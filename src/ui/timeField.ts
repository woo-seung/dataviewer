/**
 * Time range fields: plain "YYYY-MM-DD HH:MM[:SS]" text (one format whatever
 * the browser locale), typed in or picked from the calendar. Typing accepts
 * compact digits (202610101350), ISO-like text and offsets (+2h, -3d).
 */
import { Calendar } from 'lucide';
import { formatTime, fromInputValue, parseTime, toInputValue } from '../data/time';
import { h, iconButton } from '../util';

/** "YYYY-MM-DD HH:MM", with ":SS" only when the seconds are not zero. */
export const showTime = (ms: number) => {
  const t = formatTime(ms);
  return t.endsWith(':00') ? t.slice(0, -3) : t;
};

const UNITS: [RegExp, number][] = [
  [/^(ms|밀리초)$/, 1],
  [/^(s|sec|secs|second|seconds|초)$/, 1e3],
  [/^(m|min|mins|minute|minutes|분)$/, 60e3],
  [/^(h|hr|hrs|hour|hours|시|시간)$/, 3600e3],
  [/^(d|day|days|일)$/, 86400e3],
  [/^(w|wk|week|weeks|주|주일)$/, 7 * 86400e3],
  [/^(mo|mon|month|months|개월|달)$/, 30 * 86400e3],
  [/^(y|yr|year|years|년)$/, 365 * 86400e3],
];

/**
 * A length of time: "2h", "1h 30m", "1.5d", "90분", "3일 12시간", "1.72 y".
 * A bare number means hours.
 */
export function parseDuration(text: string): number {
  const s = text.trim().toLowerCase().replace(/,/g, '');
  if (!s) return NaN;
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s) * 3600e3;
  const re = /(\d+(?:\.\d+)?)\s*([a-z가-힣]+)/g;
  let total = 0;
  let used = 0;
  for (const m of s.matchAll(re)) {
    const unit = UNITS.find(([u]) => u.test(m[2]));
    if (!unit) return NaN;
    total += Number(m[1]) * unit[1];
    used += m[0].length;
  }
  // everything but spaces must have been understood
  return used && used >= s.replace(/\s+/g, '').length ? total : NaN;
}

/** Compact digits: YYYYMMDD[HH[MM[SS]]] (UTC). */
function compact(s: string): number {
  const m = /^(\d{4})(\d{2})(\d{2})(?:[ T]?(\d{2})(\d{2})?(\d{2})?)?$/.exec(s);
  if (!m) return NaN;
  const [, y, mo, d, hh = '0', mi = '0', ss = '0'] = m;
  const t = Date.UTC(+y, +mo - 1, +d, +hh, +mi, +ss);
  const back = new Date(t);
  // reject 20261340 and the like
  return back.getUTCMonth() === +mo - 1 && back.getUTCDate() === +d && +hh < 24 && +mi < 60 && +ss < 60 ? t : NaN;
}

/** A moment typed in a range field; `base` anchors "+2h" / "-3d". NaN if unreadable. */
export function parseTimeInput(text: string, base?: number): number {
  const s = text.trim();
  if (!s) return NaN;
  const rel = /^([+-])\s*(.+)$/.exec(s);
  if (rel && base !== undefined && Number.isFinite(base)) {
    const d = parseDuration(rel[2]);
    return Number.isFinite(d) ? base + (rel[1] === '+' ? d : -d) : NaN;
  }
  const c = compact(s.replace(/[\s:./-]/g, (ch) => (ch === ' ' ? ' ' : '')).replace(/\s+/g, ''));
  if (Number.isFinite(c) && /^\d{8,14}$/.test(s.replace(/\s+/g, ''))) return c;
  // plain long numbers would be read as epoch time: only accept them as dates above
  if (/^\d+$/.test(s)) return NaN;
  return parseTime(s.replace(/\//g, '-'), 'auto');
}

export interface TimeField {
  el: HTMLElement;
  input: HTMLInputElement;
  /** Show a time (null = no data). Ignored while the user is typing in it. */
  set(ms: number | null): void;
  /** The user typed something not yet applied. */
  readonly dirty: boolean;
  /** Back to the shown time. */
  reset(): void;
  invalid(on: boolean): void;
}

export function timeField(label: string, onPick: (ms: number) => void): TimeField {
  const input = h('input', {
    type: 'text',
    class: 'time-input',
    'aria-label': label,
    spellcheck: false,
    placeholder: '—',
    title: `${label} — 예: 202610101350, 2026-10-10 13:50, +2h · Tab으로 다음 칸, Enter로 적용, Esc 취소`,
  }) as HTMLInputElement;
  // native picker, opened from the calendar button only
  const picker = h('input', { type: 'datetime-local', step: '1', class: 'time-picker', tabindex: -1, 'aria-hidden': 'true' }) as HTMLInputElement;
  const btn = iconButton(
    Calendar,
    `${label} 달력에서 고르기`,
    () => {
      try {
        (picker as HTMLInputElement & { showPicker?: () => void }).showPicker?.();
      } catch {
        picker.focus();
      }
    },
    'clickable-icon time-picker-btn',
    14,
  );
  btn.tabIndex = -1; // Tab goes straight from field to field
  let shown = NaN;
  let dirty = false;
  const render = () => {
    input.value = Number.isFinite(shown) ? showTime(shown) : '';
    input.classList.remove('is-invalid');
    dirty = false;
  };
  input.addEventListener('input', () => {
    dirty = true;
    input.classList.remove('is-invalid');
  });
  input.addEventListener('focus', () => input.select());
  picker.addEventListener('change', () => {
    const ms = fromInputValue(picker.value);
    if (Number.isFinite(ms)) onPick(ms);
  });
  return {
    el: h('span', { class: 'time-field' }, input, btn, picker),
    input,
    set(ms) {
      shown = ms ?? NaN;
      input.disabled = btn.disabled = ms === null;
      picker.value = ms === null ? '' : toInputValue(ms);
      if (document.activeElement !== input || !dirty) render();
    },
    get dirty() {
      return dirty && input.value.trim() !== (Number.isFinite(shown) ? showTime(shown) : '');
    },
    reset: render,
    invalid(on) {
      input.classList.toggle('is-invalid', on);
    },
  };
}
