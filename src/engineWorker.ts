/// <reference lib="webworker" />
/**
 * Engine worker: hosts the Rust engine (WebAssembly) and does all file I/O, so
 * parsing hundreds of MB never blocks the page. The main thread talks to it
 * through src/engine.ts.
 *
 * File access stays here: CSVs are read in chunks and fed to the engine,
 * cached sources are read straight into the arrays the engine allocates, and
 * saves write the byte runs the engine plans (appending to big files).
 */
import wasmUrl from './wasm/chronos.wasm?url';

declare const self: DedicatedWorkerGlobalScope;

interface Exports {
  memory: WebAssembly.Memory;
  init(): void;
  alloc(n: number): number;
  dealloc(p: number, n: number): void;
  call(c: number, cl: number, a: number, al: number, b: number, bl: number): number;
  out_ptr(): number;
  out_len(): number;
  panic_message(): void;
  memory_bytes(): number;
}

const CHUNK = 16 << 20;
const PREVIEW = 256 * 1024;
const MAGIC = 'CHRONOS3';

let x: Exports;
let broken = '';
const ready = (async () => {
  const { instance } = await WebAssembly.instantiateStreaming(fetch(wasmUrl), { env: { now: () => Date.now() } });
  x = instance.exports as unknown as Exports;
  x.init();
})();

const enc = new TextEncoder();
const dec = new TextDecoder();
const mem = (p: number, n: number) => new Uint8Array(x.memory.buffer, p, n);

function put(bytes: Uint8Array): number {
  const p = x.alloc(bytes.length);
  mem(p, bytes.length).set(bytes);
  return p;
}

/** Synchronous engine call. Returns JSON or (tag 1) the binary payload. */
function call<T = unknown>(cmd: string, args: unknown = {}, bin?: Uint8Array): T {
  if (broken) throw new Error(broken);
  const c = enc.encode(cmd);
  const a = enc.encode(JSON.stringify(args ?? {}));
  const pc = put(c);
  const pa = put(a);
  const pb = bin?.length ? put(bin) : 0;
  let code: number;
  try {
    code = x.call(pc, c.length, pa, a.length, pb, bin?.length ?? 0);
  } catch (e) {
    // a trap leaves the engine unusable: report why and refuse further calls
    x.panic_message();
    const msg = dec.decode(mem(x.out_ptr(), x.out_len()));
    broken = /alloc|memory/i.test(msg) || !msg
      ? '메모리가 부족합니다 (브라우저 탭 한도 약 4 GB). 페이지를 새로 고친 뒤 열 수를 줄이거나 32-bit로 불러오세요.'
      : `엔진 오류: ${msg} — 페이지를 새로 고치세요.`;
    console.error('engine trap', cmd, e, msg);
    throw new Error(broken);
  }
  x.dealloc(pc, c.length);
  x.dealloc(pa, a.length);
  if (pb) x.dealloc(pb, bin!.length);
  const out = mem(x.out_ptr(), x.out_len());
  if (code) throw new Error(dec.decode(out));
  return (out[0] === 0 ? JSON.parse(dec.decode(out.subarray(1))) : out.slice(1)) as T;
}

const cancelled = new Set<string>();
const progress = (payload: Record<string, unknown>) => self.postMessage({ event: 'progress', payload });

function checkCancel(job: string) {
  if (cancelled.has(job)) {
    cancelled.delete(job);
    throw new Error('취소됨');
  }
}

const bytesOf = async (b: Blob) => new Uint8Array(await b.arrayBuffer());

// ---------------- CSV ----------------

interface Settings {
  delimiter: string;
  hasHeader: boolean;
  timeColumn: string;
  timeFormat: string;
  columns: string[];
  compact: boolean;
}

