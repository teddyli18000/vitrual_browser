/**
 * Path resolution shared by the server and the CLI.
 *
 * Resolution order (see AGENTS.md "Portable mode"):
 *   1. an explicit `dataDir` (the desktop passes Electron's `app.getPath('userData')`),
 *   2. `VFOX_DATA_DIR`,
 *   3. **portable mode** — a `portable` marker file or a `data/` directory next to
 *      `process.execPath`, in which case everything lives in that `data/` directory so the whole
 *      folder can be moved to another machine,
 *   4. `%APPDATA%/vfox`, so the server, the CLI and a non-portable desktop build share one store.
 *
 * Nothing here is hardcoded to a machine-specific path, and no caller may persist an absolute path
 * that would break after a portable folder is moved.
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

import { ENV } from '@vfox/shared'

/** `<dataDir>/api-token` — the persisted API token file. */
export const API_TOKEN_FILE = 'api-token'

/** Marker file shipped by `scripts/portable-zip.mjs` next to `VFox.exe`. */
export const PORTABLE_MARKER = 'portable'
/** Data directory shipped by the portable zip. */
export const PORTABLE_DATA_DIR = 'data'

export function resolveDataDir(explicit?: string): string {
  if (explicit && explicit.length > 0) return path.resolve(explicit)

  const fromEnv = process.env[ENV.dataDir]
  if (fromEnv && fromEnv.length > 0) return path.resolve(fromEnv)

  const portable = portableDataDir()
  if (portable !== undefined) return portable

  return path.join(defaultAppDataRoot(), 'vfox')
}

/**
 * `<exeDir>/data` when the portable build is in effect, otherwise `undefined`.
 *
 * `execPath` is a parameter so the rule can be tested without a packaged executable.
 */
export function portableDataDir(execPath: string = process.execPath): string | undefined {
  const exeDir = path.dirname(execPath)
  const dataDir = path.join(exeDir, PORTABLE_DATA_DIR)
  if (existsSync(path.join(exeDir, PORTABLE_MARKER)) || existsSync(dataDir)) return dataDir
  return undefined
}

export function apiTokenPath(dataDir: string): string {
  return path.join(dataDir, API_TOKEN_FILE)
}

function defaultAppDataRoot(): string {
  const appData = process.env.APPDATA
  if (appData && appData.length > 0) return appData
  if (process.platform === 'darwin') {
    return path.join(homedir(), 'Library', 'Application Support')
  }
  const xdg = process.env.XDG_DATA_HOME
  if (xdg && xdg.length > 0) return xdg
  return path.join(homedir(), '.local', 'share')
}
