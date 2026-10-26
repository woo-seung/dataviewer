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
  LayoutDashboard,
  Maximize,
  Plus,
  Sparkles,
  SquareDashedMousePointer,
  ZoomIn,
  ZoomOut,
} from 'lucide';
import { store } from '../store';
import type { TimeRange } from '../types';
import { MIN_TILE, type Tile } from '../layout';
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
  private tilesEl: HTMLElement;
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
        iconButton(LayoutDashboard, '타일 크기 균등하게', () => store.equalizeTiles(this.wsId)),
        iconButton(Plus, '빈 차트 위젯 추가', () => store.addWidget(this.wsId)),
      ),
    );

    this.tilesEl = h('div', { class: 'tiles' });
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
    const content = h('div', { class: 'view-content' }, this.tilesEl, this.emptyState);
    this.el = h('div', { class: 'workspace-leaf' }, header, content, h('div', { class: 'maximize-host' }));

    this.bindDrop(content);
    // where new tiles go depends on the real worksheet size
    const ro = new ResizeObserver(() => {
      if (content.clientWidth > 0) store.viewSize = { w: content.clientWidth - 12, h: content.clientHeight - 12 };
    });
    ro.observe(content);
    this.unsub.push(() => ro.disconnect());
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
    this.el.remove();
  }

  private syncWidgets() {
    const ws = store.sheet(this.wsId);
    if (!ws) return;
    const ids = new Set(ws.widgets.map((w) => w.id));
    for (const [id, w] of this.widgets) {
      if (!ids.has(id)) {
        if (w.isMaximized) w.toggleMaximize();
        w.destroy();
        this.widgets.delete(id);
      }
    }
    for (const st of ws.widgets) if (!this.widgets.has(st.id)) this.widgets.set(st.id, new ChartWidget(this.wsId, st.id));
    this.renderTiles();
    this.emptyState.hidden = ws.widgets.length > 0;
  }

  /** Lay the widgets out as nested flex splits with draggable gutters. */
  private renderTiles() {
    const tree = store.layoutOf(this.wsId);
    if (!tree) return this.tilesEl.replaceChildren();
    const root = this.buildTile(tree);
    // more tiles than fit: the worksheet scrolls instead of squeezing them
    this.tilesEl.style.minWidth = `${root.minW}px`;
    this.tilesEl.style.minHeight = `${root.minH}px`;
    this.tilesEl.replaceChildren(root.el);
  }

  private buildTile(t: Tile): { el: HTMLElement; minW: number; minH: number } {
    if (t.kind === 'leaf') {
      const w = this.widgets.get(t.id);
      return { el: w ? w.el : h('div', { class: 'tile' }), minW: MIN_W, minH: MIN_H };
    }
    const row = t.dir === 'row';
    const el = h('div', { class: `tile-split ${row ? 'is-row' : 'is-col'}` });
    const parts = t.children.map((c) => this.buildTile(c));
    let minW = 0;
    let minH = 0;
    parts.forEach((p, i) => {
      p.el.style.flex = `${t.sizes[i]} 1 0px`;
      p.el.style.minWidth = `${p.minW}px`;
      p.el.style.minHeight = `${p.minH}px`;
      if (i > 0) el.append(this.gutter(t, i, parts.map((x) => x.el)));
      el.append(p.el);
      if (row) {
        minW += p.minW + (i ? GUTTER : 0);
        minH = Math.max(minH, p.minH);
      } else {
        minH += p.minH + (i ? GUTTER : 0);
        minW = Math.max(minW, p.minW);
      }
    });
    return { el, minW, minH };
  }

  /** Splitter between child i-1 and i: drag to share their space, double-click to even it out. */
  private gutter(t: Tile & { kind: 'split' }, i: number, kids: HTMLElement[]) {
    const row = t.dir === 'row';
    const g = h('div', { class: `tile-gutter ${row ? 'is-row' : 'is-col'}`, title: '끌어서 크기 조절 · 더블클릭: 반반' });
    const sizes = [...t.sizes];
    const apply = () => kids.forEach((k, j) => (k.style.flex = `${sizes[j]} 1 0px`));
    g.addEventListener('pointerdown', (down) => {
      if (down.button !== 0) return;
      down.preventDefault();
      g.setPointerCapture(down.pointerId);
      g.classList.add('is-active');
      const a = kids[i - 1].getBoundingClientRect();
      const b = kids[i].getBoundingClientRect();
      const span = row ? a.width + b.width : a.height + b.height;
      const share = sizes[i - 1] + sizes[i];
      const start = row ? down.clientX : down.clientY;
      const startA = row ? a.width : a.height;
      const minA = row ? parseFloat(kids[i - 1].style.minWidth) : parseFloat(kids[i - 1].style.minHeight);
      const minB = row ? parseFloat(kids[i].style.minWidth) : parseFloat(kids[i].style.minHeight);
      const move = (e: PointerEvent) => {
        const px = Math.max(minA || 0, Math.min(span - (minB || 0), startA + (row ? e.clientX : e.clientY) - start));
        sizes[i - 1] = (share * px) / span;
        sizes[i] = share - sizes[i - 1];
        apply();
      };
      const up = () => {
        g.classList.remove('is-active');
        g.removeEventListener('pointermove', move);
        g.removeEventListener('pointerup', up);
        g.removeEventListener('pointercancel', up);
        store.setTileSizes(this.wsId, t.id, [...sizes]);
      };
      g.addEventListener('pointermove', move);
      g.addEventListener('pointerup', up);
      g.addEventListener('pointercancel', up);
    });
    g.addEventListener('dblclick', () => {
      const share = sizes[i - 1] + sizes[i];
      sizes[i - 1] = sizes[i] = share / 2;
      apply();
      store.setTileSizes(this.wsId, t.id, [...sizes]);
    });
    return g;
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

  /** Series dropped on the empty worksheet (or its margin) become a new widget. */
  private bindDrop(area: HTMLElement) {
    dropTarget(area, {
      accepts: isSeries,
      drop: (p, e) => {
        if (!isSeries(p)) return;
        const w = store.addWidget(this.wsId, {}, p.data.fromWidget ? [] : p.data.items);
        if (w && p.data.fromWidget) store.moveSeries(p.data.fromWidget, this.wsId, w.id, e.altKey || e.ctrlKey);
      },
    });
  }
}

/** Smallest tile (px); a worksheet with more tiles than fit scrolls. */
const MIN_W = MIN_TILE.w;
const MIN_H = MIN_TILE.h;
const GUTTER = 6;
