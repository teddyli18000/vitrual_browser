/**
 * Guard test for the undocumented playwright-core hooks the launcher depends on.
 *
 * `_userDataDir` and `_sharedBrowser` are private API. If a future `playwright-core` renames or
 * drops them, every profile would silently fall back to a throwaway temp directory and the
 * `wsEndpoint` would disappear — a silent, product-breaking degradation. This test turns that into
 * a loud CI failure.
 *
 * It also re-checks the invariants that were established by measurement rather than by reading
 * docs: the socks5 proxy correction and the no-default-viewport fix.
 */

import fs from 'node:fs'
import path from 'node:path'
import { FingerprintSchema, ProfileSchema } from '@vfox/shared'
import { describe, expect, it } from 'vitest'
import { createIdentity } from '../src/identity.js'
import { KernelManager } from '../src/kernel.js'
import { toServerOptions } from '../src/launcher.js'

const packageRoot = path.resolve(import.meta.dirname, '..')
const repoRoot = path.resolve(packageRoot, '..', '..')
const coreBundle = path.join(repoRoot, 'node_modules/playwright-core/lib/coreBundle.js')
const camoufoxUtils = path.join(repoRoot, 'node_modules/camoufox-js/dist/utils.js')

const noopLogger = { debug() {}, info() {}, warn() {}, error() {} }

describe('playwright-core private hooks', () => {
  it('pins playwright-core to the exact verified version', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>
    }
    const installed = JSON.parse(
      fs.readFileSync(path.join(repoRoot, 'node_modules/playwright-core/package.json'), 'utf8'),
    ) as { version: string }

    // No range: the hooks below were verified against exactly this version.
    expect(pkg.dependencies['playwright-core']).toBe('1.60.0')
    expect(installed.version).toBe('1.60.0')
  })

  it('still routes launchServer through launchPersistentContext for _userDataDir', () => {
    const source = fs.readFileSync(coreBundle, 'utf8')

    expect(source).toContain('if (options2._userDataDir !== void 0)')
    expect(source).toContain(
      'launchPersistentContext(progress2, options2._userDataDir, launchOptions)',
    )
    expect(source).toContain('return context2._browser')
  })

  it('still exposes process(), wsEndpoint() and the shared-browser switch', () => {
    const source = fs.readFileSync(coreBundle, 'utf8')

    expect(source).toContain('browserServer.process = () => browser.options.browserProcess.process')
    expect(source).toContain('browserServer.wsEndpoint = () => wsEndpoint')
    expect(source).toContain('options2._sharedBrowser ? "launchServerShared" : "launchServer"')
    expect(source).toContain('browserServer.emit("close", exitCode, signal)')
  })

  it('still accepts noDefaultViewport and still rejects a null viewport', () => {
    const source = fs.readFileSync(coreBundle, 'utf8')

    // The persistent-context scheme: viewport is a non-nullable object, noDefaultViewport is the
    // documented flag that suppresses Playwright's 1280x720 default.
    expect(source).toContain('noDefaultViewport: tOptional(tBoolean)')
    expect(source).toContain('if (!options2.viewport && !options2.noDefaultViewport)')
    expect(source).toContain('options2.viewport = { width: 1280, height: 720 }')
  })

  it('still accepts every camoufox-js option name the launcher passes', () => {
    const source = fs.readFileSync(camoufoxUtils, 'utf8')
    for (const option of [
      'config',
      'os',
      'block_images',
      'block_webrtc',
      'block_webgl',
      'disable_coop',
      'webgl_config',
      'geoip',
      'humanize',
      'locale',
      'fonts',
      'screen',
      'window',
      'headless',
      'proxy',
    ]) {
      expect(source, `camoufox-js no longer accepts \`${option}\``).toContain(option)
    }
    expect(source).toContain('export async function launchOptions(')
  })
})

