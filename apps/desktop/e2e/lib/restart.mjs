/**
 * restart.mjs — the phase that restarts the APPLICATION, not just a profile.
 *
 * THE GAP THIS CLOSES. The packaged suite covers create -> launch -> browse -> stop -> clone -> export,
 * and proves a PROFILE survives a stop and relaunch. It never stopped the app itself and started it
 * again — which is the journey the owner actually performs, and the one where a portable product can
 * quietly lose everything: a stale single-instance lock, a store that only lives in memory, a token
 * that is not re-read, a second launch that silently uses a different data directory.
 *
 * THE SHAPE. A named export taking the phase's reporting helpers, like `idle-cost.mjs`: it reports
 * rather than asserts when a condition is environmental, and asserts when it is ours.
 *
 * The one function worth reading first is `checkPortablePaths` — it is a pure function of the files on
 * disk, so it can be shown going red locally by corrupting a store file, which is the only way to
 * prove any of this without Electron.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

/**
 * The portable promise: everything the product stores lives inside its own folder, so the folder can be
 * moved as a whole. An absolute path pointing outside it breaks that the moment the user moves or
 * copies the folder — and it is invisible until they do.
 *
 * A pure function of the filesystem, deliberately: it is what lets the failing case be demonstrated on
 * a machine where the app cannot start.
 *
 * @param {{ dataDir: string }} options
 * @returns {{ ok: boolean, checked: number, problems: string[] }}
 */
export function checkPortablePaths({ dataDir }) {
  const problems = []
  let checked = 0

  /** Every string in a JSON document, with its path, so a violation can be named precisely. */
  const strings = (value, trail, out) => {
    if (typeof value === 'string') out.push([trail, value])
    else if (Array.isArray(value))
      value.forEach((item, index) => {
        strings(item, `${trail}[${index}]`, out)
      })
    else if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value))
        strings(child, trail ? `${trail}.${key}` : key, out)
    }
    return out
  }

  const isAbsolute = value =>
    /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\') || value.startsWith('/')

  const walk = current => {
    let entries = []
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        // A profile's `userdata` is a real browser profile directory and contains thousands of files the
        // browser itself owns, including absolute paths in its own caches. Asserting over those would
        // report the engine's business as ours, so the check is scoped to the product's own store.
        if (entry.name === 'userdata') continue
        walk(full)
        continue
      }
      if (!entry.name.endsWith('.json')) continue
      checked += 1
      let parsed
      try {
        parsed = JSON.parse(readFileSync(full, 'utf8'))
      } catch (error) {
        problems.push(`${path.relative(dataDir, full)} is not valid JSON: ${error.message}`)
        continue
      }
      for (const [trail, value] of strings(parsed, '', [])) {
        if (!isAbsolute(value)) continue
        const resolved = path.resolve(value)
        const inside = resolved.toLowerCase().startsWith(path.resolve(dataDir).toLowerCase())
        if (!inside) {
          problems.push(
            `${path.relative(dataDir, full)} → ${trail} is the absolute path "${value}", which is ` +
              'outside the portable folder. The folder can no longer be moved as a whole.',
          )
        }
      }
    }
  }

  walk(dataDir)

  // FAIL CLOSED ON ZERO. Reading no store file means nothing was verified, and a check that scans
  // nothing and returns green is worse than no check because it is believed — this repository has
  // shipped that mistake twice. A missing store is a finding, not an empty pass.
  if (checked === 0) {
    problems.push(
      `no .json store file was found under ${dataDir}, so the portable promise was not verified. ` +
        'This is a failed check, not a pass.',
    )
  }

  return { ok: problems.length === 0, checked, problems }
}

/**
 * The phase. Everything it needs is injected so the runner owns the spawn call and the FIRST start
 * stays byte-for-byte what it was.
 *
 * @param {object} options
 * @param {() => Promise<{ stop: () => Promise<void>, started: boolean }>} options.spawnApp
 *   starts the packaged app with the same environment and data directory as the first start
 * @param {() => Promise<void>} options.stopApp stops the app the way the suite already does
 * @param {(route: string, init?: object) => Promise<{ status: number, body: any }>} options.api
 * @param {string} options.dataDir
 * @param {string} options.engineDir
 * @param {string} options.apiPort
 * @param {Array<{ id: string, name: string }>} options.expectedProfiles created earlier in the run
 * @param {{ note: Function, log: Function, assert: Function }} options.report
 */
