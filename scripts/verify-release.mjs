#!/usr/bin/env node
/**
 * verify-release.mjs — the release gate that inspects the *artifacts*, not the intentions.
 *
 * `.github/workflows/release.yml` runs this after `scripts/build-installer.mjs` and fails the
 * release when any check fails. Every check is deliberately independent of a teammate's
 * self-report: it reads the bytes that are about to be published.
 *
 * Checks
 *   1 artifacts        the expected files exist, are non-zero, and SHA256SUMS.txt matches them
 *   2 builder-config   apps/desktop/electron-builder.yml still carries the per-user install
 *                      contract and no system-integration features
 *   3 installer        the NSIS installer and the packaged app both declare `asInvoker`
 *                      (parsed from their PE RT_MANIFEST resource, never a byte grep)
 *   4 fuses            @electron/fuses reports the hardened fuse state on the packaged exe
 *   5 portable-zip     no absolute, drive-lettered or `..` entry names
 *   6 packaged-app     camoufox-js / playwright-core / impit are present as real files, the
 *                      main bundle is not an inlined copy of them
 *   7 integration      our own bundle registers no protocol handler, login item or user task
 *
 * Usage:
 *   node scripts/verify-release.mjs [--out <dir>] [--config <file>] [--skip-fuses]
 *
 * `--skip-fuses` exists only so the rest of the gate can be exercised while `ui` is still
 * landing the fuse flip; the release workflow never passes it.
 */
import { createHash } from 'node:crypto'
import {
  appendFileSync,
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
} from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** @param {string} name */
function arg(name) {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? undefined : process.argv[index + 1]
}

const outDir = path.resolve(arg('out') ?? path.join(repoRoot, 'release'))
const configPath = path.resolve(
  arg('config') ?? path.join(repoRoot, 'apps', 'desktop', 'electron-builder.yml'),
)
const skipFuses = process.argv.includes('--skip-fuses')
const version = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version

const failures = []
const notes = []

/** @param {string} name @param {boolean} ok @param {string} detail */
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(`${name}: ${detail}`)
}

/** @param {string} name @param {string} detail */
function note(name, detail) {
  notes.push(`${name}: ${detail}`)
  console.log(`INFO  ${name} — ${detail}`)
}

// --------------------------------------------------------------------------------- helpers

/** Every file below `dir`, as POSIX-style paths relative to it. */
function walk(dir, prefix = '') {
  const found = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) found.push(...walk(path.join(dir, entry.name), relative))
    else found.push(relative)
  }
  return found
}

/**
 * Extract the RT_MANIFEST resource of a PE file.
 *
 * electron-builder writes `win.requestedExecutionLevel` into the executable's manifest, so
 * parsing the real resource is the only trustworthy way to prove the installer and the app
 * will not ask for administrator. Returns undefined when the file has no manifest.
 *
 * @param {string} file
 * @returns {string | undefined}
 */
