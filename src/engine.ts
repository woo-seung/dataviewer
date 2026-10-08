/**
 * Client for the Rust data engine. In the desktop app every call goes through
 * one Tauri command; for browser tests the same protocol runs over the HTTP
 * bridge (`?bridge=http://127.0.0.1:7878`). Replies are a tag byte (0 = JSON,
 * 1 = binary) followed by the payload.
 */
import type { ColumnInfo, ImportSettings, SourceInfo } from './types';
import type { TimeFormat } from './data/time';
import { uid } from './util';

type Listener = (event: string, payload: Record<string, unknown>) => void;

interface Transport {
  call(cmd: string, args: unknown): Promise<ArrayBuffer>;
  listen(fn: Listener): void;
}

const tauri = (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
export const isDesktop = !!tauri;

function bridgeUrl(): string | null {
  const q = new URLSearchParams(location.search).get('bridge');
  return q || null;
}

async function tauriTransport(): Promise<Transport> {
  const { invoke } = await import('@tauri-apps/api/core');
  const { listen } = await import('@tauri-apps/api/event');
  return {
    call: (cmd, args) => invoke<ArrayBuffer>('engine', { cmd, args }),
    listen: (fn) => {
      void listen<{ event: string; payload: Record<string, unknown> }>('engine-event', (e) => fn(e.payload.event, e.payload.payload));
    },
  };
}

function httpTransport(base: string): Transport {
  const listeners: Listener[] = [];
  let polling = false;
  const poll = async () => {
    if (polling) return;
    polling = true;
    while (listeners.length) {
      try {
        const r = await fetch(`${base}/events`);
        const list = (await r.json()) as { event: string; payload: Record<string, unknown> }[];
        for (const e of list) listeners.forEach((l) => l(e.event, e.payload));
      } catch {
        /* bridge restarting */
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    polling = false;
  };
  return {
    async call(cmd, args) {
      const r = await fetch(`${base}/call/${cmd}`, { method: 'POST', body: JSON.stringify(args ?? {}) });
      if (!r.ok) throw new Error(await r.text());
      return r.arrayBuffer();
    },
    listen(fn) {
      listeners.push(fn);
      void poll();
    },
  };
}

let transport: Promise<Transport> | null = null;
const listeners = new Set<Listener>();

function getTransport(): Promise<Transport> {
  if (!transport) {
    transport = (async () => {
      const b = bridgeUrl();
      const t = tauri ? await tauriTransport() : b ? httpTransport(b) : null;
      if (!t) throw new Error('데이터 엔진에 연결할 수 없습니다. 데스크톱 앱으로 실행하세요.');
      t.listen((ev, p) => listeners.forEach((l) => l(ev, p)));
      return t;
    })();
  }
  return transport;
}

export const hasEngine = !!tauri || !!bridgeUrl();

async function raw(cmd: string, args: unknown = {}): Promise<ArrayBuffer> {
  const t = await getTransport();
  try {
    return await t.call(cmd, args);
  } catch (e) {
    throw new Error(typeof e === 'string' ? e : (e as Error).message);
  }
}

async function json<T>(cmd: string, args: unknown = {}): Promise<T> {
  const buf = await raw(cmd, args);
  const bytes = new Uint8Array(buf);
  if (bytes[0] !== 0) throw new Error(`unexpected binary reply for ${cmd}`);
  return JSON.parse(new TextDecoder().decode(bytes.subarray(1))) as T;
}

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

export interface Memory {
  totalMb: number;
  availableMb: number;
  processMb: number;
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
  phase: 'parse' | 'index' | 'reprocess';
  name?: string;
}

export interface OpenResult {
  workspace: unknown;
  sources: SourceInfo[];
  notes: string[];
  reprocessed: string[];
}

export interface Job<T> {
  promise: Promise<T>;
  cancel: () => void;
}

function withJob<T>(run: (job: string) => Promise<T>, onProgress?: (p: Progress) => void): Job<T> {
  const job = uid('job');
  const l: Listener = (ev, p) => {
    if (ev === 'progress' && p.job === job) onProgress?.(p as unknown as Progress);
  };
  listeners.add(l);
  const promise = run(job).finally(() => listeners.delete(l));
  return { promise, cancel: () => void json('cancel', { job }).catch(() => undefined) };
}

export const engine = {
  appInfo: () => json<{ dataDir: string; logPath: string | null; memory: Memory; launchFiles: string[]; version: string }>('app_info'),
  memory: () => json<Memory>('memory'),
  log: (msg: string) => json<boolean>('log', { msg }).catch(() => false),
  reveal: (path: string) => json<boolean>('reveal', { path }),
  preview: (path: string, delimiter = '') => json<CsvPreview>('preview', { path, delimiter }),
  import: (path: string, settings: ImportSettings, onProgress?: (p: Progress) => void, id?: string): Job<SourceInfo> =>
    withJob((job) => json<SourceInfo>('import', { path, settings, id, job }), onProgress),
  open: (path: string, onProgress?: (p: Progress) => void): Job<OpenResult> => withJob((job) => json<OpenResult>('open', { path, job }), onProgress),
  save: (path: string, workspace: unknown, sources: string[]) =>
    json<{ fileSize: number; written: number; rewrote: boolean; ms: number }>('save', { path, workspace, sources }),
  remove: (id: string) => json<boolean>('remove', { id }),
  clear: () => json<boolean>('clear'),
  stat: (path: string) => json<{ exists: boolean; size?: number; lastModified?: number }>('stat', { path }),
  sample: () => json<{ path: string }>('sample'),
  writeFile: (path: string, data: Uint8Array) => json<boolean>('write_file', { path, base64: toBase64(data) }),
  exportCsv: (path: string, series: (SeriesKey & { label: string; scale: number; offset: number })[], start: number, end: number) =>
    json<{ rows: number }>('export_csv', { path, series, start, end }),
  stats: (series: SeriesKey[], start: number, end: number) => json<(Stats | null)[]>('stats', { series, start, end }),
  values: (series: SeriesKey[], t: number) => json<(number | null)[]>('values', { series, t }),
  /** Downsampled windows, fetched in slices so no single IPC reply grows past ~8 MB. */
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
  const buf = (await raw('window', { series, start, end, maxPoints })).slice(1);
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

function toBase64(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

export type { ColumnInfo };
