//! Chronos engine: everything that touches the data. The UI only ever receives
//! the few thousand points it draws, so file size is bounded by RAM, not by the
//! webview's JavaScript heap.
//!
//! All operations go through [`Engine::call`] (command name + JSON args), which
//! the Tauri app and the HTTP test bridge expose identically.

pub mod chronos;
pub mod csv;
pub mod series;
pub mod time;

use std::collections::HashMap;
use std::fmt;
use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::csv::ImportSettings;
use crate::series::{build_blocks, lower_bound, nearest, stats, window, Blocks, Values};

#[derive(Debug)]
pub enum Error {
    Io(std::io::Error),
    Msg(String),
    Cancelled,
}

impl Error {
    pub fn msg(s: impl Into<String>) -> Self {
        Error::Msg(s.into())
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        match self {
            Error::Io(e) if e.kind() == std::io::ErrorKind::NotFound => write!(f, "파일을 찾을 수 없습니다: {e}"),
            Error::Io(e) => write!(f, "{e}"),
            Error::Msg(m) => write!(f, "{m}"),
            Error::Cancelled => write!(f, "취소됨"),
        }
    }
}

impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Self {
        Error::Io(e)
    }
}
impl From<serde_json::Error> for Error {
    fn from(e: serde_json::Error) -> Self {
        Error::Msg(format!("잘못된 요청: {e}"))
    }
}

pub struct Column {
    pub name: String,
    pub values: Values,
    pub blocks: Blocks,
    pub min: f64,
    pub max: f64,
    pub mean: f64,
}

pub struct Source {
    pub id: String,
    pub name: String,
    /// Absolute path of the original CSV.
    pub path: PathBuf,
    pub size: u64,
    pub mtime: i64,
    pub imported_at: i64,
    pub import: ImportSettings,
    /// Identifies this processed generation of the data (see chronos::FileSource::token).
    pub token: String,
    pub time: Vec<f64>,
    pub columns: Vec<Column>,
    /// Loaded from a workspace cache because the CSV was not found.
    pub missing_original: bool,
}

