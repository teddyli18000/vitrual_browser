<script setup lang="ts">
import type { RuntimeStatus } from '@vfox/shared'
import { computed } from 'vue'
import { type MessageKey, t } from '../i18n'

const props = withDefaults(
  defineProps<{
    status: RuntimeStatus
    /** Optional short label next to the dot. */
    label?: boolean
  }>(),
  { label: true },
)

const STATUS_KEY: Record<RuntimeStatus, MessageKey> = {
  stopped: 'status.stopped',
  starting: 'status.starting',
  running: 'status.running',
  stopping: 'status.stopping',
  error: 'status.error',
}

const text = computed(() => t(STATUS_KEY[props.status]))
</script>

<template>
  <span class="status" :class="status">
    <span class="dot" />
    <span v-if="label" class="text">{{ text }}</span>
  </span>
</template>

<style scoped>
.status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  line-height: 1;
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--vfox-idle);
  flex: 0 0 8px;
}

.stopped .dot {
  background: var(--vfox-idle);
}

.running .dot {
  background: var(--vfox-ok);
}

.error .dot {
  background: var(--vfox-err);
}

/* The only animated state: `starting` is the one the user is waiting on. */
.starting .dot,
.stopping .dot {
  background: var(--vfox-warn);
}

.starting .dot {
  animation: pulse 1s ease-in-out infinite;
}

@keyframes pulse {
  0%,
  100% {
    opacity: 1;
    transform: scale(1);
  }
  50% {
    opacity: 0.35;
    transform: scale(0.72);
  }
}

.running .text {
  color: #15803d;
}

.error .text {
  color: #b42318;
}

.starting .text,
.stopping .text {
  color: #b45309;
}

.stopped .text {
  color: var(--vfox-muted);
}
</style>