async function importCsv(file: File, settings: Settings, job: string, id?: string, name?: string) {
  call('import_begin', { job, settings, total: file.size });
  try {
    let last = 0;
    for (let off = 0; off < file.size; off += CHUNK) {
      const chunk = await bytesOf(file.slice(off, off + CHUNK));
      checkCancel(job);
      call('import_feed', { job }, chunk);
      if (performance.now() - last > 100) {
        last = performance.now();
        progress({ job, loaded: Math.min(file.size, off + CHUNK), total: file.size, phase: 'parse', name });
      }
    }
    progress({ job, loaded: file.size, total: file.size, phase: 'index', name });
    return call('import_end', { job, id, name: file.name, size: file.size, lastModified: file.lastModified });
  } catch (e) {
    call('import_abort', { job });
    throw e;
  }
}

// ---------------- .chronos ----------------

interface Sec {
  o: number;
  n: number;
  t: string;
}
interface FileSource {
  id: string;
  name: string;
  size: number;
  lastModified: number;
  import: Settings;
  rows: number;
  time: Sec;
  columns: unknown[];
}
interface Header {
  app: string;
  format: number;
  savedAt: number;
  workspace: unknown;
  sources: FileSource[];
}

const u64 = (b: Uint8Array, at: number) => Number(new DataView(b.buffer, b.byteOffset + at, 8).getBigUint64(0, true));
const isMagic = (b: Uint8Array, at: number) => dec.decode(b.subarray(at, at + 8)) === MAGIC;

async function headerAt(file: Blob, end: number): Promise<Header | null> {
  if (end < 32) return null;
  const foot = await bytesOf(file.slice(end - 24, end));
  if (!isMagic(foot, 16)) return null;
  const off = u64(foot, 0);
  const len = u64(foot, 8);
  if (off + len + 24 !== end) return null;
  try {
    return JSON.parse(dec.decode(await bytesOf(file.slice(off, off + len)))) as Header;
  } catch {
    return null;
  }
}

/** Header via the footer; after an interrupted append, the last intact one. */
async function readHeader(file: Blob): Promise<Header> {
  const head = await bytesOf(file.slice(0, 8));
  if (file.size < 32 || !isMagic(head, 0)) throw new Error('Chronos 워크스페이스 파일(.chronos)이 아닙니다.');
  const h = await headerAt(file, file.size);
  if (h) return h;
  const span = Math.min(file.size, 64 << 20);
  const tail = await bytesOf(file.slice(file.size - span));
  for (let p = tail.length - 8; p >= 0; p--) {
    if (tail[p] === 0x43 && isMagic(tail, p)) {
      const found = await headerAt(file, file.size - span + p + 8);
      if (found) return found;
    }
  }
  throw new Error('워크스페이스 파일이 손상되었습니다.');
}

/** Read a cached source straight into engine memory (contiguous sections in big reads). */
async function loadCached(file: Blob, fs: FileSource, missing: boolean) {
  const key = `load_${fs.id}`;
  const { targets } = call<{ targets: [number, number, number][] }>('load_alloc', { key, source: fs, missing });
  try {
    targets.sort((a, b) => a[0] - b[0]);
    let i = 0;
    while (i < targets.length) {
      const start = targets[i][0];
      let end = start + targets[i][2];
      let j = i + 1;
      while (j < targets.length && targets[j][0] - end < 64 && targets[j][0] + targets[j][2] - start <= 64 << 20) {
        end = Math.max(end, targets[j][0] + targets[j][2]);
        j++;
      }
      const buf = await bytesOf(file.slice(start, end));
      for (let k = i; k < j; k++) {
        const [o, p, n] = targets[k];
        mem(p, n).set(buf.subarray(o - start, o - start + n));
      }
      i = j;
    }
    return call('load_commit', { key });
  } catch (e) {
    call('load_abort', { key });
    throw e;
  }
}

