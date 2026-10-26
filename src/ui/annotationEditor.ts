/** Popover to write / edit an annotation's note and colour (Ctrl+Enter saves, Esc cancels). */
import { MessageSquare, Trash2 } from 'lucide';
import { ANNOTATION_COLORS, whenText } from '../annotations';
import { store } from '../store';
import type { Annotation, AnnotationValue } from '../types';
import { formatValue, h, icon } from '../util';

let open: { el: HTMLElement; close: (save: boolean) => void } | null = null;

export function closeAnnotationEditor(save = true) {
  open?.close(save);
}

const fmt = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : formatValue(v));

/** The captured data as a small table (value at a point, or min / max / mean over a range). */
export function valuesTable(a: Annotation, limit = 8): HTMLElement {
  const range = a.kind !== 'point';
  const t = h('table', { class: 'anno-values' });
  t.append(h('tr', {}, h('th', {}, '시리즈'), ...(range ? [h('th', {}, '최소'), h('th', {}, '최대'), h('th', {}, '평균')] : [h('th', {}, '값')])));
  const row = (v: AnnotationValue) =>
    h('tr', {}, h('td', { title: v.column }, v.label), ...(range ? [h('td', {}, fmt(v.min)), h('td', {}, fmt(v.max)), h('td', {}, fmt(v.mean))] : [h('td', {}, fmt(v.value))]));
  a.values.slice(0, limit).forEach((v) => t.append(row(v)));
  if (a.values.length > limit) t.append(h('tr', {}, h('td', { class: 'muted', colspan: range ? 4 : 2 }, `외 ${a.values.length - limit}개`)));
  return t;
}

export function openAnnotationEditor(a: Annotation, at: { x: number; y: number }, isNew: boolean) {
  closeAnnotationEditor(true);
  let color = a.color;
  const text = h('textarea', { class: 'anno-text', placeholder: '메모를 입력하세요… (Ctrl+Enter 저장)', rows: 4 }) as HTMLTextAreaElement;
  text.value = a.note;
  const swatches = h('div', { class: 'anno-colors' });
  const paint = () =>
    swatches.replaceChildren(
      ...ANNOTATION_COLORS.map((c) => {
        const b = h('button', { type: 'button', class: `anno-color ${c === color ? 'is-active' : ''}`, style: `--c:${c}`, 'aria-label': c });
        b.addEventListener('click', () => {
          color = c;
          paint();
        });
        return b;
      }),
    );
  paint();
  const done = (save: boolean) => {
    if (!open || open.el !== el) return;
    open = null;
    el.remove();
    document.removeEventListener('pointerdown', outside, true);
    if (save) store.updateAnnotation(a.id, { note: text.value.trim(), color });
    else if (isNew) store.removeAnnotation(a.id);
  };
  const btn = (label: string, fn: () => void, cls = '') => {
    const b = h('button', { type: 'button', class: cls }, label);
    b.addEventListener('click', fn);
    return b;
  };
  const el = h(
    'div',
    { class: 'anno-editor', role: 'dialog', 'aria-label': '주석' },
    h('div', { class: 'anno-editor-head' }, icon(MessageSquare, 14), h('span', {}, a.kind === 'point' ? '포인트 주석' : a.kind === 'chart' ? '차트 주석' : '구간 주석'), h('span', { class: 'anno-when' }, whenText(a))),
    text,
    swatches,
    ...(a.view.snapshot ? [h('img', { class: 'anno-shot', src: a.view.snapshot, alt: '주석을 달 때의 차트' })] : []),
    ...(a.values.length ? [valuesTable(a, 6)] : []),
    h(
      'div',
      { class: 'anno-editor-actions' },
      isNew ? h('span') : (() => {
        const d = h('button', { type: 'button', class: 'mod-warning anno-delete', title: '주석 삭제' }, icon(Trash2, 14));
        d.addEventListener('click', () => {
          done(false);
          store.removeAnnotation(a.id);
        });
        return d;
      })(),
      h('span', { class: 'spacer' }),
      btn('취소', () => done(false)),
      btn('저장', () => done(true), 'mod-cta'),
    ),
  );
  text.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) done(true);
    else if (e.key === 'Escape') done(false);
  });
  // clicking elsewhere keeps what was typed
  const outside = (e: PointerEvent) => {
    if (!el.contains(e.target as Node)) done(true);
  };
  document.body.append(el);
  const r = el.getBoundingClientRect();
  el.style.left = `${Math.max(8, Math.min(window.innerWidth - r.width - 8, at.x + 12))}px`;
  el.style.top = `${Math.max(8, Math.min(window.innerHeight - r.height - 8, at.y + 12))}px`;
  open = { el, close: done };
  setTimeout(() => document.addEventListener('pointerdown', outside, true));
  text.focus();
}
