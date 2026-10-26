/**
 * Plugin sandbox: each plugin chart runs in an iframe with `sandbox=
 * "allow-scripts"` (opaque origin: no cookies, storage, IndexedDB or file
 * handles of this app) and a CSP without any network access, so code an LLM
 * wrote can neither read the user's files nor send data anywhere. It talks to
 * the app only through postMessage (runtime.js ↔ PluginFrame).
 */
// d3's package exports hide dist/, so the file is imported by path
import d3src from '../../node_modules/d3/dist/d3.min.js?raw';
import runtimeSrc from './runtime.js?raw';
import { PALETTE } from '../palette';
import { store } from '../store';
import { cssVar } from '../util';
import type { PluginManifest } from './types';

const CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:";

/** Turn an ES module plugin into a classic script that sets window.__plugin. */
export function prepareCode(code: string): string {
  let c = code.replace(/^﻿/, '');
  // d3 is provided as a global; other imports cannot work without a network
  c = c.replace(/^\s*import\s+(?:\*\s+as\s+\w+|\{[^}]*\}|\w+)\s+from\s+['"]d3[^'"]*['"];?\s*$/gm, '');
  if (/^\s*import\s/m.test(c)) throw new Error('플러그인은 import를 쓸 수 없습니다 (d3는 전역 변수로 제공됩니다).');
  if (!/export\s+default\s/.test(c)) throw new Error('플러그인 코드에 `export default { ... }` 가 없습니다.');
  c = c.replace(/export\s+default\s+/, 'window.__plugin = ');
  c = c.replace(/^(\s*)export\s+(?=(const|let|var|function|class|async)\b)/gm, '$1');
  return c;
}

const esc = (s: string) => s.replace(/<\/script/gi, '<\\/script');

