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
} from './types';
import { debounce, uid } from './util';
import { nextSlot, slotColor } from './palette';

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
};

type Handler<T> = (payload: T) => void;

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
    if (ev !== 'cursor' && ev !== 'selection' && ev !== 'project') {
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
    copy.widgets.forEach((w) => {
      w.id = uid('w');
      w.series.forEach((s) => (s.id = uid('s')));
    });
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

  addWidget(wsId: string, partial: Partial<WidgetState> = {}, items: { sourceId: string; column: string }[] = []): WidgetState | null {
    const ws = this.sheet(wsId);
    if (!ws) return null;
    const w = defaultWidget(partial);
    if (partial.y === undefined) w.y = ws.widgets.reduce((m, x) => Math.max(m, x.y + x.h), 0);
    ws.widgets.push(w);
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
    copy.y = w.y + w.h;
    this.sheet(wsId)!.widgets.push(copy);
    this.emit('widgets', wsId);
    this.select(copy.id);
  }

  removeWidget(wsId: string, id: string) {
    const ws = this.sheet(wsId);
    if (!ws) return;
    ws.widgets = ws.widgets.filter((w) => w.id !== id);
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

  /** Layout-only update from the grid (no re-render). */
  setLayout(wsId: string, id: string, l: { x: number; y: number; w: number; h: number }) {
    const w = this.widget(wsId, id);
    if (!w) return;
    if (w.x === l.x && w.y === l.y && w.w === l.w && w.h === l.h) return;
    Object.assign(w, l);
    this.save();
    this.onChange?.('widgets');
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
