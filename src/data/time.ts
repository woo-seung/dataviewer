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
  if (!Number.isNaN(n)) return n;
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

/** Plotly date axes report ranges as 'YYYY-MM-DD HH:MM:SS.ffff' strings in UTC. */
export function plotlyDateToMs(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v !== 'string') return NaN;
  return parseTime(v, 'iso');
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
