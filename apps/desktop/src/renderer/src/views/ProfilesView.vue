<script setup lang="ts">
import type { OsTarget, Profile } from '@vfox/shared'
import { ElMessage, ElMessageBox } from 'element-plus'
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { errorMessage } from '../api/http'
import BatchCreateDialog from '../components/BatchCreateDialog.vue'
import ProfileDetail from '../components/ProfileDetail.vue'
import ProfileDialog from '../components/ProfileDialog.vue'
import StatusDot from '../components/StatusDot.vue'
import { type MessageKey, t } from '../i18n'
import { useConnectionStore } from '../stores/connection'
import { useKernelStore } from '../stores/kernel'
import { usePrefsStore } from '../stores/prefs'
import { useProfilesStore } from '../stores/profiles'
import { useRuntimeStore } from '../stores/runtime'
import { formatRelative, proxyLabel } from '../utils/format'

const store = useProfilesStore()
const runtime = useRuntimeStore()
const kernel = useKernelStore()
const connection = useConnectionStore()
const prefs = usePrefsStore()
const router = useRouter()

const search = ref('')
const groupFilter = ref<string | null>(null)
const selected = ref<Profile[]>([])
const currentRow = ref<Profile | null>(null)
const dialogOpen = ref(false)
const batchOpen = ref(false)
const editing = ref<Profile | null>(null)
const searchInput = ref<{ focus: () => void } | null>(null)

const OS_KEY: Record<OsTarget, MessageKey> = {
  windows: 'os.windows',
  macos: 'os.macos',
  linux: 'os.linux',
}

const batching = ref(false)
const batchDone = ref(0)
const batchTotal = ref(0)

const filtered = computed(() => {
  const term = search.value.trim().toLowerCase()
  return store.items.filter(profile => {
    if (groupFilter.value === '__none__' && profile.groupId !== null) return false
    if (
      groupFilter.value &&
      groupFilter.value !== '__none__' &&
      profile.groupId !== groupFilter.value
    )
      return false
    if (term.length === 0) return true
    const haystack = [
      profile.name,
      profile.notes,
      proxyLabel(profile.proxy),
      store.groupName(profile.groupId),
    ]
      .join('\n')
      .toLowerCase()
    return haystack.includes(term)
  })
})

const hasProfiles = computed(() => store.items.length > 0)
const isFiltered = computed(() => search.value.trim().length > 0 || groupFilter.value !== null)
const kernelMissing = computed(() => kernel.info !== null && !kernel.info.installed)

const groupOptions = computed(() => [
  { value: '__none__', label: t('profiles.ungrouped') },
  ...store.groups.map(group => ({ value: group.id, label: group.name })),
])

function lastStarted(profile: Profile): string {
  return formatRelative(prefs.lastStartedOf(profile.id, runtime.startedAt(profile.id)))
}

/* ------------------------------------------------------------------------ actions */

function openCreate(): void {
  editing.value = null
  dialogOpen.value = true
}

function openEdit(profile: Profile): void {
  editing.value = profile
  dialogOpen.value = true
}

async function toggle(profile: Profile): Promise<void> {
  if (runtime.isActive(profile.id)) await stopOne(profile)
  else await startOne(profile)
}

async function startOne(profile: Profile): Promise<void> {
  try {
    await store.launch(profile.id)
    ElMessage.success(t('profiles.started', { name: profile.name }))
  } catch (err) {
    await reportLaunchFailure(profile, err)
  }
}

async function stopOne(profile: Profile): Promise<void> {
  try {
    await store.stop(profile.id)
    ElMessage.success(t('profiles.stopped', { name: profile.name }))
  } catch (err) {
    ElMessage.error(t('error.stopFailed', { name: profile.name, reason: errorMessage(err) }))
  }
}

/** Errors must name the next step: a missing engine is the one failure a user can fix alone. */
async function reportLaunchFailure(profile: Profile, err: unknown): Promise<void> {
  await kernel.refresh()
  if (kernelMissing.value) {
    try {
      await ElMessageBox.confirm(t('error.kernelMissing'), t('settings.kernel'), {
        confirmButtonText: t('error.goSettings'),
        cancelButtonText: t('common.cancel'),
        type: 'warning',
      })
      await router.push('/settings')
    } catch {
      // The user dismissed it; the banner at the top of the list stays visible.
    }
    return
  }
  ElMessage.error(t('error.launchFailed', { name: profile.name, reason: errorMessage(err) }))
}

