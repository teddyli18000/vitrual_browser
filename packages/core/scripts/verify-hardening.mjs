/**
 * TEMPORARY local verification harness for the v0.1.0 hardening work.
 * Vitest cannot execute in this sandbox (piped stdio is denied), so the new code paths are exercised
 * against compiled `dist` with Node's own runner. Deleted after the run.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { FingerprintSchema, ProfileSchema } from '@vfox/shared'
import { createIdentity, identityInputs, identityIsCurrent } from '../dist/identity.js'
import { createCore } from '../dist/index.js'
import { KernelManager } from '../dist/kernel.js'
import { toServerOptions } from '../dist/launcher.js'
import { combineLoggers, createFileLogger, logFilePath } from '../dist/log.js'
import { reconcileOrphans } from '../dist/orphans.js'
import { Store } from '../dist/store.js'

let passed = 0
let failed = 0
const failures = []

async function test(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failed += 1
    failures.push(`${name}: ${error.message}`)
    console.log(`  FAIL ${name}\n       ${error.message}`)
  }
}

const group = name => console.log(`\n${name}`)
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vfox-verify2-'))
const noop = { debug() {}, info() {}, warn() {}, error() {} }
const logger = () => ({ debug() {}, info() {}, warn() {}, error() {} })

/* -------------------------------------------------------------------------- identity */

group('identity')
await test('generates a Firefox fingerprint with the engine version recorded', async () => {
  const { identity, config } = await createIdentity(FingerprintSchema.parse({ os: 'macos' }), '152.0.4')
  assert.equal(identity.version, 1)
  assert.equal(identity.engine, '152.0.4')
  assert.match(identity.fingerprint.navigator.userAgent, /Firefox/)
  assert.deepEqual(Object.keys(config).sort(), [
    'audio:seed',
    'canvas:aaCapOffset',
    'canvas:aaOffset',
    'canvas:seed',
    'fonts:spacing_seed',
    'window.history.length',
    'window.screenY',
  ])
})
await test('honours screen constraints and never overwrites user config', async () => {
  const { identity } = await createIdentity(
    FingerprintSchema.parse({
      os: 'windows',
      screen: { minWidth: 1920, maxWidth: 1920, minHeight: 1080, maxHeight: 1080 },
      window: { width: 1280, height: 720 },
    }),
    null,
  )
  assert.equal(identity.fingerprint.screen.width, 1920)
  assert.equal(identity.fingerprint.screen.height, 1080)

  // Pinning must be per key: one user-set seed must not stop the others from being pinned.
  const { config } = await createIdentity(FingerprintSchema.parse({ config: { 'canvas:seed': 7 } }), null)
  assert.equal(config['canvas:seed'], undefined)
  assert.equal(typeof config['audio:seed'], 'number')
  assert.equal(typeof config['fonts:spacing_seed'], 'number')
  assert.equal(config['canvas:aaCapOffset'], true)
})
await test('pins a WebGL pair (the engine samples one at random otherwise)', async () => {
  const { webgl } = await createIdentity(FingerprintSchema.parse({ os: 'windows' }), null)
  assert.equal(typeof webgl.vendor, 'string')
  assert.equal(typeof webgl.renderer, 'string')

  const chosen = { vendor: 'Google Inc.', renderer: 'Custom' }
  const kept = await createIdentity(FingerprintSchema.parse({ webgl: chosen }), null)
  assert.deepEqual(kept.webgl, chosen)
})
await test('identity inputs only track os/screen/window', () => {
  const base = FingerprintSchema.parse({})
  assert.notEqual(identityInputs(FingerprintSchema.parse({ os: 'macos' })), identityInputs(base))
  assert.equal(identityInputs(FingerprintSchema.parse({ humanize: true })), identityInputs(base))
  assert.equal(
    identityInputs(FingerprintSchema.parse({ config: { 'navigator.maxTouchPoints': 5 } })),
    identityInputs(base),
  )
})
await test('identityIsCurrent handles missing/stale/unknown engine versions', () => {
  const identity = { version: 1, engine: '152.0.4', generatedAt: 'x', fingerprint: {} }
  const make = overrides =>
    ProfileSchema.parse({
      id: 'p', name: 'p', fingerprint: {}, launch: {},
      createdAt: 'x', updatedAt: 'x', ...overrides,
    })
  assert.equal(identityIsCurrent(make({}), '152.0.4'), false)
  assert.equal(identityIsCurrent(make({ identity }), '152.0.4'), true)
  assert.equal(identityIsCurrent(make({ identity }), '153.0.1'), false)
  assert.equal(identityIsCurrent(make({ identity }), null), true)
  assert.equal(identityIsCurrent(make({ identity: { ...identity, engine: null } }), '152.0.4'), true)
})

