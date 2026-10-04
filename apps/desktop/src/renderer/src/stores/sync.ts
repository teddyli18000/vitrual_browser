import type { SyncSession, TileLayout } from '@vfox/shared'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { getSync, startSync, stopSync, tileWindows } from '../api/endpoints'
import { ApiError } from '../api/http'
import { t } from '../i18n'

/**
 * Window tiling calls `user32.dll` through koffi, so it exists on Windows only — this is the same
 * fact `@vfox/sync` encodes when it fails with `tiling_unavailable`. It is checked here so the
 * button can be disabled *before* the first attempt instead of after it.
 */
const TILING_PLATFORM = 'win32'

/**
 * The synchroniser session plus the local draft the user is editing.
 *
 * The **session is the source of truth**: it is seeded from `GET /sync` and then kept live by the
 * `sync` SSE event, which is the only thing that ever sets `mirroredEvents`. The master/slave
 * selection is a draft — it is mirrored from the session while one is active (so the controls show
 * what is actually being mirrored), and preserved after a stop so restarting is one click.
 */
export const useSyncStore = defineStore('sync', () => {
  const session = ref<SyncSession | null>(null)
  const masterId = ref<string | null>(null)
  const slaveIds = ref<string[]>([])
  const layout = ref<TileLayout>('grid')
  /** `null` = the primary monitor, which is always a valid target. */
  const displayIndex = ref<number | null>(null)
  const busy = ref(false)
  /** Set only when the backend itself answered `tiling_unavailable`. */
  const tilingError = ref<string | null>(null)

  const platformSupported = window.vfox.platform === TILING_PLATFORM
  const tilingAvailable = computed(() => platformSupported && tilingError.value === null)

  const active = computed(() => session.value?.active === true)
  const mirroredEvents = computed(() => session.value?.mirroredEvents ?? 0)
  const startedAt = computed(() => session.value?.startedAt ?? null)
  /** The ids the running session actually mirrors; the tile action uses these, not the draft. */
  const sessionProfileIds = computed(() =>
    session.value ? [session.value.masterProfileId, ...session.value.slaveProfileIds] : [],
  )

  /** Applies a session (from `GET /sync` or the SSE event). `null` only ends it; the draft stays. */
  function apply(next: SyncSession | null): void {
    session.value = next
    if (!next) return
    masterId.value = next.masterProfileId
    slaveIds.value = [...next.slaveProfileIds]
  }

  async function seed(): Promise<void> {
    apply(await getSync())
  }

  async function start(): Promise<SyncSession> {
    const master = masterId.value
    if (!master || slaveIds.value.length === 0) {
      throw new ApiError('sync-incomplete', t('sync.pickFirst'))
    }
    busy.value = true
    try {
      const created = await startSync({
        masterProfileId: master,
        slaveProfileIds: [...slaveIds.value],
      })
      apply(created)
      return created
    } finally {
      busy.value = false
    }
  }

  async function stop(): Promise<void> {
    busy.value = true
    try {
      await stopSync()
      // The SSE event confirms it; clearing here makes the state flip on the click, not later.
      session.value = null
    } finally {
      busy.value = false
    }
  }

  async function tile(profileIds: string[]): Promise<void> {
    busy.value = true
    try {
      await tileWindows({ profileIds, layout: layout.value, displayIndex: displayIndex.value })
      tilingError.value = null
    } catch (err) {
      // Latch the backend's own words so the disabled button can explain itself, and so the
      // reason shown is the server's, never a guess invented here.
      if (err instanceof ApiError && err.code === 'tiling_unavailable')
        tilingError.value = err.message
      throw err
    } finally {
      busy.value = false
    }
  }

  /** Clears a latched failure so the button is usable again (the backend may have been fixed). */
  function forgetTilingError(): void {
    tilingError.value = null
  }

  return {
    session,
    masterId,
    slaveIds,
    layout,
    displayIndex,
    busy,
    tilingError,
    platformSupported,
    tilingAvailable,
    active,
    mirroredEvents,
    startedAt,
    sessionProfileIds,
    apply,
    seed,
    start,
    stop,
    tile,
    forgetTilingError,
  }
})
