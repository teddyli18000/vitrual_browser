/**
 * artifact.mjs — read a packaged VFox build and answer the one question that v0.2.0 got wrong:
 * **is the WebGL database a real file on disk, or is it sealed inside `app.asar`?**
 *
 * Why this is the guard that matters: `camoufox-js/dist/webgl/sample.js` opens
 * `dist/data-files/webgl_data.db` with **better-sqlite3, a native module**. Electron's asar shim
 * patches Node's `fs` layer, but native code calls libuv directly and never goes through it, so a
 * database inside `app.asar` cannot be opened — every profile creation died with
 * `unable to open database file` (SQLITE_CANTOPEN) in the shipped v0.2.0.
 *
 * The check is deliberately structural and needs no Electron: it is the part of the end-to-end test
 * that can be run anywhere, including on the artifact that shipped the bug.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { createInflateRaw } from 'node:zlib'

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50

/** How much of `app.asar` is inflated to read its header. Headers are a few hundred KB. */
export const ASAR_HEADER_BYTES = 4 * 1024 * 1024

/** The payload camoufox-js loads at runtime, and the database it opens through a native module. */
export const WEBGL_DATA_DIR = 'node_modules/camoufox-js/dist/data-files/'
export const WEBGL_DATABASE = `${WEBGL_DATA_DIR}webgl_data.db`

/** Where the bundled main process looks for the extraction worker. */
export const MAIN_WORKER = 'out/main/unzip-worker.js'

/** @param {Buffer} buffer @returns {number} */
function findEndOfCentralDirectory(buffer) {
  for (
    let offset = buffer.length - 22;
    offset >= 0 && offset >= buffer.length - 22 - 0xffff;
    offset--
  ) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) return offset
  }
  throw new Error('no End Of Central Directory record — not a zip file')
}

/**
 * Entry names from a zip's central directory, without extracting it.
 *
 * @param {string} zipPath
 * @returns {{ name: string, offset: number, compressedSize: number, size: number, method: number }[]}
 */
export function readZipEntries(zipPath) {
  const buffer = readFileSync(zipPath)
  const eocd = findEndOfCentralDirectory(buffer)
  const count = buffer.readUInt16LE(eocd + 10)
  let offset = buffer.readUInt32LE(eocd + 16)
  const entries = []
  for (let index = 0; index < count; index++) {
    if (buffer.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
      throw new Error(`corrupt central directory at entry ${index}`)
    }
    const nameLength = buffer.readUInt16LE(offset + 28)
    entries.push({
      name: buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8'),
      method: buffer.readUInt16LE(offset + 10),
      compressedSize: buffer.readUInt32LE(offset + 20),
      size: buffer.readUInt32LE(offset + 24),
      offset: buffer.readUInt32LE(offset + 42),
    })
    offset += 46 + nameLength + buffer.readUInt16LE(offset + 30) + buffer.readUInt16LE(offset + 32)
  }
  return entries
}

/**
 * Inflate at most `maxBytes` of a deflate stream.
 *
 * `zlib.inflateRawSync`'s `maxOutputLength` **throws** once the output would exceed the cap rather
 * than truncating, which makes it useless for reading a prefix of a 90 MB entry. So the stream is
 * pumped by hand and destroyed as soon as enough has arrived.
 *
 * @param {Buffer} raw @param {number} maxBytes @returns {Promise<Buffer>}
 */
function inflatePrefix(raw, maxBytes) {
  return new Promise((resolve, reject) => {
    const inflater = createInflateRaw()
    const chunks = []
    let total = 0
    let settled = false

    const finish = () => {
      if (settled) return
      settled = true
      resolve(Buffer.concat(chunks).subarray(0, maxBytes))
    }

    inflater.on('data', chunk => {
      if (settled) return
      chunks.push(chunk)
      total += chunk.length
      if (total >= maxBytes) {
        // Destroying mid-stream is expected here; the `settled` guard keeps the resulting
        // premature-close error from rejecting a promise we have already resolved.
        inflater.destroy()
        finish()
      }
    })
    inflater.on('end', finish)
    inflater.on('error', error => {
      if (settled) return
      settled = true
      reject(error)
    })
    inflater.end(raw)
  })
}

/**
 * Read at most `maxBytes` from one zip entry — enough for an asar header, without inflating a
 * 90 MB archive into memory.
 *
 * @param {string} zipPath @param {string} entryName @param {number} maxBytes
 * @returns {Promise<Buffer>}
 */
export async function readZipEntryPrefix(zipPath, entryName, maxBytes) {
  const entry = readZipEntries(zipPath).find(candidate => candidate.name === entryName)
  if (!entry) throw new Error(`${entryName} is not in ${zipPath}`)

  const buffer = readFileSync(zipPath)
  const localNameLength = buffer.readUInt16LE(entry.offset + 26)
  const localExtraLength = buffer.readUInt16LE(entry.offset + 28)
  const start = entry.offset + 30 + localNameLength + localExtraLength
  const raw = buffer.subarray(start, start + entry.compressedSize)

  if (entry.method === 0) return raw.subarray(0, maxBytes)
  if (entry.method !== 8) throw new Error(`unsupported zip compression method ${entry.method}`)
  return inflatePrefix(raw, maxBytes)
}