describe('assembled server options', () => {
  it('keeps a socks5 proxy intact, disables the default viewport and sets both hooks', async ctx => {
    const kernel = new KernelManager({ logger: noopLogger })
    if (!(await kernel.info()).installed) {
      ctx.skip()
      return
    }

    const profile = ProfileSchema.parse({
      id: 'guard',
      name: 'Guard',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      proxy: { type: 'socks5', host: '127.0.0.1', port: 1080, username: 'u', password: 'p' },
      // No network in unit tests: geoip would look the egress IP up through the proxy.
      fingerprint: { geoip: false, hardwareConcurrency: 8 },
    })

    const options = await toServerOptions(profile, 'C:\\profiles\\guard\\userdata', () => {})

    // Measured upstream bug: camoufox-js turns this into the literal string "null".
    expect(options.proxy).toEqual({
      server: 'socks5://127.0.0.1:1080',
      username: 'u',
      password: 'p',
    })
    expect(options.noDefaultViewport).toBe(true)
    expect(options.viewport).toBeUndefined()
    expect(options._userDataDir).toBe('C:\\profiles\\guard\\userdata')
    expect(options._sharedBrowser).toBe(true)
    expect(options.headless).toBe(false)
    // The fingerprint has to reach the engine as chunked CAMOU_CONFIG env vars.
    const env = options.env as Record<string, string>
    expect(env.CAMOU_CONFIG_1).toContain('navigator.hardwareConcurrency')
    expect(options.firefoxUserPrefs).toBeTypeOf('object')
  })

  /**
   * The product's central promise: a profile is the SAME device every time it is opened. This is
   * the strongest assertion available without a browser — the engine is handed the stored identity
   * and must turn it into the same CAMOU_CONFIG bytes on every launch.
   */
  it('re-injects the stored identity byte-for-byte on every launch', async ctx => {
    const kernel = new KernelManager({ logger: noopLogger })
    if (!(await kernel.info()).installed) {
      ctx.skip()
      return
    }

    const generated = await createIdentity(
      FingerprintSchema.parse({ os: 'windows', geoip: false }),
      'test',
    )
    const profile = ProfileSchema.parse({
      id: 'stable',
      name: 'Stable',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      fingerprint: { geoip: false, config: generated.config },
      identity: generated.identity,
    })

    const first = camouConfig(
      await toServerOptions(profile, 'C:\\profiles\\stable\\userdata', () => {}),
    )
    const second = camouConfig(
      await toServerOptions(profile, 'C:\\profiles\\stable\\userdata', () => {}),
    )

    // Identical bytes, not merely equivalent values: this is what the engine actually reads.
    expect(JSON.stringify(second)).toBe(JSON.stringify(first))
    // And it is the identity we stored — with its version numbers rewritten to the installed
    // engine's by `fromBrowserforge(fingerprint, ffVersion)`, deterministically.
    const storedUa = (generated.identity.fingerprint.navigator as { userAgent: string }).userAgent
    const shape = (ua: string) => ua.replace(/\d+/g, '#')
    expect(String(first['navigator.userAgent'])).toMatch(/Firefox\/\d+\.0/)
    expect(shape(String(first['navigator.userAgent']))).toBe(shape(storedUa))
    // The per-launch keys are pinned, so the canvas, audio and window position cannot drift either.
    expect(first['canvas:seed']).toBe(generated.config['canvas:seed'])
    expect(first['audio:seed']).toBe(generated.config['audio:seed'])
    expect(first['window.history.length']).toBe(generated.config['window.history.length'])
    expect(first['window.screenY']).toBe(generated.config['window.screenY'])
    expect(first['webGl:vendor']).toBe(generated.webgl?.vendor)
    expect(first['webGl:renderer']).toBe(generated.webgl?.renderer)
  })

  it('would notice a device that changes between launches', async ctx => {
    const kernel = new KernelManager({ logger: noopLogger })
    if (!(await kernel.info()).installed) {
      ctx.skip()
      return
    }

    const base = ProfileSchema.parse({
      id: 'unstable',
      name: 'Unstable',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      fingerprint: { geoip: false },
      identity: null,
    })

    // Without a stored identity the engine rolls a new device, which is exactly the bug this
    // feature exists to prevent — so the two configs must not be identical.
    const first = JSON.stringify(
      camouConfig(await toServerOptions(base, 'C:\\profiles\\unstable\\userdata', () => {})),
    )
    const second = JSON.stringify(
      camouConfig(await toServerOptions(base, 'C:\\profiles\\unstable\\userdata', () => {})),
    )

    expect(second).not.toBe(first)
  })
})

/** Reassemble camoufox-js's chunked CAMOU_CONFIG_<n> environment variables. */
function camouConfig(options: Record<string, unknown>): Record<string, unknown> {
  const env = options.env as Record<string, string>
  const joined = Object.entries(env)
    .filter(([key]) => key.startsWith('CAMOU_CONFIG_'))
    .map(([key, value]) => [Number(key.split('_').pop()), value] as const)
    .sort((a, b) => a[0] - b[0])
    .map(([, value]) => value)
    .join('')
  return JSON.parse(joined) as Record<string, unknown>
}