export async function restartPhase({
  spawnApp,
  stopApp,
  api,
  dataDir,
  engineDir,
  apiPort,
  expectedProfiles,
  report,
}) {
  const { note, log, assert } = report

  log('')
  log('=== 8. restarting the APPLICATION, not just a profile')

  // 1. Stop the app the way the suite already does.
  await stopApp()
  log(`      stopped the application`)

  // 2. Start it again with the SAME environment and data directory.
  const restarted = await spawnApp()
  assert(restarted.started, 'the application started a second time with the same data directory')

  // 3. The five named checks.
  //
  // (a) It answers its own loopback API again, on the same port.
  let health = null
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline && !health) {
    const response = await api('/api/v1/health').catch(() => null)
    if (response?.status === 200) health = response
    else await new Promise(resolve => setTimeout(resolve, 2_000))
  }
  assert(Boolean(health), `the API answered again after the restart, on port ${apiPort}`)

  // (b) The profiles created earlier are still listed, by id, with the same names.
  const listed = await api('/api/v1/profiles')
  const after = listed.body?.data ?? []
  const missing = expectedProfiles.filter(
    profile => !after.some(candidate => candidate.id === profile.id),
  )
  const renamed = expectedProfiles.filter(profile => {
    const found = after.find(candidate => candidate.id === profile.id)
    return found && found.name !== profile.name
  })
  assert(
    missing.length === 0,
    `every profile created earlier is still listed by id (${expectedProfiles.length - missing.length}/${expectedProfiles.length})` +
      (missing.length
        ? `; missing: ${missing.map(profile => `${profile.id} (${profile.name})`).join(', ')}`
        : ''),
  )
  assert(
    renamed.length === 0,
    `every profile kept its name across the restart` +
      (renamed.length ? `; renamed: ${renamed.map(profile => profile.id).join(', ')}` : ''),
  )

  // (c) The engine is still installed where it was - ASKED OF THE APP, NOT OF THE FILESYSTEM. The
  // multi-kernel work moves the launcher into <root>/kernels/<version>/ and leaves only version.json at
  // the root, so a path assertion here fails on a CORRECT install the moment that lands. What the
  // product reports is the property, and it cannot drift with the layout.
  const engineAfterRestart = await api('/api/v1/kernel').catch(() => null)
  const kernelInfo = engineAfterRestart?.body?.data ?? null
  assert(
    kernelInfo?.installed === true &&
      Array.isArray(kernelInfo.kernels) &&
      kernelInfo.kernels.length > 0,
    `the engine is still installed after the restart (${JSON.stringify(kernelInfo)})`,
  )
  assert(
    existsSync(path.join(engineDir, 'version.json')),
    'the engine version file survived the restart, so the app will not re-download it',
  )

  // (d) Nothing in the store points outside the portable folder.
  const portable = checkPortablePaths({ dataDir })
  assert(
    portable.ok,
    `no absolute path in the store points outside the portable folder (${portable.checked} file(s) read)`,
  )
  for (const problem of portable.problems) log(`      ${problem}`)

  // (e) No stale process after the second stop.
  //
  // WHAT THIS DOES NOT PROVE, stated here rather than implied: it asserts the app's API stopped
  // ANSWERING, which is a proxy for the process being gone. A process could linger without serving, and
  // a stale single-instance lock could hold a port with no live app behind it. The direct check is
  // `user32.listEngineProcesses`, which needs CIM — the GitHub runner does not have it, the same
  // limitation phase 7 already reports around. So this check is weaker than it reads, and the note below
  // says which situation was observed instead of assuming the stronger one.
  await stopApp()
  await new Promise(resolve => setTimeout(resolve, 5_000))
  const leftover = await api('/api/v1/health').catch(() => null)
  assert(
    leftover?.status !== 200,
    'the application stopped cleanly the second time: its API no longer answers',
  )
  if (leftover?.status === 200) {
    note('a second stop left the API answering — a stale single-instance lock is the usual cause')
  }

  // A file the suite wrote and then could not read back is a different failure from a file that was
  // never written, and the message should say which.
  const profilesFile = path.join(dataDir, 'profiles.json')
  if (existsSync(profilesFile)) {
    log(`      store size after the restart: ${statSync(profilesFile).size} bytes`)
  }
}