/**
 * Parse an asar header from the first bytes of the archive.
 *
 * Layout: `[u32 4][u32 headerPickleSize][headerPickle…]`, where the header pickle is
 * `[u32 payloadSize][u32 jsonLength][json…]`. So the JSON begins at file offset 16 — the header
 * pickle has to be sliced out first, which is the same two-step the release gate uses.
 *
 * @param {Buffer} prefix @returns {{ files: Record<string, any> }}
 */
export function readAsarHeader(prefix) {
  const headerPickleSize = prefix.readUInt32LE(4)
  if (headerPickleSize <= 8 || 8 + headerPickleSize > prefix.length) {
    throw new Error(
      `asar header pickle size ${headerPickleSize} does not fit in ${prefix.length} bytes read; ` +
        'increase ASAR_HEADER_BYTES',
    )
  }
  const headerPickle = prefix.subarray(8, 8 + headerPickleSize)
  const jsonLength = headerPickle.readUInt32LE(4)
  if (jsonLength <= 0 || 8 + jsonLength > headerPickle.length) {
    throw new Error(`asar JSON length ${jsonLength} is out of range`)
  }
  return JSON.parse(headerPickle.subarray(8, 8 + jsonLength).toString('utf8'))
}

/** @param {{ files: Record<string, any> }} header @returns {string[]} every path in the archive */
export function asarPaths(header) {
  const out = []
  const walk = (node, prefix) => {
    for (const [name, child] of Object.entries(node.files ?? {})) {
      const current = prefix ? `${prefix}/${name}` : name
      if (child.files) walk(child, current)
      else out.push(current)
    }
  }
  walk(header, '')
  return out
}

/**
 * Where the packaged application lives, whether it is an extracted directory or a portable zip.
 *
 * @param {string} target a directory holding `resources/`, or a portable `.zip`
 */
export async function describeArtifact(target) {
  if (target.toLowerCase().endsWith('.zip')) {
    const entries = readZipEntries(target)
    const asar = entries.find(entry => entry.name.endsWith('resources/app.asar'))
    if (!asar) throw new Error(`no resources/app.asar in ${target}`)
    return {
      kind: 'zip',
      target,
      asarPath: asar.name,
      unpackedPrefix: asar.name.replace(/app\.asar$/, 'app.asar.unpacked/'),
      asarHeader: readAsarHeader(await readZipEntryPrefix(target, asar.name, ASAR_HEADER_BYTES)),
      unpackedEntries: entries
        .filter(entry => entry.name.includes('app.asar.unpacked/'))
        .map(entry =>
          entry.name.slice(entry.name.indexOf('app.asar.unpacked/') + 'app.asar.unpacked/'.length),
        ),
      executable: entries.find(entry => /(^|\/)VFox\.exe$/.test(entry.name))?.name ?? null,
    }
  }

  const resources = path.join(target, 'resources')
  if (!statSync(resources, { throwIfNoEntry: false })) {
    throw new Error(`${target} has no resources/ directory — is it a packaged build?`)
  }
  const unpackedDir = path.join(resources, 'app.asar.unpacked')
  const unpackedEntries = []
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(path.join(dir, entry.name), relative)
      else unpackedEntries.push(relative)
    }
  }
  if (statSync(unpackedDir, { throwIfNoEntry: false })) walk(unpackedDir, '')

  return {
    kind: 'directory',
    target,
    asarPath: path.join(resources, 'app.asar'),
    unpackedPrefix: unpackedDir,
    asarHeader: readAsarHeader(
      readFileSync(path.join(resources, 'app.asar')).subarray(0, ASAR_HEADER_BYTES),
    ),
    unpackedEntries,
    executable: path.join(target, 'VFox.exe'),
  }
}

/**
 * The regression guard. Returns every problem found, so a failure names the cause rather than
 * saying "the app did not work".
 *
 * @param {ReturnType<typeof describeArtifact>} artifact
 * @returns {{ ok: boolean, detail: string, problems: string[] }}
 */
