/**
 * Startup orphan reconciliation.
 *
 * When the app is killed abnormally (crash, task manager, power loss) the engine processes it
 * spawned survive, still holding their profile's `parent.lock`. The next launch of that profile
 * then fails with "profile in use" — the single most common support complaint in this product
 * category. The long-term fix is a Windows Job Object with `KILL_ON_JOB_CLOSE`; until then this
 * reconciles at startup.
 *
 * Rules that matter:
 *   - a profile directory is NEVER deleted, only the stale lock file inside it;
 *   - a lock is only removed when we could enumerate processes and none of them references that
 *     profile, so a failure to enumerate never turns into a wrongly removed lock;
 *   - when nothing holds a lock, no process enumeration is done at all, so the common path costs
 *     one directory listing.
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { CoreLogger } from './index.js'

export interface EngineProcess {
  pid: number
  commandLine: string
}

export interface ReconcileOptions {
  dataDir: string
  logger: CoreLogger
  /** Injectable for tests; returns `null` when the platform cannot enumerate processes. */
  listProcesses?: () => Promise<EngineProcess[] | null>
  killTree?: (pid: number) => void
}

export interface ReconcileResult {
  /** Orphaned engine pids that were killed. */
  killed: number[]
  /** Stale lock files that were removed. */
  locksRemoved: string[]
  /** `false` when there was nothing to check (no profile holds a lock). */
  checked: boolean
}

const ENGINE_IMAGE = 'camoufox.exe'
const LOCK_FILE = 'parent.lock'
const DATA_DIR_LOCK = 'core.lock'

export interface DataDirLock {
  /** `false` when another live VFox instance already owns this data directory. */
  readonly acquired: boolean
  release(): Promise<void>
}

/**
 * Claim the data directory for this process.
 *
 * Reconciliation kills every engine process that references our profiles, which is only correct
 * when *we* are the instance that owns them. The desktop app, the CLI and the server all default to
 * the same data directory, so without this a `vfox` command run while the GUI has profiles open
 * would kill the user's running browsers. The lock is a file holding our pid: a live pid means
 * another instance is running and reconciliation is skipped entirely; a dead pid (or no file) means
 * the previous instance is gone and its engines are genuine orphans.
 */
export async function acquireDataDirLock(
  dataDir: string,
  logger: CoreLogger,
): Promise<DataDirLock> {
  const file = path.join(dataDir, DATA_DIR_LOCK)
  const owner = await readLockPid(file)
  if (owner !== null && owner !== process.pid && isProcessAlive(owner)) {
    logger.warn(
      `another VFox instance (pid ${owner}) owns ${dataDir}; ` +
        'skipping orphan reconciliation so its profiles keep running',
    )
    return { acquired: false, release: async () => {} }
  }

  await fs.mkdir(dataDir, { recursive: true })
  await fs.writeFile(
    file,
    `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`,
    'utf8',
  )
  return {
    acquired: true,
    async release() {
      // Only ever remove our own lock: another instance may have taken over meanwhile.
      if ((await readLockPid(file)) === process.pid) {
        await fs.rm(file, { force: true })
      }
    },
  }
}

async function readLockPid(file: string): Promise<number | null> {
  try {
    const raw = JSON.parse(await fs.readFile(file, 'utf8')) as { pid?: unknown }
    return typeof raw.pid === 'number' && Number.isInteger(raw.pid) && raw.pid > 0 ? raw.pid : null
  } catch {
    return null
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the process exists but we are not allowed to signal it.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export async function reconcileOrphans(options: ReconcileOptions): Promise<ReconcileResult> {
  const { dataDir, logger } = options
  const result: ReconcileResult = { killed: [], locksRemoved: [], checked: false }

  const profilesDir = path.join(dataDir, 'profiles')
  const profileDirs = await listDirectories(profilesDir)
  if (profileDirs.length === 0) {
    return result
  }

  const locked = []
  for (const dir of profileDirs) {
    if (await exists(path.join(dir, LOCK_FILE))) {
      locked.push(dir)
    }
  }
  if (locked.length === 0) {
    // An orphaned engine always holds its profile's lock, so there is nothing to reconcile.
    return result
  }

  result.checked = true
  const list = options.listProcesses ?? listEngineProcesses
  const processes = await list()
  if (processes === null) {
    logger.warn(
      `orphan reconciliation skipped: could not enumerate ${ENGINE_IMAGE} processes, ` +
        `${locked.length} profile(s) still hold ${LOCK_FILE}`,
    )
    return result
  }

  const profilesRoot = path.resolve(profilesDir).toLowerCase()
  const ours = processes.filter(process => process.commandLine.toLowerCase().includes(profilesRoot))

  const kill = options.killTree ?? killProcessTree
  for (const process of ours) {
    logger.warn(`killing orphaned engine process ${process.pid} from a previous run`)
    kill(process.pid)
    result.killed.push(process.pid)
  }

  // Re-enumerate once so a lock is never removed while its owner is still alive.
  const survivors = (await list()) ?? []
  const aliveCommands = survivors.map(process => process.commandLine.toLowerCase())

  for (const dir of locked) {
    const owner = path.resolve(dir, 'userdata').toLowerCase()
    if (aliveCommands.some(command => command.includes(owner))) {
      continue
    }
    try {
      await fs.rm(path.join(dir, LOCK_FILE), { force: true })
      result.locksRemoved.push(path.join(dir, LOCK_FILE))
    } catch (error) {
      logger.warn(`could not remove stale ${LOCK_FILE} in ${dir}: ${message(error)}`)
    }
  }

  if (result.killed.length > 0 || result.locksRemoved.length > 0) {
    logger.info(
      `orphan reconciliation: killed ${result.killed.length} process(es), ` +
        `removed ${result.locksRemoved.length} stale lock(s)`,
    )
  }
  return result
}

async function listDirectories(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    return entries.filter(entry => entry.isDirectory()).map(entry => path.join(dir, entry.name))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return []
    }
    throw error
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target)
    return true
  } catch {
    return false
  }
}

/**
 * Engine processes with their command lines.
 *
 * `wmic` is gone from current Windows images and `tasklist` cannot show a command line, so this
 * uses CIM. It returns `null` — never an empty list — when the platform cannot answer, because the
 * caller must not confuse "no processes" with "could not look".
 */
async function listEngineProcesses(): Promise<EngineProcess[] | null> {
  if (process.platform !== 'win32') {
    return null
  }
  const command = [
    `Get-CimInstance Win32_Process -Filter "Name='${ENGINE_IMAGE}'"`,
    'Select-Object ProcessId,CommandLine',
    'ConvertTo-Json -Compress -AsArray',
  ].join(' | ')

  const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8',
    windowsHide: true,
  })
  if (result.error || result.status !== 0 || !result.stdout) {
    return null
  }
  try {
    const parsed = JSON.parse(result.stdout) as { ProcessId?: unknown; CommandLine?: unknown }[]
    if (!Array.isArray(parsed)) {
      return null
    }
    return parsed.flatMap(entry => {
      const pid = Number(entry.ProcessId)
      const commandLine = typeof entry.CommandLine === 'string' ? entry.CommandLine : ''
      return Number.isInteger(pid) && pid > 0 ? [{ pid, commandLine }] : []
    })
  } catch {
    return null
  }
}

function killProcessTree(pid: number): void {
  if (process.platform !== 'win32') {
    return
  }
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
    stdio: 'ignore',
    windowsHide: true,
  })
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
