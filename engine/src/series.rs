//! Column storage, block summary index, M4 windows and window statistics.

pub const BLOCK: usize = 64;

#[derive(Debug)]
pub enum Values {
    F64(Vec<f64>),
    F32(Vec<f32>),
}

impl Values {
    pub fn len(&self) -> usize {
        match self {
            Values::F64(v) => v.len(),
            Values::F32(v) => v.len(),
        }
    }
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
    #[inline]
    pub fn get(&self, i: usize) -> f64 {
        match self {
            Values::F64(v) => v[i],
            Values::F32(v) => v[i] as f64,
        }
    }
    pub fn bytes(&self) -> &[u8] {
        match self {
            Values::F64(v) => bytemuck::cast_slice(v),
            Values::F32(v) => bytemuck::cast_slice(v),
        }
    }
    pub fn dtype(&self) -> &'static str {
        match self {
            Values::F64(_) => "f64",
            Values::F32(_) => "f32",
        }
    }
    pub fn byte_len(&self) -> usize {
        self.bytes().len()
    }
}

/// Per-64-row summaries: min/max (with their row), sum and non-NaN count.
#[derive(Debug, Default)]
pub struct Blocks {
    pub min: Vec<f64>,
    pub max: Vec<f64>,
    pub min_idx: Vec<u32>,
    pub max_idx: Vec<u32>,
    pub sum: Vec<f64>,
    pub count: Vec<u32>,
}

trait Num: Copy + Send + Sync {
    fn f(self) -> f64;
}
impl Num for f64 {
    #[inline]
    fn f(self) -> f64 {
        self
    }
}
impl Num for f32 {
    #[inline]
    fn f(self) -> f64 {
        self as f64
    }
}

fn build_blocks_t<T: Num>(v: &[T]) -> Blocks {
    let nb = v.len().div_ceil(BLOCK);
    let mut b = Blocks {
        min: Vec::with_capacity(nb),
        max: Vec::with_capacity(nb),
        min_idx: Vec::with_capacity(nb),
        max_idx: Vec::with_capacity(nb),
        sum: Vec::with_capacity(nb),
        count: Vec::with_capacity(nb),
    };
    for (k, chunk) in v.chunks(BLOCK).enumerate() {
        let base = k * BLOCK;
        let (mut mn, mut mx, mut mni, mut mxi, mut s, mut c) = (f64::INFINITY, f64::NEG_INFINITY, base, base, 0.0, 0u32);
        for (j, x) in chunk.iter().enumerate() {
            let x = x.f();
            if x.is_nan() {
                continue;
            }
            if x < mn {
                mn = x;
                mni = base + j;
            }
            if x > mx {
                mx = x;
                mxi = base + j;
            }
            s += x;
            c += 1;
        }
        b.min.push(if c > 0 { mn } else { f64::NAN });
        b.max.push(if c > 0 { mx } else { f64::NAN });
        b.min_idx.push(mni as u32);
        b.max_idx.push(mxi as u32);
        b.sum.push(s);
        b.count.push(c);
    }
    b
}

