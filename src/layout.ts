/**
 * Tiled worksheet layout (Obsidian-style split panes): a tree whose leaves are
 * widgets and whose inner nodes split their area into a row (side by side) or
 * a column (stacked), with fractional sizes. Tiles always fill the worksheet;
 * there is no free placement and no empty space.
 *
 * Everything here is pure: functions return a new or updated tree.
 */
import { uid } from './util';

export type Tile = { kind: 'leaf'; id: string } | { kind: 'split'; id: string; dir: 'row' | 'col'; children: Tile[]; sizes: number[] };

export type Side = 'left' | 'right' | 'top' | 'bottom';

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const leaf = (id: string): Tile => ({ kind: 'leaf', id });
const split = (dir: 'row' | 'col', children: Tile[], sizes?: number[]): Tile => ({
  kind: 'split',
  id: uid('t'),
  dir,
  children,
  sizes: sizes ?? children.map(() => 1 / children.length),
});

export function leaves(t: Tile | null | undefined): string[] {
  if (!t) return [];
  return t.kind === 'leaf' ? [t.id] : t.children.flatMap(leaves);
}

/** Merge nested splits of the same direction, drop single-child splits, renormalise sizes. */
export function normalize(t: Tile | null): Tile | null {
  if (!t || t.kind === 'leaf') return t;
  const kids: Tile[] = [];
  const sizes: number[] = [];
  t.children.forEach((c, i) => {
    const n = normalize(c);
    if (!n) return;
    const s = t.sizes[i] ?? 1 / t.children.length;
    if (n.kind === 'split' && n.dir === t.dir) {
      n.children.forEach((cc, j) => {
        kids.push(cc);
        sizes.push(s * n.sizes[j]);
      });
    } else {
      kids.push(n);
      sizes.push(s);
    }
  });
  if (!kids.length) return null;
  if (kids.length === 1) return kids[0];
  const total = sizes.reduce((a, b) => a + b, 0) || 1;
  return { ...t, children: kids, sizes: sizes.map((s) => s / total) };
}

export function remove(t: Tile | null, id: string): Tile | null {
  if (!t) return null;
  if (t.kind === 'leaf') return t.id === id ? null : t;
  const children: Tile[] = [];
  const sizes: number[] = [];
  t.children.forEach((c, i) => {
    const r = remove(c, id);
    if (r) {
      children.push(r);
      sizes.push(t.sizes[i]);
    }
  });
  return normalize({ ...t, children, sizes });
}

/** Put `newId` on one side of the tile `targetId`, taking half of its space. */
export function insertAt(t: Tile | null, targetId: string, newId: string, side: Side): Tile {
  if (!t) return leaf(newId);
  const dir: 'row' | 'col' = side === 'left' || side === 'right' ? 'row' : 'col';
  const before = side === 'left' || side === 'top';
  const walk = (n: Tile): Tile => {
    if (n.kind === 'leaf') {
      if (n.id !== targetId) return n;
      return split(dir, before ? [leaf(newId), n] : [n, leaf(newId)]);
    }
    const i = n.children.findIndex((c) => c.kind === 'leaf' && c.id === targetId);
    if (i >= 0 && n.dir === dir) {
      const half = n.sizes[i] / 2;
      const children = [...n.children];
      const sizes = [...n.sizes];
      children.splice(before ? i : i + 1, 0, leaf(newId));
      sizes.splice(i, 1, half, half);
      return { ...n, children, sizes };
    }
    return { ...n, children: n.children.map(walk) };
  };
  return normalize(walk(t))!;
}

/** Exchange the places of two tiles. */
export function swap(t: Tile, a: string, b: string): Tile {
  const walk = (n: Tile): Tile => {
    if (n.kind === 'leaf') return n.id === a ? leaf(b) : n.id === b ? leaf(a) : n;
    return { ...n, children: n.children.map(walk) };
  };
  return walk(t);
}

export function setSizes(t: Tile, splitId: string, sizes: number[]): Tile {
  if (t.kind === 'leaf') return t;
  if (t.id === splitId) return { ...t, sizes };
  return { ...t, children: t.children.map((c) => setSizes(c, splitId, sizes)) };
}

