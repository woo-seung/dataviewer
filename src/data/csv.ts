import Papa from 'papaparse';
import type { DataSource } from '../types';
import { parseNumber, parseTime, type TimeFormat } from './time';
import type { ParseRequest, WorkerMessage } from './csvWorker';
import { uid } from '../util';

export interface CsvPreview {
  delimiter: string;
  hasHeader: boolean;
  header: string[];
  rows: string[][];
  timeColumn: number;
  numericColumns: number[];
}

const TIME_NAME_RE = /^(time|date|datetime|timestamp|ts|t|epoch|시간|일시|날짜|시각)$|time|date|stamp/i;

function looksNumeric(values: string[]): boolean {
  const filled = values.filter((v) => v.trim() !== '');
  if (!filled.length) return false;
  const ok = filled.filter((v) => !Number.isNaN(parseNumber(v))).length;
  return ok / filled.length >= 0.8;
}

function looksTime(values: string[]): boolean {
  const filled = values.filter((v) => v.trim() !== '');
  if (!filled.length) return false;
  const ok = filled.filter((v) => !/^[-+]?[\d.]+$/.test(v.trim()) && Number.isFinite(parseTime(v))).length;
  return ok / filled.length >= 0.8;
}

export async function previewCsv(file: File, delimiter = ''): Promise<CsvPreview> {
  const text = await file.slice(0, 256 * 1024).text();
  const res = Papa.parse<string[]>(text, { delimiter: delimiter || undefined, preview: 60, skipEmptyLines: true });
  const all = res.data.filter((r) => r.length > 0);
  if (!all.length) throw new Error('파일이 비어 있습니다.');
  const width = Math.max(...all.map((r) => r.length));
  const firstRow = all[0];
  // Header if the first row has a non-numeric cell where later rows are numeric.
  const hasHeader = firstRow.some((cell, i) => {
    const below = all.slice(1, 20).map((r) => r[i] ?? '');
    return Number.isNaN(parseNumber(cell)) && (looksNumeric(below) || looksTime(below));
  }) || firstRow.every((c) => Number.isNaN(parseNumber(c)));
  const header = hasHeader
    ? Array.from({ length: width }, (_, i) => (firstRow[i] ?? '').trim() || `col${i + 1}`)
    : Array.from({ length: width }, (_, i) => `col${i + 1}`);
  const rows = hasHeader ? all.slice(1) : all;
  const colValues = (i: number) => rows.map((r) => r[i] ?? '');

  let timeColumn = header.findIndex((h, i) => TIME_NAME_RE.test(h) && (looksTime(colValues(i)) || looksNumeric(colValues(i))));
  if (timeColumn < 0) timeColumn = header.findIndex((_, i) => looksTime(colValues(i)));
  if (timeColumn < 0) timeColumn = 0;
  const numericColumns = header.map((_, i) => i).filter((i) => i !== timeColumn && looksNumeric(colValues(i)));
  return { delimiter: res.meta.delimiter, hasHeader, header, rows: rows.slice(0, 30), timeColumn, numericColumns };
}

export function importCsv(
  file: File,
  opts: { delimiter: string; hasHeader: boolean; timeColumn: number; timeFormat: TimeFormat; columns: number[]; header: string[] },
  onProgress?: (fraction: number) => void,
): Promise<DataSource> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./csvWorker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (ev: MessageEvent<WorkerMessage>) => {
      const m = ev.data;
      if (m.type === 'progress') onProgress?.(m.total ? m.loaded / m.total : 0);
      else if (m.type === 'error') {
        worker.terminate();
        reject(new Error(m.message));
      } else {
        worker.terminate();
        if (!m.time.length) {
          reject(new Error('유효한 타임스탬프가 있는 행이 없습니다. 시간 열/형식을 확인하세요.'));
          return;
        }
        resolve({
          id: uid('src'),
          name: file.name,
          size: file.size,
          importedAt: Date.now(),
          timeColumn: opts.header[opts.timeColumn],
          time: m.time,
          columns: m.columns,
        });
      }
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message || 'CSV 파싱 워커 오류'));
    };
    const req: ParseRequest = {
      file,
      delimiter: opts.delimiter,
      hasHeader: opts.hasHeader,
      timeColumn: opts.timeColumn,
      timeFormat: opts.timeFormat,
      columns: opts.columns,
      columnNames: opts.columns.map((i) => opts.header[i]),
    };
    worker.postMessage(req);
  });
}

/** Synthetic multi-sensor dataset so the app has something to show on first run. */
export function generateSampleCsv(rows = 50_000): File {
  const start = Date.UTC(2026, 0, 1);
  const step = 60_000; // 1 min
  const lines = ['timestamp,cpu_load,memory_mb,temperature_c,network_rx_kbps,network_tx_kbps,disk_iops,pressure_hpa'];
  let mem = 4200;
  let temp = 42;
  let pressure = 1013;
  let seed = 7;
  const rnd = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  for (let i = 0; i < rows; i++) {
    const t = start + i * step;
    const day = (i % 1440) / 1440;
    const daily = Math.sin(day * Math.PI * 2 - Math.PI / 2) * 0.5 + 0.5;
    const cpu = Math.min(100, Math.max(0, 15 + 55 * daily + (rnd() - 0.5) * 20 + (rnd() < 0.002 ? 40 : 0)));
    mem = Math.min(16000, Math.max(2000, mem + (rnd() - 0.5) * 40 + (cpu - 40) * 0.2));
    if (rnd() < 0.0005) mem = 4000;
    temp += (35 + cpu * 0.35 - temp) * 0.05 + (rnd() - 0.5) * 0.4;
    const rx = Math.max(0, 800 + 4000 * daily + (rnd() - 0.5) * 900 + (rnd() < 0.003 ? 9000 : 0));
    const tx = Math.max(0, 300 + 1500 * daily + (rnd() - 0.5) * 400);
    const iops = Math.round(Math.max(0, 120 + cpu * 6 + (rnd() - 0.5) * 150));
    pressure += (1013 - pressure) * 0.001 + (rnd() - 0.5) * 0.3;
    const iso = new Date(t).toISOString().replace('T', ' ').slice(0, 19);
    lines.push(
      `${iso},${cpu.toFixed(2)},${mem.toFixed(1)},${temp.toFixed(2)},${rx.toFixed(1)},${tx.toFixed(1)},${iops},${pressure.toFixed(2)}`,
    );
  }
  return new File([lines.join('\n')], 'sample_server_metrics.csv', { type: 'text/csv' });
}