async function cloneOne(profile: Profile): Promise<void> {
  try {
    const { value } = await ElMessageBox.prompt(
      t('profiles.clone.body', { name: profile.name }),
      t('profiles.clone.title'),
      {
        confirmButtonText: t('common.confirm'),
        cancelButtonText: t('common.cancel'),
        inputValue: `${profile.name} 副本`,
        inputPlaceholder: t('profiles.clone.nameLabel'),
      },
    )
    const created = await store.clone(profile.id, value)
    ElMessage.success(t('profiles.cloned', { name: created.name }))
  } catch (err) {
    if (err === 'cancel' || err === 'close') return
    ElMessage.error(t('error.cloneFailed', { reason: errorMessage(err) }))
  }
}

async function exportOne(profile: Profile): Promise<void> {
  const hide = ElMessage.info({ message: `${t('profiles.action.export')}…`, duration: 0 })
  try {
    const path = await store.exportOne(profile)
    if (path) ElMessage.success(t('profiles.export.done', { path }))
  } catch (err) {
    ElMessage.error(t('error.exportFailed', { reason: errorMessage(err) }))
  } finally {
    hide.close()
  }
}

async function importOne(): Promise<void> {
  const hide = ElMessage.info({ message: `${t('profiles.import')}…`, duration: 0 })
  try {
    const profile = await store.importOne()
    if (profile) ElMessage.success(t('profiles.import.done', { name: profile.name }))
  } catch (err) {
    ElMessage.error(t('error.importFailed', { reason: errorMessage(err) }))
  } finally {
    hide.close()
  }
}

/**
 * Deleting a profile destroys its browser data, so a profile that already owns a userdata
 * directory requires the name to be typed back. Nothing is ever removed silently.
 */
async function removeOne(profile: Profile): Promise<void> {
  const usage = await window.vfox.profileUsage(profile.id)
  const body = t('profiles.delete.body', { name: profile.name })
  try {
    if (usage.exists) {
      await ElMessageBox.prompt(
        t('profiles.delete.typeHint', { name: profile.name }),
        t('profiles.delete.title'),
        {
          confirmButtonText: t('common.delete'),
          cancelButtonText: t('common.cancel'),
          inputPlaceholder: profile.name,
          inputValidator: (value: string) =>
            value === profile.name || t('profiles.delete.mismatch'),
          type: 'warning',
        },
      )
    } else {
      await ElMessageBox.confirm(body, t('profiles.delete.title'), {
        confirmButtonText: t('common.delete'),
        cancelButtonText: t('common.cancel'),
        type: 'warning',
      })
    }
  } catch {
    return
  }

  try {
    await store.remove(profile.id)
    prefs.forget(profile.id)
    ElMessage.success(t('profiles.deleted', { name: profile.name }))
  } catch (err) {
    ElMessage.error(t('error.deleteFailed', { reason: errorMessage(err) }))
  }
}

/* -------------------------------------------------------------------------- batch */

async function batchStart(): Promise<void> {
  const ids = (selected.value.length > 0 ? selected.value : filtered.value)
    .filter(profile => !runtime.isActive(profile.id))
    .map(profile => profile.id)
  if (ids.length === 0) {
    ElMessage.info(t('profiles.batch.nothing'))
    return
  }
  batching.value = true
  batchDone.value = 0
  batchTotal.value = ids.length
  try {
    const result = await store.batchStart(
      ids,
      id => runtime.isActive(id),
      (done, total) => {
        batchDone.value = done
        batchTotal.value = total
      },
    )
    ElMessage.success(store.describeBatch(result))
  } finally {
    batching.value = false
  }
}

async function batchStop(): Promise<void> {
  const ids = (selected.value.length > 0 ? selected.value : filtered.value)
    .filter(profile => runtime.isActive(profile.id))
    .map(profile => profile.id)
  if (ids.length === 0) {
    ElMessage.info(t('profiles.batch.nothing'))
    return
  }
  const stopped = await store.batchStop(ids)
  ElMessage.success(t('profiles.batch.stopDone', { stopped }))
}

async function refresh(): Promise<void> {
  await store.load(false)
  try {
    await runtime.seed()
  } catch {
    // The SSE stream owns runtime state; a failed seed is not worth a toast.
  }
  void kernel.refresh()
}

/* ------------------------------------------------------------------------- keyboard */

function onKeydown(event: KeyboardEvent): void {
  if (event.ctrlKey && !event.shiftKey && !event.altKey) {
    const key = event.key.toLowerCase()
    if (key === 'n') {
      event.preventDefault()
      openCreate()
      return
    }
    if (key === 'f') {
      event.preventDefault()
      void nextTick(() => searchInput.value?.focus())
    }
  }
}

