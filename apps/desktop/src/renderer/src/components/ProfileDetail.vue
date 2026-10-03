<script setup lang="ts">
import type { Profile } from '@vfox/shared'
import { ElMessage } from 'element-plus'
import { onMounted, ref } from 'vue'
import type { ProfileUsage } from '../../../shared/bridge'
import { t } from '../i18n'
import { usePrefsStore } from '../stores/prefs'
import { useRuntimeStore } from '../stores/runtime'
import { copyText } from '../utils/clipboard'
import { formatBytes, formatDateTime, formatRelative } from '../utils/format'

const props = defineProps<{ profile: Profile }>()

const runtime = useRuntimeStore()
const prefs = usePrefsStore()

const usage = ref<ProfileUsage | null>(null)
const measuring = ref(true)

onMounted(async () => {
  try {
    usage.value = await window.vfox.profileUsage(props.profile.id)
  } finally {
    measuring.value = false
  }
})

async function openDir(): Promise<void> {
  const dir = usage.value?.path || (await window.vfox.profileDir(props.profile.id)) || ''
  if (!dir) return
  const error = await window.vfox.openPath(dir)
  if (error) ElMessage.error(error)
}

async function revealDir(): Promise<void> {
  const dir = usage.value?.path
  if (!dir) return
  await window.vfox.revealPath(dir)
}

async function copyEndpoint(): Promise<void> {
  const endpoint = runtime.wsEndpoint(props.profile.id)
  if (!endpoint) return
  const ok = await copyText(endpoint)
  if (ok) ElMessage.success(t('common.copied'))
  else ElMessage.error(t('common.copyFailed'))
}
</script>

<template>
  <div class="detail">
    <div class="cell">
      <div class="k">{{ t('detail.dataDir') }}</div>
      <div class="v vfox-mono">{{ usage?.path || '—' }}</div>
      <div class="actions">
        <ElButton link type="primary" size="small" @click="openDir">{{ t('detail.openDir') }}</ElButton>
        <ElButton link size="small" @click="revealDir">
          {{ t('detail.revealDir') }}
        </ElButton>
      </div>
    </div>

    <div class="cell">
      <div class="k">{{ t('detail.usage') }}</div>
      <div class="v">
        <template v-if="measuring">{{ t('detail.usageLoading') }}</template>
        <template v-else-if="usage && usage.exists">
          {{ formatBytes(usage.bytes) }}
          <span class="vfox-muted"> · {{ t('detail.files', { n: usage.files }) }}</span>
        </template>
        <template v-else>
          <span class="vfox-muted">{{ t('detail.empty') }}</span>
        </template>
      </div>
    </div>

    <div class="cell">
      <div class="k">{{ t('detail.wsEndpoint') }}</div>
      <div v-if="runtime.wsEndpoint(profile.id)" class="v">
        <span class="vfox-mono endpoint">{{ runtime.wsEndpoint(profile.id) }}</span>
        <ElButton link type="primary" size="small" @click="copyEndpoint">
          {{ t('detail.copyEndpoint') }}
        </ElButton>
        <div class="hint">{{ t('detail.wsEndpointHint') }}</div>
      </div>
      <div v-else class="v vfox-muted">{{ t('detail.notRunning') }}</div>
    </div>

    <div class="cell">
      <div class="k">{{ t('detail.created') }} / {{ t('detail.updated') }}</div>
      <div class="v">{{ formatDateTime(profile.createdAt) }} · {{ formatDateTime(profile.updatedAt) }}</div>
    </div>

    <div class="cell">
      <div class="k">{{ t('profiles.col.lastStarted') }}</div>
      <div class="v">
        {{ formatRelative(prefs.lastStartedOf(profile.id, runtime.startedAt(profile.id))) || '—' }}
      </div>
    </div>

    <div v-if="profile.notes" class="cell span">
      <div class="k">{{ t('detail.notes') }}</div>
      <div class="v">{{ profile.notes }}</div>
    </div>

    <div v-if="runtime.lastError(profile.id)" class="cell span">
      <div class="k err">{{ t('detail.lastError') }}</div>
      <div class="v err">{{ runtime.lastError(profile.id) }}</div>
    </div>
  </div>
</template>

<style scoped>
.detail {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px 20px;
  padding: 12px 16px 14px 48px;
  background: #fafbfd;
  border-bottom: 1px solid var(--vfox-border);
}

.span {
  grid-column: 1 / -1;
}

.k {
  font-size: 11px;
  color: var(--vfox-muted);
  margin-bottom: 3px;
}

.k.err {
  color: #b42318;
}

.v {
  font-size: 12px;
  word-break: break-all;
  line-height: 1.6;
}

.v.err {
  color: #b42318;
}

.endpoint {
  display: inline-block;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  vertical-align: bottom;
}

.actions {
  margin-top: 2px;
}

.hint {
  font-size: 11px;
  color: var(--vfox-muted);
  margin-top: 2px;
}
</style>
