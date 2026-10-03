/**
 * Path resolution shared by the server and the CLI.
 *
 * The desktop app passes Electron's `app.getPath('userData')`; the server and the CLI
 * fall back to `%APPDATA%/vfox` (see AGENTS.md) so all three share one profile store.
 * Nothing here is hardcoded to a machine-specific path.
 */

import { homedir } from 'node:os'
import path from 'node:path'

import { ENV } from '@vfox/shared'

/** `<dataDir>/api-token` — the persisted API token file. */
export const API_TOKEN_FILE = 'api-token'

/**
 * Resolution order: explicit argument -> `VFOX_DATA_DIR` -> `%APPDATA%/vfox`
 * (`~/AppData/Roaming/vfox` on Windows, XDG data dir elsewhere).
 */
export function resolveDataDir(explicit?: string): string {
  if (explicit && explicit.length > 0) return path.resolve(explicit)

  const fromEnv = process.env[ENV.dataDir]
  if (fromEnv && fromEnv.length > 0) return path.resolve(fromEnv)

  return path.join(defaultAppDataRoot(), 'vfox')
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