export function checkWebglDatabase(artifact) {
  const inAsar = asarPaths(artifact.asarHeader).filter(entry => entry.startsWith(WEBGL_DATA_DIR))
  const unpacked = artifact.unpackedEntries.filter(entry => entry.startsWith(WEBGL_DATA_DIR))
  const problems = []

  if (!unpacked.includes(WEBGL_DATABASE)) {
    problems.push(
      `${WEBGL_DATABASE} is not a real file under resources/app.asar.unpacked/. ` +
        (inAsar.length > 0
          ? `It is sealed inside app.asar (${inAsar.length} data-files entries found there), which a ` +
            'native module cannot open — this is exactly the v0.2.0 defect. Add ' +
            '`**/camoufox-js/dist/data-files/**` to asarUnpack in apps/desktop/electron-builder.yml.'
          : 'It is missing from the package entirely.'),
    )
  }
  if (inAsar.length > 0 && unpacked.length === 0) {
    problems.push(
      `all ${inAsar.length} camoufox-js data-files entries are inside app.asar and none are unpacked`,
    )
  }

  return {
    ok: problems.length === 0,
    detail:
      `asar holds ${inAsar.length} data-files entr${inAsar.length === 1 ? 'y' : 'ies'}, ` +
      `app.asar.unpacked holds ${unpacked.length}`,
    problems,
  }
}

/**
 * Paths that must never ship inside the packaged application.
 *
 * The two end-to-end suites are development tools; the owner was explicit that neither may enter the
 * released code. `electron-builder.yml` packs `out/**` and `package.json`, so `apps/desktop/e2e/**`
 * *should* be excluded — but "should be" is the assumption that shipped the last bug, so it is
 * asserted here instead.
 *
 * Scoping is deliberate: our own paths are matched exactly, while the generic `e2e/` directory and
 * `*.test.*` / `*.spec.*` patterns are applied only outside `node_modules`. Production dependencies
 * legitimately contain test files, and a guard that fails on those would be switched off within a
 * week — which would be worse than not having it.
 */
const FORBIDDEN_OWN_PATHS = [
  { pattern: /(^|\/)apps\/desktop\/e2e\//, why: 'the packaged end-to-end suite directory' },
  { pattern: /(^|\/)packaged-e2e\.mjs$/, why: 'the packaged end-to-end assertion suite' },
  { pattern: /(^|\/)collect-evidence\.mjs$/, why: 'the evidence collector' },
  { pattern: /e2e\/lib\/artifact\.mjs$/, why: "the suite's structural guard" },
]
const FORBIDDEN_OUTSIDE_DEPENDENCIES = [
  { pattern: /(^|\/)e2e\//, why: 'an end-to-end directory' },
  { pattern: /\.test\.[cm]?js$/, why: 'a test file' },
  { pattern: /\.spec\.[cm]?js$/, why: 'a test file' },
]

/**
 * Assert that no development tooling was packed into the release.
 *
 * @param {ReturnType<typeof describeArtifact>} artifact
 * @returns {{ ok: boolean, detail: string, problems: string[] }}
 */
/**
 * Assert the extraction worker is really inside the package.
 *
 * `packages/core` starts it with `new Worker(new URL('./unzip-worker.js', import.meta.url))`.
 * That is correct in the source tree and wrong once electron-vite has bundled the main process,
 * because `import.meta.url` becomes the bundle's own path — so the worker is looked for at
 * `out/main/unzip-worker.js`, which the bundler does not emit because the worker is not an entry
 * point. The shipped v0.3.0 failed every engine install with:
 *
 *     Cannot find module '…\resources\app.asar\out\main\unzip-worker.js'
 *
 * `apps/desktop/scripts/copy-worker.mjs` puts it there as part of the build. This asserts the
 * result rather than trusting the build step, because the build step is exactly what was missing.
 *
 * @param {ReturnType<typeof describeArtifact>} artifact
 * @returns {{ ok: boolean, detail: string, problems: string[] }}
 */
export function checkMainWorker(artifact) {
  const packaged = asarPaths(artifact.asarHeader)
  const found = packaged.some(entry => entry === MAIN_WORKER || entry.endsWith(`/${MAIN_WORKER}`))

  return {
    ok: found,
    detail: found
      ? `${MAIN_WORKER} is inside the package`
      : `${MAIN_WORKER} is missing from the package (${packaged.length} paths scanned)`,
    problems: found
      ? []
      : [
          `the engine-extraction worker \`${MAIN_WORKER}\` is not inside app.asar. Every engine ` +
            'install will fail with "Cannot find module". Check that `node scripts/copy-worker.mjs` ' +
            'runs as part of the desktop build in apps/desktop/package.json.',
        ],
  }
}

export function checkNoTestCode(artifact) {
  const packaged = [...asarPaths(artifact.asarHeader), ...artifact.unpackedEntries]
  const problems = []

  for (const entry of packaged) {
    const rules = entry.includes('node_modules/')
      ? FORBIDDEN_OWN_PATHS
      : [...FORBIDDEN_OWN_PATHS, ...FORBIDDEN_OUTSIDE_DEPENDENCIES]
    for (const { pattern, why } of rules) {
      if (!pattern.test(entry)) continue
      problems.push(
        `${entry} is ${why} and must not be inside the package. Narrow the \`files:\` glob in ` +
          'apps/desktop/electron-builder.yml so development tooling stays out of the release.',
      )
      break
    }
  }

  return {
    ok: problems.length === 0,
    detail: `${packaged.length} packaged paths scanned for test tooling`,
    problems,
  }
}
