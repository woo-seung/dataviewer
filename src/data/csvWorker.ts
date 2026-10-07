/// <reference lib="webworker" />
import Papa from 'papaparse';
import { parseNumber, parseTime, type TimeFormat } from './time';

export interface ParseRequest {
  file: File;
  delimiter: string;
  hasHeader: boolean;
  timeColumn: number;
  timeFormat: TimeFormat;
  /** Column indices to import as numeric series. */
  columns: number[];
  columnNames: string[];
}

export type WorkerMessage =
  | { type: 'progress'; loaded: number; total: number }
  | {
      type: 'done';
      time: Float64Array;
      columns: { name: string; values: Float64Array; min: number; max: number; mean: number }[];
      skipped: number;
    }
  | { type: 'error'; message: string };

class Growable {
  buf = new Float64Array(1 << 16);
  len = 0;
  push(v: number) {
    if (this.len === this.buf.length) {
      const n = new Float64Array(this.buf.length * 2);
      n.set(this.buf);
      this.buf = n;
    }
    this.buf[this.len++] = v;
  }
  done(): Float64Array {
    return this.buf.slice(0, this.len);
  }
}

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.addEventListener('message', (ev: MessageEvent<ParseRequest>) => {
  const req = ev.data;
  const time = new Growable();
  const cols = req.columns.map(() => new Growable());
  let skipped = 0;
  let first = req.hasHeader;
  const total = req.file.size;

  Papa.parse<string[]>(req.file, {
    delimiter: req.delimiter || undefined,
    skipEmptyLines: true,
    chunkSize: 1 << 22,
    chunk: (res) => {
      const rows = res.data;
      for (let r = 0; r < rows.length; r++) {
        if (first) {
          first = false;
          continue;
        }
        const row = rows[r];
        const t = parseTime(row[req.timeColumn] ?? '', req.timeFormat);
        if (!Number.isFinite(t)) {
          skipped++;
          continue;
        }
        time.push(t);
        for (let c = 0; c < cols.length; c++) cols[c].push(parseNumber(row[req.columns[c]] ?? ''));
      }
      ctx.postMessage({ type: 'progress', loaded: res.meta.cursor, total } satisfies WorkerMessage);
    },
    complete: () => {
      try {
        let t = time.done();
        let values = cols.map((c) => c.done());
        // Sort by time when the file is not monotonic.
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
          values = values.map((v) => {
            const nv = new Float64Array(v.length);
            for (let i = 0; i < idx.length; i++) nv[i] = v[idx[i]];
            return nv;
          });
          t = nt;
        }
        const columns = values.map((v, i) => {
          let min = Infinity;
          let max = -Infinity;
          let sum = 0;
          let n = 0;
          for (let k = 0; k < v.length; k++) {
            const x = v[k];
            if (x === x) {
              if (x < min) min = x;
              if (x > max) max = x;
              sum += x;
              n++;
            }
          }
          return { name: req.columnNames[i], values: v, min: n ? min : NaN, max: n ? max : NaN, mean: n ? sum / n : NaN };
        });
        const msg: WorkerMessage = { type: 'done', time: t, columns, skipped };
        ctx.postMessage(msg, [t.buffer, ...columns.map((c) => c.values.buffer)]);
      } catch (e) {
        ctx.postMessage({ type: 'error', message: String(e) } satisfies WorkerMessage);
      }
    },
    error: (err) => ctx.postMessage({ type: 'error', message: err.message } satisfies WorkerMessage),
  });
});
