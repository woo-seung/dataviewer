//! CSV preview/detection and the parallel importer.
//!
//! Unquoted files (the usual machine-written case) are memory-mapped and split
//! into newline-aligned chunks parsed on all cores. A first pass counts lines
//! per chunk so every chunk writes straight into its own slice of one final
//! allocation; rows with an unreadable timestamp are compacted out afterwards.
//! Files containing quotes take a sequential, quote-aware path.

use std::fs::File;
use std::io::Read;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use memchr::memchr_iter;
use rayon::prelude::*;
use serde::{Deserialize, Serialize};

use crate::series::Values;
use crate::time::{detect_format, parse_time, TimeFormat};
use crate::Error;

/// How a CSV is imported, by column name, so it can be re-imported without asking.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSettings {
    pub delimiter: String,
    pub has_header: bool,
    pub time_column: String,
    pub time_format: TimeFormat,
    pub columns: Vec<String>,
    pub compact: bool,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub delimiter: String,
    pub has_header: bool,
    pub header: Vec<String>,
    pub rows: Vec<Vec<String>>,
    pub time_column: usize,
    pub numeric_columns: Vec<usize>,
    pub estimated_rows: u64,
    pub size: u64,
    pub time_format: TimeFormat,
}

pub fn parse_number(raw: &[u8], decimal_comma: bool) -> f64 {
    let mut b = raw;
    while let [first, rest @ ..] = b {
        if matches!(first, b' ' | b'\t' | b'"') { b = rest } else { break }
    }
    while let [rest @ .., last] = b {
        if matches!(last, b' ' | b'\t' | b'\r' | b'"') { b = rest } else { break }
    }
    if b.is_empty() {
        return f64::NAN;
    }
    if let Ok(v) = fast_float2::parse::<f64, _>(b) {
        return v;
    }
    if decimal_comma {
        if let Some(p) = b.iter().position(|&c| c == b',') {
            if !b[p + 1..].contains(&b',') && !b.contains(&b'.') {
                let mut s = b.to_vec();
                s[p] = b'.';
                if let Ok(v) = fast_float2::parse::<f64, _>(&s) {
                    return v;
                }
            }
        }
    }
    match b.to_ascii_lowercase().as_slice() {
        b"true" | b"on" | b"yes" => 1.0,
        b"false" | b"off" | b"no" => 0.0,
        _ => f64::NAN,
    }
}

/// Split one record with quote handling (used for headers, previews and quoted files).
pub fn split_record(line: &[u8], delim: u8) -> Vec<Vec<u8>> {
    let mut out = Vec::new();
    let mut cur = Vec::new();
    let mut q = false;
    let mut i = 0;
    while i < line.len() {
        let c = line[i];
        if q {
            if c == b'"' {
                if line.get(i + 1) == Some(&b'"') {
                    cur.push(b'"');
                    i += 1;
                } else {
                    q = false;
                }
            } else {
                cur.push(c);
            }
        } else if c == b'"' {
            q = true;
        } else if c == delim {
            out.push(std::mem::take(&mut cur));
        } else if c != b'\r' {
            cur.push(c);
        }
        i += 1;
    }
    out.push(cur);
    out
}

fn looks_numeric(vals: &[&[u8]]) -> bool {
    let filled: Vec<_> = vals.iter().filter(|v| !v.iter().all(|c| c.is_ascii_whitespace())).collect();
    !filled.is_empty() && filled.iter().filter(|v| !parse_number(v, true).is_nan()).count() * 5 >= filled.len() * 4
}

fn looks_time(vals: &[&[u8]]) -> bool {
    let filled: Vec<_> = vals.iter().filter(|v| !v.is_empty()).collect();
    !filled.is_empty()
        && filled
            .iter()
            .filter(|v| !v.iter().all(|c| c.is_ascii_digit() || *c == b'.') && !parse_time(v, TimeFormat::Auto).is_nan())
            .count()
            * 5
            >= filled.len() * 4
}

fn time_name(n: &str) -> bool {
    let l = n.to_lowercase();
    ["time", "date", "stamp", "시간", "일시", "날짜", "시각"].iter().any(|k| l.contains(k)) || l == "ts" || l == "t" || l == "epoch"
}

fn skip_bom(b: &[u8]) -> &[u8] {
    b.strip_prefix(&[0xEF, 0xBB, 0xBF][..]).unwrap_or(b)
}

