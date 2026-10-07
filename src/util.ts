import { createElement, type IconNode } from 'lucide';

let counter = 0;
export function uid(prefix = 'id'): string {
  counter = (counter + 1) % 1e6;
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

type Attrs = Record<string, string | number | boolean | undefined | null | EventListener>;

/** Tiny hyperscript helper. Keys starting with "on" become event listeners. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: (Node | string | null | undefined | false)[]
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else if (k === 'class') e.className = String(v);
    else if (k === 'html') e.innerHTML = String(v);
    else if (k in e && typeof v !== 'string') (e as unknown as Record<string, unknown>)[k] = v;
    else e.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    e.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return e;
}

export function icon(node: IconNode, size = 16, cls = ''): SVGElement {
  const svg = createElement(node, { width: size, height: size, 'stroke-width': 1.75 });
  svg.classList.add('svg-icon');
  if (cls) svg.classList.add(cls);
  return svg;
}

export function iconButton(
  node: IconNode,
  label: string,
  onClick: (e: MouseEvent) => void,
  cls = 'clickable-icon',
  size = 16,
): HTMLButtonElement {
  const b = h('button', { class: cls, 'aria-label': label, title: label, type: 'button' }, icon(node, size));
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick(e);
  });
  return b;
}

export function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number) {
  let t: ReturnType<typeof setTimeout> | undefined;
  return (...a: A) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

/** Run at most once per animation frame with the latest arguments. */
export function rafThrottle<A extends unknown[]>(fn: (...a: A) => void) {
  let pending: A | null = null;
  return (...a: A) => {
    const first = pending === null;
    pending = a;
    if (first)
      requestAnimationFrame(() => {
        const args = pending!;
        pending = null;
        fn(...args);
      });
  };
}

/** First index i with arr[i] >= v. */
export function lowerBound(arr: ArrayLike<number>, v: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function nearestIndex(arr: ArrayLike<number>, v: number): number {
  if (!arr.length) return -1;
  const i = lowerBound(arr, v);
  if (i <= 0) return 0;
  if (i >= arr.length) return arr.length - 1;
  return v - arr[i - 1] <= arr[i] - v ? i - 1 : i;
}

const SI = [
  { v: 1e12, s: 'T' },
  { v: 1e9, s: 'G' },
  { v: 1e6, s: 'M' },
  { v: 1e3, s: 'k' },
  { v: 1, s: '' },
  { v: 1e-3, s: 'm' },
  { v: 1e-6, s: 'µ' },
  { v: 1e-9, s: 'n' },
];

export function formatValue(v: number, si = true, unit = ''): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  if (!Number.isFinite(v)) return v > 0 ? '∞' : '-∞';
  const u = unit ? ` ${unit}` : '';
  if (v === 0) return `0${u}`;
  const a = Math.abs(v);
  if (si) {
    const p = SI.find((x) => a >= x.v) ?? SI[SI.length - 1];
    const n = v / p.v;
    const digits = Math.abs(n) >= 100 ? 1 : Math.abs(n) >= 10 ? 2 : 3;
    return `${Number(n.toFixed(digits))}${p.s ? (unit ? ` ${p.s}${unit}` : p.s) : u}`;
  }
  if (a >= 1e9 || a < 1e-4) return `${v.toExponential(3)}${u}`;
  if (a >= 1e5) return `${Math.round(v).toLocaleString('en-US')}${u}`;
  return `${Number(v.toPrecision(5))}${u}`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function formatCount(n: number): string {
  return n.toLocaleString('en-US');
}

export function cssVar(name: string): string {
  return getComputedStyle(document.body).getPropertyValue(name).trim();
}

export function downloadBlob(blob: Blob, filename: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

export function pickFiles(accept: string, multiple = true): Promise<File[]> {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept, multiple });
    input.addEventListener('change', () => resolve(Array.from(input.files ?? [])));
    input.click();
  });
}

export function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v));
}