/** Enter on the focused row is the fastest path: no dialog, one keystroke to a running VM. */
function onTableEnter(): void {
  if (currentRow.value) void toggle(currentRow.value)
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
  void store.load()
  void kernel.refresh()
})

onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <section class="view">
    <header class="head">
      <h1 class="title">{{ t('profiles.title') }}</h1>
      <span class="count vfox-muted">{{ t('common.total', { n: filtered.length }) }}</span>
    </header>

    <div class="toolbar">
      <ElButton type="primary" @click="openCreate">
        {{ t('profiles.new') }}
        <span class="kbd">Ctrl+N</span>
      </ElButton>
      <ElTooltip
        :disabled="connection.state !== 'offline'"
        :content="t('batch.offlineTip')"
        placement="top"
      >
        <span class="tip-wrap">
          <ElButton :disabled="connection.state === 'offline'" @click="batchOpen = true">
            {{ t('batch.button') }}
          </ElButton>
        </span>
      </ElTooltip>
      <ElButton :disabled="batching || !connection.state || connection.state === 'offline'" @click="batchStart">
        {{ t('profiles.batchStart') }}
      </ElButton>
      <ElButton :disabled="batching || connection.state === 'offline'" @click="batchStop">
        {{ t('profiles.batchStop') }}
      </ElButton>
      <ElButton :disabled="connection.state === 'offline'" @click="importOne">
        {{ t('profiles.import') }}
      </ElButton>

      <span class="spacer" />

      <span v-if="selected.length > 0" class="selected vfox-muted">
        {{ t('profiles.selected', { n: selected.length }) }}
      </span>
      <ElInput
        ref="searchInput"
        v-model="search"
        class="search"
        clearable
        :placeholder="`${t('profiles.searchPlaceholder')}  Ctrl+F`"
      />
      <ElSelect v-model="groupFilter" class="group-filter" clearable :placeholder="t('profiles.groupAll')">
        <ElOption
          v-for="option in groupOptions"
          :key="option.value"
          :label="option.label"
          :value="option.value"
        />
      </ElSelect>
      <ElButton :disabled="connection.state === 'offline'" @click="refresh">
        {{ t('common.refresh') }}
      </ElButton>
    </div>

    <ElAlert
      v-if="kernelMissing"
      class="kernel-alert"
      type="warning"
      :closable="false"
      show-icon
      :title="t('error.kernelMissing')"
    >
      <template #default>
        <ElButton link type="primary" @click="router.push('/settings')">{{ t('error.goSettings') }}</ElButton>
      </template>
    </ElAlert>

    <div v-if="batching" class="batch-bar">
      <ElProgress
        :percentage="batchTotal > 0 ? Math.round((batchDone / batchTotal) * 100) : 0"
        :stroke-width="10"
        striped
        striped-flow
      />
      <span class="batch-text">{{ t('profiles.batch.progress', { done: batchDone, total: batchTotal }) }}</span>
      <ElButton size="small" @click="store.cancelBatch()">{{ t('profiles.batch.cancel') }}</ElButton>
    </div>

    <div class="table-wrap" tabindex="0" @keydown.enter.prevent="onTableEnter">
      <ElTable
        v-loading="store.loading && !store.loaded"
        :data="filtered"
        class="vfox-table"
        size="small"
        height="100%"
        row-key="id"
        highlight-current-row
        @selection-change="selected = $event"
        @current-change="currentRow = $event"
        @row-dblclick="toggle"
      >
        <ElTableColumn type="selection" width="42" />
        <ElTableColumn type="expand" width="34">
          <template #default="{ row }">
            <ProfileDetail :profile="row" />
          </template>
        </ElTableColumn>

        <ElTableColumn :label="t('profiles.col.status')" width="104">
          <template #default="{ row }">
            <StatusDot :status="runtime.statusOf(row.id)" />
          </template>
        </ElTableColumn>

        <ElTableColumn :label="t('profiles.col.name')" min-width="180" show-overflow-tooltip>
          <template #default="{ row }">
            <span class="name">{{ row.name }}</span>
            <span v-if="row.notes" class="notes vfox-muted">{{ row.notes }}</span>
          </template>
        </ElTableColumn>

        <ElTableColumn :label="t('profiles.col.group')" width="120" show-overflow-tooltip>
          <template #default="{ row }">
            <ElTag v-if="row.groupId" size="small" type="info" effect="plain">
              {{ store.groupName(row.groupId) || '—' }}
            </ElTag>
            <span v-else class="vfox-muted">—</span>
          </template>
        </ElTableColumn>

        <ElTableColumn :label="t('profiles.col.os')" width="92">
          <template #default="{ row }">{{ t(OS_KEY[row.fingerprint.os as OsTarget]) }}</template>
        </ElTableColumn>

        <ElTableColumn :label="t('profiles.col.proxy')" min-width="150" show-overflow-tooltip>
          <template #default="{ row }">
            <span v-if="row.proxy" class="vfox-mono">{{ proxyLabel(row.proxy) }}</span>
            <span v-else class="vfox-muted">—</span>
          </template>
        </ElTableColumn>

        <ElTableColumn :label="t('profiles.col.lastStarted')" width="128">
          <template #default="{ row }">
            <span :class="{ 'vfox-muted': !lastStarted(row) }">{{ lastStarted(row) || '—' }}</span>
          </template>
        </ElTableColumn>

        <ElTableColumn :label="t('profiles.col.actions')" width="196" fixed="right">
          <template #default="{ row }">
            <ElButton
              v-if="runtime.isActive(row.id)"
              link
              type="danger"
              size="small"
              @click="stopOne(row)"
            >
              {{ t('profiles.action.stop') }}
            </ElButton>
            <ElButton v-else link type="primary" size="small" @click="startOne(row)">
              {{ t('profiles.action.start') }}
            </ElButton>
            <ElButton link size="small" @click="openEdit(row)">{{ t('common.edit') }}</ElButton>
            <ElDropdown trigger="click">
              <ElButton link size="small">{{ t('profiles.action.more') }} ▾</ElButton>
              <template #dropdown>
                <ElDropdownMenu>
                  <ElDropdownItem @click="cloneOne(row)">{{ t('profiles.action.clone') }}</ElDropdownItem>
                  <ElDropdownItem @click="exportOne(row)">{{ t('profiles.action.export') }}</ElDropdownItem>
                  <ElDropdownItem divided @click="removeOne(row)">
                    {{ t('profiles.action.delete') }}
                  </ElDropdownItem>
                </ElDropdownMenu>
              </template>
            </ElDropdown>
          </template>
        </ElTableColumn>

        <template #empty>
          <div class="empty">
            <template v-if="isFiltered && hasProfiles">
              <div class="empty-title">{{ t('profiles.empty.filtered') }}</div>
              <div class="empty-desc">{{ t('profiles.empty.filteredDesc') }}</div>
            </template>
            <template v-else>
              <div class="empty-title">{{ t('profiles.empty.title') }}</div>
              <div class="empty-desc">{{ t('profiles.empty.desc') }}</div>
              <ElButton type="primary" @click="openCreate">{{ t('profiles.empty.action') }}</ElButton>
            </template>
          </div>
        </template>
      </ElTable>
    </div>

    <footer class="foot vfox-muted">{{ t('detail.startHint') }}</footer>

    <ProfileDialog v-model="dialogOpen" :profile="editing" :groups="store.groups" />
    <BatchCreateDialog v-model="batchOpen" :groups="store.groups" />
  </section>
