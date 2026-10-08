import { GridStack } from 'gridstack';
import {
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock,
  Crosshair,
  FolderOpen,
  Hand,
  LayoutGrid,
  Maximize,
  Plus,
  Sparkles,
  SquareDashedMousePointer,
  ZoomIn,
  ZoomOut,
} from 'lucide';
import { store } from '../store';
import type { TimeRange } from '../types';
import { dropTarget, isSeries } from './dnd';
import { formatDuration, fromInputValue, toInputValue } from '../data/time';
import { h, icon, iconButton } from '../util';
import { ChartWidget } from './chartWidget';
import { showMenu } from './overlays';
import { actions } from '../actions';

const PRESETS: { label: string; ms: number | null; hint?: string }[] = [
  { label: '전체 데이터', ms: null, hint: 'A' },
  { label: '마지막 15분', ms: 15 * 60e3 },
  { label: '마지막 1시간', ms: 3600e3 },
  { label: '마지막 6시간', ms: 6 * 3600e3 },
  { label: '마지막 12시간', ms: 12 * 3600e3 },
  { label: '마지막 24시간', ms: 24 * 3600e3 },
  { label: '마지막 7일', ms: 7 * 86400e3 },
  { label: '마지막 30일', ms: 30 * 86400e3 },
];

export class WorksheetView {
  readonly el: HTMLElement;
  private gridEl: HTMLElement;
  private grid: GridStack;
  private widgets = new Map<string, ChartWidget>();
  private unsub: (() => void)[] = [];
  private fromInput: HTMLInputElement;
  private toInput: HTMLInputElement;
  private backBtn: HTMLButtonElement;
  private fwdBtn: HTMLButtonElement;
  private crossBtn: HTMLButtonElement;
  private dragBtn: HTMLButtonElement;
  private durLabel: HTMLElement;
  private emptyState: HTMLElement;
  private syncingGrid = false;

