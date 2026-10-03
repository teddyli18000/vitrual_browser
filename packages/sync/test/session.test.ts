import type { SyncSession } from '@vfox/shared'
import { describe, expect, it, vi } from 'vitest'
import { SyncError } from '../src/errors.js'
import { SYNC_LISTENER_SOURCE, SYNC_TEARDOWN_SOURCE } from '../src/mirror.js'
import { createSyncWith } from '../src/session.js'
import {
  type FakeProfile,
  FakeWorld,
  keyPayload,
  mousePayload,
  type TestLogger,
  testLogger,
  waitFor,
} from './helpers/fake-browser.js'
import { FakeTileBackend } from './helpers/fake-tile.js'

interface Harness {
  world: FakeWorld
  master: FakeProfile
  slaveA: FakeProfile
  slaveB: FakeProfile
  logger: TestLogger
  tile: FakeTileBackend
  sync: ReturnType<typeof createSyncWith>
}

function harness(): Harness {
  const world = new FakeWorld()
  const master = world.add('master', { pid: 1111 })
  const slaveA = world.add('slave-a', { pid: 2222 })
  const slaveB = world.add('slave-b', { pid: 3333 })
  const logger = testLogger()
  const tile = new FakeTileBackend()
  const sync = createSyncWith(
    { resolve: world.resolve, logger: logger.logger },
    {
      connect: world.connect,
      tile,
      newId: () => 'session-1',
      now: () => Date.parse('2024-05-01T12:00:00.000Z'),
    },
  )
  return { world, master, slaveA, slaveB, logger, tile, sync }
}

const startInput = {
  masterProfileId: 'master',
  slaveProfileIds: ['slave-a', 'slave-b'],
}

async function expectSyncError(
  promise: Promise<unknown>,
  code: string,
  messagePart: string,
): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(SyncError)
  try {
    await promise
    throw new Error('expected the promise to reject')
  } catch (error) {
    const failure = error as SyncError
    expect(failure.code).toBe(code)
    expect(failure.message).toContain(messagePart)
  }
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

describe('start validation', () => {
  it('rejects an unknown master profile by name', async () => {
    const { sync } = harness()
    await expectSyncError(
      sync.start({ masterProfileId: 'ghost', slaveProfileIds: ['slave-a'] }),
      'unknown_profile',
      'unknown profile "ghost"',
    )
  })

  it('rejects an unknown slave profile by name', async () => {
    const { sync } = harness()
    await expectSyncError(
      sync.start({ masterProfileId: 'master', slaveProfileIds: ['slave-a', 'ghost'] }),
      'unknown_profile',
      'unknown profile "ghost"',
    )
  })

  it('rejects a master that is not running', async () => {
    const { sync, master } = harness()
    master.target.wsEndpoint = null
    await expectSyncError(sync.start(startInput), 'not_running', 'profile "master" is not running')
  })

  it('rejects a slave that is not running', async () => {
    const { sync, slaveB } = harness()
    slaveB.target.wsEndpoint = null
    await expectSyncError(sync.start(startInput), 'not_running', 'profile "slave-b" is not running')
  })

  it('rejects an empty slave list', async () => {
    const { sync } = harness()
    await expectSyncError(
      sync.start({ masterProfileId: 'master', slaveProfileIds: [] }),
      'invalid_input',
      'at least one slave',
    )
  })

  it('rejects a master that is also listed as a slave', async () => {
    const { sync } = harness()
    await expectSyncError(
      sync.start({ masterProfileId: 'master', slaveProfileIds: ['master', 'slave-a'] }),
      'invalid_input',
      'cannot be both the master and a slave',
    )
  })

  it('rejects a slave that resolves to the master browser, which would echo our own input', async () => {
    const { sync, slaveB, master } = harness()
    slaveB.target.pid = master.target.pid
    slaveB.target.wsEndpoint = master.target.wsEndpoint
    await expectSyncError(sync.start(startInput), 'invalid_input', 'same browser as the master')
  })

  it('rejects a second session while one is active', async () => {
    const { sync } = harness()
    await sync.start(startInput)
    await expectSyncError(sync.start(startInput), 'already_active', 'already active')
    await sync.stop()
  })

  it('rejects every start after close()', async () => {
    const { sync } = harness()
    await sync.close()
    await expectSyncError(sync.start(startInput), 'closed', 'is closed')
  })

  it('leaves nothing behind when a slave cannot be attached', async () => {
    const { sync, world, master, slaveB } = harness()
    const revive = world.kill('ws://127.0.0.1/slave-b')

    await expect(sync.start(startInput)).rejects.toThrow(
      'could not attach to slave profile "slave-b"',
    )

    expect(sync.current()).toBeNull()
    expect(master.context.binding).toBeNull()
    expect(master.browser.connectionClosed).toBe(true)
    expect(world.connectCalls).toEqual([
      'ws://127.0.0.1/master',
      'ws://127.0.0.1/slave-a',
      'ws://127.0.0.1/slave-b',
    ])
    // A later session must still be able to attach to the master context.
    revive()
    const session = await sync.start(startInput)
    expect(session.slaveProfileIds).toEqual(['slave-a', 'slave-b'])
    expect(slaveB.context.binding).toBeNull()
    await sync.stop()
  })
})

