import Plotly from 'plotly.js-dist-min';
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
import type { ChartType, SeriesDrag, SeriesRef, TimeRange, WidgetState } from '../types';
import { DRAG_MIME, DRAG_MOVE_MIME } from '../types';
import { windowed, windowStats } from '../data/downsample';
import { formatTime, plotlyDateToMs } from '../data/time';
import { resolveColor, withAlpha } from '../palette';
import { cssVar, downloadBlob, formatValue, h, icon, iconButton, lowerBound, nearestIndex, rafThrottle } from '../util';
import { showMenu, type MenuItem } from './overlays';

export const CHART_TYPES: { type: ChartType; label: string; icon: IconNode }[] = [
  { type: 'line', label: '라인', icon: ChartLine },
  { type: 'area', label: '영역', icon: ChartArea },
  { type: 'stacked', label: '누적 영역', icon: Layers },
  { type: 'step', label: '스텝', icon: Activity },
  { type: 'scatter', label: '산점도', icon: ChartScatter },
];

interface Gd extends HTMLDivElement {
  _fullLayout?: {
    xaxis: Axis;
    yaxis: Axis;
  };
  on?: (ev: string, fn: (e: Record<string, unknown>) => void) => void;
}
interface Axis {
  _offset: number;
  _length: number;
  l2p: (v: number) => number;
  p2l: (v: number) => number;
  type: string;
}

export class ChartWidget {
  readonly el: HTMLElement;
  readonly content: HTMLElement;
  private gd: Gd;
  private plotWrap: HTMLElement;
  private legend: HTMLElement;
  private titleEl: HTMLElement;
  private typeBtn: HTMLButtonElement;
  private linkBtn: HTMLButtonElement;
  private maxBtn: HTMLButtonElement;
  private badge: HTMLElement;
  private empty: HTMLElement;
  private vline: HTMLElement;
  private hline: HTMLElement;
  private xLabel: HTMLElement;
  private yLabel: HTMLElement;
  private plotted = false;
  private suppressRelayout = 0;
  private mouseY: number | null = null;
  private lastCursor: number | null = null;
  private valueCells: HTMLElement[] = [];
  private legendRows: HTMLElement[] = [];
  private unsub: (() => void)[] = [];
  private ro: ResizeObserver;
  private maxParent: { parent: HTMLElement; next: Node | null } | null = null;
  private renderedRange: TimeRange | null = null;
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

    this.gd = h('div', { class: 'widget-gd' }) as Gd;
    this.vline = h('div', { class: 'crosshair-v' });
    this.hline = h('div', { class: 'crosshair-h' });
    this.xLabel = h('div', { class: 'crosshair-label is-x' });
    this.yLabel = h('div', { class: 'crosshair-label is-y' });
    this.empty = h(
      'div',
      { class: 'widget-empty' },
      icon(ChartLine, 28),
      h('div', {}, '사이드바에서 시리즈를 여기로 드래그하세요'),
    );
    this.plotWrap = h('div', { class: 'widget-plot' }, this.gd, this.vline, this.hline, this.xLabel, this.yLabel, this.empty);
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
    this.bindCursor();

