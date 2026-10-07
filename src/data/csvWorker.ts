/// <reference lib="webworker" />
import Papa from 'papaparse';
import { buildBlocks, type Blocks } from './blocks';
import { parseNumber, parseTime, type TimeFormat } from './time';
import { QuoteFound, scanChunk } from './fastCsv';

export interface ParseRequest {
  file: File;
  delimiter: string;
  hasHeader: boolean;
  timeColumn: number;
  timeFormat: TimeFormat;
  /** Column indices to import as numeric series. */
  columns: number[];
  columnNames: string[];
  /** Store values as Float32 (half memory, ~7 significant digits). */
  compact: boolean;
  /** Row count estimate from the preview, used to pre-size buffers. */
  estimatedRows: number;
  /** Preview saw no quote characters → try the byte-level fast path. */
  noQuotes: boolean;
}

export interface ParsedColumn {
  name: string;
  values: Float64Array | Float32Array;
  blocks: Blocks;
  min: number;
  max: number;
  mean: number;
}

export type WorkerMessage =
  | { type: 'progress'; loaded: number; total: number; rows: number }
  | { type: 'done'; time: Float64Array; columns: ParsedColumn[]; skipped: number }
  | { type: 'error'; message: string };

type Ctor = Float64ArrayConstructor | Float32ArrayConstructor;

/** Typed buffer that grows by 1.5× (pre-sized from the estimate to avoid most copies). */
class Growable<T extends Float64Array | Float32Array> {
  buf: T;
  len = 0;
  constructor(
    private C: Ctor,
    cap: number,
  ) {
    this.buf = new C(Math.max(1024, cap)) as T;
  }
  push(v: number) {
    if (this.len === this.buf.length) {
      const n = new this.C(Math.ceil(this.buf.length * 1.5)) as T;
      n.set(this.buf);
      this.buf = n;
    }
    this.buf[this.len++] = v;
  }
  /** Trim unused capacity only when it is worth a copy. */
  done(): T {
    if (this.len === this.buf.length) return this.buf;
    if (this.buf.length - this.len < this.buf.length * 0.05) return this.buf.subarray(0, this.len) as T;
    return this.buf.slice(0, this.len) as T;
  }
}

const ctx = self as unknown as DedicatedWorkerGlobalScope;

function finish(req: ParseRequest, VC: Ctor, time: Growable<Float64Array>, cols: Growable<Float64Array | Float32Array>[], skipped: number) {
  try {
    let t = time.done();
    let values: (Float64Array | Float32Array)[] = cols.map((c) => c.done());
    let sorted = true;
    for (let i = 1; i < t.length; i++) {
      if (t[i] < t[i - 1]) {
        sorted = false;
        break;
      }
    }
    if (!sorted) {
      const idx = new Uint32Array(t.length);
      for (let i = 0; i < idx.length; i++) idx[i] = i;
      const tt = t;
      idx.sort((a, b) => tt[a] - tt[b]);
      const nt = new Float64Array(t.length);
      for (let i = 0; i < idx.length; i++) nt[i] = t[idx[i]];
      t = nt;
      values = values.map((v) => {
        const nv = new VC(v.length);
        for (let i = 0; i < idx.length; i++) nv[i] = v[idx[i]];
        return nv;
      });
    }
    const columns: ParsedColumn[] = values.map((v, i) => {
      const blocks = buildBlocks(v);
      let min = Infinity;
      let max = -Infinity;
      let sum = 0;
      let n = 0;
      for (let k = 0; k < blocks.count.length; k++) {
        if (!blocks.count[k]) continue;
        if (blocks.min[k] < min) min = blocks.min[k];
        if (blocks.max[k] > max) max = blocks.max[k];
        sum += blocks.sum[k];
        n += blocks.count[k];
      }
      return { name: req.columnNames[i], values: v, blocks, min: n ? min : NaN, max: n ? max : NaN, mean: n ? sum / n : NaN };
    });
    const transfer: Transferable[] = [t.buffer];
    for (const c of columns) {
      transfer.push(c.values.buffer, c.blocks.min.buffer, c.blocks.max.buffer, c.blocks.minIdx.buffer, c.blocks.maxIdx.buffer, c.blocks.sum.buffer, c.blocks.count.buffer);
    }
    ctx.postMessage({ type: 'done', time: t, columns, skipped } satisfies WorkerMessage, transfer);
  } catch (e) {
    ctx.postMessage({ type: 'error', message: e instanceof RangeError ? OOM : String(e) } satisfies WorkerMessage);
  }
}

const OOM = '메모리가 부족합니다. 열 수를 줄이거나 32-bit 모드로 가져오세요.';
const CHUNK = 16 << 20;

