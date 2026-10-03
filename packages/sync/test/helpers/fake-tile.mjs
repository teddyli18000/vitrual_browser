/** Records what the session asked the tiling layer to do, without touching a real window. */
export class FakeTileBackend {
  workAreaCalls = []
  placed = []
  focused = []

  workAreaRect = { x: 0, y: 0, width: 1920, height: 1040 }
  /** When false, `place()` reports that no visible window matched the pid. */
  matches = true
  /** Pids whose window is reported as not found, even while `matches` is true. */
  unmatched = new Set()

  async workArea(displayIndex) {
    this.workAreaCalls.push(displayIndex)
    return this.workAreaRect
  }

  async place(pid, rect) {
    this.placed.push({ pid, rect })
    return this.matches && !this.unmatched.has(pid) ? 1 : 0
  }

  async focus(pid) {
    this.focused.push(pid)
  }
}