/* --------------------------------------------------------- identity re-injection (engine) */

group('identity re-injection (real camoufox-js option mapping)')
const kernelInfo = await new KernelManager({ logger: noop }).info()
if (!kernelInfo.installed) {
  console.log('  skipped: engine not installed')
} else {
  const camouConfig = options => {
    const joined = Object.entries(options.env)
      .filter(([key]) => key.startsWith('CAMOU_CONFIG_'))
      .map(([key, value]) => [Number(key.split('_').pop()), value])
      .sort((a, b) => a[0] - b[0])
      .map(([, value]) => value)
      .join('')
    return JSON.parse(joined)
  }

  await test('the same stored identity yields byte-identical CAMOU_CONFIG', async () => {
    const generated = await createIdentity(FingerprintSchema.parse({ os: 'windows', geoip: false }), 'test')
    const profile = ProfileSchema.parse({
      id: 'stable', name: 'Stable',
      fingerprint: { geoip: false, config: generated.config, webgl: generated.webgl },
      identity: generated.identity, launch: {}, createdAt: 'x', updatedAt: 'x',
    })
    const first = camouConfig(await toServerOptions(profile, 'C:\\p\\userdata', () => {}))
    const second = camouConfig(await toServerOptions(profile, 'C:\\p\\userdata', () => {}))
    assert.equal(JSON.stringify(second), JSON.stringify(first))
    // The UA comes from the stored identity; its version is rewritten to the installed engine's
    // major version by `fromBrowserforge(fingerprint, ffVersion)`, deterministically.
    assert.match(first['navigator.userAgent'], /Firefox\/\d+\.0/)
    assert.equal(
      (first['navigator.userAgent'] ?? '').split('rv:')[1],
      (generated.identity.fingerprint.navigator.userAgent ?? '').split('rv:')[1],
    )
    assert.equal(first['canvas:seed'], generated.config['canvas:seed'])
    assert.equal(first['audio:seed'], generated.config['audio:seed'])
    assert.equal(first['window.history.length'], generated.config['window.history.length'])
    assert.equal(first['window.screenY'], generated.config['window.screenY'])
    assert.equal(first['webGl:vendor'], generated.webgl.vendor)
    assert.equal(first['webGl:renderer'], generated.webgl.renderer)
  })

  await test('without an identity the engine rolls a different device (the bug this prevents)', async () => {
    const base = ProfileSchema.parse({
      id: 'unstable', name: 'Unstable', fingerprint: { geoip: false }, identity: null,
      launch: {}, createdAt: 'x', updatedAt: 'x',
    })
    const first = JSON.stringify(camouConfig(await toServerOptions(base, 'C:\\p\\userdata', () => {})))
    const second = JSON.stringify(camouConfig(await toServerOptions(base, 'C:\\p\\userdata', () => {})))
    assert.notEqual(second, first)
  })
}

/* ----------------------------------------------------------------------------- store */

group('store integrity')
await test('keeps the previous generation as .bak', async () => {
  const dir = path.join(tmp, 'bak')
  const store = new Store(dir, logger())
  await store.load()
  await store.createProfile({ name: 'First' })
  await assert.rejects(fs.access(`${store.profilesFile}.bak`))
  await store.createProfile({ name: 'Second' })
  const backup = JSON.parse(await fs.readFile(`${store.profilesFile}.bak`, 'utf8'))
  assert.deepEqual(backup.map(p => p.name), ['First'])
})
await test('quarantines a corrupt file, restores .bak and reports it loudly', async () => {
  const dir = path.join(tmp, 'recover')
  const store = new Store(dir, logger())
  await store.load()
  await store.createProfile({ name: 'Acme' })
  await store.createProfile({ name: 'Second' })
  await fs.writeFile(store.profilesFile, '[{"id":"Acme","na')

  const errors = []
  const log = { debug() {}, info() {}, warn() {}, error: m => errors.push(m) }
  const reopened = new Store(dir, log)
  await reopened.load()
  assert.deepEqual(reopened.listProfiles().map(p => p.name), ['Acme'])
  assert.equal(errors.length, 1)
  assert.match(errors[0], /restored from/)
  const quarantined = (await fs.readdir(dir)).filter(n => n.startsWith('profiles.corrupt-'))
  assert.equal(quarantined.length, 1)
  assert.equal(await fs.readFile(path.join(dir, quarantined[0]), 'utf8'), '[{"id":"Acme","na')
})
await test('fails loudly and leaves the file when no backup is usable', async () => {
  const dir = path.join(tmp, 'unrecoverable')
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'profiles.json'), 'not json')
  await assert.rejects(new Store(dir, logger()).load(), /no backup is available/)
  assert.equal(await fs.readFile(path.join(dir, 'profiles.json'), 'utf8'), 'not json')
  assert.equal((await fs.readdir(dir)).filter(n => n.includes('corrupt')).length, 0)

  await fs.writeFile(path.join(dir, 'profiles.json.bak'), 'also broken')
  await assert.rejects(new Store(dir, logger()).load(), /is invalid too/)
})
await test('applyIdentity stores, clears and merges config', async () => {
  const dir = path.join(tmp, 'identity-store')
  const store = new Store(dir, logger())
  await store.load()
  const created = await store.createProfile({ name: 'Acme' })
  assert.equal(created.identity, null)
  const identity = { version: 1, engine: '152.0.4', generatedAt: 'x', fingerprint: {} }
  const withIdentity = await store.applyIdentity(created.id, identity, {
    config: { 'canvas:seed': 42 },
    webgl: { vendor: 'Google Inc.', renderer: 'ANGLE' },
  })
  assert.deepEqual(withIdentity.identity, identity)
  assert.deepEqual(withIdentity.fingerprint.config, { 'canvas:seed': 42 })
  assert.deepEqual(withIdentity.fingerprint.webgl, { vendor: 'Google Inc.', renderer: 'ANGLE' })
  const cleared = await store.applyIdentity(created.id, null)
  assert.equal(cleared.identity, null)
  assert.deepEqual(cleared.fingerprint.config, { 'canvas:seed': 42 })
  assert.deepEqual(cleared.fingerprint.webgl, { vendor: 'Google Inc.', renderer: 'ANGLE' })
})

