//! `.chronos` v3 workspace file: layout + data-source references (absolute and
//! workspace-relative paths) + complete preprocessing (parsed arrays + block
//! index), with the header at the END:
//!
//!   "CHRONOS3" | sections (8-byte aligned, little endian) … | header JSON | u64 header_off | u64 header_len | "CHRONOS3"
//!
//! Saving appends only what changed: unchanged sources keep their sections, a
//! layout-only save writes just a new header + footer. When too much of the
//! file is dead space the file is rewritten (to a temp file, then renamed).

use std::fs::{File, OpenOptions};
use std::io::{BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::csv::ImportSettings;
use crate::series::{Blocks, Values};
use crate::{Column, Error, Source};

pub const MAGIC: &[u8; 8] = b"CHRONOS3";
const FOOTER: u64 = 24;

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Dt {
    F64,
    F32,
    U32,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug)]
pub struct Sec {
    pub o: u64,
    pub n: u64,
    pub t: Dt,
}

impl Sec {
    fn bytes(&self) -> u64 {
        self.n * if self.t == Dt::F64 { 8 } else { 4 }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FileBlocks {
    pub min: Sec,
    pub max: Sec,
    pub min_idx: Sec,
    pub max_idx: Sec,
    pub sum: Sec,
    pub count: Sec,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct FileColumn {
    pub name: String,
    pub min: Option<f64>,
    pub max: Option<f64>,
    pub mean: Option<f64>,
    pub values: Sec,
    pub blocks: FileBlocks,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FileSource {
    pub id: String,
    pub name: String,
    pub path_abs: String,
    /// Relative to the workspace file's folder ('/'-separated), when on the same volume.
    pub path_rel: Option<String>,
    pub size: u64,
    pub last_modified: i64,
    pub imported_at: i64,
    pub import: ImportSettings,
    pub rows: u64,
    /// Changes whenever the data is (re)processed; equal token = sections can be reused.
    pub token: String,
    pub time: Sec,
    pub columns: Vec<FileColumn>,
}

#[derive(Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Header {
    pub app: String,
    pub format: u32,
    pub saved_at: i64,
    pub workspace: Value,
    pub sources: Vec<FileSource>,
}

/// Relative path from directory `from` to `to` ('/'-separated), None across volumes.
pub fn relative(from: &Path, to: &Path) -> Option<String> {
    use std::path::Component;
    let a: Vec<Component> = from.components().collect();
    let b: Vec<Component> = to.components().collect();
    match (a.first(), b.first()) {
        (Some(Component::Prefix(x)), Some(Component::Prefix(y))) if x.as_os_str().to_ascii_lowercase() != y.as_os_str().to_ascii_lowercase() => return None,
        _ => {}
    }
    let eq = |x: &Component, y: &Component| {
        if cfg!(windows) { x.as_os_str().to_ascii_lowercase() == y.as_os_str().to_ascii_lowercase() } else { x == y }
    };
    let mut i = 0;
    while i < a.len() && i < b.len() && eq(&a[i], &b[i]) {
        i += 1;
    }
    if i == 0 {
        return None;
    }
    let mut parts: Vec<String> = vec!["..".into(); a.len() - i];
    parts.extend(b[i..].iter().map(|c| c.as_os_str().to_string_lossy().into_owned()));
    Some(parts.join("/"))
}

pub fn resolve(dir: &Path, rel: &str) -> PathBuf {
    let mut p = dir.to_path_buf();
    for seg in rel.split(['/', '\\']) {
        match seg {
            "" | "." => {}
            ".." => {
                p.pop();
            }
            s => p.push(s),
        }
    }
    p
}

struct W {
    f: BufWriter<File>,
    pos: u64,
}

impl W {
    fn pad(&mut self) -> std::io::Result<()> {
        let pad = (8 - self.pos % 8) % 8;
        if pad > 0 {
            self.f.write_all(&[0u8; 8][..pad as usize])?;
            self.pos += pad;
        }
        Ok(())
    }
    fn sec(&mut self, bytes: &[u8], t: Dt, n: usize) -> std::io::Result<Sec> {
        self.pad()?;
        let s = Sec { o: self.pos, n: n as u64, t };
        self.f.write_all(bytes)?;
        self.pos += bytes.len() as u64;
        Ok(s)
    }
}

fn nn(v: f64) -> Option<f64> {
    (!v.is_nan()).then_some(v)
}

fn write_source(w: &mut W, s: &Source, ws_dir: Option<&Path>) -> std::io::Result<FileSource> {
    let time = w.sec(bytemuck::cast_slice(&s.time), Dt::F64, s.time.len())?;
    let mut columns = Vec::with_capacity(s.columns.len());
    for c in &s.columns {
        let dt = if matches!(c.values, Values::F32(_)) { Dt::F32 } else { Dt::F64 };
        let values = w.sec(c.values.bytes(), dt, c.values.len())?;
        let b = &c.blocks;
        let blocks = FileBlocks {
            min: w.sec(bytemuck::cast_slice(&b.min), Dt::F64, b.min.len())?,
            max: w.sec(bytemuck::cast_slice(&b.max), Dt::F64, b.max.len())?,
            min_idx: w.sec(bytemuck::cast_slice(&b.min_idx), Dt::U32, b.min_idx.len())?,
            max_idx: w.sec(bytemuck::cast_slice(&b.max_idx), Dt::U32, b.max_idx.len())?,
            sum: w.sec(bytemuck::cast_slice(&b.sum), Dt::F64, b.sum.len())?,
            count: w.sec(bytemuck::cast_slice(&b.count), Dt::U32, b.count.len())?,
        };
        columns.push(FileColumn { name: c.name.clone(), min: nn(c.min), max: nn(c.max), mean: nn(c.mean), values, blocks });
    }
    Ok(meta(s, ws_dir, time, columns))
}

fn meta(s: &Source, ws_dir: Option<&Path>, time: Sec, columns: Vec<FileColumn>) -> FileSource {
    FileSource {
        id: s.id.clone(),
        name: s.name.clone(),
        path_abs: s.path.to_string_lossy().into_owned(),
        path_rel: ws_dir.and_then(|d| relative(d, &s.path)),
        size: s.size,
        last_modified: s.mtime,
        imported_at: s.imported_at,
        import: s.import.clone(),
        rows: s.time.len() as u64,
        token: s.token.clone(),
        time,
        columns,
    }
}

fn write_tail(w: &mut W, header: &Header) -> Result<(), Error> {
    w.pad()?;
    let json = serde_json::to_vec(header)?;
    let off = w.pos;
    w.f.write_all(&json)?;
    w.f.write_all(&off.to_le_bytes())?;
    w.f.write_all(&(json.len() as u64).to_le_bytes())?;
    w.f.write_all(MAGIC)?;
    w.pos += json.len() as u64 + FOOTER;
    w.f.flush()?;
    Ok(())
}

/// Read the header via the footer; falls back to the last intact footer if a save was interrupted.
pub fn read_header(f: &mut File) -> Result<Header, Error> {
    let len = f.metadata()?.len();
    let mut magic = [0u8; 8];
    f.seek(SeekFrom::Start(0))?;
    if len < 8 + FOOTER || f.read_exact(&mut magic).is_err() || &magic != MAGIC {
        return Err(Error::msg("Chronos 워크스페이스 파일(.chronos)이 아닙니다."));
    }
    let try_at = |f: &mut File, end: u64| -> Option<Header> {
        if end < 8 + FOOTER {
            return None;
        }
        let mut foot = [0u8; 24];
        f.seek(SeekFrom::Start(end - FOOTER)).ok()?;
        f.read_exact(&mut foot).ok()?;
        if &foot[16..] != MAGIC {
            return None;
        }
        let off = u64::from_le_bytes(foot[0..8].try_into().unwrap());
        let hl = u64::from_le_bytes(foot[8..16].try_into().unwrap());
        if off.checked_add(hl)? + FOOTER != end {
            return None;
        }
        let mut buf = vec![0u8; hl as usize];
        f.seek(SeekFrom::Start(off)).ok()?;
        f.read_exact(&mut buf).ok()?;
        serde_json::from_slice(&buf).ok()
    };
    if let Some(h) = try_at(f, len) {
        return Ok(h);
    }
    // interrupted append: scan backwards (last 64 MiB) for an earlier intact footer
    let span = len.min(64 << 20);
    let mut tail = vec![0u8; span as usize];
    f.seek(SeekFrom::Start(len - span))?;
    f.read_exact(&mut tail)?;
    let finder = memchr::memmem::rfind_iter(&tail, MAGIC).collect::<Vec<_>>();
    for p in finder {
        let end = len - span + p as u64 + 8;
        if let Some(h) = try_at(f, end) {
            return Ok(h);
        }
    }
    Err(Error::msg("워크스페이스 파일이 손상되었습니다."))
}

fn read_vec<T: bytemuck::Pod + Default + Clone>(f: &mut File, s: &Sec) -> std::io::Result<Vec<T>> {
    let mut v = vec![T::default(); s.n as usize];
    f.seek(SeekFrom::Start(s.o))?;
    f.read_exact(bytemuck::cast_slice_mut(&mut v))?;
    Ok(v)
}

/// Load a source's arrays from the file (no parsing).
pub fn load_source(f: &mut File, fs: &FileSource, path: PathBuf) -> Result<Source, Error> {
    let time: Vec<f64> = read_vec(f, &fs.time)?;
    let mut columns = Vec::with_capacity(fs.columns.len());
    for c in &fs.columns {
        let values = match c.values.t {
            Dt::F32 => Values::F32(read_vec(f, &c.values)?),
            _ => Values::F64(read_vec(f, &c.values)?),
        };
        let b = &c.blocks;
        let blocks = Blocks {
            min: read_vec(f, &b.min)?,
            max: read_vec(f, &b.max)?,
            min_idx: read_vec(f, &b.min_idx)?,
            max_idx: read_vec(f, &b.max_idx)?,
            sum: read_vec(f, &b.sum)?,
            count: read_vec(f, &b.count)?,
        };
        columns.push(Column {
            name: c.name.clone(),
            values,
            blocks,
            min: c.min.unwrap_or(f64::NAN),
            max: c.max.unwrap_or(f64::NAN),
            mean: c.mean.unwrap_or(f64::NAN),
        });
    }
    Ok(Source {
        id: fs.id.clone(),
        name: fs.name.clone(),
        path,
        size: fs.size,
        mtime: fs.last_modified,
        imported_at: fs.imported_at,
        import: fs.import.clone(),
        token: fs.token.clone(),
        time,
        columns,
        missing_original: false,
    })
}

fn src_bytes(fs: &FileSource) -> u64 {
    let mut n = fs.time.bytes();
    for c in &fs.columns {
        let b = &c.blocks;
        n += c.values.bytes() + b.min.bytes() + b.max.bytes() + b.min_idx.bytes() + b.max_idx.bytes() + b.sum.bytes() + b.count.bytes();
    }
    n
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SaveReport {
    pub file_size: u64,
    pub written: u64,
    pub rewrote: bool,
}

pub fn save(path: &Path, workspace: Value, sources: &[std::sync::Arc<Source>], now: i64) -> Result<SaveReport, Error> {
    let ws_dir = path.parent().map(|p| p.to_path_buf());
    let existing = File::open(path).ok().and_then(|mut f| read_header(&mut f).ok().map(|h| (h, f.metadata().map(|m| m.len()).unwrap_or(0))));
    let mut header = Header { app: "chronos-vault".into(), format: 3, saved_at: now, workspace, sources: Vec::new() };

    if let Some((old, len)) = existing {
        let reusable: Vec<Option<&FileSource>> = sources.iter().map(|s| old.sources.iter().find(|o| o.id == s.id && o.token == s.token)).collect();
        let live: u64 = reusable.iter().flatten().map(|o| src_bytes(o)).sum();
        let new_bytes: u64 = sources.iter().zip(&reusable).filter(|(_, r)| r.is_none()).map(|(s, _)| s.byte_len()).sum();
        let dead = len.saturating_sub(live);
        // small files are simply rewritten; big ones append unless a third is dead space
        if len + new_bytes > (32u64 << 20) && dead <= (len + new_bytes) / 3 {
            // append mode: keep the file, add new sections + a fresh header
            let f = OpenOptions::new().write(true).open(path)?;
            let mut w = W { pos: len, f: BufWriter::with_capacity(8 << 20, f) };
            w.f.seek(SeekFrom::Start(len))?;
            for (s, r) in sources.iter().zip(&reusable) {
                header.sources.push(match r {
                    Some(o) => FileSource { path_abs: s.path.to_string_lossy().into_owned(), path_rel: ws_dir.as_deref().and_then(|d| relative(d, &s.path)), ..(*o).clone() },
                    None => write_source(&mut w, s, ws_dir.as_deref())?,
                });
            }
            write_tail(&mut w, &header)?;
            let f = w.f.into_inner().map_err(|e| Error::Io(e.into_error()))?;
            f.sync_data()?;
            return Ok(SaveReport { file_size: w.pos, written: w.pos - len, rewrote: false });
        }
    }
    // full write to a temp file next to the target, then replace it
    let tmp = path.with_extension("chronos.tmp");
    let f = File::create(&tmp)?;
    let mut w = W { pos: 0, f: BufWriter::with_capacity(8 << 20, f) };
    w.f.write_all(MAGIC)?;
    w.pos = 8;
    for s in sources {
        header.sources.push(write_source(&mut w, s, ws_dir.as_deref())?);
    }
    write_tail(&mut w, &header)?;
    let f = w.f.into_inner().map_err(|e| Error::Io(e.into_error()))?;
    f.sync_data()?;
    drop(f);
    std::fs::rename(&tmp, path)?;
    Ok(SaveReport { file_size: w.pos, written: w.pos, rewrote: true })
}
