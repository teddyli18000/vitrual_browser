import path from 'node:path'
import { type Profile, type ProfileRuntime, ProfileSchema } from '@vfox/shared'
import { describe, expect, it, vi } from 'vitest'
import type { KernelResolution } from '../src/kernels.js'
import type { BrowserExit, BrowserHandle, BrowserLauncher } from '../src/launcher.js'
import { RuntimeRegistry } from '../src/runtime.js'

class FakeBrowser implements BrowserHandle {
  readonly pid = 4242
  readonly wsEndpoint = 'ws://127.0.0.1:9999/vfox'
  closes = 0
  #exitListener: ((exit: BrowserExit) => void) | null = null

  async close(): Promise<void> {
    this.closes += 1
    // The real engine's process dies when it is closed; the registry must not treat that as a crash.
    this.#exitListener?.({ exitCode: 0, signal: null })
  }

  onExit(listener: (exit: BrowserExit) => void): void {
    this.#exitListener = listener
  }

  /** Simulate the browser dying on its own. */
  die(exit: BrowserExit): void {
    this.#exitListener?.(exit)
  }
}

function profile(id: string, name = id): Profile {
  return ProfileSchema.parse({
    id,
    name,
    fingerprint: {},
    launch: {},
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
  })
}

function logger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

function setup(
  launch: BrowserLauncher,
  profiles = [profile('p1'), profile('p2')],
  resolveKernel: (item: Profile) => Promise<KernelResolution> = async () => ({
    ok: true,
    version: '152.0.4-beta.30',
    dir: path.join('engines', 'kernels', '152.0.4-beta.30'),
    source: 'default',
    warning: null,
  }),
) {
  const log = logger()
  const registry = new RuntimeRegistry({
    launch,
    resolveProfile: async id => profiles.find(item => item.id === id),
    resolveKernel,
    userDataDir: id => path.join('data', 'profiles', id, 'userdata'),
    profileIds: async () => profiles.map(item => item.id),
    logger: log,
  })
  return { registry, log }
}

