/**
 * Client for the data engine, which runs in a Web Worker (src/engineWorker.ts)
 * as WebAssembly. Every call is a message; chart windows come back as
 * transferred binary buffers.
 */
import type { ColumnInfo, ImportSettings, SourceInfo } from './types';
import type { TimeFormat } from './data/time';
import { uid } from './util';

type Listener = (event: string, payload: Record<string, unknown>) => void;

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
const listeners = new Set<Listener>();

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./engineWorker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent) => {
      const m = e.data as { id?: number; ok?: boolean; result?: unknown; error?: string; event?: string; payload?: Record<string, unknown> };
      if (m.event) {
        listeners.forEach((l) => l(m.event!, m.payload ?? {}));
        return;
      }
      const p = pending.get(m.id!);
      if (!p) return;
      pending.delete(m.id!);
      if (m.ok) p.resolve(m.result);
      else p.reject(new Error(m.error));
    };
    worker.onerror = (e) => {
      log(`worker error: ${e.message}`);
      for (const p of pending.values()) p.reject(new Error(`데이터 엔진 오류: ${e.message}`));
      pending.clear();
    };
  }
  return worker;
}

function call<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  const id = ++seq;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    getWorker().postMessage({ id, cmd, args });
  });
}

// ---------- diagnostics: a small in-memory log the user can save ----------

const LOG_MAX = 2000;
const logLines: string[] = [];

export function log(msg: string) {
  const line = `${new Date().toISOString()} ${msg}`;
  logLines.push(line);
  if (logLines.length > LOG_MAX) logLines.splice(0, logLines.length - LOG_MAX);
  console.info('[chronos]', msg);
}

export const logText = () => logLines.join('\n') + '\n';

// ---------- types ----------

export interface CsvPreview {
  delimiter: string;
  hasHeader: boolean;
  header: string[];
  rows: string[][];
  timeColumn: number;
  numericColumns: number[];
  estimatedRows: number;
  size: number;
  timeFormat: TimeFormat;
}

export interface Win {
  x: Float64Array;
  y: Float64Array;
  raw: number;
}

export interface Stats {
  min: number | null;
  max: number | null;
  mean: number | null;
  count: number;
}

export interface SeriesKey {
  source: string;
  column: string;
}

export interface Progress {
  loaded: number;
  total: number;
  phase: 'parse' | 'index' | 'reprocess' | 'load';
  name?: string;
}

export interface OpenResult {
  workspace: unknown;
  sources: SourceInfo[];
  notes: string[];
  reprocessed: string[];
}

export interface PeekResult {
  workspace: unknown;
  sources: { id: string; name: string; size: number; lastModified: number; rows: number }[];
}

export interface Job<T> {
  promise: Promise<T>;
  cancel: () => void;
}

/** Where a workspace file lives: a file the user picked, or the browser's private storage. */
export type SaveTarget = { handle: FileSystemFileHandle } | { opfs: string };

export interface SaveResult {
  fileSize: number;
  written: number;
  rewrote: boolean;
  ms: number;
}

function withJob<T>(run: (job: string) => Promise<T>, onProgress?: (p: Progress) => void): Job<T> {
  const job = uid('job');
  const l: Listener = (ev, p) => {
    if (ev === 'progress' && p.job === job) onProgress?.(p as unknown as Progress);
  };
  listeners.add(l);
  const promise = run(job).finally(() => listeners.delete(l));
  return { promise, cancel: () => void call('cancel', { job }).catch(() => undefined) };
}

/** Largest data the engine can hold (32-bit WebAssembly memory). */
export const ENGINE_LIMIT = 4 * 1024 ** 3;

export const engine = {
  info: () => call<{ memoryBytes: number }>('info'),
  preview: (file: File, delimiter = '') => call<CsvPreview>('preview', { file, delimiter }),
  import: (file: File, settings: ImportSettings, onProgress?: (p: Progress) => void, id?: string): Job<SourceInfo & { skipped?: number }> =>
    withJob((job) => call('import', { file, settings, id, job }), onProgress),
  peek: (file: File) => call<PeekResult>('peek', { file }),
  /** Load a workspace; `csv` maps source ids to their current CSV (null = known to be gone). */
  open: (file: File, csv: Record<string, File | null>, onProgress?: (p: Progress) => void): Job<OpenResult> =>
    withJob((job) => call('open', { file, csv, job }), onProgress),
  save: (target: SaveTarget, workspace: unknown, sources: string[]) => call<SaveResult>('save', { target, workspace, sources }),
  opfsFile: (name: string) => call<File | null>('opfs_file', { name }),
  opfsRemove: (name: string) => call<boolean>('opfs_remove', { name }),
  remove: (id: string) => call<boolean>('remove', { id }),
  clear: () => call<boolean>('clear'),
  sample: () => call<Blob>('sample'),
  exportCsv: (series: (SeriesKey & { label: string; scale: number; offset: number })[], start: number, end: number) =>
    call<Blob>('export_csv', { series, start, end }),
  stats: (series: SeriesKey[], start: number, end: number) => call<(Stats | null)[]>('stats', { series, start, end }),
  values: (series: SeriesKey[], t: number) => call<(number | null)[]>('values', { series, t }),
  /** Time of the sample nearest to t, per series. */
  times: (series: SeriesKey[], t: number) => call<(number | null)[]>('times', { series, t }),
  /** Downsampled windows, fetched in slices so no single reply grows past ~8 MB. */
  async window(series: SeriesKey[], start: number, end: number, maxPoints: number): Promise<(Win | null)[]> {
    const perSeries = 8 * (maxPoints > 0 ? maxPoints : 1_000_000);
    const step = Math.max(1, Math.floor(REPLY_BUDGET / perSeries));
    const out: (Win | null)[] = [];
    for (let i = 0; i < series.length; i += step) out.push(...(await windowSlice(series.slice(i, i + step), start, end, maxPoints)));
    return out;
  },
};

const REPLY_BUDGET = 8 * 1024 * 1024;

async function windowSlice(series: SeriesKey[], start: number, end: number, maxPoints: number): Promise<(Win | null)[]> {
  const bytes = await call<Uint8Array>('window', { series, start, end, maxPoints });
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  // f64 header [n, base, (len, raw)*n], then per series f32 x-offsets + f32 y
  const n = new Float64Array(buf, 0, 1)[0];
  const head = new Float64Array(buf, 0, 2 + n * 2);
  const base = head[1];
  const data = new Float32Array(buf, head.byteLength);
  const out: (Win | null)[] = [];
  let o = 0;
  for (let i = 0; i < n; i++) {
    const len = head[2 + i * 2];
    const rawN = head[3 + i * 2];
    if (!len && !rawN) {
      out.push(null);
      continue;
    }
    const x = new Float64Array(len);
    for (let k = 0; k < len; k++) x[k] = base + data[o + k];
    out.push({ x, y: Float64Array.from(data.subarray(o + len, o + 2 * len)), raw: rawN });
    o += 2 * len;
  }
  return out;
}

export type { ColumnInfo };