pub fn preview(path: &Path, delimiter: Option<&str>) -> Result<Preview, Error> {
    let mut f = File::open(path)?;
    let size = f.metadata()?.len();
    let mut buf = vec![0u8; size.min(256 * 1024) as usize];
    f.read_exact(&mut buf)?;
    let text = skip_bom(&buf);
    let lines: Vec<&[u8]> = text.split(|&c| c == b'\n').filter(|l| !l.iter().all(|c| c.is_ascii_whitespace())).take(61).collect();
    if lines.is_empty() {
        return Err(Error::msg("파일이 비어 있습니다."));
    }
    let delim = match delimiter.and_then(|d| d.bytes().next()) {
        Some(d) => d,
        None => {
            // most consistent candidate across the first lines
            let mut best = (b',', 0usize);
            for d in [b',', b';', b'\t', b'|'] {
                let counts: Vec<usize> = lines.iter().take(20).map(|l| split_record(l, d).len()).collect();
                let first = counts[0];
                if first > 1 && counts.iter().all(|&c| c == first) && first > best.1 {
                    best = (d, first);
                }
            }
            if best.1 == 0 {
                // fall back to the most frequent candidate on the first line
                [b',', b';', b'\t', b'|'].into_iter().max_by_key(|d| lines[0].iter().filter(|c| *c == d).count()).unwrap()
            } else {
                best.0
            }
        }
    };
    let recs: Vec<Vec<Vec<u8>>> = lines.iter().map(|l| split_record(l, delim)).collect();
    let width = recs.iter().map(|r| r.len()).max().unwrap_or(0);
    let first = &recs[0];
    let col = |rows: &[Vec<Vec<u8>>], i: usize| -> Vec<Vec<u8>> { rows.iter().map(|r| r.get(i).cloned().unwrap_or_default()).collect() };
    let has_header = first.iter().enumerate().any(|(i, cell)| {
        let below = col(&recs[1..recs.len().min(21)], i);
        let below: Vec<&[u8]> = below.iter().map(|v| v.as_slice()).collect();
        parse_number(cell, true).is_nan() && (looks_numeric(&below) || looks_time(&below))
    }) || first.iter().all(|c| parse_number(c, true).is_nan());
    let header: Vec<String> = (0..width)
        .map(|i| {
            let n = if has_header { String::from_utf8_lossy(first.get(i).map(|v| v.as_slice()).unwrap_or(b"")).trim().to_string() } else { String::new() };
            if n.is_empty() { format!("col{}", i + 1) } else { n }
        })
        .collect();
    let body = if has_header { &recs[1..] } else { &recs[..] };
    let colv = |i: usize| col(body, i);
    let mut time_column = (0..width)
        .find(|&i| {
            let c = colv(i);
            let c: Vec<&[u8]> = c.iter().map(|v| v.as_slice()).collect();
            time_name(&header[i]) && (looks_time(&c) || looks_numeric(&c))
        })
        .or_else(|| {
            (0..width).find(|&i| {
                let c = colv(i);
                let c: Vec<&[u8]> = c.iter().map(|v| v.as_slice()).collect();
                looks_time(&c)
            })
        })
        .unwrap_or(0);
    if time_column >= width {
        time_column = 0;
    }
    let numeric_columns = (0..width)
        .filter(|&i| {
            let c = colv(i);
            let c: Vec<&[u8]> = c.iter().map(|v| v.as_slice()).collect();
            i != time_column && looks_numeric(&c)
        })
        .collect();
    let tc = colv(time_column);
    let tcs: Vec<&[u8]> = tc.iter().map(|v| v.as_slice()).collect();
    let nl = memchr_iter(b'\n', &buf).count() as u64;
    let estimated_rows = if buf.len() as u64 >= size { nl + 1 } else { ((nl as f64 / buf.len() as f64) * size as f64) as u64 };
    Ok(Preview {
        delimiter: (delim as char).to_string(),
        has_header,
        header,
        rows: body.iter().take(30).map(|r| r.iter().map(|c| String::from_utf8_lossy(c).into_owned()).collect()).collect(),
        time_column,
        numeric_columns,
        estimated_rows,
        size,
        time_format: detect_format(&tcs),
    })
}

/// Result of parsing (before indexing).
pub struct Parsed {
    pub time: Vec<f64>,
    pub columns: Vec<(String, Values)>,
    pub skipped: u64,
}

pub struct Progress<'a> {
    pub bytes: &'a AtomicU64,
    pub cancel: &'a AtomicBool,
}

trait Store: Copy + Send + Sync + 'static {
    const NAN: Self;
    fn from(v: f64) -> Self;
    fn wrap(v: Vec<Self>) -> Values;
}
impl Store for f64 {
    const NAN: Self = f64::NAN;
    fn from(v: f64) -> Self {
        v
    }
    fn wrap(v: Vec<Self>) -> Values {
        Values::F64(v)
    }
}
impl Store for f32 {
    const NAN: Self = f32::NAN;
    fn from(v: f64) -> Self {
        v as f32
    }
    fn wrap(v: Vec<Self>) -> Values {
        Values::F32(v)
    }
}

