//! Timestamp parsing straight from bytes. Zone-less stamps are taken as UTC
//! wall-clock time so charts show exactly what the file says.

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum TimeFormat {
    #[default]
    Auto,
    Iso,
    Dmy,
    Mdy,
    EpochS,
    EpochMs,
}

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (m + if m > 2 { -3 } else { 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

struct Cur<'a> {
    b: &'a [u8],
    i: usize,
}

impl<'a> Cur<'a> {
    fn peek(&self) -> Option<u8> {
        self.b.get(self.i).copied()
    }
    /// Read 1..=max digits.
    fn num(&mut self, min: usize, max: usize) -> Option<i64> {
        let start = self.i;
        let mut v = 0i64;
        while self.i < self.b.len() && self.i - start < max && self.b[self.i].is_ascii_digit() {
            v = v * 10 + (self.b[self.i] - b'0') as i64;
            self.i += 1;
        }
        if self.i - start >= min { Some(v) } else { None }
    }
    fn eat(&mut self, c: u8) -> bool {
        if self.peek() == Some(c) {
            self.i += 1;
            true
        } else {
            false
        }
    }
    fn done(&self) -> bool {
        self.i >= self.b.len()
    }
}

/// `[ T]hh:mm[:ss[.fff]][Z|±hh[:]mm]` after a date; returns ms offset or None.
fn time_part(c: &mut Cur) -> Option<f64> {
    if c.done() {
        return Some(0.0);
    }
    match c.peek()? {
        b'T' | b't' | b' ' => c.i += 1,
        _ => return None,
    }
    while c.eat(b' ') {}
    let hh = c.num(1, 2)?;
    if !c.eat(b':') {
        return None;
    }
    let mi = c.num(2, 2)?;
    let mut ms = (hh * 3_600_000 + mi * 60_000) as f64;
    if c.eat(b':') {
        let ss = c.num(2, 2)?;
        ms += (ss * 1000) as f64;
        if c.eat(b'.') || c.eat(b',') {
            let mut scale = 100.0;
            while let Some(d) = c.peek().filter(|d| d.is_ascii_digit()) {
                ms += (d - b'0') as f64 * scale;
                scale /= 10.0;
                c.i += 1;
            }
        }
    }
    while c.eat(b' ') {}
    if c.done() {
        return Some(ms);
    }
    match c.peek()? {
        b'Z' | b'z' => {
            c.i += 1;
            c.done().then_some(ms)
        }
        s @ (b'+' | b'-') => {
            c.i += 1;
            let oh = c.num(2, 2)?;
            c.eat(b':');
            let om = c.num(2, 2)?;
            let off = ((oh * 60 + om) * 60_000) as f64;
            c.done().then_some(if s == b'-' { ms + off } else { ms - off })
        }
        _ => None,
    }
}

fn parse_ymd(b: &[u8]) -> Option<f64> {
    let mut c = Cur { b, i: 0 };
    let y = c.num(4, 4)?;
    let sep = c.peek()?;
    if !matches!(sep, b'-' | b'/' | b'.') {
        return None;
    }
    c.i += 1;
    let m = c.num(1, 2)?;
    if !c.eat(sep) {
        return None;
    }
    let d = c.num(1, 2)?;
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    let day = days_from_civil(y, m, d) as f64 * 86_400_000.0;
    Some(day + time_part(&mut c)?)
}

/// `d.m.yyyy` / `m/d/yyyy` (+ time). `day_first`: None = decide per cell.
fn parse_dmy(b: &[u8], day_first: Option<bool>) -> Option<f64> {
    let mut c = Cur { b, i: 0 };
    let a = c.num(1, 2)?;
    let sep = c.peek()?;
    if !matches!(sep, b'-' | b'/' | b'.') {
        return None;
    }
    c.i += 1;
    let bb = c.num(1, 2)?;
    if !c.eat(sep) {
        return None;
    }
    let y = c.num(4, 4)?;
    let df = day_first.unwrap_or(if a > 12 { true } else if bb > 12 { false } else { sep != b'/' });
    let (d, m) = if df { (a, bb) } else { (bb, a) };
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    let day = days_from_civil(y, m, d) as f64 * 86_400_000.0;
    Some(day + time_part(&mut c)?)
}

fn epoch_auto(n: f64) -> f64 {
    let a = n.abs();
    if a > 1e17 {
        n / 1e6
    } else if a > 1e14 {
        n / 1e3
    } else if a > 1e11 {
        n
    } else {
        n * 1000.0
    }
}

fn trim(mut b: &[u8]) -> &[u8] {
    while let [first, rest @ ..] = b {
        if matches!(first, b' ' | b'\t' | b'"') { b = rest } else { break }
    }
    while let [rest @ .., last] = b {
        if matches!(last, b' ' | b'\t' | b'\r' | b'"') { b = rest } else { break }
    }
    b
}

fn is_number(b: &[u8]) -> bool {
    b.iter().any(|c| c.is_ascii_digit()) && fast_float2::parse::<f64, _>(b).is_ok()
}

/// Epoch milliseconds, or NaN.
pub fn parse_time(raw: &[u8], fmt: TimeFormat) -> f64 {
    let b = trim(raw);
    if b.is_empty() {
        return f64::NAN;
    }
    let num = || fast_float2::parse::<f64, _>(b).ok();
    let r = match fmt {
        TimeFormat::EpochS => num().map(|n| n * 1000.0),
        TimeFormat::EpochMs => num(),
        TimeFormat::Iso => parse_ymd(b),
        TimeFormat::Dmy => parse_dmy(b, Some(true)),
        TimeFormat::Mdy => parse_dmy(b, Some(false)),
        TimeFormat::Auto => {
            if is_number(b) {
                num().map(epoch_auto)
            } else {
                parse_ymd(b).or_else(|| parse_dmy(b, None))
            }
        }
    };
    r.unwrap_or(f64::NAN)
}

/// Pick one concrete format from sample cells so the full parse skips guessing.
pub fn detect_format(samples: &[&[u8]]) -> TimeFormat {
    let cells: Vec<&[u8]> = samples.iter().map(|s| trim(s)).filter(|s| !s.is_empty()).collect();
    if cells.is_empty() {
        return TimeFormat::Auto;
    }
    if cells.iter().all(|c| is_number(c)) {
        let m = cells.iter().filter_map(|c| fast_float2::parse::<f64, _>(*c).ok()).fold(0f64, |a, v| a.max(v.abs()));
        return if m < 1e11 { TimeFormat::EpochS } else if m < 1e14 { TimeFormat::EpochMs } else { TimeFormat::Auto };
    }
    if cells.iter().all(|c| parse_ymd(c).is_some()) {
        return TimeFormat::Iso;
    }
    if cells.iter().all(|c| parse_dmy(c, None).is_some()) {
        let parts = |c: &[u8]| {
            let mut cur = Cur { b: c, i: 0 };
            let a = cur.num(1, 2).unwrap_or(0);
            cur.i += 1;
            let b = cur.num(1, 2).unwrap_or(0);
            (a, b, c.contains(&b'/'))
        };
        if cells.iter().any(|c| parts(c).0 > 12) {
            return TimeFormat::Dmy;
        }
        if cells.iter().any(|c| parts(c).1 > 12) {
            return TimeFormat::Mdy;
        }
        return if parts(cells[0]).2 { TimeFormat::Mdy } else { TimeFormat::Dmy };
    }
    TimeFormat::Auto
}

#[cfg(test)]
mod tests {
    use super::*;
    fn t(s: &str) -> f64 {
        parse_time(s.as_bytes(), TimeFormat::Auto)
    }
    #[test]
    fn iso_variants() {
        assert_eq!(t("2026-01-01 12:34:56"), 1767270896000.0);
        assert_eq!(t("2026-01-01T12:34:56.789Z"), 1767270896789.0);
        assert_eq!(t("2026-01-01T12:34:56+09:00"), 1767238496000.0);
        assert_eq!(t("2026-01-01 12:34"), 1767270840000.0);
        assert_eq!(t("2026-01-01"), 1767225600000.0);
        assert_eq!(t("2026/03/05 01:02:03,5"), 1772672523500.0);
        assert_eq!(t("2026-1-5 1:02:03"), 1767574923000.0);
        assert!(t("hello").is_nan());
    }
    #[test]
    fn dmy_and_epoch() {
        assert_eq!(t("13.03.2026 00:00:00"), parse_time(b"2026-03-13", TimeFormat::Iso));
        assert_eq!(parse_time(b"03/13/2026", TimeFormat::Auto), parse_time(b"2026-03-13", TimeFormat::Iso));
        assert_eq!(t("1767225600"), 1767225600000.0);
        assert_eq!(t("1767225600123"), 1767225600123.0);
    }
    #[test]
    fn detect() {
        assert_eq!(detect_format(&[b"01.03.2026 00:00", b"13.03.2026 00:00"]), TimeFormat::Dmy);
        assert_eq!(detect_format(&[b"1767225600"]), TimeFormat::EpochS);
        assert_eq!(detect_format(&[b"2026-01-01 00:00:00"]), TimeFormat::Iso);
    }
}
