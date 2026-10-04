<script setup lang="ts">
import { ElConfigProvider } from 'element-plus'
import en from 'element-plus/es/locale/lang/en'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import { computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import ConnectionBanner from './components/ConnectionBanner.vue'
import { locale, t } from './i18n'
import { useConnectionStore } from './stores/connection'
import { useRuntimeStore } from './stores/runtime'
import { useSyncStore } from './stores/sync'

const connection = useConnectionStore()
const runtime = useRuntimeStore()
const sync = useSyncStore()
const route = useRoute()

const elementLocale = computed(() => (locale.value === 'zh-CN' ? zhCn : en))

const nav = computed(() => [
  { path: '/profiles', label: t('nav.profiles'), icon: 'Grid' },
  { path: '/sync', label: t('nav.sync'), icon: 'Connection' },
  { path: '/groups', label: t('nav.groups'), icon: 'FolderOpened' },
  { path: '/settings', label: t('nav.settings'), icon: 'Setting' },
  { path: '/about', label: t('nav.about'), icon: 'InfoFilled' },
])

onMounted(() => {
  void connection.connect()
})
</script>

<template>
  <ElConfigProvider :locale="elementLocale">
    <div class="shell">
      <aside class="sidebar">
        <div class="brand">
          <div class="brand-mark">V</div>
          <div class="brand-text">
            <div class="brand-name">{{ t('app.name') }}</div>
            <div class="brand-sub">{{ t('app.subtitle') }}</div>
          </div>
        </div>

        <nav class="nav">
          <RouterLink
            v-for="item in nav"
            :key="item.path"
            :to="item.path"
            class="nav-item"
            :class="{ active: route.path === item.path }"
          >
            <span>{{ item.label }}</span>
            <!-- Mirrored input is a global state: it stays visible from any view. -->
            <span v-if="item.path === '/sync' && sync.active" class="nav-live" />
          </RouterLink>
        </nav>

        <div class="sidebar-foot">
          <div class="foot-row">
            <span class="dot" :class="connection.state" />
            <span>{{ connection.state === 'online' ? t('conn.online', { base: connection.base }) : t('conn.offline.title') }}</span>
          </div>
          <div class="foot-row muted">
            {{ t('common.total', { n: runtime.activeCount }) }} · v{{ connection.version }}
          </div>
        </div>
      </aside>

      <main class="content">
        <ConnectionBanner />
        <RouterView />
      </main>
    </div>
  </ElConfigProvider>
</template>

<style scoped>
.shell {
  display: flex;
  height: 100vh;
  overflow: hidden;
}

.sidebar {
  display: flex;
  flex-direction: column;
  width: 208px;
  flex: 0 0 208px;
  background: var(--vfox-sidebar);
  color: #c8cede;
}

.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 16px 16px 14px;
}

.brand-mark {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border-radius: 8px;
  font-weight: 700;
  font-size: 15px;
  color: #fff;
  background: linear-gradient(140deg, #4a6cf7, #22c1c3);
}

.brand-name {
  font-size: 14px;
  font-weight: 600;
  color: #fff;
  line-height: 1.2;
}

.brand-sub {
  font-size: 11px;
  color: #7b8397;
}

.nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px;
  flex: 1;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-radius: 6px;
  font-size: 13px;
  color: #aab2c5;
  text-decoration: none;
  transition: background 0.15s, color 0.15s;
}

.nav-item:hover {
  background: var(--vfox-sidebar-hover);
  color: #e6e9f2;
}

.nav-item.active {
  background: var(--vfox-accent);
  color: #fff;
}

.nav-live {
  margin-left: auto;
  width: 7px;
  height: 7px;
  flex: 0 0 7px;
  border-radius: 50%;
  background: var(--vfox-ok);
  box-shadow: 0 0 0 2px rgba(34, 197, 94, 0.25);
  animation: nav-pulse 1.4s ease-in-out infinite;
}

@keyframes nav-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.35;
  }
}

.sidebar-foot {
  padding: 12px 14px 14px;
  border-top: 1px solid #2a3040;
  font-size: 11px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.foot-row {
  display: flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.foot-row.muted {
  color: #7b8397;
}

.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex: 0 0 7px;
  background: var(--vfox-idle);
}

.dot.online {
  background: var(--vfox-ok);
}

.dot.offline {
  background: var(--vfox-err);
}

.content {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
</style>
