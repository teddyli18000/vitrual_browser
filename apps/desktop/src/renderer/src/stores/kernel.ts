import type { KernelInfo, KernelProgress } from '@vfox/shared'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { getKernel, installKernel, removeKernel } from '../api/endpoints'
import { errorMessage } from '../api/http'

const BUSY_PHASES: KernelProgress['phase'][] = ['checking', 'downloading', 'extracting']

/** Engine (Camoufox) status and install progress, the latter pushed on the `kernel` SSE event. */
export const useKernelStore = defineStore('kernel', () => {
  const info = ref<KernelInfo | null>(null)
  const progress = ref<KernelProgress | null>(null)
  const error = ref<string | null>(null)

  const busy = computed(() => progress.value !== null && BUSY_PHASES.includes(progress.value.phase))

  /** Every kernel directory, including the ones that cannot be launched. */
  const kernels = computed(() => info.value?.kernels ?? [])
  /** The engine an unpinned profile and a new profile get. */
  const defaultVersion = computed(() => info.value?.defaultVersion ?? null)
  /** The versions this build was tested against and can therefore install. */
  const availableVersions = computed(() => info.value?.availableVersions ?? [])
  /** At least one usable kernel is installed. Not the same question as "this profile's pin is
   * installed" — see `resolveKernelForProfile` in the core, and `errorCodeOf` in the runtime store. */
  const installed = computed(() => info.value?.installed === true)

  async function refresh(): Promise<void> {
    try {
      info.value = await getKernel()
      error.value = null
    } catch (err) {
      error.value = errorMessage(err)
    }
  }

  async function install(version?: string): Promise<void> {
    try {
      await installKernel(version)
      progress.value = {
        phase: 'checking',
        percent: null,
        receivedBytes: null,
        totalBytes: null,
        message: null,
      }
    } catch (err) {
      error.value = errorMessage(err)
    }
  }

  /**
   * Remove one kernel. The refusal (409, naming the profiles that pin it) is returned rather than
   * swallowed, because that message IS the explanation — the caller shows it as-is.
   */
  async function remove(version: string): Promise<string | null> {
    try {
      info.value = await removeKernel(version)
      error.value = null
      return null
    } catch (err) {
      const message = errorMessage(err)
      error.value = message
      return message
    }
  }

  function applyProgress(next: KernelProgress): void {
    progress.value = next
    // `done` is the only reliable "re-read the status" signal: the download finishes on the
    // server's clock, not on a request we can await.
    if (next.phase === 'done') {
      void refresh()
      setTimeout(() => {
        progress.value = null
      }, 4000)
    }
    if (next.phase === 'error') error.value = next.message ?? '安装失败'
  }

  return {
    info,
    progress,
    error,
    busy,
    kernels,
    defaultVersion,
    availableVersions,
    installed,
    refresh,
    install,
    remove,
    applyProgress,
  }
})
