<script setup lang="ts">
import {
  type CookieImportMode,
  type CookieImportResult,
  MAX_COOKIE_FILE_BYTES,
  type Profile,
} from '@vfox/shared'
import { ElMessage, ElMessageBox } from 'element-plus'
import { computed, ref, watch } from 'vue'
import type { ProfileUsage } from '../../../shared/bridge'
import { importCookies } from '../api/endpoints'
import { errorMessage } from '../api/http'
import { t } from '../i18n'
import { useProfilesStore } from '../stores/profiles'
import { useRuntimeStore } from '../stores/runtime'
import { formatBytes } from '../utils/format'
import StatusDot from './StatusDot.vue'

const props = defineProps<{
  modelValue: boolean
  profile: Profile | null
}>()

const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>()

const profiles = useProfilesStore()
const runtime = useRuntimeStore()

interface PickedFile {
  name: string
  size: number
  content: string
}

const visible = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit('update:modelValue', value),
})

const fileInput = ref<HTMLInputElement | null>(null)
const picked = ref<PickedFile | null>(null)
const mode = ref<CookieImportMode>('merge')
const busy = ref(false)
const stopping = ref(false)
const error = ref<string | null>(null)
const result = ref<CookieImportResult | null>(null)
/**
 * Whether the profile has a browser data directory at all. Loaded in the background: the walk is
 * bounded and cached, but it must never hold up the dialog — this only drives a warning.
 */
const usage = ref<ProfileUsage | null>(null)

/** The server accepts `stopped` and `error`; anything else owns the jar and answers 409. */
const running = computed(() => props.profile !== null && runtime.isActive(props.profile.id))

const submitBlockReason = computed(() => {
  if (busy.value) return ''
  if (running.value) return t('cookies.running.blocked')
  if (!picked.value) return t('cookies.import.pickFirst')
  return ''
})

const canSubmit = computed(
  () => !busy.value && !running.value && picked.value !== null && submitBlockReason.value === '',
)

watch(
  () => [props.modelValue, props.profile?.id] as const,
  ([open]) => {
    if (!open) return
    reset()
  },
  { immediate: true },
)

function reset(): void {
  picked.value = null
  mode.value = 'merge'
  busy.value = false
  error.value = null
  result.value = null
  usage.value = null
  void loadUsage()
}

async function loadUsage(): Promise<void> {
  const profile = props.profile
  if (!profile) return
  try {
    const measured = await window.vfox.profileUsage(profile.id)
    // A slow answer for a profile the user already navigated away from must not be shown.
    if (props.profile?.id === profile.id) usage.value = measured
  } catch {
    // The warning is a courtesy; the server stays the authority on whether an import can work.
  }
}

function pickFile(): void {
  fileInput.value?.click()
}

async function onFilePicked(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const chosen = input.files?.[0]
  // Clearing lets the same file be picked again after an error without a silent no-op.
  input.value = ''
  if (!chosen) return

  error.value = null
  if (chosen.size > MAX_COOKIE_FILE_BYTES) {
    picked.value = null
    error.value = t('cookies.import.tooLarge', { max: formatBytes(MAX_COOKIE_FILE_BYTES) })
    return
  }
  try {
    const content = await chosen.text()
    if (content.trim().length === 0) {
      picked.value = null
      error.value = t('cookies.import.emptyFile')
      return
    }
    picked.value = { name: chosen.name, size: chosen.size, content }
  } catch (err) {
    picked.value = null
    error.value = t('cookies.import.readFailed', { reason: errorMessage(err) })
  }
}

function chooseMode(value: string | number | boolean | undefined): void {
  if (value === 'merge' || value === 'replace') mode.value = value
}

async function stopProfile(): Promise<void> {
  const profile = props.profile
  if (!profile) return
  stopping.value = true
  try {
    await profiles.stop(profile.id)
    ElMessage.success(t('profiles.stopped', { name: profile.name }))
  } catch (err) {
    ElMessage.error(t('error.stopFailed', { name: profile.name, reason: errorMessage(err) }))
  } finally {
    stopping.value = false
  }
}

