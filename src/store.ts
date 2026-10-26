import type {
  ChartType,
  SourceInfo,
  SourceMeta,
  SeriesRef,
  Settings,
  TimeRange,
  WidgetState,
  Workspace,
  Worksheet,
  Annotation,
} from './types';
import { debounce, uid } from './util';
import { nextSlot, slotColor } from './palette';
import { appendRow, distribute, distributeAround, equalize, fromGrid, tileRects, neighbor, insertAt, insertAuto, reconcile, remove, renameLeaves, setSizes, swap, type Side, type Tile } from './layout';

type Events = {
  sources: void;
  worksheets: void;
  active: string;
  widgets: string; // worksheet id: widget list changed
  widget: { ws: string; id: string }; // one widget's config changed
  range: string; // worksheet id: shared timeline changed
  selection: string | null;
  settings: void;
  cursor: { ws: string; x: number | null; from: string | null };
  /** work folder / workspace file / dirty state changed */
  project: void;
  /** annotation list changed */
  annotations: void;
  /** annotation mode switched, or an annotation was focused (transient UI state) */
  annotating: void;
};

type Handler<T> = (payload: T) => void;

/** New widgets split tiles down to this height, then start a new row (px). */
const COMFORT_H = 240;
const ROW_H = 320;

/** Hundreds of lines in one chart are unreadable and make every redraw move tens of MB. */
export const MAX_SERIES_PER_CHART = 64;

const LS_KEY = 'chronos-vault.workspace.v1';

export const DEFAULT_SETTINGS: Settings = {
  theme: 'dark',
  leftOpen: true,
  rightOpen: true,
  leftWidth: 280,
  rightWidth: 300,
  defaultMaxPoints: 4000,
  dragMode: 'zoom',
  zoomY: false,
  rightTab: 'props',
};

function newWorksheet(name: string): Worksheet {
  return { id: uid('ws'), name, widgets: [], range: null, crosshair: true };
}

export function defaultWidget(partial: Partial<WidgetState> = {}): WidgetState {
  return {
    id: uid('w'),
    title: '',
    type: 'line',
    series: [],
    x: 0,
    y: 0,
    w: 6,
    h: 5,
    linked: true,
    range: null,
    yAxis: { auto: true, min: null, max: null, log: false, unit: '', siPrefix: true, includeZero: false },
    showLegend: true,
    lineWidth: 1.5,
    markers: false,
    maxPoints: store?.ws.settings.defaultMaxPoints ?? DEFAULT_SETTINGS.defaultMaxPoints,
    ...partial,
  };
}

interface History {
  back: (TimeRange | null)[];
  fwd: (TimeRange | null)[];
  lastPush: number;
}

class Store {
  sources = new Map<string, SourceInfo>();
  ws: Workspace;
  private handlers = new Map<keyof Events, Set<Handler<never>>>();
  private history = new Map<string, History>();

  /** Hook for the project layer (dirty tracking). */
  onChange?: (ev: keyof Events) => void;
  /** Called when a drop asked for more series than a chart may hold. */
  onSeriesLimit?: (added: number, skipped: number) => void;

  constructor() {
    this.ws = this.load();
  }

  // ---------- events ----------
  on<K extends keyof Events>(ev: K, fn: Handler<Events[K]>): () => void {
    if (!this.handlers.has(ev)) this.handlers.set(ev, new Set());
    this.handlers.get(ev)!.add(fn as Handler<never>);
    return () => this.handlers.get(ev)!.delete(fn as Handler<never>);
  }
  emit<K extends keyof Events>(ev: K, payload: Events[K]) {
    this.handlers.get(ev)?.forEach((fn) => (fn as Handler<Events[K]>)(payload));
    if (ev !== 'cursor' && ev !== 'selection' && ev !== 'project' && ev !== 'annotating') {
      this.save();
      this.onChange?.(ev);
    }
  }