describe('start', () => {
  it('returns the session described by the frozen schema', async () => {
    const { sync } = harness()
    const session = await sync.start(startInput)

    expect(session).toEqual({
      id: 'session-1',
      masterProfileId: 'master',
      slaveProfileIds: ['slave-a', 'slave-b'],
      active: true,
      startedAt: '2024-05-01T12:00:00.000Z',
      mirroredEvents: 0,
    })
    await sync.stop()
  })

  it('hands out copies, so a caller cannot mutate the live session', async () => {
    const { sync } = harness()
    await sync.start(startInput)

    const first = sync.current()
    first?.slaveProfileIds.push('injected')
    if (first) {
      first.mirroredEvents = 999
    }

    expect(sync.current()?.slaveProfileIds).toEqual(['slave-a', 'slave-b'])
    expect(sync.current()?.mirroredEvents).toBe(0)
    await sync.stop()
  })

  it('instruments the master window only', async () => {
    const { sync, master, slaveA, slaveB } = harness()
    await sync.start(startInput)

    expect(master.context.binding?.name).toBe('__vfoxSyncReport')
    expect(master.context.initScripts).toEqual([SYNC_LISTENER_SOURCE])
    expect(master.page.evaluated).toContain(SYNC_LISTENER_SOURCE)

    // A slave must never be able to report input: no binding, no listener, no init script.
    expect(slaveA.context.binding).toBeNull()
    expect(slaveB.context.binding).toBeNull()
    expect(slaveA.context.initScripts).toEqual([])
    expect(slaveB.context.initScripts).toEqual([])
    expect(slaveA.page.evaluated).not.toContain(SYNC_LISTENER_SOURCE)
    await sync.stop()
  })

  it('instruments a master page that appears after the session started', async () => {
    const { sync, master } = harness()
    await sync.start(startInput)

    const opened = master.context.openPage()
    await waitFor(() => opened.evaluated.includes(SYNC_LISTENER_SOURCE))
    await sync.stop()
  })

  it('emits the new session to every change listener', async () => {
    const { sync } = harness()
    const seen: (SyncSession | null)[] = []
    sync.on('change', session => seen.push(session))

    await sync.start(startInput)

    expect(seen).toHaveLength(1)
    expect(seen[0]?.masterProfileId).toBe('master')
    await sync.stop()
  })
})

