<script setup lang="ts">
import { ElMessage } from 'element-plus'
import { computed, onMounted, ref } from 'vue'
import { type Locale, locale, setLocale, t } from '../i18n'
import { useConnectionStore } from '../stores/connection'
import { useKernelStore } from '../stores/kernel'
import { copyText } from '../utils/clipboard'
import { formatBytes } from '../utils/format'

const connection = useConnectionStore()
const kernel = useKernelStore()

const showToken = ref(false)

const DATA_MODE_LABEL = {
  portable: 'settings.mode.portable',
  installed: 'settings.mode.installed',
  custom: 'settings.mode.custom',
} as const

const dataModeLabel = computed(() => t(DATA_MODE_LABEL[connection.dataMode]))
const dataModeTagType = computed(() =>
  connection.dataMode === 'portable'
    ? 'success'
    : connection.dataMode === 'custom'
      ? 'warning'
      : 'info',
)

const port = computed(() => {
  try {
    return new URL(connection.base).port || '—'
  } catch {
    return '—'
  }
})

const progressPercent = computed(() => {
  const progress = kernel.progress
  if (!progress) return 0
  if (progress.percent !== null) return Math.round(progress.percent)
  if (progress.phase === 'extracting' || progress.phase === 'done') return 100
  return 0
})

const progressText = computed(() => {
  const progress = kernel.progress
  if (!progress) return ''
  switch (progress.phase) {
    case 'checking':
      return t('settings.kernelChecking')
    case 'downloading':
      return progress.totalBytes
        ? `${t('settings.kernelDownloading', { percent: progressPercent.value })} · ${formatBytes(progress.receivedBytes ?? 0)} / ${formatBytes(progress.totalBytes)}`
        : t('settings.kernelDownloading', { percent: progressPercent.value })
    case 'extracting':
      return t('settings.kernelExtracting')
    case 'done':
      return t('settings.kernelDone')
    case 'error':
      return t('settings.kernelError', { reason: progress.message ?? '' })
    default:
      return ''
  }
})

async function openDataDir(): Promise<void> {
  const error = await window.vfox.openPath(connection.dataDir)
  if (error) ElMessage.error(error)
}

async function copy(value: string): Promise<void> {
  const ok = await copyText(value)
  if (ok) ElMessage.success(t('common.copied'))
  else ElMessage.error(t('common.copyFailed'))
}

async function install(): Promise<void> {
  await kernel.install()
  if (kernel.error) ElMessage.error(kernel.error)
  else ElMessage.info(t('settings.kernelStarted'))
}

function useLanguage(next: Locale): void {
  setLocale(next)
}

onMounted(() => {
  void kernel.refresh()
})
</script>