pub fn build_blocks(v: &Values) -> Blocks {
    match v {
        Values::F64(x) => build_blocks_t(x),
        Values::F32(x) => build_blocks_t(x),
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Agg {
    pub min: f64,
    pub max: f64,
    pub min_idx: usize,
    pub max_idx: usize,
    pub sum: f64,
    pub count: u64,
}

impl Agg {
    fn new() -> Self {
        Agg { min: f64::INFINITY, max: f64::NEG_INFINITY, min_idx: 0, max_idx: 0, sum: 0.0, count: 0 }
    }
}

fn aggregate_t<T: Num>(v: &[T], bl: &Blocks, a: usize, b: usize) -> Agg {
    let mut g = Agg::new();
    let raw = |from: usize, to: usize, g: &mut Agg| {
        for (i, x) in v[from..to].iter().enumerate() {
            let x = x.f();
            if x.is_nan() {
                continue;
            }
            if x < g.min {
                g.min = x;
                g.min_idx = from + i;
            }
            if x > g.max {
                g.max = x;
                g.max_idx = from + i;
            }
            g.sum += x;
            g.count += 1;
        }
    };
    if b <= a {
        return g;
    }
    if b - a < BLOCK * 2 || bl.count.is_empty() {
        raw(a, b, &mut g);
        return g;
    }
    let k0 = a.div_ceil(BLOCK);
    let k1 = b / BLOCK;
    raw(a, k0 * BLOCK, &mut g);
    for k in k0..k1 {
        let c = bl.count[k];
        if c == 0 {
            continue;
        }
        if bl.min[k] < g.min {
            g.min = bl.min[k];
            g.min_idx = bl.min_idx[k] as usize;
        }
        if bl.max[k] > g.max {
            g.max = bl.max[k];
            g.max_idx = bl.max_idx[k] as usize;
        }
        g.sum += bl.sum[k];
        g.count += c as u64;
    }
    raw(k1 * BLOCK, b, &mut g);
    g
}

pub fn aggregate(v: &Values, bl: &Blocks, a: usize, b: usize) -> Agg {
    match v {
        Values::F64(x) => aggregate_t(x, bl, a, b),
        Values::F32(x) => aggregate_t(x, bl, a, b),
    }
}

/// First index with time[i] >= t.
pub fn lower_bound(time: &[f64], t: f64) -> usize {
    time.partition_point(|&x| x < t)
}

pub fn nearest(time: &[f64], t: f64) -> Option<usize> {
    if time.is_empty() {
        return None;
    }
    let i = lower_bound(time, t);
    if i == 0 {
        return Some(0);
    }
    if i >= time.len() {
        return Some(time.len() - 1);
    }
    Some(if t - time[i - 1] <= time[i] - t { i - 1 } else { i })
}

pub struct Window {
    pub x: Vec<f64>,
    /// NaN marks a gap.
    pub y: Vec<f64>,
    pub raw: usize,
}

/// Slice [start, end] (plus one neighbour each side) and reduce with M4:
/// per time bucket keep first / min / max / last, via the block index.
pub fn window(time: &[f64], v: &Values, bl: &Blocks, start: f64, end: f64, max_points: usize) -> Window {
    let i0 = lower_bound(time, start).saturating_sub(1);
    let i1 = (lower_bound(time, end) + 1).min(time.len());
    let n = i1.saturating_sub(i0);
    if max_points == 0 || n <= max_points {
        return Window { x: time[i0..i1].to_vec(), y: (i0..i1).map(|i| v.get(i)).collect(), raw: n };
    }
    let buckets = (max_points / 4).max(1);
    let t0 = time[i0];
    let span = (time[i1 - 1] - t0).max(1e-9);
    let mut x = Vec::with_capacity(buckets * 4 + 2);
    let mut y = Vec::with_capacity(buckets * 4 + 2);
    let mut a = i0;
    for k in 0..buckets {
        if a >= i1 {
            break;
        }
        let b = if k == buckets - 1 {
            i1
        } else {
            lower_bound(time, t0 + span * (k + 1) as f64 / buckets as f64).clamp(a, i1)
        };
        if b <= a {
            continue;
        }
        let g = aggregate(v, bl, a, b);
        if g.count == 0 {
            if y.last().is_some_and(|l: &f64| !l.is_nan()) {
                x.push(time[a]);
                y.push(f64::NAN);
            }
            a = b;
            continue;
        }
        let mut fi = a;
        while v.get(fi).is_nan() {
            fi += 1;
        }
        let mut li = b - 1;
        while v.get(li).is_nan() {
            li -= 1;
        }
        let mut idx = [fi, g.min_idx, g.max_idx, li];
        idx.sort_unstable();
        let mut prev = usize::MAX;
        for i in idx {
            if i == prev {
                continue;
            }
            prev = i;
            x.push(time[i]);
            y.push(v.get(i));
        }
        a = b;
    }
    Window { x, y, raw: n }
}

#[derive(serde::Serialize, Debug, Clone, Copy)]
pub struct Stats {
    pub min: f64,
    pub max: f64,
    pub mean: f64,
    pub count: u64,
}

pub fn stats(time: &[f64], v: &Values, bl: &Blocks, start: f64, end: f64) -> Stats {
    let i0 = lower_bound(time, start);
    let i1 = time.partition_point(|&x| x <= end);
    let g = aggregate(v, bl, i0, i1.max(i0));
    if g.count == 0 {
        return Stats { min: f64::NAN, max: f64::NAN, mean: f64::NAN, count: 0 };
    }
    Stats { min: g.min, max: g.max, mean: g.sum / g.count as f64, count: g.count }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn m4_and_stats_match_brute_force() {
        let n = 1_000_003;
        let t: Vec<f64> = (0..n).map(|i| i as f64 * 10.0).collect();
        let v: Vec<f32> = (0..n)
            .map(|i| if i % 100_000 < 50 { f32::NAN } else { (i as f32 / 1000.0).sin() + if i == 777_777 { 50.0 } else { 0.0 } })
            .collect();
        let vals = Values::F32(v.clone());
        let bl = build_blocks(&vals);
        let w = window(&t, &vals, &bl, 0.0, t[n - 1], 4000);
        assert!(w.x.len() <= 4002);
        assert!(w.y.iter().cloned().fold(f64::MIN, f64::max) > 49.0, "spike kept");
        let s = stats(&t, &vals, &bl, 12_345.0, 8_000_000.0);
        let (mut mn, mut mx, mut sum, mut c) = (f64::MAX, f64::MIN, 0.0, 0u64);
        for i in 0..n {
            if t[i] < 12_345.0 || t[i] > 8_000_000.0 || v[i].is_nan() {
                continue;
            }
            let x = v[i] as f64;
            mn = mn.min(x);
            mx = mx.max(x);
            sum += x;
            c += 1;
        }
        assert_eq!(s.count, c);
        assert_eq!(s.min, mn);
        assert_eq!(s.max, mx);
        assert!((s.mean - sum / c as f64).abs() < 1e-9);
    }
}
