import type { IconNode } from 'lucide';
import { X } from 'lucide';
import { h, icon, iconButton } from '../util';

// ---------- Notices (Obsidian-style toasts, top-right) ----------
let noticeHost: HTMLElement | null = null;

export function notice(msg: string, timeout = 3500, kind: 'info' | 'error' = 'info'): { el: HTMLElement; set: (m: string) => void; hide: () => void } {
  if (!noticeHost) {
    noticeHost = h('div', { class: 'notice-container', role: 'status', 'aria-live': 'polite' });
    document.body.append(noticeHost);
  }
  const el = h('div', { class: `notice ${kind === 'error' ? 'is-error' : ''}` }, msg);
  const hide = () => {
    el.classList.add('is-hiding');
    setTimeout(() => el.remove(), 200);
  };
  if (timeout > 0) el.addEventListener('click', hide);
  noticeHost.append(el);
  if (timeout > 0) setTimeout(hide, timeout);
  return { el, set: (m) => (el.textContent = m), hide };
}

// ---------- Context menu ----------
export interface MenuItem {
  title: string;
  icon?: IconNode;
  onClick?: () => void;
  checked?: boolean;
  disabled?: boolean;
  danger?: boolean;
  separator?: boolean;
  hint?: string;
}

let openMenu: HTMLElement | null = null;

export function closeMenu() {
  openMenu?.remove();
  openMenu = null;
}

export function showMenu(items: MenuItem[], at: { x: number; y: number } | HTMLElement) {
  closeMenu();
  const menu = h('div', { class: 'menu', role: 'menu' });
  for (const it of items) {
    if (it.separator) {
      menu.append(h('div', { class: 'menu-separator' }));
      continue;
    }
    const row = h(
      'div',
      {
        class: `menu-item ${it.disabled ? 'is-disabled' : ''} ${it.danger ? 'is-warning' : ''}`,
        role: 'menuitem',
        tabindex: -1,
      },
      h('div', { class: 'menu-item-icon' }, it.icon ? icon(it.icon, 15) : it.checked ? h('span', { class: 'check' }, '✓') : ''),
      h('div', { class: 'menu-item-title' }, it.title),
      it.hint ? h('div', { class: 'menu-item-hint' }, it.hint) : null,
    );
    if (!it.disabled)
      row.addEventListener('click', (e) => {
        e.stopPropagation();
        closeMenu();
        it.onClick?.();
      });
    menu.append(row);
  }
  document.body.append(menu);
  openMenu = menu;
  let x: number;
  let y: number;
  if (at instanceof HTMLElement) {
    const r = at.getBoundingClientRect();
    x = r.left;
    y = r.bottom + 4;
  } else ({ x, y } = at);
  const mr = menu.getBoundingClientRect();
  x = Math.min(x, window.innerWidth - mr.width - 8);
  y = y + mr.height > window.innerHeight - 8 ? Math.max(8, y - mr.height) : y;
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  setTimeout(() => {
    const off = (e: Event) => {
      if (openMenu && e.target instanceof Node && openMenu.contains(e.target)) return;
      closeMenu();
      document.removeEventListener('pointerdown', off, true);
      document.removeEventListener('keydown', esc, true);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') off(e);
    };
    document.addEventListener('pointerdown', off, true);
    document.addEventListener('keydown', esc, true);
  });
}

// ---------- Modal ----------
export interface ModalHandle {
  el: HTMLElement;
  content: HTMLElement;
  footer: HTMLElement;
  close: () => void;
}

export function modal(title: string, opts: { width?: number; onClose?: () => void } = {}): ModalHandle {
  const content = h('div', { class: 'modal-content' });
  const footer = h('div', { class: 'modal-button-container' });
  const close = () => {
    bg.remove();
    document.removeEventListener('keydown', esc);
    opts.onClose?.();
  };
  const esc = (e: KeyboardEvent) => {
    if (e.key === 'Escape') close();
  };
  const box = h(
    'div',
    { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    iconButton(X, '닫기', close, 'modal-close-button'),
    h('div', { class: 'modal-title' }, title),
    content,
    footer,
  );
  if (opts.width) box.style.width = `${opts.width}px`;
  const bg = h('div', { class: 'modal-container' }, h('div', { class: 'modal-bg' }), box);
  bg.firstElementChild!.addEventListener('click', close);
  document.addEventListener('keydown', esc);
  document.body.append(bg);
  return { el: box, content, footer, close };
}

export function button(label: string, onClick: () => void, cta = false): HTMLButtonElement {
  return h('button', { class: cta ? 'mod-cta' : '', type: 'button', onclick: onClick as EventListener }, label);
}

export function prompt(title: string, initial = '', placeholder = ''): Promise<string | null> {
  return new Promise((resolve) => {
    let done = false;
    const m = modal(title, { width: 420, onClose: () => !done && resolve(null) });
    const input = h('input', { type: 'text', value: initial, placeholder, class: 'full-width' });
    const ok = () => {
      done = true;
      m.close();
      resolve(input.value);
    };
    input.addEventListener('keydown', (e) => e.key === 'Enter' && ok());
    m.content.append(input);
    m.footer.append(button('취소', () => m.close()), button('확인', ok, true));
    setTimeout(() => input.select());
  });
}

export function confirmDialog(title: string, message: string, okLabel = '삭제'): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const m = modal(title, { width: 420, onClose: () => !done && resolve(false) });
    m.content.append(h('p', {}, message));
    m.footer.append(
      button('취소', () => m.close()),
      h('button', {
        class: 'mod-warning',
        type: 'button',
        onclick: (() => {
          done = true;
          m.close();
          resolve(true);
        }) as EventListener,
      }, okLabel),
    );
  });
}
