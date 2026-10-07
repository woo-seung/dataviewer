import { Copy, LayoutDashboard, Pencil, Plus, X } from 'lucide';
import { store } from '../store';
import { DRAG_MIME } from '../types';
import { h, icon, iconButton } from '../util';
import { showMenu } from './overlays';

const TAB_MIME = 'application/x-chronos-tab';

export class TabBar {
  readonly el: HTMLElement;
  private list: HTMLElement;

  constructor() {
    this.list = h('div', { class: 'workspace-tab-header-container-inner', role: 'tablist' });
    this.el = h(
      'div',
      { class: 'workspace-tab-header-container' },
      this.list,
      h('div', { class: 'workspace-tab-header-new-tab' }, iconButton(Plus, '새 워크시트 (Alt+T)', () => store.addWorksheet())),
      h('div', { class: 'workspace-tab-header-spacer' }),
    );
    store.on('worksheets', () => this.render());
    store.on('active', () => this.render());
    this.render();
  }

  private render() {
    this.list.replaceChildren();
    store.ws.worksheets.forEach((ws, idx) => {
      const active = ws.id === store.ws.activeId;
      const title = h('div', { class: 'workspace-tab-header-inner-title' }, ws.name);
      const tab = h(
        'div',
        {
          class: `workspace-tab-header ${active ? 'is-active mod-active' : ''}`,
          role: 'tab',
          'aria-selected': String(active),
          draggable: 'true',
          title: ws.name,
        },
        h(
          'div',
          { class: 'workspace-tab-header-inner' },
          h('div', { class: 'workspace-tab-header-inner-icon' }, icon(LayoutDashboard, 15)),
          title,
          h('div', { class: 'workspace-tab-header-inner-close-button' }, iconButton(X, '닫기', () => store.removeWorksheet(ws.id), 'clickable-icon', 14)),
        ),
      );
      tab.addEventListener('mousedown', (e) => {
        if (e.button === 1) {
          e.preventDefault();
          store.removeWorksheet(ws.id);
        }
      });
      tab.addEventListener('click', () => store.setActive(ws.id));
      tab.addEventListener('dblclick', () => this.rename(ws.id, title));
      tab.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showMenu(
          [
            { title: '이름 변경', icon: Pencil, onClick: () => this.rename(ws.id, title) },
            { title: '복제', icon: Copy, onClick: () => store.duplicateWorksheet(ws.id) },
            { separator: true, title: '' },
            { title: '닫기', icon: X, onClick: () => store.removeWorksheet(ws.id) },
            {
              title: '다른 탭 모두 닫기',
              disabled: store.ws.worksheets.length < 2,
              onClick: () => store.ws.worksheets.filter((w) => w.id !== ws.id).forEach((w) => store.removeWorksheet(w.id)),
            },
          ],
          { x: e.clientX, y: e.clientY },
        );
      });
      // reorder
      tab.addEventListener('dragstart', (e) => {
        e.dataTransfer!.setData(TAB_MIME, ws.id);
        e.dataTransfer!.effectAllowed = 'move';
      });
      let hoverTimer: ReturnType<typeof setTimeout> | undefined;
      tab.addEventListener('dragover', (e) => {
        const types = e.dataTransfer?.types ?? [];
        if (types.includes(TAB_MIME)) {
          e.preventDefault();
          tab.classList.add('is-drop-target');
        } else if (types.includes(DRAG_MIME) && !active && !hoverTimer) {
          // hovering a series over a tab switches to it
          hoverTimer = setTimeout(() => store.setActive(ws.id), 450);
        }
      });
      tab.addEventListener('dragleave', () => {
        tab.classList.remove('is-drop-target');
        clearTimeout(hoverTimer);
        hoverTimer = undefined;
      });
      tab.addEventListener('drop', (e) => {
        tab.classList.remove('is-drop-target');
        const id = e.dataTransfer?.getData(TAB_MIME);
        if (id) {
          e.preventDefault();
          store.moveWorksheet(id, idx);
        }
      });
      this.list.append(tab);
    });
    this.list.querySelector('.is-active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  private rename(id: string, title: HTMLElement) {
    title.contentEditable = 'true';
    title.focus();
    document.getSelection()?.selectAllChildren(title);
    const done = (commit: boolean) => {
      title.contentEditable = 'false';
      title.removeEventListener('blur', blur);
      title.removeEventListener('keydown', key);
      if (commit) store.renameWorksheet(id, title.textContent ?? '');
      else this.render();
    };
    const blur = () => done(true);
    const key = (e: KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        done(true);
      }
      if (e.key === 'Escape') done(false);
    };
    title.addEventListener('blur', blur);
    title.addEventListener('keydown', key);
  }
}
