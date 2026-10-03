#!/usr/bin/env node
/**
 * build-installer.mjs — one command from a clean checkout to shippable release artifacts.
 *
 * Used by `.github/workflows/release.yml` and by a human who wants the same bytes locally.
 * It runs, in order:
 *   1. `pnpm -r --filter "./packages/**" build`      — the workspace libraries
 *   2. `electron-vite build` in apps/desktop         — main, preload and renderer
 *   3. `electron-builder --win nsis zip --x64`       — the NSIS installer and the portable zip
 *   4. artifact normalisation + SHA256SUMS.txt + a printed inventory
 *
 * Deliberate choices:
 *   - `--win nsis zip --x64` is passed on the CLI so the produced artifact set does not
 *     depend on whatever `apps/desktop/electron-builder.yml` happens to list.
 *   - `-c.directories.output=<repo>/release` pins the output dir, so the artifacts land in
 *     one predictable place on any machine and in CI.
 *   - `-c.npmRebuild=false` skips electron-builder's dependency install/rebuild pass: our
 *     node_modules is already installed by pnpm, `better-sqlite3` is never imported by
 *     camoufox-js's build output (see AGENTS.md) and `impit` ships napi prebuilds, so a
 *     full MSVC rebuild would cost minutes and ship nothing different.
 *   - Artifacts are re-saved under the exact names the release publishes:
 *     `VFox-Setup-<version>.exe` and `VFox-<version>-portable.zip`.
 *
 * Usage:
 *   node scripts/build-installer.mjs
 */
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { addPortableMarkers } from './portable-zip.mjs'
import { run as runCommand } from './run-command.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outDir = path.join(repoRoot, 'release')

// Keep electron-builder's ~200 MB of Electron/NSIS downloads inside the checkout, exactly
// like scripts/dev-env.ps1 does locally and like the actions/cache steps expect in CI.
process.env.ELECTRON_CACHE ??= path.join(repoRoot, '.cache', 'electron')
process.env.ELECTRON_BUILDER_CACHE ??= path.join(repoRoot, '.cache', 'electron-builder')

/** @param {string} message */
function fail(message) {
  console.error(`\n[build-installer] FAIL: ${message}`)
  process.exit(1)
}

/**
 * Run a build step, failing this script with a named reason when it does not succeed.
 * The child-process details (inherited stdio, the Windows `.cmd` shim) live in run-command.mjs
 * because `scripts/test-all.mjs` needs exactly the same behaviour.
 *
 * @param {string} command @param {string[]} args @param {string} cwd
 */
function run(command, args, cwd) {
  console.error('')
  const status = runCommand(command, args, cwd)
  if (status !== 0) fail(`\`${command} ${args.join(' ')}\` exited with ${status}`)
}

/** @param {string} file */
function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/** @param {string} dir @returns {string[]} every file below `dir`, relative to it */
function walk(dir) {
  const found = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      for (const nested of walk(full)) found.push(path.join(entry.name, nested))
    } else {
      found.push(entry.name)
    }
  }
  return found
}

/** @param {string} relative */
function sizeOf(relative) {
  return `${(statSync(path.join(outDir, relative)).size / 1024 / 1024).toFixed(1)} MB`
}

// ---------------------------------------------------------------- 1. build the workspace
// Read the two version files directly rather than spawning scripts/version.mjs: a child
// process with piped stdio is not available in this project's local sandbox. The workflow
// still runs scripts/version.mjs as the authoritative check before this script.
const versionOf = relative =>
  JSON.parse(readFileSync(path.join(repoRoot, relative), 'utf8')).version
const version = versionOf('package.json')
const desktopVersion = versionOf(path.join('apps', 'desktop', 'package.json'))
if (version !== desktopVersion) {
  fail(
    `package.json is ${version} but apps/desktop/package.json is ${desktopVersion}; ` +
      'bump both together (scripts/version.mjs checks the same invariant).',
  )
}
console.error(`[build-installer] version ${version}`)

