import {
  CircleHelp,
  Command as CommandIcon,
  FilePlus,
  FolderOpen,
  Moon,
  PanelLeft,
  PanelRight,
  Save,
  SlidersHorizontal,
  Sparkles,
  Sun,
  Files,
  LayoutDashboard,
} from 'lucide';
import { store } from '../store';
import { actions } from '../actions';
import { project } from '../project';
import { engine, isDesktop } from '../engine';

async function setWindowTitle(t: string) {
  if (!isDesktop) return;
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  await getCurrentWindow().setTitle(t).catch(() => undefined);
}
import { formatTime } from '../data/time';
import { clamp, formatBytes, formatCount, h, icon, iconButton } from '../util';
import { ChartWidget } from './chartWidget';
import { openCommandPalette, type Command } from './commandPalette';
import { Explorer } from './explorer';
import { modal, notice } from './overlays';
import { PropertiesPanel } from './properties';
import { TabBar } from './tabs';
import { WorksheetView } from './worksheetView';

export class App {
  private view: WorksheetView | null = null;
  private root: HTMLElement;
  private leftSplit: HTMLElement;
  private rightSplit: HTMLElement;
  private leafHost: HTMLElement;
  private themeBtn: HTMLButtonElement;
  private status = {
    file: h('div', { class: 'status-bar-item mod-file' }),
    sources: h('div', { class: 'status-bar-item' }),
    cursor: h('div', { class: 'status-bar-item' }),
    render: h('div', { class: 'status-bar-item' }),
  };
  private renderStats = new Map<string, { raw: number; shown: number; ms: number }>();

  constructor(mount: HTMLElement) {
    const explorer = new Explorer();
    const props = new PropertiesPanel();
    props.getView = () => this.view;
    const tabs = new TabBar();

    this.themeBtn = iconButton(Moon, '테마 전환', () => actions.toggleTheme(), 'clickable-icon side-dock-ribbon-action');
    const ribbonBtn = (ic: Parameters<typeof iconButton>[0], label: string, fn: () => void) => iconButton(ic, label, fn, 'clickable-icon side-dock-ribbon-action', 18);
    const ribbon = h(
      'div',
      { class: 'workspace-ribbon side-dock-ribbon mod-left' },
      h(
        'div',
        { class: 'side-dock-actions' },
        ribbonBtn(PanelLeft, '왼쪽 사이드바 (Ctrl+[)', () => actions.toggleLeft()),
        ribbonBtn(FolderOpen, 'CSV 열기 (Ctrl+Shift+O)', () => void actions.openCsv()),
        ribbonBtn(Sparkles, '샘플 데이터', () => void actions.loadSample()),
        ribbonBtn(FilePlus, '새 워크시트 (Alt+T)', () => store.addWorksheet()),
        ribbonBtn(CommandIcon, '명령 팔레트 (Ctrl+P)', () => this.palette()),
        ribbonBtn(LayoutDashboard, '워크스페이스 열기 (Ctrl+O)', () => void actions.openWorkspace()),
        ribbonBtn(Save, '워크스페이스 저장 (Ctrl+S)', () => void actions.saveWorkspace()),
      ),
      h('div', { class: 'side-dock-settings' }, this.themeBtn, ribbonBtn(CircleHelp, '도움말 / 단축키', () => this.help())),
    );

    const sideHeader = (ic: Parameters<typeof icon>[0], label: string, toggleFn: () => void, side: 'left' | 'right') =>
      h(
        'div',
        { class: 'workspace-tab-header-container mod-sidebar' },
        h('div', { class: 'workspace-tab-header is-active' }, h('div', { class: 'workspace-tab-header-inner' }, icon(ic, 16), h('span', { class: 'sidebar-tab-label' }, label))),
        h('div', { class: 'workspace-tab-header-spacer' }),
        iconButton(side === 'left' ? PanelLeft : PanelRight, '사이드바 닫기', toggleFn),
      );

    this.leftSplit = h(
      'div',
      { class: 'workspace-split mod-left-split' },
      sideHeader(Files, '탐색기', () => actions.toggleLeft(), 'left'),
      h('div', { class: 'workspace-leaf-content' }, explorer.el),
      this.resizer('left'),
    );
    this.rightSplit = h(
      'div',
      { class: 'workspace-split mod-right-split' },
      this.resizer('right'),
      sideHeader(SlidersHorizontal, '속성', () => actions.toggleRight(), 'right'),
      h('div', { class: 'workspace-leaf-content' }, props.el),
    );
    this.leafHost = h('div', { class: 'workspace-tabs-content' });
    const rightToggle = iconButton(PanelRight, '오른쪽 사이드바 (Ctrl+])', () => actions.toggleRight(), 'clickable-icon tab-bar-right-toggle');
    tabs.el.append(rightToggle);
    const center = h('div', { class: 'workspace-split mod-root' }, tabs.el, this.leafHost);

    const statusBar = h('div', { class: 'status-bar' }, this.status.file, h('div', { class: 'status-bar-spacer' }), this.status.cursor, this.status.render, this.status.sources);
    this.root = h(
      'div',
      { class: 'app-container' },
      h('div', { class: 'horizontal-main-container' }, ribbon, this.leftSplit, center, this.rightSplit),
      statusBar,
      h('div', { class: 'file-drop-overlay' }, h('div', {}, icon(FolderOpen, 36), h('div', {}, 'CSV 파일을 놓아 불러오기'))),
    );
    mount.replaceChildren(this.root);

    ChartWidget.onRendered = (_ws, id, raw, shown, ms) => {
      this.renderStats.set(id, { raw, shown, ms });
      this.updateStatus();
    };
    store.on('active', () => this.mountView());
    store.on('settings', () => this.applySettings());
    store.on('sources', () => this.updateStatus());
    store.on('widgets', () => this.updateStatus());
    store.on('project', () => this.updateFileStatus());
    this.updateFileStatus();
    store.on('cursor', (c) => {
      this.status.cursor.textContent = c.x === null ? '' : `커서 ${formatTime(c.x, true)}`;
    });
    this.applySettings();
    this.mountView();
    this.bindKeys();
    this.bindFileDrop();
  }

