/**
 * Work folder + workspace file.
 *
 * - A work folder (directory handle) gives every CSV a path relative to the
 *   workspace file, so re-opening the workspace loads its data automatically.
 * - The workspace file (.chronos) always carries the complete preprocessing
 *   (parsed arrays + block index) next to those paths. On open, a CSV whose
 *   size/mtime still match is served from that cache; a changed CSV is
 *   re-parsed with its original import settings and the file is re-saved.
 */
import { encodeChronos, readChronos, isChronosFile, type ChronosReader } from './data/chronosFile';
import {
  createFileAt,
  dirOf,
  ensurePermission,
  fileAt,
  fsaSupported,
  loadHandle,
  normalize,
  pathInRoot,
  pickDirectory,
  pickSaveFile,
  relativePath,
  resolveRelative,
  saveHandle,
  splitPath,
} from './fs/fsa';
import { store } from './store';
import type { DataSource, SourceMeta, Workspace } from './types';
import { openImportDialog, reimport } from './ui/importDialog';
import { confirmDialog, notice, prompt } from './ui/overlays';
import { downloadBlob, formatBytes } from './util';

interface WsFile {
  /** null when opened without File System Access (save goes to a download). */
  handle: FileSystemFileHandle | null;
  /** Root-relative path, when the file lives inside the work folder. */
  path: string | null;
  name: string;
}

class Project {
  root: FileSystemDirectoryHandle | null = null;
  /** Remembered folder that still needs a permission click after reload. */
  pendingRoot: FileSystemDirectoryHandle | null = null;
  file: WsFile | null = null;
  dirty = false;
  saving = false;
  /** CSV handles of sources imported this session (paths can be derived once a folder is opened). */
  private csvHandles = new Map<string, FileSystemFileHandle>();
  private loading = 0;
  private saveQueued = false;
  private warnedNoFolder = false;

  async init() {
    store.onChange = (ev) => {
      if (this.loading) return;
      if (ev === 'sources') {
        // preprocessing changed → it must land in the workspace file
        void this.persistPreprocessing();
        return;
      }
      if (!this.dirty && (this.file || this.root)) {
        this.dirty = true;
        this.changed();
      }
    };
    window.addEventListener('beforeunload', (e) => {
      if (this.dirty && this.file) e.preventDefault();
    });
    if (!fsaSupported) return;
    const root = await loadHandle<FileSystemDirectoryHandle>('root');
    if (root) {
      if (await ensurePermission(root, 'readwrite', false)) await this.setRoot(root, false);
      else this.pendingRoot = root;
    }
    if (this.root && store.ws.file?.path) {
      const h = await fileAt(this.root, store.ws.file.path);
      if (h) this.file = { handle: h, path: store.ws.file.path, name: h.name };
    }
    this.changed();
    if (this.root) await this.resolveMissing();
  }

  private changed() {
    store.emit('project', undefined);
  }

  get rootName(): string | null {
    return (this.root ?? this.pendingRoot)?.name ?? null;
  }

  // ---------------- work folder ----------------
  async openFolder() {
    if (!fsaSupported) {
      notice('이 브라우저는 폴더 접근을 지원하지 않습니다. Chrome 또는 Edge를 사용하세요.', 6000, 'error');
      return;
    }
    const h = await pickDirectory();
    if (h) await this.setRoot(h, true);
  }

  /** Re-grant access to the remembered folder (needs a user gesture). */
  async reconnect() {
    const h = this.pendingRoot;
    if (!h) return;
    if (await ensurePermission(h, 'readwrite', true)) await this.setRoot(h, true);
  }

  async closeFolder() {
    this.root = null;
    this.pendingRoot = null;
    await saveHandle('root', null);
    this.changed();
  }

  async setRoot(h: FileSystemDirectoryHandle, persist: boolean) {
    this.root = h;
    this.pendingRoot = null;
    if (persist) await saveHandle('root', h);
    // sources imported from handles before the folder was opened get their paths now
    for (const [id, fh] of this.csvHandles) {
      const src = store.sources.get(id);
      if (src && !src.path) src.path = (await pathInRoot(h, fh)) ?? undefined;
    }
    for (const m of store.ws.sourceMeta ?? []) {
      const s = store.sources.get(m.id);
      if (s?.path) m.path = s.path;
    }
    if (this.file?.handle && !this.file.path) this.file.path = await pathInRoot(h, this.file.handle);
    this.changed();
    if (persist) await this.resolveMissing();
  }

