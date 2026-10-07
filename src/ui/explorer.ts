import {
  ChartLine,
  ChevronRight,
  ChevronsDownUp,
  FilePlus,
  FileSpreadsheet,
  FolderOpen,
  Info,
  LayoutDashboard,
  Plus,
  Sparkles,
  Trash2,
} from 'lucide';
import { store } from '../store';
import { DRAG_MIME, type DataSource, type SeriesDrag } from '../types';
import { formatTime } from '../data/time';
import { formatBytes, formatCount, formatValue, h, icon, iconButton } from '../util';
import { actions } from '../actions';
import { confirmDialog, modal, showMenu } from './overlays';

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
    this.search = h('input', { type: 'search', placeholder: '시리즈 검색…', class: 'search-input', 'aria-label': '시리즈 검색' });
    this.search.addEventListener('input', () => this.render());
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
      this.tree,
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
    const q = this.search.value.trim().toLowerCase();
    this.tree.replaceChildren();
    this.visibleOrder = [];
    if (!store.sources.size) {
      this.tree.append(
        h(
          'div',
          { class: 'pane-empty' },
          h('p', {}, '불러온 데이터가 없습니다.'),
          h('p', { class: 'muted' }, 'CSV 파일을 창에 끌어다 놓거나 아래 버튼을 사용하세요.'),
          h('button', { class: 'mod-cta', type: 'button', onclick: (() => void actions.openCsv()) as EventListener }, icon(FolderOpen, 15), ' CSV 열기'),
          h('button', { type: 'button', onclick: (() => void actions.loadSample()) as EventListener }, icon(Sparkles, 15), ' 샘플 데이터'),
        ),
      );
      return;
    }
    for (const src of store.sources.values()) {
      const cols = src.columns.filter((c) => !q || c.name.toLowerCase().includes(q) || src.name.toLowerCase().includes(q));
      if (q && !cols.length) continue;
      const open = q ? true : !this.collapsed.has(src.id);
      const folder = h(
        'div',
        { class: `tree-item-self nav-folder-title ${open ? '' : 'is-collapsed'}`, draggable: 'true', role: 'treeitem', 'aria-expanded': String(open), title: this.sourceTooltip(src) },
        h('div', { class: 'tree-item-icon collapse-icon' }, icon(ChevronRight, 14)),
        icon(FileSpreadsheet, 15, 'file-icon'),
        h('div', { class: 'tree-item-inner' }, src.name),
        h('div', { class: 'tree-item-flair' }, formatCount(src.time.length)),
      );
      folder.addEventListener('click', () => {
        if (this.collapsed.has(src.id)) this.collapsed.delete(src.id);
        else this.collapsed.add(src.id);
        this.render();
      });
      folder.addEventListener('dragstart', (e) => {
        e.dataTransfer!.setData(DRAG_MIME, JSON.stringify(this.dragPayload(src.columns.map((c) => key(src.id, c.name)))));
        e.dataTransfer!.effectAllowed = 'copy';
      });
      folder.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        this.sourceMenu(src, e);
      });
      const children = h('div', { class: 'tree-item-children', role: 'group' });
      if (open)
        for (const c of cols) {
          const k = key(src.id, c.name);
          this.visibleOrder.push(k);
          const row = h(
            'div',
            {
              class: `tree-item-self nav-file-title ${this.selected.has(k) ? 'is-active' : ''}`,
              draggable: 'true',
              role: 'treeitem',
              'aria-selected': String(this.selected.has(k)),
              title: `${c.name}\n최소 ${formatValue(c.min)} · 최대 ${formatValue(c.max)} · 평균 ${formatValue(c.mean)}\n더블클릭: 선택된 위젯에 추가`,
            },
            icon(ChartLine, 14, 'file-icon'),
            h('div', { class: 'tree-item-inner' }, c.name),
          );
          row.addEventListener('click', (e) => this.onSelect(k, e));
          row.addEventListener('dblclick', () => this.addToChart([k]));
          row.addEventListener('dragstart', (e) => {
            if (!this.selected.has(k)) {
              this.selected = new Set([k]);
              this.anchor = k;
              this.markSelection();
            }
            e.dataTransfer!.setData(DRAG_MIME, JSON.stringify(this.dragPayload([...this.selected])));
            e.dataTransfer!.effectAllowed = 'copy';
            const n = this.selected.size;
            if (n > 1) {
              const ghost = h('div', { class: 'drag-ghost' }, `${n}개 시리즈`);
              document.body.append(ghost);
              e.dataTransfer!.setDragImage(ghost, -8, -8);
              setTimeout(() => ghost.remove());
            }
          });
          row.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            if (!this.selected.has(k)) this.onSelect(k, e);
            this.columnMenu(e);
          });
          (row as HTMLElement & { _key?: Key })._key = k;
          children.append(row);
        }
      this.tree.append(h('div', { class: 'tree-item nav-folder' }, folder, children));
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

  private sourceTooltip(src: DataSource) {
    return `${src.name}\n${formatCount(src.time.length)}행 · ${src.columns.length}열 · ${formatBytes(src.size)}\n${formatTime(src.time[0])} → ${formatTime(src.time[src.time.length - 1])}`;
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

  private sourceMenu(src: DataSource, e: MouseEvent) {
    showMenu(
      [
        { title: '모든 열을 차트로', icon: ChartLine, onClick: () => actions.chartSource(src) },
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
          onClick: async () => {
            if (await confirmDialog('데이터 소스 제거', `"${src.name}" 을(를) 제거하면 이 데이터를 사용하는 모든 시리즈가 차트에서 빠집니다.`, '제거'))
              store.removeSource(src.id);
          },
        },
      ],
      { x: e.clientX, y: e.clientY },
    );
  }

  private info(src: DataSource) {
    const m = modal(src.name, { width: 640 });
    const t = h('table', { class: 'info-table' });
    const rows: [string, string][] = [
      ['행 수', formatCount(src.time.length)],
      ['파일 크기', formatBytes(src.size)],
      ['시간 열', src.timeColumn],
      ['시작', formatTime(src.time[0], true)],
      ['끝', formatTime(src.time[src.time.length - 1], true)],
      ['불러온 시각', new Date(src.importedAt).toLocaleString()],
    ];
    rows.forEach(([a, b]) => t.append(h('tr', {}, h('th', {}, a), h('td', {}, b))));
    const ct = h('table', { class: 'info-table cols' }, h('tr', {}, h('th', {}, '열'), h('th', {}, '최소'), h('th', {}, '최대'), h('th', {}, '평균')));
    src.columns.forEach((c) => ct.append(h('tr', {}, h('td', {}, c.name), h('td', { class: 'num' }, formatValue(c.min)), h('td', { class: 'num' }, formatValue(c.max)), h('td', { class: 'num' }, formatValue(c.mean)))));
    m.content.append(t, h('h4', {}, '열 통계'), ct);
  }
}