/* --------------------------------------------------------------------------- orphans */

group('orphan reconciliation')
const makeProfileDir = async (dir, id, withLock) => {
  const profileDir = path.join(dir, 'profiles', id)
  await fs.mkdir(path.join(profileDir, 'userdata'), { recursive: true })
  if (withLock) await fs.writeFile(path.join(profileDir, 'parent.lock'), '')
  return profileDir
}
await test('does nothing when no profile holds a lock', async () => {
  const dir = path.join(tmp, 'orphan-idle')
  await makeProfileDir(dir, 'a', false)
  let called = 0
  const result = await reconcileOrphans({
    dataDir: dir, logger: logger(), listProcesses: async () => { called += 1; return [] },
  })
  assert.deepEqual(result, { killed: [], locksRemoved: [], checked: false })
  assert.equal(called, 0)
})
await test('kills orphans and removes their stale locks', async () => {
  const dir = path.join(tmp, 'orphan-kill')
  await makeProfileDir(dir, 'a', true)
  await makeProfileDir(dir, 'b', true)
  const processes = ['a', 'b'].map((id, index) => ({
    pid: 100 + index,
    commandLine: `camoufox.exe -profile ${path.join(dir, 'profiles', id, 'userdata')}`,
  }))
  const killed = []
  let call = 0
  const result = await reconcileOrphans({
    dataDir: dir, logger: logger(),
    listProcesses: async () => (call++ === 0 ? processes : []),
    killTree: pid => killed.push(pid),
  })
  assert.deepEqual(result.killed, [100, 101])
  assert.deepEqual(killed, [100, 101])
  assert.equal(result.locksRemoved.length, 2)
  await assert.rejects(fs.access(path.join(dir, 'profiles', 'a', 'parent.lock')))
})
await test('keeps a lock owned by a live process, and never removes a lock when blind', async () => {
  const dir = path.join(tmp, 'orphan-live')
  await makeProfileDir(dir, 'a', true)
  const owner = { pid: 5, commandLine: `camoufox.exe -profile ${path.join(dir, 'profiles', 'a', 'userdata')}` }
  const live = await reconcileOrphans({
    dataDir: dir, logger: logger(), listProcesses: async () => [owner], killTree: () => {},
  })
  assert.deepEqual(live.locksRemoved, [])
  assert.equal(await fs.readFile(path.join(dir, 'profiles', 'a', 'parent.lock'), 'utf8'), '')

  const blind = await reconcileOrphans({ dataDir: dir, logger: logger(), listProcesses: async () => null })
  assert.equal(blind.checked, true)
  assert.deepEqual(blind.locksRemoved, [])
  assert.equal(await fs.readFile(path.join(dir, 'profiles', 'a', 'parent.lock'), 'utf8'), '')
})
await test('never touches profile data', async () => {
  const dir = path.join(tmp, 'orphan-data')
  const profileDir = await makeProfileDir(dir, 'a', true)
  await fs.writeFile(path.join(profileDir, 'userdata', 'cookies.sqlite'), 'data')
  await reconcileOrphans({ dataDir: dir, logger: logger(), listProcesses: async () => [] })
  assert.equal(await fs.readFile(path.join(profileDir, 'userdata', 'cookies.sqlite'), 'utf8'), 'data')
})

