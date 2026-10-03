/**
 * Window bounds + UI flags, persisted as one small JSON file next to the profile store.
 * Restored bounds are validated against the currently attached displays so unplugging a
 * monitor cannot put the window off-screen.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { screen, type BrowserWindow, type Rectangle } from 'electron'

export interface UiState {
  window: Rectangle
  maximized: boolean
  /** The "still running in the tray" balloon is shown once, ever. */
  trayHintShown: boolean
}

const DEFAULT_BOUNDS: Rectangle = { x: 0, y: 0, width: 1180, height: 760 }

function statePath(dataDir: string): string {
  return join(dataDir, 'ui-state.json')
}

function isRectangle(value: unknown): value is Rectangle {
  if (typeof value !== 'object' || value === null) return false
  const r = value as Record<string, unknown>
  return (
    typeof r.x === 'number' &&
    typeof r.y === 'number' &&
    typeof r.width === 'number' &&
    typeof r.height === 'number' &&
    r.width > 200 &&
    r.height > 200
  )
}

/** True when at least a strip of the saved rectangle is still on a live display. */
function isVisibleOnSomeDisplay(bounds: Rectangle): boolean {
  return screen.getAllDisplays().some((display) => {
    const area = display.workArea
    return (
      bounds.x < area.x + area.width &&
      bounds.x + bounds.width > area.x &&
      bounds.y < area.y + area.height &&
      bounds.y + bounds.height > area.y
    )
  })
}

export function loadUiState(dataDir: string): UiState {
  const fallback: UiState = { window: DEFAULT_BOUNDS, maximized: false, trayHintShown: false }
  let raw: string
  try {
    raw = readFileSync(statePath(dataDir), 'utf8')
  } catch {
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Partial<UiState>
    const bounds = isRectangle(parsed.window) && isVisibleOnSomeDisplay(parsed.window) ? parsed.window : DEFAULT_BOUNDS
    return {
      window: bounds,
      maximized: parsed.maximized === true,
      trayHintShown: parsed.trayHintShown === true,
    }
  } catch {
    return fallback
  }
}

export function saveUiState(dataDir: string, state: UiState): void {
  try {
    const file = statePath(dataDir)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  } catch {
    // Losing window geometry must never break the app.
  }
}

/**
 * Persist bounds as the user moves/resizes, coalesced so a drag does not write on every frame.
 * `getUiState` lets the caller merge flags it owns (e.g. `trayHintShown`).
 */
export function trackWindowState(window: BrowserWindow, dataDir: string, getUiState: () => UiState): void {
  let timer: NodeJS.Timeout | null = null
  const persist = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      const state = getUiState()
      const bounds = window.isMaximized() || window.isMinimized() ? state.window : window.getNormalBounds()
      saveUiState(dataDir, { ...state, window: bounds, maximized: window.isMaximized() })
    }, 400)
  }
  window.on('resize', persist)
  window.on('move', persist)
  window.on('maximize', persist)
  window.on('unmaximize', persist)
  window.on('close', () => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    const state = getUiState()
    const bounds = window.isMaximized() || window.isMinimized() ? state.window : window.getNormalBounds()
    saveUiState(dataDir, { ...state, window: bounds, maximized: window.isMaximized() })
  })
}
