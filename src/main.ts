import 'gridstack/dist/gridstack.min.css';
import 'uplot/dist/uPlot.min.css';
import './styles/app.css';
import { initStore, MAX_SERIES_PER_CHART } from './store';
import { App } from './ui/app';
import { project, confirmClose } from './project';
import { hasEngine, isDesktop } from './engine';
import { notice } from './ui/overlays';

async function boot() {
  const store = initStore();
  document.body.classList.add(store.ws.settings.theme === 'dark' ? 'theme-dark' : 'theme-light');
  new App(document.getElementById('app')!);
  (window as unknown as { __chronos: unknown }).__chronos = { store, project };
  if (!hasEngine) {
    notice('데이터 엔진이 없습니다. Chronos Vault 데스크톱 앱으로 실행하세요.', 0, 'error');
    return;
  }
  const { engine } = await import('./engine');
  // diagnostics → chronos.log in the app data folder
  let errors = 0;
  const report = (m: string) => errors++ < 50 && void engine.log(m);
  window.addEventListener('error', (e) => report(`error: ${e.message} @ ${e.filename}:${e.lineno}`));
  window.addEventListener('unhandledrejection', (e) => report(`unhandled: ${(e.reason as Error)?.stack ?? e.reason}`));
  const heap = () => (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0;
  void engine.log(`ui loaded (heap ${Math.round(heap() / 1e6)} MB)`);
  store.onSeriesLimit = (added, skipped) => {
    notice(`차트 하나에는 시리즈를 ${MAX_SERIES_PER_CHART}개까지 넣을 수 있습니다. ${added}개를 추가하고 ${skipped}개는 건너뛰었습니다.`, 6000);
    void engine.log(`series limit: added ${added}, skipped ${skipped}`);
  };
  setInterval(() => void engine.log(`heartbeat: heap ${Math.round(heap() / 1e6)} MB, ${document.querySelectorAll('canvas').length} canvases, ${store.sources.size} sources`), 60_000);

  await project.init();
  if (isDesktop) {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    const { listen } = await import('@tauri-apps/api/event');
    const win = getCurrentWindow();
    // unsaved changes guard
    await win.onCloseRequested(async (e) => {
      e.preventDefault();
      if (await confirmClose()) await win.destroy();
    });
    // a second launch (double-clicked .chronos / CSV) forwards its files here
    await listen<string[]>('open-files', (e) => {
      void (async () => {
        const { actions } = await import('./actions');
        for (const p of e.payload) await actions.openPath(p);
      })();
    });
  }
}

void boot();
