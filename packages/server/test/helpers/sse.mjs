/**
 * Reads an SSE stream through `fastify.inject()`.
 *
 * `payloadAsStream` resolves as soon as the headers are written, which is what makes an endless
 * SSE response testable without opening a real socket.
 */

import { API_ROUTES } from '@vfox/shared'

/** Parses `event:`/`data:` pairs out of the raw stream, ignoring `retry:` and `:` comments. */
export function parseFrames(raw) {
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

export async function openStream(h) {
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
