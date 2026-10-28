/** Form for a plugin widget's parameters, generated from the plugin's `params` definition. */
import { GripVertical, X } from 'lucide';
import { store } from '../store';
import type { ColumnRef, ParamSpec, ParamValue, PluginManifest } from '../plugins/types';
import { h, icon, iconButton } from '../util';
import { draggable, dropTarget, isSeries, seriesPayload, type DragPayload } from './dnd';

/** Every loaded column as "source › column", for the column pickers. */
function columnOptions(): { key: string; ref: ColumnRef }[] {
  const out: { key: string; ref: ColumnRef }[] = [];
  const multi = store.sources.size > 1;
  for (const s of store.sources.values())
    for (const c of s.columns) out.push({ key: multi ? `${s.name} › ${c.name}` : c.name, ref: { source: s.id, column: c.name, label: c.name } });
  return out;
}

let listSeq = 0;

/** Text field with suggestions (type to filter; thousands of columns stay usable). */
function columnInput(value: ColumnRef | null, onPick: (r: ColumnRef | null) => void, placeholder = '열 검색…') {
  const opts = columnOptions();
  const id = `cols-${++listSeq}`;
  const list = h('datalist', { id }, ...opts.map((o) => h('option', { value: o.key })));
  const keyOf = (r: ColumnRef | null) => (r ? (opts.find((o) => o.ref.source === r.source && o.ref.column === r.column)?.key ?? r.label) : '');
  const input = h('input', { type: 'text', list: id, placeholder, value: keyOf(value), class: 'param-column-input', spellcheck: false }) as HTMLInputElement;
  const commit = () => {
    const v = input.value.trim();
    if (!v) return onPick(null);
    const hit = opts.find((o) => o.key === v) ?? opts.find((o) => o.ref.column === v);
    if (hit) onPick(hit.ref);
    else input.classList.add('is-invalid');
  };
  input.addEventListener('change', commit);
  input.addEventListener('input', () => input.classList.remove('is-invalid'));
  return h('span', { class: 'param-column-wrap' }, input, list);
}

const same = (a: ColumnRef, b: ColumnRef) => a.source === b.source && a.column === b.column;
const refsOf = (p: DragPayload): ColumnRef[] => (isSeries(p) ? p.data.items.map((i) => ({ source: i.sourceId, column: i.column, label: i.column })) : []);

/**
 * A column parameter as a slot of blocks (Lego-like): drag columns in from the
 * explorer (or a block from another slot, which moves it), × takes one out,
 * the search field adds by name. `column` holds one block (a drop replaces
 * it), `columns` up to `max`.
 */
function columnSlot(
  key: string,
  p: ParamSpec & { type: 'column' | 'columns' },
  v: ParamValue,
  values: Record<string, ParamValue>,
  set: (patch: Record<string, ParamValue>) => void,
  widgetId: string,
): HTMLElement {
  const multi = p.type === 'columns';
  const list: ColumnRef[] = multi ? [...((v as ColumnRef[]) ?? [])] : v ? [v as ColumnRef] : [];
  const max = multi ? (p as { max?: number }).max : 1;
  const store1 = (next: ColumnRef[]): ParamValue => (multi ? next : (next[0] ?? null));
  const put = (refs: ColumnRef[], from?: { widgetId: string; key: string }) => {
    let next = multi ? [...list] : [];
    for (const r of refs) if (!next.some((c) => same(c, r)) && (max === undefined || next.length < max)) next.push(r);
    if (!multi) next = refs.slice(0, 1);
    const patch: Record<string, ParamValue> = { [key]: store1(next) };
    // a block moved out of another slot of this widget leaves it
    if (from && from.widgetId === widgetId && from.key !== key) {
      const old = values[from.key];
      // onto an occupied one-column slot: the two blocks swap places
      const back = !multi && list[0] && !refs.some((r) => same(r, list[0])) ? list[0] : null;
      if (Array.isArray(old)) {
        const rest = (old as ColumnRef[]).filter((c) => !refs.some((r) => same(c, r)));
        patch[from.key] = back && !rest.some((c) => same(c, back)) ? [...rest, back] : rest;
      } else patch[from.key] = back;
    }
    set(patch);
  };
  const blocks = list.map((c, i) => {
    const b = h(
      'span',
      { class: 'param-block', title: `${c.column}\n끌어서 다른 칸으로 옮기기` },
      icon(GripVertical, 12, 'param-block-grip'),
      h('span', { class: 'param-block-label' }, c.label),
      iconButton(X, '빼기', () => set({ [key]: store1(list.filter((_, j) => j !== i)) }), 'clickable-icon', 12),
    );
    draggable(
      b,
      () => seriesPayload({ items: [{ sourceId: c.source, column: c.column }], fromParam: { widgetId, key } }),
      () => `${c.label} — 다른 칸으로 옮기기`,
    );
    return b;
  });
  const full = max !== undefined && list.length >= max;
  const hint = h('span', { class: 'param-slot-hint' }, list.length ? (multi ? (full ? `최대 ${max}개` : '＋ 끌어 놓기') : '끌어 놓으면 교체') : multi ? '탐색기에서 열을 끌어 놓기 (여러 개)' : '탐색기에서 열을 끌어 놓기');
  const slot = h('div', { class: `param-slot ${list.length ? '' : 'is-empty'}` }, ...blocks, hint);
  dropTarget(slot, {
    accepts: (d) => isSeries(d) && !(d.data.fromParam && d.data.fromParam.widgetId === widgetId && d.data.fromParam.key === key),
    drop: (d) => put(refsOf(d), isSeries(d) ? d.data.fromParam : undefined),
  });
  const search = full && multi ? null : columnInput(null, (r) => r && put([r]), multi ? '열 추가…' : list.length ? '다른 열로 바꾸기…' : '열 검색…');
  return h('div', { class: 'param-columns' }, slot, search);
}

