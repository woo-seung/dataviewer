import uPlot from 'uplot';
import {
  Activity,
  Camera,
  ChartArea,
  ChartLine,
  ChartScatter,
  Copy,
  Download,
  Ellipsis,
  Eye,
  EyeOff,
  FolderOpen,
  Layers,
  Link,
  Maximize2,
  Minimize2,
  Pencil,
  Settings2,
  Table2,
  Trash2,
  Unlink,
  ZoomOut,
  type IconNode,
} from 'lucide';
import { store } from '../store';
import type { ChartType, SeriesRef, TimeRange, WidgetState } from '../types';
import { dropTarget, draggable, isSeries, seriesPayload } from './dnd';
import { engine, type SeriesKey } from '../engine';
import { saveFile } from '../dialogs';
import { formatTime } from '../data/time';
import { resolveColor, withAlpha } from '../palette';
import { cssVar, formatCount, formatValue, h, icon, iconButton, rafThrottle } from '../util';
import { notice, showMenu, type MenuItem } from './overlays';
import { project } from '../project';

export const CHART_TYPES: { type: ChartType; label: string; icon: IconNode }[] = [
  { type: 'line', label: '라인', icon: ChartLine },
  { type: 'area', label: '영역', icon: ChartArea },
  { type: 'stacked', label: '누적 영역', icon: Layers },
  { type: 'step', label: '스텝', icon: Activity },
  { type: 'scatter', label: '산점도', icon: ChartScatter },
];

type Cell = number | null | undefined;
type Window = { x: Float64Array; y: Float64Array; raw: number };
const EMPTY: Window = { x: new Float64Array(0), y: new Float64Array(0), raw: 0 };
const seriesKey = (s: SeriesRef): SeriesKey => ({ source: s.sourceId, column: s.column });

// 24h, ISO-ish tick labels; second line shows the next-larger unit when it changes (ms timestamps).
const S = 1000;
const M = 60 * S;
const HR = 60 * M;
const D = 24 * HR;
const TIME_TICKS: uPlot.Axis.TimeValuesConfig = [
  [365 * D, '{YYYY}', null, null, null, null, null, null, 1],
  [28 * D, '{YYYY}-{MM}', null, null, null, null, null, null, 1],
  [D, '{MM}-{DD}', '\n{YYYY}', null, null, null, null, null, 1],
  [HR, '{HH}:{mm}', '\n{YYYY}-{MM}-{DD}', null, '\n{MM}-{DD}', null, null, null, 1],
  [M, '{HH}:{mm}', '\n{YYYY}-{MM}-{DD}', null, '\n{MM}-{DD}', null, null, null, 1],
  [S, '{HH}:{mm}:{ss}', '\n{YYYY}-{MM}-{DD} {HH}:{mm}', null, '\n{MM}-{DD} {HH}:{mm}', null, '\n{HH}:{mm}', null, 1],
  [1, '{HH}:{mm}:{ss}.{fff}', '\n{YYYY}-{MM}-{DD} {HH}:{mm}', null, '\n{MM}-{DD} {HH}:{mm}', null, '\n{HH}:{mm}', null, 1],
];

/**
 * Put several (x, y) series with different timestamps on one shared x array, as
 * uPlot requires. Missing positions are `undefined` (line joins across them);
 * NaN samples become `null` (a real gap).
 */
function align(wins: Window[]): { x: Float64Array; ys: Cell[][] } {
  let total = 0;
  for (const w of wins) total += w.x.length;
  let x: Float64Array;
  if (wins.length === 1) x = Float64Array.from(wins[0].x);
  else {
    const all = new Float64Array(total);
    let o = 0;
    for (const w of wins) {
      all.set(w.x, o);
      o += w.x.length;
    }
    all.sort();
    let u = 0;
    for (let i = 0; i < all.length; i++) if (i === 0 || all[i] !== all[i - 1]) all[u++] = all[i];
    x = all.subarray(0, u);
  }
  const ys = wins.map((w) => {
    const y: Cell[] = new Array(x.length);
    let j = 0;
    for (let i = 0; i < w.x.length; i++) {
      const t = w.x[i];
      while (x[j] < t) j++;
      const v = w.y[i];
      y[j] = v === v ? v : null;
    }
    return y;
  });
  return { x, ys };
}

/** Linear interpolation of a sparse aligned series at every x (for stacking). */
function fillLinear(x: Float64Array, y: Cell[]): (number | null)[] {
  const out: (number | null)[] = new Array(x.length).fill(null);
  let prev = -1;
  for (let i = 0; i < x.length; i++) {
    const v = y[i];
    if (v === undefined) continue;
    if (v === null) {
      prev = -1;
      continue;
    }
    out[i] = v;
    if (prev >= 0 && i - prev > 1) {
      const pv = y[prev] as number;
      for (let k = prev + 1; k < i; k++) out[k] = pv + ((v - pv) * (x[k] - x[prev])) / (x[i] - x[prev]);
    }
    prev = i;
  }
  return out;
}