// The four workspace libraries are built one `pnpm --filter` at a time instead of with
// `pnpm -r --filter "./packages/**" build`. The result is identical, but pnpm's recursive
// runner pipes each child's output through itself, and a piped child process is not
// available on a sandboxed developer machine — which would make this script CI-only.
// Building per package also names the package that failed. `@vfox/shared` is the root of
// the dependency graph (core/server/cli resolve its built `dist/`), so it goes first.
const packageDir = path.join(repoRoot, 'packages')
const packageNames = readdirSync(packageDir, { withFileTypes: true })
  .filter(entry => entry.isDirectory())
  .map(entry => {
    const manifest = path.join(packageDir, entry.name, 'package.json')
    return existsSync(manifest) ? JSON.parse(readFileSync(manifest, 'utf8')) : undefined
  })
  .filter(pkg => typeof pkg?.scripts?.build === 'string')
  .map(pkg => pkg.name)
  .sort((a, b) => (a === '@vfox/shared' ? -1 : b === '@vfox/shared' ? 1 : a.localeCompare(b)))

for (const name of packageNames) run('pnpm', ['--filter', name, 'build'], repoRoot)

run('pnpm', ['--filter', '@vfox/desktop', 'exec', 'electron-vite', 'build'], repoRoot)

// ------------------------------------------------------- 2. package with electron-builder
if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

run(
  'pnpm',
  [
    '--filter',
    '@vfox/desktop',
    'exec',
    'electron-builder',
    '--win',
    'nsis',
    'zip',
    '--x64',
    '--publish',
    'never',
    '-c.npmRebuild=false',
    `-c.directories.output=${outDir.replaceAll('\\', '/')}`,
  ],
  repoRoot,
)

// ------------------------------------------------------------- 3. normalise the artifacts
// electron-builder also writes .blockmap/.yml metadata and keeps `win-unpacked/`, which the
// release must not publish and must not mistake for an artifact.
const files = walk(outDir).filter(
  relative =>
    !/(^|[\\/])win-unpacked[\\/]/i.test(relative) && !/\.(blockmap|ya?ml)$/i.test(relative),
)
const installers = files.filter(file => file.toLowerCase().endsWith('.exe'))
const zips = files.filter(file => file.toLowerCase().endsWith('.zip'))

if (installers.length === 0) {
  fail(`electron-builder produced no NSIS installer in ${outDir}. Files: ${files.join(', ')}`)
}
if (zips.length === 0) {
  fail(`electron-builder produced no portable zip in ${outDir}. Files: ${files.join(', ')}`)
}

/** @param {string[]} candidates @param {RegExp} preferred @param {string} target */
function publish(candidates, preferred, target) {
  const chosen =
    candidates.find(file => preferred.test(path.basename(file))) ??
    candidates.sort(
      (a, b) => statSync(path.join(outDir, b)).size - statSync(path.join(outDir, a)).size,
    )[0]
  const from = path.join(outDir, chosen)
  const to = path.join(outDir, target)
  if (from !== to) {
    copyFileSync(from, to)
    rmSync(from, { force: true })
  }
  return target
}

const installer = publish(installers, /setup|install/i, `VFox-Setup-${version}.exe`)
const portable = publish(zips, /portable|win/i, `VFox-${version}-portable.zip`)

// The portable zip must be self-contained: the runtime switches to `<exe dir>/data` when it
// finds a `portable` marker or a `data/` directory next to the executable. electron-builder
// cannot put them there for the zip alone (its `extraFiles` would also land inside the NSIS
// install and silently move the *installed* build into portable mode), so the finished
// archive is amended in place. This happens before the checksums are computed.
const addedMarkers = addPortableMarkers(path.join(outDir, portable))
console.error(
  `[build-installer] portable markers ${addedMarkers.length > 0 ? `added: ${addedMarkers.join(', ')}` : 'already present'}`,
)

const published = [installer, portable]

// -------------------------------------------------------- 4. checksums + printed inventory
const sums = published.map(name => `${sha256(path.join(outDir, name))}  ${name}`)
writeFileSync(path.join(outDir, 'SHA256SUMS.txt'), `${sums.join('\n')}\n`)
published.push('SHA256SUMS.txt')

for (const name of published) {
  const file = path.join(outDir, name)
  if (!existsSync(file) || statSync(file).size === 0) fail(`${name} is missing or empty`)
}

console.error(`\n[build-installer] release artifacts in ${outDir}`)
for (const name of published) {
  console.error(`  ${name}  ${sizeOf(name)}`)
  if (name !== 'SHA256SUMS.txt') console.error(`    sha256 ${sha256(path.join(outDir, name))}`)
}
