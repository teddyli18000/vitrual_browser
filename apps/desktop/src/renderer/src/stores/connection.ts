import type { ProfileRuntime } from '@vfox/shared'
import { defineStore } from 'pinia'
import { ref } from 'vue'
import { getHealth } from '../api/endpoints'
import { openEventStream, type StreamState } from '../api/events'
import { errorMessage, setConnection } from '../api/http'
import { useKernelStore } from './kernel'
import { usePrefsStore } from './prefs'
import { useRuntimeStore } from './runtime'
import { useSyncStore } from './sync'

export type ConnectionState = 'idle' | 'online' | 'offline'

/**
 * Owns the connection facts handed over by the preload bridge, the health probe and the single
 * SSE stream. If the embedded API is down the app still renders — the banner explains why and
 * offers 重试, which asks the main process to start the service again.
 */
export const useConnectionStore = defineStore('connection', () => {
  const bridge = window.vfox

  const state = ref<ConnectionState>('idle')
  const streamState = ref<StreamState>('closed')
  const base = ref(bridge.apiBase)
  const token = ref(bridge.token)
  const serviceError = ref<string | null>(bridge.serviceError)
  const error = ref<string | null>(null)
  const retrying = ref(false)
  const dataDir = ref(bridge.dataDir)
  const dataMode = ref(bridge.dataMode)
  const version = ref(bridge.version)
  const platform = ref(bridge.platform)

  let closeStream: (() => void) | null = null

  function openStream(): void {
    closeStream?.()
    const runtime = useRuntimeStore()
    const kernel = useKernelStore()
    const prefs = usePrefsStore()
    const sync = useSyncStore()
    closeStream = openEventStream({
      onRuntime: (update: ProfileRuntime) => {
        runtime.apply(update)
        prefs.rememberStarted(update)
      },
      onKernel: progress => kernel.applyProgress(progress),
      onSync: session => sync.apply(session),
      onState: next => {
        streamState.value = next
      },
    })
  }

  async function check(): Promise<boolean> {
    try {
      const health = await getHealth()
      state.value = 'online'
      error.value = null
      serviceError.value = null
      version.value = health.version
      return true
    } catch (err) {
      state.value = 'offline'
      error.value = errorMessage(err)
      return false
    }
  }

  /** Health probe + runtime seed + SSE subscription, in that order. */
  async function connect(): Promise<boolean> {
    setConnection(base.value, token.value)
    if (!base.value) {
      state.value = 'offline'
      error.value = serviceError.value ?? '核心服务未启动'
      return false
    }
    const ok = await check()
    if (!ok) return false
    const runtime = useRuntimeStore()
    try {
      await runtime.seed()
      for (const entry of Object.values(runtime.byId)) usePrefsStore().rememberStarted(entry)
    } catch {
      // The stream will fill it in as soon as anything changes.
    }
    useKernelStore().refresh()
    openStream()
    return true
  }

  async function retry(): Promise<boolean> {
    if (retrying.value) return false
    retrying.value = true
    try {
      const result = await bridge.restartService()
      base.value = result.url
      token.value = result.token
      serviceError.value = result.error
      setConnection(base.value, token.value)
      const ok = await connect()
      if (!ok) error.value = result.error ?? error.value
      return ok
    } finally {
      retrying.value = false
    }
  }

  function disconnect(): void {
    closeStream?.()
    closeStream = null
  }

  return {
    state,
    streamState,
    base,
    token,
    serviceError,
    error,
    retrying,
    dataDir,
    dataMode,
    version,
    platform,
    connect,
    check,
    retry,
    disconnect,
  }
})
