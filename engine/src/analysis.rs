//! Aggregations for non-time-series charts (plugins): series aligned on
//! shared timestamps, regression, 1-D / 2-D histograms and calendar buckets.
//! Everything runs over the full data in the engine; only results go out.

use serde::Serialize;

use crate::series::{lower_bound, Values};

/// One series as (timestamps, values).
pub struct Col<'a> {
    pub time: &'a [f64],
    pub values: &'a Values,
}

fn span(time: &[f64], start: f64, end: f64) -> (usize, usize) {
    let a = if start.is_finite() { lower_bound(time, start) } else { 0 };
    let b = if end.is_finite() { time.partition_point(|&x| x <= end) } else { time.len() };
    (a, b.max(a))
}

/// Visit rows where every series has a sample at the same timestamp (inner
/// join on time), within [start, end]. Series of one source share timestamps,
/// so this is a plain scan for them.
pub fn for_each_aligned(cols: &[Col], start: f64, end: f64, mut f: impl FnMut(f64, &[f64])) {
    if cols.is_empty() {
        return;
    }
    let base = cols[0].time;
    let (a, b) = span(base, start, end);
    let same = cols.iter().all(|c| std::ptr::eq(c.time, base));
    let mut row = vec![0f64; cols.len()];
    if same {
        for i in a..b {
            for (k, c) in cols.iter().enumerate() {
                row[k] = c.values.get(i);
            }
            f(base[i], &row);
        }
        return;
    }
    let mut ptr: Vec<usize> = cols.iter().map(|c| span(c.time, start, end).0).collect();
    'rows: for i in a..b {
        let t = base[i];
        row[0] = cols[0].values.get(i);
        for k in 1..cols.len() {
            let tk = cols[k].time;
            let p = &mut ptr[k];
            while *p < tk.len() && tk[*p] < t {
                *p += 1;
            }
            if *p >= tk.len() || tk[*p] != t {
                continue 'rows;
            }
            row[k] = cols[k].values.get(*p);
        }
        f(t, &row);
    }
}