export function equalize(t: Tile): Tile {
  if (t.kind === 'leaf') return t;
  return { ...t, sizes: t.children.map(() => 1 / t.children.length), children: t.children.map(equalize) };
}

/** Tile rectangles in a nominal 16:9 box (to pick where new tiles go). */
function rects(t: Tile, r: Rect, out: Map<string, Rect>) {
  if (t.kind === 'leaf') {
    out.set(t.id, r);
    return;
  }
  let at = 0;
  t.children.forEach((c, i) => {
    const s = t.sizes[i];
    rects(c, t.dir === 'row' ? { x: r.x + at * r.w, y: r.y, w: s * r.w, h: r.h } : { x: r.x, y: r.y + at * r.h, w: r.w, h: s * r.h }, out);
    at += s;
  });
}

/** Smallest useful tile (px); new tiles stack downward rather than get narrower. */
export const MIN_TILE = { w: 240, h: 150 };

/**
 * Split a tile for a new one (`near`, or the largest tile): side by side
 * while both halves stay wide enough in `box` (the worksheet's size in px),
 * otherwise stacked — so a crowded worksheet scrolls down, never sideways.
 */
export function insertAuto(t: Tile | null, newId: string, near?: string, box = { w: 1600, h: 900 }): Tile {
  if (!t) return leaf(newId);
  const rs = new Map<string, Rect>();
  rects(t, { x: 0, y: 0, w: box.w, h: box.h }, rs);
  let target = near && rs.has(near) ? near : '';
  if (!target) {
    let best = -1;
    for (const [id, r] of rs) {
      const area = r.w * r.h;
      if (area > best + 1e-9) {
        best = area;
        target = id;
      }
    }
  }
  const r = rs.get(target)!;
  const wide = r.w / 2 >= MIN_TILE.w && (r.w >= r.h * 1.2 || r.h / 2 < MIN_TILE.h);
  return insertAt(t, target, newId, wide ? 'right' : 'bottom');
}

/** Keep the tree in step with the widget list (drop removed ids, add new ones). */
export function reconcile(t: Tile | null, ids: string[], box?: { w: number; h: number }): Tile | null {
  const want = new Set(ids);
  let out = t;
  for (const id of leaves(t)) if (!want.has(id)) out = remove(out, id);
  const have = new Set(leaves(out));
  for (const id of ids) if (!have.has(id)) out = insertAuto(out, id, undefined, box);
  return out;
}

/**
 * Tiles from free grid positions (older workspaces, the sample dashboard):
 * guillotine cuts — split where a horizontal or vertical line crosses no widget.
 */
export function fromGrid(items: { id: string; x: number; y: number; w: number; h: number }[]): Tile | null {
  if (!items.length) return null;
  if (items.length === 1) return leaf(items[0].id);
  const cut = (axis: 'x' | 'y'): typeof items[] | null => {
    const span = axis === 'x' ? 'w' : 'h';
    const sorted = [...items].sort((a, b) => a[axis] - b[axis]);
    const groups: (typeof items)[] = [];
    let cur: typeof items = [];
    let end = -Infinity;
    for (const it of sorted) {
      if (cur.length && it[axis] >= end) {
        groups.push(cur);
        cur = [];
      }
      cur.push(it);
      end = Math.max(end, it[axis] + it[span]);
    }
    groups.push(cur);
    return groups.length > 1 ? groups : null;
  };
  const extent = (g: typeof items, axis: 'x' | 'y') => {
    const span = axis === 'x' ? 'w' : 'h';
    return Math.max(...g.map((i) => i[axis] + i[span])) - Math.min(...g.map((i) => i[axis]));
  };
  for (const [axis, dir] of [['y', 'col'], ['x', 'row']] as const) {
    const groups = cut(axis);
    if (groups) {
      const sizes = groups.map((g) => Math.max(1, extent(g, axis)));
      const total = sizes.reduce((a, b) => a + b, 0);
      return normalize(split(dir, groups.map((g) => fromGrid(g)!), sizes.map((s) => s / total)));
    }
  }
  // overlapping leftovers: stack them
  return split('col', items.map((i) => leaf(i.id)));
}