impl Source {
    pub fn byte_len(&self) -> u64 {
        (self.time.len() * 8) as u64 + self.columns.iter().map(|c| c.values.byte_len() as u64 + (c.blocks.min.len() * 36) as u64).sum::<u64>()
    }
    fn column(&self, name: &str) -> Option<&Column> {
        self.columns.iter().find(|c| c.name == name)
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnInfo {
    pub name: String,
    pub min: f64,
    pub max: f64,
    pub mean: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceInfo {
    pub id: String,
    pub name: String,
    pub path: String,
    pub size: u64,
    pub last_modified: i64,
    pub imported_at: i64,
    pub time_column: String,
    pub import: ImportSettings,
    pub rows: u64,
    pub start: f64,
    pub end: f64,
    pub compact: bool,
    pub bytes: u64,
    pub columns: Vec<ColumnInfo>,
    pub missing_original: bool,
}

impl From<&Source> for SourceInfo {
    fn from(s: &Source) -> Self {
        SourceInfo {
            id: s.id.clone(),
            name: s.name.clone(),
            path: s.path.to_string_lossy().into_owned(),
            size: s.size,
            last_modified: s.mtime,
            imported_at: s.imported_at,
            time_column: s.import.time_column.clone(),
            import: s.import.clone(),
            rows: s.time.len() as u64,
            start: s.time.first().copied().unwrap_or(f64::NAN),
            end: s.time.last().copied().unwrap_or(f64::NAN),
            compact: s.import.compact,
            bytes: s.byte_len(),
            columns: s.columns.iter().map(|c| ColumnInfo { name: c.name.clone(), min: c.min, max: c.max, mean: c.mean }).collect(),
            missing_original: s.missing_original,
        }
    }
}

/// Command result: JSON or raw bytes (window data).
pub enum Reply {
    Json(Value),
    Bytes(Vec<u8>),
}

impl Reply {
    /// Transport encoding shared by Tauri and the bridge: tag byte + payload.
    pub fn encode(self) -> Vec<u8> {
        match self {
            Reply::Json(v) => {
                let mut b = vec![0u8];
                b.extend(serde_json::to_vec(&v).unwrap_or_default());
                b
            }
            Reply::Bytes(mut b) => {
                b.insert(0, 1u8);
                b
            }
        }
    }
}

pub fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn mtime_ms(m: &std::fs::Metadata) -> i64 {
    m.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as i64).unwrap_or(0)
}

static COUNTER: AtomicU64 = AtomicU64::new(1);
fn new_token(prefix: &str) -> String {
    format!("{prefix}_{:x}{:x}", now_ms(), COUNTER.fetch_add(1, Ordering::Relaxed))
}

#[derive(Deserialize)]
struct SeriesRef {
    source: String,
    column: String,
}

pub type Emit<'a> = &'a (dyn Fn(&str, Value) + Sync);

#[derive(Default)]
pub struct Engine {
    sources: RwLock<HashMap<String, Arc<Source>>>,
    jobs: Mutex<HashMap<String, Arc<AtomicBool>>>,
    /// Per-user app data folder (autosave workspace, sample data).
    pub data_dir: PathBuf,
    /// Files passed on the command line (file association / "open with").
    pub launch_files: Mutex<Vec<String>>,
    pub version: String,
}

impl Engine {
    pub fn new() -> Self {
        Self { data_dir: std::env::temp_dir().join("chronos-vault"), ..Self::default() }
    }

    pub fn with_data_dir(dir: PathBuf, version: &str) -> Self {
        Self { data_dir: dir, version: version.to_string(), ..Self::default() }
    }

    fn get(&self, id: &str) -> Result<Arc<Source>, Error> {
        self.sources.read().unwrap().get(id).cloned().ok_or_else(|| Error::msg(format!("데이터 소스 {id} 이(가) 로드되지 않았습니다.")))
    }

    fn job(&self, job: &str) -> Arc<AtomicBool> {
        let f = Arc::new(AtomicBool::new(false));
        self.jobs.lock().unwrap().insert(job.to_string(), f.clone());
        f
    }

    /// Parse + index a CSV, reporting byte progress through `emit("progress")`.
    pub fn import_path(&self, path: &Path, settings: &ImportSettings, id: Option<String>, job: &str, emit: Emit) -> Result<Arc<Source>, Error> {
        let meta = std::fs::metadata(path)?;
        let total = meta.len();
        let bytes = AtomicU64::new(0);
        let cancel = self.job(job);
        let done = AtomicBool::new(false);
        let t0 = std::time::Instant::now();
        let parsed = std::thread::scope(|sc| {
            sc.spawn(|| {
                while !done.load(Ordering::Relaxed) {
                    emit("progress", json!({ "job": job, "loaded": bytes.load(Ordering::Relaxed), "total": total, "phase": "parse" }));
                    std::thread::sleep(Duration::from_millis(120));
                }
            });
            let r = csv::import(path, settings, &csv::Progress { bytes: &bytes, cancel: &cancel });
            done.store(true, Ordering::Relaxed);
            r
        });
        self.jobs.lock().unwrap().remove(job);
        let parsed = parsed?;
        emit("progress", json!({ "job": job, "loaded": total, "total": total, "phase": "index" }));
        let columns: Vec<Column> = parsed
            .columns
            .into_par_iter()
            .map(|(name, values)| {
                let blocks = build_blocks(&values);
                let (mut mn, mut mx, mut s, mut n) = (f64::INFINITY, f64::NEG_INFINITY, 0.0, 0u64);
                for k in 0..blocks.count.len() {
                    if blocks.count[k] == 0 {
                        continue;
                    }
                    mn = mn.min(blocks.min[k]);
                    mx = mx.max(blocks.max[k]);
                    s += blocks.sum[k];
                    n += blocks.count[k] as u64;
                }
                let ok = n > 0;
                Column { name, values, blocks, min: if ok { mn } else { f64::NAN }, max: if ok { mx } else { f64::NAN }, mean: if ok { s / n as f64 } else { f64::NAN } }
            })
            .collect();
        let src = Arc::new(Source {
            id: id.unwrap_or_else(|| new_token("src")),
            name: path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
            path: std::fs::canonicalize(path).map(strip_unc).unwrap_or_else(|_| path.to_path_buf()),
            size: total,
            mtime: mtime_ms(&meta),
            imported_at: now_ms(),
            import: settings.clone(),
            token: new_token("gen"),
            time: parsed.time,
            columns,
            missing_original: false,
        });
        emit("log", json!({ "msg": format!("{}: {} rows, {:.2}s", src.name, src.time.len(), t0.elapsed().as_secs_f64()), "skipped": parsed.skipped }));
        self.sources.write().unwrap().insert(src.id.clone(), src.clone());
        Ok(src)
    }

    fn open_workspace(&self, path: &Path, job: &str, emit: Emit) -> Result<Value, Error> {
        let mut f = File::open(path)?;
        let header = chronos::read_header(&mut f)?;
        let ws_dir = std::fs::canonicalize(path).map(strip_unc).ok().and_then(|p| p.parent().map(Path::to_path_buf));
        let mut loaded = Vec::new();
        let mut notes = Vec::new();
        let mut reprocessed = Vec::new();
        self.sources.write().unwrap().clear();
        for fs in &header.sources {
            let candidates: Vec<PathBuf> = fs
                .path_rel
                .as_deref()
                .and_then(|r| ws_dir.as_deref().map(|d| chronos::resolve(d, r)))
                .into_iter()
                .chain(std::iter::once(PathBuf::from(&fs.path_abs)))
                .collect();
            let found = candidates.into_iter().find_map(|p| std::fs::metadata(&p).ok().filter(|m| m.is_file()).map(|m| (p, m)));
            let src = match found {
                Some((p, m)) if m.len() == fs.size && mtime_ms(&m) == fs.last_modified => chronos::load_source(&mut f, fs, p)?,
                Some((p, _)) => {
                    emit("progress", json!({ "job": job, "loaded": 0, "total": 1, "phase": "reprocess", "name": fs.name }));
                    match self.import_path(&p, &fs.import, Some(fs.id.clone()), job, emit) {
                        Ok(s) => {
                            reprocessed.push(fs.name.clone());
                            loaded.push(SourceInfo::from(&*s));
                            continue;
                        }
                        Err(Error::Cancelled) => return Err(Error::Cancelled),
                        Err(e) => {
                            notes.push(format!("{}: 다시 처리하지 못해 저장된 데이터를 사용합니다 ({e})", fs.name));
                            chronos::load_source(&mut f, fs, p)?
                        }
                    }
                }
                None => {
                    notes.push(format!("원본 없음: {} (저장된 데이터 사용)", fs.path_rel.as_deref().unwrap_or(&fs.path_abs)));
                    let mut s = chronos::load_source(&mut f, fs, PathBuf::from(&fs.path_abs))?;
                    s.missing_original = true;
                    s
                }
            };
            loaded.push(SourceInfo::from(&src));
            self.sources.write().unwrap().insert(src.id.clone(), Arc::new(src));
        }
        Ok(json!({ "workspace": header.workspace, "sources": loaded, "notes": notes, "reprocessed": reprocessed, "savedAt": header.saved_at }))
    }

    /// Dispatch one command. `emit` receives progress events.
    pub fn call(&self, cmd: &str, args: Value, emit: Emit) -> Result<Reply, Error> {
        let s = |k: &str| args.get(k).and_then(Value::as_str).map(str::to_string);
        let need = |k: &str| s(k).ok_or_else(|| Error::msg(format!("'{k}' 인자가 필요합니다.")));
        let f = |k: &str| args.get(k).and_then(Value::as_f64).unwrap_or(f64::NAN);
        let series = || -> Result<Vec<SeriesRef>, Error> { Ok(serde_json::from_value(args.get("series").cloned().unwrap_or(json!([])))?) };
        Ok(match cmd {
            "preview" => Reply::Json(serde_json::to_value(csv::preview(Path::new(&need("path")?), s("delimiter").as_deref().filter(|d| !d.is_empty()))?)?),
            "import" => {
                let settings: ImportSettings = serde_json::from_value(args.get("settings").cloned().unwrap_or_default())?;
                let src = self.import_path(Path::new(&need("path")?), &settings, s("id"), &s("job").unwrap_or_default(), emit)?;
                Reply::Json(serde_json::to_value(SourceInfo::from(&*src))?)
            }
            "cancel" => {
                if let Some(flag) = self.jobs.lock().unwrap().get(&need("job")?) {
                    flag.store(true, Ordering::Relaxed);
                }
                Reply::Json(json!(true))
            }
            "remove" => {
                self.sources.write().unwrap().remove(&need("id")?);
                Reply::Json(json!(true))
            }
            "clear" => {
                self.sources.write().unwrap().clear();
                Reply::Json(json!(true))
            }
            "list" => {
                let all = self.sources.read().unwrap();
                Reply::Json(serde_json::to_value(all.values().map(|s| SourceInfo::from(&**s)).collect::<Vec<_>>())?)
            }
            "window" => {
                let (start, end) = (f("start"), f("end"));
                let max_points = args.get("maxPoints").and_then(Value::as_u64).unwrap_or(4000) as usize;
                let refs = series()?;
                let wins: Vec<Option<series::Window>> = refs
                    .par_iter()
                    .map(|r| {
                        let src = self.get(&r.source).ok()?;
                        let c = src.column(&r.column)?;
                        Some(window(&src.time, &c.values, &c.blocks, start, end, max_points))
                    })
                    .collect();
                // f64 layout: [n, (len, raw)*n, x0.., y0.., x1.., y1.. …]
                let mut out: Vec<f64> = vec![wins.len() as f64];
                for w in &wins {
                    out.push(w.as_ref().map_or(0.0, |w| w.x.len() as f64));
                    out.push(w.as_ref().map_or(0.0, |w| w.raw as f64));
                }
                for w in wins.iter().flatten() {
                    out.extend_from_slice(&w.x);
                    out.extend_from_slice(&w.y);
                }
                Reply::Bytes(bytemuck::cast_slice(&out).to_vec())
            }
            "stats" => {
                let (start, end) = (f("start"), f("end"));
                let out: Vec<Value> = series()?
                    .par_iter()
                    .map(|r| {
                        let st = self.get(&r.source).ok().and_then(|src| src.column(&r.column).map(|c| stats(&src.time, &c.values, &c.blocks, start, end)));
                        st.map_or(Value::Null, |s| json!(s))
                    })
                    .collect();
                Reply::Json(json!(out))
            }
            "values" => {
                let t = f("t");
                let out: Vec<Value> = series()?
                    .iter()
                    .map(|r| {
                        let v = self.get(&r.source).ok().and_then(|src| {
                            let c = src.column(&r.column)?;
                            nearest(&src.time, t).map(|i| c.values.get(i))
                        });
                        v.filter(|x| !x.is_nan()).map_or(Value::Null, |x| json!(x))
                    })
                    .collect();
                Reply::Json(json!(out))
            }
            "save" => {
                let path = PathBuf::from(need("path")?);
                // only the sources the workspace uses (when the UI says which)
                let keep: Option<Vec<String>> = args.get("sources").and_then(|v| serde_json::from_value(v.clone()).ok());
                let mut all: Vec<Arc<Source>> = self
                    .sources
                    .read()
                    .unwrap()
                    .values()
                    .filter(|s| keep.as_ref().is_none_or(|k| k.contains(&s.id)))
                    .cloned()
                    .collect();
                all.sort_by(|a, b| a.id.cmp(&b.id));
                let t0 = std::time::Instant::now();
                let rep = chronos::save(&path, args.get("workspace").cloned().unwrap_or(Value::Null), &all, now_ms())?;
                Reply::Json(json!({ "fileSize": rep.file_size, "written": rep.written, "rewrote": rep.rewrote, "ms": t0.elapsed().as_millis() as u64 }))
            }
            "open" => Reply::Json(self.open_workspace(Path::new(&need("path")?), &s("job").unwrap_or_default(), emit)?),
            "stat" => {
                let p = PathBuf::from(need("path")?);
                Reply::Json(match std::fs::metadata(&p) {
                    Ok(m) => json!({ "exists": true, "size": m.len(), "lastModified": mtime_ms(&m) }),
                    Err(_) => json!({ "exists": false }),
                })
            }
            "export_csv" => {
                #[derive(Deserialize)]
                struct Item {
                    source: String,
                    column: String,
                    label: String,
                    #[serde(default = "one")]
                    scale: f64,
                    #[serde(default)]
                    offset: f64,
                }
                fn one() -> f64 {
                    1.0
                }
                let items: Vec<Item> = serde_json::from_value(args.get("series").cloned().unwrap_or(json!([])))?;
                let (start, end) = (f("start"), f("end"));
                let srcs: Vec<(Arc<Source>, &Item)> = items.iter().filter_map(|it| self.get(&it.source).ok().map(|s| (s, it))).collect();
                let mut stamps: Vec<f64> = srcs
                    .iter()
                    .flat_map(|(s, _)| {
                        let a = lower_bound(&s.time, start);
                        let b = s.time.partition_point(|&x| x <= end);
                        s.time[a..b.max(a)].to_vec()
                    })
                    .collect();
                stamps.par_sort_by(f64::total_cmp);
                stamps.dedup();
                let mut w = BufWriter::new(File::create(need("path")?)?);
                let esc = |v: &str| if v.contains([',', '"', '\n']) { format!("\"{}\"", v.replace('"', "\"\"")) } else { v.to_string() };
                write!(w, "timestamp")?;
                for (_, it) in &srcs {
                    write!(w, ",{}", esc(&it.label))?;
                }
                writeln!(w)?;
                for &t in &stamps {
                    write!(w, "{}", fmt_time(t))?;
                    for (s, it) in &srcs {
                        let k = lower_bound(&s.time, t);
                        let v = if k < s.time.len() && s.time[k] == t { s.column(&it.column).map(|c| c.values.get(k)).unwrap_or(f64::NAN) } else { f64::NAN };
                        if v.is_nan() { write!(w, ",")? } else { write!(w, ",{}", v * it.scale + it.offset)? }
                    }
                    writeln!(w)?;
                }
                w.flush()?;
                Reply::Json(json!({ "rows": stamps.len() }))
            }
            "app_info" => Reply::Json(json!({
                "dataDir": self.data_dir.to_string_lossy(),
                "launchFiles": std::mem::take(&mut *self.launch_files.lock().unwrap()),
                "version": self.version,
            })),
            "sample" => {
                std::fs::create_dir_all(&self.data_dir)?;
                let p = self.data_dir.join("sample_server_metrics.csv");
                if !p.exists() {
                    write_sample(&p)?;
                }
                Reply::Json(json!({ "path": p.to_string_lossy() }))
            }
            "write_file" => {
                use base64::Engine as _;
                let data = base64::engine::general_purpose::STANDARD.decode(need("base64")?).map_err(|e| Error::msg(e.to_string()))?;
                std::fs::write(need("path")?, data)?;
                Reply::Json(json!(true))
            }
            other => return Err(Error::msg(format!("알 수 없는 명령: {other}"))),
        })
    }
}

/// Synthetic multi-sensor CSV (50k rows at 1 min) for the "sample data" action.
fn write_sample(p: &Path) -> std::io::Result<()> {
    let mut w = BufWriter::new(File::create(p)?);
    writeln!(w, "timestamp,cpu_load,memory_mb,temperature_c,network_rx_kbps,network_tx_kbps,disk_iops,pressure_hpa")?;
    let start = 1_767_225_600_000f64; // 2026-01-01
    let (mut mem, mut temp, mut pressure, mut seed) = (4200f64, 42f64, 1013f64, 7u64);
    let mut rnd = || {
        seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        (seed >> 11) as f64 / (1u64 << 53) as f64
    };
    for i in 0..50_000u64 {
        let day = (i % 1440) as f64 / 1440.0;
        let daily = (day * std::f64::consts::TAU - std::f64::consts::FRAC_PI_2).sin() * 0.5 + 0.5;
        let spike = if rnd() < 0.002 { 40.0 } else { 0.0 };
        let cpu = (15.0 + 55.0 * daily + (rnd() - 0.5) * 20.0 + spike).clamp(0.0, 100.0);
        mem = (mem + (rnd() - 0.5) * 40.0 + (cpu - 40.0) * 0.2).clamp(2000.0, 16000.0);
        if rnd() < 0.0005 {
            mem = 4000.0;
        }
        temp += (35.0 + cpu * 0.35 - temp) * 0.05 + (rnd() - 0.5) * 0.4;
        let burst = if rnd() < 0.003 { 9000.0 } else { 0.0 };
        let rx = (800.0 + 4000.0 * daily + (rnd() - 0.5) * 900.0 + burst).max(0.0);
        let tx = (300.0 + 1500.0 * daily + (rnd() - 0.5) * 400.0).max(0.0);
        let iops = (120.0 + cpu * 6.0 + (rnd() - 0.5) * 150.0).max(0.0).round();
        pressure += (1013.0 - pressure) * 0.001 + (rnd() - 0.5) * 0.3;
        let ts = fmt_time(start + i as f64 * 60_000.0);
        writeln!(w, "{},{cpu:.2},{mem:.1},{temp:.2},{rx:.1},{tx:.1},{iops},{pressure:.2}", &ts[..19])?;
    }
    w.flush()
}

/// `\\?\C:\x` → `C:\x` (canonicalize on Windows returns verbatim paths).
fn strip_unc(p: PathBuf) -> PathBuf {
    let s = p.to_string_lossy();
    match s.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with("UNC") => PathBuf::from(rest),
        _ => p,
    }
}

/// UTC wall-clock `YYYY-MM-DD HH:MM:SS.mmm`.
pub fn fmt_time(ms: f64) -> String {
    let total = ms.floor() as i64;
    let days = total.div_euclid(86_400_000);
    let rem = total.rem_euclid(86_400_000);
    // civil from days (Howard Hinnant)
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02} {:02}:{:02}:{:02}.{:03}", rem / 3_600_000, rem / 60_000 % 60, rem / 1000 % 60, rem % 1000)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn noop(_: &str, _: Value) {}

