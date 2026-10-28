import { h } from '../util';

export interface Command {
  id: string;
  name: string;
  hotkey?: string;
  run: () => void;
}

function fuzzy(q: string, text: string): number {
  if (!q) return 1;
  const t = text.toLowerCase();
  const s = q.toLowerCase();
  if (t.includes(s)) return 100 - t.indexOf(s);
  let i = 0;
  let score = 0;
  for (const ch of t) {
    if (ch === s[i]) {
      i++;
      score++;
      if (i === s.length) return score;
    }
  }
  return 0;
}

let open: HTMLElement | null = null;

export function openCommandPalette(commands: () => Command[], placeholder = '명령 입력…') {
  if (open) return;
  const input = h('input', { type: 'text', class: 'prompt-input', placeholder, 'aria-label': '명령 검색' });
  const results = h('div', { class: 'prompt-results', role: 'listbox' });
  const box = h(
    'div',
    { class: 'prompt' },
    h('div', { class: 'prompt-input-container' }, input),
    results,
    h('div', { class: 'prompt-instructions' }, h('span', {}, '↑↓ 이동'), h('span', {}, '↵ 실행'), h('span', {}, 'esc 닫기')),
  );
  const bg = h('div', { class: 'modal-container mod-dim' }, h('div', { class: 'modal-bg' }), box);
  open = bg;
  let sel = 0;
  let shown: Command[] = [];
  const all = commands();

  const close = () => {
    bg.remove();
    open = null;
  };
  const run = (c: Command | undefined) => {
    if (!c) return;
    close();
    c.run();
  };
  const render = () => {
    const q = input.value.trim();
    shown = all
      .map((c) => ({ c, s: fuzzy(q, c.name) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.c);
    sel = Math.min(sel, Math.max(0, shown.length - 1));
    results.replaceChildren(
      ...shown.map((c, i) => {
        const r = h(
          'div',
          { class: `suggestion-item ${i === sel ? 'is-selected' : ''}`, role: 'option' },
          h('span', {}, c.name),
          c.hotkey ? h('kbd', { class: 'suggestion-hotkey' }, c.hotkey) : null,
        );
        r.addEventListener('mousemove', () => {
          if (sel !== i) {
            sel = i;
            render();
          }
        });
        r.addEventListener('click', () => run(c));
        return r;
      }),
    );
    if (!shown.length) results.append(h('div', { class: 'suggestion-empty' }, '일치하는 명령이 없습니다.'));
    results.querySelector('.is-selected')?.scrollIntoView({ block: 'nearest' });
  };
  input.addEventListener('input', () => {
    sel = 0;
    render();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      sel = (sel + 1) % Math.max(1, shown.length);
      render();
      e.preventDefault();
    } else if (e.key === 'ArrowUp') {
      sel = (sel - 1 + shown.length) % Math.max(1, shown.length);
      render();
      e.preventDefault();
    } else if (e.key === 'Enter') run(shown[sel]);
    else if (e.key === 'Escape') close();
    e.stopPropagation();
  });
  bg.firstElementChild!.addEventListener('click', close);
  document.body.append(bg);
  render();
  input.focus();
}