  // ---------------- importing ----------------
  /** Import a CSV picked/dropped as a file handle (path known when inside the folder). */
  async importHandle(h: FileSystemFileHandle): Promise<DataSource | null> {
    if (!(await ensurePermission(h, 'read', true))) return null;
    const path = this.root ? await pathInRoot(this.root, h) : null;
    const existing = path ? store.sourceByPath(path) : undefined;
    if (existing) {
      notice(`${path} 은(는) 이미 불러와져 있습니다.`);
      return existing;
    }
    const src = await openImportDialog(await h.getFile(), false, { path });
    if (src) this.csvHandles.set(src.id, h);
    return src;
  }

  // ---------------- saving ----------------
  private wsDir(): string[] | null {
    return this.file?.path != null ? dirOf(this.file.path) : null;
  }

  private relOf(path: string | undefined): string | undefined {
    const dir = this.wsDir();
    return path && dir ? relativePath(dir, path) : undefined;
  }

  /**
   * Workspace as stored in the file: paths become relative to the file.
   * `keepRel` keeps relative paths read from this same file when the folder
   * is not connected (they are still valid for it).
   */
  private exportWorkspace(keepRel: boolean): Workspace {
    const w = JSON.parse(JSON.stringify(store.ws)) as Workspace;
    w.sourceMeta = (w.sourceMeta ?? []).map((m) => ({ ...m, rel: this.relOf(m.path) ?? (keepRel ? m.rel : undefined), path: undefined }));
    delete w.file;
    return w;
  }

  private metaRel(id: string): string | undefined {
    return store.ws.sourceMeta?.find((m) => m.id === id)?.rel;
  }

  private async uniqueName(base: string): Promise<string> {
    if (!this.root) return base;
    const stem = base.replace(/\.chronos$/i, '');
    for (let i = 1; ; i++) {
      const name = i === 1 ? `${stem}.chronos` : `${stem} ${i}.chronos`;
      if (!(await fileAt(this.root, name))) return name;
    }
  }

  /** Choose where a new workspace file goes. */
  private async chooseTarget(): Promise<WsFile | 'download' | null> {
    if (this.root) {
      const name = await prompt('워크스페이스 저장 (작업 폴더 기준 경로)', await this.uniqueName('workspace.chronos'), 'dashboards/plant.chronos');
      if (!name?.trim()) return null;
      const segs = normalize(splitPath(name.trim().replace(/\\/g, '/')));
      if (!segs?.length) return null;
      let path = segs.join('/');
      if (!/\.chronos$/i.test(path)) path += '.chronos';
      if (await fileAt(this.root, path)) {
        if (!(await confirmDialog('덮어쓰기', `${path} 이(가) 이미 있습니다. 덮어쓸까요?`, '덮어쓰기'))) return null;
      }
      const handle = await createFileAt(this.root, path);
      return { handle, path, name: handle.name };
    }
    if (fsaSupported) {
      const handle = await pickSaveFile('workspace.chronos');
      if (!handle) return null;
      notice('작업 폴더 밖에 저장하면 CSV 상대경로를 기록할 수 없습니다. 데이터(전처리 결과)는 파일에 포함됩니다.', 7000);
      return { handle, path: null, name: handle.name };
    }
    return 'download';
  }