struct Layout {
    delim: u8,
    time_field: usize,
    /// field index -> output slot
    slot_of: Vec<i32>,
    slots: usize,
    fmt: TimeFormat,
    decimal_comma: bool,
}

/// Parse one unquoted line into time + slot values. Returns NaN time on failure.
#[inline]
fn parse_line<T: Store>(line: &[u8], l: &Layout, out: &mut [T]) -> f64 {
    let mut t = f64::NAN;
    let mut f = 0usize;
    let mut a = 0usize;
    let n = l.slot_of.len();
    let mut seen = 0usize;
    for o in out.iter_mut() {
        *o = T::NAN;
    }
    let mut i = 0usize;
    loop {
        let at_end = i >= line.len();
        if at_end || line[i] == l.delim {
            let field = &line[a..i];
            if f == l.time_field {
                t = parse_time(field, l.fmt);
                if t.is_nan() {
                    return t;
                }
            }
            if f < n {
                let s = l.slot_of[f];
                if s >= 0 {
                    out[s as usize] = T::from(parse_number(field, l.decimal_comma));
                    seen += 1;
                }
            }
            f += 1;
            a = i + 1;
            if at_end || (seen >= l.slots && f > l.time_field) {
                break;
            }
        }
        i += 1;
    }
    t
}

fn chunk_bounds(body: &[u8], target: usize) -> Vec<(usize, usize)> {
    let len = body.len();
    let n = (len / (4 << 20)).clamp(1, target);
    let mut cuts = vec![0usize];
    for k in 1..n {
        let p = len * k / n;
        let p = memchr::memchr(b'\n', &body[p..]).map(|q| p + q + 1).unwrap_or(len);
        if p > *cuts.last().unwrap() && p < len {
            cuts.push(p);
        }
    }
    cuts.push(len);
    cuts.windows(2).map(|w| (w[0], w[1])).collect()
}

fn count_records(chunk: &[u8]) -> usize {
    let nl = memchr_iter(b'\n', chunk).count();
    nl + usize::from(!chunk.is_empty() && *chunk.last().unwrap() != b'\n')
}

fn parse_parallel<T: Store>(body: &[u8], l: &Layout, p: &Progress) -> Result<(Vec<f64>, Vec<Vec<T>>), Error> {
    let chunks = chunk_bounds(body, rayon::current_num_threads() * 8);
    let counts: Vec<usize> = chunks.par_iter().map(|&(a, b)| count_records(&body[a..b])).collect();
    let total: usize = counts.iter().sum();
    let mut time = vec![f64::NAN; total];
    let mut cols: Vec<Vec<T>> = (0..l.slots).map(|_| vec![T::NAN; total]).collect();

    // carve disjoint output slices per chunk
    struct Task<'a, T> {
        range: (usize, usize),
        time: &'a mut [f64],
        cols: Vec<&'a mut [T]>,
    }
    let mut tasks: Vec<Task<T>> = Vec::with_capacity(chunks.len());
    {
        let mut t_rest: &mut [f64] = &mut time;
        let mut c_rest: Vec<&mut [T]> = cols.iter_mut().map(|c| c.as_mut_slice()).collect();
        for (k, &range) in chunks.iter().enumerate() {
            let n = counts[k];
            let (th, tt) = std::mem::take(&mut t_rest).split_at_mut(n);
            t_rest = tt;
            let mut mine = Vec::with_capacity(c_rest.len());
            for c in c_rest.iter_mut() {
                let (h, t) = std::mem::take(c).split_at_mut(n);
                *c = t;
                mine.push(h);
            }
            tasks.push(Task { range, time: th, cols: mine });
        }
    }
    tasks.into_par_iter().try_for_each(|mut task| -> Result<(), Error> {
        let chunk = &body[task.range.0..task.range.1];
        let mut row = vec![T::NAN; l.slots];
        let mut start = 0usize;
        let mut r = 0usize;
        let mut since = 0usize;
        while start < chunk.len() && r < task.time.len() {
            let end = memchr::memchr(b'\n', &chunk[start..]).map(|q| start + q).unwrap_or(chunk.len());
            let mut line = &chunk[start..end];
            if let [rest @ .., b'\r'] = line {
                line = rest;
            }
            if !line.is_empty() {
                let t = parse_line(line, l, &mut row);
                task.time[r] = t;
                if !t.is_nan() {
                    for (s, c) in task.cols.iter_mut().enumerate() {
                        c[r] = row[s];
                    }
                }
            }
            r += 1;
            since += end + 1 - start;
            start = end + 1;
            if since > 1 << 20 {
                p.bytes.fetch_add(since as u64, Ordering::Relaxed);
                since = 0;
                if p.cancel.load(Ordering::Relaxed) {
                    return Err(Error::Cancelled);
                }
            }
        }
        p.bytes.fetch_add(since as u64, Ordering::Relaxed);
        Ok(())
    })?;
    Ok((time, cols))
}

