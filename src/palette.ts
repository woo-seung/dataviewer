/**
 * Categorical series palette, validated for CVD separation on light and dark
 * surfaces. Series store a slot reference ("slot:N") so the colour follows the
 * entity and re-steps correctly when the theme changes; custom picks store hex.
 */
export const PALETTE = {
  light: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'],
  dark: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'],
};

export const SLOT_NAMES = ['blue', 'orange', 'aqua', 'yellow', 'magenta', 'green', 'violet', 'red'];

export function slotColor(i: number): string {
  return `slot:${i}`;
}

export function slotIndex(c: string): number {
  return c.startsWith('slot:') ? Number(c.slice(5)) : -1;
}

/** Lowest slot not already used in this chart (fixed order, never re-assigned on removal). */
export function nextSlot(used: string[]): number {
  const taken = new Set(used.map(slotIndex));
  for (let i = 0; i < PALETTE.dark.length; i++) if (!taken.has(i)) return i;
  return used.length % PALETTE.dark.length;
}

export function resolveColor(c: string, theme: 'dark' | 'light'): string {
  const i = slotIndex(c);
  if (i < 0) return c;
  const p = PALETTE[theme];
  return p[i % p.length];
}

export function withAlpha(hex: string, a: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
