<script setup lang="ts">
/**
 * The six proxy inputs, shared by the single-profile dialog and the batch dialog so a proxy field
 * can only ever be fixed in one place.
 *
 * `disabled` is passed straight through to every control, and each control is wrapped in a tooltip
 * that explains *why* it is disabled — a greyed-out field with no explanation is the thing this
 * codebase avoids.
 */

import type { ProxyDraft } from '../forms/profile-draft'
import { t } from '../i18n'

defineProps<{ disabled?: boolean; disabledTip?: string }>()

const proxy = defineModel<ProxyDraft>({ required: true })
</script>

<template>
  <div class="proxy-grid" :class="{ dim: disabled }">
    <label class="field">
      <span class="field-label">{{ t('proxy.type') }}</span>
      <ElTooltip :disabled="!disabled" :content="disabledTip" placement="top">
        <span class="tip-wrap">
          <ElSelect v-model="proxy.type" :disabled="disabled">
            <ElOption label="HTTP" value="http" />
            <ElOption label="HTTPS" value="https" />
            <ElOption label="SOCKS5" value="socks5" />
          </ElSelect>
        </span>
      </ElTooltip>
    </label>

    <label class="field">
      <span class="field-label">{{ t('proxy.port') }}</span>
      <ElTooltip :disabled="!disabled" :content="disabledTip" placement="top">
        <span class="tip-wrap">
          <ElInputNumber
            v-model="proxy.port"
            :min="1"
            :max="65535"
            controls-position="right"
            :disabled="disabled"
          />
        </span>
      </ElTooltip>
    </label>

    <label class="field span-2">
      <span class="field-label">{{ t('proxy.host') }}</span>
      <ElTooltip :disabled="!disabled" :content="disabledTip" placement="top">
        <span class="tip-wrap">
          <ElInput
            v-model="proxy.host"
            :placeholder="t('proxy.hostPlaceholder')"
            :disabled="disabled"
          />
        </span>
      </ElTooltip>
    </label>

    <label class="field">
      <span class="field-label">{{ t('proxy.username') }}</span>
      <ElTooltip :disabled="!disabled" :content="disabledTip" placement="top">
        <span class="tip-wrap">
          <ElInput v-model="proxy.username" :disabled="disabled" autocomplete="off" />
        </span>
      </ElTooltip>
    </label>

    <label class="field">
      <span class="field-label">{{ t('proxy.password') }}</span>
      <ElTooltip :disabled="!disabled" :content="disabledTip" placement="top">
        <span class="tip-wrap">
          <ElInput
            v-model="proxy.password"
            type="password"
            show-password
            :disabled="disabled"
            autocomplete="new-password"
          />
        </span>
      </ElTooltip>
    </label>
  </div>
</template>

<style scoped>
.proxy-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px 18px;
}

.proxy-grid.dim {
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

.field-label {
  font-size: 12px;
  color: #4a5162;
}

/* A disabled control does not emit pointer events, so the tooltip needs a real box to hover. */
.tip-wrap {
  display: block;
  width: 100%;
}
</style>
