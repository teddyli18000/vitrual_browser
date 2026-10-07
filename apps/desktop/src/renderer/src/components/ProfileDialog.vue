<script setup lang="ts">
import type { Group, Profile } from '@vfox/shared'
import { ElMessage } from 'element-plus'
import { computed, ref, watch } from 'vue'
import { errorMessage } from '../api/http'
import {
  autoCount,
  draftFrom,
  emptyDraft,
  type ProfileDraft,
  payloadFrom,
} from '../forms/profile-draft'
import { t } from '../i18n'
import { useKernelStore } from '../stores/kernel'
import { useProfilesStore } from '../stores/profiles'
import AutoField from './AutoField.vue'
import ProxyFields from './ProxyFields.vue'

const props = defineProps<{
  modelValue: boolean
  profile: Profile | null
  groups: Group[]
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  saved: [profile: Profile]
}>()

const store = useProfilesStore()
const kernel = useKernelStore()
const draft = ref<ProfileDraft>(emptyDraft())
const activeTab = ref('basic')
const saving = ref(false)
const testing = ref(false)
const testResult = ref<{ ok: boolean; message: string } | null>(null)

const isEdit = computed(() => props.profile !== null)
const autoTotal = computed(() => autoCount(draft.value))

watch(
  () => props.modelValue,
  open => {
    if (!open) return
    draft.value = props.profile ? draftFrom(props.profile) : emptyDraft()
    activeTab.value = 'basic'
    testResult.value = null
  },
)

async function save(): Promise<void> {
  if (draft.value.name.trim().length === 0) {
    activeTab.value = 'basic'
    ElMessage.warning(t('dialog.nameRequired'))
    return
  }
  const { payload, error } = payloadFrom(draft.value)
  if (error) {
    activeTab.value = 'advanced'
    ElMessage.error(t('dialog.invalidJson'))
    return
  }
  saving.value = true
  try {
    const saved =
      isEdit.value && props.profile
        ? await store.update(props.profile.id, payload)
        : await store.create(payload)
    ElMessage.success(
      isEdit.value
        ? t('dialog.saved', { name: saved.name })
        : t('dialog.created', { name: saved.name }),
    )
    emit('saved', saved)
    emit('update:modelValue', false)
  } catch (err) {
    ElMessage.error(errorMessage(err))
  } finally {
    saving.value = false
  }
}

async function testProxy(): Promise<void> {
  const proxy = draft.value.proxy
  if (proxy.host.trim().length === 0 || !proxy.port) {
    ElMessage.warning(t('proxy.incomplete'))
    return
  }
  testing.value = true
  try {
    const result = await window.vfox.probeProxy({
      host: proxy.host.trim(),
      port: Number(proxy.port),
    })
    testResult.value = {
      ok: result.ok,
      message: result.ok
        ? t('proxy.testOk', { ms: result.ms ?? 0 })
        : t('proxy.testFail', { reason: result.message }),
    }
  } catch (err) {
    testResult.value = { ok: false, message: t('proxy.testFail', { reason: errorMessage(err) }) }
  } finally {
    testing.value = false
  }
}

function close(): void {
  emit('update:modelValue', false)
}
</script>

