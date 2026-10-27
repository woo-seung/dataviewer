/**
 * The worksheet's time range as three typed fields: start → end and the
 * duration. Edits stay pending while Tab moves between them; Enter (or
 * leaving the group) applies them together, Esc puts the range back.
 *
 * - "202610101350 ⇥ 202610121600 ⏎" sets both ends.
 * - start + duration → the end is computed (and shown as you type);
 *   end + duration → the start. The one typed last is the anchor.
 * - "+2h" in the end / "-3d" in the start count from the other end.
 */
import { formatDuration } from '../data/time';
import { h } from '../util';
import { parseDuration, parseTimeInput, showTime, timeField, type TimeField } from './timeField';

export interface Range {
  start: number;
  end: number;
}

export class RangeEditor {
  readonly el: HTMLElement;
  private from: TimeField;
  private to: TimeField;
  private dur: HTMLInputElement;
  private whole: HTMLElement;
  private current: Range | null = null;
  /** the end the user typed last: the duration counts from it */
  private anchor: 'start' | 'end' = 'start';
  private durDirty = false;
  private last: 'start' | 'end' | 'dur' = 'start';

  constructor(
    private readonly apply: (r: Range) => void,
    /** start / end fields live at either side of the "→" */
    sep: HTMLElement,
  ) {
    this.from = timeField('시작 시각', (a) => this.pick('start', a));
    this.to = timeField('종료 시각', (b) => this.pick('end', b));
    this.dur = h('input', {
      type: 'text',
      class: 'dur-input',
      'aria-label': '기간',
      spellcheck: false,
      placeholder: '기간',
      title: '기간 — 예: 2h, 1h 30m, 3d, 90분 · 시작을 적고 기간을 넣으면 종료가, 종료를 적고 넣으면 시작이 계산됩니다',
    }) as HTMLInputElement;
    this.whole = h('span', { class: 'range-whole', title: '범위를 지정하지 않아 전체 데이터를 보는 중' }, '전체');
    this.el = h('span', { class: 'range-editor' }, this.from.el, sep, this.to.el, h('span', { class: 'dur-field' }, this.dur, this.whole));

    this.from.input.addEventListener('input', () => {
      this.anchor = this.last = 'start';
      this.preview();
    });
    this.to.input.addEventListener('input', () => {
      this.anchor = this.last = 'end';
      this.preview();
    });
    this.dur.addEventListener('input', () => {
      this.durDirty = true;
      this.last = 'dur';
      this.dur.classList.remove('is-invalid');
      this.preview();
    });
    this.dur.addEventListener('focus', () => this.dur.select());
    this.el.addEventListener('keydown', (e) => {
      if (!(e.target instanceof HTMLInputElement) || e.target.type !== 'text') return;
      if (e.key === 'Enter') {
        e.preventDefault();
        if (this.commit()) (e.target as HTMLInputElement).blur();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.reset();
        (e.target as HTMLInputElement).blur();
      }
    });
    // leaving the group applies what was typed (Tab inside it does not)
    this.el.addEventListener('focusout', (e) => {
      const next = (e as FocusEvent).relatedTarget as Node | null;
      if (next && this.el.contains(next)) return;
      if (this.pending() && !this.commit()) this.reset();
    });
  }

  /** Show the worksheet's range (null = no data); `whole` = no range set, all data. */
  set(r: Range | null, whole: boolean) {
    this.current = r;
    this.from.set(r ? r.start : null);
    this.to.set(r ? r.end : null);
    this.dur.disabled = !r;
    this.whole.hidden = !r || !whole;
    if (!this.durDirty || !this.el.contains(document.activeElement)) this.showDur(r);
  }

  private showDur(r: Range | null) {
    this.dur.value = r ? formatDuration(r.end - r.start) : '';
    this.dur.classList.remove('is-invalid');
    this.durDirty = false;
  }

  private pending() {
    return this.from.dirty || this.to.dirty || this.durDirty;
  }

  /** What the fields say right now, or which one cannot be read. */
  private resolve(): { range: Range; byDur: boolean } | { bad: 'start' | 'end' | 'dur' } | null {
    const cur = this.current;
    if (!cur) return null;
    const curDur = cur.end - cur.start;
    const typedS = this.from.dirty;
    const typedE = this.to.dirty;
    // both ends typed after the duration: they win and the duration follows
    const byDur = this.durDirty && (this.last === 'dur' || !(typedS && typedE));
    let D = NaN;
    if (byDur) {
      D = parseDuration(this.dur.value);
      if (!(D > 0)) return { bad: 'dur' };
    }
    // "+2h" / "-3d" count from the other end as it stands
    let S = typedS ? parseTimeInput(this.from.input.value, typedE ? NaN : cur.end) : cur.start;
    let E = typedE ? parseTimeInput(this.to.input.value, Number.isFinite(S) ? S : cur.start) : cur.end;
    if (typedS && !Number.isFinite(S) && typedE && Number.isFinite(E)) S = parseTimeInput(this.from.input.value, E);
    if (!Number.isFinite(S)) return { bad: 'start' };
    if (!Number.isFinite(E)) return { bad: 'end' };
    if (Number.isFinite(D)) {
      // a duration moves the end that was not typed (the end, unless only the end was)
      const fromEnd = typedE && (!typedS || this.anchor === 'end');
      return { range: fromEnd ? { start: E - D, end: E } : { start: S, end: S + D }, byDur };
    }
    if (E > S) return { range: { start: S, end: E }, byDur };
    // an end before the start: keep the length and move the window to what was typed last
    const keepEnd = typedE && (!typedS || this.anchor === 'end');
    return { range: keepEnd ? { start: E - curDur, end: E } : { start: S, end: S + curDur }, byDur };
  }

  /** Live: show the computed other end / duration while typing. */
  private preview() {
    this.from.invalid(false);
    this.to.invalid(false);
    const r = this.resolve();
    if (!r || 'bad' in r) return;
    const { start, end } = r.range;
    if (!this.from.dirty) this.from.input.value = showTime(start);
    if (!this.to.dirty) this.to.input.value = showTime(end);
    if (!r.byDur) {
      this.dur.value = formatDuration(end - start);
      this.durDirty = false;
    }
  }

  /** Apply the typed range; false (and the field marked) if something can't be read. */
  private commit(): boolean {
    const r = this.resolve();
    if (!r) return false;
    if ('bad' in r) {
      const f = r.bad === 'dur' ? null : r.bad === 'start' ? this.from : this.to;
      if (f) {
        f.invalid(true);
        f.input.focus();
      } else {
        this.dur.classList.add('is-invalid');
        this.dur.focus();
      }
      return false;
    }
    this.durDirty = false;
    this.from.reset();
    this.to.reset();
    this.apply(r.range);
    return true;
  }

  reset() {
    this.from.reset();
    this.to.reset();
    this.showDur(this.current);
    this.set(this.current, !this.whole.hidden);
  }

  /** Calendar pick: applies at once, keeping the other end (or the length when it would cross). */
  private pick(which: 'start' | 'end', t: number) {
    const r = this.current;
    if (!r) return;
    const len = r.end - r.start;
    if (which === 'start') this.apply(t < r.end ? { start: t, end: r.end } : { start: t, end: t + len });
    else this.apply(t > r.start ? { start: r.start, end: t } : { start: t - len, end: t });
  }
}