function srcdoc(code: string): string {
  const prepared = prepareCode(code);
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<style>
html,body{margin:0;height:100%;overflow:hidden;background:transparent;color:var(--text);font:12px/1.4 -apple-system,"Segoe UI",Roboto,"Noto Sans KR",sans-serif}
#root{position:absolute;inset:0;overflow:hidden}
svg{display:block}
.chronos-tooltip{position:fixed;display:none;pointer-events:none;z-index:9;padding:4px 8px;border-radius:4px;background:var(--tooltip-bg);color:var(--text);border:1px solid var(--grid);font-size:11px;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,.25)}
.chronos-error{margin:8px;padding:8px;white-space:pre-wrap;color:#e93147;font:11px/1.4 ui-monospace,monospace;overflow:auto;max-height:calc(100% - 16px)}
</style>
<script>window.__loadErrors=[];addEventListener('error',function(e){window.__loadErrors.push(e.message)});</script>
</head><body><div id="root"></div>
<script>${esc(d3src)}</script>
<script>${esc(prepared)}</script>
<script>${esc(runtimeSrc)}</script>
</body></html>`;
}

/** Colours and fonts handed to plugins (also set as CSS variables inside the sandbox). */
export function pluginTheme() {
  const dark = store.ws.settings.theme === 'dark';
  const vars = {
    '--text': cssVar('--text-normal'),
    '--muted': cssVar('--text-muted'),
    '--faint': cssVar('--text-faint'),
    '--grid': cssVar('--background-modifier-border'),
    '--background': cssVar('--background-primary'),
    '--tooltip-bg': cssVar('--background-secondary'),
    '--accent': cssVar('--interactive-accent'),
  };
  return {
    dark,
    text: vars['--text'],
    muted: vars['--muted'],
    faint: vars['--faint'],
    grid: vars['--grid'],
    background: vars['--background'],
    accent: vars['--accent'],
    palette: [...PALETTE[dark ? 'dark' : 'light']],
    font: '12px -apple-system, "Segoe UI", Roboto, "Noto Sans KR", sans-serif',
    vars,
  };
}

type Api = (method: string, args: Record<string, unknown>) => Promise<unknown>;

/** Typed arrays in a result move to the sandbox without copying. */
function transferables(v: unknown, out: Transferable[] = []): Transferable[] {
  if (ArrayBuffer.isView(v)) out.push(v.buffer as ArrayBuffer);
  else if (Array.isArray(v)) v.forEach((x) => transferables(x, out));
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => transferables(x, out));
  return [...new Set(out)];
}

export class PluginFrame {
  readonly iframe: HTMLIFrameElement;
  private ready: Promise<void>;
  private snaps = new Map<number, (url: string | null) => void>();
  private seq = 0;
  onSetRange?: (start: number, end: number) => void;
  onError?: (message: string) => void;
  onRendered?: () => void;
  private listener: (e: MessageEvent) => void;

  constructor(code: string, private api: Api) {
    this.iframe = document.createElement('iframe');
    this.iframe.className = 'plugin-frame';
    this.iframe.setAttribute('sandbox', 'allow-scripts');
    this.iframe.setAttribute('referrerpolicy', 'no-referrer');
    let markReady!: () => void;
    this.ready = new Promise((r) => (markReady = r));
    this.listener = (e) => {
      if (e.source !== this.iframe.contentWindow) return;
      const m = e.data ?? {};
      if (m.type === 'ready') markReady();
      else if (m.type === 'call') void this.answer(m.id, m.method, m.args ?? {});
      else if (m.type === 'setRange' && Number.isFinite(m.start) && Number.isFinite(m.end) && m.end > m.start) this.onSetRange?.(m.start, m.end);
      else if (m.type === 'error') this.onError?.(String(m.message));
      else if (m.type === 'rendered') this.onRendered?.();
      else if (m.type === 'snapshot') {
        this.snaps.get(m.id)?.(m.url ?? null);
        this.snaps.delete(m.id);
      }
    };
    window.addEventListener('message', this.listener);
    this.iframe.srcdoc = srcdoc(code);
  }

  private async answer(id: number, method: string, args: Record<string, unknown>) {
    try {
      const value = await this.api(method, args);
      this.iframe.contentWindow?.postMessage({ type: 'result', id, ok: true, value }, '*', transferables(value));
    } catch (e) {
      this.iframe.contentWindow?.postMessage({ type: 'result', id, ok: false, error: (e as Error).message }, '*');
    }
  }

  async render(msg: { params: unknown; width: number; height: number; range: { start: number; end: number } | null }) {
    await this.ready;
    this.iframe.contentWindow?.postMessage({ type: 'render', ...msg, theme: pluginTheme() }, '*');
  }

  async snapshot(): Promise<string | null> {
    await this.ready;
    const id = ++this.seq;
    return new Promise((resolve) => {
      this.snaps.set(id, resolve);
      this.iframe.contentWindow?.postMessage({ type: 'snapshot', id }, '*');
      setTimeout(() => this.snaps.has(id) && (this.snaps.delete(id), resolve(null)), 5000);
    });
  }

  destroy() {
    window.removeEventListener('message', this.listener);
    this.iframe.remove();
  }
}

/** Read a plugin's manifest by loading it in a throwaway sandbox. */
export function inspectPlugin(code: string): Promise<PluginManifest> {
  return new Promise((resolve, reject) => {
    let doc: string;
    try {
      doc = srcdoc(code);
    } catch (e) {
      reject(e);
      return;
    }
    const f = document.createElement('iframe');
    f.setAttribute('sandbox', 'allow-scripts');
    f.style.cssText = 'position:fixed;width:10px;height:10px;left:-100px;top:-100px;visibility:hidden';
    const done = (fn: () => void) => {
      window.removeEventListener('message', onMsg);
      clearTimeout(timer);
      f.remove();
      fn();
    };
    const onMsg = (e: MessageEvent) => {
      if (e.source !== f.contentWindow) return;
      const m = e.data ?? {};
      if (m.type === 'ready') f.contentWindow?.postMessage({ type: 'inspect' }, '*');
      else if (m.type === 'manifest') done(() => (m.error ? reject(new Error(m.error)) : resolve(m.manifest as PluginManifest)));
    };
    const timer = setTimeout(() => done(() => reject(new Error('플러그인을 읽는 데 시간이 너무 오래 걸립니다.'))), 8000);
    window.addEventListener('message', onMsg);
    f.srcdoc = doc;
    document.body.append(f);
  });
}
