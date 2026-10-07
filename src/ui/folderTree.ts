import { ChevronRight, FileChartColumn, FileSpreadsheet, Folder, FolderOpen, FolderX, LayoutDashboard, RefreshCw, Save } from 'lucide';
import { fsaSupported, inFrame, listDir, type DirEntry } from '../fs/fsa';
import { project } from '../project';
import { store } from '../store';
import { actions } from '../actions';
import { h, icon, iconButton } from '../util';
import { showMenu } from './overlays';

const SHOWN = /\.(csv|tsv|txt|chronos)$/i;

/** Obsidian-style file tree of the work folder (CSV + .chronos files). */
export class FolderTree {
  readonly el: HTMLElement;
  private body: HTMLElement;
  private open = new Set<string>(['']);
  private cache = new Map<string, DirEntry[]>();
  private collapsed = false;

  constructor() {
    this.body = h('div', { class: 'folder-tree' });
    this.el = h('div', { class: 'folder-section' }, this.body);
    store.on('project', () => {
      this.cache.clear();
      void this.render();
    });
    store.on('sources', () => void this.render());
    void this.render();
  }

  private async entries(dir: FileSystemDirectoryHandle, path: string): Promise<DirEntry[]> {
    if (!this.cache.has(path)) {
      try {
        const all = await listDir(dir, path);
        this.cache.set(path, all.filter((e) => e.kind === 'directory' ? !e.name.startsWith('.') : SHOWN.test(e.name)));
      } catch {
        this.cache.set(path, []);
      }
    }
    return this.cache.get(path)!;
  }

  private async render() {
    const title = h(
      'div',
      { class: `section-title ${this.collapsed ? 'is-collapsed' : ''}` },
      h('div', { class: 'tree-item-icon collapse-icon' }, icon(ChevronRight, 14)),
      h('span', {}, '작업 폴더'),
    );
    title.addEventListener('click', () => {
      this.collapsed = !this.collapsed;
      void this.render();
    });
    const out: HTMLElement[] = [title];
    if (this.collapsed) {
      this.body.replaceChildren(...out);
      return;
    }
    if (!fsaSupported) {
      out.push(
        h(
          'div',
          { class: 'folder-note' },
          inFrame
            ? '이 미리보기 페이지에서는 폴더 접근이 막혀 있습니다. 불러온 데이터와 레이아웃은 이 브라우저에 자동 보관됩니다. 작업 폴더 기능은 단일 HTML 파일 버전을 Chrome / Edge에서 열어 사용하세요.'
            : '폴더 연결(상대경로 자동 로드)은 Chrome / Edge에서 지원됩니다. 이 브라우저에서는 워크스페이스 파일에 데이터만 저장됩니다.',
        ),
      );
      this.body.replaceChildren(...out);
      return;
    }
    if (!project.root) {
      if (project.pendingRoot) {
        out.push(
          h('button', { class: 'mod-cta folder-btn', type: 'button', onclick: (() => void project.reconnect()) as EventListener }, icon(FolderOpen, 15), ` "${project.pendingRoot.name}" 다시 연결`),
        );
      }
      out.push(
        h('button', { class: 'folder-btn', type: 'button', onclick: (() => void project.openFolder()) as EventListener }, icon(Folder, 15), ' 작업 폴더 열기'),
        h('div', { class: 'folder-note' }, '폴더를 열면 워크스페이스(.chronos)에 CSV 상대경로와 전처리 결과가 함께 저장되고, 다시 열 때 자동으로 로드됩니다.'),
      );
      this.body.replaceChildren(...out);
      return;
    }
    const root = project.root;
    const head = h(
      'div',
      { class: 'tree-item-self nav-folder-title folder-root', title: root.name },
      icon(FolderOpen, 15, 'file-icon'),
      h('div', { class: 'tree-item-inner' }, root.name),
      iconButton(Save, '워크스페이스 저장 (Ctrl+S)', () => void project.save()),
      iconButton(RefreshCw, '새로고침', () => {
        this.cache.clear();
        void this.render();
      }),
      iconButton(FolderX, '폴더 닫기', () => void project.closeFolder()),
    );
    out.push(head);
    const tree = h('div', { class: 'tree-item-children' });
    await this.renderDir(root, '', tree);
    out.push(tree);
    this.body.replaceChildren(...out);
  }

  private async renderDir(dir: FileSystemDirectoryHandle, path: string, into: HTMLElement) {
    const list = await this.entries(dir, path);
    if (!list.length && !path) into.append(h('div', { class: 'folder-note' }, 'CSV 또는 .chronos 파일이 없습니다.'));
    for (const e of list) {
      if (e.kind === 'directory') {
        const isOpen = this.open.has(e.path);
        const row = h(
          'div',
          { class: `tree-item-self nav-folder-title ${isOpen ? '' : 'is-collapsed'}` },
          h('div', { class: 'tree-item-icon collapse-icon' }, icon(ChevronRight, 14)),
          h('div', { class: 'tree-item-inner' }, e.name),
        );
        row.addEventListener('click', () => {
          if (isOpen) this.open.delete(e.path);
          else this.open.add(e.path);
          void this.render();
        });
        into.append(row);
        if (isOpen) {
          const kids = h('div', { class: 'tree-item-children' });
          into.append(kids);
          await this.renderDir(e.handle as FileSystemDirectoryHandle, e.path, kids);
        }
        continue;
      }
      const isWs = /\.chronos$/i.test(e.name);
      const loaded = !isWs && !!store.sourceByPath(e.path);
      const current = isWs && project.file?.path === e.path;
      const row = h(
        'div',
        {
          class: `tree-item-self nav-file-title ${current ? 'is-active' : ''} ${loaded ? 'is-loaded' : ''}`,
          title: isWs ? `${e.path}\n클릭: 워크스페이스 열기` : `${e.path}\n클릭: 가져오기${loaded ? ' (불러옴)' : ''}`,
        },
        icon(isWs ? LayoutDashboard : loaded ? FileChartColumn : FileSpreadsheet, 14, 'file-icon'),
        h('div', { class: 'tree-item-inner' }, e.name),
        current ? h('div', { class: 'tree-item-flair' }, project.dirty ? '●' : '열림') : null,
      );
      row.addEventListener('click', () => {
        const fh = e.handle as FileSystemFileHandle;
        if (isWs) void project.open(fh, e.path);
        else void project.importHandle(fh);
      });
      row.addEventListener('contextmenu', (ev) => {
        ev.preventDefault();
        const fh = e.handle as FileSystemFileHandle;
        showMenu(
          isWs
            ? [{ title: '워크스페이스 열기', icon: LayoutDashboard, onClick: () => void project.open(fh, e.path) }]
            : [
                { title: '가져오기', icon: FileSpreadsheet, onClick: () => void project.importHandle(fh) },
                {
                  title: '가져와서 새 워크시트로',
                  icon: LayoutDashboard,
                  onClick: async () => {
                    const src = await project.importHandle(fh);
                    if (src) {
                      store.addWorksheet(src.name.replace(/\.(csv|tsv|txt)$/i, ''));
                      actions.chartSource(src);
                    }
                  },
                },
              ],
          { x: ev.clientX, y: ev.clientY },
        );
      });
      into.append(row);
    }
  }
}