function readPeManifest(file) {
  const buf = readFileSync(file)
  if (buf.length < 0x40 || buf.readUInt16LE(0) !== 0x5a4d) return undefined
  const peOffset = buf.readUInt32LE(0x3c)
  if (buf.readUInt32LE(peOffset) !== 0x00004550) return undefined

  const coff = peOffset + 4
  const sectionCount = buf.readUInt16LE(coff + 2)
  const optionalSize = buf.readUInt16LE(coff + 16)
  const optional = coff + 20
  const dataDirectory = optional + (buf.readUInt16LE(optional) === 0x20b ? 112 : 96)

  const resourceRva = buf.readUInt32LE(dataDirectory + 16)
  const resourceSize = buf.readUInt32LE(dataDirectory + 20)
  if (resourceRva === 0 || resourceSize === 0) return undefined

  const sections = []
  const sectionTable = optional + optionalSize
  for (let i = 0; i < sectionCount; i++) {
    const section = sectionTable + i * 40
    sections.push({
      virtualAddress: buf.readUInt32LE(section + 12),
      virtualSize: buf.readUInt32LE(section + 8),
      rawPointer: buf.readUInt32LE(section + 20),
      rawSize: buf.readUInt32LE(section + 16),
    })
  }
  const rvaToOffset = rva => {
    for (const section of sections) {
      const span = Math.max(section.virtualSize, section.rawSize)
      if (rva >= section.virtualAddress && rva < section.virtualAddress + span) {
        return section.rawPointer + (rva - section.virtualAddress)
      }
    }
    return undefined
  }

  const base = rvaToOffset(resourceRva)
  if (base === undefined) return undefined
  const entriesIn = offset => {
    const count = buf.readUInt16LE(offset + 12) + buf.readUInt16LE(offset + 14)
    const out = []
    for (let i = 0; i < count; i++) {
      const entry = offset + 16 + i * 8
      out.push({ id: buf.readUInt32LE(entry), offset: buf.readUInt32LE(entry + 4) })
    }
    return out
  }

  const type = entriesIn(base).find(entry => (entry.id & 0x7fffffff) === 24) // RT_MANIFEST
  if (!type || (type.offset & 0x80000000) === 0) return undefined
  const name = entriesIn(base + (type.offset & 0x7fffffff))[0]
  if (!name || (name.offset & 0x80000000) === 0) return undefined
  const language = entriesIn(base + (name.offset & 0x7fffffff))[0]
  if (!language) return undefined

  const dataEntry = base + (language.offset & 0x7fffffff)
  const dataOffset = rvaToOffset(buf.readUInt32LE(dataEntry))
  const dataSize = buf.readUInt32LE(dataEntry + 4)
  if (dataOffset === undefined) return undefined

  const text = buf.subarray(dataOffset, dataOffset + dataSize).toString('utf8')
  const start = text.indexOf('<assembly')
  const end = text.lastIndexOf('</assembly>')
  if (start === -1) return text
  return text.slice(start, end === -1 ? undefined : end + '</assembly>'.length)
}

/** @param {string} manifest @returns {string | undefined} the requestedExecutionLevel value */
function executionLevelOf(manifest) {
  return manifest?.match(/requestedExecutionLevel[^>]*level\s*=\s*"([^"]+)"/i)?.[1]
}

/** Entry names stored in an asar archive. */
function readAsarEntries(asarPath) {
  const fd = openSync(asarPath, 'r')
  try {
    const sizeBuf = Buffer.alloc(8)
    if (readSync(fd, sizeBuf, 0, 8, 0) !== 8) return undefined
    const headerSize = sizeBuf.readUInt32LE(4)
    const headerBuf = Buffer.alloc(headerSize)
    if (readSync(fd, headerBuf, 0, headerSize, 8) !== headerSize) return undefined
    const jsonLength = headerBuf.readUInt32LE(4)
    const header = JSON.parse(headerBuf.subarray(8, 8 + jsonLength).toString('utf8'))

    const out = []
    const walkTree = (node, prefix) => {
      for (const [name, child] of Object.entries(node.files ?? {})) {
        const current = prefix ? `${prefix}/${name}` : name
        if (child.files) walkTree(child, current)
        else out.push(current)
      }
    }
    walkTree(header, '')
    return out
  } finally {
    closeSync(fd)
  }
}

/** Entry names and uncompressed sizes stored in a zip's central directory. */
function readZipEntries(zipPath) {
  const buf = readFileSync(zipPath)
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd === -1) return undefined

  const count = buf.readUInt16LE(eocd + 10)
  let offset = buf.readUInt32LE(eocd + 16)
  const entries = []
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) return undefined
    const nameLength = buf.readUInt16LE(offset + 28)
    entries.push({
      name: buf.subarray(offset + 46, offset + 46 + nameLength).toString('utf8'),
      size: buf.readUInt32LE(offset + 24),
    })
    offset += 46 + nameLength + buf.readUInt16LE(offset + 30) + buf.readUInt16LE(offset + 32)
  }
  return entries
}

// ------------------------------------------------------------------ 1. artifacts + checksums
const installerName = `VFox-Setup-${version}.exe`
const portableName = `VFox-${version}-portable.zip`
const published = [installerName, portableName]
const installerPath = path.join(outDir, installerName)
const portablePath = path.join(outDir, portableName)
const sumsPath = path.join(outDir, 'SHA256SUMS.txt')

for (const name of [...published, 'SHA256SUMS.txt']) {
  const file = path.join(outDir, name)
  const size = existsSync(file) ? statSync(file).size : 0
  check('artifacts', size > 0, `${name} is ${size} bytes`)
}