/** The same layout with widget ids replaced (duplicated worksheets). */
export function renameLeaves(t: Tile | null | undefined, map: Map<string, string>): Tile | null {
  if (!t) return null;
  if (t.kind === 'leaf') return leaf(map.get(t.id) ?? t.id);
  return { ...t, id: uid('t'), children: t.children.map((c) => renameLeaves(c, map)!) };
}

/** Widgets stacked top-to-bottom (`v`) or side by side (`h`) through a tile. */
function count(t: Tile, axis: 'h' | 'v'): number {
  if (t.kind === 'leaf') return 1;
  const along = (axis === 'v' && t.dir === 'col') || (axis === 'h' && t.dir === 'row');
  const n = t.children.map((c) => count(c, axis));
  return along ? n.reduce((a, b) => a + b, 0) : Math.max(...n);
}

/**
 * Even out widget heights (`v`), widths (`h`) or both, like PowerPoint's
 * "distribute": each split shares its space by how many widgets are stacked
 * in each part, so every widget ends up the same size along that axis.
 */
export function distribute(t: Tile, axis: 'h' | 'v' | 'both'): Tile {
  if (t.kind === 'leaf') return t;
  const children = t.children.map((c) => distribute(c, axis));
  const hits = axis === 'both' || (axis === 'v' && t.dir === 'col') || (axis === 'h' && t.dir === 'row');
  if (!hits) return { ...t, children };
  const a = t.dir === 'col' ? 'v' : 'h';
  const n = children.map((c) => count(c, a));
  const total = n.reduce((x, y) => x + y, 0);
  return { ...t, children, sizes: n.map((k) => k / total) };
}

/** Path of splits from the root down to a widget. */
function pathTo(t: Tile, id: string): (Tile & { kind: 'split' })[] | null {
  if (t.kind === 'leaf') return t.id === id ? [] : null;
  for (const c of t.children) {
    const p = pathTo(c, id);
    if (p) return [t, ...p];
  }
  return null;
}

/** Distribute only within the column (`v`) or row (`h`) that holds the widget. */
export function distributeAround(t: Tile, id: string, axis: 'h' | 'v'): Tile {
  const dir = axis === 'v' ? 'col' : 'row';
  const scope = pathTo(t, id)
    ?.filter((s) => s.dir === dir)
    .pop();
  if (!scope) return t;
  const replace = (n: Tile): Tile => (n === scope ? distribute(n, axis) : n.kind === 'leaf' ? n : { ...n, children: n.children.map(replace) });
  return replace(t);
}

/** The widget right next to `id` on one side (most shared edge), if any. */
export function neighbor(t: Tile, id: string, side: Side): string | null {
  const rs = new Map<string, Rect>();
  rects(t, { x: 0, y: 0, w: 1, h: 1 }, rs);
  const r = rs.get(id);
  if (!r) return null;
  const eps = 1e-6;
  let best: string | null = null;
  let bestOverlap = eps;
  for (const [other, o] of rs) {
    if (other === id) continue;
    const touches =
      side === 'left' ? Math.abs(o.x + o.w - r.x) < eps : side === 'right' ? Math.abs(r.x + r.w - o.x) < eps : side === 'top' ? Math.abs(o.y + o.h - r.y) < eps : Math.abs(r.y + r.h - o.y) < eps;
    if (!touches) continue;
    const overlap =
      side === 'left' || side === 'right' ? Math.min(r.y + r.h, o.y + o.h) - Math.max(r.y, o.y) : Math.min(r.x + r.w, o.x + o.w) - Math.max(r.x, o.x);
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      best = other;
    }
  }
  return best;
}

/** Tile rectangles (px) for a worksheet of the given size. */
export function tileRects(t: Tile, box: { w: number; h: number }): Map<string, Rect> {
  const out = new Map<string, Rect>();
  rects(t, { x: 0, y: 0, w: box.w, h: box.h }, out);
  return out;
}

/** Put a new full-width row at the bottom, taking `frac` of the (grown) height. */
export function appendRow(t: Tile | null, newId: string, frac: number): Tile {
  if (!t) return leaf(newId);
  if (t.kind === 'split' && t.dir === 'col') return { ...t, children: [...t.children, leaf(newId)], sizes: [...t.sizes.map((s) => s * (1 - frac)), frac] };
  return split('col', [t, leaf(newId)], [1 - frac, frac]);
}
