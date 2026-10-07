import { importCsv, previewCsv, type CsvPreview } from '../data/csv';
import { formatTime, parseTime, type TimeFormat } from '../data/time';
import { store } from '../store';
import type { DataSource } from '../types';
import { formatBytes, formatCount, h } from '../util';
import { button, modal, notice } from './overlays';

const DELIMS: [string, string][] = [
  ['', '자동'],
  [',', '쉼표 ,'],
  [';', '세미콜론 ;'],
  ['\t', '탭'],
  ['|', '파이프 |'],
  [' ', '공백'],
];

const FORMATS: [TimeFormat, string][] = [
  ['auto', '자동 감지'],
  ['iso', 'ISO (YYYY-MM-DD hh:mm:ss)'],
  ['dmy', 'DD/MM/YYYY hh:mm:ss'],
  ['mdy', 'MM/DD/YYYY hh:mm:ss'],
  ['epoch-s', 'Unix epoch (초)'],
  ['epoch-ms', 'Unix epoch (밀리초)'],
];

function select<T extends string>(options: [T, string][], value: T, onChange: (v: T) => void) {
  const s = h('select', { class: 'dropdown' });
  for (const [v, label] of options) s.append(h('option', { value: v, selected: v === value }, label));
  s.addEventListener('change', () => onChange(s.value as T));
  return s;
}

function setting(name: string, desc: string, control: HTMLElement) {
  return h(
    'div',
    { class: 'setting-item' },
    h('div', { class: 'setting-item-info' }, h('div', { class: 'setting-item-name' }, name), h('div', { class: 'setting-item-description' }, desc)),
    h('div', { class: 'setting-item-control' }, control),
  );
}

/** Ask for import options; resolves with the imported source (or null on cancel). */
export async function openImportDialog(file: File, quick = false): Promise<DataSource | null> {
  let preview: CsvPreview;
  try {
    preview = await previewCsv(file);
  } catch (e) {
    notice(`${file.name}: ${(e as Error).message}`, 6000, 'error');
    return null;
  }
  if (quick && preview.numericColumns.length) return runImport(file, preview, 'auto', new Set(preview.numericColumns));

  return new Promise((resolve) => {
    let done = false;
    const m = modal(`CSV 가져오기 — ${file.name}`, { width: 860, onClose: () => !done && resolve(null) });
    let fmt: TimeFormat = 'auto';
    let selected = new Set(preview.numericColumns);
    const body = h('div', { class: 'import-body' });
    m.content.append(body);

    const rerender = () => {
      body.replaceChildren();
      const tCol = preview.timeColumn;
      const sampleCell = preview.rows.find((r) => (r[tCol] ?? '').trim())?.[tCol] ?? '';
      const sampleTime = parseTime(sampleCell, fmt);
      const timeSelect = select(
        preview.header.map((n, i) => [String(i), n] as [string, string]),
        String(tCol),
        (v) => {
          preview.timeColumn = Number(v);
          selected.delete(preview.timeColumn);
          rerender();
        },
      );
      const delimSelect = select(DELIMS, (DELIMS.find((d) => d[0] === preview.delimiter)?.[0] ?? '') as string, async (v) => {
        preview = await previewCsv(file, v);
        selected = new Set(preview.numericColumns);
        rerender();
      });
      const headerToggle = h('input', { type: 'checkbox', checked: preview.hasHeader });
      headerToggle.addEventListener('change', () => {
        preview.hasHeader = headerToggle.checked;
        if (!headerToggle.checked) {
          preview.rows = [preview.header, ...preview.rows];
          preview.header = preview.header.map((_, i) => `col${i + 1}`);
        } else {
          preview.header = preview.rows[0].map((c, i) => c.trim() || `col${i + 1}`);
          preview.rows = preview.rows.slice(1);
        }
        rerender();
      });

      body.append(
        h(
          'div',
          { class: 'import-grid' },
          setting('구분자', `감지됨: ${JSON.stringify(preview.delimiter)}`, delimSelect),
          setting('첫 행은 헤더', '열 이름으로 사용', h('label', { class: 'checkbox-container' }, headerToggle)),
          setting('시간 열', '타임스탬프가 들어있는 열', timeSelect),
          setting(
            '시간 형식',
            Number.isFinite(sampleTime) ? `예: "${sampleCell}" → ${formatTime(sampleTime, true)}` : `⚠ "${sampleCell}" 를 해석할 수 없습니다`,
            select(FORMATS, fmt, (v) => {
              fmt = v;
              rerender();
            }),
          ),
        ),
      );

      // column table with checkboxes
      const table = h('table', { class: 'preview-table' });
      const thead = h('tr');
      preview.header.forEach((name, i) => {
        const isTime = i === tCol;
        const cb = h('input', { type: 'checkbox', checked: selected.has(i), disabled: isTime });
        cb.addEventListener('change', () => (cb.checked ? selected.add(i) : selected.delete(i)));
        thead.append(
          h('th', { class: isTime ? 'is-time' : '' }, h('label', {}, isTime ? h('span', { class: 'tag' }, 'TIME') : cb, ' ', name)),
        );
      });
      table.append(h('thead', {}, thead));
      const tbody = h('tbody');
      for (const r of preview.rows.slice(0, 12)) {
        const tr = h('tr');
        preview.header.forEach((_, i) => tr.append(h('td', { class: i === tCol ? 'is-time' : '' }, r[i] ?? '')));
        tbody.append(tr);
      }
      table.append(tbody);
      body.append(
        h('div', { class: 'preview-caption' }, `미리보기 · ${formatBytes(file.size)} · 가져올 열을 선택하세요`),
        h('div', { class: 'preview-scroll' }, table),
      );
    };
    rerender();

    m.footer.append(
      button('취소', () => m.close()),
      button(
        '가져오기',
        async () => {
          if (!selected.size) {
            notice('가져올 숫자 열을 하나 이상 선택하세요.', 3000, 'error');
            return;
          }
          done = true;
          m.close();
          resolve(await runImport(file, preview, fmt, selected));
        },
        true,
      ),
    );
  });
}

async function runImport(file: File, p: CsvPreview, fmt: TimeFormat, selected: Set<number>): Promise<DataSource | null> {
  const n = notice(`${file.name} 불러오는 중… 0%`, 0);
  const t0 = performance.now();
  try {
    const src = await importCsv(
      file,
      {
        delimiter: p.delimiter,
        hasHeader: p.hasHeader,
        timeColumn: p.timeColumn,
        timeFormat: fmt,
        columns: [...selected].sort((a, b) => a - b),
        header: p.header,
      },
      (f) => n.set(`${file.name} 불러오는 중… ${Math.round(f * 100)}%`),
    );
    n.hide();
    store.addSource(src);
    notice(
      `${file.name}: ${formatCount(src.time.length)}행 × ${src.columns.length}열 (${((performance.now() - t0) / 1000).toFixed(2)}s)`,
    );
    return src;
  } catch (e) {
    n.hide();
    notice(`${file.name}: ${(e as Error).message}`, 7000, 'error');
    return null;
  }
}
