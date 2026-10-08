import { engine } from './engine';
import { openFiles } from './dialogs';
import { project } from './project';
import { store } from './store';
import type { SourceInfo } from './types';
import { confirmDialog, notice } from './ui/overlays';

/** Add the numeric columns of a source (up to 8) as one chart on the active sheet. */
function chartSource(src: SourceInfo) {
  const ws = store.active;
  const items = src.columns.slice(0, 8).map((c) => ({ sourceId: src.id, column: c.name }));
  store.addWidget(ws.id, { title: src.name.replace(/\.(csv|tsv|txt)$/i, ''), w: 12, h: 6 }, items);
}

const isWorkspace = (p: string) => /\.chronos$/i.test(p);

export const actions = {
  /** Pick CSVs (or a workspace) with the native dialog. */
  async openCsv() {
    for (const p of await openFiles('any', true)) await actions.openPath(p);
  },

  async openPath(path: string) {
    if (isWorkspace(path)) await project.open(path);
    else await project.importPath(path);
  },

  /** Paths dropped onto the window. */
  async openDropped(paths: string[]) {
    const ws = paths.find(isWorkspace);
    if (ws) return project.open(ws);
    for (const p of paths) if (/\.(csv|tsv|txt)$/i.test(p)) await project.importPath(p);
  },

  async loadSample() {
    const { path } = await engine.sample();
    const src = await project.importPath(path, true);
    if (!src) return;
    const ws = store.active;
    const id = (n: string) => ({ sourceId: src.id, column: n });
    const axis = (unit: string, includeZero: boolean, siPrefix = false) => ({ auto: true, min: null, max: null, log: false, unit, siPrefix, includeZero });
    store.addWidget(ws.id, { title: 'CPU load', x: 0, y: 0, w: 6, h: 5, type: 'area', yAxis: axis('%', true) }, [id('cpu_load')]);
    store.addWidget(ws.id, { title: 'Network', x: 6, y: 0, w: 6, h: 5, type: 'stacked', yAxis: axis('kbps', true) }, [id('network_rx_kbps'), id('network_tx_kbps')]);
    store.addWidget(ws.id, { title: 'Temperature', x: 0, y: 5, w: 8, h: 5, yAxis: axis('°C', false) }, [id('temperature_c')]);
    store.addWidget(ws.id, { title: 'Disk IOPS', x: 8, y: 5, w: 4, h: 5, type: 'scatter' }, [id('disk_iops')]);
    store.addWidget(ws.id, { title: 'Memory', x: 0, y: 10, w: 12, h: 5, type: 'step' }, [id('memory_mb')]);
  },

  chartSource,

  async removeSource(id: string) {
    const src = store.sources.get(id);
    if (!src) return store.removeSource(id);
    if (!(await confirmDialog('데이터 소스 제거', `"${src.name}" 을(를) 제거하면 이 데이터를 사용하는 모든 시리즈가 차트에서 빠집니다.`, '제거'))) return;
    try {
      await engine.remove(id);
    } catch (e) {
      notice((e as Error).message, 5000, 'error');
    }
    store.removeSource(id);
  },

  saveWorkspace: () => project.save(),
  saveWorkspaceAs: () => project.save({ as: true }),
  openWorkspace: () => project.openDialog(),
  newWorkspace: () => project.newWorkspace(),

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