<template>
  <ElDialog
    :model-value="modelValue"
    :title="isEdit && profile ? t('dialog.title.edit', { name: profile.name }) : t('dialog.title.create')"
    width="720px"
    top="6vh"
    :close-on-click-modal="false"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <ElTabs v-model="activeTab" class="tabs">
      <ElTabPane :label="t('dialog.tab.basic')" name="basic">
        <div class="grid">
          <label class="field span-2">
            <span class="field-label">{{ t('field.name') }} <em>*</em></span>
            <ElInput v-model="draft.name" :placeholder="t('field.namePlaceholder')" maxlength="120" />
          </label>

          <label class="field">
            <span class="field-label">{{ t('field.group') }}</span>
            <ElSelect v-model="draft.groupId" clearable :placeholder="t('field.groupPlaceholder')">
              <ElOption v-for="group in groups" :key="group.id" :label="group.name" :value="group.id" />
            </ElSelect>
          </label>

          <label class="field">
            <span class="field-label">{{ t('field.startUrl') }}</span>
            <ElInput v-model="draft.startUrl" :placeholder="t('field.startUrlPlaceholder')" />
          </label>

          <label class="field span-2">
            <span class="field-label">{{ t('field.notes') }}</span>
            <ElInput
              v-model="draft.notes"
              type="textarea"
              :rows="2"
              :placeholder="t('field.notesPlaceholder')"
              maxlength="4000"
            />
          </label>

          <div class="field span-2 row">
            <ElSwitch v-model="draft.headless" />
            <div>
              <div class="field-label">{{ t('field.headless') }}</div>
              <div class="hint">{{ t('field.headlessHint') }}</div>
            </div>
          </div>

          <!--
            The engine pin. `null` means "not chosen here", which the payload omits rather than sends:
            on create that lets the server pin the current default, and on edit it leaves the existing
            pin alone. Un-pinning is deliberately not offered — it is an act with an API and a CLI
            behind it, and this form must not be able to re-point a working fleet by accident.
          -->
          <div class="field span-2">
            <span class="field-label">{{ t('field.kernel') }}</span>
            <ElSelect
              v-model="draft.kernel"
              clearable
              :placeholder="
                kernel.defaultVersion
                  ? t('field.kernelFollowDefault', { version: kernel.defaultVersion })
                  : t('field.kernelNoEngine')
              "
            >
              <ElOption
                v-for="entry in kernel.kernels"
                :key="entry.version"
                :label="
                  entry.isDefault
                    ? t('field.kernelOptionDefault', { version: entry.version })
                    : entry.version
                "
                :value="entry.version"
                :disabled="entry.problem !== null"
              />
            </ElSelect>
            <div class="hint">{{ t('field.kernelHint') }}</div>
            <div v-if="profile && profile.kernel" class="hint err">{{ t('field.kernelChangeWarning') }}</div>
          </div>
        </div>
      </ElTabPane>

      <ElTabPane :label="t('dialog.tab.fingerprint')" name="fingerprint">
        <div class="auto-summary">
          <span class="vfox-auto-tag">{{ t('common.auto') }}</span>
          <span class="hint">{{ t('common.autoTip') }}</span>
          <span class="hint">· {{ t('fp.summaryAuto', { n: autoTotal }) }}</span>
        </div>

        <div class="grid">
          <label class="field">
            <span class="field-label">{{ t('fp.os') }}</span>
            <ElSelect v-model="draft.os">
              <ElOption :label="t('os.windows')" value="windows" />
              <ElOption :label="t('os.macos')" value="macos" />
              <ElOption :label="t('os.linux')" value="linux" />
            </ElSelect>
            <span class="hint">{{ t('fp.osHint') }}</span>
          </label>

          <AutoField v-model:auto="draft.screenAuto" :label="t('fp.screen')" :hint="t('fp.screenHint')">
            <div class="quad">
              <ElInputNumber v-model="draft.screen.minWidth" :min="320" :step="10" controls-position="right" />
              <ElInputNumber v-model="draft.screen.maxWidth" :min="320" :step="10" controls-position="right" />
              <ElInputNumber v-model="draft.screen.minHeight" :min="240" :step="10" controls-position="right" />
              <ElInputNumber v-model="draft.screen.maxHeight" :min="240" :step="10" controls-position="right" />
            </div>
          </AutoField>

          <AutoField v-model:auto="draft.windowAuto" :label="t('fp.window')">
            <div class="pair">
              <ElInputNumber v-model="draft.window.width" :min="320" :step="10" controls-position="right" />
              <ElInputNumber v-model="draft.window.height" :min="240" :step="10" controls-position="right" />
            </div>
          </AutoField>

          <AutoField v-model:auto="draft.webglAuto" :label="t('fp.webgl')" :hint="t('fp.webglHint')">
            <div class="stack">
              <ElInput v-model="draft.webgl.vendor" :placeholder="t('fp.webglVendor')" />
              <ElInput v-model="draft.webgl.renderer" :placeholder="t('fp.webglRenderer')" />
            </div>
          </AutoField>

          <AutoField v-model:auto="draft.fontsAuto" :label="t('fp.fonts')" :hint="t('fp.fontsHint')">
            <ElInput v-model="draft.fontsText" type="textarea" :rows="3" :placeholder="t('fp.fontsPlaceholder')" />
          </AutoField>

          <AutoField v-model:auto="draft.hardwareConcurrencyAuto" :label="t('fp.hardwareConcurrency')">
            <ElInputNumber v-model="draft.hardwareConcurrency" :min="1" :max="64" controls-position="right" />
          </AutoField>

          <!--
            `locale` spans both columns on purpose. Removing the deviceMemory control left an odd
            number of half-width fields, which would have left a visibly empty cell in the grid;
            a full-width locale field both fills it and suits values like "zh-CN,zh;q=0.9".
          -->
          <AutoField v-model:auto="draft.localeAuto" :label="t('fp.locale')" class="span-2">
            <ElInput v-model="draft.locale" :placeholder="t('fp.localePlaceholder')" />
          </AutoField>

          <AutoField v-model:auto="draft.userAgentAuto" :label="t('fp.userAgent')" class="span-2">
            <ElInput v-model="draft.userAgent" :placeholder="t('fp.userAgentPlaceholder')" />
          </AutoField>

          <div class="field span-2 row">
            <ElSwitch v-model="draft.geoip" />
            <div>
              <div class="field-label">{{ t('fp.geoip') }}</div>
              <div class="hint">{{ t('fp.geoipHint') }}</div>
            </div>
          </div>

          <div class="field span-2 row">
            <ElSwitch v-model="draft.humanize" />
            <div>
              <div class="field-label">{{ t('fp.humanize') }}</div>
              <div class="hint">{{ t('fp.humanizeHint') }}</div>
            </div>
          </div>
        </div>
      </ElTabPane>

      <ElTabPane :label="t('dialog.tab.proxy')" name="proxy">
        <div class="field row">
          <ElSwitch v-model="draft.proxyEnabled" />
          <div class="field-label">{{ t('proxy.enable') }}</div>
        </div>

        <ProxyFields
          v-model="draft.proxy"
          :disabled="!draft.proxyEnabled"
          :disabled-tip="t('proxy.enableTip')"
        />

        <div class="test-row">
          <ElTooltip
            :disabled="draft.proxyEnabled"
            :content="t('proxy.enableTip')"
            placement="top"
          >
            <span class="tip-wrap">
              <ElButton :loading="testing" :disabled="!draft.proxyEnabled" @click="testProxy">
                {{ testing ? t('proxy.testing') : t('proxy.test') }}
              </ElButton>
            </span>
          </ElTooltip>
          <span v-if="testResult" class="test-result" :class="{ ok: testResult.ok }">
            {{ testResult.message }}
          </span>
        </div>
        <div class="hint">{{ t('proxy.testNote') }}</div>
      </ElTabPane>

      <ElTabPane :label="t('dialog.tab.advanced')" name="advanced">
        <div class="grid">
          <div class="field row">
            <ElSwitch v-model="draft.blockImages" />
            <div>
              <div class="field-label">{{ t('adv.blockImages') }}</div>
              <div class="hint">{{ t('adv.blockImagesHint') }}</div>
            </div>
          </div>
          <div class="field row">
            <ElSwitch v-model="draft.blockWebrtc" />
            <div>
              <div class="field-label">{{ t('adv.blockWebrtc') }}</div>
              <div class="hint">{{ t('adv.blockWebrtcHint') }}</div>
            </div>
          </div>
          <div class="field row">
            <ElSwitch v-model="draft.blockWebgl" />
            <div>
              <div class="field-label">{{ t('adv.blockWebgl') }}</div>
              <div class="hint">{{ t('adv.blockWebglHint') }}</div>
            </div>
          </div>
          <div class="field row">
            <ElSwitch v-model="draft.disableCoop" />
            <div>
              <div class="field-label">{{ t('adv.disableCoop') }}</div>
              <div class="hint">{{ t('adv.disableCoopHint') }}</div>
            </div>
          </div>

          <label class="field span-2">
            <span class="field-label">{{ t('adv.config') }}</span>
            <ElInput
              v-model="draft.configText"
              type="textarea"
              :rows="6"
              class="vfox-mono"
              :placeholder="t('adv.configPlaceholder')"
            />
            <span class="hint">{{ t('adv.configHint') }}</span>
          </label>
        </div>
      </ElTabPane>
    </ElTabs>

    <template #footer>
      <ElButton @click="close">{{ t('common.cancel') }}</ElButton>
      <ElButton type="primary" :loading="saving" @click="save">{{ t('common.save') }}</ElButton>
    </template>
  </ElDialog>
</template>

<style scoped>
.tabs :deep(.el-tabs__header) {
  margin-bottom: 14px;
}

.grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px 18px;
  max-height: 52vh;
  overflow-y: auto;
  padding-right: 4px;
}

.grid.dim {
  opacity: 0.6;
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

.field-label em {
  color: #ef4444;
  font-style: normal;
}

.hint {
  font-size: 11px;
  line-height: 1.5;
  color: var(--vfox-muted);
}

.quad {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
}

.pair {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
}

.stack {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

/* A disabled control does not emit pointer events, so the tooltip needs a real box to hover. */
.tip-wrap {
  display: inline-block;
}

.auto-summary {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}

.test-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 16px;
}

.test-result {
  font-size: 12px;
  color: #b42318;
}

.test-result.ok {
  color: #15803d;
}
</style>
