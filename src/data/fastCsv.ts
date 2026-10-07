/**
 * Byte-level CSV scanner for the common "machine-written" case: single-byte
 * delimiter, no quoted fields, ASCII numbers. Fields are located by offset and
 * numbers/ISO timestamps are parsed straight from the bytes, so no per-cell
 * strings are created. Several times faster than a general tokenizer on
 * multi-hundred-MB files. Callers must fall back to a full CSV parser when
 * `QuoteFound` is thrown.
 */
import { parseNumber, parseTime, type TimeFormat } from './time';

export class QuoteFound extends Error {}

const POW10 = Array.from({ length: 23 }, (_, i) => 10 ** i);
const decoder = new TextDecoder();

/** Parse [a, b) as a float; exact for ≤15 significant digits (Clinger fast path), else defers to Number(). */
export function parseFloatBytes(buf: Uint8Array, a: number, b: number, decimalComma: boolean): number {
  while (a < b && (buf[a] === 32 || buf[a] === 9)) a++;
  while (b > a && (buf[b - 1] === 32 || buf[b - 1] === 9)) b--;
  if (a >= b) return NaN;
  let i = a;
  let neg = false;
  if (buf[i] === 45) {
    neg = true;
    i++;
  } else if (buf[i] === 43) i++;
  let mant = 0;
  let digits = 0;
  let frac = 0;
  let any = false;
  while (i < b) {
    const d = buf[i] - 48;
    if (d < 0 || d > 9) break;
    if (digits || d) digits++;
    mant = mant * 10 + d;
    any = true;
    i++;
  }
  if (i < b && (buf[i] === 46 || (decimalComma && buf[i] === 44))) {
    i++;
    while (i < b) {
      const d = buf[i] - 48;
      if (d < 0 || d > 9) break;
      if (digits || d) digits++;
      mant = mant * 10 + d;
      frac++;
      any = true;
      i++;
    }
  }
  let exp = 0;
  if (any && i < b && (buf[i] === 101 || buf[i] === 69)) {
    i++;
    let eneg = false;
    if (buf[i] === 45) {
      eneg = true;
      i++;
    } else if (buf[i] === 43) i++;
    let e = 0;
    let ed = false;
    while (i < b) {
      const d = buf[i] - 48;
      if (d < 0 || d > 9) break;
      e = e * 10 + d;
      ed = true;
      i++;
    }
    if (!ed) return slow(buf, a, b);
    exp = eneg ? -e : e;
  }
  if (!any || i !== b) return slow(buf, a, b);
  if (digits > 15) return slow(buf, a, b);
  const p = exp - frac;
  let v: number;
  if (p === 0) v = mant;
  else if (p > 0 && p <= 22) v = mant * POW10[p];
  else if (p < 0 && p >= -22) v = mant / POW10[-p];
  else return slow(buf, a, b);
  return neg ? -v : v;
}

function slow(buf: Uint8Array, a: number, b: number): number {
  return parseNumber(decoder.decode(buf.subarray(a, b)));
}

const dd = (buf: Uint8Array, i: number) => {
  const x = buf[i] - 48;
  const y = buf[i + 1] - 48;
  return x >= 0 && x <= 9 && y >= 0 && y <= 9 ? x * 10 + y : -1;
};

function daysFromCivil(y: number, m: number, d: number): number {
  y -= m <= 2 ? 1 : 0;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  return era * 146097 + yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy - 719468;
}

// Cache of the last date (YYYYMMDD) → epoch day, since consecutive rows share it.
let lastYmd = -1;
let lastDay = 0;

