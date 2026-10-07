/**
 * Block summary index over one column: for every BLOCK consecutive rows we keep
 * min/max (with their row index), sum and non-NaN count. Window statistics and
 * M4 reduction then touch ~n/BLOCK summaries instead of n raw samples, so
 * zooming across tens of millions of rows stays interactive.
 */
export const BLOCK = 64;

export type Values = Float64Array | Float32Array;

export interface Blocks {
  min: Float64Array;
  max: Float64Array;
  minIdx: Uint32Array;
  maxIdx: Uint32Array;
  sum: Float64Array;
  count: Uint32Array;
}

export function buildBlocks(v: Values): Blocks {
  const nb = Math.ceil(v.length / BLOCK);
  const b: Blocks = {
    min: new Float64Array(nb),
    max: new Float64Array(nb),
    minIdx: new Uint32Array(nb),
    maxIdx: new Uint32Array(nb),
    sum: new Float64Array(nb),
    count: new Uint32Array(nb),
  };
  for (let k = 0; k < nb; k++) {
    const a = k * BLOCK;
    const e = Math.min(v.length, a + BLOCK);
    let mn = Infinity;
    let mx = -Infinity;
    let mni = a;
    let mxi = a;
    let s = 0;
    let c = 0;
    for (let i = a; i < e; i++) {
      const x = v[i];
      if (x !== x) continue;
      if (x < mn) {
        mn = x;
        mni = i;
      }
      if (x > mx) {
        mx = x;
        mxi = i;
      }
      s += x;
      c++;
    }
    b.min[k] = c ? mn : NaN;
    b.max[k] = c ? mx : NaN;
    b.minIdx[k] = mni;
    b.maxIdx[k] = mxi;
    b.sum[k] = s;
    b.count[k] = c;
  }
  return b;
}

export interface Agg {
  min: number;
  max: number;
  minIdx: number;
  maxIdx: number;
  sum: number;
  count: number;
}

/** Aggregate rows [a, b) using raw samples at the ragged edges and block summaries in between. */
export function aggregate(v: Values, bl: Blocks | undefined, a: number, b: number, out: Agg): Agg {
  out.min = Infinity;
  out.max = -Infinity;
  out.minIdx = -1;
  out.maxIdx = -1;
  out.sum = 0;
  out.count = 0;
  const raw = (from: number, to: number) => {
    for (let i = from; i < to; i++) {
      const x = v[i];
      if (x !== x) continue;
      if (x < out.min) {
        out.min = x;
        out.minIdx = i;
      }
      if (x > out.max) {
        out.max = x;
        out.maxIdx = i;
      }
      out.sum += x;
      out.count++;
    }
  };
  if (!bl || b - a < BLOCK * 2) {
    raw(a, b);
    return out;
  }
  const k0 = Math.ceil(a / BLOCK);
  const k1 = Math.floor(b / BLOCK);
  raw(a, k0 * BLOCK);
  for (let k = k0; k < k1; k++) {
    const c = bl.count[k];
    if (!c) continue;
    if (bl.min[k] < out.min) {
      out.min = bl.min[k];
      out.minIdx = bl.minIdx[k];
    }
    if (bl.max[k] > out.max) {
      out.max = bl.max[k];
      out.maxIdx = bl.maxIdx[k];
    }
    out.sum += bl.sum[k];
    out.count += c;
  }
  raw(k1 * BLOCK, b);
  return out;
}

export function newAgg(): Agg {
  return { min: Infinity, max: -Infinity, minIdx: -1, maxIdx: -1, sum: 0, count: 0 };
}
