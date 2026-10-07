import { lowerBound } from '../util';
import { aggregate, newAgg, type Blocks, type Values } from './blocks';

export interface Window {
  x: Float64Array;
  /** NaN marks a gap. */
  y: Float64Array;
  /** Raw sample count inside the requested window (before reduction). */
  raw: number;
}

/**
 * Slice [start, end] (plus one neighbour on each side so lines reach the edges)
 * and reduce to at most ~`maxPoints` with M4 aggregation: per time bucket keep
 * first / min / max / last. Every spike survives and the line shape is exact at
 * pixel resolution. Buckets are aggregated through the block index, so cost is
 * O(buckets + n / BLOCK) rather than O(n).
 */
export function windowed(
  time: Float64Array,
  values: Values,
  blocks: Blocks | undefined,
  start: number,
  end: number,
  maxPoints: number,
  scale = 1,
  offset = 0,
): Window {
  const i0 = Math.max(0, lowerBound(time, start) - 1);
  const i1 = Math.min(time.length, lowerBound(time, end) + 1);
  const n = Math.max(0, i1 - i0);
  const tr = (v: number) => v * scale + offset;

  if (!maxPoints || n <= maxPoints) {
    const y = new Float64Array(n);
    for (let i = 0; i < n; i++) y[i] = tr(values[i0 + i]);
    return { x: time.subarray(i0, i1), y, raw: n };
  }

  const buckets = Math.max(1, Math.floor(maxPoints / 4));
  const t0 = time[i0];
  const span = time[i1 - 1] - t0 || 1;
  const outX = new Float64Array(buckets * 4 + 2);
  const outY = new Float64Array(buckets * 4 + 2);
  const agg = newAgg();
  let o = 0;
  let a = i0;
  const idx = [0, 0, 0, 0];
  for (let k = 0; k < buckets && a < i1; k++) {
    const b = k === buckets - 1 ? i1 : Math.max(a, Math.min(i1, lowerBound(time, t0 + (span * (k + 1)) / buckets)));
    if (b <= a) continue;
    aggregate(values, blocks, a, b, agg);
    if (!agg.count) {
      // whole bucket is NaN → emit a single gap marker
      if (o > 0 && outY[o - 1] === outY[o - 1]) {
        outX[o] = time[a];
        outY[o++] = NaN;
      }
      a = b;
      continue;
    }
    let fi = a;
    while (values[fi] !== values[fi]) fi++;
    let li = b - 1;
    while (values[li] !== values[li]) li--;
    // a gap inside the bucket between first and last is kept visible
    idx[0] = fi;
    idx[1] = agg.minIdx;
    idx[2] = agg.maxIdx;
    idx[3] = li;
    idx.sort((p, q) => p - q);
    let prev = -1;
    for (const i of idx) {
      if (i === prev) continue;
      prev = i;
      outX[o] = time[i];
      outY[o++] = tr(values[i]);
    }
    a = b;
  }
  return { x: outX.subarray(0, o), y: outY.subarray(0, o), raw: n };
}

export interface Stats {
  min: number;
  max: number;
  mean: number;
  count: number;
}

/** Exact stats over the visible window (raw data, via the block index). */
export function windowStats(time: Float64Array, values: Values, blocks: Blocks | undefined, start: number, end: number, scale = 1, offset = 0): Stats {
  const i0 = lowerBound(time, start);
  const i1 = lowerBound(time, end + 1e-9);
  const g = aggregate(values, blocks, i0, i1, newAgg());
  if (!g.count) return { min: NaN, max: NaN, mean: NaN, count: 0 };
  const p = g.min * scale + offset;
  const q = g.max * scale + offset;
  return { min: Math.min(p, q), max: Math.max(p, q), mean: (g.sum / g.count) * scale + offset, count: g.count };
}
