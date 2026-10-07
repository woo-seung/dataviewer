/**
 * `.chronos` workspace file: layout + data-source references + the complete
 * preprocessing (parsed arrays and block index) in one binary file, so a
 * workspace re-opens without re-parsing any CSV, whatever its size.
 *
 *   0   "CHRONOS2"            magic (8 bytes)
 *   8   u32 LE                header length in bytes
 *   12  u32 LE                reserved (0)
 *   16  header JSON (UTF-8)
 *   …   zero padding to an 8-byte boundary  → dataStart
 *   …   sections (raw little-endian typed arrays, each 8-byte aligned)
 *
 * Section offsets in the header are relative to dataStart, so the header can
 * be serialised before its own length is known.
 */
import type { DataSource, ImportSettings, Workspace } from '../types';
import type { Blocks } from './blocks';
import { ensureBlocks } from './db';

const MAGIC = 'CHRONOS2';

type DType = 'f64' | 'f32' | 'u32';
interface Section {
  o: number;
  n: number;
  t: DType;
}

export interface FileSource {
  id: string;
  name: string;
  /** Path of the original CSV relative to the workspace file's folder. */
  rel?: string;
  size: number;
  lastModified?: number;
  importedAt: number;
  timeColumn: string;
  import?: ImportSettings;
  rows: number;
  time: Section;
  columns: {
    name: string;
    min: number;
    max: number;
    mean: number;
    values: Section;
    blocks: Record<keyof Blocks, Section>;
  }[];
}

export interface FileHeader {
  app: 'chronos-vault';
  format: 2;
  savedAt: string;
  workspace: Workspace;
  sources: FileSource[];
}

type Arr = Float64Array | Float32Array | Uint32Array;

const BYTES: Record<DType, number> = { f64: 8, f32: 4, u32: 4 };
const dtypeOf = (a: Arr): DType => (a instanceof Float64Array ? 'f64' : a instanceof Float32Array ? 'f32' : 'u32');
const align8 = (n: number) => (n + 7) & ~7;
const BLOCK_KEYS: (keyof Blocks)[] = ['min', 'max', 'minIdx', 'maxIdx', 'sum', 'count'];

/** Byte chunks of a .chronos file, ready for a writable stream or a Blob. */
export function encodeChronos(workspace: Workspace, sources: DataSource[], relOf: (s: DataSource) => string | undefined): Uint8Array[] {
  const parts: Arr[] = [];
  let off = 0;
  const sec = (a: Arr): Section => {
    const s: Section = { o: off, n: a.length, t: dtypeOf(a) };
    parts.push(a);
    off += align8(a.byteLength);
    return s;
  };
  const fileSources: FileSource[] = sources.map((src) => {
    ensureBlocks(src);
    return {
      id: src.id,
      name: src.name,
      rel: relOf(src),
      size: src.size,
      lastModified: src.lastModified,
      importedAt: src.importedAt,
      timeColumn: src.timeColumn,
      import: src.import,
      rows: src.time.length,
      time: sec(src.time),
      columns: src.columns.map((c) => ({
        name: c.name,
        min: c.min,
        max: c.max,
        mean: c.mean,
        values: sec(c.values),
        blocks: Object.fromEntries(BLOCK_KEYS.map((k) => [k, sec(c.blocks![k])])) as Record<keyof Blocks, Section>,
      })),
    };
  });
  const header: FileHeader = { app: 'chronos-vault', format: 2, savedAt: new Date().toISOString(), workspace, sources: fileSources };
  const json = new TextEncoder().encode(JSON.stringify(header));
  const head = new Uint8Array(align8(16 + json.length));
  head.set(new TextEncoder().encode(MAGIC), 0);
  new DataView(head.buffer).setUint32(8, json.length, true);
  head.set(json, 16);
  const out: Uint8Array[] = [head];
  for (const a of parts) {
    out.push(new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
    const pad = align8(a.byteLength) - a.byteLength;
    if (pad) out.push(new Uint8Array(pad));
  }
  return out;
}

export async function isChronosFile(file: Blob): Promise<boolean> {
  const b = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  return new TextDecoder().decode(b) === MAGIC;
}

export interface ChronosReader {
  header: FileHeader;
  /** Materialise one source's arrays from the file (no parsing). */
  load(id: string): Promise<DataSource | null>;
}

export async function readChronos(file: Blob): Promise<ChronosReader> {
  const head = await file.slice(0, 16).arrayBuffer();
  if (new TextDecoder().decode(new Uint8Array(head, 0, 8)) !== MAGIC) throw new Error('Chronos 워크스페이스 파일이 아닙니다.');
  const len = new DataView(head).getUint32(8, true);
  const header = JSON.parse(await file.slice(16, 16 + len).text()) as FileHeader;
  const dataStart = align8(16 + len);
  const read = async (s: Section): Promise<Arr> => {
    const a = dataStart + s.o;
    const buf = await file.slice(a, a + s.n * BYTES[s.t]).arrayBuffer();
    return s.t === 'f64' ? new Float64Array(buf) : s.t === 'f32' ? new Float32Array(buf) : new Uint32Array(buf);
  };
  return {
    header,
    async load(id) {
      const fs = header.sources.find((s) => s.id === id);
      if (!fs) return null;
      const columns = [];
      for (const c of fs.columns) {
        const blocks = {} as Blocks;
        for (const k of BLOCK_KEYS) (blocks as unknown as Record<string, Arr>)[k] = await read(c.blocks[k]);
        columns.push({ name: c.name, min: c.min, max: c.max, mean: c.mean, values: (await read(c.values)) as Float64Array | Float32Array, blocks });
      }
      return {
        id: fs.id,
        name: fs.name,
        size: fs.size,
        lastModified: fs.lastModified,
        importedAt: fs.importedAt,
        timeColumn: fs.timeColumn,
        import: fs.import,
        time: (await read(fs.time)) as Float64Array,
        columns,
      };
    },
  };
}
