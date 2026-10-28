export type TimeFormat = 'auto' | 'iso' | 'dmy' | 'mdy' | 'epoch-s' | 'epoch-ms';

const ISO_RE =
  /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i;
const DMY_RE =
  /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i;
const NUM_RE = /^[-+]?\d+(?:\.\d+)?(?:e[-+]?\d+)?$/i;

function fracMs(f: string | undefined): number {
  if (!f) return 0;
  return Number((f + '00').slice(0, 3)) + (f.length > 3 ? Number('0.' + f.slice(3)) : 0);
}

function tzOffsetMs(tz: string | undefined): number {
  if (!tz || tz.toUpperCase() === 'Z') return 0;
  const sign = tz[0] === '-' ? -1 : 1;
  const digits = tz.slice(1).replace(':', '');
  return sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4))) * 60000;
}

function epochAuto(n: number): number {
  const a = Math.abs(n);
  if (a > 1e17) return n / 1e6; // ns
  if (a > 1e14) return n / 1e3; // µs
  if (a > 1e11) return n; // ms
  return n * 1000; // s
}

function daysFromCivil(y: number, m: number, d: number): number {
  y -= m <= 2 ? 1 : 0;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/**
 * Allocation-free parser for fixed-width ISO-like stamps
 * (YYYY-MM-DD[ T]hh:mm[:ss[.fff…]][Z|±hh[:]mm]); ~10× faster than the regex
 * path on multi-million-row files. Returns NaN when the layout differs.
 */
export function parseIsoFast(s: string): number {
  const n = s.length;
  if (n < 10) return NaN;
  const c = (i: number) => s.charCodeAt(i) - 48;
  const dd = (i: number) => {
    const a = c(i);
    const b = c(i + 1);
    return a >= 0 && a <= 9 && b >= 0 && b <= 9 ? a * 10 + b : -1;
  };
  const y1 = dd(0);
  const y2 = dd(2);
  const sep = s.charCodeAt(4);
  if (y1 < 0 || y2 < 0 || (sep !== 45 && sep !== 47 && sep !== 46) || s.charCodeAt(7) !== sep) return NaN;
  const mo = dd(5);
  const da = dd(8);
  if (mo < 1 || mo > 12 || da < 1 || da > 31) return NaN;
  let ms = daysFromCivil(y1 * 100 + y2, mo, da) * 86400000;
  if (n === 10) return ms;
  const t = s.charCodeAt(10);
  if ((t !== 84 && t !== 32 && t !== 116) || n < 16 || s.charCodeAt(13) !== 58) return NaN;
  const hh = dd(11);
  const mi = dd(14);
  if (hh < 0 || mi < 0) return NaN;
  ms += hh * 3600000 + mi * 60000;
  let i = 16;
  if (i < n && s.charCodeAt(i) === 58) {
    const ss = dd(17);
    if (ss < 0) return NaN;
    ms += ss * 1000;
    i = 19;
    const f = s.charCodeAt(i);
    if (i < n && (f === 46 || f === 44)) {
      i++;
      let scale = 100;
      let frac = 0;
      while (i < n) {
        const d = c(i);
        if (d < 0 || d > 9) break;
        frac += d * scale;
        scale /= 10;
        i++;
      }
      ms += frac;
    }
  }
  if (i === n) return ms;
  let z = s.charCodeAt(i);
  if (z === 32 && i + 1 < n) z = s.charCodeAt(++i);
  if ((z === 90 || z === 122) && i === n - 1) return ms;
  if (z === 43 || z === 45) {
    const oh = dd(i + 1);
    const om = s.charCodeAt(i + 3) === 58 ? dd(i + 4) : dd(i + 3);
    if (oh < 0 || om < 0) return NaN;
    return ms - (z === 45 ? -1 : 1) * (oh * 60 + om) * 60000;
  }
  return NaN;
}

/** Pick one concrete format from sample cells so the full parse skips guessing. */
export function detectTimeFormat(samples: string[]): TimeFormat {
  const cells = samples.map((v) => v.trim()).filter(Boolean);
  if (!cells.length) return 'auto';
  if (cells.every((v) => NUM_RE.test(v))) {
    const m = Math.max(...cells.map((v) => Math.abs(Number(v))));
    if (m < 1e11) return 'epoch-s';
    if (m < 1e14) return 'epoch-ms';
    return 'auto';
  }
  if (cells.every((v) => ISO_RE.test(v))) return 'iso';
  if (cells.every((v) => DMY_RE.test(v))) {
    const parts = cells.map((v) => DMY_RE.exec(v)!);
    if (parts.some((m) => +m[1] > 12)) return 'dmy';
    if (parts.some((m) => +m[2] > 12)) return 'mdy';
    return cells[0].includes('/') ? 'mdy' : 'dmy';
  }
  return 'auto';
}

/**
 * Parse a timestamp cell into epoch milliseconds.
 * Timestamps without an explicit zone are interpreted as UTC wall-clock time,
 * so the chart shows exactly what the file says.
 */
export function parseTime(raw: string, fmt: TimeFormat = 'auto'): number {
  const s = raw.trim();
  if (!s) return NaN;
  if (fmt === 'epoch-s') return Number(s) * 1000;
  if (fmt === 'epoch-ms') return Number(s);
  if (NUM_RE.test(s)) {
    return fmt === 'auto' ? epochAuto(Number(s)) : NaN;
  }
  if (fmt === 'auto' || fmt === 'iso') {
    const fast = parseIsoFast(s);
    if (fast === fast) return fast;
    const m = ISO_RE.exec(s);
    if (m) {
      return (
        Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0)) +
        fracMs(m[7]) -
        tzOffsetMs(m[8])
      );
    }
  }
  if (fmt === 'auto' || fmt === 'dmy' || fmt === 'mdy') {
    const m = DMY_RE.exec(s);
    if (m) {
      const a = +m[1];
      const b = +m[2];
      // auto: whichever part cannot be a month decides; otherwise '/' reads month-first (US),
      // '.' and '-' read day-first.
      let dayFirst = fmt === 'dmy';
      if (fmt === 'auto') dayFirst = a > 12 ? true : b > 12 ? false : !s.includes('/');
      const day = dayFirst ? a : b;
      const month = dayFirst ? b : a;
      return (
        Date.UTC(+m[3], month - 1, day, +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0)) +
        fracMs(m[7]) -
        tzOffsetMs(m[8])
      );
    }
  }
  if (fmt !== 'auto') return NaN;
  const t = Date.parse(s);
  if (Number.isNaN(t)) return NaN;
  // Date.parse reads zone-less strings as local time; normalise to wall-clock UTC.
  return /[zZ]|[+-]\d{2}:?\d{2}$|GMT|UTC/.test(s) ? t : t - new Date(t).getTimezoneOffset() * 60000;
}