async function submit(): Promise<void> {
  const profile = props.profile
  const chosen = picked.value
  if (!profile || !chosen || !canSubmit.value) return

  // Replace deletes cookies the file does not contain, so it is confirmed rather than assumed.
  if (mode.value === 'replace') {
    try {
      await ElMessageBox.confirm(
        t('cookies.import.replaceConfirm.body', { name: profile.name }),
        t('cookies.import.replaceConfirm.title'),
        {
          confirmButtonText: t('cookies.import.replaceConfirm.ok'),
          cancelButtonText: t('common.cancel'),
          type: 'warning',
        },
      )
    } catch {
      return
    }
  }

  busy.value = true
  error.value = null
  try {
    result.value = await importCookies(profile.id, { content: chosen.content, mode: mode.value })
  } catch (err) {
    error.value = t('cookies.import.failed', { reason: errorMessage(err) })
  } finally {
    busy.value = false
  }
}

function again(): void {
  const keepMode = mode.value
  reset()
  mode.value = keepMode
}
</script>

<template>
  <ElDialog
    v-model="visible"
    :title="t('cookies.import.title')"
    width="680px"
    :close-on-click-modal="false"
    :close-on-press-escape="!busy"
    :show-close="!busy"
  >
    <template v-if="profile">
      <!-- The result: the counts first, then every line the importer refused to guess at. -->
      <template v-if="result">
        <ElAlert
          :type="result.skipped.length > 0 ? 'warning' : 'success'"
          :closable="false"
          show-icon
          :title="
            result.skipped.length > 0
              ? t('cookies.import.donePartial', { n: result.skipped.length })
              : t('cookies.import.done')
          "
        >
          <div class="stats">
            <span class="stat">
              <b>{{ result.parsed }}</b>
              {{ t('cookies.result.parsed') }}
            </span>
            <span class="stat">
              <b>{{ result.written }}</b>
              {{ t('cookies.result.written') }}
            </span>
            <span class="stat">
              <b>{{ result.updated }}</b>
              {{ t('cookies.result.updated') }}
            </span>
            <span v-if="result.mode === 'replace'" class="stat">
              <b>{{ result.removed }}</b>
              {{ t('cookies.result.removed') }}
            </span>
            <span class="stat mode">
              {{
                result.mode === 'replace'
                  ? t('cookies.import.mode.replace')
                  : t('cookies.import.mode.merge')
              }}
            </span>
          </div>
          <div class="hint">{{ t('cookies.import.next') }}</div>
        </ElAlert>

        <div v-if="result.skipped.length > 0" class="skips">
          <div class="skips-head">
            <span class="skips-title">{{ t('cookies.skip.title') }}</span>
            <span class="hint">{{ t('cookies.skip.hint') }}</span>
          </div>
          <ElTable :data="result.skipped" class="vfox-table" size="small" max-height="220">
            <ElTableColumn :label="t('cookies.skip.line')" width="72">
              <template #default="{ row }">
                <span :class="{ 'vfox-muted': row.line === null }">
                  {{ row.line ?? t('cookies.skip.unknownLine') }}
                </span>
              </template>
            </ElTableColumn>
            <ElTableColumn
              prop="detail"
              :label="t('cookies.skip.detail')"
              min-width="200"
              show-overflow-tooltip
            />
            <ElTableColumn
              prop="reason"
              :label="t('cookies.skip.reason')"
              min-width="220"
              show-overflow-tooltip
            />
          </ElTable>
        </div>
      </template>

      <template v-else>
        <!-- What the user must know before trying, not after: format, stopped, and what is lost. -->
        <ElAlert
          class="block"
          type="info"
          :closable="false"
          show-icon
          :title="t('cookies.import.facts')"
        >
          <ul class="facts">
            <li>{{ t('cookies.import.fact.format') }}</li>
            <li>{{ t('cookies.import.fact.stopped') }}</li>
            <li>{{ t('cookies.import.fact.lossy') }}</li>
          </ul>
        </ElAlert>

        <div class="row">
          <StatusDot :status="runtime.statusOf(profile.id)" />
          <span class="name">{{ profile.name }}</span>
          <span class="spacer" />
          <ElButton
            v-if="running"
            type="warning"
            plain
            size="small"
            :loading="stopping"
            @click="stopProfile"
          >
            {{ t('cookies.running.stop') }}
          </ElButton>
        </div>

        <ElAlert
          v-if="running"
          class="block"
          type="warning"
          :closable="false"
          show-icon
          :title="t('cookies.running.title')"
          :description="t('cookies.running.body', { name: profile.name })"
        />

        <ElAlert
          v-else-if="usage && !usage.exists"
          class="block"
          type="warning"
          :closable="false"
          show-icon
          :title="t('cookies.import.noStore.title')"
          :description="t('cookies.import.noStore.body')"
        />

        <div class="row">
          <ElButton @click="pickFile">
            {{ picked ? t('cookies.import.rechoose') : t('cookies.import.choose') }}
          </ElButton>
          <span v-if="picked" class="file">
            {{ picked.name }}
            <span class="vfox-muted">· {{ formatBytes(picked.size) }}</span>
          </span>
          <span v-else class="vfox-muted">{{ t('cookies.import.noFile') }}</span>
        </div>

        <div class="modes">
          <div class="label">{{ t('cookies.import.mode') }}</div>
          <ElRadioGroup :model-value="mode" @change="chooseMode($event)">
            <ElRadioButton value="merge">{{ t('cookies.import.mode.merge') }}</ElRadioButton>
            <ElRadioButton value="replace">{{ t('cookies.import.mode.replace') }}</ElRadioButton>
          </ElRadioGroup>
          <div class="hint">
            {{
              mode === 'merge'
                ? t('cookies.import.mode.mergeHint')
                : t('cookies.import.mode.replaceHint')
            }}
          </div>
        </div>

        <div v-if="error" class="error">{{ error }}</div>
      </template>
    </template>

    <template #footer>
      <template v-if="result">
        <ElButton @click="visible = false">{{ t('common.close') }}</ElButton>
        <ElButton type="primary" @click="again">{{ t('cookies.import.again') }}</ElButton>
      </template>
      <template v-else>
        <ElButton :disabled="busy" @click="visible = false">{{ t('common.cancel') }}</ElButton>
        <ElTooltip
          :content="submitBlockReason"
          :disabled="submitBlockReason === ''"
          placement="top"
        >
          <span class="tip-wrap">
            <ElButton type="primary" :disabled="!canSubmit" :loading="busy" @click="submit">
              {{ busy ? t('cookies.import.submitting') : t('cookies.import.submit') }}
            </ElButton>
          </span>
        </ElTooltip>
      </template>
    </template>

    <input
      ref="fileInput"
      class="file-input"
      type="file"
      accept=".txt,text/plain"
      @change="onFilePicked"
    />
  </ElDialog>
