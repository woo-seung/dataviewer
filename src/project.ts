/**
 * The open workspace file (.chronos).
 *
 * There is always one: until the user saves somewhere, work goes to an
 * auto-saved "Untitled" workspace in the app data folder, so imported data and
 * its preprocessing are never lost. The engine writes the CSV paths (absolute
 * and relative to the workspace file) and the parsed data + index into the
 * file; re-opening it serves unchanged CSVs from that cache and re-processes
 * changed ones automatically.
 */
import { engine, type Progress } from './engine';
import { baseName, joinPath, openFiles, saveFile } from './dialogs';
import { DEFAULT_SETTINGS, store } from './store';
import type { SourceInfo, Workspace } from './types';
import { button, confirmDialog, modal, notice } from './ui/overlays';
import { debounce, formatBytes, h } from './util';

const RECENT_KEY = 'chronos.recent';
const LAST_KEY = 'chronos.last';

function readRecent(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as string[];
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
      const phase = p.phase === 'index' ? '인덱스 생성 중' : p.phase === 'reprocess' ? `${p.name ?? ''} 변경됨 — 다시 처리 중` : `${pct}%`;
      label.textContent = `${title} ${phase}`;
      (bar.firstElementChild as HTMLElement).style.width = `${p.phase === 'index' ? 100 : pct}%`;
    },
    hide: n.hide,
  };
}

class Project {
  path: string | null = null;
  /** The current file is the app-data autosave ("Untitled"). */
  untitled = true;
  dirty = false;
  saving = false;
  recent: string[] = readRecent();
  private autosavePath = '';
  private loading = 0;
  private saveQueued = false;
  private current: Promise<void> | null = null;

  async init() {
    const info = await engine.appInfo();
    this.autosavePath = joinPath(info.dataDir, 'Untitled.chronos');
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
    await engine.clear(); // the UI starts empty; never persist stale engine data
    const launch = info.launchFiles ?? [];
    const ws = launch.find((f) => /\.chronos$/i.test(f));
    const last = localStorage.getItem(LAST_KEY);
    if (ws) await this.open(ws, { force: true });
    else if (last && (await engine.stat(last)).exists) await this.open(last, { force: true, quietIfOk: true });
    else if ((await engine.stat(this.autosavePath)).exists) await this.open(this.autosavePath, { force: true, quietIfOk: true });
    else {
      this.path = this.autosavePath;
      this.untitled = true;
      await this.restoreMissing();
      this.changed();
    }
    for (const csv of launch.filter((f) => !/\.chronos$/i.test(f))) await this.importPath(csv);
  }

  changed() {
    store.emit('project', undefined);
  }

  get title(): string {
    if (!this.path || this.untitled) return 'Untitled';
    return baseName(this.path).replace(/\.chronos$/i, '');
  }

  private autosave = debounce(() => void this.save({ quiet: true, auto: true }), 800);

  private workspaceJson(): Workspace {
    return JSON.parse(JSON.stringify(store.ws)) as Workspace;
  }

