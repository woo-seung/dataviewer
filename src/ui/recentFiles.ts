import { ChevronRight, FilePlus, FolderOpen, LayoutDashboard, Save, X } from 'lucide';
import { baseName } from '../dialogs';
import { project } from '../project';
import { store } from '../store';
import { h, icon, iconButton } from '../util';
import { showMenu } from './overlays';

/** Current workspace + recently opened .chronos files. */
export class RecentFiles {
  readonly el: HTMLElement;
  private collapsed = false;

  constructor() {
    this.el = h('div', { class: 'recent-section' });
    store.on('project', () => this.render());
    this.render();
  }

  private render() {
    const title = h(
      'div',
      { class: `section-title ${this.collapsed ? 'is-collapsed' : ''}` },
      h('div', { class: 'tree-item-icon collapse-icon' }, icon(ChevronRight, 14)),
      h('span', {}, '워크스페이스'),
    );
    title.addEventListener('click', () => {
      this.collapsed = !this.collapsed;
      this.render();
    });
    const out: HTMLElement[] = [title];
    if (!this.collapsed) {
      const cur = h(
        'div',
        { class: 'tree-item-self nav-file-title is-active', title: project.untitled ? '저장하지 않은 워크스페이스 (자동 보관됨)' : (project.path ?? '') },
        icon(LayoutDashboard, 14, 'file-icon'),
        h('div', { class: 'tree-item-inner' }, project.title),
        h('div', { class: 'tree-item-flair' }, project.saving ? '저장 중' : project.untitled ? '자동 보관' : project.dirty ? '●' : '저장됨'),
        iconButton(Save, project.untitled ? '다른 이름으로 저장' : '저장 (Ctrl+S)', () => void project.save()),
      );
      out.push(
        cur,
        h(
          'div',
          { class: 'recent-actions' },
          iconButton(FolderOpen, '워크스페이스 열기 (Ctrl+O)', () => void project.openDialog(), 'clickable-icon nav-action-button'),
          iconButton(FilePlus, '새 워크스페이스', () => void project.newWorkspace(), 'clickable-icon nav-action-button'),
        ),
      );
      const recent = project.recent.filter((p) => p !== project.path);
      if (recent.length) out.push(h('div', { class: 'recent-caption' }, '최근 파일'));
      for (const p of recent) {
        const row = h(
          'div',
          { class: 'tree-item-self nav-file-title', title: p },
          icon(LayoutDashboard, 14, 'file-icon'),
          h('div', { class: 'tree-item-inner' }, baseName(p).replace(/\.chronos$/i, '')),
          iconButton(X, '목록에서 제거', () => project.forget(p)),
        );
        row.addEventListener('click', () => void project.open(p));
        row.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          showMenu(
            [
              { title: '열기', icon: FolderOpen, onClick: () => void project.open(p) },
              { title: '목록에서 제거', icon: X, onClick: () => project.forget(p) },
            ],
            { x: e.clientX, y: e.clientY },
          );
        });
        out.push(row);
      }
    }
    this.el.replaceChildren(...out);
  }
}
