/** Native file dialogs (Tauri). Browser tests inject `window.__chronosTest` instead. */
import { isDesktop } from './engine';

export interface Filter {
  name: string;
  extensions: string[];
}

export const CSV_FILTERS: Filter[] = [{ name: 'CSV', extensions: ['csv', 'tsv', 'txt'] }];
export const WS_FILTERS: Filter[] = [{ name: 'Chronos 워크스페이스', extensions: ['chronos'] }];

interface TestHooks {
  open?: (kind: string, multiple: boolean) => Promise<string[] | string | null>;
  save?: (kind: string, defaultPath?: string) => Promise<string | null>;
}
const test = () => (window as unknown as { __chronosTest?: TestHooks }).__chronosTest;

export async function openFiles(kind: 'csv' | 'workspace' | 'any', multiple = true): Promise<string[]> {
  if (isDesktop) {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const filters = kind === 'csv' ? CSV_FILTERS : kind === 'workspace' ? WS_FILTERS : [...WS_FILTERS, ...CSV_FILTERS];
    const r = await open({ multiple, directory: false, filters });
    if (!r) return [];
    return Array.isArray(r) ? r : [r];
  }
  const r = await test()?.open?.(kind, multiple);
  return !r ? [] : Array.isArray(r) ? r : [r];
}

export async function saveFile(kind: 'workspace' | 'csv' | 'png', defaultPath?: string): Promise<string | null> {
  if (isDesktop) {
    const { save } = await import('@tauri-apps/plugin-dialog');
    const filters = kind === 'workspace' ? WS_FILTERS : kind === 'csv' ? CSV_FILTERS.slice(0, 1) : [{ name: 'PNG', extensions: ['png'] }];
    return (await save({ defaultPath, filters })) ?? null;
  }
  return (await test()?.save?.(kind, defaultPath)) ?? null;
}

export function baseName(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

export function joinPath(dir: string, name: string): string {
  const sep = dir.includes('\\') ? '\\' : '/';
  return dir.replace(/[\\/]+$/, '') + sep + name;
}
