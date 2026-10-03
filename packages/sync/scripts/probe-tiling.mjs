/**
 * Probe for the tiling FFI layer (koffi + user32.dll).
 *
 * Tiling is the one part of the synchroniser that unit tests cannot cover: it talks to the window
 * manager, so it needs a real desktop. This script reports exactly what that layer can see, which is
 * what CI and desktop debugging need when a window is not where it should be.
 *
 * Read-only by default:
 *   node packages/sync/scripts/probe-tiling.mjs
 *   node packages/sync/scripts/probe-tiling.mjs --display 1
 *
 * Opt-in move (needs a pid whose window you do not mind moving):
 *   node packages/sync/scripts/probe-tiling.mjs --move <pid> [--rect x,y,w,h]
 *
 * Requires `pnpm --filter @vfox/sync build` and, on Windows, an installed `koffi`.
 */

import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const packageRoot = path.resolve(here, '..')

function arg(name) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : null
}

function parseRect(value, fallback) {
  if (!value) {
    return fallback
  }
  const parts = value.split(',').map(Number)
  if (parts.length !== 4 || parts.some(part => !Number.isFinite(part))) {
    throw new Error(`--rect expects x,y,width,height (got "${value}")`)
  }
  return { x: parts[0], y: parts[1], width: parts[2], height: parts[3] }
}

const { createTileBackend } = await import(
  pathToFileURL(path.join(packageRoot, 'dist', 'tile.js')).href
)

const backend = createTileBackend()
const display = arg('display')
const movePid = arg('move')

process.stdout.write(`[probe] platform: ${process.platform}\n`)

try {
  const primary = await backend.workArea(null)
  process.stdout.write(`[probe] primary work area: ${JSON.stringify(primary)}\n`)
} catch (error) {
  process.stdout.write(`[probe] primary work area FAILED: ${error.message}\n`)
  process.exitCode = 1
}

// Enumerating displays also proves the callback marshalling of EnumDisplayMonitors.
const displays = display !== null ? [Number(display)] : [0, 1, 2, 3]
for (const index of displays) {
  try {
    const area = await backend.workArea(index)
    process.stdout.write(`[probe] display ${index} work area: ${JSON.stringify(area)}\n`)
  } catch (error) {
    process.stdout.write(`[probe] display ${index}: ${error.message}\n`)
    break
  }
}

if (movePid) {
  const pid = Number(movePid)
  const rect = parseRect(arg('rect'), { x: 40, y: 40, width: 900, height: 700 })
  const moved = await backend.place(pid, rect)
  process.stdout.write(
    `[probe] move(pid ${pid}) -> ${JSON.stringify(rect)}: matched and moved ${moved} window(s)\n`,
  )
  await backend.focus(pid)
  process.stdout.write(`[probe] focus(pid ${pid}) requested\n`)
  if (moved === 0) {
    process.exitCode = 1
  }
}