    this.ro = new ResizeObserver(
      rafThrottle(() => {
        if (!this.plotted || !this.gd.isConnected || !this.gd.offsetWidth) return;
        this.suppressRelayout++;
        Promise.resolve(Plotly.Plots.resize(this.gd)).finally(() => {
          this.suppressRelayout--;
          this.drawCursor(this.lastCursor, false);
        });
      }),
    );
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
    if (this.plotted) Plotly.purge(this.gd);
    this.el.remove();
  }

  // ---------------- rendering ----------------
  render = rafThrottle(() => this.doRender());

  private doRender() {
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

    const series = st.series.filter((s) => store.column(s.sourceId, s.column));
    this.empty.hidden = series.length > 0;
    const range = store.widgetRange(this.wsId, st);
    if (!series.length || !range) {
      if (this.plotted) {
        Plotly.purge(this.gd);
        this.plotted = false;
      }
      this.renderLegend([], null);
      return;
    }
    if (!this.gd.offsetWidth) {
      // hidden (e.g. inactive tab) — render when the observer sees a size
      requestAnimationFrame(() => this.gd.isConnected && this.render());
      return;
    }

    const theme = store.ws.settings.theme;
    const stacked = st.type === 'stacked';
    const maxPts = stacked ? Math.min(st.maxPoints || 1500, 1500) : st.maxPoints;
    // scale buckets with the plot width so wide charts keep detail
    const target = maxPts ? Math.max(maxPts, Math.round(this.gd.offsetWidth * 4)) : 0;
    let raw = 0;
    let shown = 0;
    const traces = series.map((s) => {
      const { source, col } = store.column(s.sourceId, s.column)!;
      const win = windowed(source.time, col.values, range.start, range.end, target, s.scale, s.offset);
      raw += win.raw;
      shown += win.x.length;
      const color = resolveColor(s.color, theme);
      const base: Record<string, unknown> = {
        x: win.x,
        y: win.y,
        name: s.label,
        visible: s.visible,
        hoverinfo: 'none',
        connectgaps: false,
      };
      const lw = st.lineWidth;
      switch (st.type) {
        case 'scatter':
          return { ...base, type: 'scattergl', mode: 'markers', marker: { color, size: 5, opacity: 0.8 } };
        case 'area':
          return {
            ...base,
            type: 'scattergl',
            mode: st.markers ? 'lines+markers' : 'lines',
            line: { color, width: lw },
            marker: { color, size: 6 },
            fill: 'tozeroy',
            fillcolor: withAlpha(color, 0.16),
          };
        case 'stacked':
          return {
            ...base,
            type: 'scatter',
            mode: 'lines',
            stackgroup: 'one',
            line: { color, width: Math.min(lw, 1.5) },
            fillcolor: withAlpha(color, 0.55),
          };
        case 'step':
          return {
            ...base,
            type: 'scattergl',
            mode: st.markers ? 'lines+markers' : 'lines',
            line: { color, width: lw, shape: 'hv' },
            marker: { color, size: 6 },
          };
        default:
          return {
            ...base,
            type: 'scattergl',
            mode: st.markers ? 'lines+markers' : 'lines',
            line: { color, width: lw },
            marker: { color, size: 6 },
          };
      }
    });

    const y = st.yAxis;
    const text = cssVar('--text-muted');
    const grid = cssVar('--chart-grid');
    const bg = cssVar('--background-primary');
    const zoomY = store.ws.settings.zoomY;
    const layout = {
      autosize: true,
      margin: { l: 58, r: 14, t: 10, b: 30, pad: 2 },
      paper_bgcolor: bg,
      plot_bgcolor: bg,
      font: { family: cssVar('--font-interface'), size: 11, color: text },
      showlegend: false,
      hovermode: false,
      dragmode: store.ws.settings.dragMode,
      xaxis: {
        type: 'date',
        range: [range.start, range.end],
        gridcolor: grid,
        linecolor: grid,
        zeroline: false,
        tickfont: { color: text },
        automargin: true,
        hoverformat: '%Y-%m-%d %H:%M:%S',
      },
      yaxis: {
        type: y.log ? 'log' : 'linear',
        autorange: y.auto,
        range: y.auto ? undefined : y.log ? [Math.log10(Math.max(1e-12, y.min ?? 1)), Math.log10(Math.max(1e-12, y.max ?? 10))] : [y.min ?? 0, y.max ?? 1],
        rangemode: y.includeZero ? 'tozero' : 'normal',
        fixedrange: !zoomY,
        gridcolor: grid,
        linecolor: grid,
        zerolinecolor: grid,
        tickformat: y.siPrefix ? '~s' : '',
        ticksuffix: y.unit ? ` ${y.unit}` : '',
        automargin: true,
        tickfont: { color: text },
      },
    };
    const config = {
      displayModeBar: false,
      displaylogo: false,
      showTips: false,
      scrollZoom: true,
      doubleClick: false,
      responsive: false,
    };

    this.suppressRelayout++;
    const first = !this.plotted;
    Promise.resolve(Plotly.react(this.gd, traces, layout, config))
      .then(() => {
        if (first) this.bindPlotEvents();
        this.plotted = true;
        this.renderedRange = range;
        this.drawCursor(this.lastCursor, false);
        ChartWidget.onRendered?.(this.wsId, this.id, raw, shown, performance.now() - t0);
      })
      .catch((e: unknown) => console.error('plot failed', e))
      .finally(() => this.suppressRelayout--);

    this.renderLegend(series, range);
  }

  private bindPlotEvents() {
    this.gd.on?.('plotly_relayout', (ev) => {
      if (this.suppressRelayout > 0) return;
      const st = this.state;
      const x0 = ev['xaxis.range[0]'] ?? (ev['xaxis.range'] as unknown[] | undefined)?.[0];
      const x1 = ev['xaxis.range[1]'] ?? (ev['xaxis.range'] as unknown[] | undefined)?.[1];
      const y0 = ev['yaxis.range[0]'] ?? (ev['yaxis.range'] as unknown[] | undefined)?.[0];
      const y1 = ev['yaxis.range[1]'] ?? (ev['yaxis.range'] as unknown[] | undefined)?.[1];
      if (y0 !== undefined && y1 !== undefined) {
        const lg = st.yAxis.log;
        const a = lg ? 10 ** Number(y0) : Number(y0);
        const b = lg ? 10 ** Number(y1) : Number(y1);
        st.yAxis = { ...st.yAxis, auto: false, min: Math.min(a, b), max: Math.max(a, b) };
        if (x0 === undefined) store.updateWidget(this.wsId, this.id, {});
      } else if (ev['yaxis.autorange']) {
        st.yAxis = { ...st.yAxis, auto: true };
      }
      if (ev['xaxis.autorange']) this.setRange(null);
      else if (x0 !== undefined && x1 !== undefined) {
        const a = plotlyDateToMs(x0);
        const b = plotlyDateToMs(x1);
        if (Number.isFinite(a) && Number.isFinite(b) && b > a) this.setRange({ start: a, end: b });
      }
    });
    this.gd.addEventListener('dblclick', () => this.resetZoom());
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
    this.legendRows = [];
    if (!series.length || !range) {
      this.legend.replaceChildren();
      return;
    }
    const st = this.state;
    const theme = store.ws.settings.theme;
    const si = st.yAxis.siPrefix;
    const unit = st.yAxis.unit;
    const tbody = h('tbody');
    series.forEach((s, i) => {
      const { source, col } = store.column(s.sourceId, s.column)!;
      const stats = windowStats(source.time, col.values, range.start, range.end, s.scale, s.offset);
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
        { draggable: 'true', class: s.visible ? '' : 'is-hidden', title: `${source.name} › ${s.column}` },
        h('td', { class: 'legend-name' }, swatch, h('span', {}, s.label)),
        val,
        h('td', { class: 'num' }, formatValue(stats.min, si, unit)),
        h('td', { class: 'num' }, formatValue(stats.max, si, unit)),
        h('td', { class: 'num' }, formatValue(stats.mean, si, unit)),
      );
      row.addEventListener('dragstart', (e) => {
        const payload: SeriesDrag = {
          items: [{ sourceId: s.sourceId, column: s.column }],
          fromWidget: { worksheetId: this.wsId, widgetId: this.id, seriesIds: [s.id] },
        };
        e.dataTransfer!.setData(DRAG_MIME, JSON.stringify(payload));
        e.dataTransfer!.setData(DRAG_MOVE_MIME, '1');
        e.dataTransfer!.effectAllowed = 'copyMove';
      });
      row.addEventListener('mouseenter', () => this.highlight(i));
      row.addEventListener('mouseleave', () => this.highlight(-1));
      row.addEventListener('dblclick', () => store.select(this.id));
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.seriesMenu(s, e);
      });
      this.legendRows.push(row);
      tbody.append(row);
    });
    const head = h(
      'thead',
      {},
      h('tr', {}, h('th', {}, `시리즈 (${series.length})`), h('th', { class: 'num' }, '커서'), h('th', { class: 'num' }, '최소'), h('th', { class: 'num' }, '최대'), h('th', { class: 'num' }, '평균')),
    );
    this.legend.replaceChildren(h('table', { class: 'legend-table' }, head, tbody));
    this.updateCursorValues(this.lastCursor);
  }

  private highlight(i: number) {
    if (!this.plotted) return;
    const n = (this.gd as unknown as { data?: unknown[] }).data?.length ?? 0;
    if (!n) return;
    const op = Array.from({ length: n }, (_, k) => (i < 0 || k === i ? 1 : 0.2));
    this.suppressRelayout++;
    Promise.resolve(Plotly.restyle(this.gd, { opacity: op })).finally(() => this.suppressRelayout--);
  }

  // ---------------- crosshair ----------------
  private bindCursor() {
    const move = rafThrottle((cx: number, cy: number) => {
      const fl = this.gd._fullLayout;
      if (!fl || !this.plotted) return;
      const r = this.gd.getBoundingClientRect();
      const px = cx - r.left - fl.xaxis._offset;
      const py = cy - r.top - fl.yaxis._offset;
      if (px < 0 || px > fl.xaxis._length || py < 0 || py > fl.yaxis._length) {
        this.mouseY = null;
        store.cursor(this.wsId, null, this.id);
        return;
      }
      this.mouseY = py;
      store.cursor(this.wsId, fl.xaxis.p2l(px), this.id);
    });
    this.gd.addEventListener('mousemove', (e) => move(e.clientX, e.clientY));
    this.gd.addEventListener('mouseleave', () => {
      this.mouseY = null;
      setTimeout(() => store.cursor(this.wsId, null, this.id), 0);
    });
  }

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
    const fl = this.gd._fullLayout;
    const sheet = store.sheet(this.wsId);
    const showLines = sheet?.crosshair !== false;
    const hide = () => {
      this.vline.style.display = 'none';
      this.hline.style.display = 'none';
      this.xLabel.style.display = 'none';
      this.yLabel.style.display = 'none';
    };
    if (x === null || !fl || !this.plotted) {
      hide();
      this.updateCursorValues(null);
      return;
    }
    const xa = fl.xaxis;
    const ya = fl.yaxis;
    const px = xa.l2p(x);
    if (px < 0 || px > xa._length) {
      hide();
      this.updateCursorValues(null);
      return;
    }
    this.updateCursorValues(x);
    if (!showLines) return hide();
    const left = xa._offset + px;
    Object.assign(this.vline.style, { display: 'block', left: `${left}px`, top: `${ya._offset}px`, height: `${ya._length}px` });
    this.xLabel.textContent = formatTime(x);
    const lw = this.xLabel.offsetWidth || 120;
    Object.assign(this.xLabel.style, {
      display: 'block',
      left: `${Math.min(Math.max(left - lw / 2, xa._offset), xa._offset + xa._length - lw)}px`,
      top: `${ya._offset + ya._length + 2}px`,
    });
    if (own && this.mouseY !== null) {
      const top = ya._offset + this.mouseY;
      Object.assign(this.hline.style, { display: 'block', top: `${top}px`, left: `${xa._offset}px`, width: `${xa._length}px` });
      let v = ya.p2l(this.mouseY);
      if (ya.type === 'log') v = 10 ** v;
      this.yLabel.textContent = formatValue(v, this.state.yAxis.siPrefix, this.state.yAxis.unit);
      Object.assign(this.yLabel.style, { display: 'block', top: `${top - 9}px`, left: `${xa._offset + 2}px` });
    } else {
      this.hline.style.display = 'none';
      this.yLabel.style.display = 'none';
    }
  }

  private updateCursorValues(x: number | null) {
    const st = this.state;
    if (!st) return;
    const series = st.series.filter((s) => store.column(s.sourceId, s.column));
    series.forEach((s, i) => {
      const cell = this.valueCells[i];
      if (!cell) return;
      if (x === null) {
        cell.textContent = '—';
        return;
      }
      const { source, col } = store.column(s.sourceId, s.column)!;
      const k = nearestIndex(source.time, x);
      const v = k >= 0 ? col.values[k] * s.scale + s.offset : NaN;
      cell.textContent = formatValue(v, st.yAxis.siPrefix, st.yAxis.unit);
    });
  }

  // ---------------- drop target ----------------
  private bindDrop() {
    const c = this.content;
    c.addEventListener('dragover', (e) => {
      if (!e.dataTransfer?.types.includes(DRAG_MIME)) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = e.dataTransfer.types.includes(DRAG_MOVE_MIME) && !(e.altKey || e.ctrlKey) ? 'move' : 'copy';
      c.classList.add('is-drop-target');
    });
    c.addEventListener('dragleave', (e) => {
      if (!c.contains(e.relatedTarget as Node)) c.classList.remove('is-drop-target');
    });
    c.addEventListener('drop', (e) => {
      c.classList.remove('is-drop-target');
      const raw = e.dataTransfer?.getData(DRAG_MIME);
      if (!raw) return;
      e.preventDefault();
      e.stopPropagation();
      const p = JSON.parse(raw) as SeriesDrag;
      if (p.fromWidget) store.moveSeries(p.fromWidget, this.wsId, this.id, e.altKey || e.ctrlKey);
      else store.addSeries(this.wsId, this.id, p.items);
      store.select(this.id);
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

  async snapshot() {
    if (!this.plotted) return;
    this.suppressRelayout++;
    try {
      await Plotly.relayout(this.gd, {
        showlegend: true,
        legend: { orientation: 'h', y: -0.15, font: { color: cssVar('--text-normal') } },
        title: { text: this.state.title, font: { color: cssVar('--text-normal'), size: 14 } },
        'margin.t': 36,
      });
      const w = Math.max(this.gd.offsetWidth, 900);
      const url: string = await Plotly.toImage(this.gd, { format: 'png', width: w, height: Math.round(w * 0.5), scale: 2 });
      const blob = await (await fetch(url)).blob();
      downloadBlob(blob, `${this.state.title.replace(/[^\w\-가-힣 ]+/g, '_') || 'chart'}.png`);
    } finally {
      await Plotly.relayout(this.gd, { showlegend: false, title: { text: '' }, 'margin.t': 10 });
      this.suppressRelayout--;
    }
  }

  exportCsv() {
    const st = this.state;
    const range = this.renderedRange ?? store.widgetRange(this.wsId, st);
    if (!range) return;
    const series = st.series.filter((s) => store.column(s.sourceId, s.column));
    // union of timestamps in the window
    const stamps = new Set<number>();
    for (const s of series) {
      const { source } = store.column(s.sourceId, s.column)!;
      const i0 = lowerBound(source.time, range.start);
      const i1 = lowerBound(source.time, range.end + 1e-9);
      for (let i = i0; i < i1; i++) stamps.add(source.time[i]);
    }
    const times = Float64Array.from(stamps).sort();
    const cols = series.map((s) => {
      const { source, col } = store.column(s.sourceId, s.column)!;
      return (t: number) => {
        const k = lowerBound(source.time, t);
        if (source.time[k] !== t) return '';
        const v = col.values[k];
        return Number.isNaN(v) ? '' : String(v * s.scale + s.offset);
      };
    });
    const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    const lines = [['timestamp', ...series.map((s) => esc(s.label))].join(',')];
    for (const t of times) lines.push([formatTime(t, true), ...cols.map((f) => f(t))].join(','));
    downloadBlob(new Blob([lines.join('\n')], { type: 'text/csv' }), `${st.title || 'chart'}.csv`);
  }
}
