<script setup lang="ts">
/**
 * 批量创建环境 — the GUI for `POST /api/v1/profiles/batch`.
 *
 * Builds exactly what `ProfileBatchCreateSchema` accepts and nothing more: count, namePrefix,
 * groupId, and the three optional shared constraints (proxy, launch, a partial fingerprint).
 *
 * Two backend properties drive the copy and the flow, and the UI must not paper over either:
 *  - **All or nothing.** A failure leaves the store untouched, so the error says "nothing was
 *    created" instead of showing a partial count, and the dialog stays open so the input is kept.
 *  - **The cap is 50** because every profile is a real browser window with its own engine process.
 *    It is enforced here as well as by zod, so the user cannot type 500 and then meet a schema error.
 */

import type { OsTarget, ProfileBatchCreate } from '@vfox/shared'
import { MAX_BATCH_PROFILES } from '@vfox/shared'
import { ElMessage } from 'element-plus'
import { computed, ref, watch } from 'vue'
import { errorMessage } from '../api/http'
import { DEFAULT_PROXY, type ProxyDraft } from '../forms/profile-draft'
import { t } from '../i18n'
import { useProfilesStore } from '../stores/profiles'
import ProxyFields from './ProxyFields.vue'

const props = defineProps<{
  modelValue: boolean
  groups: { id: string; name: string }[]
}>()

const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>()

const store = useProfilesStore()

const count = ref(10)
const namePrefix = ref('')
const groupId = ref<string | null>(null)

const proxyEnabled = ref(false)
const proxy = ref<ProxyDraft>({ ...DEFAULT_PROXY })

const launchEnabled = ref(false)
const headless = ref(false)
const startUrl = ref('')

const fingerprintEnabled = ref(false)
const os = ref<OsTarget>('windows')

const creating = ref(false)

const prefix = computed(() => namePrefix.value.trim())
const prefixTooLong = computed(() => prefix.value.length > 80)
const countInRange = computed(
  () => Number.isInteger(count.value) && count.value >= 1 && count.value <= MAX_BATCH_PROFILES,
)
const ready = computed(() => prefix.value.length > 0 && !prefixTooLong.value && countInRange.value)

/** Exactly the names the server will produce: `<prefix> <index>` starting at 1. */
const names = computed(() =>
  prefix.value.length === 0 || !countInRange.value
    ? []
    : Array.from({ length: count.value }, (_, index) => `${prefix.value} ${index + 1}`),
)

const submitTip = computed(() => {
  if (prefixTooLong.value) return t('batch.namePrefixTooLong')
  if (prefix.value.length === 0) return t('batch.namePrefixRequired')
  if (!countInRange.value) return t('batch.countRange')
  return t('batch.submitTip')
})

const groupName = computed(
  () => props.groups.find(group => group.id === groupId.value)?.name ?? t('batch.groupNone'),
)

watch(
  () => props.modelValue,
  open => {
    if (open) return
    creating.value = false
  },
)

function payload(): ProfileBatchCreate {
  return {
    count: count.value,
    namePrefix: prefix.value,
    groupId: groupId.value,
    ...(proxyEnabled.value
      ? {
          proxy: {
            type: proxy.value.type,
            host: proxy.value.host.trim(),
            port: Number(proxy.value.port),
            ...(proxy.value.username.trim() ? { username: proxy.value.username.trim() } : {}),
            ...(proxy.value.password ? { password: proxy.value.password } : {}),
          },
        }
      : {}),
    ...(launchEnabled.value
      ? {
          launch: {
            headless: headless.value,
            startUrl: startUrl.value.trim().length > 0 ? startUrl.value.trim() : null,
          },
        }
      : {}),
    ...(fingerprintEnabled.value ? { fingerprint: { os: os.value } } : {}),
  }
}

async function submit(): Promise<void> {
  if (!ready.value || creating.value) return
  creating.value = true
  try {
    const created = await store.createBatch(payload())
    ElMessage.success(t('batch.created', { n: created.length }))
    emit('update:modelValue', false)
  } catch (err) {
    // All or nothing: never report a partial count, and keep the dialog so the input survives.
    ElMessage.error(t('batch.failed', { reason: errorMessage(err) }))
  } finally {
    creating.value = false
  }
}
</script>

