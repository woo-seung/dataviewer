/**
 * The open workspace file (.chronos).
 *
 * There is always one: until the user saves somewhere, work goes to an
 * auto-saved "Untitled" workspace in the browser's private storage, so
 * imported data and its preprocessing survive a reload. The file holds the
 * layout plus the parsed data and index of every source; re-opening it serves
 * the data from that cache, and re-processes a CSV that changed since (when
 * the browser still has access to it).
 *
 * The browser has no file paths: workspace and CSV file handles are
 * remembered in IndexedDB (Chrome/Edge) and need one click per visit to be
 * read again.
 */
import { engine, log, type Progress, type SaveTarget } from './engine';
import { download, fsa, handles, permitted, pickFiles, pickSave, type Picked } from './dialogs';
import { DEFAULT_SETTINGS, store } from './store';
import type { SourceInfo, Workspace } from './types';
import { button, confirmDialog, modal, notice } from './ui/overlays';
import { debounce, formatBytes, h, uid } from './util';

const RECENT_KEY = 'chronos.recent2';
const LAST_KEY = 'chronos.last2';
const UNTITLED = 'Untitled.chronos';
const EXPORT = 'Export.chronos';

/** A recently used workspace; its handle lives in IndexedDB under `ws:<id>`. */
export interface Recent {
  id: string;
  name: string;
}

/** Recent workspaces, newest first, one entry per file name (older lists could repeat one). */
function readRecent(): Recent[] {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as Recent[];
    const seen = new Set<string>();
    return list.filter((r) => !seen.has(r.name) && (seen.add(r.name), true));
  } catch {
    return [];
  }
}

function blankWorkspace(): Workspace {
  return { version: 1, worksheets: [], activeId: '', selectedWidgetId: null, settings: { ...store.ws.settings } };
}

/** Progress notice with a cancel button for long engine jobs. */
export function progressNotice(title: string) {
  const label = h('span', {}, `${title}…`);
  const bar = h('div', { class: 'notice-progress' }, h('div', {}));
  const cancel = h('button', { type: 'button', class: 'notice-cancel' }, '취소');
  const n = notice('', 0);
  n.el.replaceChildren(label, bar, cancel);
  return {
    onCancel(fn: () => void) {
      cancel.addEventListener('click', (e) => {
        e.stopPropagation();
        fn();
      });
    },
    update(p: Progress) {
      const pct = p.total ? Math.round((p.loaded / p.total) * 100) : 0;
      const phase =
        p.phase === 'index' ? '인덱스 생성 중' : p.phase === 'reprocess' ? `${p.name ?? ''} 변경됨 — 다시 처리 중` : p.phase === 'load' ? `${p.name ?? ''} 불러오는 중` : `${pct}%`;
      label.textContent = `${title} ${phase}`;
      (bar.firstElementChild as HTMLElement).style.width = `${p.phase === 'index' ? 100 : pct}%`;
    },
    hide: n.hide,
  };
}

/** A notice with action buttons (stays until used or dismissed). */
function askNotice(text: string, actions: [string, () => void][]) {
  const n = notice('', 0);
  n.el.replaceChildren(
    h('span', {}, text),
    ...actions.map(([label, fn]) => {
      const b = h('button', { type: 'button', class: 'notice-cancel' }, label);
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        n.hide();
        fn();
      });
      return b;
    }),
  );
  return n;
}

class Project {
  /** Where the workspace is saved: a picked file, or (Untitled) the browser's storage. */
  target: SaveTarget = { opfs: UNTITLED };
  name = 'Untitled';
  /** Id of the current file in the recent list (null for Untitled). */
  recentId: string | null = null;
  dirty = false;
  saving = false;
  recent: Recent[] = readRecent();
  private loading = 0;
  private saveQueued = false;
  private current: Promise<void> | null = null;

  get untitled() {
    return 'opfs' in this.target;
  }

  get title(): string {
    return this.untitled ? 'Untitled' : this.name.replace(/\.chronos$/i, '');
  }

