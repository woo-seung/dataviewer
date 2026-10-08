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

/** A loaded data source as the engine describes it (the data itself stays in the engine). */
export interface SourceInfo {
  id: string;
  name: string;
  /** Absolute path of the original CSV. */
  path: string;
  size: number;
  lastModified: number;
  importedAt: number;
  timeColumn: string;
  import: ImportSettings;
  rows: number;
  /** Epoch ms of the first / last sample. */
  start: number;
  end: number;
  compact: boolean;
  /** Memory used by the parsed data. */
  bytes: number;
  columns: ColumnInfo[];
  /** Loaded from the workspace file because the CSV was not found. */
  missingOriginal: boolean;
}

export interface ColumnInfo {
  name: string;
  /** Over the whole column (null when empty). */
  min: number | null;
  max: number | null;
  mean: number | null;
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
}

/**
 * What the layout remembers about each source, so charts can be restored by
 * re-importing the original CSV when no workspace file holds its data.
 */
export interface SourceMeta {
  id: string;
  name: string;
  path: string;
  columns: string[];
  import: ImportSettings;
}

export interface Workspace {
  version: 1;
  worksheets: Worksheet[];
  sourceMeta?: SourceMeta[];
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
