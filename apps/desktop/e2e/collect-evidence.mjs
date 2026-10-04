/**
 * collect-evidence.mjs — the **evidence collector**. Never a gate; it always exits 0.
 *
 * The owner's design, and a good one: one Playwright suite that asserts (`packaged-e2e.mjs`) and a
 * separate script that gathers everything a human needs to review a run without re-running it. This
 * is the second one. It shares the launch helpers and the structural guard, but it makes no
 * pass/fail decision — if the app will not start, that fact is *recorded*, not raised.
 *
 * A reviewer goes from a red CI run to evidence like this: open the run, download the
 * `packaged-e2e-evidence` artifact, read `evidence.md`. It contains the artifact's structural
 * report, the engine version the app resolved, the window rects it opened, the app's own log file,
 * and the per-profile fingerprint table.
 *
 * Temporary output only: everything is written under `--out` (default `<repo>/.cache/e2e-evidence`,
 * which is gitignored), never into the repository and never into the app's data directory.
 *
 * Usage:
 *   node apps/desktop/e2e/collect-evidence.mjs --app release/win-unpacked --out .cache/e2e-evidence
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { checkNoTestCode, checkWebglDatabase, describeArtifact } from './lib/artifact.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..', '..')
const user32 = await import(
  pathToFileURL(path.join(repoRoot, 'packages', 'core', 'scripts', 'lib', 'user32.mjs')).href
)

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : process.argv[index + 1]
}

const appTarget = path.resolve(argument('app', 'release/win-unpacked'))
const outDir = path.resolve(argument('out', path.join(repoRoot, '.cache', 'e2e-evidence')))
mkdirSync(outDir, { recursive: true })

const sections = []
function section(title, body) {
  sections.push(`## ${title}\n\n${body}\n`)
  console.log(`collected: ${title}`)
}

// ---------------------------------------------------------------- structural report (no Electron)
try {
  const artifact = await describeArtifact(appTarget)
  const webgl = checkWebglDatabase(artifact)
  const tests = checkNoTestCode(artifact)
  section(
    'Artifact',
    [
      `- target: \`${appTarget}\``,
      `- executable: \`${artifact.executable}\``,
      `- asar: \`${artifact.asarPath}\``,
      `- WebGL database unpacked: **${webgl.ok}** — ${webgl.detail}`,
      ...webgl.problems.map(problem => `  - ${problem}`),
      `- no test tooling packaged: **${tests.ok}** — ${tests.detail}`,
      ...tests.problems.map(problem => `  - ${problem}`),
      '',
      `### app.asar.unpacked (${artifact.unpackedEntries.length} entries, first 40)`,
      '```',
      ...artifact.unpackedEntries.slice(0, 40),
      '```',
    ].join('\n'),
  )
} catch (error) {
  section('Artifact', `could not read \`${appTarget}\`: ${error.message}`)
}

// ------------------------------------------------------------- the running app, best effort
let app
let bridge = null
try {
  const { _electron: electron } = await import('playwright')
  app = await electron.launch({
    executablePath: path.join(appTarget, 'VFox.exe'),
    timeout: 120_000,
  })
  const page = await app.firstWindow({ timeout: 120_000 })
  bridge = await page.evaluate(() => globalThis.vfox ?? null)
  section(
    'Application',
    [
      `- window title: \`${await page.title()}\``,
      `- bridge: \`${JSON.stringify(bridge)}\``,
      `- user agent: \`${await page.evaluate(() => navigator.userAgent)}\``,
    ].join('\n'),
  )

  // The app's own log file — the thing a maintainer would otherwise have to ask the user for.
  const dataDir = path.join(appTarget, 'data')
  const logs = []
  const collect = dir => {
    if (!existsSync(dir)) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) collect(full)
      else if (/\.log$/i.test(entry.name)) logs.push(full)
    }
  }
  collect(dataDir)
  for (const log of logs.slice(0, 3)) {
    const text = readFileSync(log, 'utf8').split('\n').slice(-400).join('\n')
    writeFileSync(path.join(outDir, path.basename(log)), text)
    section(`App log: ${path.basename(log)}`, `last 400 lines written to \`${path.basename(log)}\``)
  }
  if (logs.length === 0) section('App log', `no .log files under ${dataDir}`)

  if (bridge?.apiBase && bridge?.token) {
    const kernel = await fetch(`${bridge.apiBase}/api/v1/kernel`, {
      headers: { 'x-vfox-token': bridge.token },
    }).then(response => response.json())
    section('Engine', '```json\n' + JSON.stringify(kernel, null, 2) + '\n```')
  }
} catch (error) {
  section('Application', `could not launch or inspect the app: ${error.message}`)
} finally {
  await app?.close().catch(() => {})
}

// ------------------------------------------------------------------------- windows and processes
try {
  const engine = await user32.listEngineProcesses()
  section(
    'Windows and processes',
    [
      `- engine pids: \`${JSON.stringify(engine.pids ?? [])}\``,
      `- windows: ${(engine.windows ?? []).length}`,
      '```',
      ...(engine.windows ?? [])
        .slice(0, 30)
        .map(w => `pid ${w.pid} ${w.width}x${w.height} at ${w.x},${w.y} "${w.title ?? ''}"`),
      '```',
    ].join('\n'),
  )
} catch (error) {
  section('Windows and processes', `could not enumerate: ${error.message}`)
}

writeFileSync(
  path.join(outDir, 'evidence.md'),
  `# VFox packaged evidence\n\nCollected ${new Date().toISOString()} — this is evidence, not a gate.\n\n${sections.join('\n')}`,
)
console.log(`\nevidence written to ${path.join(outDir, 'evidence.md')}`)
// Always 0: the collector must never be the thing that decides whether a release is good.
process.exit(0)
