/**
 * File System Access helpers (Chromium). A "work folder" directory handle lets
 * the app store paths relative to a workspace file and read them back later —
 * something plain <input type=file> cannot do.
 */

type Mode = 'read' | 'readwrite';

interface PermissionHandle {
  queryPermission?: (d: { mode: Mode }) => Promise<PermissionState>;
  requestPermission?: (d: { mode: Mode }) => Promise<PermissionState>;
}

interface PickerType {
  description: string;
  accept: Record<string, string[]>;
}

type W = typeof window & {
  showDirectoryPicker?: (o?: { id?: string; mode?: Mode }) => Promise<FileSystemDirectoryHandle>;
  showOpenFilePicker?: (o?: { id?: string; multiple?: boolean; types?: PickerType[] }) => Promise<FileSystemFileHandle[]>;
  showSaveFilePicker?: (o?: { id?: string; suggestedName?: string; types?: PickerType[] }) => Promise<FileSystemFileHandle>;
};

const w = window as W;

/** Embedded in another page (e.g. a sandboxed preview frame), where pickers are refused. */
export const inFrame = (() => {
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
})();

export const fsaSupported = typeof w.showDirectoryPicker === 'function' && !inFrame;

export const CSV_TYPES: PickerType[] = [{ description: 'CSV', accept: { 'text/csv': ['.csv', '.tsv', '.txt'] } }];
export const WS_TYPES: PickerType[] = [{ description: 'Chronos 워크스페이스', accept: { 'application/octet-stream': ['.chronos'], 'application/json': ['.json'] } }];

export async function pickDirectory(): Promise<FileSystemDirectoryHandle | null> {
  try {
    return await w.showDirectoryPicker!({ id: 'chronos-folder', mode: 'readwrite' });
  } catch {
    return null; // cancelled
  }
}

export async function pickOpenFiles(types: PickerType[], multiple: boolean): Promise<FileSystemFileHandle[]> {
  try {
    return await w.showOpenFilePicker!({ id: 'chronos-open', multiple, types });
  } catch {
    return [];
  }
}

export async function pickSaveFile(suggestedName: string): Promise<FileSystemFileHandle | null> {
  try {
    return await w.showSaveFilePicker!({ id: 'chronos-save', suggestedName, types: WS_TYPES.slice(0, 1) });
  } catch {
    return null;
  }
}

/** Check (and, when allowed by a user gesture, request) access to a handle. */
export async function ensurePermission(h: FileSystemHandle, mode: Mode, request: boolean): Promise<boolean> {
  const p = h as unknown as PermissionHandle;
  if (typeof p.queryPermission !== 'function') return true; // e.g. origin-private FS
  if ((await p.queryPermission({ mode })) === 'granted') return true;
  if (!request || typeof p.requestPermission !== 'function') return false;
  try {
    return (await p.requestPermission({ mode })) === 'granted';
  } catch {
    return false;
  }
}

// ---------- paths (POSIX-style, relative to the work folder root) ----------

export function splitPath(p: string): string[] {
  return p.split('/').filter((s) => s && s !== '.');
}

/** Normalise segments, resolving '..'. Returns null when the path escapes the root. */
export function normalize(segs: string[]): string[] | null {
  const out: string[] = [];
  for (const s of segs) {
    if (s === '..') {
      if (!out.length) return null;
      out.pop();
    } else if (s && s !== '.') out.push(s);
  }
  return out;
}

export function dirOf(path: string): string[] {
  return splitPath(path).slice(0, -1);
}

/** Relative path from directory `fromDir` to `to` (both root-relative). */
export function relativePath(fromDir: string[], to: string): string {
  const t = splitPath(to);
  let i = 0;
  while (i < fromDir.length && i < t.length - 1 && fromDir[i] === t[i]) i++;
  return [...Array(fromDir.length - i).fill('..'), ...t.slice(i)].join('/');
}

/** Root-relative path of `rel` interpreted from directory `fromDir`. */
export function resolveRelative(fromDir: string[], rel: string): string | null {
  const n = normalize([...fromDir, ...rel.split('/')]);
  return n ? n.join('/') : null;
}

export async function fileAt(root: FileSystemDirectoryHandle, path: string): Promise<FileSystemFileHandle | null> {
  const segs = splitPath(path);
  if (!segs.length) return null;
  try {
    let dir = root;
    for (const s of segs.slice(0, -1)) dir = await dir.getDirectoryHandle(s);
    return await dir.getFileHandle(segs[segs.length - 1]);
  } catch {
    return null;
  }
}

export async function createFileAt(root: FileSystemDirectoryHandle, path: string): Promise<FileSystemFileHandle> {
  const segs = splitPath(path);
  let dir = root;
  for (const s of segs.slice(0, -1)) dir = await dir.getDirectoryHandle(s, { create: true });
  return dir.getFileHandle(segs[segs.length - 1], { create: true });
}

/** Root-relative path of a handle, or null when it lives outside the folder. */
export async function pathInRoot(root: FileSystemDirectoryHandle, h: FileSystemHandle): Promise<string | null> {
  try {
    const segs = await root.resolve(h);
    return segs ? segs.join('/') : null;
  } catch {
    return null;
  }
}

export interface DirEntry {
  name: string;
  path: string;
  kind: 'file' | 'directory';
  handle: FileSystemHandle;
}

export async function listDir(dir: FileSystemDirectoryHandle, base: string): Promise<DirEntry[]> {
  const out: DirEntry[] = [];
  const iter = (dir as unknown as { values(): AsyncIterable<FileSystemHandle> }).values();
  for await (const h of iter) out.push({ name: h.name, kind: h.kind, handle: h, path: base ? `${base}/${h.name}` : h.name });
  return out.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'directory' ? -1 : 1));
}

// ---------- remembering handles across reloads (IndexedDB structured clone) ----------

const DB = 'chronos-vault-handles';

function db(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('h');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

export async function saveHandle(key: string, h: FileSystemHandle | null) {
  try {
    const d = await db();
    const t = d.transaction('h', 'readwrite');
    if (h) t.objectStore('h').put(h, key);
    else t.objectStore('h').delete(key);
    t.oncomplete = () => d.close();
  } catch (e) {
    console.warn('handle save failed', e);
  }
}

export async function loadHandle<T extends FileSystemHandle>(key: string): Promise<T | null> {
  try {
    const d = await db();
    return await new Promise((res) => {
      const r = d.transaction('h').objectStore('h').get(key);
      r.onsuccess = () => {
        res((r.result as T) ?? null);
        d.close();
      };
      r.onerror = () => res(null);
    });
  } catch {
    return null;
  }
}