/// Aligned rows, evenly thinned to at most `max_rows`. Returns (rows total, time, columns).
pub fn aligned(cols: &[Col], start: f64, end: f64, max_rows: usize) -> (usize, Vec<f64>, Vec<Vec<f64>>) {
    let mut total = 0usize;
    for_each_aligned(cols, start, end, |_, _| total += 1);
    let step = if max_rows == 0 || total <= max_rows { 1 } else { total.div_ceil(max_rows) };
    let cap = total / step + 1;
    let mut time = Vec::with_capacity(cap);
    let mut out: Vec<Vec<f64>> = cols.iter().map(|_| Vec::with_capacity(cap)).collect();
    let mut i = 0usize;
    for_each_aligned(cols, start, end, |t, row| {
        if i % step == 0 {
            time.push(t);
            for (k, v) in row.iter().enumerate() {
                out[k].push(*v);
            }
        }
        i += 1;
    });
    (total, time, out)
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Regression {
    pub n: u64,
    pub slope: Option<f64>,
    pub intercept: Option<f64>,
    pub r: Option<f64>,
    pub r2: Option<f64>,
    pub x_mean: Option<f64>,
    pub y_mean: Option<f64>,
    pub x_min: Option<f64>,
    pub x_max: Option<f64>,
}

/// Least-squares line y = slope·x + intercept over all aligned (x, y) pairs.
pub fn regress(x: &Col, y: &Col, start: f64, end: f64) -> Regression {
    // Welford-style running sums for numerical stability
    let (mut n, mut mx, mut my, mut sxx, mut syy, mut sxy) = (0f64, 0f64, 0f64, 0f64, 0f64, 0f64);
    let (mut lo, mut hi) = (f64::INFINITY, f64::NEG_INFINITY);
    for_each_aligned(&[Col { time: x.time, values: x.values }, Col { time: y.time, values: y.values }], start, end, |_, r| {
        let (a, b) = (r[0], r[1]);
        if a.is_nan() || b.is_nan() {
            return;
        }
        n += 1.0;
        let dx = a - mx;
        let dy = b - my;
        mx += dx / n;
        my += dy / n;
        sxx += dx * (a - mx);
        syy += dy * (b - my);
        sxy += dx * (b - my);
        lo = lo.min(a);
        hi = hi.max(a);
    });
    if n < 2.0 {
        return Regression { n: n as u64, ..Default::default() };
    }
    let slope = if sxx > 0.0 { Some(sxy / sxx) } else { None };
    let r = if sxx > 0.0 && syy > 0.0 { Some(sxy / (sxx * syy).sqrt()) } else { None };
    Regression {
        n: n as u64,
        slope,
        intercept: slope.map(|s| my - s * mx),
        r,
        r2: r.map(|r| r * r),
        x_mean: Some(mx),
        y_mean: Some(my),
        x_min: Some(lo),
        x_max: Some(hi),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Histogram {
    pub min: f64,
    pub max: f64,
    pub counts: Vec<u64>,
    pub total: u64,
}

fn min_max(c: &Col, a: usize, b: usize) -> (f64, f64) {
    let (mut lo, mut hi) = (f64::INFINITY, f64::NEG_INFINITY);
    for i in a..b {
        let v = c.values.get(i);
        if !v.is_nan() {
            lo = lo.min(v);
            hi = hi.max(v);
        }
    }
    (lo, hi)
}

#[inline]
fn bin(v: f64, lo: f64, hi: f64, n: usize) -> Option<usize> {
    if v.is_nan() || v < lo || v > hi {
        return None;
    }
    if hi <= lo {
        return Some(0);
    }
    Some((((v - lo) / (hi - lo)) * n as f64).floor().min(n as f64 - 1.0) as usize)
}

/// Value histogram over [start, end]; range defaults to the data's min / max.
pub fn hist(c: &Col, start: f64, end: f64, bins: usize, range: Option<(f64, f64)>) -> Histogram {
    let bins = bins.clamp(1, 10_000);
    let (a, b) = span(c.time, start, end);
    let (lo, hi) = range.unwrap_or_else(|| min_max(c, a, b));
    let mut counts = vec![0u64; bins];
    let mut total = 0;
    if lo.is_finite() && hi.is_finite() {
        for i in a..b {
            if let Some(k) = bin(c.values.get(i), lo, hi, bins) {
                counts[k] += 1;
                total += 1;
            }
        }
    }
    Histogram { min: lo, max: hi, counts, total }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Histogram2d {
    pub x_min: f64,
    pub x_max: f64,
    pub y_min: f64,
    pub y_max: f64,
    pub x_bins: usize,
    pub y_bins: usize,
    /// Row-major: counts[yi * x_bins + xi].
    pub counts: Vec<u64>,
    pub total: u64,
}

/// Density of aligned (x, y) pairs on a grid.
pub fn hist2d(x: &Col, y: &Col, start: f64, end: f64, bx: usize, by: usize) -> Histogram2d {
    let (bx, by) = (bx.clamp(1, 2000), by.clamp(1, 2000));
    let cols = [Col { time: x.time, values: x.values }, Col { time: y.time, values: y.values }];
    let (mut x0, mut x1, mut y0, mut y1) = (f64::INFINITY, f64::NEG_INFINITY, f64::INFINITY, f64::NEG_INFINITY);
    for_each_aligned(&cols, start, end, |_, r| {
        if r[0].is_nan() || r[1].is_nan() {
            return;
        }
        x0 = x0.min(r[0]);
        x1 = x1.max(r[0]);
        y0 = y0.min(r[1]);
        y1 = y1.max(r[1]);
    });
    let mut counts = vec![0u64; bx * by];
    let mut total = 0;
    if x0.is_finite() {
        for_each_aligned(&cols, start, end, |_, r| {
            if let (Some(i), Some(j)) = (bin(r[0], x0, x1, bx), bin(r[1], y0, y1, by)) {
                counts[j * bx + i] += 1;
                total += 1;
            }
        });
    }
    Histogram2d { x_min: x0, x_max: x1, y_min: y0, y_max: y1, x_bins: bx, y_bins: by, counts, total }
}

/// Calendar keys for bucketing (all UTC).
#[derive(Clone, Copy, Debug)]
pub enum Key {
    Minute,
    Hour,
    Weekday,
    DayOfMonth,
    Month,
    Year,
    /// Days since 1970-01-01 (one cell per date).
    Day,
    /// Months since 1970-01 (one cell per month).
    YearMonth,
}

impl Key {
    pub fn parse(s: &str) -> Option<Key> {
        Some(match s {
            "minute" => Key::Minute,
            "hour" => Key::Hour,
            "weekday" => Key::Weekday,
            "dayOfMonth" => Key::DayOfMonth,
            "month" => Key::Month,
            "year" => Key::Year,
            "day" => Key::Day,
            "yearMonth" => Key::YearMonth,
            _ => return None,
        })
    }

    fn of(self, ms: f64) -> i64 {
        let total = ms.floor() as i64;
        let days = total.div_euclid(86_400_000);
        let rem = total.rem_euclid(86_400_000);
        match self {
            Key::Minute => rem / 60_000 % 60,
            Key::Hour => rem / 3_600_000,
            // 1970-01-01 was a Thursday; 0 = Monday
            Key::Weekday => (days + 3).rem_euclid(7),
            Key::Day => days,
            _ => {
                let (y, m, d) = civil(days);
                match self {
                    Key::DayOfMonth => d,
                    Key::Month => m,
                    Key::Year => y,
                    _ => (y - 1970) * 12 + (m - 1),
                }
            }
        }
    }
}

/// (year, month 1-12, day 1-31) from days since the epoch (Howard Hinnant).
fn civil(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[derive(Serialize)]
pub struct Bucket {
    pub a: i64,
    pub b: Option<i64>,
    pub count: u64,
    pub mean: f64,
    pub min: f64,
    pub max: f64,
    pub sum: f64,
}

/// Group samples by one or two calendar keys (e.g. hour × weekday) with count / mean / min / max.
pub fn buckets(c: &Col, start: f64, end: f64, k1: Key, k2: Option<Key>) -> Vec<Bucket> {
    use std::collections::HashMap;
    let (a, b) = span(c.time, start, end);
    let mut map: HashMap<(i64, i64), (u64, f64, f64, f64)> = HashMap::new();
    for i in a..b {
        let v = c.values.get(i);
        if v.is_nan() {
            continue;
        }
        let t = c.time[i];
        let key = (k1.of(t), k2.map_or(0, |k| k.of(t)));
        let e = map.entry(key).or_insert((0, 0.0, f64::INFINITY, f64::NEG_INFINITY));
        e.0 += 1;
        e.1 += v;
        e.2 = e.2.min(v);
        e.3 = e.3.max(v);
    }
    let mut out: Vec<Bucket> = map
        .into_iter()
        .map(|((ka, kb), (n, s, lo, hi))| Bucket { a: ka, b: k2.map(|_| kb), count: n, mean: s / n as f64, min: lo, max: hi, sum: s })
        .collect();
    out.sort_by_key(|x| (x.a, x.b));
    out
}

/// Raw samples within [start, end], evenly thinned to at most `limit`. Returns (total, time, values).
pub fn raw(c: &Col, start: f64, end: f64, limit: usize) -> (usize, Vec<f64>, Vec<f64>) {
    let (a, b) = span(c.time, start, end);
    let total = b - a;
    let step = if limit == 0 || total <= limit { 1 } else { total.div_ceil(limit) };
    let mut t = Vec::with_capacity(total / step + 1);
    let mut v = Vec::with_capacity(total / step + 1);
    let mut i = a;
    while i < b {
        t.push(c.time[i]);
        v.push(c.values.get(i));
        i += step;
    }
    (total, t, v)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn align_regress_hist_buckets() {
        let ta: Vec<f64> = (0..100).map(|i| i as f64 * 1000.0).collect();
        let tb: Vec<f64> = (0..100).map(|i| i as f64 * 2000.0).collect(); // every other stamp of a
        let va = Values::F64((0..100).map(|i| i as f64).collect());
        let vb = Values::F64((0..100).map(|i| 3.0 * (2 * i) as f64 + 1.0).collect()); // y = 3x + 1 on shared stamps
        let a = Col { time: &ta, values: &va };
        let b = Col { time: &tb, values: &vb };
        let (total, t, cols) = aligned(&[Col { time: &ta, values: &va }, Col { time: &tb, values: &vb }], f64::NEG_INFINITY, f64::INFINITY, 10);
        assert_eq!(total, 50);
        assert!(t.len() <= 10 && cols[0].len() == t.len());
        let r = regress(&a, &b, f64::NEG_INFINITY, f64::INFINITY);
        assert_eq!(r.n, 50);
        assert!((r.slope.unwrap() - 3.0).abs() < 1e-9 && (r.intercept.unwrap() - 1.0).abs() < 1e-9);
        assert!((r.r2.unwrap() - 1.0).abs() < 1e-12);
        let h = hist(&a, f64::NEG_INFINITY, f64::INFINITY, 10, None);
        assert_eq!(h.counts, vec![10; 10]);
        let h2 = hist2d(&a, &b, f64::NEG_INFINITY, f64::INFINITY, 5, 5);
        assert_eq!(h2.total, 50);
        assert_eq!(h2.counts.iter().sum::<u64>(), 50);
        // 2026-01-05 is a Monday
        let mon = 1_767_571_200_000f64;
        assert_eq!(Key::Weekday.of(mon), 0);
        assert_eq!(Key::Hour.of(mon + 5.5 * 3_600_000.0), 5);
        assert_eq!(Key::Month.of(mon), 1);
        let tc: Vec<f64> = (0..48).map(|h| mon + h as f64 * 3_600_000.0).collect();
        let vc = Values::F64((0..48).map(|h| (h % 24) as f64).collect());
        let bk = buckets(&Col { time: &tc, values: &vc }, f64::NEG_INFINITY, f64::INFINITY, Key::Hour, Some(Key::Weekday));
        assert_eq!(bk.len(), 48);
        let bh = buckets(&Col { time: &tc, values: &vc }, f64::NEG_INFINITY, f64::INFINITY, Key::Hour, None);
        assert_eq!(bh.len(), 24);
        assert_eq!(bh[5].count, 2);
        assert_eq!(bh[5].mean, 5.0);
    }
}
