import 'gridstack/dist/gridstack.min.css';
import './styles/app.css';
import { initStore } from './store';
import { sourceDb } from './data/db';
import { App } from './ui/app';

async function boot() {
  const store = initStore();
  document.body.classList.add(store.ws.settings.theme === 'dark' ? 'theme-dark' : 'theme-light');
  const sources = await sourceDb.all();
  for (const s of sources) store.sources.set(s.id, s);
  new App(document.getElementById('app')!);
}

void boot();
