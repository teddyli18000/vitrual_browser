<script setup lang="ts">
import { t } from '../i18n'

defineProps<{
  label: string
  hint?: string
}>()

/** `true` means "let the engine generate this value" — the control is then greyed out. */
const auto = defineModel<boolean>('auto', { required: true })
</script>

<template>
  <div class="auto-field">
    <div class="head">
      <span class="label">{{ label }}</span>
      <ElSwitch v-model="auto" size="small" :active-text="t('common.auto')" />
    </div>
    <div class="control" :class="{ off: auto }">
      <slot />
    </div>
    <div v-if="hint" class="hint">{{ hint }}</div>
  </div>
</template>

<style scoped>
.auto-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-height: 22px;
}

.label {
  font-size: 12px;
  color: #4a5162;
}

.control {
  min-width: 0;
  transition: opacity 0.15s;
}

.control.off {
  opacity: 0.45;
  pointer-events: none;
}

.hint {
  font-size: 11px;
  line-height: 1.5;
  color: var(--vfox-muted);
}
</style>
