import { describe, expect, it } from 'vitest'
import { ViewportTracker } from '../dist/mapping.js'
import { normalizeMirrorEvent } from '../dist/mirror.js'
import { SlaveMirror } from '../dist/slave.js'
import { FakePage, FakeWorld, mousePayload, testLogger, waitFor } from './helpers/fake-browser.mjs'

function event(kind, x, y, extra = {}) {
  const normalized = normalizeMirrorEvent(mousePayload(kind, x, y, extra))
  if (!normalized) {
    throw new Error('the test payload was not normalised')
  }
  return normalized
}

function keyEvent(kind, key) {
  const normalized = normalizeMirrorEvent({ kind, key, vw: 1280, vh: 800 })
  if (!normalized) {
    throw new Error('the test payload was not normalised')
  }
  return normalized
}

async function attach(world, profileId, overrides = {}) {
  const profile = world.profiles.get(profileId)
  if (!profile) {
    throw new Error(`unknown fake profile ${profileId}`)
  }
  const logger = testLogger()
  const slave = await SlaveMirror.attach({
    profileId,
    label: profile.name,
    wsEndpoint: profile.target.wsEndpoint ?? '',
    connect: world.connect,
    logger: logger.logger,
    viewports: new ViewportTracker(),
    onGone: () => {},
    ...overrides,
  })
  return { world, slave, page: profile.page, logger }
}

function methods(page) {
  return page.calls.map(call => call.method)
}

