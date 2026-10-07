import type { ProfileRuntime, RuntimeErrorCode, RuntimeStatus } from '@vfox/shared'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { getRuntime, listRuntime } from '../api/endpoints'

/**
 * Live runtime state, fed exclusively by the SSE stream. The list endpoint is used once on
 * connect (and on an explicit 刷新) to seed it — there is no polling anywhere.
 */
export const useRuntimeStore = defineStore('runtime', () => {
  const byId = ref<Record<string, ProfileRuntime>>({})

  function apply(runtime: ProfileRuntime): void {
    byId.value = { ...byId.value, [runtime.profileId]: runtime }
  }

  function replaceAll(list: ProfileRuntime[]): void {
    const next: Record<string, ProfileRuntime> = {}
    for (const runtime of list) next[runtime.profileId] = runtime
    byId.value = next
  }

  async function seed(): Promise<void> {
    replaceAll(await listRuntime())
  }

  function statusOf(profileId: string): RuntimeStatus {
    return byId.value[profileId]?.status ?? 'stopped'
  }

  function startedAt(profileId: string): string | null {
    return byId.value[profileId]?.startedAt ?? null
  }

  /** Non-null only while the profile is actually running; the engine exposes a Juggler endpoint. */
  function wsEndpoint(profileId: string): string | null {
    return byId.value[profileId]?.wsEndpoint ?? null
  }

  function lastError(profileId: string): string | null {
    return byId.value[profileId]?.lastError ?? null
  }

  /**
   * The machine-readable failure class, when the failure has an action attached to it.
   *
   * This is what the interface branches on. Matching `lastError` against English prose instead would
   * stop offering the fix the day someone rewords the message, and the core records the code
   * precisely so that does not have to happen (`RuntimeErrorCodeSchema`).
   */
  function errorCodeOf(profileId: string): RuntimeErrorCode | null {
    return byId.value[profileId]?.errorCode ?? null
  }

  /** True while the profile's launch is refused because its pinned kernel is not installed. */
  function kernelMissing(profileId: string): boolean {
    return errorCodeOf(profileId) === 'kernel_missing'
  }

  /**
   * Re-read one profile's runtime from the API and merge it in.
   *
   * Called after a failed launch, where the SSE push that carries `errorCode` may not have arrived
   * yet: the registry records it before answering, but the stream is a separate connection. One read
   * on an event, never a poll.
   */
  async function refreshOne(profileId: string): Promise<void> {
    try {
      apply(await getRuntime(profileId))
    } catch {
      // The stream will catch up; a failed refresh must not replace the error the caller is about
      // to report.
    }
  }

  function isActive(profileId: string): boolean {
    const status = statusOf(profileId)
    return status === 'running' || status === 'starting' || status === 'stopping'
  }

  const activeCount = computed(
    () =>
      Object.values(byId.value).filter(rt => rt.status !== 'stopped' && rt.status !== 'error')
        .length,
  )

  return {
    byId,
    activeCount,
    apply,
    replaceAll,
    seed,
    statusOf,
    startedAt,
    wsEndpoint,
    lastError,
    errorCodeOf,
    kernelMissing,
    refreshOne,
    isActive,
  }
})