  private remember(path: string) {
    if (path === this.autosavePath) {
      localStorage.removeItem(LAST_KEY);
      return;
    }
    this.recent = [path, ...this.recent.filter((p) => p !== path)].slice(0, 12);
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(this.recent));
      localStorage.setItem(LAST_KEY, path);
    } catch {
      /* storage unavailable */
    }
  }

  forget(path: string) {
    this.recent = this.recent.filter((p) => p !== path);
    localStorage.setItem(RECENT_KEY, JSON.stringify(this.recent));
    this.changed();
  }

  /**
   * Write the workspace file. `auto` saves go to the current file without
   * asking (the autosave for Untitled, or the user's file after new data).
   */
  async save(opts: { as?: boolean; quiet?: boolean; auto?: boolean } = {}) {
    if (this.current) {
      // an automatic save is already writing: coalesce autosaves, but let an
      // explicit save (Ctrl+S / Save As) run right after it
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
    let path = this.path;
    if (opts.as || !path || (this.untitled && !opts.auto)) {
      const picked = await saveFile('workspace', this.untitled ? 'workspace.chronos' : (this.path ?? undefined));
      if (!picked) return;
      path = /\.chronos$/i.test(picked) ? picked : `${picked}.chronos`;
    }
    this.saving = true;
    this.changed();
    try {
      const r = await engine.save(path, this.workspaceJson(), [...store.sources.keys()]);
      this.path = path;
      this.untitled = path === this.autosavePath;
      this.dirty = false;
      this.remember(path);
      if (!opts.quiet) notice(`${baseName(path)} 저장 (${formatBytes(r.fileSize)}, ${r.rewrote ? '전체 기록' : `${formatBytes(r.written)} 추가`}, ${(r.ms / 1000).toFixed(1)}s)`);
    } catch (e) {
      notice(`저장 실패: ${(e as Error).message}`, 8000, 'error');
    } finally {
      this.saving = false;
      this.changed();
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
    const [p] = await openFiles('workspace', false);
    if (p) await this.open(p);
  }

  async open(path: string, opts: { force?: boolean; quietIfOk?: boolean } = {}) {
    if (!opts.force && !(await this.confirmDiscard())) return;
    const pn = progressNotice(`${baseName(path)} 열기`);
    const job = engine.open(path, (p) => pn.update(p));
    pn.onCancel(job.cancel);
    this.loading++;
    try {
      const r = await job.promise;
      pn.hide();
      const ws = (r.workspace as Workspace | null) ?? blankWorkspace();
      ws.settings = { ...DEFAULT_SETTINGS, ...ws.settings, theme: store.ws.settings.theme };
      store.replaceWorkspace(ws, r.sources);
      this.path = path;
      this.untitled = path === this.autosavePath;
      this.dirty = false;
      this.remember(path);
      if (r.reprocessed.length) await this.save({ quiet: true, auto: true });
      const msg = [
        r.reprocessed.length ? `변경된 CSV를 다시 처리했습니다: ${r.reprocessed.join(', ')}` : '',
        ...r.notes,
      ].filter(Boolean);
      if (msg.length || !opts.quietIfOk) notice([`${this.title} 열기 — 데이터 소스 ${r.sources.length}개`, ...msg].join('\n'), msg.length ? 9000 : 3000);
    } catch (e) {
      pn.hide();
      if ((e as Error).message !== '취소됨') {
        notice(`열기 실패: ${(e as Error).message}`, 8000, 'error');
        if (/찾을 수 없습니다/.test((e as Error).message)) this.forget(path);
      }
    } finally {
      this.loading--;
      this.changed();
    }
    await this.restoreMissing();
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
    this.path = this.autosavePath;
    this.untitled = true;
    this.dirty = false;
    await this.save({ quiet: true, auto: true });
  }

  /** Import one CSV path with the import dialog (relinks a missing source with the same path). */
  async importPath(path: string, quick = false): Promise<SourceInfo | null> {
    const existing = store.sourceByPath(path);
    if (existing) {
      notice(`${baseName(path)} 은(는) 이미 불러와져 있습니다.`);
      return existing;
    }
    const { openImportDialog } = await import('./ui/importDialog');
    return openImportDialog(path, quick);
  }

  /** Charts reference sources the engine doesn't have: re-import them from their CSVs. */
  async restoreMissing() {
    const missing = store.missingSources().filter((m) => m.path && m.import);
    if (!missing.length) return;
    for (const m of missing) {
      const pn = progressNotice(`${m.name} 다시 불러오기`);
      const job = engine.import(m.path, m.import, (p) => pn.update(p), m.id);
      pn.onCancel(job.cancel);
      try {
        store.addSource(await job.promise);
      } catch (e) {
        notice(`${m.name}: ${(e as Error).message}`, 7000, 'error');
      } finally {
        pn.hide();
      }
    }
  }
}

export const project = new Project();

/** Close-button guard for the desktop window. */
export async function confirmClose(): Promise<boolean> {
  return project.confirmDiscard();
}

export { confirmDialog };