fn parse_quoted<T: Store>(body: &[u8], l: &Layout, p: &Progress) -> Result<(Vec<f64>, Vec<Vec<T>>), Error> {
    let est = count_records(body);
    let mut time = Vec::with_capacity(est);
    let mut cols: Vec<Vec<T>> = (0..l.slots).map(|_| Vec::with_capacity(est)).collect();
    let mut i = 0usize;
    let mut since = 0usize;
    while i < body.len() {
        // find end of record honouring quotes
        let mut q = false;
        let mut j = i;
        while j < body.len() {
            match body[j] {
                b'"' => q = !q,
                b'\n' if !q => break,
                _ => {}
            }
            j += 1;
        }
        let rec = &body[i..j];
        if !rec.iter().all(|c| c.is_ascii_whitespace()) {
            let fields = split_record(rec, l.delim);
            let t = fields.get(l.time_field).map(|f| parse_time(f, l.fmt)).unwrap_or(f64::NAN);
            time.push(t);
            for c in cols.iter_mut() {
                c.push(T::NAN);
            }
            if !t.is_nan() {
                for (f, s) in l.slot_of.iter().enumerate() {
                    if *s >= 0 {
                        let v = fields.get(f).map(|x| parse_number(x, l.decimal_comma)).unwrap_or(f64::NAN);
                        *cols[*s as usize].last_mut().unwrap() = T::from(v);
                    }
                }
            }
        }
        since += j + 1 - i;
        i = j + 1;
        if since > 1 << 20 {
            p.bytes.fetch_add(since as u64, Ordering::Relaxed);
            since = 0;
            if p.cancel.load(Ordering::Relaxed) {
                return Err(Error::Cancelled);
            }
        }
    }
    Ok((time, cols))
}

/// Drop rows without a valid timestamp, in place.
fn compact<T: Store>(time: &mut Vec<f64>, cols: &mut [Vec<T>]) -> u64 {
    let mut w = 0usize;
    for r in 0..time.len() {
        if time[r].is_nan() {
            continue;
        }
        if w != r {
            time[w] = time[r];
            for c in cols.iter_mut() {
                c[w] = c[r];
            }
        }
        w += 1;
    }
    let skipped = (time.len() - w) as u64;
    time.truncate(w);
    for c in cols.iter_mut() {
        c.truncate(w);
    }
    skipped
}

fn sort_by_time<T: Store>(time: &mut Vec<f64>, cols: &mut [Vec<T>]) {
    let sorted = time.par_windows(2).all(|w| w[0] <= w[1]);
    if sorted {
        return;
    }
    let mut idx: Vec<u32> = (0..time.len() as u32).collect();
    idx.par_sort_by(|&a, &b| time[a as usize].total_cmp(&time[b as usize]));
    *time = idx.par_iter().map(|&i| time[i as usize]).collect();
    cols.par_iter_mut().for_each(|c| *c = idx.iter().map(|&i| c[i as usize]).collect());
}

fn run<T: Store>(body: &[u8], l: &Layout, p: &Progress, names: Vec<String>) -> Result<Parsed, Error> {
    let quoted = memchr::memchr(b'"', body).is_some();
    let (mut time, mut cols) = if quoted { parse_quoted::<T>(body, l, p)? } else { parse_parallel::<T>(body, l, p)? };
    let skipped = compact(&mut time, &mut cols);
    sort_by_time(&mut time, &mut cols);
    Ok(Parsed { time, columns: names.into_iter().zip(cols.into_iter().map(T::wrap)).collect(), skipped })
}

