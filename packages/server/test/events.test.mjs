import { API_ROUTES, SSE_EVENT_KERNEL, SSE_EVENT_RUNTIME } from '@vfox/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createHarness, tick } from './helpers/harness.mjs'

let h

beforeEach(async () => {
  h = await createHarness()
})

afterEach(async () => {
  await h.dispose()
})

/** Parses `event:`/`data:` pairs out of the raw stream, ignoring `retry:` and `:` comments. */
function parseFrames(raw) {
  const frames = []
  for (const block of raw.split('\n\n')) {
    const event = block
      .split('\n')
      .find(line => line.startsWith('event: '))
      ?.slice('event: '.length)
    const data = block
      .split('\n')
      .find(line => line.startsWith('data: '))
      ?.slice('data: '.length)
    if (event && data !== undefined) frames.push({ event, data: JSON.parse(data) })
  }
  return frames
}

async function openStream() {
  // `payloadAsStream` resolves as soon as the headers are written, which is what makes an endless
  // SSE response testable through `fastify.inject()`.
  const res = await h.app.inject({
    method: 'GET',
    url: API_ROUTES.events,
    headers: h.auth,
    payloadAsStream: true,
  })
  const chunks = []
  const stream = res.stream()
  stream.on('data', chunk => chunks.push(chunk.toString('utf8')))
  const text = () => chunks.join('')
  return {
    statusCode: res.statusCode,
    headers: res.headers,
    frames: () => parseFrames(text()),
    text,
    close: () => {
      res.raw.res.destroy()
    },
  }
}

async function createProfile(name = 'Streamed') {
  const res = await h.app.inject({
    method: 'POST',
    url: API_ROUTES.profiles,
    headers: { ...h.auth, 'content-type': 'application/json' },
    payload: { name },
  })
  return res.json().data
}

describe('GET /api/v1/events', () => {
  it('opens an event stream with the right headers', async () => {
    const stream = await openStream()
    expect(stream.statusCode).toBe(200)
    expect(String(stream.headers['content-type'])).toContain('text/event-stream')
    expect(String(stream.headers['cache-control'])).toContain('no-cache')
    await tick()
    expect(stream.text()).toContain('retry: 3000')
    expect(h.context.hub.clientCount).toBe(1)
    stream.close()
    await tick()
    expect(h.context.hub.clientCount).toBe(0)
  })

  it('snapshots current runtime state on connect', async () => {
    const profile = await createProfile()
    const stream = await openStream()
    await tick()

    const frames = stream.frames()
    expect(frames).toHaveLength(1)
    expect(frames[0].event).toBe(SSE_EVENT_RUNTIME)
    expect(frames[0].data).toMatchObject({ profileId: profile.id, status: 'stopped' })
    stream.close()
  })

  it('pushes runtime transitions from core events', async () => {
    const profile = await createProfile()
    const stream = await openStream()
    await tick()

    h.core.setRuntime(profile.id, {
      status: 'running',
      pid: 1234,
      wsEndpoint: 'ws://127.0.0.1:6000/playwright',
    })
    await tick()

    const frames = stream.frames().filter(frame => frame.event === SSE_EVENT_RUNTIME)
    expect(frames).toHaveLength(2)
    expect(frames[1].data).toMatchObject({
      profileId: profile.id,
      status: 'running',
      pid: 1234,
      wsEndpoint: 'ws://127.0.0.1:6000/playwright',
    })
    stream.close()
  })

  it('pushes kernel progress from core events', async () => {
    const stream = await openStream()
    await tick()

    h.core.installProgress = [
      { phase: 'downloading', percent: 42, receivedBytes: 42, totalBytes: 100, message: null },
    ]
    const res = await h.app.inject({
      method: 'POST',
      url: API_ROUTES.kernelInstall,
      headers: h.auth,
    })
    expect(res.statusCode).toBe(202)
    await tick()

    const kernel = stream.frames().filter(frame => frame.event === SSE_EVENT_KERNEL)
    expect(kernel.map(frame => frame.data.phase)).toEqual(['checking', 'downloading'])
    expect(kernel[1].data).toMatchObject({ percent: 42, totalBytes: 100 })
    stream.close()
  })

  it('replays the last kernel phase to a late client', async () => {
    h.core.installProgress = [
      { phase: 'extracting', percent: null, receivedBytes: null, totalBytes: null, message: null },
    ]
    await h.app.inject({ method: 'POST', url: API_ROUTES.kernelInstall, headers: h.auth })
    await tick()

    const stream = await openStream()
    await tick()
    const kernel = stream.frames().filter(frame => frame.event === SSE_EVENT_KERNEL)
    expect(kernel).toHaveLength(1)
    expect(kernel[0].data).toMatchObject({ phase: 'extracting' })
    stream.close()
  })

  it('broadcasts one transition to every connected client', async () => {
    const profile = await createProfile()
    const first = await openStream()
    const second = await openStream()
    await tick()

    h.core.setRuntime(profile.id, { status: 'starting' })
    await tick()

    for (const stream of [first, second]) {
      const frames = stream.frames().filter(frame => frame.event === SSE_EVENT_RUNTIME)
      expect(frames.at(-1).data).toMatchObject({ status: 'starting' })
      stream.close()
    }
    await tick()
    expect(h.context.hub.clientCount).toBe(0)
  })

  it('stops delivering after the hub is shut down', async () => {
    const profile = await createProfile()
    const stream = await openStream()
    await tick()
    expect(h.context.hub.clientCount).toBe(1)

    h.context.hub.stop()
    await tick()
    expect(h.context.hub.clientCount).toBe(0)

    h.core.setRuntime(profile.id, { status: 'running' })
    await tick()
    expect(stream.frames().filter(frame => frame.event === SSE_EVENT_RUNTIME)).toHaveLength(1)
  })
})