export function parseNumber(raw: string): number {
  if (raw === '' || raw == null) return NaN;
  const n = Number(raw);
  // Number('  ') === 0, so a zero needs a digit to be real
  if (n === n) return n !== 0 || /\d/.test(raw) ? n : NaN;
  const t = raw.trim();
  if (!t) return NaN;
  const lower = t.toLowerCase();
  if (lower === 'true' || lower === 'on') return 1;
  if (lower === 'false' || lower === 'off') return 0;
  // "1,5" decimal comma (only when there is exactly one comma and no dot)
  if (/^[-+]?\d+,\d+$/.test(t)) return Number(t.replace(',', '.'));
  return NaN;
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** Format epoch ms as wall-clock text (UTC-based, matches chart display). */
export function formatTime(ms: number, withMs = false): string {
  if (!Number.isFinite(ms)) return '—';
  const d = new Date(ms);
  const base = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(
    d.getUTCHours(),
  )}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  return withMs ? `${base}.${pad(d.getUTCMilliseconds(), 3)}` : base;
}

/** Value for <input type="datetime-local"> in wall-clock UTC. */
export function toInputValue(ms: number): string {
  return formatTime(ms).replace(' ', 'T');
}

export function fromInputValue(v: string): number {
  return parseTime(v.replace('T', ' '), 'iso');
}

export function formatDuration(ms: number): string {
  const a = Math.abs(ms);
  if (a < 1000) return `${Math.round(a)} ms`;
  const s = a / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 2 : 1)} s`;
  const m = s / 60;
  if (m < 60) return `${m.toFixed(1)} min`;
  const h = m / 60;
  if (h < 48) return `${h.toFixed(1)} h`;
  const d = h / 24;
  if (d < 365) return `${d.toFixed(1)} d`;
  return `${(d / 365).toFixed(2)} y`;
}