<template>
  <section class="view vfox-scroll">
    <h1 class="title">{{ t('settings.title') }}</h1>

    <div class="card">
      <div class="card-head">
        <div>
          <div class="card-title">{{ t('settings.dataDir') }}</div>
          <div class="hint">{{ t('settings.dataDirHint') }}</div>
        </div>
        <ElButton @click="openDataDir">{{ t('settings.open') }}</ElButton>
      </div>
      <div class="kv">
        <span class="k">{{ t('settings.dataMode') }}</span>
        <span class="v">
          <ElTag :type="dataModeTagType" size="small" effect="plain">{{ dataModeLabel }}</ElTag>
        </span>
      </div>
      <div class="mono vfox-mono">{{ connection.dataDir || '—' }}</div>
      <div v-if="connection.dataMode === 'portable'" class="hint">
        {{ t('settings.dataDirPortableHint') }}
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <div>
          <div class="card-title">{{ t('settings.api') }}</div>
          <div class="hint">{{ t('settings.apiHint') }}</div>
        </div>
        <ElTag :type="connection.state === 'online' ? 'success' : 'danger'" size="small" effect="plain">
          {{ connection.state === 'online' ? t('conn.online', { base: connection.base }) : t('conn.offline.title') }}
        </ElTag>
      </div>
      <div class="kv">
        <span class="k">{{ t('settings.apiPort') }}</span>
        <span class="v vfox-mono">{{ port }}</span>
      </div>
      <div class="kv">
        <span class="k">{{ t('settings.apiToken') }}</span>
        <span class="v vfox-mono token">
          {{ showToken ? connection.token || '—' : '••••••••••••••••' }}
        </span>
        <ElButton link size="small" @click="showToken = !showToken">
          {{ showToken ? t('settings.hideToken') : t('settings.showToken') }}
        </ElButton>
        <ElButton link size="small" @click="copy(connection.token)">{{ t('common.copy') }}</ElButton>
      </div>
      <div class="hint">{{ t('settings.apiTokenHint') }}</div>
    </div>

    <div class="card">
      <div class="card-head">
        <div>
          <div class="card-title">{{ t('settings.kernel') }}</div>
          <div class="hint">{{ t('settings.kernelHint') }}</div>
        </div>
        <ElButton type="primary" :loading="kernel.busy" :disabled="kernel.busy" @click="install">
          {{ kernel.busy ? t('settings.kernelInstalling') : t('settings.kernelInstall') }}
        </ElButton>
      </div>

      <div class="kv">
        <span class="k">{{ t('settings.kernelStatus') }}</span>
        <span class="v">
          <ElTag :type="kernel.info?.installed ? 'success' : 'warning'" size="small" effect="plain">
            {{ kernel.info?.installed ? t('settings.kernelInstalled') : t('settings.kernelMissing') }}
          </ElTag>
        </span>
      </div>
      <div class="kv">
        <span class="k">{{ t('settings.kernelVersion') }}</span>
        <span class="v vfox-mono">{{ kernel.info?.version || '—' }}</span>
      </div>
      <div class="kv">
        <span class="k">{{ t('settings.kernelPath') }}</span>
        <span class="v vfox-mono path">{{ kernel.info?.path || '—' }}</span>
      </div>

      <div v-if="kernel.progress" class="progress">
        <ElProgress
          :percentage="progressPercent"
          :status="kernel.progress.phase === 'error' ? 'exception' : kernel.progress.phase === 'done' ? 'success' : undefined"
          :indeterminate="kernel.progress.phase === 'checking'"
          :stroke-width="12"
        />
        <div class="hint" :class="{ err: kernel.progress.phase === 'error' }">{{ progressText }}</div>
      </div>
      <div v-else-if="kernel.error" class="hint err">{{ kernel.error }}</div>
    </div>

    <div class="card">
      <div class="card-head">
        <div>
          <div class="card-title">{{ t('settings.language') }}</div>
          <div class="hint">{{ t('settings.languageHint') }}</div>
        </div>
      </div>
      <ElRadioGroup :model-value="locale" @change="useLanguage($event as Locale)">
        <ElRadioButton value="zh-CN">简体中文</ElRadioButton>
        <ElRadioButton value="en">English</ElRadioButton>
      </ElRadioGroup>
    </div>
  </section>
</template>

<style scoped>
.view {
  flex: 1;
  min-height: 0;
  padding: 14px 16px 20px;
}

.title {
  margin: 0 0 12px;
  font-size: 15px;
  font-weight: 600;
}

.card {
  border: 1px solid var(--vfox-border);
  border-radius: 8px;
  background: var(--vfox-panel);
  padding: 14px 16px;
  margin-bottom: 12px;
  max-width: 860px;
}

.card-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 10px;
}

.card-title {
  font-size: 13px;
  font-weight: 600;
}

.hint {
  font-size: 11px;
  color: var(--vfox-muted);
  line-height: 1.6;
  margin-top: 2px;
}

.hint.err {
  color: #b42318;
}

.mono {
  padding: 7px 10px;
  border-radius: 6px;
  background: #f4f6fa;
  word-break: break-all;
}

.kv {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 4px 0;
  font-size: 12px;
}

.k {
  flex: 0 0 84px;
  color: var(--vfox-muted);
}

.v {
  min-width: 0;
  word-break: break-all;
}

.path {
  flex: 1;
}

.token {
  flex: 1;
}

.progress {
  margin-top: 12px;
}
</style>
