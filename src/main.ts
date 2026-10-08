import 'gridstack/dist/gridstack.min.css';
import 'uplot/dist/uPlot.min.css';
import './styles/app.css';
import { initStore } from './store';
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
