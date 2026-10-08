import { engine, type CsvPreview } from '../engine';
import { baseName } from '../dialogs';
import { detectTimeFormat, formatTime, parseTime, type TimeFormat } from '../data/time';
import { progressNotice } from '../project';
import { store } from '../store';
import type { ImportSettings, SourceInfo } from '../types';
import { formatBytes, formatCount, h } from '../util';
import { button, modal, notice } from './overlays';

const DELIMS: [string, string][] = [
  ['', '자동'],
  [',', '쉼표 ,'],
  [';', '세미콜론 ;'],
  ['\t', '탭'],
  ['|', '파이프 |'],
];

const FORMATS: [TimeFormat, string][] = [
  ['auto', '자동 (셀마다 추측)'],
  ['iso', 'ISO (YYYY-MM-DD hh:mm:ss)'],
  ['dmy', 'DD/MM/YYYY hh:mm:ss'],
  ['mdy', 'MM/DD/YYYY hh:mm:ss'],
  ['epoch-s', 'Unix epoch (초)'],
  ['epoch-ms', 'Unix epoch (밀리초)'],
];

type Precision = 'f64' | 'f32';

/** Above this the default switches to 32-bit values to halve memory. */
const COMPACT_THRESHOLD = 2 * 1024 ** 3;

const estimateBytes = (rows: number, cols: number, compact: boolean) => rows * (8 + cols * (compact ? 4 : 8) + cols * 0.6);

function select<T extends string>(options: [T, string][], value: T, onChange: (v: T) => void) {
  const s = h('select', { class: 'dropdown' });
  for (const [v, label] of options) s.append(h('option', { value: v, selected: v === value }, label));
  s.addEventListener('change', () => onChange(s.value as T));
  return s;
}

function setting(name: string, desc: string | HTMLElement, control: HTMLElement) {
  return h(
    'div',
    { class: 'setting-item' },
    h('div', { class: 'setting-item-info' }, h('div', { class: 'setting-item-name' }, name), h('div', { class: 'setting-item-description' }, desc)),
    h('div', { class: 'setting-item-control' }, control),
  );
}

const guess = (p: CsvPreview): TimeFormat => detectTimeFormat(p.rows.map((r) => r[p.timeColumn] ?? ''));

/** Ask for import options for a CSV path; resolves with the imported source (or null on cancel). */
export async function openImportDialog(path: string, quick = false): Promise<SourceInfo | null> {
  const name = baseName(path);
  let preview: CsvPreview;
  try {
    preview = await engine.preview(path);
  } catch (e) {
    notice(`${name}: ${(e as Error).message}`, 6000, 'error');
    return null;
  }
  // a source the layout still references (same path) keeps its id and columns
  const relink = store.missingSources().find((m) => m.path === path);
  let selected = new Set(preview.numericColumns);
  if (relink) {
    const wanted = new Set(relink.columns);
    const match = preview.header.map((n, i) => (wanted.has(n) ? i : -1)).filter((i) => i >= 0 && i !== preview.timeColumn);
    if (match.length) selected = new Set(match);
  }
  const defaultPrecision = (): Precision => (estimateBytes(preview.estimatedRows, selected.size, false) > COMPACT_THRESHOLD ? 'f32' : 'f64');
  const settingsOf = (fmt: TimeFormat, compact: boolean): ImportSettings => ({
    delimiter: preview.delimiter,
    hasHeader: preview.hasHeader,
    timeColumn: preview.header[preview.timeColumn],
    timeFormat: fmt,
    columns: [...selected].sort((a, b) => a - b).map((i) => preview.header[i]),
    compact,
  });
  if (quick && selected.size) return runImport(path, settingsOf(preview.timeFormat, defaultPrecision() === 'f32'), relink?.id);

  return new Promise((resolve) => {
    let done = false;
    const m = modal(`CSV 가져오기 — ${name}`, { width: 880, onClose: () => !done && resolve(null) });
    let fmt: TimeFormat = preview.timeFormat;
    let precision: Precision = defaultPrecision();
    let precisionTouched = false;
    const body = h('div', { class: 'import-body' });
    m.content.append(body);
    const memLine = h('div', { class: 'setting-item-description' });
    const updateMem = () => {
      const bytes = estimateBytes(preview.estimatedRows, selected.size, precision === 'f32');
      memLine.textContent = `예상 ${formatCount(preview.estimatedRows)}행 · 메모리 약 ${formatBytes(bytes)}`;
    };

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
          fmt = guess(preview);
          rerender();
        },
      );
      const delimSelect = select(DELIMS, (DELIMS.find((d) => d[0] === preview.delimiter)?.[0] ?? '') as string, async (v) => {
        try {
          preview = await engine.preview(path, v);
        } catch (e) {
          notice((e as Error).message, 5000, 'error');
          return;
        }
        selected = new Set(preview.numericColumns);
        fmt = preview.timeFormat;
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
      updateMem();

      body.append(
        ...(relink ? [h('div', { class: 'import-relink' }, `이전에 불러왔던 "${relink.name}" 의 차트에 다시 연결됩니다.`)] : []),
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
          setting(
            '값 정밀도',
            memLine,
            select(
              [
                ['f64', '64-bit (정확)'],
                ['f32', '32-bit (메모리 절반)'],
              ],
              precision,
              (v) => {
                precision = v;
                precisionTouched = true;
                updateMem();
              },
            ),
          ),
        ),
      );

      const table = h('table', { class: 'preview-table' });
      const thead = h('tr');
      preview.header.forEach((col, i) => {
        const isTime = i === tCol;
        const cb = h('input', { type: 'checkbox', checked: selected.has(i), disabled: isTime });
        cb.addEventListener('change', () => {
          if (cb.checked) selected.add(i);
          else selected.delete(i);
          if (!precisionTouched) precision = defaultPrecision();
          updateMem();
        });
        thead.append(h('th', { class: isTime ? 'is-time' : '' }, h('label', {}, isTime ? h('span', { class: 'tag' }, 'TIME') : cb, ' ', col)));
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
        h('div', { class: 'preview-caption' }, `미리보기 · ${formatBytes(preview.size)} · ${path}`),
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
          resolve(await runImport(path, settingsOf(fmt, precision === 'f32'), relink?.id));
        },
        true,
      ),
    );
  });
}

async function runImport(path: string, settings: ImportSettings, id?: string): Promise<SourceInfo | null> {
  const name = baseName(path);
  const pn = progressNotice(`${name} 불러오는 중`);
  const t0 = performance.now();
  const job = engine.import(path, settings, (p) => pn.update(p), id);
  pn.onCancel(job.cancel);
  try {
    const src = await job.promise;
    pn.hide();
    store.addSource(src);
    notice(`${name}: ${formatCount(src.rows)}행 × ${src.columns.length}열 (${((performance.now() - t0) / 1000).toFixed(1)}s${settings.compact ? ', 32-bit' : ''})`);
    return src;
  } catch (e) {
    pn.hide();
    const msg = (e as Error).message;
    notice(msg === '취소됨' ? `${name}: 가져오기를 취소했습니다.` : `${name}: ${msg}`, msg === '취소됨' ? 3000 : 7000, msg === '취소됨' ? 'info' : 'error');
    return null;
  }
}
