import { generateSampleCsv } from './data/csv';
import { deserializeSource, serializeSource, type SerializedSource } from './data/db';
import { store } from './store';
import type { DataSource, Workspace } from './types';
import { openImportDialog } from './ui/importDialog';
import { confirmDialog, notice } from './ui/overlays';
import { downloadBlob, pickFiles } from './util';

interface WorkspaceFile {
  app: 'chronos-vault';
  version: 1;
  savedAt: string;
  workspace: Workspace;
  sources: SerializedSource[];
}

/** Add every numeric column of a freshly imported source as one chart on the active sheet. */
function chartSource(src: DataSource) {
  const ws = store.active;
  const items = src.columns.slice(0, 8).map((c) => ({ sourceId: src.id, column: c.name }));
  store.addWidget(ws.id, { title: src.name.replace(/\.(csv|tsv|txt)$/i, ''), w: 12, h: 6 }, items);
}

export const actions = {
  async openCsv(files?: File[]) {
    const list = files ?? (await pickFiles('.csv,.tsv,.txt,text/csv'));
    for (const f of list) {
      if (/\.json$/i.test(f.name)) {
        await actions.openWorkspace(f);
        continue;
      }
      await openImportDialog(f);
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

  async saveWorkspace() {
    const file: WorkspaceFile = {
      app: 'chronos-vault',
      version: 1,
      savedAt: new Date().toISOString(),
      workspace: store.ws,
      sources: [...store.sources.values()].map(serializeSource),
    };
    downloadBlob(new Blob([JSON.stringify(file)], { type: 'application/json' }), `workspace-${new Date().toISOString().slice(0, 10)}.chronos.json`);
    notice('워크스페이스를 저장했습니다 (데이터 포함).');
  },

  async openWorkspace(f?: File) {
    const file = f ?? (await pickFiles('.json,application/json', false))[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text()) as WorkspaceFile;
      if (data.app !== 'chronos-vault' || !data.workspace) throw new Error('워크스페이스 파일이 아닙니다.');
      store.replaceWorkspace(data.workspace, data.sources.map(deserializeSource));
      notice(`워크스페이스 "${file.name}" 를 열었습니다.`);
    } catch (e) {
      notice(`열기 실패: ${(e as Error).message}`, 6000, 'error');
    }
  },

  async resetWorkspace() {
    if (!(await confirmDialog('워크스페이스 초기화', '모든 워크시트, 위젯, 불러온 데이터를 삭제합니다. 계속할까요?', '초기화'))) return;
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