/* ------------------------------------------------------------------------------- log */

group('rotating log')
await test('writes levels, messages and args to <dataDir>/logs/vfox.log', async () => {
  const dir = path.join(tmp, 'log')
  const log = createFileLogger(dir)
  log.info('profile created', { id: 'p1' })
  log.error('launch failed', new Error('spawn EPERM'))
  await new Promise(r => setTimeout(r, 30))
  const contents = await fs.readFile(logFilePath(dir), 'utf8')
  assert.match(contents, /INFO {2}profile created \{"id":"p1"\}/)
  assert.match(contents, /ERROR launch failed Error: spawn EPERM/)
})
await test('rotates at the size limit and keeps a bounded number of files', async () => {
  const dir = path.join(tmp, 'log-rotate')
  const log = createFileLogger(dir, { maxBytes: 200, maxFiles: 3 })
  for (let i = 0; i < 40; i += 1) log.info(`line ${i} ${'x'.repeat(60)}`)
  const deadline = Date.now() + 5000
  let current = ''
  while (Date.now() < deadline) {
    current = await fs.readFile(logFilePath(dir), 'utf8').catch(() => '')
    if (current.includes('line 39')) break
    await new Promise(r => setTimeout(r, 10))
  }
  const files = (await fs.readdir(path.join(dir, 'logs'))).sort()
  assert.deepEqual(files, ['vfox.1.log', 'vfox.2.log', 'vfox.log'])
  assert.match(current, /line 39/)
})
await test('never throws when the log cannot be written, and combineLoggers fans out', async () => {
  const dir = path.join(tmp, 'log-broken')
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'logs'), 'not a directory')
  const log = createFileLogger(dir)
  assert.doesNotThrow(() => log.error('still fine'))
  await new Promise(r => setTimeout(r, 20))

  const seen = []
  const combined = combineLoggers({ debug() {}, info() {}, warn: m => seen.push(m), error() {} }, undefined)
  combined.warn('careful', 1)
  assert.deepEqual(seen, ['careful'])
})

/* ------------------------------------------------------------------------------ core */

group('createCore wiring')
await test('creates a profile with a generated identity and re-rolls it on an os change', async () => {
  const dir = path.join(tmp, 'core')
  const core = await createCore({ dataDir: dir })
  const profile = await core.profiles.create({ name: 'Acme', fingerprint: { os: 'windows' } })
  assert.ok(profile.identity, 'identity must be generated at creation')
  assert.equal(profile.identity.version, 1)
  assert.match(profile.identity.fingerprint.navigator.userAgent, /Firefox/)
  assert.equal(typeof profile.fingerprint.config['canvas:seed'], 'number')

  // A non-identity edit keeps the device.
  const renamed = await core.profiles.update(profile.id, { name: 'Acme 2' })
  assert.deepEqual(renamed.identity, profile.identity)

  // Changing an identity input drops it, so it is re-rolled exactly once on the next launch.
  const reOs = await core.profiles.update(profile.id, { fingerprint: { os: 'macos' } })
  assert.equal(reOs.identity, null)
  await core.close()
})
await test('starts up with a leftover parent.lock and runs reconciliation', async () => {
  const dir = path.join(tmp, 'core-orphan')
  await makeProfileDir(dir, 'dead', true)
  const core = await createCore({ dataDir: dir })
  await core.close()
  // Log writes are queued, so wait for the record instead of guessing a delay.
  const deadline = Date.now() + 5000
  let log = ''
  while (Date.now() < deadline) {
    log = await fs.readFile(logFilePath(path.resolve(dir)), 'utf8').catch(() => '')
    if (/orphan reconciliation|could not enumerate/.test(log)) break
    await new Promise(r => setTimeout(r, 10))
  }
  // Process enumeration needs piped stdio, which this sandbox denies, so the safe path is taken:
  // the lock is kept and the skip is logged. Either way reconciliation must have run and reported.
  assert.match(log, /orphan reconciliation|could not enumerate/)
})
await test('writes diagnostics to the rotating log', async () => {
  const dir = path.join(tmp, 'core-log')
  const core = await createCore({ dataDir: dir })
  await core.profiles.create({ name: 'Logged' })
  await core.close()
  const contents = await fs.readFile(logFilePath(path.resolve(dir)), 'utf8')
  assert.match(contents, /created with a generated device identity/)
})

await fs.rm(tmp, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) {
  console.log(failures.join('\n'))
  process.exit(1)
}