  constructor(readonly wsId: string) {
    this.backBtn = iconButton(ArrowLeft, '뒤로 (Alt+←)', () => store.back(this.wsId));
    this.fwdBtn = iconButton(ArrowRight, '앞으로 (Alt+→)', () => store.forward(this.wsId));
    this.fromInput = h('input', { type: 'datetime-local', step: '1', class: 'time-input', 'aria-label': '시작 시각' });
    this.toInput = h('input', { type: 'datetime-local', step: '1', class: 'time-input', 'aria-label': '종료 시각' });
    const applyInputs = () => {
      const a = fromInputValue(this.fromInput.value);
      const b = fromInputValue(this.toInput.value);
      if (Number.isFinite(a) && Number.isFinite(b) && b > a) store.setRange(this.wsId, { start: a, end: b });
      else this.syncToolbar();
    };
    this.fromInput.addEventListener('change', applyInputs);
    this.toInput.addEventListener('change', applyInputs);
    this.durLabel = h('span', { class: 'range-duration' });
    this.crossBtn = iconButton(Crosshair, '크로스헤어 동기화', () => {
      const ws = store.sheet(this.wsId)!;
      store.updateWorksheet(this.wsId, { crosshair: !ws.crosshair });
    });
    this.dragBtn = iconButton(SquareDashedMousePointer, '드래그 모드: 줌 / 이동', () =>
      store.updateSettings({ dragMode: store.ws.settings.dragMode === 'zoom' ? 'pan' : 'zoom' }),
    );

    const presetBtn = h('button', { class: 'toolbar-button', type: 'button', title: '시간 범위 프리셋' }, icon(Clock, 15), h('span', {}, '범위'), icon(ChevronDown, 14));
    presetBtn.addEventListener('click', () =>
      showMenu(
        PRESETS.map((p) => ({ title: p.label, hint: p.hint, onClick: () => this.applyPreset(p.ms) })),
        presetBtn,
      ),
    );

    const header = h(
      'div',
      { class: 'view-header' },
      h('div', { class: 'view-header-nav' }, this.backBtn, this.fwdBtn),
      h(
        'div',
        { class: 'view-header-range' },
        presetBtn,
        iconButton(ChevronLeft, '왼쪽으로 이동 (←)', () => this.pan(-0.25)),
        this.fromInput,
        h('span', { class: 'range-sep' }, '→'),
        this.toInput,
        iconButton(ChevronRight, '오른쪽으로 이동 (→)', () => this.pan(0.25)),
        iconButton(ZoomIn, '확대 (+)', () => this.zoom(0.5)),
        iconButton(ZoomOut, '축소 (-)', () => this.zoom(2)),
        iconButton(Maximize, '전체 보기 (A)', () => this.applyPreset(null)),
        this.durLabel,
      ),
      h('div', { class: 'widget-header-spacer' }),
      h(
        'div',
        { class: 'view-actions' },
        this.crossBtn,
        this.dragBtn,
        iconButton(LayoutGrid, '레이아웃 정렬', () => this.compact()),
        iconButton(Plus, '빈 차트 위젯 추가', () => store.addWidget(this.wsId)),
      ),
    );

    this.gridEl = h('div', { class: 'grid-stack' });
    this.emptyState = h(
      'div',
      { class: 'empty-state' },
      h('div', { class: 'empty-state-title' }, '빈 워크시트'),
      h('div', { class: 'empty-state-desc' }, '왼쪽 탐색기에서 시리즈(열)를 이 영역으로 드래그하면 차트 위젯이 생성됩니다.'),
      h(
        'div',
        { class: 'empty-state-actions' },
        h('button', { class: 'mod-cta', type: 'button', onclick: (() => actions.openCsv()) as EventListener }, icon(FolderOpen, 15), ' CSV 열기'),
        h('button', { type: 'button', onclick: (() => actions.loadSample()) as EventListener }, icon(Sparkles, 15), ' 샘플 데이터'),
        h('button', { type: 'button', onclick: (() => store.addWidget(this.wsId)) as EventListener }, icon(Plus, 15), ' 빈 위젯'),
      ),
    );
    const content = h('div', { class: 'view-content' }, this.gridEl, this.emptyState);
    this.el = h('div', { class: 'workspace-leaf' }, header, content, h('div', { class: 'maximize-host' }));

    this.grid = GridStack.init(
      {
        column: 12,
        cellHeight: 64,
        margin: 5,
        float: true,
        animate: true,
        handle: '.widget-header',
        resizable: { handles: 'e,se,s,sw,w' },
        columnOpts: { breakpoints: [{ w: 720, c: 1 }] },
      },
      this.gridEl,
    );
    this.grid.on('change', (_e, nodes) => {
      if (this.syncingGrid) return;
      for (const n of nodes) {
        const id = n.el?.getAttribute('gs-id');
        if (id && this.grid.getColumn() === 12) store.setLayout(this.wsId, id, { x: n.x ?? 0, y: n.y ?? 0, w: n.w ?? 6, h: n.h ?? 5 });
      }
    });

    this.bindDrop(content);
    this.syncWidgets();
    this.syncToolbar();

    this.unsub.push(
      store.on('widgets', (ws) => {
        if (ws !== this.wsId) return;
        this.syncWidgets();
        this.syncToolbar();
      }),
      store.on('range', (ws) => ws === this.wsId && this.syncToolbar()),
      store.on('settings', () => this.syncToolbar()),
      store.on('worksheets', () => this.syncToolbar()),
    );
  }

  destroy() {
    this.unsub.forEach((f) => f());
    this.widgets.forEach((w) => w.destroy());
    this.widgets.clear();
    this.grid.destroy(false);
    this.el.remove();
  }

