/**
 * Pointer-event drag & drop for in-app drags (series → charts, legend rows,
 * tabs). HTML5 drag & drop is unavailable in the Windows webview while native
 * file drops are enabled, so the app does its own: a ghost follows the pointer
 * and the innermost registered target under it receives over/leave/drop.
 */
import type { SeriesDrag } from '../types';
import { h } from '../util';

export type DragPayload = { kind: 'series'; data: SeriesDrag } | { kind: 'tab'; id: string };

export interface DropTarget {
  accepts(p: DragPayload): boolean;
  over?(p: DragPayload, e: PointerEvent): void;
  leave?(): void;
  drop(p: DragPayload, e: PointerEvent): void;
}

const targets = new WeakMap<Element, DropTarget>();
let active: { payload: DragPayload; ghost: HTMLElement; target: Element | null } | null = null;

export function dropTarget(el: HTMLElement, t: DropTarget) {
  targets.set(el, t);
}

export function isDragging() {
  return active !== null;
}

function findTarget(x: number, y: number, p: DragPayload): Element | null {
  let el = document.elementFromPoint(x, y);
  while (el) {
    const t = targets.get(el);
    if (t?.accepts(p)) return el;
    el = el.parentElement;
  }
  return null;
}

function setTarget(el: Element | null, e: PointerEvent) {
  if (!active) return;
  if (active.target !== el) {
    if (active.target) {
      active.target.classList.remove('is-drop-target');
      targets.get(active.target)?.leave?.();
    }
    active.target = el;
    el?.classList.add('is-drop-target');
  }
  if (el) targets.get(el)?.over?.(active.payload, e);
}

/**
 * Make `el` a drag source. `payload` is read when the drag starts (after a
 * 5 px move), so selections made by the pointerdown itself are included.
 */
export function draggable(el: HTMLElement, payload: () => DragPayload | null, label: () => string) {
  el.addEventListener('pointerdown', (down) => {
    if (down.button !== 0 || (down.target as HTMLElement).closest('button, input, [contenteditable="true"]')) return;
    const sx = down.clientX;
    const sy = down.clientY;
    let started = false;
    const move = (e: PointerEvent) => {
      if (!started) {
        if (Math.hypot(e.clientX - sx, e.clientY - sy) < 5) return;
        const p = payload();
        if (!p) return cleanup();
        started = true;
        const ghost = h('div', { class: 'drag-ghost' }, label());
        document.body.append(ghost);
        document.body.classList.add('is-dragging');
        active = { payload: p, ghost, target: null };
      }
      if (!active) return;
      active.ghost.style.transform = `translate(${e.clientX + 12}px, ${e.clientY + 10}px)`;
      setTarget(findTarget(e.clientX, e.clientY, active.payload), e);
    };
    const up = (e: PointerEvent) => {
      if (active) {
        const t = active.target;
        const p = active.payload;
        setTarget(null, e);
        finish();
        if (t) targets.get(t)?.drop(p, e);
        // swallow the click that follows a drag (it fires before timers run)
        const swallow = (c: MouseEvent) => c.stopPropagation();
        window.addEventListener('click', swallow, { capture: true, once: true });
        setTimeout(() => window.removeEventListener('click', swallow, true));
      }
      cleanup();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && active) {
        setTarget(null, new PointerEvent('pointercancel'));
        finish();
        cleanup();
      }
    };
    const finish = () => {
      active?.ghost.remove();
      active = null;
      document.body.classList.remove('is-dragging');
    };
    const cleanup = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('keydown', key);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('keydown', key);
  });
}

/** Payload helpers. */
export const seriesPayload = (data: SeriesDrag): DragPayload => ({ kind: 'series', data });
export const isSeries = (p: DragPayload): p is { kind: 'series'; data: SeriesDrag } => p.kind === 'series';
