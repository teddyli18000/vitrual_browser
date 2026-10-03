<script setup lang="ts">
import { computed } from 'vue'
import { t } from '../i18n'
import { useConnectionStore } from '../stores/connection'

const connection = useConnectionStore()
const visible = computed(() => connection.state === 'offline')
</script>

<template>
  <div v-if="visible" class="banner">
    <div class="banner-main">
      <div class="banner-title">{{ t('conn.offline.title') }}</div>
      <div class="banner-desc">{{ t('conn.offline.desc', { base: connection.base || '—' }) }}</div>
      <div v-if="connection.error || connection.serviceError" class="banner-reason">
        {{ t('conn.offline.reason', { reason: connection.error ?? connection.serviceError ?? '' }) }}
      </div>
    </div>
    <ElButton type="primary" :loading="connection.retrying" @click="connection.retry()">
      {{ connection.retrying ? t('conn.offline.retrying') : t('common.retry') }}
    </ElButton>
  </div>
</template>

<style scoped>
.banner {
  display: flex;
  align-items: center;
  gap: 16px;
  margin: 12px 16px 0;
  padding: 12px 16px;
  border: 1px solid #f3c9c9;
  border-radius: 8px;
  background: #fef4f4;
}

.banner-main {
  flex: 1;
  min-width: 0;
}

.banner-title {
  font-size: 13px;
  font-weight: 600;
  color: #b42318;
}

.banner-desc {
  margin-top: 2px;
  font-size: 12px;
  color: #7a271a;
  word-break: break-all;
}

.banner-reason {
  margin-top: 2px;
  font-size: 12px;
  color: #97564a;
  word-break: break-all;
}
</style>
