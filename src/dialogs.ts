/**
 * Browser file access. Chrome/Edge give file handles (File System Access API)
 * that can be written back and remembered across visits in IndexedDB;
 * elsewhere files are opened with a file input and saved as downloads.
 * Browser tests inject `window.__chronosTest` instead of the native pickers.
 */

export interface Picked {
  file: File;
  handle?: FileSystemFileHandle;
}

type Kind = 'csv' | 'workspace' | 'any' | 'plugin';

interface PickerType {
  description: string;
  accept: Record<string, string[]>;
}

const CSV_TYPE: PickerType = { description: 'CSV', accept: { 'text/csv': ['.csv', '.tsv', '.txt'] } };
const WS_TYPE: PickerType = { description: 'Chronos 워크스페이스', accept: { 'application/octet-stream': ['.chronos'] } };
const PNG_TYPE: PickerType = { description: 'PNG', accept: { 'image/png': ['.png'] } };
const JS_TYPE: PickerType = { description: '차트 플러그인', accept: { 'text/javascript': ['.js', '.mjs', '.txt'] } };

type W = typeof window & {
  showOpenFilePicker?: (o?: { id?: string; multiple?: boolean; types?: PickerType[]; excludeAcceptAllOption?: boolean }) => Promise<FileSystemFileHandle[]>;
  showSaveFilePicker?: (o?: { id?: string; suggestedName?: string; types?: PickerType[] }) => Promise<FileSystemFileHandle>;
};
const w = window as W;

interface TestHooks {
  open?: (kind: string, multiple: boolean) => Promise<(File | Picked)[] | null>;
  save?: (kind: string, name: string) => Promise<FileSystemFileHandle | null>;
}
const test = () => (window as unknown as { __chronosTest?: TestHooks }).__chronosTest;

/** Opening and saving through handles (Chrome, Edge). */
export const fsa = typeof w.showOpenFilePicker === 'function' && typeof w.showSaveFilePicker === 'function';

const typesFor = (kind: Kind) => (kind === 'plugin' ? [JS_TYPE] : kind === 'csv' ? [CSV_TYPE] : kind === 'workspace' ? [WS_TYPE] : [WS_TYPE, CSV_TYPE]);

export async function pickFiles(kind: Kind, multiple = true): Promise<Picked[]> {
  const t = test()?.open;
  if (t) return ((await t(kind, multiple)) ?? []).map((f) => (f instanceof File ? { file: f } : f));
  if (fsa) {
    try {
      const hs = await w.showOpenFilePicker!({ id: kind === 'workspace' ? 'chronos-ws' : kind === 'plugin' ? 'chronos-plugin' : 'chronos-csv', multiple, types: typesFor(kind) });
      return Promise.all(hs.map(async (handle) => ({ handle, file: await handle.getFile() })));
    } catch (e) {
      if ((e as Error).name === 'AbortError') return [];
      throw e;
    }
  }
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = multiple;
    input.accept = kind === 'plugin' ? '.js,.mjs,.txt' : kind === 'csv' ? '.csv,.tsv,.txt' : kind === 'workspace' ? '.chronos' : '.chronos,.csv,.tsv,.txt';
    input.addEventListener('change', () => resolve([...(input.files ?? [])].map((file) => ({ file }))));
    input.addEventListener('cancel', () => resolve([]));
    input.click();
  });
}

/** Ask where to save. Null = cancelled or not supported (use `download`). */
export async function pickSave(kind: 'workspace' | 'csv' | 'png', suggestedName: string): Promise<FileSystemFileHandle | null> {
  const t = test()?.save;
  if (t) return t(kind, suggestedName);
  if (!fsa) return null;
  try {
    return await w.showSaveFilePicker!({
      id: kind === 'workspace' ? 'chronos-ws' : `chronos-${kind}`,
      suggestedName,
      types: [kind === 'workspace' ? WS_TYPE : kind === 'csv' ? CSV_TYPE : PNG_TYPE],
    });
  } catch (e) {
    if ((e as Error).name === 'AbortError') return null;
    throw e;
  }
}

export function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Save a generated file: picker where available, otherwise a download. Returns false if cancelled. */
export async function saveBlob(blob: Blob, kind: 'csv' | 'png', name: string): Promise<boolean> {
  if (!fsa && !test()?.save) {
    download(blob, name);
    return true;
  }
  const handle = await pickSave(kind, name);
  if (!handle) return false;
  const wr = await handle.createWritable();
  await wr.write(blob);
  await wr.close();
  return true;
}

type PermissionHandle = FileSystemHandle & {
  queryPermission?: (d: { mode: 'read' | 'readwrite' }) => Promise<PermissionState>;
  requestPermission?: (d: { mode: 'read' | 'readwrite' }) => Promise<PermissionState>;
};

/** Whether we may use a remembered handle; `ask` prompts (needs a click or key press). */
export async function permitted(handle: FileSystemHandle, mode: 'read' | 'readwrite', ask: boolean): Promise<boolean> {
  const hd = handle as PermissionHandle;
  if (!hd.queryPermission) return true;
  if ((await hd.queryPermission({ mode })) === 'granted') return true;
  if (!ask || !hd.requestPermission) return false;
  try {
    return (await hd.requestPermission({ mode })) === 'granted';
  } catch {
    return false;
  }
}

// ---------- remembered handles (IndexedDB) ----------

const DB = 'chronos-vault';
const STORE = 'handles';

function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
  try {
    const d = await db();
    return await new Promise<T>((resolve, reject) => {
      const r = fn(d.transaction(STORE, mode).objectStore(STORE));
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  } catch (e) {
    console.warn('handle store', e);
    return undefined;
  }
}

export const handles = {
  get: (key: string) => tx<FileSystemFileHandle>('readonly', (s) => s.get(key) as IDBRequest<FileSystemFileHandle>),
  set: (key: string, h: FileSystemFileHandle) => tx('readwrite', (s) => s.put(h, key)),
  del: (key: string) => tx('readwrite', (s) => s.delete(key)),
  keys: async () => ((await tx('readonly', (s) => s.getAllKeys())) ?? []).map(String),
};

/** Dropped files, with handles where the browser provides them. Must be called inside the drop event. */
export function droppedFiles(dt: DataTransfer): Promise<Picked[]> {
  const items = [...dt.items].filter((i) => i.kind === 'file');
  const jobs = items.map((i) => {
    const file = i.getAsFile();
    const getHandle = (i as DataTransferItem & { getAsFileSystemHandle?: () => Promise<FileSystemHandle | null> }).getAsFileSystemHandle;
    const hp = getHandle ? getHandle.call(i).catch(() => null) : Promise.resolve(null);
    return hp.then((h) => ({ file: file!, handle: h && h.kind === 'file' ? (h as FileSystemFileHandle) : undefined }));
  });
  return Promise.all(jobs).then((r) => r.filter((p) => p.file));
}

export function baseName(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}
