import { ChevronRight, FilePlus, FolderOpen, LayoutDashboard, Save } from 'lucide';
import { project } from '../project';
import { store } from '../store';
import { h, icon, iconButton } from '../util';

/** The current workspace, with open / new / save. */
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
        { class: 'tree-item-self nav-file-title is-active', title: project.untitled ? '저장하지 않은 워크스페이스 (브라우저에 자동 보관됨)' : project.name },
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
    }
    this.el.replaceChildren(...out);
  }
}
