import 'uplot/dist/uPlot.min.css';
import './styles/app.css';
import { initStore, MAX_SERIES_PER_CHART } from './store';
import { App } from './ui/app';
import { project } from './project';
import { log } from './engine';
import { notice } from './ui/overlays';

async function boot() {
  const store = initStore();
  document.body.classList.add(store.ws.settings.theme === 'dark' ? 'theme-dark' : 'theme-light');
  new App(document.getElementById('app')!);
  (window as unknown as { __chronos: unknown }).__chronos = { store, project };
  // diagnostics (saved with the command "진단 로그 저장")
  let errors = 0;
  const report = (m: string) => errors++ < 50 && log(m);
  window.addEventListener('error', (e) => report(`error: ${e.message} @ ${e.filename}:${e.lineno}`));
  window.addEventListener('unhandledrejection', (e) => report(`unhandled: ${(e.reason as Error)?.stack ?? e.reason}`));
  log(`ui loaded: ${navigator.userAgent}`);
  store.onSeriesLimit = (added, skipped) => {
    notice(`차트 하나에는 시리즈를 ${MAX_SERIES_PER_CHART}개까지 넣을 수 있습니다. ${added}개를 추가하고 ${skipped}개는 건너뛰었습니다.`, 6000);
    log(`series limit: added ${added}, skipped ${skipped}`);
  };
  // keep the browser from evicting the autosaved workspace under storage pressure
  void navigator.storage?.persist?.().catch(() => false);
  window.addEventListener('beforeunload', (e) => {
    if (project.dirty || project.saving) e.preventDefault();
  });
  await project.init();
}

void boot();
