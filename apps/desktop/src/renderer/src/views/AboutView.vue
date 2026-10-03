<script setup lang="ts">
import { HOMEPAGE, PRODUCT_NAME, PRODUCT_TAGLINE } from '@vfox/shared'
import { ElMessage } from 'element-plus'
import { t } from '../i18n'
import { useConnectionStore } from '../stores/connection'

const connection = useConnectionStore()

async function openHomepage(): Promise<void> {
  try {
    await window.vfox.openHomepage()
  } catch {
    ElMessage.error(t('common.copyFailed'))
  }
}
</script>

<template>
  <section class="view vfox-scroll">
    <div class="hero">
      <div class="mark">V</div>
      <div>
        <h1 class="title">{{ t('about.title') }}</h1>
        <div class="tagline vfox-muted">{{ PRODUCT_TAGLINE }}</div>
      </div>
    </div>

    <div class="card">
      <div class="kv">
        <span class="k">{{ t('about.version') }}</span>
        <span class="v vfox-mono">{{ connection.version }}</span>
      </div>
      <div class="kv">
        <span class="k">{{ t('about.license') }}</span>
        <span class="v">{{ t('about.licenseValue') }}</span>
      </div>
      <div class="kv">
        <span class="k">{{ t('about.homepage') }}</span>
        <span class="v">
          <ElButton link type="primary" @click="openHomepage">{{ HOMEPAGE }}</ElButton>
        </span>
      </div>
    </div>

    <div class="card">
      <div class="card-title">{{ t('about.components') }}</div>
      <ul class="list">
        <li>{{ t('about.comp.camoufox') }}</li>
        <li>{{ t('about.comp.camoufoxJs') }}</li>
        <li>{{ t('about.comp.playwright') }}</li>
      </ul>
    </div>

    <div class="card no-telemetry">
      <div class="card-title">{{ PRODUCT_NAME }} · {{ t('about.noTelemetry') }}</div>
      <div class="hint">{{ t('about.outbound') }}</div>
      <div class="hint">{{ t('about.freeForever') }}</div>
      <div class="hint">{{ t('about.portable') }}</div>
    </div>
  </section>
</template>

<style scoped>
.view {
  flex: 1;
  min-height: 0;
  padding: 14px 16px 20px;
}

.hero {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-bottom: 16px;
}

.mark {
  display: grid;
  place-items: center;
  width: 46px;
  height: 46px;
  border-radius: 12px;
  font-size: 22px;
  font-weight: 700;
  color: #fff;
  background: linear-gradient(140deg, #4a6cf7, #22c1c3);
}

.title {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
}

.tagline {
  font-size: 12px;
  margin-top: 2px;
}

.card {
  border: 1px solid var(--vfox-border);
  border-radius: 8px;
  background: var(--vfox-panel);
  padding: 14px 16px;
  margin-bottom: 12px;
  max-width: 860px;
}

.card-title {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 6px;
}

.kv {
  display: flex;
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

.list {
  margin: 0;
  padding-left: 18px;
  font-size: 12px;
  line-height: 1.9;
  color: #3d4351;
}

.no-telemetry {
  border-color: #c7e7d3;
  background: #f4fbf7;
}

.hint {
  font-size: 11px;
  color: var(--vfox-muted);
  line-height: 1.7;
}
</style>
