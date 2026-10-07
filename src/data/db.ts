import type { DataSource } from '../types';
import { buildBlocks } from './blocks';

const DB_NAME = 'chronos-vault';
const STORE = 'sources';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    t.oncomplete = () => db.close();
  });
}

export const sourceDb = {
  put: (s: DataSource) => tx('readwrite', (st) => st.put(s)).catch((e) => console.warn('IndexedDB put failed', e)),
  delete: (id: string) => tx('readwrite', (st) => st.delete(id)).catch((e) => console.warn('IndexedDB delete failed', e)),
  clear: () => tx('readwrite', (st) => st.clear()).catch(() => undefined),
  all: async (): Promise<DataSource[]> => {
    try {
      return (await tx('readonly', (st) => st.getAll())) as DataSource[];
    } catch (e) {
      console.warn('IndexedDB unavailable', e);
      return [];
    }
  },
};

// ---- workspace file (de)serialisation with embedded data ----

export function sourceBytes(s: DataSource): number {
  return s.time.byteLength + s.columns.reduce((n, c) => n + c.values.byteLength, 0);
}

/** Make sure every column has its summary index (older caches/files lack it). */
export function ensureBlocks(s: DataSource): DataSource {
  for (const c of s.columns) if (!c.blocks) c.blocks = buildBlocks(c.values);
  return s;
}

function f64ToB64(a: Float64Array | Float32Array): string {
  const bytes = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode(...bytes.subarray(i, i + CH));
  return btoa(s);
}

function b64ToArr(s: string, dtype: 'f64' | 'f32' = 'f64'): Float64Array | Float32Array {
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return dtype === 'f32' ? new Float32Array(bytes.buffer) : new Float64Array(bytes.buffer);
}

export interface SerializedSource {
  id: string;
  name: string;
  size: number;
  importedAt: number;
  timeColumn: string;
  time: string;
  columns: { name: string; values: string; dtype?: 'f64' | 'f32'; min: number; max: number; mean: number }[];
}

export function serializeSource(s: DataSource): SerializedSource {
  return {
    ...s,
    time: f64ToB64(s.time),
    columns: s.columns.map((c) => ({
      name: c.name,
      min: c.min,
      max: c.max,
      mean: c.mean,
      dtype: c.values instanceof Float32Array ? ('f32' as const) : ('f64' as const),
      values: f64ToB64(c.values),
    })),
  };
}

export function deserializeSource(s: SerializedSource): DataSource {
  return ensureBlocks({
    ...s,
    time: b64ToArr(s.time) as Float64Array,
    columns: s.columns.map((c) => ({ name: c.name, min: c.min, max: c.max, mean: c.mean, values: b64ToArr(c.values, c.dtype) })),
  });
}
