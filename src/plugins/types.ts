/** Chart plugins: a widget type defined by one JavaScript file (see spec.ts for the contract). */

export type ParamSpec =
  | { type: 'column'; label: string; description?: string; optional?: boolean }
  | { type: 'columns'; label: string; description?: string; min?: number; max?: number }
  | { type: 'number'; label: string; description?: string; default?: number; min?: number; max?: number; step?: number }
  | { type: 'select'; label: string; description?: string; options: (string | { value: string; label: string })[]; default?: string }
  | { type: 'boolean'; label: string; description?: string; default?: boolean }
  | { type: 'text'; label: string; description?: string; default?: string }
  | { type: 'color'; label: string; description?: string; default?: string };

/** What a plugin declares about itself (read in the sandbox, functions stripped). */
export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  params: Record<string, ParamSpec>;
}

/** An installed plugin: manifest + source. */
export interface PluginRecord extends PluginManifest {
  code: string;
  builtin?: boolean;
  installedAt: number;
}

/** A column chosen for a plugin parameter. */
export interface ColumnRef {
  source: string;
  column: string;
  label: string;
}

export type ParamValue = ColumnRef | ColumnRef[] | number | string | boolean | null;

/** Widget state for a plugin chart. */
export interface PluginWidget {
  id: string;
  params: Record<string, ParamValue>;
  /** Box zoom / pan of a plugin chart, in its data units (null = fit). */
  zoom?: PluginZoom | null;
}

export interface PluginZoom {
  x?: [number, number] | null;
  y?: [number, number] | null;
}
