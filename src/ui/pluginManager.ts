/**
 * Plugin manager: copy the spec for an LLM, install the plugin it writes
 * (paste or .js file), and add / export / remove plugins.
 */
import { ClipboardCopy, Code, Download, FileUp, Plus, Puzzle, Trash2, Upload } from 'lucide';
import { plugins } from '../plugins/registry';
import { pluginSpec } from '../plugins/spec';
import type { PluginRecord } from '../plugins/types';
import { download, pickFiles } from '../dialogs';
import { store } from '../store';
import { h, icon } from '../util';
import { button, confirmDialog, modal, notice } from './overlays';

async function copy(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text);
    notice(`클립보드에 복사했습니다: ${what}`);
  } catch {
    // clipboard blocked: show it to copy by hand
    const m = modal(what, { width: 760 });
    const t = h('textarea', { class: 'plugin-code', readonly: true }) as HTMLTextAreaElement;
    t.value = text;
    m.content.append(h('p', { class: 'muted' }, '클립보드에 접근할 수 없습니다. 아래 내용을 전체 선택해 복사하세요.'), t);
    t.select();
  }
}

/** The plugin source from whatever was pasted (an LLM answer with ```js fences, or bare code). */
export function extractCode(text: string): string {
  const blocks = [...text.matchAll(/```(?:js|javascript|mjs|ts)?[^\n]*\n([\s\S]*?)```/gi)].map((m) => m[1]);
  const withExport = blocks.filter((b) => /export\s+default/.test(b));
  const pick = (withExport.length ? withExport : blocks).sort((a, b) => b.length - a.length)[0];
  return (pick ?? text).trim();
}

/** Add a widget using the plugin on the active worksheet. */
export function addPluginWidget(p: PluginRecord) {
  plugins.embed(p);
  const w = store.addPluginWidget(store.active.id, p);
  if (w) {
    store.select(w.id);
    store.updateSettings({ rightOpen: true, rightTab: 'props' });
  }
}

export async function installCode(text: string): Promise<PluginRecord | null> {
  const code = extractCode(text);
  if (!code) return null;
  try {
    const { plugin, replaced } = await plugins.install(code);
    notice(`플러그인 ${replaced ? '업데이트' : '설치'}: ${plugin.name} (${plugin.id} ${plugin.version})`);
    return plugin;
  } catch (e) {
    notice(`플러그인을 불러오지 못했습니다: ${(e as Error).message}`, 9000, 'error');
    return null;
  }
}

export async function openPluginManager() {
  const m = modal('차트 플러그인', { width: 820 });
  const list = h('div', { class: 'plugin-list' });
  const paste = h('textarea', { class: 'plugin-code', placeholder: 'LLM이 만든 플러그인 코드(또는 ```js 코드 블록이 든 답변 전체)를 여기에 붙여넣으세요', spellcheck: false }) as HTMLTextAreaElement;
  const render = async () => {
    const all = await plugins.list();
    const inWs = store.ws.plugins ?? [];
    const extra = inWs.filter((p) => !all.some((a) => a.id === p.id));
    list.replaceChildren(...[...all, ...extra].map((p) => row(p, !all.some((a) => a.id === p.id))));
  };
  const row = (p: PluginRecord, workspaceOnly: boolean) => {
    const used = store.ws.worksheets.reduce((n, ws) => n + ws.widgets.filter((w) => w.plugin?.id === p.id).length, 0);
    const act = (ic: Parameters<typeof icon>[0], label: string, fn: () => void, cls = '') => {
      const b = h('button', { type: 'button', class: `plugin-act ${cls}`, title: label }, icon(ic, 14), h('span', {}, label));
      b.addEventListener('click', fn);
      return b;
    };
    return h(
      'div',
      { class: 'plugin-row' },
      h('div', { class: 'plugin-icon' }, icon(Puzzle, 18)),
      h(
        'div',
        { class: 'plugin-info' },
        h('div', { class: 'plugin-name' }, p.name, h('span', { class: 'plugin-badge' }, p.builtin ? '내장' : workspaceOnly ? '이 워크스페이스' : '내 플러그인'), used ? h('span', { class: 'plugin-used' }, `위젯 ${used}개 사용 중`) : null),
        h('div', { class: 'plugin-meta' }, `${p.id} · v${p.version}${p.author ? ` · ${p.author}` : ''}`),
        p.description ? h('div', { class: 'plugin-desc' }, p.description) : null,
        h('div', { class: 'plugin-params' }, `파라미터: ${Object.entries(p.params).map(([k, v]) => `${v.label || k}(${v.type})`).join(', ') || '없음'}`),
      ),
      h(
        'div',
        { class: 'plugin-actions' },
        act(Plus, '위젯 추가', () => {
          addPluginWidget(p);
          m.close();
        }, 'mod-cta'),
        act(Code, '코드 복사', () => void copy(p.code, `"${p.name}" 코드`)),
        act(Download, '내보내기', () => download(new Blob([p.code], { type: 'text/javascript' }), `${p.id}.js`)),
        ...(workspaceOnly ? [act(Upload, '내 플러그인에 추가', () => void plugins.adopt(p.id).then(render))] : []),
        ...(!p.builtin && !workspaceOnly
          ? [
              act(Trash2, '삭제', async () => {
                if (!(await confirmDialog('플러그인 삭제', `"${p.name}" 을(를) 내 플러그인에서 삭제할까요? 이미 만든 위젯은 워크스페이스에 저장된 사본으로 계속 그려집니다.`, '삭제'))) return;
                plugins.remove(p.id);
                await render();
              }, 'mod-warning'),
            ]
          : []),
      ),
    );
  };

  const fromFile = async () => {
    const [f] = await pickFiles('plugin', false);
    if (!f) return;
    paste.value = await f.file.text();
  };
  const install = async () => {
    const p = await installCode(paste.value);
    if (!p) return;
    paste.value = '';
    await render();
  };

  m.content.append(
    h(
      'div',
      { class: 'plugin-howto' },
      h('div', { class: 'plugin-step' }, h('b', {}, '1'), h('span', {}, '명세서를 복사해 Claude·ChatGPT 등에 붙여넣고, 그 아래에 원하는 그래프를 설명합니다. (예: "온도와 압력의 산점도에 1·2차 회귀선과 R²를 같이")')),
      h('div', { class: 'plugin-step' }, h('b', {}, '2'), h('span', {}, '답으로 받은 코드를 아래에 붙여넣고 "불러오기"를 누르면 바로 위젯으로 쓸 수 있습니다. 같은 id면 업데이트됩니다.')),
      h(
        'div',
        { class: 'plugin-howto-actions' },
        (() => {
          const b = button('플러그인 명세서 복사', () => void copy(pluginSpec(), '플러그인 명세서'), true);
          b.prepend(icon(ClipboardCopy, 15));
          return b;
        })(),
      ),
    ),
    paste,
    h(
      'div',
      { class: 'plugin-install' },
      (() => {
        const b = button('.js 파일에서', () => void fromFile());
        b.prepend(icon(FileUp, 15));
        return b;
      })(),
      button('불러오기', () => void install(), true),
    ),
    h('div', { class: 'plugin-list-title' }, '설치된 플러그인'),
    list,
    h('p', { class: 'muted plugin-note' }, '플러그인은 외부와 격리된 영역에서 실행되어 인터넷·파일·브라우저 저장소에 접근할 수 없고, 앱이 넘겨주는 집계 데이터만 받습니다. 위젯에 쓴 플러그인은 워크스페이스 파일에도 함께 저장됩니다.'),
  );
  await render();
}
