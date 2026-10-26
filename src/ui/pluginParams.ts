/** Form for a plugin widget's parameters, generated from the plugin's `params` definition. */
import { X } from 'lucide';
import { store } from '../store';
import type { ColumnRef, ParamSpec, ParamValue, PluginManifest } from '../plugins/types';
import { h, iconButton } from '../util';

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

export function paramControls(m: PluginManifest, params: Record<string, ParamValue>, set: (patch: Record<string, ParamValue>) => void): HTMLElement[] {
  const values = resolveParams(m, params);
  return Object.entries(m.params).map(([k, p]) => {
    let control: HTMLElement;
    const v = values[k];
    switch (p.type) {
      case 'column':
        control = columnInput(v as ColumnRef | null, (r) => set({ [k]: r }));
        break;
      case 'columns': {
        const list = (v as ColumnRef[]) ?? [];
        const chips = h(
          'div',
          { class: 'param-chips' },
          ...list.map((c, i) =>
            h('span', { class: 'param-chip', title: c.column }, c.label, iconButton(X, '빼기', () => set({ [k]: list.filter((_, j) => j !== i) }), 'clickable-icon', 12)),
          ),
        );
        const full = p.max !== undefined && list.length >= p.max;
        control = h(
          'div',
          { class: 'param-columns' },
          chips,
          full ? h('span', { class: 'muted' }, `최대 ${p.max}개`) : columnInput(null, (r) => r && !list.some((c) => c.source === r.source && c.column === r.column) && set({ [k]: [...list, r] }), '열 추가…'),
        );
        break;
      }
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
