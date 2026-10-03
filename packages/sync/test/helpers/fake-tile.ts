import type { TileBackend } from '../../src/tile.js'
import type { Rect } from '../../src/tile-grid.js'

/** Records what the session asked the tiling layer to do, without touching a real window. */
export class FakeTileBackend implements TileBackend {
  readonly workAreaCalls: (number | null)[] = []
  readonly placed: { pid: number; rect: Rect }[] = []
  readonly focused: number[] = []

  workAreaRect: Rect = { x: 0, y: 0, width: 1920, height: 1040 }
  /** When false, `place()` reports that no visible window matched the pid. */
  matches = true

  async workArea(displayIndex: number | null): Promise<Rect> {
    this.workAreaCalls.push(displayIndex)
    return this.workAreaRect
  }

  async place(pid: number, rect: Rect): Promise<number> {
    this.placed.push({ pid, rect })
    return this.matches ? 1 : 0
  }

  async focus(pid: number): Promise<void> {
    this.focused.push(pid)
  }
}