  async save(opts: { as?: boolean; quiet?: boolean } = {}) {
    if (this.saving) {
      this.saveQueued = true;
      return;
    }
    const keepRel = !!this.file && !opts.as;
    if (!this.file || opts.as) {
      const t = await this.chooseTarget();
      if (!t) return;
      if (t === 'download') {
        const chunks = encodeChronos(this.exportWorkspace(false), [...store.sources.values()], () => undefined);
        downloadBlob(new Blob(chunks as BlobPart[], { type: 'application/octet-stream' }), 'workspace.chronos');
        this.dirty = false;
        this.changed();
        return;
      }
      this.file = t;
    }
    const f = this.file;
    if (!f.handle) return;
    this.saving = true;
    this.changed();
    const t0 = performance.now();
    try {
      if (!(await ensurePermission(f.handle, 'readwrite', true))) throw new Error('파일 쓰기 권한이 없습니다.');
      const sources = [...store.sources.values()];
      const chunks = encodeChronos(this.exportWorkspace(keepRel), sources, (s) => this.relOf(s.path) ?? (keepRel ? this.metaRel(s.id) : undefined));
      const w = await f.handle.createWritable();
      let bytes = 0;
      for (const c of chunks) {
        await w.write(c as unknown as BufferSource);
        bytes += c.byteLength;
      }
      await w.close();
      store.ws.file = { name: f.name, path: f.path ?? undefined };
      store.save();
      await saveHandle('workspace', f.handle);
      this.dirty = false;
      if (!opts.quiet) notice(`${f.path ?? f.name} 저장 (${formatBytes(bytes)}, ${((performance.now() - t0) / 1000).toFixed(1)}s)`);
    } catch (e) {
      notice(`저장 실패: ${(e as Error).message}`, 7000, 'error');
    } finally {
      this.saving = false;
      this.changed();
      if (this.saveQueued) {
        this.saveQueued = false;
        void this.save({ quiet: true });
      }
    }
  }

  /** Called whenever sources change: keep the preprocessing inside the workspace file. */
  private async persistPreprocessing() {
    if (this.file?.handle) return this.save({ quiet: true });
    if (this.root && store.sources.size) {
      const name = await this.uniqueName('workspace.chronos');
      const handle = await createFileAt(this.root, name);
      this.file = { handle, path: name, name };
      notice(`전처리 결과를 작업 폴더의 ${name} 에 저장합니다.`);
      return this.save({ quiet: true });
    }
    this.dirty = store.sources.size > 0;
    this.changed();
    if (!this.warnedNoFolder && store.sources.size) {
      this.warnedNoFolder = true;
      notice('작업 폴더를 열거나 워크스페이스를 저장하면 CSV 상대경로와 전처리 결과가 함께 저장됩니다.', 7000);
    }
  }

  // ---------------- opening ----------------
  /** Open a .chronos workspace (from the folder tree, a picker, a drop or a plain File). */
  async open(src: FileSystemFileHandle | File, knownPath?: string) {
    if (this.dirty && !(await confirmDialog('저장되지 않은 변경', '현재 워크스페이스에 저장되지 않은 변경이 있습니다. 그래도 열까요?', '열기'))) return;
    const handle = src instanceof File ? null : src;
    if (handle && !(await ensurePermission(handle, 'readwrite', true)) && !(await ensurePermission(handle, 'read', true))) return;
    const file = handle ? await handle.getFile() : (src as File);
    if (!(await isChronosFile(file))) {
      notice(`${file.name}: Chronos 워크스페이스 파일이 아닙니다.`, 6000, 'error');
      return;
    }
    let reader: ChronosReader;
    try {
      reader = await readChronos(file);
    } catch (e) {
      notice(`열기 실패: ${(e as Error).message}`, 7000, 'error');
      return;
    }
    const path = knownPath ?? (handle && this.root ? await pathInRoot(this.root, handle) : null);
    this.file = { handle, path, name: file.name };
    this.loading++;
    try {
      const ws = reader.header.workspace;
      const dir = path != null ? dirOf(path) : null;
      const metaById = new Map((ws.sourceMeta ?? []).map((m) => [m.id, m]));
      for (const fs of reader.header.sources) {
        const m = metaById.get(fs.id);
        const rel = fs.rel ?? m?.rel;
        const p = rel && dir ? resolveRelative(dir, rel) : null;
        if (m) {
          m.rel = rel;
          m.path = p ?? undefined;
        }
      }
      for (const m of ws.sourceMeta ?? []) if (!m.path && m.rel && dir) m.path = resolveRelative(dir, m.rel) ?? undefined;
      ws.file = { name: file.name, path: path ?? undefined };

      const { loaded, stale, notes } = await this.loadFromFile(reader, ws.sourceMeta ?? [], reader.header.sources.map((s) => s.id));
      store.replaceWorkspace(ws, loaded);
      this.dirty = false;
      this.changed();
      const refreshed = await this.reimportAll(stale);
      // sources the file references without a cached copy (e.g. a failed earlier import)
      const orphans = store.missingSources().filter((m) => m.path && !reader.header.sources.some((s) => s.id === m.id));
      const extra = await this.loadFromCsv(orphans);
      if (refreshed + extra > 0) await this.save({ quiet: true });
      const missing = store.missingSources();
      notice(
        [
          `${path ?? file.name} 열기 — 저장된 전처리 ${loaded.length}개 사용${refreshed ? `, 변경된 CSV ${refreshed}개 다시 처리` : ''}`,
          ...notes,
          missing.length ? `데이터 없음: ${missing.map((m) => m.rel ?? m.name).join(', ')}` : '',
          !this.root && reader.header.sources.some((s) => s.rel) ? '원본 CSV 변경을 확인하려면 이 파일이 있는 작업 폴더를 여세요.' : '',
        ]
          .filter(Boolean)
          .join('\n'),
        missing.length || notes.length ? 9000 : 4000,
      );
    } finally {
      this.loading--;
    }
  }

