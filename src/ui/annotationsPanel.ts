/** Right-sidebar list of every annotation; clicking one brings back the screen it was made on. */
import { ChevronRight, MessageSquarePlus, Pencil, Trash2 } from 'lucide';
import { noteTitle, openAnnotation, whenText } from '../annotations';
import { store } from '../store';
import type { Annotation } from '../types';
import { h, icon, iconButton } from '../util';
import { openAnnotationEditor, valuesTable } from './annotationEditor';
import { confirmDialog } from './overlays';

export class AnnotationsPanel {
  readonly el: HTMLElement;
  private list: HTMLElement;
  private search: HTMLInputElement;
  private onlySheet = false;
  private expanded = new Set<string>();

  constructor() {
    this.search = h('input', { type: 'search', class: 'search-input', placeholder: '주석 검색…', 'aria-label': '주석 검색' }) as HTMLInputElement;
    this.search.addEventListener('input', () => this.render());
    const sheetToggle = h('label', { class: 'anno-filter' }, h('input', { type: 'checkbox' }), ' 현재 워크시트만');
    sheetToggle.querySelector('input')!.addEventListener('change', (e) => {
      this.onlySheet = (e.target as HTMLInputElement).checked;
      this.render();
    });
    const add = h('button', { type: 'button', class: 'anno-add', title: '주석 모드 (N): 그래프를 클릭하면 포인트, 드래그하면 구간에 주석' }, icon(MessageSquarePlus, 15), ' 주석 달기');
    add.addEventListener('click', () => store.setAnnotating(!store.annotating));
    this.list = h('div', { class: 'anno-list' });
    this.el = h('div', { class: 'anno-panel' }, h('div', { class: 'anno-panel-head' }, add, this.search, sheetToggle), this.list);
    store.on('annotations', () => this.render());
    store.on('annotating', () => {
      add.classList.toggle('is-active', store.annotating);
      this.render();
    });
    store.on('active', () => this.onlySheet && this.render());
    store.on('worksheets', () => this.render());
    store.on('widgets', () => this.render());
    this.render();
  }

  private render() {
    const q = this.search.value.trim().toLowerCase();
    const order = new Map(store.ws.worksheets.map((w, i) => [w.id, i]));
    const items = store.annotations
      .filter((a) => !this.onlySheet || a.worksheetId === store.active.id)
      .filter((a) => !q || `${a.note} ${a.widgetTitle} ${a.sheetName}`.toLowerCase().includes(q))
      .sort((a, b) => (order.get(a.worksheetId) ?? 1e9) - (order.get(b.worksheetId) ?? 1e9) || a.t - b.t);
    if (!items.length) {
      this.list.replaceChildren(
        h(
          'div',
          { class: 'pane-empty' },
          h('p', {}, store.annotations.length ? '일치하는 주석이 없습니다.' : '주석이 없습니다.'),
          h('p', { class: 'muted' }, '"주석 달기"(N)를 누른 뒤 그래프를 클릭하면 그 시점에, 드래그하면 그 구간에 주석이 달립니다. 주석에는 메모, 그 시점의 데이터, 그때의 화면(시간 범위·확대 상태)이 저장됩니다.'),
        ),
      );
      return;
    }
    this.list.replaceChildren(...items.map((a) => this.item(a)));
    this.list.querySelector('.is-focused')?.scrollIntoView({ block: 'nearest' });
  }

  private item(a: Annotation): HTMLElement {
    const ws = store.sheet(a.worksheetId);
    const w = ws ? store.widget(ws.id, a.widgetId) : null;
    const where = `${ws?.name ?? `${a.sheetName} (삭제됨)`} › ${w?.title ?? `${a.widgetTitle} (삭제됨)`}`;
    const open = this.expanded.has(a.id);
    const toggle = iconButton(ChevronRight, open ? '접기' : '자세히 (메모 전체, 데이터)', () => {
      if (open) this.expanded.delete(a.id);
      else this.expanded.add(a.id);
      this.render();
    }, `clickable-icon anno-expand ${open ? 'is-open' : ''}`, 14);
    const edit = iconButton(Pencil, '편집', (e) => openAnnotationEditor(a, { x: e.clientX - 300, y: e.clientY }, false), 'clickable-icon', 14);
    const del = iconButton(Trash2, '삭제', async () => {
      if (await confirmDialog('주석 삭제', `"${noteTitle(a)}" 주석을 삭제할까요?`, '삭제')) store.removeAnnotation(a.id);
    }, 'clickable-icon', 14);
    const el = h(
      'div',
      { class: `anno-item ${store.focusedAnnotation === a.id ? 'is-focused' : ''}`, style: `--c:${a.color}`, title: '클릭: 주석을 달던 화면으로 이동' },
      h(
        'div',
        { class: 'anno-item-head' },
        toggle,
        h('span', { class: `anno-kind is-${a.kind}` }),
        h('div', { class: 'anno-item-title' }, noteTitle(a)),
        h('div', { class: 'anno-item-actions' }, edit, del),
      ),
      h('div', { class: 'anno-item-when' }, whenText(a)),
      h('div', { class: 'anno-item-where' }, where),
      ...(open
        ? [
            ...(a.note.includes('\n') ? [h('div', { class: 'anno-item-note' }, a.note.split('\n').slice(1).join('\n').trim())] : []),
            valuesTable(a, 50),
            h('div', { class: 'anno-item-meta' }, `작성 ${new Date(a.createdAt).toLocaleString()}${a.updatedAt && a.updatedAt - a.createdAt > 60_000 ? ` · 수정 ${new Date(a.updatedAt).toLocaleString()}` : ''}`),
          ]
        : []),
    );
    el.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('button')) return;
      openAnnotation(a);
    });
    return el;
  }
}