describe('SlaveMirror', () => {
  it('replays a queued event into the slave page', async () => {
    const world = new FakeWorld()
    world.add('slave')
    const { slave, page } = await attach(world, 'slave')

    slave.enqueue(event('mousemove', 100, 200))
    await waitFor(() => page.calls.length === 1)

    expect(page.calls).toEqual([{ method: 'move', args: [100, 200] }])
    await slave.stop()
  })

  it('maps into the slave viewport, which may differ from the master', async () => {
    const world = new FakeWorld()
    world.add('slave', { page: new FakePage({ measured: { width: 640, height: 400 } }) })
    const { slave, page } = await attach(world, 'slave')

    slave.enqueue(event('mousedown', 640, 400))
    await waitFor(() => page.calls.length === 2)

    expect(page.calls).toEqual([
      { method: 'move', args: [320, 200] },
      { method: 'down', args: [{ button: 'left' }] },
    ])
    await slave.stop()
  })

  it('drops mousemove first when the slave is slow, and keeps clicks and keys', async () => {
    const world = new FakeWorld()
    world.add('slave')
    const { slave, page } = await attach(world, 'slave')

    let release = () => {}
    page.gate = new Promise(resolve => {
      release = resolve
    })

    for (let index = 0; index < 40; index += 1) {
      slave.enqueue(event('mousemove', index, index))
    }
    slave.enqueue(event('click', 10, 10))
    slave.enqueue(keyEvent('keydown', 'a'))

    expect(slave.dropped.moves).toBeGreaterThan(0)

    page.gate = null
    release()
    await waitFor(() => methods(page).includes('key-down'))

    expect(methods(page)).toContain('click')
    expect(methods(page)).toContain('key-down')
    await slave.stop()
  })

  it('evicts a queued mousemove to make room for an action', async () => {
    const world = new FakeWorld()
    world.add('slave')
    const { slave, page } = await attach(world, 'slave', { limits: { moves: 100, queue: 1 } })

    let release = () => {}
    page.gate = new Promise(resolve => {
      release = resolve
    })

    slave.enqueue(event('mousemove', 1, 1))
    slave.enqueue(event('mousemove', 2, 2))
    slave.enqueue(event('click', 3, 3))

    expect(slave.dropped.moves).toBe(1)

    page.gate = null
    release()
    await waitFor(() => methods(page).includes('click'))
    await slave.stop()
  })

  it('warns once and drops the event when even the action queue is full', async () => {
    const world = new FakeWorld()
    world.add('slave')
    const { slave, page, logger } = await attach(world, 'slave', { limits: { queue: 1 } })

    let release = () => {}
    page.gate = new Promise(resolve => {
      release = resolve
    })

    slave.enqueue(event('click', 1, 1))
    slave.enqueue(event('click', 2, 2))
    slave.enqueue(event('click', 3, 3))
    slave.enqueue(event('click', 4, 4))

    expect(slave.dropped.critical).toBe(2)
    expect(logger.warnings.filter(warning => warning.includes('not keeping up'))).toHaveLength(1)

    page.gate = null
    release()
    await waitFor(() => methods(page).includes('click'))
    await slave.stop()
  })

  it('waits for a page instead of dropping the event', async () => {
    const world = new FakeWorld()
    const profile = world.add('slave', { withPage: false })
    const { slave } = await attach(world, 'slave')

    slave.enqueue(event('click', 50, 60))
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(profile.page.calls).toEqual([])

    const opened = profile.context.openPage()
    await waitFor(() => opened.calls.length === 2)

    expect(opened.calls).toEqual([
      { method: 'move', args: [50, 60] },
      { method: 'click', args: [50, 60, { button: 'left' }] },
    ])
    await slave.stop()
  })

  it('gives up on the backlog when the slave never gets a page', async () => {
    const world = new FakeWorld()
    world.add('slave', { withPage: false })
    const { slave, logger } = await attach(world, 'slave', { pageWaitMs: 20 })

    slave.enqueue(event('click', 1, 1))
    slave.enqueue(event('click', 2, 2))
    slave.enqueue(event('click', 3, 3))

    await waitFor(() => slave.dropped.noPage === 3)
    expect(logger.warnings.some(warning => warning.includes('has no page'))).toBe(true)
    await slave.stop()
  })

  it('replays into a new page after the slave window was closed', async () => {
    const world = new FakeWorld()
    const profile = world.add('slave')
    const { slave, page } = await attach(world, 'slave')

    page.closeWindow()
    const reopened = profile.context.openPage()

    slave.enqueue(event('mousemove', 7, 8))
    await waitFor(() => reopened.calls.length === 1)

    expect(reopened.calls).toEqual([{ method: 'move', args: [7, 8] }])
    expect(page.calls).toEqual([])
    await slave.stop()
  })

  it('stops replaying, drops the backlog and detaches its listeners', async () => {
    const world = new FakeWorld()
    const profile = world.add('slave')
    const { slave, page } = await attach(world, 'slave')

    slave.enqueue(event('mousemove', 1, 1))
    await waitFor(() => page.calls.length === 1)

    await slave.stop()

    expect(profile.browser.connectionClosed).toBe(true)
    expect(profile.context.pageListenerCount).toBe(0)
    expect(profile.browser.disconnectListenerCount).toBe(0)

    slave.enqueue(event('mousemove', 2, 2))
    profile.context.openPage()
    await new Promise(resolve => setTimeout(resolve, 20))

    expect(page.calls).toHaveLength(1)
    expect(slave.dropped.noPage).toBe(0)
  })

  it('reports a disconnected browser to the session', async () => {
    const world = new FakeWorld()
    const profile = world.add('slave')
    const gone = []
    const { slave } = await attach(world, 'slave', { onGone: id => gone.push(id) })

    profile.browser.disconnect()

    expect(gone).toEqual(['slave'])
    await slave.stop()
    expect(gone).toEqual(['slave'])
  })

  it('fails with a clear error when the browser cannot be reached', async () => {
    const world = new FakeWorld()
    world.add('slave')
    world.kill('ws://127.0.0.1/slave')

    await expect(attach(world, 'slave')).rejects.toThrow(
      'could not attach to slave profile "slave"',
    )
  })

  it('fails when the browser exposes no context', async () => {
    const world = new FakeWorld()
    const profile = world.add('slave')
    profile.browser.contexts_.length = 0

    await expect(attach(world, 'slave')).rejects.toThrow('exposed no browser context')
  })
})