  /**
   * Take each source from the file's cache unless its CSV (at the stored
   * relative path) changed since it was processed.
   */
  private async loadFromFile(reader: ChronosReader, metas: SourceMeta[], ids: string[]) {
    const loaded: DataSource[] = [];
    const stale: { meta: SourceMeta; file: File; handle: FileSystemFileHandle }[] = [];
    const notes: string[] = [];
    for (const id of ids) {
      const fs = reader.header.sources.find((s) => s.id === id)!;
      const meta = metas.find((m) => m.id === id);
      const path = meta?.path;
      const h = this.root && path ? await fileAt(this.root, path) : null;
      if (h) {
        const f = await h.getFile();
        if (f.size !== fs.size || f.lastModified !== fs.lastModified) {
          if (meta?.import) {
            stale.push({ meta, file: f, handle: h });
            continue;
          }
          notes.push(`${path}: 변경되었지만 가져오기 설정이 없어 저장된 데이터를 사용합니다.`);
        }
        this.csvHandles.set(id, h);
      } else if (path && this.root) notes.push(`원본 없음: ${path} (저장된 데이터 사용)`);
      const src = await reader.load(id);
      if (src) {
        src.path = path;
        loaded.push(src);
      }
    }
    return { loaded, stale, notes };
  }

  private async reimportAll(list: { meta: SourceMeta; file: File; handle: FileSystemFileHandle }[]): Promise<number> {
    let n = 0;
    for (const { meta, file, handle } of list) {
      const src = await reimport(file, meta.import!, meta.id, { path: meta.path });
      if (src) {
        store.addSource(src);
        this.csvHandles.set(src.id, handle);
        n++;
      }
    }
    return n;
  }

  /** Load sources straight from their CSVs (no cached copy available). */
  private async loadFromCsv(metas: SourceMeta[]): Promise<number> {
    if (!this.root) return 0;
    let n = 0;
    for (const m of metas) {
      if (!m.path || !m.import) continue;
      const h = await fileAt(this.root, m.path);
      if (!h) continue;
      const src = await reimport(await h.getFile(), m.import, m.id, { path: m.path });
      if (src) {
        store.addSource(src);
        this.csvHandles.set(src.id, h);
        n++;
      }
    }
    return n;
  }

  /** After a reload/folder connect: fill in sources that are referenced but not in memory. */
  async resolveMissing() {
    let missing = store.missingSources();
    if (!missing.length) return;
    this.loading++;
    let changed = 0;
    try {
      if (this.file?.handle && (await ensurePermission(this.file.handle, 'read', false))) {
        try {
          const reader = await readChronos(await this.file.handle.getFile());
          const ids = missing.map((m) => m.id).filter((id) => reader.header.sources.some((s) => s.id === id));
          const { loaded, stale } = await this.loadFromFile(reader, store.ws.sourceMeta ?? [], ids);
          for (const s of loaded) store.addSource(s);
          changed += await this.reimportAll(stale);
        } catch (e) {
          console.warn('workspace file unreadable', e);
        }
      }
      missing = store.missingSources();
      changed += await this.loadFromCsv(missing);
    } finally {
      this.loading--;
    }
    if (changed) await this.persistPreprocessing();
  }

  closeFile() {
    this.file = null;
    this.dirty = false;
    delete store.ws.file;
    void saveHandle('workspace', null);
    this.changed();
  }
}

export const project = new Project();
