/**
 * Tile geometry — pure arithmetic, so the placement rules are testable without a monitor.
 *
 * Windows are laid out inside the monitor's *work area* (the screen minus the taskbar), never the
 * full screen, so a tiled row is never hidden behind the taskbar.
 */

import type { TileLayout } from '@vfox/shared'

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** Space between tiled windows, so two adjacent window borders stay distinguishable. */
export const TILE_GAP = 2

export function computeTileGrid(
  count: number,
  layout: TileLayout,
  workArea: Rect,
  gap: number = TILE_GAP,
): Rect[] {
  if (count <= 0) {
    return []
  }
  const { columns, rows } = gridShape(count, layout)
  const cellWidth = Math.max(1, Math.floor((workArea.width - gap * (columns - 1)) / columns))
  const cellHeight = Math.max(1, Math.floor((workArea.height - gap * (rows - 1)) / rows))

  const rects: Rect[] = []
  for (let index = 0; index < count; index += 1) {
    const column = index % columns
    const row = Math.floor(index / columns)
    rects.push({
      x: workArea.x + column * (cellWidth + gap),
      y: workArea.y + row * (cellHeight + gap),
      width: cellWidth,
      height: cellHeight,
    })
  }
  return rects
}

export function gridShape(count: number, layout: TileLayout): { columns: number; rows: number } {
  if (layout === 'rows') {
    return { columns: 1, rows: count }
  }
  if (layout === 'columns') {
    return { columns: count, rows: 1 }
  }
  const columns = Math.max(1, Math.ceil(Math.sqrt(count)))
  return { columns, rows: Math.ceil(count / columns) }
}