</template>

<style scoped>
.block {
  margin-bottom: 12px;
}

.facts {
  margin: 0;
  padding-left: 18px;
  font-size: 12px;
  line-height: 1.7;
}

.row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
}

.row .spacer {
  flex: 1;
}

.name {
  font-weight: 500;
}

.file {
  font-size: 12px;
  word-break: break-all;
}

.modes {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.label {
  font-size: 12px;
  color: var(--vfox-muted);
}

.hint {
  font-size: 11px;
  color: var(--vfox-muted);
  line-height: 1.6;
}

.error {
  margin-top: 12px;
  padding: 8px 10px;
  border: 1px solid #fecdca;
  border-radius: 6px;
  background: #fef3f2;
  font-size: 12px;
  color: #b42318;
  line-height: 1.6;
  word-break: break-word;
}

.stats {
  display: flex;
  align-items: baseline;
  gap: 16px;
  flex-wrap: wrap;
  margin-bottom: 4px;
}

.stat {
  font-size: 12px;
  color: #3b4a6b;
}

.stat b {
  font-size: 15px;
  margin-right: 4px;
  font-variant-numeric: tabular-nums;
}

.stat.mode {
  margin-left: auto;
}

.skips {
  margin-top: 12px;
}

.skips-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 6px;
}

.skips-title {
  font-size: 13px;
  font-weight: 600;
}

.tip-wrap {
  display: inline-block;
}

/* The real picker is the OS dialog; this input only exists to open it. */
.file-input {
  display: none;
}
</style>