</template>

<style scoped>
/* A disabled control does not emit pointer events, so the tooltip needs a real box to hover. */
.tip-wrap {
  display: inline-block;
}

.view {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  padding: 14px 16px 0;
}

.head {
  display: flex;
  align-items: baseline;
  gap: 10px;
}

.title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
}

.count {
  font-size: 12px;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 12px 0 10px;
}

.spacer {
  flex: 1;
}

.selected {
  font-size: 12px;
  white-space: nowrap;
}

.search {
  width: 230px;
}

.group-filter {
  width: 150px;
}

.kbd {
  margin-left: 6px;
  font-size: 10px;
  opacity: 0.75;
}

.kernel-alert {
  margin-bottom: 10px;
}

.batch-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 12px;
  margin-bottom: 10px;
  border: 1px solid #dbe3ff;
  border-radius: 8px;
  background: #f5f7ff;
}

.batch-bar :deep(.el-progress) {
  flex: 1;
}

.batch-text {
  font-size: 12px;
  color: #3b4a6b;
  white-space: nowrap;
}

.table-wrap {
  flex: 1;
  min-height: 0;
  border: 1px solid var(--vfox-border);
  border-radius: 8px;
  background: var(--vfox-panel);
  overflow: hidden;
  outline: none;
}

.name {
  font-weight: 500;
}

.notes {
  margin-left: 8px;
  font-size: 11px;
}

.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 56px 0 64px;
}

.empty-title {
  font-size: 14px;
  font-weight: 600;
}

.empty-desc {
  font-size: 12px;
  color: var(--vfox-muted);
  max-width: 420px;
  text-align: center;
  line-height: 1.7;
}

.foot {
  padding: 8px 2px 10px;
  font-size: 11px;
}
</style>