describe('launch', () => {
  it('walks stopped -> starting -> running and captures pid, wsEndpoint and startedAt', async () => {
    const browser = new FakeBrowser()
    const { registry } = setup(async () => browser)
    const seen: ProfileRuntime[] = []
    registry.on('change', runtime => seen.push(runtime))

    expect(registry.get('p1').status).toBe('stopped')
    const runtime = await registry.launch('p1')

    expect(seen.map(item => item.status)).toEqual(['starting', 'running'])
    expect(runtime.status).toBe('running')
    expect(runtime.pid).toBe(4242)
    expect(runtime.wsEndpoint).toBe('ws://127.0.0.1:9999/vfox')
    expect(runtime.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(runtime.lastError).toBeNull()
    expect(registry.get('p1')).toEqual(runtime)
  })

  it('passes the profile and its own userdata directory to the launcher', async () => {
    const launch = vi.fn<BrowserLauncher>(async () => new FakeBrowser())
    const { registry } = setup(launch)

    await registry.launch('p2')

    expect(launch).toHaveBeenCalledOnce()
    const context = launch.mock.calls[0]?.[0]
    expect(context?.profile.id).toBe('p2')
    expect(context?.userDataDir).toBe(path.join('data', 'profiles', 'p2', 'userdata'))
  })

  it('is idempotent while starting or running', async () => {
    const launch = vi.fn<BrowserLauncher>(async () => new FakeBrowser())
    const { registry } = setup(launch)

    const [first, second] = await Promise.all([registry.launch('p1'), registry.launch('p1')])

    expect(launch).toHaveBeenCalledOnce()
    expect(second).toEqual(first)
  })

  it('settles to error and rethrows when the engine cannot start', async () => {
    const { registry, log } = setup(async () => {
      throw new Error('spawn EPERM')
    })
    const seen: ProfileRuntime[] = []
    registry.on('change', runtime => seen.push(runtime))

    await expect(registry.launch('p1')).rejects.toThrow('spawn EPERM')

    expect(seen.map(item => item.status)).toEqual(['starting', 'error'])
    expect(registry.get('p1').status).toBe('error')
    expect(registry.get('p1').lastError).toBe('spawn EPERM')
    expect(log.warn).not.toHaveBeenCalled()
  })

  it('rejects an unknown profile', async () => {
    const { registry } = setup(async () => new FakeBrowser())
    await expect(registry.launch('ghost')).rejects.toThrow('Unknown profile: ghost')
  })
})

describe('stop', () => {
  it('walks running -> stopping -> stopped and closes the browser', async () => {
    const browser = new FakeBrowser()
    const { registry } = setup(async () => browser)
    await registry.launch('p1')

    const seen: ProfileRuntime[] = []
    registry.on('change', runtime => seen.push(runtime))
    const runtime = await registry.stop('p1')

    expect(seen.map(item => item.status)).toEqual(['stopping', 'stopped'])
    expect(runtime.status).toBe('stopped')
    expect(runtime.pid).toBeNull()
    expect(runtime.wsEndpoint).toBeNull()
    expect(runtime.startedAt).toBeNull()
    expect(browser.closes).toBe(1)
  })

  it('is a no-op for a profile that is not running', async () => {
    const browser = new FakeBrowser()
    const { registry } = setup(async () => browser)

    const runtime = await registry.stop('p1')

    expect(runtime.status).toBe('stopped')
    expect(browser.closes).toBe(0)
  })

  it('stops a profile that is still starting and closes the late handle', async () => {
    const browser = new FakeBrowser()
    let release = () => {}
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const { registry } = setup(async () => {
      await gate
      return browser
    })

    const launching = registry.launch('p1')
    await Promise.resolve()
    expect(registry.get('p1').status).toBe('starting')

    const stopping = registry.stop('p1')
    release()

    expect((await stopping).status).toBe('stopped')
    expect((await launching).status).toBe('stopped')
    expect(browser.closes).toBe(1)
    expect(registry.get('p1').status).toBe('stopped')
  })
})

describe('unexpected exit', () => {
  it('settles to error with the exit code', async () => {
    const browser = new FakeBrowser()
    const { registry } = setup(async () => browser)
    await registry.launch('p1')

    const seen: ProfileRuntime[] = []
    registry.on('change', runtime => seen.push(runtime))
    browser.die({ exitCode: 3221225477, signal: null })

    expect(seen).toHaveLength(1)
    expect(registry.get('p1').status).toBe('error')
    expect(registry.get('p1').lastError).toContain('3221225477')
    expect(registry.get('p1').pid).toBeNull()
  })

  it('settles to stopped on a clean exit', async () => {
    const browser = new FakeBrowser()
    const { registry } = setup(async () => browser)
    await registry.launch('p1')

    browser.die({ exitCode: 0, signal: null })

    expect(registry.get('p1').status).toBe('stopped')
    expect(registry.get('p1').lastError).toBeNull()
  })
})

describe('registry', () => {
  it('lists one runtime per known profile and defaults unknown ids to stopped', async () => {
    const { registry } = setup(async () => new FakeBrowser())
    await registry.launch('p1')

    expect((await registry.list()).map(item => [item.profileId, item.status])).toEqual([
      ['p1', 'running'],
      ['p2', 'stopped'],
    ])
    expect(registry.get('never-seen').status).toBe('stopped')
  })

  it('stops delivering changes after unsubscribe', async () => {
    const browser = new FakeBrowser()
    const { registry } = setup(async () => browser)
    const listener = vi.fn()
    const off = registry.on('change', listener)

    await registry.launch('p1')
    const calls = listener.mock.calls.length
    off()
    await registry.stop('p1')

    expect(calls).toBeGreaterThan(0)
    expect(listener).toHaveBeenCalledTimes(calls)
  })

  it('keeps working when a listener throws', async () => {
    const browser = new FakeBrowser()
    const { registry, log } = setup(async () => browser)
    registry.on('change', () => {
      throw new Error('sse client exploded')
    })

    await registry.launch('p1')

    expect(registry.get('p1').status).toBe('running')
    expect(log.warn).toHaveBeenCalled()
  })

  it('does not change state on its own: there are no polling timers', async () => {
    vi.useFakeTimers()
    try {
      const browser = new FakeBrowser()
      const { registry } = setup(async () => browser)
      await registry.launch('p1')

      const listener = vi.fn()
      registry.on('change', listener)
      await vi.advanceTimersByTimeAsync(120_000)

      expect(listener).not.toHaveBeenCalled()
      expect(registry.get('p1').status).toBe('running')
    } finally {
      vi.useRealTimers()
    }
  })

  it('closeAll stops everything that is running and forgets removed profiles', async () => {
    const browsers = new Map<string, FakeBrowser>()
    const { registry } = setup(async context => {
      const browser = new FakeBrowser()
      browsers.set(context.profile.id, browser)
      return browser
    })

    await registry.launch('p1')
    await registry.launch('p2')
    await registry.closeAll()

    expect([...browsers.values()].map(browser => browser.closes)).toEqual([1, 1])
    expect((await registry.list()).map(item => item.status)).toEqual(['stopped', 'stopped'])
  })
})
