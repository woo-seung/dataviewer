/** What a plugin may ask for (ctx.data.* in the sandbox), answered by the engine. */
import { engine, type SeriesKey } from '../engine';
import { store } from '../store';
import type { ColumnRef } from './types';

type Opts = { start?: number | null; end?: number | null; all?: boolean };

const key = (c: unknown): SeriesKey => {
  const r = c as ColumnRef | null;
  if (!r || typeof r.source !== 'string' || typeof r.column !== 'string') throw new Error('열을 지정하세요 (파라미터의 column 값).');
  if (!store.column(r.source, r.column)) throw new Error(`데이터가 로드되지 않은 열입니다: ${r.label ?? r.column}`);
  return { source: r.source, column: r.column };
};

/** API bound to one widget: time options default to the widget's visible range. */
export function pluginApi(wsId: string, widgetId: string, width: () => number) {
  const span = (o: Opts) => {
    if (o.all) return [-8.64e15, 8.64e15];
    const w = store.widget(wsId, widgetId);
    const r = w ? store.widgetRange(wsId, w) : null;
    // no range yet: everything (bounds within the representable dates)
    return [o.start ?? r?.start ?? -8.64e15, o.end ?? r?.end ?? 8.64e15];
  };
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  return async (method: string, a: Record<string, unknown>): Promise<unknown> => {
    const [start, end] = span(a as Opts);
    switch (method) {
      case 'columns':
        return [...store.sources.values()].flatMap((s) =>
          s.columns.map((c) => ({ source: s.id, column: c.name, label: c.name, sourceName: s.name, rows: s.rows, start: s.start, end: s.end, min: c.min, max: c.max, mean: c.mean })),
        );
      case 'stats': {
        const cols = (a.columns as unknown[]) ?? [];
        return engine.stats(cols.map(key), start, end);
      }
      case 'series': {
        const [w] = await engine.window([key(a.column)], start, end, num(a.maxPoints, Math.max(200, Math.round(width() * 2))));
        return { t: w?.x ?? new Float64Array(0), v: w?.y ?? new Float64Array(0), total: w?.raw ?? 0 };
      }
      case 'raw':
        return engine.raw(key(a.column), start, end, num(a.limit, 200_000));
      case 'aligned': {
        const cols = (a.columns as unknown[]) ?? [];
        return engine.aligned(cols.map(key), start, end, num(a.maxRows, 20_000));
      }
      case 'regression':
        return engine.regress(key(a.x), key(a.y), start, end);
      case 'histogram':
        return engine.hist(key(a.column), start, end, num(a.bins, 50), a.min as number | undefined, a.max as number | undefined);
      case 'histogram2d':
        return engine.hist2d(key(a.x), key(a.y), start, end, num(a.xBins ?? a.bins, 50), num(a.yBins ?? a.bins, 50));
      case 'buckets':
        return engine.buckets(key(a.column), start, end, (a.keys as string[]) ?? ['hour']);
      default:
        throw new Error(`알 수 없는 데이터 함수: ${method}`);
    }
  };
}