async function openWorkspace(file: File, csv: Record<string, File | null>, job: string) {
  const header = await readHeader(file);
  call('clear');
  const sources: unknown[] = [];
  const notes: string[] = [];
  const reprocessed: string[] = [];
  for (const fs of header.sources) {
    const f = csv[fs.id];
    checkCancel(job);
    if (f && (f.size !== fs.size || f.lastModified !== fs.lastModified)) {
      progress({ job, loaded: 0, total: 1, phase: 'reprocess', name: fs.name });
      try {
        sources.push(await importCsv(f, fs.import, job, fs.id, fs.name));
        reprocessed.push(fs.name);
        continue;
      } catch (e) {
        if ((e as Error).message === '취소됨') throw e;
        notes.push(`${fs.name}: 다시 처리하지 못해 저장된 데이터를 사용합니다 (${(e as Error).message})`);
      }
    }
    progress({ job, loaded: sources.length, total: header.sources.length, phase: 'load', name: fs.name });
    sources.push(await loadCached(file, fs, f === null));
    if (f === null) notes.push(`원본 없음: ${fs.name} (저장된 데이터 사용)`);
  }
  return { workspace: header.workspace, sources, notes, reprocessed, savedAt: header.savedAt };
}

/** Where a workspace is written: a file the user picked, or a file in the origin-private storage. */
type Target = { handle: FileSystemFileHandle } | { opfs: string };

async function opfsHandle(name: string, create: boolean) {
  const root = await navigator.storage.getDirectory();
  return root.getFileHandle(name, { create });
}

async function existingFile(t: Target): Promise<File | null> {
  try {
    const h = 'handle' in t ? t.handle : await opfsHandle(t.opfs, false);
    const f = await h.getFile();
    return f.size ? f : null;
  } catch {
    return null;
  }
}

interface Plan {
  start: number;
  rewrite: boolean;
  fileSize: number;
  pieces: [number, number][];
}

async function save(target: Target, workspace: unknown, sourceIds: string[] | null) {
  const t0 = performance.now();
  // Appending only pays off in private storage: a user-picked file is always
  // copied whole by the browser first, which is slower than writing it anew.
  const old = 'opfs' in target ? await existingFile(target) : null;
  let existing: Header | null = null;
  if (old) existing = await readHeader(old).catch(() => null);
  const key = `save_${Date.now()}`;
  const plan = call<Plan>('save_plan', { key, workspace, sources: sourceIds, existing, existingLen: existing ? old!.size : 0 });
  try {
    if ('opfs' in target) await writeOpfs(target.opfs, plan);
    else await writeHandle(target.handle, plan);
  } finally {
    call('save_done', { key });
  }
  return { fileSize: plan.fileSize, written: plan.fileSize - plan.start, rewrote: plan.rewrite, ms: performance.now() - t0 };
}

/**
 * Walk the planned byte runs as ~16 MB blocks (a wide file has tens of
 * thousands of small sections; one write per section would be very slow).
 * Blocks are copies, so wasm memory may grow while they are written.
 */
async function eachBlock(plan: Plan, write: (block: Uint8Array<ArrayBuffer>, at: number) => Promise<void> | void) {
  let buf = new Uint8Array(Math.min(CHUNK, Math.max(1, plan.fileSize - plan.start)));
  let fill = 0;
  let at = plan.start;
  const flush = async () => {
    if (!fill) return;
    await write(buf.subarray(0, fill), at);
    at += fill;
    fill = 0;
    buf = new Uint8Array(buf.length);
  };
  for (const [p, n] of plan.pieces) {
    let k = 0;
    while (k < n) {
      const len = Math.min(buf.length - fill, n - k);
      buf.set(mem(p + k, len), fill);
      fill += len;
      k += len;
      if (fill === buf.length) await flush();
    }
  }
  await flush();
}