/** Byte version of parseIsoFast; NaN when the layout differs. */
export function parseIsoBytes(buf: Uint8Array, a: number, b: number): number {
  while (b > a && (buf[b - 1] === 32 || buf[b - 1] === 13)) b--;
  while (a < b && buf[a] === 32) a++;
  const n = b - a;
  if (n < 10) return NaN;
  const y1 = dd(buf, a);
  const y2 = dd(buf, a + 2);
  const sep = buf[a + 4];
  if (y1 < 0 || y2 < 0 || (sep !== 45 && sep !== 47 && sep !== 46) || buf[a + 7] !== sep) return NaN;
  const mo = dd(buf, a + 5);
  const da = dd(buf, a + 8);
  if (mo < 1 || mo > 12 || da < 1 || da > 31) return NaN;
  const ymd = (y1 * 100 + y2) * 10000 + mo * 100 + da;
  if (ymd !== lastYmd) {
    lastYmd = ymd;
    lastDay = daysFromCivil(y1 * 100 + y2, mo, da);
  }
  let ms = lastDay * 86400000;
  if (n === 10) return ms;
  const t = buf[a + 10];
  if ((t !== 84 && t !== 32 && t !== 116) || n < 16 || buf[a + 13] !== 58) return NaN;
  const hh = dd(buf, a + 11);
  const mi = dd(buf, a + 14);
  if (hh < 0 || mi < 0) return NaN;
  ms += hh * 3600000 + mi * 60000;
  let i = a + 16;
  if (i < b && buf[i] === 58) {
    const ss = dd(buf, i + 1);
    if (ss < 0) return NaN;
    ms += ss * 1000;
    i += 3;
    if (i < b && (buf[i] === 46 || buf[i] === 44)) {
      i++;
      let scale = 100;
      while (i < b) {
        const d = buf[i] - 48;
        if (d < 0 || d > 9) break;
        ms += d * scale;
        scale /= 10;
        i++;
      }
    }
  }
  if (i === b) return ms;
  if ((buf[i] === 90 || buf[i] === 122) && i === b - 1) return ms;
  const z = buf[i];
  if (z === 43 || z === 45) {
    const oh = dd(buf, i + 1);
    const om = buf[i + 3] === 58 ? dd(buf, i + 4) : dd(buf, i + 3);
    if (oh < 0 || om < 0) return NaN;
    return ms - (z === 45 ? -1 : 1) * (oh * 60 + om) * 60000;
  }
  return NaN;
}

export interface ScanSink {
  /** Called once per data row with the parsed time; return false to skip the row. */
  row(t: number): void;
  value(slot: number, v: number): void;
  /** Number of output columns (values for missing fields are NaN). */
  slots: number;
  skipped(): void;
}

export interface ScanOptions {
  delimiter: number;
  hasHeader: boolean;
  timeColumn: number;
  timeFormat: TimeFormat;
  /** field index → output slot (-1 = ignore) */
  slotOf: Int32Array;
}

/**
 * Scan one chunk of whole lines. Returns the offset of the first byte that
 * belongs to an incomplete trailing line (to be prepended to the next chunk).
 */
export function scanChunk(buf: Uint8Array, final: boolean, o: ScanOptions, sink: ScanSink, state: { header: boolean }): number {
  const d = o.delimiter;
  const decimalComma = d !== 44;
  const tc = o.timeColumn;
  const slotOf = o.slotOf;
  const nf = slotOf.length;
  const fmt = o.timeFormat;
  const seen = new Uint8Array(sink.slots);
  let pos = 0;
  const len = buf.length;
  while (pos < len) {
    let eol = buf.indexOf(10, pos);
    if (eol < 0) {
      if (!final) return pos;
      eol = len;
    }
    let end = eol;
    if (end > pos && buf[end - 1] === 13) end--;
    if (end === pos) {
      pos = eol + 1;
      continue;
    }
    if (state.header) {
      state.header = false;
      pos = eol + 1;
      continue;
    }
    // locate the time field first (rows with a bad stamp are skipped)
    let f = 0;
    let a = pos;
    let ta = -1;
    let tb = -1;
    for (let i = pos; i <= end; i++) {
      const c = i < end ? buf[i] : d;
      if (c === 34) throw new QuoteFound();
      if (c === d) {
        if (f === tc) {
          ta = a;
          tb = i;
          break;
        }
        f++;
        a = i + 1;
      }
    }
    let t = NaN;
    if (ta >= 0) {
      if (fmt === 'iso') t = parseIsoBytes(buf, ta, tb);
      else if (fmt === 'epoch-ms') t = parseFloatBytes(buf, ta, tb, false);
      else if (fmt === 'epoch-s') t = parseFloatBytes(buf, ta, tb, false) * 1000;
      if (t !== t) t = parseTime(decoder.decode(buf.subarray(ta, tb)), fmt);
    }
    if (t !== t) {
      sink.skipped();
      pos = eol + 1;
      continue;
    }
    sink.row(t);
    seen.fill(0);
    f = 0;
    a = pos;
    for (let i = pos; i <= end && f < nf; i++) {
      const c = i < end ? buf[i] : d;
      if (c === 34) throw new QuoteFound();
      if (c === d) {
        const s = slotOf[f];
        if (s >= 0) {
          sink.value(s, parseFloatBytes(buf, a, i, decimalComma));
          seen[s] = 1;
        }
        f++;
        a = i + 1;
      }
    }
    for (let s = 0; s < seen.length; s++) if (!seen[s]) sink.value(s, NaN);
    pos = eol + 1;
  }
  return len;
}
