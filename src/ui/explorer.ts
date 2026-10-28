import {
  ChartLine,
  ChevronRight,
  ChevronsDownUp,
  FilePlus,
  FileSpreadsheet,
  FileX,
  FolderOpen,
  Info,
  LayoutDashboard,
  Plus,
  Sparkles,
  Trash2,
} from 'lucide';
import { store } from '../store';
import type { SeriesDrag, SourceInfo } from '../types';
import { formatTime } from '../data/time';
import { columnMatcher, debounce, formatBytes, formatCount, formatValue, h, icon, iconButton } from '../util';
import { actions } from '../actions';
import { modal, showMenu } from './overlays';
import { RecentFiles } from './recentFiles';
import { draggable, seriesPayload } from './dnd';
import { baseName } from '../dialogs';

/** Rows rendered per source; wider sources are narrowed with the search. */
const MAX_ROWS = 500;

type Key = string; // `${sourceId}::${column}`
const key = (s: string, c: string) => `${s}::${c}`;
const unkey = (k: Key) => {
  const i = k.indexOf('::');
  return { sourceId: k.slice(0, i), column: k.slice(i + 2) };
};

export class Explorer {
  readonly el: HTMLElement;
  private tree: HTMLElement;
  private search: HTMLInputElement;
  private collapsed = new Set<string>();
  private selected = new Set<Key>();
  private anchor: Key | null = null;
  private visibleOrder: Key[] = [];

  constructor() {
    this.search = h('input', {
      type: 'search',
      placeholder: '열 검색 (정규식)…',
      class: 'search-input',
      'aria-label': '열 검색 (정규식)',
      spellcheck: false,
      title: '정규식으로 열을 거릅니다 (대소문자 무시). 예: temp|press, ^tag_00[1-3]\n소스 폴더를 끌면 검색된 열만 추가됩니다.',
    });
    this.search.addEventListener('input', debounce(() => this.render(), 120));
    this.tree = h('div', { class: 'nav-files-container', role: 'tree' });
    this.el = h(
      'div',
      { class: 'explorer' },
      h(
        'div',
        { class: 'nav-header' },
        h(
          'div',
          { class: 'nav-buttons-container' },
          iconButton(FolderOpen, 'CSV 열기', () => void actions.openCsv(), 'clickable-icon nav-action-button'),
          iconButton(Sparkles, '샘플 데이터 불러오기', () => void actions.loadSample(), 'clickable-icon nav-action-button'),
          iconButton(FilePlus, '새 워크시트', () => store.addWorksheet(), 'clickable-icon nav-action-button'),
          iconButton(
            ChevronsDownUp,
            '모두 접기/펼치기',
            () => {
              const ids = [...store.sources.keys()];
              if (ids.every((id) => this.collapsed.has(id))) this.collapsed.clear();
              else ids.forEach((id) => this.collapsed.add(id));
              this.render();
            },
            'clickable-icon nav-action-button',
          ),
        ),
        h('div', { class: 'search-input-container' }, this.search),
      ),
      h('div', { class: 'explorer-scroll' }, h('div', { class: 'section-title is-static is-first' }, h('span', {}, '데이터 소스')), this.tree, new RecentFiles().el),
    );
    store.on('sources', () => this.render());
    this.render();
  }

  private dragPayload(keys: Key[]): SeriesDrag {
    return { items: keys.map(unkey) };
  }

  private targetWidget() {
    const sel = store.ws.selectedWidgetId;
    const found = sel ? store.findWidget(sel) : null;
    return found && found.ws.id === store.active.id ? found : null;
  }

  private addToChart(keys: Key[], forceNew = false) {
    const items = keys.map(unkey);
    const t = this.targetWidget();
    if (t && !forceNew) store.addSeries(t.ws.id, t.w.id, items);
    else store.addWidget(store.active.id, {}, items);
  }