export class ChartWidget {
  readonly el: HTMLElement;
  readonly content: HTMLElement;
  private u: uPlot | null = null;
  private structKey = '';
  private curRange: TimeRange = { start: 0, end: 1 };
  private plotWrap: HTMLElement;
  private plotHost: HTMLElement;
  private legend: HTMLElement;
  private titleEl: HTMLElement;
  private typeBtn: HTMLButtonElement;
  private linkBtn: HTMLButtonElement;
  private maxBtn: HTMLButtonElement;
  private badge: HTMLElement;
  private empty: HTMLElement;
  private missing: HTMLElement;
  private vline: HTMLElement;
  private hline: HTMLElement;
  private xLabel: HTMLElement;
  private yLabel: HTMLElement;
  private mouseY: number | null = null;
  private lastCursor: number | null = null;
  private valueCells: HTMLElement[] = [];
  private unsub: (() => void)[] = [];
  private ro: ResizeObserver;
  private maxParent: { parent: HTMLElement; next: Node | null } | null = null;
  private renderedRange: TimeRange | null = null;
  private pan: { x: number; range: TimeRange } | null = null;
  /** Called with raw/displayed point counts after each render (for the status bar). */
  static onRendered?: (wsId: string, id: string, raw: number, shown: number, ms: number) => void;

