/**
 * Annotations: notes on a chart at a moment or over a span, with the data
 * there and the view they were made in. Opening one restores that view.
 */
import { formatDuration, formatTime } from './data/time';
import { store } from './store';
import type { Annotation } from './types';
import { notice } from './ui/overlays';

export const ANNOTATION_COLORS = ['#e9973f', '#e93147', '#08b94e', '#086ddd', '#a882ff', '#e0de71'];

export function whenText(a: Annotation): string {
  if (a.kind === 'point' || a.t2 === undefined) return formatTime(a.t, a.t % 1000 !== 0);
  return `${formatTime(a.t)} → ${formatTime(a.t2)} (${formatDuration(a.t2 - a.t)})`;
}

/** First line of the note (for labels). */
export const noteTitle = (a: Annotation) => a.note.split('\n')[0].trim() || (a.kind === 'point' ? '포인트 주석' : '구간 주석');

/** Bring back the screen the annotation was made on: worksheet, x range, y zoom, visible series. */
export function openAnnotation(a: Annotation) {
  const ws = store.sheet(a.worksheetId);
  if (!ws) {
    notice(`"${a.sheetName}" 워크시트가 삭제되어 열 수 없습니다.`, 5000, 'error');
    return;
  }
  store.setActive(ws.id);
  const w = store.widget(ws.id, a.widgetId);
  if (!w) {
    store.setRange(ws.id, a.view.range);
    notice(`"${a.widgetTitle}" 위젯이 삭제되어 시간 범위만 되돌렸습니다.`, 5000);
    store.focusAnnotation(a.id);
    return;
  }
  const visible = new Set(a.view.visible);
  const known = w.series.some((s) => visible.has(s.id));
  for (const s of w.series) if (known) s.visible = visible.has(s.id);
  if (w.linked) {
    store.updateWidget(ws.id, w.id, { yAxis: { ...a.view.yAxis } });
    store.setRange(ws.id, a.view.range);
  } else {
    store.updateWidget(ws.id, w.id, { yAxis: { ...a.view.yAxis }, range: { ...a.view.range } });
    store.emit('range', ws.id);
  }
  store.select(w.id);
  store.focusAnnotation(a.id);
}
