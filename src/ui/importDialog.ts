import { ENGINE_LIMIT, engine, log, type CsvPreview } from '../engine';
import { detectTimeFormat, formatTime, parseTime, type TimeFormat } from '../data/time';
import { progressNotice } from '../project';
import { store } from '../store';
import type { ImportSettings, SourceInfo } from '../types';
import { columnMatcher, debounce, formatBytes, formatCount, h } from '../util';
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
/** Columns shown in the sample table (the picker lists all of them). */
const PREVIEW_COLS = 40;

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
export async function openImportDialog(file: File, quick = false): Promise<SourceInfo | null> {
  const name = file.name;
  let preview: CsvPreview;
  try {
    preview = await engine.preview(file);
  } catch (e) {
    notice(`${name}: ${(e as Error).message}`, 6000, 'error');
    return null;
  }
  // a source the layout still references (same file name) keeps its id and columns
  const relink = store.missingSources().find((m) => m.name === name);
  let selected = new Set(preview.numericColumns);
  if (relink) {
    const wanted = new Set(relink.columns);
    const match = preview.header.map((n, i) => (wanted.has(n) ? i : -1)).filter((i) => i >= 0 && i !== preview.timeColumn);
    if (match.length) selected = new Set(match);
  }
  // the engine holds at most ~4 GB (32-bit WebAssembly), shared by all sources
  const used = [...store.sources.values()].reduce((n, s) => n + s.bytes, 0);
  const freeBytes = ENGINE_LIMIT * 0.9 - used;
  const defaultPrecision = (): Precision => {
    const need = estimateBytes(preview.estimatedRows, selected.size, false);
    return need > COMPACT_THRESHOLD || need > freeBytes * 0.6 ? 'f32' : 'f64';
  };
  const settingsOf = (fmt: TimeFormat, compact: boolean): ImportSettings => ({
    delimiter: preview.delimiter,
    hasHeader: preview.hasHeader,
    timeColumn: preview.header[preview.timeColumn],
    timeFormat: fmt,
    columns: [...selected].sort((a, b) => a - b).map((i) => preview.header[i]),
    compact,
  });
  if (quick && selected.size) return runImport(file, settingsOf(preview.timeFormat, defaultPrecision() === 'f32'), relink?.id);

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
      const tight = bytes > freeBytes * 0.8;
      memLine.textContent = `예상 ${formatCount(preview.estimatedRows)}행 · 메모리 약 ${formatBytes(bytes)} / 사용 가능 ${formatBytes(Math.max(0, freeBytes))}${tight ? ' — 메모리가 부족할 수 있습니다. 32-bit로 바꾸거나 열 수를 줄이세요.' : ''}`;
      memLine.classList.toggle('is-warning', tight);
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
          preview = await engine.preview(file, v);
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

      body.append(columnPicker(), previewArea);
      renderPreview();
    };

    // ---- column picker: regex search + select / deselect the matching columns ----
    let query = '';
    const previewArea = h('div');
    const listEl = h('div', { class: 'column-pick-list' });
    const countEl = h('span', { class: 'column-pick-count' });
    const search = h('input', { type: 'search', class: 'column-pick-search', placeholder: '열 검색 — 정규식 (예: temp|press, ^tag_00[1-3])', spellcheck: false }) as HTMLInputElement;
    const matching = () => {
      const m = columnMatcher(query);
      search.classList.toggle('is-invalid', m.invalid);
      search.title = m.invalid ? '정규식이 올바르지 않아 일반 텍스트로 검색합니다.' : '';
      return preview.header.map((_, i) => i).filter((i) => i !== preview.timeColumn && m.test(preview.header[i]));
    };
    const selectionChanged = () => {
      if (!precisionTouched) precision = defaultPrecision();
      updateMem();
      renderList();
      renderPreview();
    };
    const setAll = (on: boolean) => {
      for (const i of matching()) on ? selected.add(i) : selected.delete(i);
      selectionChanged();
    };
    const numericOnly = () => {
      const numeric = new Set(preview.numericColumns);
      for (const i of matching()) numeric.has(i) ? selected.add(i) : selected.delete(i);
      selectionChanged();
    };
    function renderList() {
      const idx = matching();
      const total = preview.header.length - 1;
      countEl.textContent = `선택 ${formatCount(selected.size)} / ${formatCount(total)}열${query.trim() ? ` · 검색 결과 ${formatCount(idx.length)}` : ''}`;
      const numeric = new Set(preview.numericColumns);
      listEl.replaceChildren(
        ...idx.map((i) => {
          const cb = h('input', { type: 'checkbox', checked: selected.has(i) }) as HTMLInputElement;
          cb.addEventListener('change', () => {
            if (cb.checked) selected.add(i);
            else selected.delete(i);
            selectionChanged();
          });
          return h('label', { class: `column-pick-item ${numeric.has(i) ? '' : 'is-text'}`, title: numeric.has(i) ? preview.header[i] : `${preview.header[i]} (숫자가 아닌 값이 많은 열)` }, cb, h('span', {}, preview.header[i]));
        }),
      );
      if (!idx.length) listEl.append(h('div', { class: 'column-pick-empty' }, '일치하는 열이 없습니다.'));
    }
    const debouncedList = debounce(() => {
      renderList();
      renderPreview();
    }, 120);
    search.addEventListener('input', () => {
      query = search.value;
      debouncedList();
    });
    function columnPicker() {
      search.value = query;
      renderList();
      return h(
        'div',
        { class: 'column-pick' },
        h(
          'div',
          { class: 'column-pick-toolbar' },
          search,
          button('모두 선택', () => setAll(true)),
          button('모두 해제', () => setAll(false)),
          button('숫자 열만', () => numericOnly()),
          countEl,
        ),
        listEl,
      );
    }
    // sample rows for the time column + the first selected columns that match the search
    function renderPreview() {
      const tCol = preview.timeColumn;
      const shown = [tCol, ...matching().filter((i) => selected.has(i)).slice(0, PREVIEW_COLS)];
      const table = h('table', { class: 'preview-table' });
      table.append(h('thead', {}, h('tr', {}, ...shown.map((i) => h('th', { class: i === tCol ? 'is-time' : '' }, i === tCol ? h('span', { class: 'tag' }, 'TIME') : '', ' ', preview.header[i])))));
      const tbody = h('tbody');
      for (const r of preview.rows.slice(0, 12)) tbody.append(h('tr', {}, ...shown.map((i) => h('td', { class: i === tCol ? 'is-time' : '' }, r[i] ?? ''))));
      table.append(tbody);
      const more = selected.size - (shown.length - 1);
      previewArea.replaceChildren(
        h('div', { class: 'preview-caption' }, `미리보기 · ${formatBytes(preview.size)} · ${name}${more > 0 ? ` · 선택한 열 중 ${PREVIEW_COLS}개만 표시` : ''}`),
        h('div', { class: 'preview-scroll' }, table),
      );
    }
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
          resolve(await runImport(file, settingsOf(fmt, precision === 'f32'), relink?.id));
        },
        true,
      ),
    );
  });
}

async function runImport(file: File, settings: ImportSettings, id?: string): Promise<SourceInfo | null> {
  const name = file.name;
  const pn = progressNotice(`${name} 불러오는 중`);
  const t0 = performance.now();
  const job = engine.import(file, settings, (p) => pn.update(p), id);
  pn.onCancel(job.cancel);
  try {
    const src = await job.promise;
    pn.hide();
    log(`import ${name}: ${src.rows} rows x ${src.columns.length} cols, ${Math.round(src.bytes / 1e6)} MB, ${Math.round(performance.now() - t0)} ms`);
    store.addSource(src);
    notice(`${name}: ${formatCount(src.rows)}행 × ${src.columns.length}열 (${((performance.now() - t0) / 1000).toFixed(1)}s${settings.compact ? ', 32-bit' : ''})`);
    return src;
  } catch (e) {
    pn.hide();
    const msg = (e as Error).message;
    log(`import ${name} failed: ${msg}`);
    notice(msg === '취소됨' ? `${name}: 가져오기를 취소했습니다.` : `${name}: ${msg}`, msg === '취소됨' ? 3000 : 7000, msg === '취소됨' ? 'info' : 'error');
    return null;
  }
}
