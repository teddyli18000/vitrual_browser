import type { ProfileRuntime, RuntimeStatus } from '@vfox/shared'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { listRuntime } from '../api/endpoints'

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
    isActive,
  }
})