  // ---------- persistence ----------
  private load(): Workspace {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) {
        const w = JSON.parse(raw) as Workspace;
        if (w.version === 1 && w.worksheets?.length) {
          w.settings = { ...DEFAULT_SETTINGS, ...w.settings };
          return w;
        }
      }
    } catch (e) {
      console.warn('workspace load failed', e);
    }
    const first = newWorksheet('Worksheet 1');
    return { version: 1, worksheets: [first], activeId: first.id, selectedWidgetId: null, settings: { ...DEFAULT_SETTINGS } };
  }

  save = debounce(() => {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(this.ws));
    } catch (e) {
      console.warn('workspace save failed', e);
    }
  }, 300);

  replaceWorkspace(w: Workspace, sources: SourceInfo[]) {
    this.sources = new Map(sources.map((s) => [s.id, s]));
    this.ws = { ...w, settings: { ...DEFAULT_SETTINGS, ...w.settings } };
    if (!this.ws.worksheets?.length) this.ws.worksheets = [newWorksheet('Worksheet 1')];
    if (!this.ws.worksheets.some((s) => s.id === this.ws.activeId)) this.ws.activeId = this.ws.worksheets[0].id;
    this.history.clear();
    for (const src of sources) this.upsertMeta(src);
    this.emit('sources', undefined);
    this.emit('settings', undefined);
    this.emit('worksheets', undefined);
    this.emit('active', this.ws.activeId);
  }

  // ---------- sources ----------
  private upsertMeta(s: SourceInfo) {
    const meta: SourceMeta = { id: s.id, name: s.name, path: s.path, columns: s.columns.map((c) => c.name), import: s.import };
    const list = (this.ws.sourceMeta ??= []);
    const i = list.findIndex((m) => m.id === s.id);
    if (i >= 0) list[i] = meta;
    else list.push(meta);
  }

  /** Metadata of sources that charts reference but whose data is not loaded. */
  missingSources(): SourceMeta[] {
    return (this.ws.sourceMeta ?? []).filter((m) => !this.sources.has(m.id));
  }

  sourceByPath(path: string): SourceInfo | undefined {
    for (const s of this.sources.values()) if (s.path === path) return s;
    return undefined;
  }

  addSource(s: SourceInfo) {
    this.sources.set(s.id, s);
    this.upsertMeta(s);
    this.emit('sources', undefined);
    // a re-linked source brings its charts back
    for (const ws of this.ws.worksheets) if (ws.widgets.some((w) => w.series.some((x) => x.sourceId === s.id))) this.emit('range', ws.id);
  }

  removeSource(id: string) {
    this.sources.delete(id);
    this.ws.sourceMeta = (this.ws.sourceMeta ?? []).filter((m) => m.id !== id);
    for (const ws of this.ws.worksheets) {
      let changed = false;
      for (const w of ws.widgets) {
        const before = w.series.length;
        w.series = w.series.filter((s) => s.sourceId !== id);
        if (w.series.length !== before) {
          changed = true;
          this.emit('widget', { ws: ws.id, id: w.id });
        }
      }
      if (changed) this.emit('range', ws.id);
    }
    this.emit('sources', undefined);
  }

  column(sourceId: string, column: string) {
    const s = this.sources.get(sourceId);
    if (!s) return null;
    const c = s.columns.find((c) => c.name === column);
    return c ? { source: s, col: c } : null;
  }

  // ---------- worksheets ----------
  get active(): Worksheet {
    return this.ws.worksheets.find((w) => w.id === this.ws.activeId) ?? this.ws.worksheets[0];
  }

  sheet(id: string): Worksheet | undefined {
    return this.ws.worksheets.find((w) => w.id === id);
  }

  addWorksheet(name?: string, activate = true): Worksheet {
    const n = name ?? this.uniqueSheetName();
    const w = newWorksheet(n);
    this.ws.worksheets.push(w);
    this.emit('worksheets', undefined);
    if (activate) this.setActive(w.id);
    return w;
  }

  private uniqueSheetName() {
    let i = this.ws.worksheets.length + 1;
    const names = new Set(this.ws.worksheets.map((w) => w.name));
    while (names.has(`Worksheet ${i}`)) i++;
    return `Worksheet ${i}`;
  }

  duplicateWorksheet(id: string) {
    const src = this.sheet(id);
    if (!src) return;
    const copy: Worksheet = JSON.parse(JSON.stringify(src));
    copy.id = uid('ws');
    copy.name = `${src.name} (copy)`;
    const ids = new Map<string, string>();
    copy.widgets.forEach((w) => {
      const id = uid('w');
      ids.set(w.id, id);
      w.id = id;
      w.series.forEach((s) => (s.id = uid('s')));
    });
    copy.layout = renameLeaves(this.layoutOf(id), ids);
    const idx = this.ws.worksheets.indexOf(src);
    this.ws.worksheets.splice(idx + 1, 0, copy);
    this.emit('worksheets', undefined);
    this.setActive(copy.id);
  }

  removeWorksheet(id: string) {
    const idx = this.ws.worksheets.findIndex((w) => w.id === id);
    if (idx < 0) return;
    this.ws.worksheets.splice(idx, 1);
    this.history.delete(id);
    if (!this.ws.worksheets.length) this.ws.worksheets.push(newWorksheet('Worksheet 1'));
    this.emit('worksheets', undefined);
    if (this.ws.activeId === id) this.setActive(this.ws.worksheets[Math.max(0, idx - 1)].id);
  }

  renameWorksheet(id: string, name: string) {
    const w = this.sheet(id);
    if (!w || !name.trim()) return;
    w.name = name.trim();
    this.emit('worksheets', undefined);
  }

  moveWorksheet(id: string, toIndex: number) {
    const from = this.ws.worksheets.findIndex((w) => w.id === id);
    if (from < 0) return;
    const [w] = this.ws.worksheets.splice(from, 1);
    this.ws.worksheets.splice(Math.min(toIndex, this.ws.worksheets.length), 0, w);
    this.emit('worksheets', undefined);
  }

  setActive(id: string) {
    if (!this.sheet(id)) return;
    this.ws.activeId = id;
    this.ws.selectedWidgetId = null;
    this.emit('active', id);
    this.emit('selection', null);
  }

  updateWorksheet(id: string, patch: Partial<Worksheet>) {
    const w = this.sheet(id);
    if (!w) return;
    Object.assign(w, patch);
    this.emit('range', id);
  }

  // ---------- widgets ----------
  widget(wsId: string, id: string): WidgetState | undefined {
    return this.sheet(wsId)?.widgets.find((w) => w.id === id);
  }

  findWidget(id: string): { ws: Worksheet; w: WidgetState } | null {
    for (const ws of this.ws.worksheets) {
      const w = ws.widgets.find((x) => x.id === id);
      if (w) return { ws, w };
    }
    return null;
  }

  // ---------- annotations ----------
  /** Annotation mode: the next click / drag on a chart adds a note. */
  annotating = false;
  /** The annotation last opened from the list (its marker is highlighted). */
  focusedAnnotation: string | null = null;

  get annotations(): Annotation[] {
    return (this.ws.annotations ??= []);
  }

  setAnnotating(on: boolean) {
    if (this.annotating === on) return;
    this.annotating = on;
    this.emit('annotating', undefined);
  }

  focusAnnotation(id: string | null) {
    this.focusedAnnotation = id;
    this.emit('annotating', undefined);
  }

  addAnnotation(a: Annotation) {
    this.annotations.push(a);
    this.emit('annotations', undefined);
  }

  updateAnnotation(id: string, patch: Partial<Annotation>) {
    const a = this.annotations.find((x) => x.id === id);
    if (!a) return;
    Object.assign(a, patch, { updatedAt: Date.now() });
    this.emit('annotations', undefined);
  }

  removeAnnotation(id: string) {
    this.ws.annotations = this.annotations.filter((a) => a.id !== id);
    if (this.focusedAnnotation === id) this.focusedAnnotation = null;
    this.emit('annotations', undefined);
  }

  // ---------- tiles ----------
  /** Size of the worksheet area in px (set by the view; guides where new tiles go). */
  viewSize = { w: 1600, h: 900 };

  /** The worksheet's tile tree, kept in step with its widgets. */
  layoutOf(wsId: string): Tile | null {
    const ws = this.sheet(wsId);
    if (!ws) return null;
    if (ws.layout === undefined) ws.layout = fromGrid(ws.widgets);
    const ids = ws.widgets.map((w) => w.id);
    ws.layout = reconcile(ws.layout, ids, this.viewSize);
    return ws.layout;
  }

  private setTiles(wsId: string, t: Tile | null) {
    const ws = this.sheet(wsId);
    if (ws) ws.layout = t;
  }

  /** Move a tile next to another one (`center` = swap places). */
  moveTile(wsId: string, id: string, targetId: string, side: Side | 'center') {
    const t = this.layoutOf(wsId);
    if (!t || id === targetId) return;
    this.setTiles(wsId, side === 'center' ? swap(t, id, targetId) : insertAt(remove(t, id), targetId, id, side));
    this.emit('widgets', wsId);
  }

  /** Move a widget to another worksheet (dropped on its tab). */
  moveWidgetToSheet(fromWs: string, id: string, toWs: string) {
    const from = this.sheet(fromWs);
    const to = this.sheet(toWs);
    const w = from?.widgets.find((x) => x.id === id);
    if (!from || !to || !w || from === to) return;
    const t = this.layoutOf(fromWs);
    from.widgets = from.widgets.filter((x) => x.id !== id);
    from.layout = remove(t, id);
    const before = this.layoutOf(toWs);
    to.widgets.push(w);
    to.layout = insertAuto(before, id, undefined, this.viewSize);
    if (this.ws.selectedWidgetId === id) this.select(null);
    this.emit('widgets', fromWs);
    this.emit('widgets', toWs);
    this.emit('range', toWs);
  }

  /** Splitter drag: new fractions for one split (no re-render needed). */
  setTileSizes(wsId: string, splitId: string, sizes: number[]) {
    const t = this.layoutOf(wsId);
    if (!t) return;
    this.setTiles(wsId, setSizes(t, splitId, sizes));
    this.save();
    this.onChange?.('widgets');
  }

  /** PowerPoint-style distribute: equal widget heights / widths, sheet-wide or in one widget's column / row. */
  distributeTiles(wsId: string, axis: 'h' | 'v' | 'both', around?: string) {
    const t = this.layoutOf(wsId);
    if (!t) return;
    this.setTiles(wsId, around && axis !== 'both' ? distributeAround(t, around, axis) : distribute(t, axis));
    this.emit('widgets', wsId);
  }

  /** The widget next to `id` on a side (for "swap with the one above" etc.). */
  neighborTile(wsId: string, id: string, side: Side): string | null {
    const t = this.layoutOf(wsId);
    return t ? neighbor(t, id, side) : null;
  }

  equalizeTiles(wsId: string) {
    const t = this.layoutOf(wsId);
    if (!t) return;
    this.setTiles(wsId, equalize(t));
    this.emit('widgets', wsId);
  }

  /** Re-tile from the widgets' x/y/w/h (used to lay out a generated dashboard). */
  retile(wsId: string) {
    const ws = this.sheet(wsId);
    if (!ws) return;
    ws.layout = fromGrid(ws.widgets);
    ws.height = null;
    this.emit('widgets', wsId);
  }

  /** Height the worksheet is drawn at (px). */
  sheetPx(wsId: string): number {
    return Math.max(this.viewSize.h, this.sheet(wsId)?.height ?? 0);
  }

  /**
   * Where a new widget goes: split the largest tile while every tile stays
   * comfortably tall; once the sheet is full, add a row below and let the
   * worksheet grow (it scrolls).
   */
  private placeNew(wsId: string, before: Tile | null, id: string): Tile {
    const H = this.sheetPx(wsId);
    const box = { w: this.viewSize.w, h: H };
    const t = insertAuto(before, id, undefined, box);
    const shortest = Math.min(...[...tileRects(t, box).values()].map((r) => r.h));
    if (!before || shortest >= COMFORT_H) return t;
    const grown = H + ROW_H;
    this.sheet(wsId)!.height = grown;
    return appendRow(before, id, ROW_H / grown);
  }

  /** Taller (or back to screen height with null) worksheet, with new fractions for one split. */
  resizeSheet(wsId: string, height: number | null, splitId?: string, sizes?: number[]) {
    const ws = this.sheet(wsId);
    if (!ws) return;
    ws.height = height !== null && height > this.viewSize.h + 4 ? Math.round(height) : null;
    const t = this.layoutOf(wsId);
    if (t && splitId && sizes) this.setTiles(wsId, setSizes(t, splitId, sizes));
    this.emit('widgets', wsId);
  }

  /** Add a widget; `place` puts it beside a tile, otherwise the largest tile is split. */
  addWidget(
    wsId: string,
    partial: Partial<WidgetState> = {},
    items: { sourceId: string; column: string }[] = [],
    place?: { target: string; side: Side },
  ): WidgetState | null {
    const ws = this.sheet(wsId);
    if (!ws) return null;
    const w = defaultWidget(partial);
    const before = this.layoutOf(wsId);
    ws.widgets.push(w);
    ws.layout = place ? insertAt(before, place.target, w.id, place.side) : this.placeNew(wsId, before, w.id);
    this.appendSeries(w, items);
    if (!w.title) w.title = this.autoTitle(w);
    this.emit('widgets', wsId);
    this.select(w.id);
    return w;
  }

  duplicateWidget(wsId: string, id: string) {
    const w = this.widget(wsId, id);
    if (!w) return;
    const copy: WidgetState = JSON.parse(JSON.stringify(w));
    copy.id = uid('w');
    copy.series.forEach((s) => (s.id = uid('s')));
    copy.title = `${w.title} (copy)`;
    const before = this.layoutOf(wsId);
    this.sheet(wsId)!.widgets.push(copy);
    this.setTiles(wsId, insertAuto(before, copy.id, id, this.viewSize));
    this.emit('widgets', wsId);
    this.select(copy.id);
  }

  removeWidget(wsId: string, id: string) {
    const ws = this.sheet(wsId);
    if (!ws) return;
    const t = this.layoutOf(wsId);
    ws.widgets = ws.widgets.filter((w) => w.id !== id);
    ws.layout = remove(t, id);
    if (this.ws.selectedWidgetId === id) this.select(null);
    this.emit('widgets', wsId);
    this.emit('range', wsId);
  }

  updateWidget(wsId: string, id: string, patch: Partial<WidgetState>) {
    const w = this.widget(wsId, id);
    if (!w) return;
    Object.assign(w, patch);
    this.emit('widget', { ws: wsId, id });
  }

  select(id: string | null) {
    if (this.ws.selectedWidgetId === id) return;
    this.ws.selectedWidgetId = id;
    this.emit('selection', id);
  }

  private autoTitle(w: WidgetState): string {
    if (!w.series.length) return 'Untitled chart';
    if (w.series.length === 1) return w.series[0].label;
    return `${w.series[0].label} +${w.series.length - 1}`;
  }

  private appendSeries(w: WidgetState, items: { sourceId: string; column: string }[]): number {
    let added = 0;
    let skipped = 0;
    for (const it of items) {
      if (w.series.length >= MAX_SERIES_PER_CHART) {
        skipped++;
        continue;
      }
      if (w.series.some((s) => s.sourceId === it.sourceId && s.column === it.column)) continue;
      if (!this.column(it.sourceId, it.column)) continue;
      const multiSource = new Set([...w.series.map((s) => s.sourceId), it.sourceId]).size > 1;
      const srcName = this.sources.get(it.sourceId)?.name.replace(/\.(csv|tsv|txt)$/i, '') ?? '';
      w.series.push({
        id: uid('s'),
        sourceId: it.sourceId,
        column: it.column,
        label: multiSource ? `${srcName} · ${it.column}` : it.column,
        color: slotColor(nextSlot(w.series.map((s) => s.color))),
        visible: true,
        scale: 1,
        offset: 0,
      });
      added++;
    }
    if (skipped) this.onSeriesLimit?.(added, skipped);
    return added;
  }

  addSeries(wsId: string, widgetId: string, items: { sourceId: string; column: string }[]) {
    const w = this.widget(wsId, widgetId);
    if (!w) return;
    const wasEmpty = !w.series.length;
    if (!this.appendSeries(w, items)) return;
    if (wasEmpty && (!w.title || w.title === 'Untitled chart')) w.title = this.autoTitle(w);
    this.emit('widget', { ws: wsId, id: widgetId });
    this.emit('range', wsId);
  }

  updateSeries(wsId: string, widgetId: string, seriesId: string, patch: Partial<SeriesRef>) {
    const s = this.widget(wsId, widgetId)?.series.find((x) => x.id === seriesId);
    if (!s) return;
    Object.assign(s, patch);
    this.emit('widget', { ws: wsId, id: widgetId });
  }

  /** Show only one series; if it already is the only one shown, show them all again. */
  soloSeries(wsId: string, widgetId: string, seriesId: string) {
    const w = this.widget(wsId, widgetId);
    if (!w) return;
    const alone = w.series.every((s) => s.visible === (s.id === seriesId));
    for (const s of w.series) s.visible = alone || s.id === seriesId;
    this.emit('widget', { ws: wsId, id: widgetId });
  }

  removeSeries(wsId: string, widgetId: string, seriesIds: string[]) {
    const w = this.widget(wsId, widgetId);
    if (!w) return;
    w.series = w.series.filter((s) => !seriesIds.includes(s.id));
    this.emit('widget', { ws: wsId, id: widgetId });
    this.emit('range', wsId);
  }

  moveSeries(from: { worksheetId: string; widgetId: string; seriesIds: string[] }, toWs: string, toWidget: string, copy = false) {
    if (from.widgetId === toWidget) return;
    const src = this.widget(from.worksheetId, from.widgetId);
    const dst = this.widget(toWs, toWidget);
    if (!src || !dst) return;
    const moving = src.series.filter((s) => from.seriesIds.includes(s.id));
    this.appendSeries(
      dst,
      moving.map((s) => ({ sourceId: s.sourceId, column: s.column })),
    );
    // carry over label/transform for moved series
    for (const m of moving) {
      const d = dst.series.find((s) => s.sourceId === m.sourceId && s.column === m.column);
      if (d) Object.assign(d, { label: m.label, scale: m.scale, offset: m.offset, visible: m.visible });
    }
    if (!copy) this.removeSeries(from.worksheetId, from.widgetId, from.seriesIds);
    this.emit('widget', { ws: toWs, id: toWidget });
    this.emit('range', toWs);
  }

  setChartType(wsId: string, id: string, type: ChartType) {
    this.updateWidget(wsId, id, { type });
  }

  // ---------- time ranges ----------
  /** Full extent covered by a set of series. */
  extentOf(series: SeriesRef[]): TimeRange | null {
    let start = Infinity;
    let end = -Infinity;
    const seen = new Set<string>();
    for (const s of series) {
      if (seen.has(s.sourceId)) continue;
      seen.add(s.sourceId);
      const src = this.sources.get(s.sourceId);
      if (!src || !src.rows) continue;
      start = Math.min(start, src.start);
      end = Math.max(end, src.end);
    }
    if (!Number.isFinite(start)) return null;
    if (start === end) return { start: start - 1000, end: end + 1000 };
    return { start, end };
  }

  sheetExtent(wsId: string): TimeRange | null {
    const ws = this.sheet(wsId);
    if (!ws) return null;
    return this.extentOf(ws.widgets.filter((w) => w.linked).flatMap((w) => w.series));
  }

  sheetRange(wsId: string): TimeRange | null {
    const ws = this.sheet(wsId);
    return ws?.range ?? this.sheetExtent(wsId);
  }

  widgetRange(wsId: string, w: WidgetState): TimeRange | null {
    if (w.linked) return this.sheetRange(wsId);
    return w.range ?? this.extentOf(w.series);
  }

  private hist(wsId: string): History {
    let h = this.history.get(wsId);
    if (!h) {
      h = { back: [], fwd: [], lastPush: 0 };
      this.history.set(wsId, h);
    }
    return h;
  }

  /** Set the shared timeline. Rapid successive changes (wheel/pan) coalesce into one history step. */
  setRange(wsId: string, range: TimeRange | null, recordHistory = true) {
    const ws = this.sheet(wsId);
    if (!ws) return;
    if (recordHistory) {
      const h = this.hist(wsId);
      const now = performance.now();
      if (now - h.lastPush > 600) h.back.push(ws.range);
      if (h.back.length > 100) h.back.shift();
      h.fwd = [];
      h.lastPush = now;
    }
    ws.range = range;
    this.emit('range', wsId);
  }

  setWidgetRange(wsId: string, id: string, range: TimeRange | null) {
    const w = this.widget(wsId, id);
    if (!w) return;
    w.range = range;
    this.emit('widget', { ws: wsId, id });
  }

  canBack(wsId: string) {
    return this.hist(wsId).back.length > 0;
  }
  canForward(wsId: string) {
    return this.hist(wsId).fwd.length > 0;
  }
  back(wsId: string) {
    const h = this.hist(wsId);
    const ws = this.sheet(wsId);
    if (!ws || !h.back.length) return;
    h.fwd.push(ws.range);
    ws.range = h.back.pop()!;
    h.lastPush = 0;
    this.emit('range', wsId);
  }
  forward(wsId: string) {
    const h = this.hist(wsId);
    const ws = this.sheet(wsId);
    if (!ws || !h.fwd.length) return;
    h.back.push(ws.range);
    ws.range = h.fwd.pop()!;
    h.lastPush = 0;
    this.emit('range', wsId);
  }

  // ---------- settings ----------
  updateSettings(patch: Partial<Settings>) {
    Object.assign(this.ws.settings, patch);
    this.emit('settings', undefined);
  }

  cursor(ws: string, x: number | null, from: string | null) {
    this.emit('cursor', { ws, x, from });
  }
}

export let store: Store;
export function initStore() {
  store = new Store();
  return store;
}
