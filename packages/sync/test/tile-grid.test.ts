import { describe, expect, it } from 'vitest'
import { computeTileGrid, gridShape, type Rect, TILE_GAP } from '../src/tile-grid.js'

const workArea: Rect = { x: 0, y: 0, width: 1920, height: 1040 }

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}

function right(rect: Rect): number {
  return rect.x + rect.width
}

function bottom(rect: Rect): number {
  return rect.y + rect.height
}

describe('gridShape', () => {
  it('lays a grid out as squarely as possible', () => {
    expect(gridShape(1, 'grid')).toEqual({ columns: 1, rows: 1 })
    expect(gridShape(2, 'grid')).toEqual({ columns: 2, rows: 1 })
    expect(gridShape(4, 'grid')).toEqual({ columns: 2, rows: 2 })
    expect(gridShape(5, 'grid')).toEqual({ columns: 3, rows: 2 })
    expect(gridShape(9, 'grid')).toEqual({ columns: 3, rows: 3 })
    expect(gridShape(10, 'grid')).toEqual({ columns: 4, rows: 3 })
  })

  it('stacks rows and columns on request', () => {
    expect(gridShape(4, 'rows')).toEqual({ columns: 1, rows: 4 })
    expect(gridShape(4, 'columns')).toEqual({ columns: 4, rows: 1 })
  })
})

describe('computeTileGrid', () => {
  it('returns nothing for an empty selection', () => {
    expect(computeTileGrid(0, 'grid', workArea)).toEqual([])
  })

  it('fills the work area exactly when the grid divides evenly', () => {
    const rects = computeTileGrid(4, 'grid', { x: 0, y: 0, width: 1920, height: 1040 })

    expect(rects).toEqual([
      { x: 0, y: 0, width: 959, height: 519 },
      { x: 961, y: 0, width: 959, height: 519 },
      { x: 0, y: 521, width: 959, height: 519 },
      { x: 961, y: 521, width: 959, height: 519 },
    ])
  })

  it('keeps every window inside the work area, taskbar included', () => {
    const area: Rect = { x: 0, y: 0, width: 1920, height: 1040 }
    for (const count of [1, 2, 3, 4, 5, 6, 7, 8, 12]) {
      for (const layout of ['grid', 'rows', 'columns'] as const) {
        for (const rect of computeTileGrid(count, layout, area)) {
          expect(rect.x).toBeGreaterThanOrEqual(area.x)
          expect(rect.y).toBeGreaterThanOrEqual(area.y)
          expect(right(rect)).toBeLessThanOrEqual(area.x + area.width)
          expect(bottom(rect)).toBeLessThanOrEqual(area.y + area.height)
          expect(rect.width).toBeGreaterThan(0)
          expect(rect.height).toBeGreaterThan(0)
        }
      }
    }
  })

  it('offsets the whole grid when the work area starts elsewhere', () => {
    const rects = computeTileGrid(2, 'grid', { x: 1920, y: -200, width: 800, height: 600 })

    expect(rects[0]?.x).toBe(1920)
    expect(rects[0]?.y).toBe(-200)
    expect(rects[1]?.x).toBe(1920 + 399 + TILE_GAP)
    expect(rects[1]?.y).toBe(-200)
  })

  it('never overlaps two windows', () => {
    const rects = computeTileGrid(6, 'grid', workArea)
    for (let a = 0; a < rects.length; a += 1) {
      for (let b = a + 1; b < rects.length; b += 1) {
        const first = rects[a]
        const second = rects[b]
        if (first && second) {
          expect(overlaps(first, second)).toBe(false)
        }
      }
    }
  })

  it('leaves the last, partially filled row at the left edge', () => {
    const rects = computeTileGrid(5, 'grid', workArea)

    expect(rects).toHaveLength(5)
    expect(rects[3]?.x).toBe(0)
    expect(rects[4]?.x).toBe(rects[1]?.x)
    expect(rects[4]?.y).toBe(rects[3]?.y)
  })

  it('stacks rows and columns as asked', () => {
    const rows = computeTileGrid(3, 'rows', workArea)
    expect(rows.map(rect => rect.x)).toEqual([0, 0, 0])
    expect(rows[0]?.width).toBe(workArea.width)

    const columns = computeTileGrid(3, 'columns', workArea)
    expect(columns.map(rect => rect.y)).toEqual([0, 0, 0])
    expect(columns[0]?.height).toBe(workArea.height)
  })

  it('degrades to one pixel instead of producing a negative size on a tiny screen', () => {
    const rects = computeTileGrid(9, 'columns', { x: 0, y: 0, width: 10, height: 10 })
    for (const rect of rects) {
      expect(rect.width).toBeGreaterThanOrEqual(1)
      expect(rect.height).toBeGreaterThanOrEqual(1)
    }
  })
})
