import { lowerBound } from '../util';

export interface Window {
  x: Float64Array;
  y: Float64Array;
  /** Raw sample count inside the requested window (before reduction). */
  raw: number;
}

/**
 * Slice [start, end] (plus one neighbour on each side so lines reach the edges)
 * and reduce to at most `maxPoints` with an M4 aggregation: per pixel-bucket keep
 * first / min / max / last. That preserves every spike and the line shape while
 * keeping WebGL traces small. NaN runs stay as gaps.
 */
export function windowed(
  time: Float64Array,
  values: Float64Array,
  start: number,
  end: number,
  maxPoints: number,
  scale = 1,
  offset = 0,
): Window {
  const i0 = Math.max(0, lowerBound(time, start) - 1);
  const i1 = Math.min(time.length, lowerBound(time, end) + 1);
  const n = Math.max(0, i1 - i0);
  const tr = scale !== 1 || offset !== 0;

  if (!maxPoints || n <= maxPoints) {
    const x = time.subarray(i0, i1);
    let y = values.subarray(i0, i1);
    if (tr) {
      const t = new Float64Array(n);
      for (let i = 0; i < n; i++) t[i] = y[i] * scale + offset;
      y = t;
    }
    return { x, y, raw: n };
  }

  const buckets = Math.max(1, Math.floor(maxPoints / 4));
  const span = time[i1 - 1] - time[i0] || 1;
  const outX = new Float64Array(buckets * 4 + 2);
  const outY = new Float64Array(buckets * 4 + 2);
  let o = 0;
  let i = i0;
  for (let b = 0; b < buckets && i < i1; b++) {
    const bEnd = b === buckets - 1 ? Infinity : time[i0] + (span * (b + 1)) / buckets;
    let fi = -1;
    let li = -1;
    let mni = -1;
    let mxi = -1;
    let sawNaN = false;
    for (; i < i1 && time[i] < bEnd; i++) {
      const v = values[i];
      if (v !== v) {
        sawNaN = true;
        continue;
      }
      if (fi < 0) fi = i;
      li = i;
      if (mni < 0 || v < values[mni]) mni = i;
      if (mxi < 0 || v > values[mxi]) mxi = i;
    }
    if (fi < 0) {
      if (sawNaN && o > 0 && outY[o - 1] === outY[o - 1]) {
        outX[o] = time[i - 1];
        outY[o++] = NaN;
      }
      continue;
    }
    // emit in index order, de-duplicated
    const idx = [fi, mni, mxi, li].sort((a, c) => a - c);
    let prev = -1;
    for (const k of idx) {
      if (k === prev) continue;
      prev = k;
      outX[o] = time[k];
      outY[o++] = tr ? values[k] * scale + offset : values[k];
    }
  }
  return { x: outX.subarray(0, o), y: outY.subarray(0, o), raw: n };
}

export interface Stats {
  min: number;
  max: number;
  mean: number;
  count: number;
}

/** Stats over the visible window (raw data, not the reduced trace). */
export function windowStats(time: Float64Array, values: Float64Array, start: number, end: number, scale = 1, offset = 0): Stats {
  const i0 = lowerBound(time, start);
  const i1 = lowerBound(time, end + 1e-9);
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let count = 0;
  for (let i = i0; i < i1; i++) {
    const v = values[i];
    if (v !== v) continue;
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
    count++;
  }
  if (!count) return { min: NaN, max: NaN, mean: NaN, count: 0 };
  const a = min * scale + offset;
  const b = max * scale + offset;
  return { min: Math.min(a, b), max: Math.max(a, b), mean: (sum / count) * scale + offset, count };
}