/** Byte-level path; resolves false when a quote shows up and the general parser must take over. */
async function fastPath(req: ParseRequest, time: Growable<Float64Array>, cols: Growable<Float64Array | Float32Array>[], onSkip: () => void): Promise<boolean> {
  const maxField = Math.max(req.timeColumn, ...req.columns) + 1;
  const slotOf = new Int32Array(maxField).fill(-1);
  req.columns.forEach((f, s) => (slotOf[f] = s));
  const opts = { delimiter: req.delimiter.charCodeAt(0), hasHeader: req.hasHeader, timeColumn: req.timeColumn, timeFormat: req.timeFormat, slotOf };
  const sink = {
    slots: cols.length,
    row: (t: number) => time.push(t),
    value: (s: number, v: number) => cols[s].push(v),
    skipped: onSkip,
  };
  const state = { header: req.hasHeader };
  const total = req.file.size;
  let pos = 0;
  let carry: Uint8Array | null = null;
  let lastPost = 0;
  try {
    while (pos < total) {
      const next = Math.min(total, pos + CHUNK);
      let buf = new Uint8Array(await req.file.slice(pos, next).arrayBuffer());
      if (pos === 0 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) buf = buf.subarray(3);
      if (carry?.length) {
        const joined = new Uint8Array(carry.length + buf.length);
        joined.set(carry);
        joined.set(buf, carry.length);
        buf = joined;
      }
      pos = next;
      const rest = scanChunk(buf, pos >= total, opts, sink, state);
      carry = rest < buf.length ? buf.slice(rest) : null;
      const now = performance.now();
      if (now - lastPost > 100) {
        lastPost = now;
        ctx.postMessage({ type: 'progress', loaded: pos, total, rows: time.len } satisfies WorkerMessage);
      }
    }
    return true;
  } catch (e) {
    if (e instanceof QuoteFound) return false;
    throw e;
  }
}

ctx.addEventListener('message', async (ev: MessageEvent<ParseRequest>) => {
  const req = ev.data;
  const cap = Math.ceil(req.estimatedRows * 1.08) + 1024;
  const VC: Ctor = req.compact ? Float32Array : Float64Array;
  let time = new Growable<Float64Array>(Float64Array, cap);
  let cols = req.columns.map(() => new Growable<Float64Array | Float32Array>(VC, cap));
  let skipped = 0;
  const total = req.file.size;

  try {
    if (req.noQuotes && req.delimiter.length === 1 && req.delimiter.charCodeAt(0) < 128) {
      if (await fastPath(req, time, cols, () => skipped++)) {
        ctx.postMessage({ type: 'progress', loaded: total, total, rows: time.len } satisfies WorkerMessage);
        finish(req, VC, time, cols, skipped);
        return;
      }
      // quoted fields found: start over with the general parser
      time = new Growable<Float64Array>(Float64Array, cap);
      cols = req.columns.map(() => new Growable<Float64Array | Float32Array>(VC, cap));
      skipped = 0;
    }
  } catch (e) {
    ctx.postMessage({ type: 'error', message: e instanceof RangeError ? OOM : String(e) } satisfies WorkerMessage);
    return;
  }

  const colIdx = req.columns;
  const nc = cols.length;
  const tc = req.timeColumn;
  const fmt = req.timeFormat;
  let first = req.hasHeader;
  let lastPost = 0;
  Papa.parse<string[]>(req.file, {
    delimiter: req.delimiter || undefined,
    skipEmptyLines: true,
    chunkSize: 1 << 23,
    chunk: (res) => {
      const rows = res.data;
      for (let r = 0; r < rows.length; r++) {
        if (first) {
          first = false;
          continue;
        }
        const row = rows[r];
        const t = parseTime(row[tc] ?? '', fmt);
        if (t !== t) {
          skipped++;
          continue;
        }
        time.push(t);
        for (let c = 0; c < nc; c++) cols[c].push(parseNumber(row[colIdx[c]] ?? ''));
      }
      const now = performance.now();
      if (now - lastPost > 100) {
        lastPost = now;
        ctx.postMessage({ type: 'progress', loaded: res.meta.cursor, total, rows: time.len } satisfies WorkerMessage);
      }
    },
    complete: () => {
      ctx.postMessage({ type: 'progress', loaded: total, total, rows: time.len } satisfies WorkerMessage);
      finish(req, VC, time, cols, skipped);
    },
    error: (err) => ctx.postMessage({ type: 'error', message: err.message } satisfies WorkerMessage),
  });
});

// Allocation failures while growing buffers surface here.
ctx.addEventListener('error', (e) => {
  ctx.postMessage({ type: 'error', message: /allocation|memory|Array buffer/i.test(e.message) ? OOM : e.message } satisfies WorkerMessage);
});