pub fn import(path: &Path, s: &ImportSettings, p: &Progress) -> Result<Parsed, Error> {
    let file = File::open(path)?;
    if file.metadata()?.len() == 0 {
        return Err(Error::msg("파일이 비어 있습니다."));
    }
    // SAFETY: read-only map; the file may change underneath, which at worst yields odd values.
    let map = unsafe { memmap2::Mmap::map(&file)? };
    let data = skip_bom(&map);
    let delim = s.delimiter.bytes().next().unwrap_or(b',');
    let first_end = memchr::memchr(b'\n', data).unwrap_or(data.len());
    let first = split_record(&data[..first_end], delim);
    let header: Vec<String> = first
        .iter()
        .enumerate()
        .map(|(i, c)| {
            let n = String::from_utf8_lossy(c).trim().to_string();
            if s.has_header && !n.is_empty() { n } else { format!("col{}", i + 1) }
        })
        .collect();
    let find = |name: &str| header.iter().position(|h| h == name);
    let time_field = find(&s.time_column).ok_or_else(|| Error::msg(format!("시간 열 '{}' 을(를) 찾을 수 없습니다.", s.time_column)))?;
    let mut names = Vec::new();
    let mut slot_of = vec![-1i32; header.len()];
    for c in &s.columns {
        if let Some(f) = find(c) {
            if f != time_field && slot_of[f] < 0 {
                slot_of[f] = names.len() as i32;
                names.push(c.clone());
            }
        }
    }
    if names.is_empty() {
        return Err(Error::msg("가져올 열을 찾을 수 없습니다."));
    }
    let body = if s.has_header { &data[(first_end + 1).min(data.len())..] } else { data };
    let l = Layout { delim, time_field, slots: names.len(), slot_of, fmt: s.time_format, decimal_comma: delim != b',' };
    let parsed = if s.compact { run::<f32>(body, &l, p, names)? } else { run::<f64>(body, &l, p, names)? };
    if parsed.time.is_empty() {
        return Err(Error::msg("유효한 타임스탬프가 있는 행이 없습니다. 시간 열/형식을 확인하세요."));
    }
    Ok(parsed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn tmp(name: &str, content: &str) -> std::path::PathBuf {
        let p = std::env::temp_dir().join(format!("chronos-test-{}-{}", std::process::id(), name));
        File::create(&p).unwrap().write_all(content.as_bytes()).unwrap();
        p
    }
    fn settings(delim: &str, cols: &[&str], fmt: TimeFormat) -> ImportSettings {
        ImportSettings { delimiter: delim.into(), has_header: true, time_column: "time".into(), time_format: fmt, columns: cols.iter().map(|s| s.to_string()).collect(), compact: false }
    }
    fn prog() -> (AtomicU64, AtomicBool) {
        (AtomicU64::new(0), AtomicBool::new(false))
    }

    #[test]
    fn preview_detects_layout() {
        let p = tmp("pv.csv", "Datum;Spannung;Strom;Status\n01.03.2026 00:00:00;230,1;10.1;on\n13.03.2026 00:01:00;231,2;10.2;off\n");
        let pv = preview(&p, None).unwrap();
        assert_eq!(pv.delimiter, ";");
        assert!(pv.has_header);
        assert_eq!(pv.time_column, 0);
        assert_eq!(pv.numeric_columns, vec![1, 2, 3]);
        assert_eq!(pv.time_format, TimeFormat::Dmy);
    }

    #[test]
    fn parallel_parse_unsorted_gaps_and_bad_rows() {
        let mut s = String::from("time,a,b\n");
        for i in (0..200_000).rev() {
            s.push_str(&format!("{},{},{}\n", 1_700_000_000 + i, i, if i % 7 == 0 { String::new() } else { format!("{}", i * 2) }));
        }
        s.push_str("garbage,1,2\n\n");
        let p = tmp("par.csv", &s);
        let (b, c) = prog();
        let r = import(&p, &settings(",", &["a", "b"], TimeFormat::EpochS), &Progress { bytes: &b, cancel: &c }).unwrap();
        assert_eq!(r.time.len(), 200_000);
        assert_eq!(r.skipped, 2); // garbage row + empty line
        assert!(r.time.windows(2).all(|w| w[0] < w[1]));
        assert_eq!(r.columns[0].1.get(5), 5.0);
        assert!(r.columns[1].1.get(7).is_nan());
        assert_eq!(r.columns[1].1.get(8), 16.0);
    }

    #[test]
    fn quoted_file_falls_back() {
        let p = tmp("q.csv", "\"time\",\"label\",\"value\"\n\"2026-02-01 00:00:01\",\"a, b\",1.5\n\"2026-02-01 00:00:02\",\"x\",\"2.5\"\n");
        let (b, c) = prog();
        let r = import(&p, &settings(",", &["value"], TimeFormat::Iso), &Progress { bytes: &b, cancel: &c }).unwrap();
        assert_eq!(r.time.len(), 2);
        assert_eq!(r.columns[0].1.get(1), 2.5);
    }
}
