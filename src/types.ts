import type { Blocks } from './data/blocks';
import type { TimeFormat } from './data/time';

/** How a CSV was imported, by column name, so it can be re-imported without asking. */
export interface ImportSettings {
  delimiter: string;
  hasHeader: boolean;
  timeColumn: string;
  timeFormat: TimeFormat;
  columns: string[];
  compact: boolean;
}

/** A parsed CSV file: one shared time axis and N numeric columns. */
export interface DataSource {
  id: string;
  name: string;
  /** Original file size in bytes (informational). */
  size: number;
  importedAt: number;
  timeColumn: string;
  /** Epoch milliseconds, sorted ascending. */
  time: Float64Array;
  columns: SourceColumn[];
  /** Path of the original CSV relative to the work folder root, when known. */
  path?: string;
  /** Original file's mtime, used to detect a changed CSV. */
  lastModified?: number;
  import?: ImportSettings;
}

export interface SourceColumn {
  name: string;
  /** Float32 when imported in compact mode (half the memory). */
  values: Float64Array | Float32Array;
  /** Summary index for fast window stats / downsampling (saved in .chronos files). */
  blocks?: Blocks;
  /** Precomputed over the whole column (NaN skipped). */
  min: number;
  max: number;
  mean: number;
}

export type ChartType = 'line' | 'area' | 'stacked' | 'scatter' | 'step';

export interface SeriesRef {
  id: string;
  sourceId: string;
  column: string;
  label: string;
  color: string;
  visible: boolean;
  /** Linear transform applied before display: y' = y * scale + offset. */
  scale: number;
  offset: number;
}

export interface TimeRange {
  start: number;
  end: number;
}

export interface YAxisOptions {
  auto: boolean;
  min: number | null;
  max: number | null;
  log: boolean;
  unit: string;
  /** Format tick labels with SI prefixes (k, M, G…). */
  siPrefix: boolean;
  /** Include zero in the automatic range. */
  includeZero: boolean;
}

export interface WidgetState {
  id: string;
  title: string;
  type: ChartType;
  series: SeriesRef[];
  /** Grid placement (gridstack units). */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Follows the worksheet timeline when true. */
  linked: boolean;
  /** Own range when not linked. */
  range: TimeRange | null;
  yAxis: YAxisOptions;
  showLegend: boolean;
  lineWidth: number;
  markers: boolean;
  /** Max points per series rendered for the visible window (LTTB). 0 = no limit. */
  maxPoints: number;
}

export interface Worksheet {
  id: string;
  name: string;
  widgets: WidgetState[];
  /** Shared timeline; null = fit all data. */
  range: TimeRange | null;
  crosshair: boolean;
}

export interface Settings {
  theme: 'dark' | 'light';
  leftOpen: boolean;
  rightOpen: boolean;
  leftWidth: number;
  rightWidth: number;
  defaultMaxPoints: number;
  dragMode: 'zoom' | 'pan';
  /** Allow box-zoom / wheel-zoom on the value axis too. */
  zoomY: boolean;
  /** Sources larger than this (MB of arrays) are not cached in IndexedDB. */
  cacheLimitMb: number;
}

/**
 * Lightweight description of a source kept in the workspace, so charts survive
 * a reload even when the data itself was too large to cache: re-opening the
 * same file re-links it by name.
 */
export interface SourceMeta {
  id: string;
  name: string;
  size: number;
  rows: number;
  columns: string[];
  start: number;
  end: number;
  path?: string;
  /** Path relative to the workspace file (as stored in a .chronos file). */
  rel?: string;
  lastModified?: number;
  import?: ImportSettings;
}

export interface Workspace {
  version: 1;
  worksheets: Worksheet[];
  sourceMeta?: SourceMeta[];
  /** Linked workspace file (root-relative path inside the work folder). */
  file?: { name: string; path?: string };
  activeId: string;
  selectedWidgetId: string | null;
  settings: Settings;
}

/** Drag payload for series dragged from the tree or another widget. */
export interface SeriesDrag {
  items: { sourceId: string; column: string }[];
  fromWidget?: { worksheetId: string; widgetId: string; seriesIds: string[] };
}

export const DRAG_MIME = 'application/x-chronos-series';
/** Extra marker type set when the drag comes from a chart legend (readable during dragover). */
export const DRAG_MOVE_MIME = 'application/x-chronos-move';