  constructor(
    readonly wsId: string,
    readonly id: string,
  ) {
    const st = this.state;
    this.titleEl = h('div', { class: 'widget-title', title: '더블클릭하여 이름 변경' }, st.title);
    this.titleEl.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      this.editTitle();
    });
    this.typeBtn = iconButton(ChartLine, '차트 유형', () => this.typeMenu(), 'clickable-icon widget-type');
    this.linkBtn = iconButton(Link, '타임라인 연동', () => this.toggleLink());
    this.maxBtn = iconButton(Maximize2, '최대화', () => this.toggleMaximize());
    this.badge = h('span', { class: 'widget-badge' });
    const header = h(
      'div',
      { class: 'widget-header' },
      this.typeBtn,
      this.titleEl,
      this.badge,
      h('div', { class: 'widget-header-spacer' }),
      h(
        'div',
        { class: 'widget-actions' },
        iconButton(ZoomOut, '줌 초기화 (더블클릭)', () => this.resetZoom()),
        this.linkBtn,
        iconButton(Table2, '범례 테이블', () => store.updateWidget(this.wsId, this.id, { showLegend: !this.state.showLegend })),
        iconButton(Camera, '스냅샷 PNG', () => void this.snapshot()),
        this.maxBtn,
        iconButton(Ellipsis, '더 보기', (e) => this.moreMenu(e)),
      ),
    );

    this.plotHost = h('div', { class: 'widget-canvas' });
    this.vline = h('div', { class: 'crosshair-v' });
    this.hline = h('div', { class: 'crosshair-h' });
    this.xLabel = h('div', { class: 'crosshair-label is-x' });
    this.yLabel = h('div', { class: 'crosshair-label is-y' });
    this.empty = h('div', { class: 'widget-empty' }, icon(ChartLine, 28), h('div', {}, '사이드바에서 시리즈를 여기로 드래그하세요'));
    this.missing = h('div', { class: 'widget-missing' });
    this.plotWrap = h('div', { class: 'widget-plot' }, this.plotHost, this.vline, this.hline, this.xLabel, this.yLabel, this.empty, this.missing);
    this.legend = h('div', { class: 'widget-legend' });
    this.content = h('div', { class: 'grid-stack-item-content widget' }, header, h('div', { class: 'widget-body' }, this.plotWrap, this.legend));
    this.el = h('div', { class: 'grid-stack-item', 'gs-id': this.id, 'gs-x': st.x, 'gs-y': st.y, 'gs-w': st.w, 'gs-h': st.h }, this.content);

    this.content.addEventListener('pointerdown', () => store.select(this.id));
    this.content.addEventListener('contextmenu', (e) => {
      if ((e.target as HTMLElement).closest('.widget-legend tr')) return;
      e.preventDefault();
      this.moreMenu(e);
    });
    this.bindDrop();
    this.bindPointer();

    this.ro = new ResizeObserver(rafThrottle(() => this.plotWrap.isConnected && this.render()));
    this.ro.observe(this.plotWrap);

    this.unsub.push(
      store.on('widget', (p) => p.ws === this.wsId && p.id === this.id && this.render()),
      store.on('range', (ws) => ws === this.wsId && this.render()),
      store.on('sources', () => this.render()),
      store.on('settings', () => this.render()),
      store.on('selection', (sel) => this.content.classList.toggle('is-selected', sel === this.id)),
      store.on('cursor', (c) => this.onCursor(c)),
    );
    this.content.classList.toggle('is-selected', store.ws.selectedWidgetId === this.id);
    this.render();
  }

  get state(): WidgetState {
    return store.widget(this.wsId, this.id)!;
  }

  destroy() {
    this.unsub.forEach((f) => f());
    this.ro.disconnect();
    this.u?.destroy();
    this.u = null;
    this.el.remove();
  }

  // ---------------- rendering ----------------
  render = rafThrottle(() => this.doRender());

  private loadedSeries(st: WidgetState) {
    return st.series.filter((s) => store.column(s.sourceId, s.column));
  }

  private renderSeq = 0;
  private legendSeq = 0;
  private cursorSeq = 0;

  private async doRender() {
    const st = this.state;
    if (!st) return;
    const t0 = performance.now();
    this.titleEl.textContent = st.title;
    this.typeBtn.replaceChildren(icon(CHART_TYPES.find((c) => c.type === st.type)?.icon ?? ChartLine, 16));
    this.linkBtn.replaceChildren(icon(st.linked ? Link : Unlink, 16));
    this.linkBtn.classList.toggle('is-active', st.linked);
    this.linkBtn.title = st.linked ? '타임라인 연동됨 (클릭하여 해제)' : '독립 타임라인 (클릭하여 연동)';
    this.badge.textContent = st.linked ? '' : '독립';
    this.legend.hidden = !st.showLegend;

    const series = this.loadedSeries(st);
    this.renderMissing(st);
    this.empty.hidden = st.series.length > 0;
    const range = store.widgetRange(this.wsId, st);
    const width = this.plotWrap.clientWidth;
    const height = this.plotWrap.clientHeight;
    if (!series.length || !range || width < 10 || height < 10) {
      if (!series.length || !range) {
        this.u?.destroy();
        this.u = null;
        this.structKey = '';
        this.renderLegend([], null);
      }
      return;
    }
    this.curRange = range;
    const seq = ++this.renderSeq;

    const theme = store.ws.settings.theme;
    const stacked = st.type === 'stacked';
    // ~4 points per pixel column keeps M4 visually lossless
    const target = st.maxPoints ? Math.max(st.maxPoints, Math.round(width * 4)) : 0;
    let res: (Window | null)[];
    try {
      res = await engine.window(series.map(seriesKey), range.start, range.end, target);
    } catch (e) {
      console.warn('window failed', e);
      return;
    }
    if (seq !== this.renderSeq || !this.state) return; // a newer render superseded this one
    let raw = 0;
    const wins = series.map((s, i) => {
      const w = res[i] ?? EMPTY;
      raw += w.raw;
      if (s.scale === 1 && s.offset === 0) return w;
      const y = new Float64Array(w.y.length);
      for (let k = 0; k < y.length; k++) y[k] = w.y[k] * s.scale + s.offset;
      return { x: w.x, y, raw: w.raw };
    });
    const { x, ys } = align(wins);
    let data: Cell[][] = ys;
    if (stacked) {
      const acc = new Float64Array(x.length);
      data = ys.map((y, i) => {
        if (!series[i].visible) return y;
        const f = fillLinear(x, y);
        return f.map((v, k) => (v === null ? null : (acc[k] += v)));
      });
    }

    const key = JSON.stringify([
      st.type,
      series.map((s) => [s.id, s.color, s.visible, s.label]),
      theme,
      st.yAxis,
      st.lineWidth,
      st.markers,
      store.ws.settings.dragMode,
      store.ws.settings.zoomY,
    ]);
    const aligned = [x as unknown as number[], ...(data as number[][])] as uPlot.AlignedData;
    if (!this.u || key !== this.structKey) {
      this.u?.destroy();
      this.u = new uPlot(this.options(st, series, width, height), aligned, this.plotHost);
      this.structKey = key;
    } else {
      if (this.u.width !== width || this.u.height !== height) this.u.setSize({ width, height });
      this.u.setData(aligned);
    }
    this.renderedRange = range;
    this.drawCursor(this.lastCursor, false);
    ChartWidget.onRendered?.(this.wsId, this.id, raw, x.length * series.length, performance.now() - t0);
    const ms = performance.now() - t0;
    if (ms > 2000) void engine.log(`slow chart render: ${series.length} series, ${x.length} points, ${raw} raw rows, ${Math.round(ms)} ms`);
    this.renderLegend(series, range);
  }

  private options(st: WidgetState, series: SeriesRef[], width: number, height: number): uPlot.Options {
    const theme = store.ws.settings.theme;
    const text = cssVar('--text-muted');
    const grid = cssVar('--chart-grid');
    const font = `11px ${cssVar('--font-interface')}`;
    const y = st.yAxis;
    const zoomMode = store.ws.settings.dragMode === 'zoom';
    const stacked = st.type === 'stacked';
    const stepped = uPlot.paths.stepped!({ align: 1 });
    const fmtY = (v: number) => formatValue(v, y.siPrefix, y.unit);

    const sOpts: uPlot.Series[] = series.map((s, i) => {
      const color = resolveColor(s.color, theme);
      const base: uPlot.Series = {
        label: s.label,
        show: s.visible,
        stroke: color,
        width: st.lineWidth,
        spanGaps: false,
        points: { show: st.markers, size: 5, stroke: color, fill: color },
      };
      switch (st.type) {
        case 'scatter':
          return { ...base, paths: () => null, points: { show: true, size: 4, width: 0, stroke: color, fill: withAlpha(color, 0.85), space: 0 } };
        case 'area':
          return { ...base, fill: withAlpha(color, 0.16), fillTo: (u: uPlot) => (y.log ? (u.scales.y.min ?? 0) : 0) };
        case 'step':
          return { ...base, paths: stepped };
        case 'stacked': {
          // first visible layer fills to zero, the rest fill via bands
          const firstVisible = series.findIndex((x) => x.visible) === i;
          return { ...base, width: Math.min(st.lineWidth, 1.5), fill: firstVisible ? withAlpha(color, 0.55) : undefined };
        }
        default:
          return base;
      }
    });

    const bands: uPlot.Band[] = [];
    if (stacked) {
      let below = -1;
      series.forEach((s, i) => {
        if (!s.visible) return;
        if (below >= 0) bands.push({ series: [i + 1, below + 1], fill: withAlpha(resolveColor(s.color, theme), 0.55) });
        below = i;
      });
    }

    const yRange: uPlot.Scale.Range = (_u, min, max) => {
      if (!y.auto && y.min !== null && y.max !== null && y.max > y.min) return [y.min, y.max];
      if (min === null || max === null || !Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
      if (y.log) return uPlot.rangeLog(Math.max(min, 1e-12), Math.max(max, 1e-12), 10, true);
      let lo = min;
      let hi = max;
      if (y.includeZero) {
        lo = Math.min(lo, 0);
        hi = Math.max(hi, 0);
      }
      if (lo === hi) {
        const d = Math.abs(lo) * 0.1 || 1;
        lo -= d;
        hi += d;
      }
      const pad = (hi - lo) * 0.06;
      return [y.includeZero && lo === 0 ? 0 : lo - pad, y.includeZero && hi === 0 ? 0 : hi + pad];
    };

    return {
      width,
      height,
      ms: 1,
      tzDate: (ts) => uPlot.tzDate(new Date(ts), 'Etc/UTC'),
      padding: [10, 14, 0, 4],
      legend: { show: false },
      focus: { alpha: 0.25 },
      scales: {
        x: { time: true, auto: false, range: () => [this.curRange.start, this.curRange.end] },
        y: { distr: y.log ? 3 : 1, auto: true, range: yRange },
      },
      axes: [
        { stroke: text, font, grid: { stroke: grid, width: 1 }, ticks: { stroke: grid, width: 1, size: 4 }, space: 80, values: TIME_TICKS },
        {
          stroke: text,
          font,
          grid: { stroke: grid, width: 1 },
          ticks: { show: false },
          space: 28,
          values: (_u, splits) => splits.map(fmtY),
          size: (u, values, axisIdx) => {
            if (!values?.length) return 40;
            u.ctx.font = u.axes[axisIdx].font![0] as unknown as string;
            const w = Math.max(...values.map((v) => u.ctx.measureText(v).width));
            return Math.ceil(w / devicePixelRatio) + 14;
          },
        },
      ],
      series: [{}, ...sOpts],
      bands,
      cursor: {
        x: false,
        y: false,
        points: { show: false },
        focus: { prox: -1 },
        drag: { x: zoomMode, y: zoomMode && store.ws.settings.zoomY, uni: store.ws.settings.zoomY ? 20 : Infinity, setScale: false },
        bind: {
          dblclick: () => () => {
            this.resetZoom();
            return null;
          },
          mousedown: (_u, _t, handler) => (e: MouseEvent) => {
            if (!zoomMode || e.button === 1 || e.shiftKey) {
              this.startPan(e);
              return null;
            }
            return handler(e);
          },
        },
      },
      hooks: {
        setSelect: [
          (u) => {
            const sel = u.select;
            if (sel.width > 4) {
              const a = u.posToVal(sel.left, 'x');
              const b = u.posToVal(sel.left + sel.width, 'x');
              if (b > a) this.setRange({ start: a, end: b });
            }
            if (store.ws.settings.zoomY && sel.height > 4 && sel.height < u.over.clientHeight - 1) {
              const top = u.posToVal(sel.top, 'y');
              const bot = u.posToVal(sel.top + sel.height, 'y');
              const st2 = this.state;
              store.updateWidget(this.wsId, this.id, { yAxis: { ...st2.yAxis, auto: false, min: Math.min(top, bot), max: Math.max(top, bot) } });
            }
            u.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false);
          },
        ],
      },
    };
  }

  private renderMissing(st: WidgetState) {
    const gone = st.series.filter((s) => !store.column(s.sourceId, s.column));
    this.missing.hidden = !gone.length;
    if (!gone.length) return;
    const names = [...new Set(gone.map((s) => store.ws.sourceMeta?.find((m) => m.id === s.sourceId)?.name ?? '(삭제된 소스)'))];
    this.missing.replaceChildren(
      h('span', {}, `데이터 없음: ${names.join(', ')}`),
      h('button', { type: 'button', onclick: (() => void project.restoreMissing()) as EventListener }, icon(FolderOpen, 14), ' 다시 불러오기'),
    );
  }

  // ---------------- interaction ----------------
  private bindPointer() {
    const move = rafThrottle((cx: number, cy: number) => {
      const u = this.u;
      if (!u) return;
      const r = u.over.getBoundingClientRect();
      const px = cx - r.left;
      const py = cy - r.top;
      if (px < 0 || px > r.width || py < 0 || py > r.height) {
        this.mouseY = null;
        store.cursor(this.wsId, null, this.id);
        return;
      }
      this.mouseY = py;
      store.cursor(this.wsId, u.posToVal(px, 'x'), this.id);
    });
    this.plotHost.addEventListener('mousemove', (e) => move(e.clientX, e.clientY));
    this.plotHost.addEventListener('mouseleave', () => {
      this.mouseY = null;
      setTimeout(() => store.cursor(this.wsId, null, this.id), 0);
    });
    this.plotHost.addEventListener(
      'wheel',
      (e) => {
        const u = this.u;
        if (!u || !(e.target as HTMLElement).closest('.u-over')) return;
        e.preventDefault();
        const r = u.over.getBoundingClientRect();
        const c = u.posToVal(e.clientX - r.left, 'x');
        const f = Math.pow(1.0015, Math.max(-300, Math.min(300, e.deltaY * (e.deltaMode === 1 ? 33 : 1))));
        const { start, end } = this.curRange;
        if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
          const d = (end - start) * (e.deltaX || e.deltaY) * 0.0015;
          this.setRange({ start: start + d, end: end + d });
          return;
        }
        this.setRange({ start: c - (c - start) * f, end: c + (end - c) * f });
      },
      { passive: false },
    );
  }

  private startPan(e: MouseEvent) {
    e.preventDefault();
    this.pan = { x: e.clientX, range: { ...this.curRange } };
    this.plotHost.classList.add('is-panning');
    const move = rafThrottle((cx: number) => {
      const u = this.u;
      if (!u || !this.pan) return;
      const span = this.pan.range.end - this.pan.range.start;
      const dt = ((cx - this.pan.x) / u.over.clientWidth) * span;
      this.setRange({ start: this.pan.range.start - dt, end: this.pan.range.end - dt });
    });
    const onMove = (ev: MouseEvent) => move(ev.clientX);
    const onUp = () => {
      this.pan = null;
      this.plotHost.classList.remove('is-panning');
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  private setRange(r: TimeRange | null) {
    const st = this.state;
    if (st.linked) store.setRange(this.wsId, r);
    else store.setWidgetRange(this.wsId, this.id, r);
  }

  resetZoom() {
    const st = this.state;
    st.yAxis = { ...st.yAxis, auto: true };
    if (st.linked) store.setRange(this.wsId, null);
    else store.setWidgetRange(this.wsId, this.id, null);
  }

  // ---------------- legend table ----------------
  private renderLegend(series: SeriesRef[], range: TimeRange | null) {
    this.valueCells = [];
    if (!series.length || !range) {
      this.legend.replaceChildren();
      return;
    }
    const st = this.state;
    const theme = store.ws.settings.theme;
    const si = st.yAxis.siPrefix;
    const unit = st.yAxis.unit;
    const tbody = h('tbody');
    const statCells: HTMLElement[][] = [];
    series.forEach((s, i) => {
      const source = store.sources.get(s.sourceId)!;
      const color = resolveColor(s.color, theme);
      const swatch = h('button', {
        class: `legend-swatch ${s.visible ? '' : 'is-off'}`,
        style: `--swatch:${color}`,
        title: s.visible ? '숨기기' : '보이기',
        'aria-label': s.visible ? `${s.label} 숨기기` : `${s.label} 보이기`,
        type: 'button',
      });
      swatch.addEventListener('click', (e) => {
        e.stopPropagation();
        store.updateSeries(this.wsId, this.id, s.id, { visible: !s.visible });
      });
      const val = h('td', { class: 'num cursor-val' }, '—');
      this.valueCells.push(val);
      const row = h(
        'tr',
        { class: s.visible ? '' : 'is-hidden', title: `${source.name} › ${s.column}` },
        h('td', { class: 'legend-name' }, swatch, h('span', {}, s.label)),
        val,
        ...this.statRow(statCells),
      );
      draggable(
        row,
        () => seriesPayload({ items: [{ sourceId: s.sourceId, column: s.column }], fromWidget: { worksheetId: this.wsId, widgetId: this.id, seriesIds: [s.id] } }),
        () => `${s.label} — 다른 차트로 이동 (Ctrl: 복사)`,
      );
      row.addEventListener('mouseenter', () => s.visible && this.u?.setSeries(i + 1, { focus: true }));
      row.addEventListener('mouseleave', () => this.u?.setSeries(null, { focus: false }));
      row.addEventListener('dblclick', () => store.select(this.id));
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.seriesMenu(s, e);
      });
      tbody.append(row);
    });
    const head = h(
      'thead',
      {},
      h('tr', {}, h('th', {}, `시리즈 (${series.length})`), h('th', { class: 'num' }, '커서'), h('th', { class: 'num' }, '최소'), h('th', { class: 'num' }, '최대'), h('th', { class: 'num' }, '평균')),
    );
    this.legend.replaceChildren(h('table', { class: 'legend-table' }, head, tbody));
    this.updateCursorValues(this.lastCursor);
    const seq = ++this.legendSeq;
    void engine
      .stats(series.map(seriesKey), range.start, range.end)
      .then((stats) => {
        if (seq !== this.legendSeq) return;
        stats.forEach((st0, i) => {
          const s = series[i];
          const t = (v: number | null | undefined) => (v == null ? NaN : v * s.scale + s.offset);
          const [a, b] = [t(st0?.min), t(st0?.max)];
          const cells = statCells[i];
          cells[0].textContent = formatValue(Math.min(a, b), si, unit);
          cells[1].textContent = formatValue(Math.max(a, b), si, unit);
          cells[2].textContent = formatValue(t(st0?.mean), si, unit);
          cells[0].parentElement!.title = `${store.sources.get(s.sourceId)?.name ?? ""} › ${s.column}\n구간 샘플 ${formatCount(st0?.count ?? 0)}개`;
        });
      })
      .catch((e) => console.warn('stats failed', e));
  }

  private statRow(all: HTMLElement[][]): HTMLElement[] {
    const cells = [0, 1, 2].map(() => h('td', { class: 'num' }, '…'));
    all.push(cells);
    return cells;
  }

  // ---------------- crosshair ----------------
  private onCursor(c: { ws: string; x: number | null; from: string | null }) {
    if (c.ws !== this.wsId) return;
    const st = this.state;
    if (!st) return;
    const fromState = c.from ? store.widget(this.wsId, c.from) : null;
    const shared = st.linked && (fromState?.linked ?? true);
    if (c.from !== this.id && !shared) {
      if (this.lastCursor !== null) this.drawCursor(null, false);
      return;
    }
    this.drawCursor(c.x, c.from === this.id);
  }

  private drawCursor(x: number | null, own: boolean) {
    this.lastCursor = x;
    const u = this.u;
    const showLines = store.sheet(this.wsId)?.crosshair !== false;
    const hide = () => {
      this.vline.style.display = 'none';
      this.hline.style.display = 'none';
      this.xLabel.style.display = 'none';
      this.yLabel.style.display = 'none';
    };
    if (x === null || !u) {
      hide();
      this.updateCursorValues(null);
      return;
    }
    const W = u.over.clientWidth;
    const H = u.over.clientHeight;
    const px = u.valToPos(x, 'x');
    if (px < 0 || px > W) {
      hide();
      this.updateCursorValues(null);
      return;
    }
    this.updateCursorValues(x);
    if (!showLines) return hide();
    // overlay lives in plotWrap; translate from the plotting area's origin
    const wr = this.plotWrap.getBoundingClientRect();
    const or = u.over.getBoundingClientRect();
    const ox = or.left - wr.left;
    const oy = or.top - wr.top;
    const left = ox + px;
    Object.assign(this.vline.style, { display: 'block', left: `${left}px`, top: `${oy}px`, height: `${H}px` });
    this.xLabel.textContent = formatTime(x);
    const lw = this.xLabel.offsetWidth || 120;
    Object.assign(this.xLabel.style, {
      display: 'block',
      left: `${Math.min(Math.max(left - lw / 2, ox), ox + W - lw)}px`,
      top: `${oy + H + 2}px`,
    });
    if (own && this.mouseY !== null) {
      const top = oy + this.mouseY;
      Object.assign(this.hline.style, { display: 'block', top: `${top}px`, left: `${ox}px`, width: `${W}px` });
      this.yLabel.textContent = formatValue(u.posToVal(this.mouseY, 'y'), this.state.yAxis.siPrefix, this.state.yAxis.unit);
      Object.assign(this.yLabel.style, { display: 'block', top: `${top - 9}px`, left: `${ox + 2}px` });
    } else {
      this.hline.style.display = 'none';
      this.yLabel.style.display = 'none';
    }
  }

  private updateCursorValues(x: number | null) {
    const st = this.state;
    if (!st) return;
    const series = this.loadedSeries(st);
    const seq = ++this.cursorSeq;
    if (x === null || !series.length) {
      this.valueCells.forEach((c) => (c.textContent = '—'));
      return;
    }
    void engine
      .values(series.map(seriesKey), x)
      .then((vals) => {
        if (seq !== this.cursorSeq) return;
        series.forEach((s, i) => {
          const cell = this.valueCells[i];
          const v = vals[i];
          if (cell) cell.textContent = formatValue(v == null ? NaN : v * s.scale + s.offset, st.yAxis.siPrefix, st.yAxis.unit);
        });
      })
      .catch(() => undefined);
  }

  // ---------------- drop target ----------------
  private bindDrop() {
    dropTarget(this.content, {
      accepts: (p) => isSeries(p) && p.data.fromWidget?.widgetId !== this.id,
      drop: (p, e) => {
        if (!isSeries(p)) return;
        if (p.data.fromWidget) store.moveSeries(p.data.fromWidget, this.wsId, this.id, e.altKey || e.ctrlKey);
        else store.addSeries(this.wsId, this.id, p.data.items);
        store.select(this.id);
      },
    });
  }

  // ---------------- actions ----------------
  private editTitle() {
    const t = this.titleEl;
    t.contentEditable = 'true';
    t.focus();
    document.getSelection()?.selectAllChildren(t);
    const finish = (commit: boolean) => {
      t.contentEditable = 'false';
      t.removeEventListener('blur', onBlur);
      t.removeEventListener('keydown', onKey);
      const v = t.textContent?.trim() ?? '';
      if (commit && v) store.updateWidget(this.wsId, this.id, { title: v });
      else t.textContent = this.state.title;
    };
    const onBlur = () => finish(true);
    const onKey = (e: KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        finish(true);
      } else if (e.key === 'Escape') finish(false);
    };
    t.addEventListener('blur', onBlur);
    t.addEventListener('keydown', onKey);
  }

  private typeMenu() {
    showMenu(
      CHART_TYPES.map((c) => ({
        title: c.label,
        icon: c.icon,
        checked: this.state.type === c.type,
        onClick: () => store.setChartType(this.wsId, this.id, c.type),
      })),
      this.typeBtn,
    );
  }

  private toggleLink() {
    const st = this.state;
    if (st.linked) store.updateWidget(this.wsId, this.id, { linked: false, range: store.sheetRange(this.wsId) });
    else store.updateWidget(this.wsId, this.id, { linked: true });
    store.emit('range', this.wsId);
  }

  toggleMaximize() {
    const host = this.el.closest('.workspace-leaf')?.querySelector<HTMLElement>('.maximize-host');
    if (!host) return;
    if (this.maxParent) {
      this.maxParent.parent.insertBefore(this.content, this.maxParent.next);
      this.maxParent = null;
      host.classList.remove('is-active');
      this.maxBtn.replaceChildren(icon(Maximize2, 16));
      this.maxBtn.title = '최대화';
    } else {
      this.maxParent = { parent: this.content.parentElement!, next: this.content.nextSibling };
      host.replaceChildren(this.content);
      host.classList.add('is-active');
      this.maxBtn.replaceChildren(icon(Minimize2, 16));
      this.maxBtn.title = '복원';
    }
  }

  get isMaximized() {
    return this.maxParent !== null;
  }

  private moreMenu(e: MouseEvent) {
    const st = this.state;
    const items: MenuItem[] = [
      { title: '이름 변경', icon: Pencil, onClick: () => this.editTitle() },
      { title: '속성 패널', icon: Settings2, onClick: () => { store.select(this.id); store.updateSettings({ rightOpen: true }); } },
      { separator: true, title: '' },
      ...CHART_TYPES.map((c) => ({ title: c.label, icon: c.icon, checked: st.type === c.type, onClick: () => store.setChartType(this.wsId, this.id, c.type) })),
      { separator: true, title: '' },
      { title: st.showLegend ? '범례 숨기기' : '범례 보이기', icon: Table2, onClick: () => store.updateWidget(this.wsId, this.id, { showLegend: !st.showLegend }) },
      { title: '모든 시리즈 보이기', icon: Eye, onClick: () => st.series.forEach((s) => store.updateSeries(this.wsId, this.id, s.id, { visible: true })) },
      { title: '스냅샷 PNG', icon: Camera, onClick: () => void this.snapshot() },
      { title: '보이는 구간 CSV 내보내기', icon: Download, onClick: () => this.exportCsv() },
      { title: '위젯 복제', icon: Copy, onClick: () => store.duplicateWidget(this.wsId, this.id) },
      { separator: true, title: '' },
      { title: '위젯 삭제', icon: Trash2, danger: true, onClick: () => store.removeWidget(this.wsId, this.id) },
    ];
    showMenu(items, e.type === 'contextmenu' ? { x: e.clientX, y: e.clientY } : (e.currentTarget as HTMLElement) ?? { x: e.clientX, y: e.clientY });
  }

  private seriesMenu(s: SeriesRef, e: MouseEvent) {
    const st = this.state;
    showMenu(
      [
        { title: s.visible ? '숨기기' : '보이기', icon: s.visible ? EyeOff : Eye, onClick: () => store.updateSeries(this.wsId, this.id, s.id, { visible: !s.visible }) },
        {
          title: '이것만 보기',
          icon: Eye,
          onClick: () => st.series.forEach((x) => store.updateSeries(this.wsId, this.id, x.id, { visible: x.id === s.id })),
        },
        { title: '속성 편집…', icon: Settings2, onClick: () => { store.select(this.id); store.updateSettings({ rightOpen: true }); } },
        {
          title: '새 위젯으로 분리',
          icon: Copy,
          onClick: () => {
            const nw = store.addWidget(this.wsId, { type: st.type, y: st.y + st.h, x: st.x, w: st.w, h: st.h }, []);
            if (nw) store.moveSeries({ worksheetId: this.wsId, widgetId: this.id, seriesIds: [s.id] }, this.wsId, nw.id);
          },
        },
        { separator: true, title: '' },
        { title: '제거', icon: Trash2, danger: true, onClick: () => store.removeSeries(this.wsId, this.id, [s.id]) },
      ],
      { x: e.clientX, y: e.clientY },
    );
  }

  /** PNG of the chart canvas with a title and legend row, at device resolution. */
  async snapshot() {
    const u = this.u;
    if (!u) return;
    const st = this.state;
    const dpr = devicePixelRatio || 1;
    const src = u.ctx.canvas;
    const head = 34 * dpr;
    const foot = 30 * dpr;
    const c = document.createElement('canvas');
    c.width = src.width;
    c.height = src.height + head + foot;
    const g = c.getContext('2d')!;
    const fontFam = cssVar('--font-interface');
    g.fillStyle = cssVar('--background-primary');
    g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = cssVar('--text-normal');
    g.font = `600 ${14 * dpr}px ${fontFam}`;
    g.textBaseline = 'middle';
    g.fillText(st.title, 12 * dpr, head / 2);
    g.drawImage(src, 0, head);
    g.font = `${12 * dpr}px ${fontFam}`;
    let x = 12 * dpr;
    const y = head + src.height + foot / 2;
    for (const s of this.loadedSeries(st).filter((s) => s.visible)) {
      g.fillStyle = resolveColor(s.color, store.ws.settings.theme);
      g.fillRect(x, y - 5 * dpr, 10 * dpr, 10 * dpr);
      g.fillStyle = cssVar('--text-muted');
      g.fillText(s.label, x + 15 * dpr, y);
      x += g.measureText(s.label).width + 32 * dpr;
    }
    const blob = await new Promise<Blob | null>((res) => c.toBlob(res, 'image/png'));
    if (!blob) return;
    const path = await saveFile('png', `${st.title.replace(/[^\w\-가-힣 ]+/g, '_') || 'chart'}.png`);
    if (!path) return;
    try {
      await engine.writeFile(path, new Uint8Array(await blob.arrayBuffer()));
      notice(`스냅샷 저장: ${path}`);
    } catch (e) {
      notice(`저장 실패: ${(e as Error).message}`, 6000, 'error');
    }
  }

  /** Export the visible window (raw samples, all series on a union time axis). */
  async exportCsv() {
    const st = this.state;
    const range = this.renderedRange ?? store.widgetRange(this.wsId, st);
    if (!range) return;
    const series = this.loadedSeries(st);
    const path = await saveFile('csv', `${st.title || 'chart'}.csv`);
    if (!path) return;
    try {
      const r = await engine.exportCsv(path, series.map((s) => ({ ...seriesKey(s), label: s.label, scale: s.scale, offset: s.offset })), range.start, range.end);
      notice(`${formatCount(r.rows)}행을 내보냈습니다: ${path}`);
    } catch (e) {
      notice(`내보내기 실패: ${(e as Error).message}`, 6000, 'error');
    }
  }
}
