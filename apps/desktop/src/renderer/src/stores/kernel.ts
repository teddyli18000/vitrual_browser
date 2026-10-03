import type { KernelInfo, KernelProgress } from '@vfox/shared'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { getKernel, installKernel } from '../api/endpoints'
import { errorMessage } from '../api/http'

const BUSY_PHASES: KernelProgress['phase'][] = ['checking', 'downloading', 'extracting']

/** Engine (Camoufox) status and install progress, the latter pushed on the `kernel` SSE event. */
export const useKernelStore = defineStore('kernel', () => {
  const info = ref<KernelInfo | null>(null)
  const progress = ref<KernelProgress | null>(null)
  const error = ref<string | null>(null)

  const busy = computed(() => progress.value !== null && BUSY_PHASES.includes(progress.value.phase))

  async function refresh(): Promise<void> {
    try {
      info.value = await getKernel()
      error.value = null
    } catch (err) {
      error.value = errorMessage(err)
    }
  }

  async function install(): Promise<void> {
    try {
      await installKernel()
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

  return { info, progress, error, busy, refresh, install, applyProgress }
})