  async init() {
    store.onChange = (ev) => {
      if (this.loading) return;
      if (ev === 'sources') {
        // new or re-processed data: always persist it into the workspace file
        void this.save({ quiet: true, auto: true });
        return;
      }
      if (this.untitled) this.autosave();
      else if (!this.dirty) {
        this.dirty = true;
        this.changed();
      }
    };
    await engine.clear();
    // the last named workspace reopens directly when the browser still allows
    // reading it; otherwise the Untitled autosave loads and a button offers it
    const last = localStorage.getItem(LAST_KEY);
    const r = last ? this.recent.find((x) => x.id === last) : null;
    const hd = r ? await handles.get(`ws:${r.id}`) : undefined;
    if (r && hd && (await permitted(hd, 'read', false))) {
      await this.openRecent(r, true);
      if (!this.untitled) return;
    }
    const untitled = await engine.opfsFile(UNTITLED);
    if (untitled) await this.openFile({ file: untitled }, { target: { opfs: UNTITLED }, quietIfOk: true });
    else {
      store.replaceWorkspace(store.ws, []);
      this.changed();
    }
    if (r && hd && !(await permitted(hd, 'read', false)))
      askNotice(`마지막 워크스페이스 "${r.name}"`, [['다시 열기', () => void this.confirmDiscard().then((ok) => (ok ? this.openRecent(r) : undefined))]]);
  }

  changed() {
    store.emit('project', undefined);
  }

  private autosave = debounce(() => void this.save({ quiet: true, auto: true }), 800);

  private workspaceJson(): Workspace {
    return JSON.parse(JSON.stringify(store.ws)) as Workspace;
  }

  private remembering: Promise<void> = Promise.resolve();

  /** Put a workspace at the top of the recent list (one entry per file). */
  private remember(handle: FileSystemFileHandle | null): Promise<void> {
    // one at a time: two overlapping calls would both add the same file
    this.remembering = this.remembering.then(() => this.rememberNow(handle)).catch(() => undefined);
    return this.remembering;
  }

  private async rememberNow(handle: FileSystemFileHandle | null) {
    if (!handle) {
      this.recentId = null;
      localStorage.removeItem(LAST_KEY);
      return;
    }
    // every entry for this file (same entry, or same file name) collapses into one
    const same: string[] = [];
    for (const r of this.recent) {
      const hd = await handles.get(`ws:${r.id}`);
      const match = r.name === handle.name || (hd ? await hd.isSameEntry(handle).catch(() => false) : false);
      if (match) same.push(r.id);
    }
    const id = same[0] ?? uid('ws');
    for (const old of same.slice(1)) void handles.del(`ws:${old}`);
    await handles.set(`ws:${id}`, handle);
    this.recentId = id;
    this.recent = [{ id, name: handle.name }, ...this.recent.filter((r) => !same.includes(r.id))].slice(0, 12);
    this.persistRecent();
    try {
      localStorage.setItem(LAST_KEY, id);
    } catch {
      /* storage unavailable */
    }
  }

