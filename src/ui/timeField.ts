/**
 * Time range field: plain "YYYY-MM-DD HH:MM[:SS]" text (always the same
 * format, whatever the browser locale), typed in directly or picked from the
 * calendar. Without data it reads "—" instead of an empty date mask.
 */
import { Calendar } from 'lucide';
import { formatTime, fromInputValue, parseTime, toInputValue } from '../data/time';
import { h, iconButton } from '../util';

export interface TimeField {
  el: HTMLElement;
  /** Show a time (null = no data). Ignored while the user is typing. */
  set(ms: number | null): void;
}

/** "YYYY-MM-DD HH:MM", with ":SS" only when the seconds are not zero. */
const show = (ms: number) => {
  const t = formatTime(ms);
  return t.endsWith(':00') ? t.slice(0, -3) : t;
};

export function timeField(label: string, commit: (ms: number) => void): TimeField {
  const input = h('input', { type: 'text', class: 'time-input', 'aria-label': label, spellcheck: false, placeholder: '—', title: `${label} — 입력 후 Enter (예: 2026-01-31 14:00)` }) as HTMLInputElement;
  // native picker, opened from the calendar button only
  const picker = h('input', { type: 'datetime-local', step: '1', class: 'time-picker', tabindex: -1, 'aria-hidden': 'true' }) as HTMLInputElement;
  const btn = iconButton(Calendar, `${label} 달력에서 고르기`, () => {
    try {
      (picker as HTMLInputElement & { showPicker?: () => void }).showPicker?.();
    } catch {
      picker.focus();
    }
  }, 'clickable-icon time-picker-btn', 14);
  let shown = NaN;
  const render = () => {
    input.value = Number.isFinite(shown) ? show(shown) : '';
    input.classList.remove('is-invalid');
  };
  const apply = () => {
    const v = input.value.trim();
    if (!v || (Number.isFinite(shown) && v === show(shown))) return render();
    const ms = parseTime(v, 'auto');
    if (!Number.isFinite(ms)) {
      input.classList.add('is-invalid');
      return;
    }
    commit(ms);
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      apply();
      if (!input.classList.contains('is-invalid')) input.blur();
    } else if (e.key === 'Escape') {
      render();
      input.blur();
    }
  });
  input.addEventListener('blur', () => (input.classList.contains('is-invalid') ? render() : apply()));
  input.addEventListener('focus', () => input.select());
  picker.addEventListener('change', () => {
    const ms = fromInputValue(picker.value);
    if (Number.isFinite(ms)) commit(ms);
  });
  return {
    el: h('span', { class: 'time-field' }, input, btn, picker),
    set(ms) {
      shown = ms ?? NaN;
      input.disabled = btn.disabled = ms === null;
      picker.value = ms === null ? '' : toInputValue(ms);
      if (document.activeElement !== input) render();
    },
  };
}
