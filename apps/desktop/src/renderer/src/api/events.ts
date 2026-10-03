/**
 * Live state, pushed — never polled.
 *
 * `EventSource` cannot send the `x-vfox-token` header, so the stream is read with `fetch` and a
 * small SSE parser instead. Reconnecting after a dropped stream is required for correctness and
 * is not polling: the server only speaks when something actually changes.
 */

import {
  API_ROUTES,
  API_TOKEN_HEADER,
  type KernelProgress,
  type ProfileRuntime,
  SSE_EVENT_KERNEL,
  SSE_EVENT_RUNTIME,
} from '@vfox/shared'
import { connectionBase, connectionToken } from './http'

export type StreamState = 'connecting' | 'open' | 'closed'

export interface EventStreamHandlers {
  onRuntime(runtime: ProfileRuntime): void
  onKernel(progress: KernelProgress): void
  onState(state: StreamState, error?: string): void
}

interface SseMessage {
  event: string
  data: string
}

function parseChunk(chunk: string): SseMessage | null {
  let event = 'message'
  const data: string[] = []
  for (const line of chunk.split('\n')) {
    if (line.length === 0 || line.startsWith(':')) continue
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    const raw = colon === -1 ? '' : line.slice(colon + 1)
    const value = raw.startsWith(' ') ? raw.slice(1) : raw
    if (field === 'event') event = value
    else if (field === 'data') data.push(value)
  }
  if (data.length === 0) return null
  return { event, data: data.join('\n') }
}

const MAX_BACKOFF_MS = 10_000

export function openEventStream(handlers: EventStreamHandlers): () => void {
  const controller = new AbortController()
  let stopped = false
  let attempt = 0

  const sleep = (ms: number): Promise<void> =>
    new Promise(resolve => {
      setTimeout(resolve, ms)
    })

  const dispatch = (message: SseMessage): void => {
    let payload: unknown
    try {
      payload = JSON.parse(message.data)
    } catch {
      return
    }
    if (message.event === SSE_EVENT_RUNTIME) handlers.onRuntime(payload as ProfileRuntime)
    else if (message.event === SSE_EVENT_KERNEL) handlers.onKernel(payload as KernelProgress)
  }

  const run = async (): Promise<void> => {
    while (!stopped) {
      handlers.onState('connecting')
      let failure = ''
      try {
        const res = await fetch(`${connectionBase()}${API_ROUTES.events}`, {
          headers: { accept: 'text/event-stream', [API_TOKEN_HEADER]: connectionToken() },
          signal: controller.signal,
          cache: 'no-store',
        })
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
        attempt = 0
        handlers.onState('open')
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n')
          let boundary = buffer.indexOf('\n\n')
          while (boundary !== -1) {
            const chunk = buffer.slice(0, boundary)
            buffer = buffer.slice(boundary + 2)
            const message = parseChunk(chunk)
            if (message) dispatch(message)
            boundary = buffer.indexOf('\n\n')
          }
        }
      } catch (err) {
        if (stopped) return
        failure = err instanceof Error ? err.message : String(err)
      }
      if (stopped) return
      handlers.onState('closed', failure)
      attempt += 1
      await sleep(Math.min(500 * 2 ** attempt, MAX_BACKOFF_MS))
    }
  }

  void run()

  return () => {
    stopped = true
    controller.abort()
  }
}