  private persistRecent() {
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(this.recent));
    } catch {
      /* storage unavailable */
    }
  }

  forget(id: string) {
    this.recent = this.recent.filter((r) => r.id !== id);
    localStorage.setItem(RECENT_KEY, JSON.stringify(this.recent));
    void handles.del(`ws:${id}`);
    this.changed();
  }

  /**
   * Write the workspace file. `auto` saves go to the current file without
   * asking (the autosave for Untitled, or the user's file after new data).
   */
  async save(opts: { as?: boolean; quiet?: boolean; auto?: boolean } = {}) {
    if (this.current) {
      // a save is already writing: coalesce autosaves, but let an explicit
      // save (Ctrl+S / Save As) run right after it
      if (opts.auto) {
        this.saveQueued = true;
        return;
      }
      await this.current;
    }
    const run = this.doSave(opts);
    this.current = run;
    try {
      await run;
    } finally {
      if (this.current === run) this.current = null;
    }
    if (this.saveQueued) {
      this.saveQueued = false;
      void this.save({ quiet: true, auto: true });
    }
  }

  private async doSave(opts: { as?: boolean; quiet?: boolean; auto?: boolean }) {
    let target = this.target;
    let name = this.name;
    if (opts.as || (this.untitled && !opts.auto)) {
      const suggested = this.untitled ? 'workspace.chronos' : this.name;
      const handle = await pickSave('workspace', suggested);
      if (!handle) {
        if (!fsa) await this.exportDownload(suggested);
        return;
      }
      target = { handle };
      name = handle.name;
    }
    if ('handle' in target && !(await permitted(target.handle, 'readwrite', !opts.auto))) {
      // an automatic save cannot ask for permission: wait for Ctrl+S
      this.dirty = true;
      this.changed();
      if (!opts.quiet) notice('저장 권한이 없습니다.', 5000, 'error');
      return;
    }
    this.saving = true;
    this.changed();
    try {
      const r = await engine.save(target, this.workspaceJson(), [...store.sources.keys()]);
      log(`save ${name}: ${formatBytes(r.fileSize)}, ${r.rewrote ? 'rewrite' : `+${formatBytes(r.written)}`}, ${Math.round(r.ms)} ms`);
      const switched = target !== this.target;
      this.target = target;
      this.name = name;
      this.dirty = false;
      if (switched) await this.remember('handle' in target ? target.handle : null);
      if (!opts.quiet) notice(`${name} 저장 (${formatBytes(r.fileSize)}, ${r.rewrote ? '전체 기록' : `${formatBytes(r.written)} 추가`}, ${(r.ms / 1000).toFixed(1)}s)`);
    } catch (e) {
      log(`save failed: ${(e as Error).message}`);
      notice(`저장 실패: ${(e as Error).message}`, 8000, 'error');
    } finally {
      this.saving = false;
      this.changed();
    }
  }

  /** Browsers without file handles: build the file in private storage and download it. */
  private async exportDownload(name: string) {
    try {
      await engine.save({ opfs: EXPORT }, this.workspaceJson(), [...store.sources.keys()]);
      const f = await engine.opfsFile(EXPORT);
      if (f) download(f, name);
      setTimeout(() => void engine.opfsRemove(EXPORT), 120_000);
    } catch (e) {
      notice(`저장 실패: ${(e as Error).message}`, 8000, 'error');
    }
  }

  /** Ask before discarding unsaved changes. Resolves false to abort. */
  async confirmDiscard(): Promise<boolean> {
    if (!this.dirty || this.untitled) return true;
    return new Promise((resolve) => {
      let done = false;
      const m = modal('저장되지 않은 변경', { width: 440, onClose: () => !done && resolve(false) });
      m.content.append(h('p', {}, `"${this.title}" 의 변경 사항을 저장할까요?`));
      const finish = (v: boolean) => {
        done = true;
        m.close();
        resolve(v);
      };
      m.footer.append(
        button('취소', () => finish(false)),
        button('저장 안 함', () => finish(true)),
        button(
          '저장',
          async () => {
            done = true;
            m.close();
            await this.save();
            resolve(!this.dirty);
          },
          true,
        ),
      );
    });
  }

  async openDialog() {
    const [p] = await pickFiles('workspace', false);
    if (p) await this.open(p);
  }

  async openRecent(r: Recent, quiet = false) {
    const hd = await handles.get(`ws:${r.id}`);
    if (!hd || !(await permitted(hd, 'read', true))) {
      if (!hd) this.forget(r.id);
      notice(`${r.name}: 파일에 접근할 수 없습니다.`, 5000, 'error');
      return;
    }
    try {
      await this.open({ file: await hd.getFile(), handle: hd }, { force: true, quietIfOk: quiet });
    } catch (e) {
      notice(`${r.name}: ${(e as Error).message}`, 6000, 'error');
      if ((e as Error).name === 'NotFoundError') this.forget(r.id);
    }
  }

  /** Open a workspace file (from a picker, a drop or the recent list). */
  async open(p: Picked, opts: { force?: boolean; quietIfOk?: boolean } = {}) {
    if (!opts.force && !(await this.confirmDiscard())) return;
    // writable later only through a handle; otherwise it becomes Untitled content
    const target: SaveTarget = p.handle ? { handle: p.handle } : { opfs: UNTITLED };
    await this.openFile(p, { target, quietIfOk: opts.quietIfOk });
    if (p.handle) await this.remember(p.handle);
    else if (!this.untitled) await this.remember(null);
    if (!p.handle) await this.save({ quiet: true, auto: true });
    this.changed();
  }

  private async openFile(p: Picked, opts: { target: SaveTarget; quietIfOk?: boolean }) {
    const pn = progressNotice(`${p.file.name} 열기`);
    this.loading++;
    let needAccess: { id: string; name: string; handle: FileSystemFileHandle }[] = [];
    try {
      const peek = await engine.peek(p.file);
      // current CSVs where the browser already lets us read them
      const csv: Record<string, File | null> = {};
      for (const s of peek.sources) {
        const hd = await handles.get(`src:${s.id}`);
        if (!hd) continue;
        if (await permitted(hd, 'read', false)) {
          try {
            csv[s.id] = await hd.getFile();
          } catch {
            csv[s.id] = null;
          }
        } else needAccess.push({ id: s.id, name: s.name, handle: hd });
      }
      const job = engine.open(p.file, csv, (x) => pn.update(x));
      pn.onCancel(job.cancel);
      const r = await job.promise;
      pn.hide();
      const ws = (r.workspace as Workspace | null) ?? blankWorkspace();
      ws.settings = { ...DEFAULT_SETTINGS, ...ws.settings, theme: store.ws.settings.theme };
      store.replaceWorkspace(ws, r.sources);
      this.target = opts.target;
      this.name = p.file.name;
      this.dirty = false;
      log(`open ${p.file.name}: ${r.sources.length} sources, ${r.reprocessed.length} reprocessed`);
      if (r.reprocessed.length) void this.save({ quiet: true, auto: true });
      const msg = [r.reprocessed.length ? `변경된 CSV를 다시 처리했습니다: ${r.reprocessed.join(', ')}` : '', ...r.notes].filter(Boolean);
      if (msg.length || !opts.quietIfOk) notice([`${this.title} 열기 — 데이터 소스 ${r.sources.length}개`, ...msg].join('\n'), msg.length ? 9000 : 3000);
    } catch (e) {
      pn.hide();
      needAccess = [];
      if ((e as Error).message !== '취소됨') notice(`열기 실패: ${(e as Error).message}`, 8000, 'error');
    } finally {
      this.loading--;
      this.changed();
    }
    if (needAccess.length) {
      const names = needAccess.map((n) => n.name).join(', ');
      askNotice(`저장된 데이터로 열었습니다. 원본 CSV(${names})가 바뀌었는지 확인하려면 접근을 허용하세요.`, [['확인', () => void this.checkOriginals(needAccess)]]);
    }
  }

  /** After a click: re-process sources whose CSV changed since it was imported. */
  private async checkOriginals(list: { id: string; name: string; handle: FileSystemFileHandle }[]) {
    let changed = 0;
    for (const { id, handle } of list) {
      if (!(await permitted(handle, 'read', true))) continue;
      const src = store.sources.get(id);
      if (!src) continue;
      let file: File;
      try {
        file = await handle.getFile();
      } catch {
        notice(`원본 없음: ${src.name} (저장된 데이터 사용)`, 6000);
        continue;
      }
      if (file.size === src.size && file.lastModified === src.lastModified) continue;
      changed++;
      await this.reimport(file, src);
    }
    if (!changed) notice('원본 CSV가 바뀌지 않았습니다.');
  }

  private async reimport(file: File, src: SourceInfo) {
    const pn = progressNotice(`${src.name} 변경됨 — 다시 처리`);
    const job = engine.import(file, src.import, (p) => pn.update(p), src.id);
    pn.onCancel(job.cancel);
    try {
      store.addSource(await job.promise);
    } catch (e) {
      if ((e as Error).message !== '취소됨') notice(`${src.name}: ${(e as Error).message}`, 7000, 'error');
    } finally {
      pn.hide();
    }
  }

  async newWorkspace() {
    if (!(await this.confirmDiscard())) return;
    this.loading++;
    try {
      await engine.clear();
      store.replaceWorkspace(blankWorkspace(), []);
    } finally {
      this.loading--;
    }
    this.target = { opfs: UNTITLED };
    this.name = 'Untitled';
    this.dirty = false;
    await this.remember(null);
    await this.save({ quiet: true, auto: true });
  }

  /** Import one CSV with the import dialog. */
  async importFile(p: Picked, quick = false): Promise<SourceInfo | null> {
    for (const s of store.sources.values()) {
      if (s.name === p.file.name && s.size === p.file.size && s.lastModified === p.file.lastModified) {
        notice(`${p.file.name} 은(는) 이미 불러와져 있습니다.`);
        return s;
      }
    }
    const { openImportDialog } = await import('./ui/importDialog');
    const src = await openImportDialog(p.file, quick);
    if (src && p.handle) await handles.set(`src:${src.id}`, p.handle);
    return src;
  }
}

export const project = new Project();

export { confirmDialog };
