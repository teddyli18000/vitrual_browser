/**
 * Where the app keeps its data, resolved once at startup.
 *
 * The portable build must be fully self-contained: every byte it writes lives inside its own
 * folder, so the whole folder can be copied to another machine or drive and keep working.
 * Nothing anywhere may cache an absolute path — every location is derived from `dataDir` at the
 * moment it is used, so moving the folder moves the data with it.
 */

import { existsSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import { ENV } from '@vfox/shared'

export type DataMode = 'portable' | 'installed' | 'custom'

export interface DataLocation {
  /** Absolute root of every persisted byte: profiles, engine, logs, ui-state. */
  dir: string
  mode: DataMode
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * Resolution order, exactly as specified:
 *  1. `VFOX_DATA_DIR` — used verbatim (dev, CI, and anyone who wants an explicit location).
 *  2. A `portable` file or a `data` directory next to the executable — portable mode. The release
 *     zip ships an empty `data/` plus the `portable` marker, so this is automatic.
 *  3. `app.getPath('userData')` — the installed mode, `%APPDATA%\VFox`.
 */
export function resolveDataLocation(): DataLocation {
  const override = process.env[ENV.dataDir]
  if (override && override.trim().length > 0) {
    return { dir: override, mode: 'custom' }
  }

  const exeDir = dirname(process.execPath)
  const portable = join(exeDir, 'data')
  if (existsSync(join(exeDir, 'portable')) || isDirectory(portable)) {
    return { dir: portable, mode: 'portable' }
  }

  return { dir: app.getPath('userData'), mode: 'installed' }
}
