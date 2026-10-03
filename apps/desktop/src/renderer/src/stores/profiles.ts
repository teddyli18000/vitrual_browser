import type { Group, Profile, ProfileCreate, ProfileUpdate } from '@vfox/shared'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import {
  cloneProfile,
  createGroup,
  createProfile,
  deleteGroup,
  deleteProfile,
  exportProfile,
  importProfileFromDialog,
  launchProfile,
  listGroups,
  listProfiles,
  renameGroup,
  stopProfile,
  updateProfile,
} from '../api/endpoints'
import { errorMessage } from '../api/http'
import { t } from '../i18n'

/** Batch start staggers launches: 20 profiles must not stampede the CPU at once. */
export const BATCH_STAGGER_MS = 1500

export interface BatchStartResult {
  started: number
  skipped: number
  failed: number
  cancelled: boolean
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms)
  })
}

export const useProfilesStore = defineStore('profiles', () => {
  const items = ref<Profile[]>([])
  const groups = ref<Group[]>([])
  const loading = ref(false)
  const loaded = ref(false)
  const error = ref<string | null>(null)

  const byId = computed(() => {
    const map: Record<string, Profile> = {}
    for (const profile of items.value) map[profile.id] = profile
    return map
  })

  function groupName(groupId: string | null): string {
    if (!groupId) return ''
    return groups.value.find(group => group.id === groupId)?.name ?? ''
  }

  function upsert(profile: Profile): void {
    const index = items.value.findIndex(item => item.id === profile.id)
    if (index === -1) items.value = [...items.value, profile]
    else items.value = items.value.map(item => (item.id === profile.id ? profile : item))
  }

  function removeLocal(id: string): void {
    items.value = items.value.filter(item => item.id !== id)
  }

  async function load(showSpinner = true): Promise<void> {
    if (showSpinner) loading.value = true
    try {
      const [profiles, groupList] = await Promise.all([listProfiles(), listGroups()])
      items.value = profiles
      groups.value = groupList
      loaded.value = true
      error.value = null
    } catch (err) {
      error.value = errorMessage(err)
    } finally {
      loading.value = false
    }
  }

  async function create(input: ProfileCreate): Promise<Profile> {
    const profile = await createProfile(input)
    upsert(profile)
    return profile
  }

  async function update(id: string, patch: ProfileUpdate): Promise<Profile> {
    const profile = await updateProfile(id, patch)
    upsert(profile)
    return profile
  }

  async function remove(id: string): Promise<void> {
    await deleteProfile(id)
    removeLocal(id)
  }

  async function clone(id: string, name?: string): Promise<Profile> {
    const profile = await cloneProfile(id, name)
    upsert(profile)
    return profile
  }

  async function launch(id: string): Promise<void> {
    await launchProfile(id)
  }

  async function stop(id: string): Promise<void> {
    await stopProfile(id)
  }

  /** Export through the OS save dialog; returns the written path, or null when cancelled. */
  async function exportOne(profile: Profile): Promise<string | null> {
    const safe = profile.name.replace(/[\\/:*?"<>|]/g, '_')
    return exportProfile(profile.id, `${safe}.vfox.zip`)
  }

  async function importOne(): Promise<Profile | null> {
    const profile = await importProfileFromDialog()
    if (profile) upsert(profile)
    return profile
  }

  /* ------------------------------------------------------------------------ groups */

  async function addGroup(name: string): Promise<Group> {
    const group = await createGroup(name)
    groups.value = [...groups.value, group]
    return group
  }

  async function renameGroupTo(id: string, name: string): Promise<void> {
    const group = await renameGroup(id, name)
    groups.value = groups.value.map(item => (item.id === group.id ? group : item))
  }

  async function removeGroup(id: string): Promise<void> {
    await deleteGroup(id)
    groups.value = groups.value.filter(item => item.id !== id)
    // The server keeps the profiles and clears their groupId; mirror that locally.
    items.value = items.value.map(item => (item.groupId === id ? { ...item, groupId: null } : item))
  }

  async function assignGroup(profileIds: string[], groupId: string | null): Promise<void> {
    const updated = await Promise.all(profileIds.map(id => updateProfile(id, { groupId })))
    for (const profile of updated) upsert(profile)
  }

  /* ------------------------------------------------------------------------- batch */

  let batchCancelled = false

  function cancelBatch(): void {
    batchCancelled = true
  }

  /**
   * Launch `ids` one at a time, `BATCH_STAGGER_MS` apart. A profile that is already running is
   * skipped rather than reported as a failure.
   */
  async function batchStart(
    ids: string[],
    isActive: (id: string) => boolean,
    onProgress: (done: number, total: number) => void,
  ): Promise<BatchStartResult> {
    batchCancelled = false
    const total = ids.length
    const result: BatchStartResult = { started: 0, skipped: 0, failed: 0, cancelled: false }

    for (let index = 0; index < total; index += 1) {
      if (batchCancelled) {
        result.cancelled = true
        break
      }
      const id = ids[index]
      if (id === undefined) continue
      if (isActive(id)) {
        result.skipped += 1
      } else {
        try {
          await launchProfile(id)
          result.started += 1
        } catch {
          result.failed += 1
        }
      }
      onProgress(index + 1, total)
      if (index < total - 1 && !batchCancelled) await sleep(BATCH_STAGGER_MS)
    }

    return result
  }

  async function batchStop(ids: string[]): Promise<number> {
    let stopped = 0
    for (const id of ids) {
      try {
        await stopProfile(id)
        stopped += 1
      } catch {
        // A profile that is already gone is not an error worth interrupting the batch for.
      }
    }
    return stopped
  }

  function describeBatch(result: BatchStartResult): string {
    if (result.cancelled) return t('profiles.batch.cancelled', { done: result.started })
    return t('profiles.batch.startDone', {
      started: result.started,
      skipped: result.skipped,
      failed: result.failed,
    })
  }

  return {
    items,
    groups,
    loading,
    loaded,
    error,
    byId,
    groupName,
    upsert,
    load,
    create,
    update,
    remove,
    clone,
    launch,
    stop,
    exportOne,
    importOne,
    addGroup,
    renameGroupTo,
    removeGroup,
    assignGroup,
    batchStart,
    batchStop,
    cancelBatch,
    describeBatch,
  }
})