  private syncWidgets() {
    const ws = store.sheet(this.wsId);
    if (!ws) return;
    const ids = new Set(ws.widgets.map((w) => w.id));
    this.syncingGrid = true;
    this.grid.batchUpdate(true);
    for (const [id, w] of this.widgets) {
      if (!ids.has(id)) {
        if (w.isMaximized) w.toggleMaximize();
        this.grid.removeWidget(w.el, false, false);
        w.destroy();
        this.widgets.delete(id);
      }
    }
    for (const st of ws.widgets) {
      if (this.widgets.has(st.id)) continue;
      const cw = new ChartWidget(this.wsId, st.id);
      this.widgets.set(st.id, cw);
      this.gridEl.append(cw.el);
      this.grid.makeWidget(cw.el, { x: st.x, y: st.y, w: st.w, h: st.h, minW: 2, minH: 2, id: st.id });
    }
    this.grid.batchUpdate(false);
    this.syncingGrid = false;
    // persist positions gridstack may have adjusted
    for (const n of this.grid.engine.nodes) {
      const id = n.el?.getAttribute('gs-id');
      if (id && this.grid.getColumn() === 12) store.setLayout(this.wsId, id, { x: n.x ?? 0, y: n.y ?? 0, w: n.w ?? 6, h: n.h ?? 5 });
    }
    this.emptyState.hidden = ws.widgets.length > 0;
  }

  private compact() {
    this.grid.compact();
  }

  widget(id: string) {
    return this.widgets.get(id);
  }

  private syncToolbar() {
    const ws = store.sheet(this.wsId);
    if (!ws) return;
    const r = store.sheetRange(this.wsId);
    this.backBtn.disabled = !store.canBack(this.wsId);
    this.fwdBtn.disabled = !store.canForward(this.wsId);
    if (r) {
      if (document.activeElement !== this.fromInput) this.fromInput.value = toInputValue(r.start);
      if (document.activeElement !== this.toInput) this.toInput.value = toInputValue(r.end);
      this.durLabel.textContent = `${formatDuration(r.end - r.start)}${ws.range ? '' : ' · 전체'}`;
    } else {
      this.fromInput.value = '';
      this.toInput.value = '';
      this.durLabel.textContent = '데이터 없음';
    }
    this.crossBtn.classList.toggle('is-active', ws.crosshair);
    const pan = store.ws.settings.dragMode === 'pan';
    this.dragBtn.replaceChildren(icon(pan ? Hand : SquareDashedMousePointer, 16));
    this.dragBtn.title = pan ? '드래그 모드: 이동 (클릭 → 줌)' : '드래그 모드: 박스 줌 (클릭 → 이동)';
  }

  applyPreset(ms: number | null) {
    const ext = store.sheetExtent(this.wsId);
    if (!ext || ms === null) return store.setRange(this.wsId, null);
    store.setRange(this.wsId, { start: Math.max(ext.start, ext.end - ms), end: ext.end });
  }

  pan(fraction: number) {
    const r = store.sheetRange(this.wsId);
    if (!r) return;
    const d = (r.end - r.start) * fraction;
    store.setRange(this.wsId, { start: r.start + d, end: r.end + d });
  }

  zoom(factor: number) {
    const r = store.sheetRange(this.wsId);
    if (!r) return;
    const c = (r.start + r.end) / 2;
    const half = ((r.end - r.start) * factor) / 2;
    const next: TimeRange = { start: c - half, end: c + half };
    const ext = store.sheetExtent(this.wsId);
    if (ext && factor > 1 && next.start <= ext.start && next.end >= ext.end) return store.setRange(this.wsId, null);
    store.setRange(this.wsId, next);
  }

  /** Dropping series on empty grid space creates a new widget there. */
  private bindDrop(area: HTMLElement) {
    dropTarget(area, {
      accepts: isSeries,
      drop: (p, e) => {
        if (!isSeries(p)) return;
        const rect = this.gridEl.getBoundingClientRect();
        const cell = this.grid.getCellFromPixel({ left: e.clientX - rect.left, top: e.clientY - rect.top });
        const x = Math.max(0, Math.min(6, cell.x));
        const w = store.addWidget(this.wsId, { x, y: Math.max(0, cell.y) }, p.data.fromWidget ? [] : p.data.items);
        if (w && p.data.fromWidget) store.moveSeries(p.data.fromWidget, this.wsId, w.id, e.altKey || e.ctrlKey);
      },
    });
  }
}