describe('mirroring', () => {
  it('replays master input into every slave, mapped to its viewport', async () => {
    const { sync, master, slaveA, slaveB } = harness()
    slaveA.page.setMeasuredViewport({ width: 640, height: 400 })
    await sync.start(startInput)

    master.context.report(mousePayload('mousedown', 640, 400))
    master.context.report(mousePayload('mouseup', 640, 400))
    master.context.report(mousePayload('click', 640, 400))
    master.context.report(keyPayload('keydown', 'a'))

    await waitFor(() => slaveA.page.calls.length === 5)
    await waitFor(() => slaveB.page.calls.length === 5)

    // The slave is half the size, so the pointer is mapped and the synthesised click is not
    // replayed a second time.
    expect(slaveA.page.calls).toEqual([
      { method: 'move', args: [320, 200] },
      { method: 'down', args: [{ button: 'left' }] },
      { method: 'move', args: [320, 200] },
      { method: 'up', args: [{ button: 'left' }] },
      { method: 'key-down', args: ['a'] },
    ])
    expect(slaveB.page.calls).toEqual([
      { method: 'move', args: [640, 400] },
      { method: 'down', args: [{ button: 'left' }] },
      { method: 'move', args: [640, 400] },
      { method: 'up', args: [{ button: 'left' }] },
      { method: 'key-down', args: ['a'] },
    ])
    expect(sync.current()?.mirroredEvents).toBe(4)
    await sync.stop()
  })

  it('counts every mirrored event and ignores reports it cannot use', async () => {
    const { sync, master } = harness()
    await sync.start(startInput)

    master.context.report(mousePayload('mousemove', 1, 1))
    master.context.report({ kind: 'dragstart', x: 0, y: 0, vw: 100, vh: 100 })
    master.context.report('not an event')
    master.context.report(keyPayload('keydown', 'Enter'))

    expect(sync.current()?.mirroredEvents).toBe(2)
    await sync.stop()
  })

  it('ignores a report that arrives after the session stopped', async () => {
    const { sync, master, slaveA } = harness()
    await sync.start(startInput)
    const binding = master.context.binding
    if (!binding) {
      throw new Error('expected the master context to have a binding')
    }

    await sync.stop()
    expect(() =>
      binding.callback({ page: master.page }, mousePayload('click', 10, 10)),
    ).not.toThrow()
    await sleep(20)

    expect(slaveA.page.calls).toEqual([])
  })

  it('pushes the event counter to the UI without one frame per mouse move', async () => {
    vi.useFakeTimers()
    try {
      const { sync, master } = harness()
      const seen: (SyncSession | null)[] = []
      sync.on('change', session => seen.push(session))
      await sync.start(startInput)

      master.context.report(mousePayload('mousemove', 1, 1))
      master.context.report(mousePayload('mousemove', 2, 2))
      master.context.report(mousePayload('mousemove', 3, 3))
      expect(seen).toHaveLength(1)

      vi.advanceTimersByTime(250)

      expect(seen).toHaveLength(2)
      expect(seen[1]?.mirroredEvents).toBe(3)
      await sync.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps one failing change listener from breaking the others', async () => {
    const { sync, logger } = harness()
    const seen: (SyncSession | null)[] = []
    sync.on('change', () => {
      throw new Error('listener exploded')
    })
    sync.on('change', session => seen.push(session))

    await sync.start(startInput)

    expect(seen).toHaveLength(1)
    expect(logger.warnings.some(warning => warning.includes('change listener'))).toBe(true)
    await sync.stop()
  })

  it('stops delivering after unsubscribe', async () => {
    const { sync } = harness()
    const seen: (SyncSession | null)[] = []
    const unsubscribe = sync.on('change', session => seen.push(session))
    unsubscribe()

    await sync.start(startInput)

    expect(seen).toEqual([])
    await sync.stop()
  })
})

describe('stop', () => {
  it('detaches cleanly and reports a null session', async () => {
    const { sync, master, slaveA, slaveB, world } = harness()
    const seen: (SyncSession | null)[] = []
    await sync.start(startInput)
    sync.on('change', session => seen.push(session))

    await sync.stop()

    expect(sync.current()).toBeNull()
    expect(seen).toEqual([null])
    expect(master.context.binding).toBeNull()
    expect(master.context.bindingDisposed).toBe(true)
    expect(master.context.initScripts).toEqual([])
    expect(master.page.evaluated).toContain(SYNC_TEARDOWN_SOURCE)
    expect(master.browser.connectionClosed).toBe(true)
    expect(slaveA.browser.connectionClosed).toBe(true)
    expect(slaveB.browser.connectionClosed).toBe(true)
    expect(world.connectCalls).toHaveLength(3)
  })

  it('is idempotent and lets a new session start afterwards', async () => {
    const { sync } = harness()
    await sync.start(startInput)
    await sync.stop()
    await sync.stop()

    const again = await sync.start({ masterProfileId: 'master', slaveProfileIds: ['slave-b'] })
    expect(again.slaveProfileIds).toEqual(['slave-b'])
    await sync.stop()
  })

  it('closes the synchroniser and releases its listeners', async () => {
    const { sync } = harness()
    const seen: (SyncSession | null)[] = []
    sync.on('change', session => seen.push(session))

    await sync.close()
    await sync.close()

    expect(seen).toEqual([])
    expect(sync.current()).toBeNull()
  })
})

describe('browser disconnects', () => {
  it('stops the session when the master window goes away', async () => {
    const { sync, master } = harness()
    const seen: (SyncSession | null)[] = []
    await sync.start(startInput)
    sync.on('change', session => seen.push(session))

    master.browser.disconnect()
    await waitFor(() => seen.length === 1)

    expect(seen).toEqual([null])
    expect(sync.current()).toBeNull()
  })

  it('drops a slave that goes away and stops when none is left', async () => {
    const { sync, slaveA, slaveB } = harness()
    const seen: (SyncSession | null)[] = []
    await sync.start(startInput)
    sync.on('change', session => seen.push(session))

    slaveA.browser.disconnect()
    await waitFor(() => seen.length === 1)
    expect(sync.current()?.slaveProfileIds).toEqual(['slave-b'])
    expect(seen[0]?.slaveProfileIds).toEqual(['slave-b'])

    slaveB.browser.disconnect()
    await waitFor(() => seen.length === 2)
    expect(seen[1]).toBeNull()
    expect(sync.current()).toBeNull()
  })
})

describe('tile', () => {
  it('places every window in a grid inside the work area and focuses the first', async () => {
    const { sync, tile } = harness()
    tile.workAreaRect = { x: 0, y: 0, width: 1000, height: 500 }

    await sync.tile({ profileIds: ['master', 'slave-a'], layout: 'grid', displayIndex: null })

    expect(tile.workAreaCalls).toEqual([null])
    expect(tile.placed).toEqual([
      { pid: 1111, rect: { x: 0, y: 0, width: 499, height: 500 } },
      { pid: 2222, rect: { x: 501, y: 0, width: 499, height: 500 } },
    ])
    expect(tile.focused).toEqual([1111])
  })

  it('honours the layout and the monitor index', async () => {
    const { sync, tile } = harness()
    tile.workAreaRect = { x: 1920, y: 0, width: 800, height: 600 }

    await sync.tile({ profileIds: ['master', 'slave-a'], layout: 'rows', displayIndex: 1 })

    expect(tile.workAreaCalls).toEqual([1])
    expect(tile.placed).toEqual([
      { pid: 1111, rect: { x: 1920, y: 0, width: 800, height: 299 } },
      { pid: 2222, rect: { x: 1920, y: 301, width: 800, height: 299 } },
    ])
  })

  it('deduplicates repeated profile ids', async () => {
    const { sync, tile } = harness()

    await sync.tile({ profileIds: ['master', 'master'], layout: 'columns', displayIndex: null })

    expect(tile.placed).toHaveLength(1)
  })

  it('rejects an empty list, unknown profiles and stopped profiles', async () => {
    const { sync, slaveA } = harness()
    await expectSyncError(
      sync.tile({ profileIds: [], layout: 'grid', displayIndex: null }),
      'invalid_input',
      'at least one profile id',
    )
    await expectSyncError(
      sync.tile({ profileIds: ['ghost'], layout: 'grid', displayIndex: null }),
      'unknown_profile',
      'unknown profile "ghost"',
    )
    slaveA.target.pid = null
    await expectSyncError(
      sync.tile({ profileIds: ['slave-a'], layout: 'grid', displayIndex: null }),
      'not_running',
      'no window to tile',
    )
  })

  it('fails loudly when no window matched', async () => {
    const { sync, tile } = harness()
    tile.matches = false
    await expectSyncError(
      sync.tile({ profileIds: ['master'], layout: 'grid', displayIndex: null }),
      'tiling_unavailable',
      'no visible browser window matched',
    )
  })
})
