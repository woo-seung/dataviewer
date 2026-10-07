import { generateSampleCsv } from './data/csv';
import { deserializeSource, type SerializedSource } from './data/db';
import { isChronosFile } from './data/chronosFile';
import { CSV_TYPES, WS_TYPES, fsaSupported, pickOpenFiles } from './fs/fsa';
import { project } from './project';
import { store } from './store';
import type { DataSource, Workspace } from './types';
import { openImportDialog } from './ui/importDialog';
import { confirmDialog, notice } from './ui/overlays';
import { pickFiles } from './util';

/** Previous JSON workspace format (base64 data), still readable. */
interface LegacyWorkspaceFile {
  app: 'chronos-vault';
  version: 1;
  workspace: Workspace;
  sources: SerializedSource[];
}

/** Add every numeric column of a freshly imported source as one chart on the active sheet. */
function chartSource(src: DataSource) {
  const ws = store.active;
  const items = src.columns.slice(0, 8).map((c) => ({ sourceId: src.id, column: c.name }));
  store.addWidget(ws.id, { title: src.name.replace(/\.(csv|tsv|txt)$/i, ''), w: 12, h: 6 }, items);
}

const isWorkspaceName = (n: string) => /\.(chronos|json)$/i.test(n);

async function openLegacy(file: File) {
  const data = JSON.parse(await file.text()) as LegacyWorkspaceFile;
  if (data.app !== 'chronos-vault' || !data.workspace) throw new Error('워크스페이스 파일이 아닙니다.');
  project.closeFile();
  store.replaceWorkspace(data.workspace, data.sources.map(deserializeSource));
  notice(`이전 형식 워크스페이스 "${file.name}" 를 열었습니다. 저장하면 .chronos 형식으로 저장됩니다.`, 6000);
}

export const actions = {
  /** Open CSVs (or a workspace). With File System Access, handles keep the relative path. */
  async openCsv(files?: File[]) {
    if (!files && fsaSupported) {
      for (const h of await pickOpenFiles(CSV_TYPES, true)) {
        if (isWorkspaceName(h.name)) await actions.openWorkspace(h);
        else await project.importHandle(h);
      }
      return;
    }
    const list = files ?? (await pickFiles('.csv,.tsv,.txt,text/csv'));
    for (const f of list) {
      if (isWorkspaceName(f.name)) await actions.openWorkspace(f);
      else await openImportDialog(f);
    }
  },

  /** Files/handles dropped onto the window. */
  async openDropped(items: (FileSystemHandle | File)[]) {
    for (const it of items) {
      if (it instanceof File) {
        await actions.openCsv([it]);
        continue;
      }
      if (it.kind !== 'file') continue;
      const h = it as FileSystemFileHandle;
      if (isWorkspaceName(h.name)) await actions.openWorkspace(h);
      else await project.importHandle(h);
    }
  },

  async loadSample() {
    const src = await openImportDialog(generateSampleCsv(), true);
    if (!src) return;
    const ws = store.active;
    const id = (n: string) => ({ sourceId: src.id, column: n });
    store.addWidget(ws.id, { title: 'CPU load', x: 0, y: 0, w: 6, h: 5, type: 'area', yAxis: { auto: true, min: null, max: null, log: false, unit: '%', siPrefix: false, includeZero: true } }, [id('cpu_load')]);
    store.addWidget(ws.id, { title: 'Network', x: 6, y: 0, w: 6, h: 5, type: 'stacked', yAxis: { auto: true, min: null, max: null, log: false, unit: 'kbps', siPrefix: false, includeZero: true } }, [id('network_rx_kbps'), id('network_tx_kbps')]);
    store.addWidget(ws.id, { title: 'Temperature', x: 0, y: 5, w: 8, h: 5, yAxis: { auto: true, min: null, max: null, log: false, unit: '°C', siPrefix: false, includeZero: false } }, [id('temperature_c')]);
    store.addWidget(ws.id, { title: 'Disk IOPS', x: 8, y: 5, w: 4, h: 5, type: 'scatter' }, [id('disk_iops')]);
    store.addWidget(ws.id, { title: 'Memory', x: 0, y: 10, w: 12, h: 5, type: 'step' }, [id('memory_mb')]);
  },

  chartSource,

  saveWorkspace: () => project.save(),
  saveWorkspaceAs: () => project.save({ as: true }),
  openFolder: () => project.openFolder(),

  async openWorkspace(src?: FileSystemFileHandle | File) {
    let target = src;
    if (!target) {
      if (fsaSupported) target = (await pickOpenFiles(WS_TYPES, false))[0];
      else target = (await pickFiles('.chronos,.json,application/json', false))[0];
    }
    if (!target) return;
    try {
      const file = target instanceof File ? target : await target.getFile();
      if (await isChronosFile(file)) await project.open(target);
      else await openLegacy(file);
    } catch (e) {
      notice(`열기 실패: ${(e as Error).message}`, 6000, 'error');
    }
  },

  async resetWorkspace() {
    if (!(await confirmDialog('워크스페이스 초기화', '모든 워크시트, 위젯, 불러온 데이터를 비웁니다 (디스크의 파일은 그대로). 계속할까요?', '초기화'))) return;
    project.closeFile();
    const blank = { version: 1 as const, worksheets: [], activeId: '', selectedWidgetId: null, settings: store.ws.settings };
    store.replaceWorkspace(blank, []);
  },

  toggleTheme() {
    store.updateSettings({ theme: store.ws.settings.theme === 'dark' ? 'light' : 'dark' });
  },
  toggleLeft() {
    store.updateSettings({ leftOpen: !store.ws.settings.leftOpen });
  },
  toggleRight() {
    store.updateSettings({ rightOpen: !store.ws.settings.rightOpen });
  },
};
