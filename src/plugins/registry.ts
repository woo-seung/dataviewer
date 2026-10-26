/**
 * Installed chart plugins. Three places, looked up in this order:
 *  - the workspace's own copies (so a shared .chronos file renders anywhere),
 *  - the user's library (browser storage; plugins imported here),
 *  - the built-ins shipped with the app (same format, in builtin/).
 */
import scatterSrc from './builtin/scatter-regression.js?raw';
import heatmapSrc from './builtin/time-heatmap.js?raw';
import densitySrc from './builtin/density-heatmap.js?raw';
import histogramSrc from './builtin/histogram.js?raw';
import corrSrc from './builtin/correlation-matrix.js?raw';
import { store } from '../store';
import type { ParamSpec, PluginManifest, PluginRecord } from './types';

const LIB_KEY = 'chronos.plugins';
const BUILTIN = [scatterSrc, heatmapSrc, densitySrc, histogramSrc, corrSrc];
const TYPES = new Set(['column', 'columns', 'number', 'select', 'boolean', 'text', 'color']);

/** The sandbox (with d3) loads only when a plugin is first used. */
const inspectPlugin = async (code: string) => (await import('./sandbox')).inspectPlugin(code);

function readLib(): PluginRecord[] {
  try {
    return JSON.parse(localStorage.getItem(LIB_KEY) ?? '[]') as PluginRecord[];
  } catch {
    return [];
  }
}

function validate(m: PluginManifest): PluginManifest {
  if (!m || typeof m !== 'object') throw new Error('플러그인 정보를 읽지 못했습니다.');
  if (typeof m.id !== 'string' || !/^[a-z0-9][a-z0-9._-]{1,63}$/.test(m.id)) throw new Error('id는 영문 소문자·숫자·-·_·. 로 된 2~64자여야 합니다 (예: "my-scatter").');
  if (typeof m.name !== 'string' || !m.name.trim()) throw new Error('name이 필요합니다.');
  const params: Record<string, ParamSpec> = m.params ?? {};
  for (const [k, p] of Object.entries(params)) {
    if (!p || !TYPES.has(p.type)) throw new Error(`파라미터 "${k}" 의 type이 올바르지 않습니다 (${[...TYPES].join(', ')}).`);
    if (p.type === 'select' && !Array.isArray(p.options)) throw new Error(`파라미터 "${k}" 에 options 배열이 필요합니다.`);
  }
  return { ...m, version: String(m.version ?? '1.0.0'), params };
}

class Registry {
  private lib: PluginRecord[] = readLib();
  private loading: Promise<PluginRecord[]> | null = null;
  onChange?: () => void;

  /** Built-in manifests are read from their code once (in the sandbox). */
  private loadBuiltins(): Promise<PluginRecord[]> {
    this.loading ??= Promise.all(BUILTIN.map(async (code) => ({ ...validate(await inspectPlugin(code)), code, builtin: true, installedAt: 0 })));
    return this.loading;
  }

  /** Everything that can be added as a widget (library entries override built-ins of the same id). */
  async list(): Promise<PluginRecord[]> {
    const b = await this.loadBuiltins();
    const ids = new Set(this.lib.map((p) => p.id));
    return [...b.filter((p) => !ids.has(p.id)), ...this.lib];
  }

  /** The plugin a widget uses: workspace copy, library, then built-in. */
  async get(id: string): Promise<PluginRecord | undefined> {
    return store.ws.plugins?.find((p) => p.id === id) ?? this.lib.find((p) => p.id === id) ?? (await this.loadBuiltins()).find((p) => p.id === id);
  }

  /** Check a plugin's code in the sandbox and add it to the library (replacing the same id). */
  async install(code: string): Promise<{ plugin: PluginRecord; replaced: boolean }> {
    const m = validate(await inspectPlugin(code));
    const plugin: PluginRecord = { ...m, code, installedAt: Date.now() };
    const replaced = this.lib.some((p) => p.id === m.id) || (await this.loadBuiltins()).some((p) => p.id === m.id);
    this.lib = [...this.lib.filter((p) => p.id !== m.id), plugin];
    this.persist();
    // widgets already using it pick up the new version
    if (store.ws.plugins?.some((p) => p.id === m.id)) this.embed(plugin);
    return { plugin, replaced };
  }

  remove(id: string) {
    this.lib = this.lib.filter((p) => p.id !== id);
    this.persist();
  }

  /** Keep a copy in the workspace file (done when a widget starts using a plugin). */
  embed(p: PluginRecord) {
    if (p.builtin) return;
    const list = (store.ws.plugins ??= []);
    const i = list.findIndex((x) => x.id === p.id);
    if (i >= 0) list[i] = p;
    else list.push(p);
    store.emit('plugins', undefined);
  }

  /** A workspace copy not in the library yet (opened from someone else's file). */
  async adopt(id: string) {
    const p = store.ws.plugins?.find((x) => x.id === id);
    if (p) {
      this.lib = [...this.lib.filter((x) => x.id !== id), { ...p, builtin: false }];
      this.persist();
    }
  }

  inLibrary(id: string) {
    return this.lib.some((p) => p.id === id);
  }

  private persist() {
    try {
      localStorage.setItem(LIB_KEY, JSON.stringify(this.lib));
    } catch {
      /* storage full: the workspace copies still work */
    }
    this.onChange?.();
    store.emit('plugins', undefined);
  }
}

export const plugins = new Registry();
