<script setup lang="ts">
import type { Group } from '@vfox/shared'
import { ElMessage, ElMessageBox } from 'element-plus'
import { computed, onMounted, ref } from 'vue'
import { errorMessage } from '../api/http'
import { t } from '../i18n'
import { useProfilesStore } from '../stores/profiles'

const store = useProfilesStore()

const assigning = ref<Group | null>(null)
const assignSelection = ref<string[]>([])
const assignSaving = ref(false)

const rows = computed(() =>
  store.groups.map(group => ({
    ...group,
    count: store.items.filter(profile => profile.groupId === group.id).length,
  })),
)

async function createGroup(): Promise<void> {
  try {
    const { value } = await ElMessageBox.prompt(t('groups.namePlaceholder'), t('groups.new'), {
      confirmButtonText: t('common.confirm'),
      cancelButtonText: t('common.cancel'),
      inputPlaceholder: t('groups.name'),
      inputValidator: (input: string) => input.trim().length > 0,
    })
    const group = await store.addGroup(value.trim())
    ElMessage.success(t('groups.created', { name: group.name }))
  } catch (err) {
    if (err === 'cancel' || err === 'close') return
    ElMessage.error(errorMessage(err))
  }
}

async function rename(group: Group): Promise<void> {
  try {
    const { value } = await ElMessageBox.prompt(group.name, t('groups.rename'), {
      confirmButtonText: t('common.confirm'),
      cancelButtonText: t('common.cancel'),
      inputPlaceholder: t('groups.name'),
      inputValue: group.name,
      inputValidator: (input: string) => input.trim().length > 0,
    })
    await store.renameGroupTo(group.id, value.trim())
    ElMessage.success(t('groups.renamed', { name: value.trim() }))
  } catch (err) {
    if (err === 'cancel' || err === 'close') return
    ElMessage.error(errorMessage(err))
  }
}

async function remove(group: Group): Promise<void> {
  try {
    await ElMessageBox.confirm(t('groups.deleteBody', { name: group.name }), t('common.delete'), {
      confirmButtonText: t('common.delete'),
      cancelButtonText: t('common.cancel'),
      type: 'warning',
    })
  } catch {
    return
  }
  try {
    await store.removeGroup(group.id)
    ElMessage.success(t('groups.deleted', { name: group.name }))
  } catch (err) {
    ElMessage.error(errorMessage(err))
  }
}

function openAssign(group: Group): void {
  assigning.value = group
  assignSelection.value = store.items.filter(profile => profile.groupId === group.id).map(p => p.id)
}

async function saveAssign(): Promise<void> {
  const group = assigning.value
  if (!group) return
  assignSaving.value = true
  try {
    const inGroup = new Set(assignSelection.value)
    const toAdd = store.items
      .filter(p => inGroup.has(p.id) && p.groupId !== group.id)
      .map(p => p.id)
    const toRemove = store.items
      .filter(p => !inGroup.has(p.id) && p.groupId === group.id)
      .map(p => p.id)
    if (toAdd.length > 0) await store.assignGroup(toAdd, group.id)
    if (toRemove.length > 0) await store.assignGroup(toRemove, null)
    ElMessage.success(t('groups.assigned'))
    assigning.value = null
  } catch (err) {
    ElMessage.error(errorMessage(err))
  } finally {
    assignSaving.value = false
  }
}

onMounted(() => {
  if (!store.loaded) void store.load()
})
</script>

<template>
  <section class="view">
    <header class="head">
      <h1 class="title">{{ t('groups.title') }}</h1>
      <ElButton type="primary" @click="createGroup">{{ t('groups.new') }}</ElButton>
    </header>
    <p class="desc vfox-muted">{{ t('groups.desc') }}</p>

    <div class="table-wrap">
      <ElTable :data="rows" class="vfox-table" size="small" height="100%" row-key="id">
        <ElTableColumn :label="t('groups.name')" min-width="220">
          <template #default="{ row }">
            <ElTag size="small" type="info" effect="plain">{{ row.name }}</ElTag>
          </template>
        </ElTableColumn>
        <ElTableColumn :label="t('profiles.col.status')" width="140">
          <template #default="{ row }">{{ t('groups.count', { n: row.count }) }}</template>
        </ElTableColumn>
        <ElTableColumn width="260" align="right">
          <template #default="{ row }">
            <ElButton link type="primary" size="small" @click="openAssign(row)">
              {{ t('groups.assign') }}
            </ElButton>
            <ElButton link size="small" @click="rename(row)">{{ t('groups.rename') }}</ElButton>
            <ElButton link type="danger" size="small" @click="remove(row)">{{ t('common.delete') }}</ElButton>
          </template>
        </ElTableColumn>

        <template #empty>
          <div class="empty">
            <div class="empty-title">{{ t('groups.empty') }}</div>
            <ElButton type="primary" @click="createGroup">{{ t('groups.new') }}</ElButton>
          </div>
        </template>
      </ElTable>
    </div>

    <ElDialog
      :model-value="assigning !== null"
      :title="t('groups.assignTitle', { name: assigning?.name ?? '' })"
      width="480px"
      @update:model-value="assigning = null"
    >
      <p class="hint vfox-muted">{{ t('groups.assignHint') }}</p>
      <ElCheckboxGroup v-model="assignSelection" class="assign-list">
        <ElCheckbox v-for="profile in store.items" :key="profile.id" :value="profile.id">
          {{ profile.name }}
        </ElCheckbox>
      </ElCheckboxGroup>
      <template #footer>
        <ElButton @click="assigning = null">{{ t('common.cancel') }}</ElButton>
        <ElButton type="primary" :loading="assignSaving" @click="saveAssign">{{ t('common.save') }}</ElButton>
      </template>
    </ElDialog>
  </section>
</template>

<style scoped>
.view {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  padding: 14px 16px 16px;
}

.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
}

.desc {
  margin: 6px 0 12px;
  font-size: 12px;
}

.table-wrap {
  flex: 1;
  min-height: 0;
  border: 1px solid var(--vfox-border);
  border-radius: 8px;
  background: var(--vfox-panel);
  overflow: hidden;
}

.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 48px 0;
}

.empty-title {
  font-size: 13px;
  color: var(--vfox-muted);
}

.hint {
  margin: 0 0 10px;
  font-size: 12px;
}

.assign-list {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px 12px;
  max-height: 320px;
  overflow-y: auto;
}
</style>