if (existsSync(sumsPath) && existsSync(installerPath) && existsSync(portablePath)) {
  const expected = new Map(
    readFileSync(sumsPath, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map(line => [line.slice(66).trim(), line.slice(0, 64)]),
  )
  for (const name of published) {
    const actual = createHash('sha256')
      .update(readFileSync(path.join(outDir, name)))
      .digest('hex')
    check('checksums', expected.get(name) === actual, `${name} ${actual}`)
  }
  const extra = [...expected.keys()].filter(name => !published.includes(name))
  check('checksums', extra.length === 0, `SHA256SUMS.txt lists only published artifacts (${extra})`)
}

// ----------------------------------------------------------------------- 2. builder config
let config
try {
  const yaml = await import('js-yaml')
  const load = yaml.load ?? yaml.default?.load
  config = load(readFileSync(configPath, 'utf8'))
  check('builder-config', true, `${path.relative(repoRoot, configPath)} parsed`)
} catch (error) {
  check('builder-config', false, `cannot read ${configPath}: ${error.message}`)
}

if (config) {
  const expected = [
    ['win.requestedExecutionLevel', config.win?.requestedExecutionLevel, 'asInvoker'],
    ['nsis.oneClick', config.nsis?.oneClick, false],
    ['nsis.perMachine', config.nsis?.perMachine, false],
    ['nsis.allowElevation', config.nsis?.allowElevation, false],
    ['nsis.deleteAppDataOnUninstall', config.nsis?.deleteAppDataOnUninstall, false],
  ]
  for (const [key, actual, wanted] of expected) {
    check(
      'installer-safety',
      actual === wanted,
      `${key} is ${JSON.stringify(actual)} (want ${wanted})`,
    )
  }

  const targets = (Array.isArray(config.win?.target) ? config.win.target : [config.win?.target])
    .filter(Boolean)
    .map(target => (typeof target === 'string' ? target : target.target))
  check('installer-safety', targets.includes('nsis'), `win.target = ${JSON.stringify(targets)}`)

  for (const key of ['fileAssociations', 'protocols', 'msi', 'squirrel', 'nsis.perMachine']) {
    if (key.includes('.')) continue
    check(
      'no-system-integration',
      config[key] === undefined,
      `electron-builder config has no ${key}`,
    )
  }
}

// ------------------------------------------------------------------ 3. execution level
const packagedExe = path.join(outDir, 'win-unpacked', 'VFox.exe')
const levelSources = [
  ['NSIS installer', existsSync(installerPath) ? installerPath : undefined],
  ['packaged app', existsSync(packagedExe) ? packagedExe : undefined],
]
for (const [label, file] of levelSources) {
  if (!file) {
    check(
      'execution-level',
      false,
      `${label} not found (${label === 'packaged app' ? packagedExe : installerPath})`,
    )
    continue
  }
  const manifest = readPeManifest(file)
  const level = executionLevelOf(manifest)
  check(
    'execution-level',
    level === 'asInvoker',
    `${label} requests ${JSON.stringify(level)} ` +
      `(manifest ${manifest ? 'parsed' : 'missing'}, ${statSync(file).size} bytes)`,
  )
}

// ------------------------------------------------------------------------------- 4. fuses
if (skipFuses) {
  note('fuses', 'skipped by --skip-fuses; the release workflow never passes this flag')
} else if (!existsSync(packagedExe)) {
  check('fuses', false, `packaged app ${packagedExe} not found`)
} else {
  // `RunAsNode` is asserted DISABLED for correctness as much as for hardening: it is what
  // makes `ELECTRON_RUN_AS_NODE` inert. With the fuse left at its default, any user (or any
  // launcher) that has `ELECTRON_RUN_AS_NODE=1` set globally turns our installed `VFox.exe`
  // into a plain Node interpreter, and `require('electron')` resolves to the npm package
  // instead of Electron's built-in module — the app misbehaves with no code defect present.
  // `GrantFileProtocolExtraPrivileges` is asserted ENABLED on purpose: it defaults to
  // enabled, and disabling it is only safe for apps that never load from `file://`. The
  // packaged renderer does exactly that, so "hardening" this fuse off ships a white screen.
  const required = [
    ['RunAsNode', false],
    ['EnableNodeOptionsEnvironmentVariable', false],
    ['EnableNodeCliInspectArguments', false],
    ['OnlyLoadAppFromAsar', true],
    ['EnableEmbeddedAsarIntegrityValidation', true],
    ['GrantFileProtocolExtraPrivileges', true],
  ]
  try {
    const fuses = await import('@electron/fuses')
    // @electron/fuses 1.x exposes `getCurrentFuseWire`; 2.x renamed it `getFuseState`.
    const read = fuses.getFuseState ?? fuses.getCurrentFuseWire
    if (typeof read !== 'function') {
      throw new Error('the package exposes no fuse-state reader')
    }
    // `FuseState` is not re-exported from the 1.x entry point, so fall back to the module
    // that defines it rather than hard-coding the wire values.
    const options =
      fuses.FuseV1Options ?? (await import('@electron/fuses/dist/config.js')).FuseV1Options
    const states = fuses.FuseState ?? (await import('@electron/fuses/dist/constants.js')).FuseState
    const state = await read(packagedExe)

    /** @param {string} name @returns {boolean | undefined} */
    const fuseValue = name => {
      const index = options?.[name]
      if (index !== undefined && state[index] !== undefined) {
        if (typeof state[index] === 'boolean') return state[index]
        if (state[index] === states?.ENABLE) return true
        if (state[index] === states?.DISABLE) return false
        return undefined
      }
      const camel = name[0].toLowerCase() + name.slice(1)
      return typeof state[camel] === 'boolean' ? state[camel] : undefined
    }

    for (const [name, wanted] of required) {
      const actual = fuseValue(name)
      check('fuses', actual === wanted, `${name} = ${actual} (want ${wanted})`)
    }
    note('fuses', `raw state ${JSON.stringify(state)}`)
  } catch (error) {
    check('fuses', false, `cannot read the fuse state of ${packagedExe}: ${error.message}`)
  }
}

// ------------------------------------------------------- 5. size budget + portable zip layout
// The headline differentiator is that VFox does NOT bundle the ~550 MB Camoufox engine.
// If a future dependency accident (a bundled engine, a stray native runtime, an un-stripped
// Chromium locale set) blows this budget, the release must fail rather than ship quietly.
const INSTALLER_BUDGET_BYTES = 150 * 1024 * 1024

if (existsSync(installerPath)) {
  const bytes = statSync(installerPath).size
  check(
    'size-budget',
    bytes <= INSTALLER_BUDGET_BYTES,
    `${installerName} is ${bytes} bytes (${(bytes / 1024 / 1024).toFixed(1)} MB); budget ${INSTALLER_BUDGET_BYTES / 1024 / 1024} MB`,
  )
}

let unpackedBytes = 0
let unpackedFiles = 0
if (existsSync(portablePath)) {
  const entries = readZipEntries(portablePath)
  if (!entries) {
    check('portable-zip', false, 'could not read the zip central directory')
  } else {
    const bad = entries.filter(
      entry =>
        /^[A-Za-z]:/.test(entry.name) || entry.name.startsWith('/') || entry.name.includes('../'),
    )
    check(
      'portable-zip',
      bad.length === 0,
      `${entries.length} entries, offending: ${bad.slice(0, 5)}`,
    )

    // Without these the extracted folder is not portable at all: VFox would silently keep
    // its profiles in %APPDATA% and the folder could not be moved to another machine.
    const names = new Set(entries.map(entry => entry.name))
    check(
      'portable-zip',
      names.has('portable'),
      'the zip ships the `portable` marker file next to VFox.exe',
    )
    check(
      'portable-zip',
      names.has('data/') || [...names].some(name => name.startsWith('data/')),
      `the zip ships a data/ directory (found ${JSON.stringify([...names].filter(n => n.startsWith('data')))})`,
    )

    unpackedFiles = entries.length
    unpackedBytes = entries.reduce((total, entry) => total + entry.size, 0)
    note(
      'footprint',
      `${portableName} holds ${unpackedFiles} files, ${(unpackedBytes / 1024 / 1024).toFixed(1)} MB unpacked`,
    )
  }
}

// ---------------------------------------------------------------------- 6. packaged app
const resourcesDir = path.join(outDir, 'win-unpacked', 'resources')
if (!existsSync(resourcesDir)) {
  check('packaged-app', false, `${resourcesDir} not found`)
} else {
  const asarPath = path.join(resourcesDir, 'app.asar')
  const asarEntries = existsSync(asarPath) ? (readAsarEntries(asarPath) ?? []) : []
  const unpackedDir = path.join(resourcesDir, 'app.asar.unpacked')
  const unpacked = existsSync(unpackedDir) ? walk(unpackedDir) : []
  note(
    'packaged-app',
    `app.asar has ${asarEntries.length} entries, app.asar.unpacked has ${unpacked.length} files`,
  )

  const has = (prefix, list) => list.some(entry => entry.startsWith(prefix))
  for (const name of ['camoufox-js', 'playwright-core']) {
    check(
      'packaged-app',
      has(`node_modules/${name}/`, asarEntries) || has(`node_modules/${name}/`, unpacked),
      `resources contain ${name} (external dependency must not be bundled)`,
    )
  }
  check(
    'packaged-app',
    has('node_modules/camoufox-js/dist/data-files/', asarEntries) ||
      has('node_modules/camoufox-js/dist/data-files/', unpacked),
    'camoufox-js ships its dist/data-files payload',
  )
  const nativeModules = [...asarEntries, ...unpacked].filter(entry => entry.endsWith('.node'))
  check(
    'packaged-app',
    nativeModules.some(entry => entry.includes('impit')),
    `impit native binary present as a file (found ${JSON.stringify(nativeModules.slice(0, 3))})`,
  )

  // The main process is built as CommonJS (`.cjs`) on purpose: electron-vite emits ESM when the
  // app package is `"type": "module"`, and Electron's own `electron` module is CJS with dynamically
  // defined exports, so an ESM main process cannot import it. Accept either extension so a future
  // build-format change surfaces as a real assertion failure rather than "file not found".
  const mainDir = path.join(repoRoot, 'apps', 'desktop', 'out', 'main')
  const mainBundle = ['index.cjs', 'index.js', 'index.mjs']
    .map(name => path.join(mainDir, name))
    .find(candidate => existsSync(candidate))
  if (!mainBundle) {
    check('packaged-app', false, `no main bundle found in ${mainDir}`)
  } else {
    const source = readFileSync(mainBundle, 'utf8')
    const size = statSync(mainBundle).size
    check(
      'packaged-app',
      size < 2 * 1024 * 1024,
      `${path.relative(repoRoot, mainBundle)} is ${(size / 1024).toFixed(1)} KB`,
    )
    check(
      'packaged-app',
      !source.includes('daijro/camoufox'),
      'the main bundle does not inline camoufox-js',
    )
  }

  // ------------------------------------------------------- 7. no system-wide integration
  const bundleDir = path.join(repoRoot, 'apps', 'desktop', 'out')
  if (existsSync(bundleDir)) {
    const forbidden = [
      'setAsDefaultProtocolClient',
      'setLoginItemSettings',
      'setUserTasks',
      'registerFileAssociations',
    ]
    const hits = []
    for (const relative of walk(bundleDir)) {
      if (!/\.(js|cjs|mjs|html)$/.test(relative)) continue
      const source = readFileSync(path.join(bundleDir, relative), 'utf8')
      for (const needle of forbidden) {
        if (source.includes(needle)) hits.push(`${relative}: ${needle}`)
      }
    }
    check('no-system-integration', hits.length === 0, `bundle hits: ${JSON.stringify(hits)}`)
  }
}

// ------------------------------------------------------------------------------- verdict
console.log('')
if (notes.length > 0) console.log(`notes: ${notes.length}`)

// The job summary is where the size trend across releases is actually read.
if (process.env.GITHUB_STEP_SUMMARY) {
  const rows = published.map(name => {
    const file = path.join(outDir, name)
    const bytes = existsSync(file) ? statSync(file).size : 0
    return `| \`${name}\` | ${(bytes / 1024 / 1024).toFixed(2)} MB |`
  })
  const summary = [
    `## VFox ${version} release verification`,
    '',
    '| Artifact | Size |',
    '| --- | --- |',
    ...rows,
    `| portable zip unpacked (${unpackedFiles} files) | ${(unpackedBytes / 1024 / 1024).toFixed(1)} MB |`,
    `| installer budget | ${(INSTALLER_BUDGET_BYTES / 1024 / 1024).toFixed(0)} MB |`,
    '',
    ...notes.map(entry => `- ${entry}`),
    '',
  ].join('\n')
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary)
}

if (failures.length > 0) {
  console.error(`[verify-release] ${failures.length} check(s) failed:`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log('[verify-release] all release gates passed')