    #[test]
    fn fmt_time_roundtrip() {
        assert_eq!(fmt_time(1767270896789.0), "2026-01-01 12:34:56.789");
        assert_eq!(fmt_time(951782400000.0), "2000-02-29 00:00:00.000");
    }

    #[test]
    fn workspace_roundtrip_relative_paths_and_reprocess() {
        let dir = std::env::temp_dir().join(format!("chronos-ws-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("data")).unwrap();
        std::fs::create_dir_all(dir.join("dash")).unwrap();
        let csv = dir.join("data/m.csv");
        let mut body = String::from("time,a,b\n");
        for i in 0..10_000 {
            body.push_str(&format!("2026-01-01 00:{:02}:{:02},{},{}\n", i / 60 % 60, i % 60, i, i * 2));
        }
        std::fs::File::create(&csv).unwrap().write_all(body.as_bytes()).unwrap();
        let e = Engine::new();
        let settings = json!({ "delimiter": ",", "hasHeader": true, "timeColumn": "time", "timeFormat": "iso", "columns": ["a", "b"], "compact": false });
        let Reply::Json(info) = e.call("import", json!({ "path": csv, "settings": settings, "job": "j" }), &noop).unwrap() else { panic!() };
        assert_eq!(info["rows"], 10_000); // stamps repeat after an hour; duplicates are kept, sorted
        let ws = dir.join("dash/w.chronos");
        let Reply::Json(r1) = e.call("save", json!({ "path": ws, "workspace": { "layout": 1 } }), &noop).unwrap() else { panic!() };
        assert_eq!(r1["rewrote"], true);
        // small files are rewritten on every save (large ones append; see examples/bench.rs)
        let Reply::Json(r2) = e.call("save", json!({ "path": ws, "workspace": { "layout": 2 } }), &noop).unwrap() else { panic!() };
        assert_eq!(r2["rewrote"], true);
        let hdr = chronos::read_header(&mut File::open(&ws).unwrap()).unwrap();
        assert_eq!(hdr.sources[0].path_rel.as_deref(), Some("../data/m.csv"));
        assert_eq!(hdr.workspace["layout"], 2);

        // reopen: unchanged → cache
        let e2 = Engine::new();
        let Reply::Json(o) = e2.call("open", json!({ "path": ws }), &noop).unwrap() else { panic!() };
        assert_eq!(o["reprocessed"].as_array().unwrap().len(), 0);
        assert_eq!(o["sources"][0]["rows"], 10_000);

        // move the whole folder → relative path still resolves
        let moved = std::env::temp_dir().join(format!("chronos-ws-moved-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&moved);
        std::fs::rename(&dir, &moved).unwrap();
        let Reply::Json(o) = e2.call("open", json!({ "path": moved.join("dash/w.chronos") }), &noop).unwrap() else { panic!() };
        assert_eq!(o["notes"].as_array().unwrap().len(), 0, "{o}");
        assert!(o["sources"][0]["path"].as_str().unwrap().contains("chronos-ws-moved"));

        // change the CSV → reprocessed with stored settings
        std::thread::sleep(Duration::from_millis(20));
        let mut f = std::fs::OpenOptions::new().append(true).open(moved.join("data/m.csv")).unwrap();
        writeln!(f, "2026-01-02 00:00:00,1,2").unwrap();
        drop(f);
        let Reply::Json(o) = e2.call("open", json!({ "path": moved.join("dash/w.chronos") }), &noop).unwrap() else { panic!() };
        assert_eq!(o["reprocessed"].as_array().unwrap().len(), 1);
        assert_eq!(o["sources"][0]["rows"], 10_001);

        // delete CSV → cached data with a note
        std::fs::remove_file(moved.join("data/m.csv")).unwrap();
        let Reply::Json(o) = e2.call("open", json!({ "path": moved.join("dash/w.chronos") }), &noop).unwrap() else { panic!() };
        assert_eq!(o["sources"][0]["missingOriginal"], true);
        assert_eq!(o["sources"][0]["rows"], 10_000, "old cache (reprocessed data was never saved)");

        // window bytes decode
        let Reply::Bytes(b) = e2.call("window", json!({ "series": [{ "source": o["sources"][0]["id"], "column": "a" }], "start": 0, "end": 2e12, "maxPoints": 400 }), &noop).unwrap() else { panic!() };
        let v: Vec<f64> = b.chunks_exact(8).map(|c| f64::from_le_bytes(c.try_into().unwrap())).collect();
        assert_eq!(v[0], 1.0);
        assert!(v[1] <= 402.0 && v[2] == 10_000.0, "{:?}", &v[..3]);
        let _ = std::fs::remove_dir_all(&moved);
    }
}
