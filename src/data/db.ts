import type { DataSource } from '../types';

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

function f64ToB64(a: Float64Array): string {
  const bytes = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode(...bytes.subarray(i, i + CH));
  return btoa(s);
}

function b64ToF64(s: string): Float64Array {
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Float64Array(bytes.buffer);
}

export interface SerializedSource {
  id: string;
  name: string;
  size: number;
  importedAt: number;
  timeColumn: string;
  time: string;
  columns: { name: string; values: string; min: number; max: number; mean: number }[];
}

export function serializeSource(s: DataSource): SerializedSource {
  return {
    ...s,
    time: f64ToB64(s.time),
    columns: s.columns.map((c) => ({ ...c, values: f64ToB64(c.values) })),
  };
}

export function deserializeSource(s: SerializedSource): DataSource {
  return {
    ...s,
    time: b64ToF64(s.time),
    columns: s.columns.map((c) => ({ ...c, values: b64ToF64(c.values) })),
  };
}