  private mountView() {
    this.view?.destroy();
    this.renderStats.clear();
    this.view = new WorksheetView(store.active.id);
    this.leafHost.replaceChildren(this.view.el);
    this.updateStatus();
  }

  private applySettings() {
    const s = store.ws.settings;
    document.body.classList.toggle('theme-dark', s.theme === 'dark');
    document.body.classList.toggle('theme-light', s.theme === 'light');
    document.documentElement.dataset.theme = s.theme;
    this.themeBtn.replaceChildren(icon(s.theme === 'dark' ? Sun : Moon, 18));
    this.leftSplit.classList.toggle('is-collapsed', !s.leftOpen);
    this.rightSplit.classList.toggle('is-collapsed', !s.rightOpen);
    this.leftSplit.style.width = s.leftOpen ? `${s.leftWidth}px` : '0px';
    this.rightSplit.style.width = s.rightOpen ? `${s.rightWidth}px` : '0px';
  }

  private resizer(side: 'left' | 'right') {
    const r = h('div', { class: `workspace-leaf-resize-handle mod-${side}` });
    r.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      r.setPointerCapture(e.pointerId);
      const startX = e.clientX;
      const startW = side === 'left' ? store.ws.settings.leftWidth : store.ws.settings.rightWidth;
      const split = side === 'left' ? this.leftSplit : this.rightSplit;
      split.classList.add('is-resizing');
      const move = (ev: PointerEvent) => {
        const d = ev.clientX - startX;
        const w = clamp(side === 'left' ? startW + d : startW - d, 180, 640);
        split.style.width = `${w}px`;
      };
      const up = () => {
        r.removeEventListener('pointermove', move);
        split.classList.remove('is-resizing');
        const w = split.getBoundingClientRect().width;
        store.updateSettings(side === 'left' ? { leftWidth: w } : { rightWidth: w });
      };
      r.addEventListener('pointermove', move);
      r.addEventListener('pointerup', up, { once: true });
    });
    return r;
  }

  private updateFileStatus() {
    const label = project.untitled ? 'Untitled (자동 보관)' : (project.path ?? '');
    this.status.file.textContent = `${label}${project.saving ? ' · 저장 중…' : project.dirty ? ' ●' : ''}`;
    this.status.file.title = project.dirty ? '저장되지 않은 변경 (Ctrl+S)' : project.untitled ? '작업은 앱 데이터 폴더에 자동 보관됩니다. Ctrl+S로 원하는 위치에 저장하세요.' : '';
    const title = `${project.title}${project.dirty ? ' •' : ''} — Chronos Vault`;
    document.title = title;
    void setWindowTitle(title);
  }

  private updateStatus() {
    const n = store.sources.size;
    const rows = [...store.sources.values()].reduce((a, s) => a + s.rows * s.columns.length, 0);
    const bytes = [...store.sources.values()].reduce((a, s) => a + s.bytes, 0);
    this.status.sources.textContent = `${n}개 소스 · ${formatCount(rows)} 포인트 · ${formatBytes(bytes)}`;
    let raw = 0;
    let shown = 0;
    let ms = 0;
    this.renderStats.forEach((v) => {
      raw += v.raw;
      shown += v.shown;
      ms = Math.max(ms, v.ms);
    });
    this.status.render.textContent = this.renderStats.size ? `렌더 ${formatCount(raw)} → ${formatCount(shown)} pts · ${ms.toFixed(0)} ms` : '';
  }

  commands(): Command[] {
    const v = () => this.view;
    const ws = () => store.active.id;
    const cmds: Command[] = [
      { id: 'open', name: 'CSV 파일 열기', hotkey: 'Ctrl+O', run: () => void actions.openCsv() },
      { id: 'sample', name: '샘플 데이터 불러오기', run: () => void actions.loadSample() },
      { id: 'new-ws', name: '새 워크시트', hotkey: 'Alt+T', run: () => store.addWorksheet() },
      { id: 'dup-ws', name: '현재 워크시트 복제', run: () => store.duplicateWorksheet(ws()) },
      { id: 'close-ws', name: '현재 워크시트 닫기', run: () => store.removeWorksheet(ws()) },
      { id: 'add-widget', name: '빈 차트 위젯 추가', run: () => store.addWidget(ws()) },
      { id: 'all', name: '시간 범위: 전체 보기', hotkey: 'A', run: () => v()?.applyPreset(null) },
      { id: 'back', name: '시간 범위: 뒤로', hotkey: 'Alt+←', run: () => store.back(ws()) },
      { id: 'fwd', name: '시간 범위: 앞으로', hotkey: 'Alt+→', run: () => store.forward(ws()) },
      { id: 'zoom-in', name: '시간 범위: 확대', hotkey: '+', run: () => v()?.zoom(0.5) },
      { id: 'zoom-out', name: '시간 범위: 축소', hotkey: '-', run: () => v()?.zoom(2) },
      { id: 'pan-l', name: '시간 범위: 왼쪽으로 이동', hotkey: '←', run: () => v()?.pan(-0.25) },
      { id: 'pan-r', name: '시간 범위: 오른쪽으로 이동', hotkey: '→', run: () => v()?.pan(0.25) },
      { id: 'last-1h', name: '시간 범위: 마지막 1시간', run: () => v()?.applyPreset(3600e3) },
      { id: 'last-24h', name: '시간 범위: 마지막 24시간', run: () => v()?.applyPreset(86400e3) },
      { id: 'last-7d', name: '시간 범위: 마지막 7일', run: () => v()?.applyPreset(7 * 86400e3) },
      { id: 'crosshair', name: '크로스헤어 동기화 토글', run: () => store.updateWorksheet(ws(), { crosshair: !store.active.crosshair }) },
      { id: 'drag', name: '드래그 모드 전환 (줌/이동)', run: () => store.updateSettings({ dragMode: store.ws.settings.dragMode === 'zoom' ? 'pan' : 'zoom' }) },
      { id: 'zoomy', name: 'Y축 줌 허용 토글', run: () => store.updateSettings({ zoomY: !store.ws.settings.zoomY }) },
      { id: 'theme', name: '테마 전환 (다크/라이트)', run: () => actions.toggleTheme() },
      { id: 'left', name: '왼쪽 사이드바 토글', hotkey: 'Ctrl+[', run: () => actions.toggleLeft() },
      { id: 'right', name: '오른쪽 사이드바 토글', hotkey: 'Ctrl+]', run: () => actions.toggleRight() },
      { id: 'save', name: '워크스페이스 저장 (.chronos, 전처리 포함)', hotkey: 'Ctrl+S', run: () => void actions.saveWorkspace() },
      { id: 'save-as', name: '워크스페이스 다른 이름으로 저장', hotkey: 'Ctrl+Shift+S', run: () => void actions.saveWorkspaceAs() },
      { id: 'load', name: '워크스페이스 열기', run: () => void actions.openWorkspace() },
      { id: 'new', name: '새 워크스페이스', run: () => void actions.newWorkspace() },
      { id: 'help', name: '도움말 / 단축키', run: () => this.help() },
      { id: 'log', name: '진단 로그 파일 위치 열기', run: () => void this.revealLog() },
      ...(project.path && !project.untitled ? [{ id: 'reveal-ws', name: '워크스페이스 파일 위치 열기', run: () => void engine.reveal(project.path!) }] : []),
    ];
    const sel = store.ws.selectedWidgetId;
    if (sel && v()?.widget(sel)) {
      const w = v()!.widget(sel)!;
      cmds.push(
        { id: 'w-snap', name: '선택 위젯: 스냅샷 PNG', run: () => void w.snapshot() },
        { id: 'w-csv', name: '선택 위젯: 보이는 구간 CSV 내보내기', run: () => w.exportCsv() },
        { id: 'w-max', name: '선택 위젯: 최대화 토글', hotkey: 'F', run: () => w.toggleMaximize() },
        { id: 'w-dup', name: '선택 위젯: 복제', run: () => store.duplicateWidget(ws(), sel) },
        { id: 'w-del', name: '선택 위젯: 삭제', hotkey: 'Del', run: () => store.removeWidget(ws(), sel) },
      );
    }
    for (const s of store.ws.worksheets) cmds.push({ id: `go-${s.id}`, name: `워크시트로 이동: ${s.name}`, run: () => store.setActive(s.id) });
    for (const src of store.sources.values())
      cmds.push({ id: `chart-${src.id}`, name: `차트 생성: ${src.name} (모든 열)`, run: () => actions.chartSource(src) });
    return cmds;
  }

  palette() {
    openCommandPalette(() => this.commands());
  }

  private async revealLog() {
    const info = await engine.appInfo();
    if (info.logPath) await engine.reveal(info.logPath).catch((e: Error) => notice(`${info.logPath}\n${e.message}`, 8000));
  }

  private help() {
    const m = modal('도움말 · 단축키', { width: 620 });
    const keys: [string, string][] = [
      ['Ctrl+P', '명령 팔레트'],
      ['Ctrl+O', '워크스페이스(.chronos) 열기'],
      ['Ctrl+Shift+O', 'CSV 열기'],
      ['Ctrl+S / Ctrl+Shift+S', '저장 / 다른 이름으로 저장'],
      ['Ctrl+N', '새 워크스페이스'],
      ['Alt+T', '새 워크시트'],
      ['Ctrl+[ / Ctrl+]', '왼쪽 / 오른쪽 사이드바'],
      ['← / →', '시간축 이동'],
      ['+ / -', '시간축 확대 / 축소'],
      ['A', '전체 보기'],
      ['Alt+← / Alt+→', '줌 기록 뒤로 / 앞으로'],
      ['F', '선택 위젯 최대화'],
      ['Delete', '선택 위젯 삭제'],
      ['Esc', '선택 해제 / 최대화 해제'],
    ];
    const t = h('table', { class: 'info-table' });
    keys.forEach(([k, d]) => t.append(h('tr', {}, h('th', {}, h('kbd', {}, k)), h('td', {}, d))));
    m.content.append(
      h('h4', {}, '사용 방법'),
      h(
        'ul',
        { class: 'help-list' },
        h('li', {}, 'CSV를 창에 끌어다 놓거나 CSV 열기(Ctrl+Shift+O)로 불러옵니다. 시간 열·형식·구분자는 자동 감지되며 파일 크기 제한이 없습니다.'),
        h('li', {}, '워크스페이스(.chronos)에는 레이아웃, CSV 경로(절대 + 워크스페이스 기준 상대), 전처리 결과(파싱된 값 + 인덱스)가 함께 저장됩니다. 다시 열면 CSV가 그대로면 저장된 전처리를 바로 쓰고, 바뀌었으면 같은 설정으로 자동 재처리합니다.'),
        h('li', {}, '저장하기 전의 작업은 "Untitled"로 앱 데이터 폴더에 자동 보관되어, 다음 실행 때 그대로 복원됩니다. .chronos 파일을 더블클릭해도 열립니다.'),
        h('li', {}, '탐색기에서 열(시리즈)을 위젯 위로 끌면 추가, 빈 공간으로 끌면 새 위젯이 생성됩니다. Ctrl/Shift로 다중 선택.'),
        h('li', {}, '범례 행을 다른 위젯으로 끌면 시리즈가 이동합니다 (Alt/Ctrl 누르면 복사).'),
        h('li', {}, '위젯 헤더를 끌어 배치를, 모서리를 끌어 크기를 조절합니다.'),
        h('li', {}, '차트 위 드래그 = 구간 확대, 휠 = 줌, 더블클릭 = 줌 초기화. 연동된 위젯은 시간축을 공유합니다.'),
        h('li', {}, '보이는 구간만 M4 다운샘플링해 그리므로 수천만 포인트도 빠르게 탐색할 수 있습니다. Shift+드래그 또는 가운데 버튼 드래그로 이동합니다.'),
      ),
      h('h4', {}, '단축키'),
      t,
    );
  }

  private bindKeys() {
    document.addEventListener('keydown', (e) => {
      const target = e.target as HTMLElement;
      const typing = target.closest('input, textarea, select, [contenteditable="true"]');
      const mod = e.ctrlKey || e.metaKey;
      const ws = store.active.id;
      if (mod && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        this.palette();
        return;
      }
      if (mod && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        void (e.shiftKey ? actions.openCsv() : actions.openWorkspace());
        return;
      }
      if (mod && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        void actions.newWorkspace();
        return;
      }
      if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void (e.shiftKey ? actions.saveWorkspaceAs() : actions.saveWorkspace());
        return;
      }
      if (e.altKey && !mod && e.code === 'KeyT') {
        e.preventDefault();
        store.addWorksheet();
        return;
      }
      if (mod && e.key === '[') {
        e.preventDefault();
        actions.toggleLeft();
        return;
      }
      if (mod && e.key === ']') {
        e.preventDefault();
        actions.toggleRight();
        return;
      }
      if (typing || mod || document.querySelector('.modal-container')) return;
      const v = this.view;
      const sel = store.ws.selectedWidgetId;
      if (e.altKey && e.key === 'ArrowLeft') store.back(ws);
      else if (e.altKey && e.key === 'ArrowRight') store.forward(ws);
      else if (e.key === 'ArrowLeft') v?.pan(-0.25);
      else if (e.key === 'ArrowRight') v?.pan(0.25);
      else if (e.key === '+' || e.key === '=') v?.zoom(0.5);
      else if (e.key === '-') v?.zoom(2);
      else if (e.key === 'a' || e.key === 'A') v?.applyPreset(null);
      else if ((e.key === 'f' || e.key === 'F') && sel) v?.widget(sel)?.toggleMaximize();
      else if ((e.key === 'Delete' || e.key === 'Backspace') && sel) store.removeWidget(ws, sel);
      else if (e.key === 'Escape') {
        const w = sel ? v?.widget(sel) : null;
        if (w?.isMaximized) w.toggleMaximize();
        else store.select(null);
      } else return;
      e.preventDefault();
    });
  }

  /** OS file drops: the desktop webview reports real paths. */
  private bindFileDrop() {
    if (!isDesktop) return;
    void import('@tauri-apps/api/webview').then(({ getCurrentWebview }) =>
      getCurrentWebview().onDragDropEvent((e) => {
        const t = e.payload.type;
        this.root.classList.toggle('is-file-dragging', t === 'enter' || t === 'over');
        if (t === 'drop') void actions.openDropped(e.payload.paths);
      }),
    );
  }
}
