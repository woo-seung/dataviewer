/**
 * "정렬" menu, like PowerPoint's arrange/distribute: even out widget heights
 * or widths across the worksheet or within one widget's column / row, and
 * swap a widget with its neighbour (Alt+Shift+arrow keys).
 */
import { AlignHorizontalSpaceAround, AlignVerticalSpaceAround, ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Grid2x2, StretchHorizontal, StretchVertical } from 'lucide';
import type { Side } from '../layout';
import { store } from '../store';
import type { MenuItem } from './overlays';

const SIDES: { side: Side; label: string; icon: typeof ArrowUp; key: string }[] = [
  { side: 'top', label: '위', icon: ArrowUp, key: 'Alt+Shift+↑' },
  { side: 'bottom', label: '아래', icon: ArrowDown, key: 'Alt+Shift+↓' },
  { side: 'left', label: '왼쪽', icon: ArrowLeft, key: 'Alt+Shift+←' },
  { side: 'right', label: '오른쪽', icon: ArrowRight, key: 'Alt+Shift+→' },
];

/** Swap a widget with the one next to it. Returns false when there is none. */
export function swapWithNeighbor(wsId: string, id: string, side: Side): boolean {
  const other = store.neighborTile(wsId, id, side);
  if (!other) return false;
  store.moveTile(wsId, id, other, 'center');
  return true;
}

export function arrangeMenu(wsId: string, widgetId: string | null): MenuItem[] {
  const items: MenuItem[] = [
    { title: '모든 위젯 높이 균등 분배', icon: AlignVerticalSpaceAround, onClick: () => store.distributeTiles(wsId, 'v') },
    { title: '모든 위젯 너비 균등 분배', icon: AlignHorizontalSpaceAround, onClick: () => store.distributeTiles(wsId, 'h') },
    { title: '높이·너비 모두 균등 분배', icon: Grid2x2, onClick: () => store.distributeTiles(wsId, 'both') },
  ];
  const w = widgetId ? store.widget(wsId, widgetId) : null;
  if (w && widgetId) {
    const name = w.title || '선택 위젯';
    items.push(
      { separator: true, title: '' },
      { title: `"${name}" 이(가) 있는 세로줄의 높이 맞추기`, icon: StretchVertical, onClick: () => store.distributeTiles(wsId, 'v', widgetId) },
      { title: `"${name}" 이(가) 있는 가로줄의 너비 맞추기`, icon: StretchHorizontal, onClick: () => store.distributeTiles(wsId, 'h', widgetId) },
      { separator: true, title: '' },
      ...SIDES.map((s) => ({
        title: `${s.label} 위젯과 자리 바꾸기`,
        icon: s.icon,
        hint: s.key,
        disabled: !store.neighborTile(wsId, widgetId, s.side),
        onClick: () => void swapWithNeighbor(wsId, widgetId, s.side),
      })),
    );
  }
  return items;
}