/** Origin-private file: synchronous in-place writes (true append); rewrites go through a temp file. */
async function writeOpfs(name: string, plan: Plan) {
  const root = await navigator.storage.getDirectory();
  const target = plan.rewrite ? `${name}.tmp` : name;
  const h = await root.getFileHandle(target, { create: true });
  const sync = await h.createSyncAccessHandle();
  try {
    if (plan.rewrite) sync.truncate(0);
    await eachBlock(plan, async (block, at) => {
      sync.write(block, { at });
      // let chart requests through while a big file is written
      await new Promise((r) => setTimeout(r, 0));
    });
    sync.truncate(plan.fileSize);
    sync.flush();
  } finally {
    sync.close();
  }
  if (plan.rewrite) {
    const tmp = h as FileSystemFileHandle & { move?: (dir: FileSystemDirectoryHandle, name: string) => Promise<void> };
    if (tmp.move) {
      await root.removeEntry(name).catch(() => undefined);
      await tmp.move(root, name);
    } else {
      // no move(): copy the temp file over
      const dst = await (await root.getFileHandle(name, { create: true })).createSyncAccessHandle();
      const src = await tmp.getFile();
      try {
        dst.truncate(0);
        for (let off = 0; off < src.size; off += CHUNK) dst.write(await bytesOf(src.slice(off, off + CHUNK)), { at: off });
        dst.flush();
      } finally {
        dst.close();
      }
      await root.removeEntry(`${name}.tmp`);
    }
  }
}

/** A user-picked file: the browser writes a swap copy and replaces the file on close. */
async function writeHandle(handle: FileSystemFileHandle, plan: Plan) {
  const w = await handle.createWritable({ keepExistingData: !plan.rewrite });
  try {
    if (plan.start) await w.seek(plan.start);
    await eachBlock(plan, (block) => w.write(block));
    await w.truncate(plan.fileSize);
    await w.close();
  } catch (e) {
    await w.abort().catch(() => undefined);
    throw e;
  }
}

async function removeOpfs(name: string) {
  const root = await navigator.storage.getDirectory();
  await root.removeEntry(name).catch(() => undefined);
}

// ---------------- dispatch ----------------

type Msg = { id: number; cmd: string; args: Record<string, unknown> };

async function handle(m: Msg): Promise<unknown> {
  await ready;
  const a = m.args ?? {};
  switch (m.cmd) {
    case 'info':
      return { memoryBytes: x.memory_bytes() };
    case 'cancel':
      cancelled.add(a.job as string);
      return true;
    case 'preview': {
      const f = a.file as File;
      return call('preview', { size: f.size, delimiter: a.delimiter ?? '' }, await bytesOf(f.slice(0, PREVIEW)));
    }
    case 'import':
      return importCsv(a.file as File, a.settings as Settings, a.job as string, a.id as string | undefined, (a.file as File).name);
    case 'peek': {
      const h = await readHeader(a.file as File);
      return { workspace: h.workspace, savedAt: h.savedAt, sources: h.sources.map((s) => ({ id: s.id, name: s.name, size: s.size, lastModified: s.lastModified, rows: s.rows })) };
    }
    case 'open':
      return openWorkspace(a.file as File, (a.csv ?? {}) as Record<string, File | null>, a.job as string);
    case 'save':
      return save(a.target as Target, a.workspace, (a.sources as string[] | null) ?? null);
    case 'opfs_file': {
      try {
        const f = await (await opfsHandle(a.name as string, false)).getFile();
        return f.size ? f : null;
      } catch {
        return null;
      }
    }
    case 'opfs_remove':
      await removeOpfs(a.name as string);
      return true;
    case 'export_csv':
    case 'sample':
      return new Blob([call<Uint8Array>(m.cmd, a) as BlobPart], { type: 'text/csv' });
    default:
      return call(m.cmd, a);
  }
}

self.onmessage = (e: MessageEvent<Msg>) => {
  const m = e.data;
  handle(m).then(
    (result) => {
      // binary replies (chart windows) move without copying
      const transfer = result instanceof Uint8Array ? [result.buffer] : [];
      self.postMessage({ id: m.id, ok: true, result }, transfer as Transferable[]);
    },
    (err: Error) => self.postMessage({ id: m.id, ok: false, error: err?.message ?? String(err) }),
  );
};