<template>
  <ElDialog
    :model-value="modelValue"
    :title="t('batch.title')"
    width="720px"
    top="6vh"
    :close-on-click-modal="false"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <div class="body">
      <div class="grid">
        <label class="field">
          <span class="field-label">{{ t('batch.count') }}</span>
          <ElInputNumber
            v-model="count"
            :min="1"
            :max="MAX_BATCH_PROFILES"
            :step="1"
            step-strictly
            controls-position="right"
            class="count-input"
          />
          <span class="hint">{{ t('batch.countHint') }}</span>
        </label>

        <label class="field">
          <span class="field-label">{{ t('batch.group') }}</span>
          <ElSelect v-model="groupId" clearable :placeholder="t('batch.groupNone')">
            <ElOption :label="t('batch.groupNone')" :value="null" />
            <ElOption v-for="group in groups" :key="group.id" :label="group.name" :value="group.id" />
          </ElSelect>
        </label>

        <label class="field span-2">
          <span class="field-label">{{ t('batch.namePrefix') }}</span>
          <ElInput
            v-model="namePrefix"
            :placeholder="t('batch.namePrefixPlaceholder')"
            maxlength="80"
            show-word-limit
          />
          <span class="hint">{{ t('batch.namePrefixHint') }}</span>
        </label>
      </div>

      <div class="section">
        <div class="section-head">
          <ElSwitch v-model="proxyEnabled" />
          <div>
            <div class="field-label">{{ t('batch.proxyEnable') }}</div>
            <div class="hint">{{ t('batch.proxyHint') }}</div>
          </div>
        </div>
        <ProxyFields
          v-model="proxy"
          :disabled="!proxyEnabled"
          :disabled-tip="t('batch.proxyDisabledTip')"
        />
      </div>

      <div class="section">
        <div class="section-head">
          <ElSwitch v-model="launchEnabled" />
          <div>
            <div class="field-label">{{ t('batch.launchEnable') }}</div>
            <div class="hint">{{ t('batch.launchHint') }}</div>
          </div>
        </div>
        <div class="grid">
          <div class="field row">
            <ElTooltip
              :disabled="launchEnabled"
              :content="t('batch.launchDisabledTip')"
              placement="top"
            >
              <span class="tip-wrap">
                <ElSwitch v-model="headless" :disabled="!launchEnabled" />
              </span>
            </ElTooltip>
            <div>
              <div class="field-label">{{ t('field.headless') }}</div>
              <div class="hint">{{ t('field.headlessHint') }}</div>
            </div>
          </div>
          <label class="field">
            <span class="field-label">{{ t('field.startUrl') }}</span>
            <ElTooltip
              :disabled="launchEnabled"
              :content="t('batch.launchDisabledTip')"
              placement="top"
            >
              <span class="tip-wrap">
                <ElInput
                  v-model="startUrl"
                  :placeholder="t('field.startUrlPlaceholder')"
                  :disabled="!launchEnabled"
                />
              </span>
            </ElTooltip>
          </label>
        </div>
      </div>

      <div class="section">
        <div class="section-head">
          <ElSwitch v-model="fingerprintEnabled" />
          <div>
            <div class="field-label">{{ t('batch.fingerprintEnable') }}</div>
            <div class="hint">{{ t('batch.fingerprintHint') }}</div>
          </div>
        </div>
        <label class="field os-field">
          <span class="field-label">{{ t('fp.os') }}</span>
          <ElTooltip
            :disabled="fingerprintEnabled"
            :content="t('batch.fingerprintDisabledTip')"
            placement="top"
          >
            <span class="tip-wrap">
              <ElSelect v-model="os" :disabled="!fingerprintEnabled">
                <ElOption :label="t('os.windows')" value="windows" />
                <ElOption :label="t('os.macos')" value="macos" />
                <ElOption :label="t('os.linux')" value="linux" />
              </ElSelect>
            </span>
          </ElTooltip>
        </label>
      </div>

      <div class="preview">
        <div class="preview-head">
          <span class="field-label">{{ t('batch.preview', { n: names.length }) }}</span>
          <ElTag v-if="ready" size="small" type="info" effect="plain">{{ groupName }}</ElTag>
        </div>
        <div v-if="names.length === 0" class="hint">{{ t('batch.previewEmpty') }}</div>
        <template v-else>
          <div class="chips">
            <span v-for="name in names" :key="name" class="chip">{{ name }}</span>
          </div>
          <div class="hint">{{ t('batch.previewNote', { n: names.length }) }}</div>
        </template>
      </div>

      <ElAlert type="info" :closable="false" show-icon :title="t('batch.note')" />
      <ElAlert
        class="warn"
        type="warning"
        :closable="false"
        show-icon
        :title="t('batch.allOrNothing')"
      />

      <!--
        Creating a batch is not instant: each profile gets its own browserforge-generated identity.
        The dialog stays open and says so, rather than looking frozen for twenty seconds.
      -->
      <div v-if="creating" class="creating">
        <ElProgress :percentage="100" :indeterminate="true" :duration="2" :stroke-width="8" />
        <div class="hint">{{ t('batch.creatingHint') }}</div>
      </div>
    </div>

    <template #footer>
      <ElTooltip :disabled="!creating" :content="t('batch.cancelTip')" placement="top">
        <span class="tip-wrap">
          <ElButton :disabled="creating" @click="emit('update:modelValue', false)">
            {{ t('common.cancel') }}
          </ElButton>
        </span>
      </ElTooltip>
      <ElTooltip :disabled="ready" :content="submitTip" placement="top">
        <span class="tip-wrap">
          <ElButton type="primary" :loading="creating" :disabled="!ready" @click="submit">
            {{ creating ? t('batch.creating', { n: count }) : t('batch.submit', { n: count }) }}
          </ElButton>
        </span>
      </ElTooltip>
    </template>
  </ElDialog>
</template>

<style scoped>
.body {
  display: flex;
  flex-direction: column;
  gap: 14px;
  max-height: 62vh;
  overflow-y: auto;
  padding-right: 4px;
}

.grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px 18px;
}

.span-2 {
  grid-column: span 2;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.field.row {
  flex-direction: row;
  align-items: flex-start;
  gap: 10px;
}

.field-label {
  font-size: 12px;
  color: #4a5162;
}

.hint {
  font-size: 11px;
  line-height: 1.5;
  color: var(--vfox-muted);
}

.count-input {
  width: 100%;
}

.os-field {
  max-width: 220px;
}

.section {
  border: 1px solid var(--vfox-border);
  border-radius: 8px;
  padding: 12px 14px;
}

.section-head {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  margin-bottom: 10px;
}

.preview {
  border: 1px solid var(--vfox-border);
  border-radius: 8px;
  background: #fafbfd;
  padding: 12px 14px;
}

.preview-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 8px;
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  max-height: 132px;
  overflow-y: auto;
}

.chip {
  padding: 2px 8px;
  border-radius: 10px;
  font-size: 12px;
  color: #3b4a6b;
  background: #eef1f8;
  white-space: nowrap;
}

.warn {
  margin-top: -4px;
}

.creating {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

/* A disabled control does not emit pointer events, so the tooltip needs a real box to hover. */
.tip-wrap {
  display: inline-block;
}
</style>