function defaultOf(p: ParamSpec): ParamValue {
  switch (p.type) {
    case 'columns':
      return [];
    case 'column':
      return null;
    case 'select': {
      const first = p.options[0];
      return p.default ?? (typeof first === 'string' ? first : first?.value ?? '');
    }
    default:
      return (p as { default?: ParamValue }).default ?? (p.type === 'boolean' ? false : p.type === 'number' ? 0 : p.type === 'color' ? '#3987e5' : '');
  }
}

/** Parameter values with the plugin's defaults filled in. */
export function resolveParams(m: PluginManifest, params: Record<string, ParamValue>): Record<string, ParamValue> {
  const out: Record<string, ParamValue> = {};
  for (const [k, p] of Object.entries(m.params)) out[k] = params[k] === undefined ? defaultOf(p) : params[k];
  return out;
}

export function paramControls(m: PluginManifest, params: Record<string, ParamValue>, set: (patch: Record<string, ParamValue>) => void, widgetId = ''): HTMLElement[] {
  const values = resolveParams(m, params);
  return Object.entries(m.params).map(([k, p]) => {
    let control: HTMLElement;
    const v = values[k];
    switch (p.type) {
      case 'column':
      case 'columns':
        control = columnSlot(k, p, v, values, set, widgetId);
        break;
      case 'number': {
        const i = h('input', { type: 'number', value: String(v ?? ''), min: p.min, max: p.max, step: p.step ?? 'any', class: 'num-input' }) as HTMLInputElement;
        i.addEventListener('change', () => i.value !== '' && Number.isFinite(Number(i.value)) && set({ [k]: Number(i.value) }));
        control = i;
        break;
      }
      case 'select': {
        const s = h('select', { class: 'dropdown' }) as HTMLSelectElement;
        for (const o of p.options) {
          const [val, label] = typeof o === 'string' ? [o, o] : [o.value, o.label];
          s.append(h('option', { value: val, selected: val === v }, label));
        }
        s.addEventListener('change', () => set({ [k]: s.value }));
        control = s;
        break;
      }
      case 'boolean': {
        const c = h('input', { type: 'checkbox', checked: !!v }) as HTMLInputElement;
        c.addEventListener('change', () => set({ [k]: c.checked }));
        control = h('label', { class: 'checkbox-container-native' }, c);
        break;
      }
      case 'color': {
        const c = h('input', { type: 'color', value: String(v || '#3987e5') }) as HTMLInputElement;
        c.addEventListener('change', () => set({ [k]: c.value }));
        control = c;
        break;
      }
      default: {
        const t = h('input', { type: 'text', value: String(v ?? '') }) as HTMLInputElement;
        t.addEventListener('change', () => set({ [k]: t.value }));
        control = t;
      }
    }
    return h(
      'div',
      { class: `setting-item param-${p.type}` },
      h('div', { class: 'setting-item-info' }, h('div', { class: 'setting-item-name' }, p.label || k), p.description ? h('div', { class: 'setting-item-description' }, p.description) : null),
      h('div', { class: 'setting-item-control' }, control),
    );
  });
}

/** Columns dropped on a plugin chart fill its column parameters (first empty one, or the list). */
export function assignColumns(m: PluginManifest, params: Record<string, ParamValue>, refs: ColumnRef[]): Record<string, ParamValue> | null {
  const values = resolveParams(m, params);
  const patch: Record<string, ParamValue> = {};
  let rest = [...refs];
  for (const [k, p] of Object.entries(m.params)) {
    if (!rest.length) break;
    if (p.type === 'column' && !values[k]) {
      patch[k] = rest.shift()!;
    } else if (p.type === 'columns') {
      const list = [...((values[k] as ColumnRef[]) ?? [])];
      for (const r of rest) if (!list.some((c) => c.source === r.source && c.column === r.column) && (p.max === undefined || list.length < p.max)) list.push(r);
      patch[k] = list;
      rest = [];
    }
  }
  // all single-column slots taken: the drop replaces the first one
  if (rest.length && !Object.keys(patch).length) {
    const first = Object.entries(m.params).find(([, p]) => p.type === 'column');
    if (first) patch[first[0]] = rest[0];
  }
  return Object.keys(patch).length ? patch : null;
}
