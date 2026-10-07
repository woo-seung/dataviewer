import { estimateBytes, guessFormat, importCsv, previewCsv, type CsvPreview } from '../data/csv';
import { formatTime, parseTime, type TimeFormat } from '../data/time';
import { store } from '../store';
import type { DataSource, ImportSettings } from '../types';
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
  ['auto', '자동 (셀마다 추측)'],
  ['iso', 'ISO (YYYY-MM-DD hh:mm:ss)'],
  ['dmy', 'DD/MM/YYYY hh:mm:ss'],
  ['mdy', 'MM/DD/YYYY hh:mm:ss'],
  ['epoch-s', 'Unix epoch (초)'],
  ['epoch-ms', 'Unix epoch (밀리초)'],
];

type Precision = 'f64' | 'f32';

/** Above this the default switches to 32-bit values to halve memory. */
const COMPACT_THRESHOLD = 512 * 1024 * 1024;

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

/** Where the file came from inside the work folder (enables relative-path saving). */
export interface FileOrigin {
  path?: string | null;
}

/** Ask for import options; resolves with the imported source (or null on cancel). */
export async function openImportDialog(file: File, quick = false, origin: FileOrigin = {}): Promise<DataSource | null> {
  let preview: CsvPreview;
  try {
    preview = await previewCsv(file);
  } catch (e) {
    notice(`${file.name}: ${(e as Error).message}`, 6000, 'error');
    return null;
  }
  const relink = store.missingSourceFor(file.name, origin.path);
  let selected = new Set(preview.numericColumns);
  if (relink) {
    // re-opening a file whose charts survived a reload: keep the same columns
    const wanted = new Set(relink.columns);
    const match = preview.header.map((n, i) => (wanted.has(n) ? i : -1)).filter((i) => i >= 0 && i !== preview.timeColumn);
    if (match.length) selected = new Set(match);
  }
  const defaultPrecision = (): Precision =>
    estimateBytes(preview.estimatedRows, selected.size, false) > COMPACT_THRESHOLD ? 'f32' : 'f64';
  if (quick && selected.size) return runImport(file, preview, guessFormat(preview), selected, defaultPrecision() === 'f32', relink?.id, origin);

  return new Promise((resolve) => {
    let done = false;
    const m = modal(`CSV 가져오기 — ${file.name}`, { width: 880, onClose: () => !done && resolve(null) });
    let fmt: TimeFormat = guessFormat(preview);
    let precision: Precision = defaultPrecision();
    let precisionTouched = false;
    const body = h('div', { class: 'import-body' });
    m.content.append(body);
    const memLine = h('div', { class: 'setting-item-description' });
    const updateMem = () => {
      const bytes = estimateBytes(preview.estimatedRows, selected.size, precision === 'f32');
      memLine.textContent = `예상 ${formatCount(preview.estimatedRows)}행 · 메모리 약 ${formatBytes(bytes)}`;
      memLine.classList.toggle('is-warning', bytes > 2 * 1024 ** 3);
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
          fmt = guessFormat(preview);
          rerender();
        },
      );
      const delimSelect = select(DELIMS, (DELIMS.find((d) => d[0] === preview.delimiter)?.[0] ?? '') as string, async (v) => {
        preview = await previewCsv(file, v);
        selected = new Set(preview.numericColumns);
        fmt = guessFormat(preview);
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
        ...(relink ? [h('div', { class: 'import-relink' }, `이전에 열었던 "${relink.name}" 의 차트에 다시 연결됩니다.`)] : []),
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
      preview.header.forEach((name, i) => {
        const isTime = i === tCol;
        const cb = h('input', { type: 'checkbox', checked: selected.has(i), disabled: isTime });
        cb.addEventListener('change', () => {
          if (cb.checked) selected.add(i);
          else selected.delete(i);
          if (!precisionTouched) precision = defaultPrecision();
          updateMem();
        });
        thead.append(h('th', { class: isTime ? 'is-time' : '' }, h('label', {}, isTime ? h('span', { class: 'tag' }, 'TIME') : cb, ' ', name)));
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
          resolve(await runImport(file, preview, fmt, selected, precision === 'f32', relink?.id, origin));
        },
        true,
      ),
    );
  });
}

/**
 * Re-import a CSV with the settings it was imported with before (no dialog).
 * Used when a workspace's original file changed on disk.
 */
export async function reimport(file: File, settings: ImportSettings, id: string, origin: FileOrigin): Promise<DataSource | null> {
  let p: CsvPreview;
  try {
    p = await previewCsv(file, settings.delimiter);
  } catch (e) {
    notice(`${file.name}: ${(e as Error).message}`, 6000, 'error');
    return null;
  }
  p.hasHeader = settings.hasHeader;
  const tc = p.header.indexOf(settings.timeColumn);
  if (tc >= 0) p.timeColumn = tc;
  const cols = new Set(settings.columns.map((c) => p.header.indexOf(c)).filter((i) => i >= 0 && i !== p.timeColumn));
  if (!cols.size) {
    notice(`${file.name}: 이전에 가져온 열을 찾을 수 없습니다.`, 6000, 'error');
    return null;
  }
  return runImport(file, p, settings.timeFormat, cols, settings.compact, id, origin, false);
}

async function runImport(
  file: File,
  p: CsvPreview,
  fmt: TimeFormat,
  selected: Set<number>,
  compact: boolean,
  id?: string,
  origin: FileOrigin = {},
  add = true,
): Promise<DataSource | null> {
  const label = h('span', {}, `${file.name} 불러오는 중… 0%`);
  const bar = h('div', { class: 'notice-progress' }, h('div', {}));
  const cancelBtn = h('button', { type: 'button', class: 'notice-cancel' }, '취소');
  const n = notice('', 0);
  n.el.replaceChildren(label, bar, cancelBtn);
  const t0 = performance.now();
  const job = importCsv(
    file,
    {
      delimiter: p.delimiter,
      hasHeader: p.hasHeader,
      timeColumn: p.timeColumn,
      timeFormat: fmt,
      columns: [...selected].sort((a, b) => a - b),
      header: p.header,
      compact,
      estimatedRows: p.estimatedRows,
      noQuotes: p.noQuotes,
    },
    (f, rows) => {
      const pct = Math.round(f * 100);
      label.textContent = `${file.name} 불러오는 중… ${pct}% · ${formatCount(rows)}행`;
      (bar.firstElementChild as HTMLElement).style.width = `${pct}%`;
    },
    id,
  );
  cancelBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    job.cancel();
  });
  try {
    const src = await job.promise;
    n.hide();
    src.path = origin.path ?? undefined;
    src.lastModified = file.lastModified;
    src.import = {
      delimiter: p.delimiter,
      hasHeader: p.hasHeader,
      timeColumn: p.header[p.timeColumn],
      timeFormat: fmt,
      columns: [...selected].sort((a, b) => a - b).map((i) => p.header[i]),
      compact,
    };
    if (add) store.addSource(src);
    notice(
      `${file.name}: ${formatCount(src.time.length)}행 × ${src.columns.length}열 (${((performance.now() - t0) / 1000).toFixed(1)}s${compact ? ', 32-bit' : ''})`,
    );
    return src;
  } catch (e) {
    n.hide();
    if ((e as Error).name === 'AbortError') notice(`${file.name}: 가져오기를 취소했습니다.`);
    else notice(`${file.name}: ${(e as Error).message}`, 7000, 'error');
    return null;
  }
}