  private render() {
    const q = this.search.value.trim();
    const match = columnMatcher(q);
    this.search.classList.toggle('is-invalid', match.invalid);
    this.tree.replaceChildren();
    this.visibleOrder = [];
    const missing = store.missingSources();
    if (!store.sources.size && !missing.length) {
      this.tree.append(
        h(
          'div',
          { class: 'pane-empty' },
          h('p', {}, '불러온 데이터가 없습니다.'),
          h('p', { class: 'muted' }, 'CSV 파일을 창에 끌어다 놓거나 아래 버튼을 사용하세요. 파일 크기 제한은 없습니다.'),
          h('button', { class: 'mod-cta', type: 'button', onclick: (() => void actions.openCsv()) as EventListener }, icon(FolderOpen, 15), ' CSV 열기'),
          h('button', { type: 'button', onclick: (() => void actions.loadSample()) as EventListener }, icon(Sparkles, 15), ' 샘플 데이터'),
        ),
      );
      return;
    }
    for (const src of store.sources.values()) {
      let cols = src.columns.filter((c) => match.test(c.name));
      if (q && !cols.length && match.test(src.name)) cols = src.columns;
      if (q && !cols.length) continue;
      const open = q ? true : !this.collapsed.has(src.id);
      const folder = h(
        'div',
        { class: `tree-item-self nav-folder-title ${open ? '' : 'is-collapsed'} ${src.missingOriginal ? 'is-orphan' : ''}`, role: 'treeitem', 'aria-expanded': String(open), title: this.sourceTooltip(src) },
        h('div', { class: 'tree-item-icon collapse-icon' }, icon(ChevronRight, 14)),
        icon(src.missingOriginal ? FileX : FileSpreadsheet, 15, 'file-icon'),
        h('div', { class: 'tree-item-inner' }, src.name),
        h('div', { class: 'tree-item-flair' }, q ? `${formatCount(cols.length)} / ${formatCount(src.columns.length)}열` : `${formatCount(src.columns.length)}열`),
      );
      folder.addEventListener('click', () => {
        if (this.collapsed.has(src.id)) this.collapsed.delete(src.id);
        else this.collapsed.add(src.id);
        this.render();
      });
      // dragging the source brings the columns that match the search
      draggable(folder, () => seriesPayload(this.dragPayload(cols.map((c) => key(src.id, c.name)))), () => `${src.name} (${cols.length}개 열)`);
      folder.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        this.sourceMenu(src, e, q ? cols.map((c) => key(src.id, c.name)) : null);
      });
      const children = h('div', { class: 'tree-item-children', role: 'group' });
      if (open) {
        for (const c of cols.slice(0, MAX_ROWS)) {
          const k = key(src.id, c.name);
          this.visibleOrder.push(k);
          const row = h(
            'div',
            {
              class: `tree-item-self nav-file-title ${this.selected.has(k) ? 'is-active' : ''}`,
              role: 'treeitem',
              'aria-selected': String(this.selected.has(k)),
              title: `${c.name}\n최소 ${formatValue(c.min ?? NaN)} · 최대 ${formatValue(c.max ?? NaN)} · 평균 ${formatValue(c.mean ?? NaN)}\n더블클릭: 선택된 위젯에 추가 · 끌어서 차트에 놓기`,
            },
            icon(ChartLine, 14, 'file-icon'),
            h('div', { class: 'tree-item-inner' }, c.name),
          );
          row.addEventListener('click', (e) => this.onSelect(k, e));
          row.addEventListener('dblclick', () => this.addToChart([k]));
          draggable(
            row,
            () => {
              if (!this.selected.has(k)) {
                this.selected = new Set([k]);
                this.anchor = k;
                this.markSelection();
              }
              return seriesPayload(this.dragPayload([...this.selected]));
            },
            () => (this.selected.size > 1 ? `${this.selected.size}개 시리즈` : c.name),
          );
          row.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            if (!this.selected.has(k)) this.onSelect(k, e);
            this.columnMenu(e);
          });
          (row as HTMLElement & { _key?: Key })._key = k;
          children.append(row);
        }
        if (cols.length > MAX_ROWS) {
          for (const c of cols.slice(MAX_ROWS)) this.visibleOrder.push(key(src.id, c.name));
          children.append(h('div', { class: 'tree-item-self nav-file-title is-more' }, h('div', { class: 'tree-item-inner' }, `… ${formatCount(cols.length - MAX_ROWS)}개 열 더 — 검색으로 좁히세요`)));
        }
      }
      this.tree.append(h('div', { class: 'tree-item nav-folder' }, folder, children));
    }
    for (const m of missing) {
      if (q && !match.test(m.name)) continue;
      const row = h(
        'div',
        { class: 'tree-item-self nav-folder-title is-missing', title: `${m.name}\n데이터가 로드되지 않았습니다. 클릭해서 같은 CSV를 다시 선택하면 차트에 다시 연결됩니다.` },
        icon(FileX, 15, 'file-icon'),
        h('div', { class: 'tree-item-inner' }, m.name),
        h('div', { class: 'tree-item-flair' }, '다시 열기'),
      );
      row.addEventListener('click', () => void actions.openCsv());
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showMenu(
          [
            { title: 'CSV 다시 선택', icon: FolderOpen, onClick: () => void actions.openCsv() },
            { title: '목록과 차트에서 제거', icon: Trash2, danger: true, onClick: () => store.removeSource(m.id) },
          ],
          { x: e.clientX, y: e.clientY },
        );
      });
      this.tree.append(h('div', { class: 'tree-item nav-folder' }, row));
    }
  }

  private markSelection() {
    this.tree.querySelectorAll<HTMLElement & { _key?: Key }>('.nav-file-title').forEach((r) => {
      const on = !!r._key && this.selected.has(r._key);
      r.classList.toggle('is-active', on);
      r.setAttribute('aria-selected', String(on));
    });
  }

  private onSelect(k: Key, e: MouseEvent) {
    if (e.shiftKey && this.anchor) {
      const a = this.visibleOrder.indexOf(this.anchor);
      const b = this.visibleOrder.indexOf(k);
      if (a >= 0 && b >= 0) {
        this.selected = new Set(this.visibleOrder.slice(Math.min(a, b), Math.max(a, b) + 1));
      }
    } else if (e.ctrlKey || e.metaKey) {
      if (this.selected.has(k)) this.selected.delete(k);
      else this.selected.add(k);
      this.anchor = k;
    } else {
      this.selected = new Set([k]);
      this.anchor = k;
    }
    this.markSelection();
  }

  private sourceTooltip(src: SourceInfo) {
    return `${src.name}\n${formatCount(src.rows)}행 · ${src.columns.length}열 · 파일 ${formatBytes(src.size)} · 메모리 ${formatBytes(src.bytes)}\n${formatTime(src.start)} → ${formatTime(src.end)}${src.missingOriginal ? '\n⚠ 원본 CSV를 찾을 수 없어 워크스페이스에 저장된 데이터를 사용 중' : ''}`;
  }

  private columnMenu(e: MouseEvent) {
    const keys = [...this.selected];
    const t = this.targetWidget();
    showMenu(
      [
        { title: t ? `"${t.w.title}" 에 추가` : '선택된 위젯에 추가', icon: Plus, disabled: !t, onClick: () => this.addToChart(keys) },
        { title: '새 위젯으로 추가', icon: ChartLine, onClick: () => this.addToChart(keys, true) },
        {
          title: '새 워크시트에 추가',
          icon: FilePlus,
          onClick: () => {
            const ws = store.addWorksheet();
            store.addWidget(ws.id, { w: 12, h: 6 }, keys.map(unkey));
          },
        },
        {
          title: '각각 별도 위젯으로',
          icon: LayoutDashboard,
          disabled: keys.length < 2,
          onClick: () => keys.forEach((k, i) => store.addWidget(store.active.id, { x: (i % 2) * 6, w: 6, h: 4 }, [unkey(k)])),
        },
      ],
      { x: e.clientX, y: e.clientY },
    );
  }

  private sourceMenu(src: SourceInfo, e: MouseEvent, matched: Key[] | null) {
    const selectMatched = () => {
      this.selected = new Set(matched ?? []);
      this.anchor = matched?.[0] ?? null;
      this.markSelection();
    };
    showMenu(
      [
        ...(matched
          ? [
              { title: `검색된 ${formatCount(matched.length)}개 열 선택`, icon: ChartLine, onClick: selectMatched },
              { title: `검색된 열로 새 차트${matched.length > 64 ? ' (처음 64개)' : ''}`, icon: Plus, onClick: () => this.addToChart(matched, true) },
            ]
          : [{ title: '모든 열을 차트로 (처음 8개)', icon: ChartLine, onClick: () => actions.chartSource(src) }]),
        {
          title: '새 워크시트에서 열기',
          icon: FilePlus,
          onClick: () => {
            store.addWorksheet(src.name.replace(/\.(csv|tsv|txt)$/i, ''));
            actions.chartSource(src);
          },
        },
        { title: '정보', icon: Info, onClick: () => this.info(src) },
        { separator: true, title: '' },
        {
          title: '데이터 소스 제거',
          icon: Trash2,
          danger: true,
          onClick: () => void actions.removeSource(src.id),
        },
      ],
      { x: e.clientX, y: e.clientY },
    );
  }

  private info(src: SourceInfo) {
    const m = modal(baseName(src.name), { width: 640 });
    const t = h('table', { class: 'info-table' });
    const rows: [string, string][] = [
      ['파일', src.name + (src.missingOriginal ? ' (원본 없음 — 저장된 데이터 사용)' : '')],
      ['행 수', formatCount(src.rows)],
      ['파일 크기', formatBytes(src.size)],
      ['메모리', `${formatBytes(src.bytes)}${src.compact ? ' (32-bit 값)' : ''}`],
      ['시간 열', `${src.timeColumn} (${src.import.timeFormat})`],
      ['시작', formatTime(src.start, true)],
      ['끝', formatTime(src.end, true)],
      ['처리한 시각', new Date(src.importedAt).toLocaleString()],
    ];
    rows.forEach(([a, b]) => t.append(h('tr', {}, h('th', {}, a), h('td', {}, b))));
    const ct = h('table', { class: 'info-table cols' }, h('tr', {}, h('th', {}, '열'), h('th', {}, '최소'), h('th', {}, '최대'), h('th', {}, '평균')));
    src.columns.forEach((c) => ct.append(h('tr', {}, h('td', {}, c.name), h('td', { class: 'num' }, formatValue(c.min ?? NaN)), h('td', { class: 'num' }, formatValue(c.max ?? NaN)), h('td', { class: 'num' }, formatValue(c.mean ?? NaN)))));
    m.content.append(t, h('h4', {}, '열 통계'), ct);
  }
}
