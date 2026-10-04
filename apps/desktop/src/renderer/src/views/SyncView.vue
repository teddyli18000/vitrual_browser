<script setup lang="ts">
import type { Profile, TileLayout } from '@vfox/shared'
import { ElMessage } from 'element-plus'
import { computed, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { errorMessage } from '../api/http'
import StatusDot from '../components/StatusDot.vue'
import { locale, type MessageKey, t } from '../i18n'
import { useConnectionStore } from '../stores/connection'
import { useProfilesStore } from '../stores/profiles'
import { useRuntimeStore } from '../stores/runtime'
import { useSyncStore } from '../stores/sync'
import { formatDateTime } from '../utils/format'

const profiles = useProfilesStore()
const runtime = useRuntimeStore()
const sync = useSyncStore()
const connection = useConnectionStore()
const router = useRouter()

const LAYOUTS: { value: TileLayout; key: MessageKey }[] = [
  { value: 'grid', key: 'tile.layout.grid' },
  { value: 'rows', key: 'tile.layout.rows' },
  { value: 'columns', key: 'tile.layout.columns' },
]

/**
 * `@vfox/sync` tiles through `user32.dll`, so only Windows has a monitor list at all. The
 * contract exposes no way to enumerate them, so the picker offers the primary monitor (which is
 * always valid) plus the first few indices, and says so — an index that does not exist comes back
 * as `tiling_unavailable` from the server, and that message is what the user then sees.
 */
const MONITOR_INDICES = [1, 2, 3]
const monitor = computed({
  get: () => (sync.displayIndex === null ? 'primary' : String(sync.displayIndex)),
  set: (value: string) => {
    sync.displayIndex = value === 'primary' ? null : Number(value)
  },
})

const monitorOptions = computed(() => [
  { value: 'primary', label: t('tile.monitorPrimary') },
  ...MONITOR_INDICES.map(index => ({
    value: String(index),
    label: t('tile.monitorIndex', { n: index + 1 }),
  })),
])

/** `ElRadioGroup` emits a loose union, so the narrow `TileLayout` is restored here. */
function chooseLayout(value: string | number | boolean | undefined): void {
  if (value === 'grid' || value === 'rows' || value === 'columns') sync.layout = value
}

/* ---------------------------------------------------------------------- the profile set */

/** The synchroniser needs a live Juggler endpoint, which only a `running` profile has. */
function isRunning(id: string): boolean {
  return runtime.statusOf(id) === 'running'
}

const running = computed(() => profiles.items.filter(profile => isRunning(profile.id)))
const runningCount = computed(() => running.value.length)
/** Running profiles first: they are the ones that can actually be picked. */
const rows = computed(() =>
  [...profiles.items].sort((a, b) => {
    const delta = Number(isRunning(b.id)) - Number(isRunning(a.id))
    return delta !== 0 ? delta : a.name.localeCompare(b.name, 'zh-CN')
  }),
)

const locked = computed(() => sync.active)
const masterName = computed(() => profiles.byId[sync.masterId ?? '']?.name ?? '—')
const runningSlaves = computed(() => sync.slaveIds.filter(isRunning))

/** zh-CN enumerates with 、 and English with ", "; one helper keeps both readable. */
function joinNames(names: string[]): string {
  return names.join(locale.value === 'zh-CN' ? '、' : ', ')
}
/** While a session is live the session decides the numbers, not the draft. */
const slaveCount = computed(() =>
  sync.active ? (sync.session?.slaveProfileIds.length ?? 0) : runningSlaves.value.length,
)
const staleNames = computed(() =>
  sync.active
    ? joinNames(sync.slaveIds.filter(id => !isRunning(id)).map(id => profiles.byId[id]?.name ?? id))
    : '',
)

const offline = computed(() => connection.state === 'offline')

/** Empty string means the button is usable; anything else is the reason it is not. */
const startBlockReason = computed(() => {
  if (offline.value) return t('conn.offline.title')
  if (sync.active) return ''
  if (runningCount.value < 2) return t('sync.needTwo.title')
  if (sync.masterId === null || !isRunning(sync.masterId)) return t('sync.pick.masterMissing')
  if (runningSlaves.value.length === 0) return t('sync.pick.slaveMissing')
  return ''
})

const canStart = computed(() => !locked.value && !sync.busy && startBlockReason.value === '')

const summary = computed(() =>
  sync.masterId
    ? t('sync.pick.summary', { master: masterName.value, n: slaveCount.value })
    : t('sync.pick.none'),
)

/* ------------------------------------------------------------------------- selection */

function setMaster(profile: Profile): void {
  if (locked.value || !isRunning(profile.id)) return
  sync.masterId = profile.id
  // One profile cannot be both, and the API would refuse it: drop it from the slaves.
  sync.slaveIds = sync.slaveIds.filter(id => id !== profile.id)
}

function toggleSlave(profile: Profile, checked: boolean): void {
  if (locked.value || !isRunning(profile.id) || profile.id === sync.masterId) return
  sync.slaveIds = checked
    ? [...sync.slaveIds, profile.id]
    : sync.slaveIds.filter(id => id !== profile.id)
}

function slaveChecked(id: string): boolean {
  return sync.slaveIds.includes(id)
}

function slaveDisabled(profile: Profile): boolean {
  return locked.value || !isRunning(profile.id) || profile.id === sync.masterId
}

/** Why the checkbox cannot be used, so a disabled control is never a silent one. */
function slaveTip(profile: Profile): string {
  if (locked.value) return t('sync.pick.locked')
  if (!isRunning(profile.id)) return t('sync.pick.notRunningTip')
  if (profile.id === sync.masterId) return t('sync.pick.masterLocked')
  return ''
}

/* ---------------------------------------------------------------------------- actions */

async function begin(): Promise<void> {
  if (!canStart.value) return
  try {
    const session = await sync.start()
    ElMessage.success(
      t('sync.started', {
        master: profiles.byId[session.masterProfileId]?.name ?? session.masterProfileId,
        n: session.slaveProfileIds.length,
      }),
    )
  } catch (err) {
    ElMessage.error(t('sync.startFailed', { reason: errorMessage(err) }))
  }
}

async function end(): Promise<void> {
  try {
    await sync.stop()
    ElMessage.success(t('sync.stopped'))
  } catch (err) {
    ElMessage.error(t('sync.stopFailed', { reason: errorMessage(err) }))
  }
}

async function startOne(profile: Profile): Promise<void> {
  try {
    await profiles.launch(profile.id)
    ElMessage.success(t('profiles.started', { name: profile.name }))
  } catch (err) {
    ElMessage.error(t('error.launchFailed', { name: profile.name, reason: errorMessage(err) }))
  }
}

async function stopOne(profile: Profile): Promise<void> {
  try {
    await profiles.stop(profile.id)
    ElMessage.success(t('profiles.stopped', { name: profile.name }))
  } catch (err) {
    ElMessage.error(t('error.stopFailed', { name: profile.name, reason: errorMessage(err) }))
  }
}

/* ------------------------------------------------------------------------------- tiling */

/** What will be arranged: the live session's windows, else the draft, else everything running. */
const tileTargets = computed(() => {
  const ids =
    sync.active && sync.session
      ? sync.sessionProfileIds
      : sync.masterId
        ? [sync.masterId, ...sync.slaveIds]
        : running.value.map(profile => profile.id)
  return ids.filter(isRunning)
})

const tileTargetNames = computed(() =>
  joinNames(tileTargets.value.map(id => profiles.byId[id]?.name ?? id)),
)

/** Empty string means the button is usable; anything else is the reason it is not. */
const tileBlockReason = computed(() => {
  if (offline.value) return t('conn.offline.title')
  if (sync.tilingError) return t('tile.unavailable', { reason: sync.tilingError })
  if (!sync.platformSupported)
    return t('tile.unavailableWindows', { platform: connection.platform })
  if (tileTargets.value.length === 0) return t('tile.needRunning')
  return ''
})

const canTile = computed(() => !sync.busy && tileBlockReason.value === '')

async function applyTile(): Promise<void> {
  if (!canTile.value) return
  const count = tileTargets.value.length
  try {
    await sync.tile(tileTargets.value)
    ElMessage.success(t('tile.done', { n: count }))
  } catch (err) {
    ElMessage.error(t('tile.failed', { reason: errorMessage(err) }))
  }
}

/* ----------------------------------------------------------------------------- refresh */

async function refresh(): Promise<void> {
  await profiles.load(false)
  await runtime.seed().catch(() => {})
  await sync.seed().catch(() => {})
}

/** Ctrl+Enter is the one shortcut: it is the whole feature, from either state. */
function onKeydown(event: KeyboardEvent): void {
  if (!event.ctrlKey || event.altKey || event.shiftKey || event.key !== 'Enter') return
  event.preventDefault()
  if (sync.active) void end()
  else void begin()
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
  void profiles.load(false)
  void runtime.seed().catch(() => {})
  void sync.seed().catch(() => {})
})

onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <section class="view vfox-scroll">
    <header class="head">
      <h1 class="title">{{ t('sync.title') }}</h1>
      <span class="count vfox-muted">{{ t('sync.subtitle') }}</span>
      <span class="spacer" />
      <span class="count vfox-muted">{{ t('sync.runningCount', { n: runningCount }) }}</span>
      <ElButton :disabled="connection.state === 'offline'" @click="refresh">
        {{ t('common.refresh') }}
      </ElButton>
    </header>

    <div class="state" :class="sync.active ? 'on' : 'off'">
      <span class="state-dot" />
      <div class="state-body">
        <div class="state-title">
          {{ sync.active ? t('sync.state.on') : t('sync.state.off') }}
        </div>
        <div class="state-desc">
          {{
            sync.active
              ? t('sync.state.onDesc', { master: masterName, n: slaveCount })
              : t('sync.state.offDesc')
          }}
        </div>
        <div v-if="sync.active && sync.startedAt" class="state-since">
          {{ t('sync.state.since', { time: formatDateTime(sync.startedAt) }) }}
        </div>
      </div>
      <div v-if="sync.active" class="counter">
        <div class="counter-num">{{ sync.mirroredEvents }}</div>
        <div class="counter-label">{{ t('sync.state.mirrored') }}</div>
        <div class="counter-hint">{{ t('sync.state.mirroredHint') }}</div>
      </div>
    </div>

    <ElAlert
      v-if="runningCount < 2"
      class="alert"
      type="warning"
      :closable="false"
      show-icon
      :title="t('sync.needTwo.title')"
    >
      <div class="alert-body">
        {{
          profiles.items.length === 0
            ? t('sync.noProfiles')
            : t('sync.needTwo.desc', { n: runningCount })
        }}
      </div>
      <ElButton link type="primary" @click="router.push('/profiles')">
        {{ t('sync.needTwo.action') }}
      </ElButton>
    </ElAlert>

    <ElAlert
      v-if="staleNames"
      class="alert"
      type="error"
      :closable="false"
      show-icon
      :title="t('sync.state.stale', { names: staleNames })"
    />

    <div class="toolbar">
      <ElTooltip
        v-if="!sync.active"
        :content="startBlockReason"
        :disabled="startBlockReason === ''"
        placement="top"
      >
        <span class="tip-wrap">
          <ElButton type="primary" :disabled="!canStart" :loading="sync.busy" @click="begin">
            {{ sync.busy ? t('sync.starting') : t('sync.start') }}
            <span class="kbd">Ctrl+Enter</span>
          </ElButton>
        </span>
      </ElTooltip>
      <ElButton v-else type="danger" :disabled="sync.busy" @click="end">
        {{ sync.busy ? t('sync.stopping') : t('sync.stop') }}
        <span class="kbd">Ctrl+Enter</span>
      </ElButton>

      <span class="spacer" />
      <span class="summary vfox-muted">{{ summary }}</span>
    </div>

    <div class="card">
      <div class="card-head">
        <div>
          <div class="card-title">{{ t('sync.pick.title') }}</div>
          <div class="hint">{{ t('sync.pick.hint') }}</div>
        </div>
        <ElTag v-if="locked" type="success" size="small" effect="plain">
          {{ t('sync.pick.lockedTag') }}
        </ElTag>
      </div>

      <div class="table-wrap">
        <ElTable
          :data="rows"
          class="vfox-table"
          size="small"
          height="260"
          row-key="id"
          :empty-text="t('sync.noProfiles')"
        >
          <ElTableColumn :label="t('profiles.col.status')" width="104">
            <template #default="{ row }">
              <StatusDot :status="runtime.statusOf(row.id)" />
            </template>
          </ElTableColumn>

          <ElTableColumn :label="t('profiles.col.name')" min-width="170" show-overflow-tooltip>
            <template #default="{ row }">
              <span class="name">{{ row.name }}</span>
              <span v-if="row.notes" class="notes vfox-muted">{{ row.notes }}</span>
            </template>
          </ElTableColumn>

          <ElTableColumn :label="t('profiles.col.group')" width="116" show-overflow-tooltip>
            <template #default="{ row }">
              <ElTag v-if="row.groupId" size="small" type="info" effect="plain">
                {{ profiles.groupName(row.groupId) || '—' }}
              </ElTag>
              <span v-else class="vfox-muted">—</span>
            </template>
          </ElTableColumn>

          <ElTableColumn :label="t('sync.pick.master')" width="124">
            <template #default="{ row }">
              <ElTag v-if="row.id === sync.masterId" type="success" size="small">
                {{ t('sync.pick.masterTag') }}
              </ElTag>
              <ElButton
                v-else
                link
                type="primary"
                size="small"
                :disabled="locked || !isRunning(row.id)"
                @click="setMaster(row)"
              >
                {{ t('sync.pick.setMaster') }}
              </ElButton>
            </template>
          </ElTableColumn>

          <ElTableColumn :label="t('sync.pick.slave')" width="88">
            <template #default="{ row }">
              <ElTooltip
                :content="slaveTip(row)"
                :disabled="slaveTip(row) === ''"
                placement="top"
              >
                <span class="check-wrap">
                  <ElCheckbox
                    :model-value="slaveChecked(row.id)"
                    :disabled="slaveDisabled(row)"
                    @change="toggleSlave(row, $event === true)"
                  />
                </span>
              </ElTooltip>
            </template>
          </ElTableColumn>

          <ElTableColumn :label="t('profiles.col.actions')" width="104" fixed="right">
            <template #default="{ row }">
              <ElButton
                v-if="isRunning(row.id)"
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
            </template>
          </ElTableColumn>
        </ElTable>
      </div>
    </div>

    <div class="duo">
      <div class="card">
        <div class="card-head">
          <div>
            <div class="card-title">{{ t('tile.title') }}</div>
            <div class="hint">{{ t('tile.hint') }}</div>
          </div>
        </div>

        <div class="tile-row">
          <span class="label">{{ t('tile.layout') }}</span>
          <ElRadioGroup
            :model-value="sync.layout"
            :disabled="!sync.tilingAvailable"
            @change="chooseLayout($event)"
          >
            <ElRadioButton v-for="option in LAYOUTS" :key="option.value" :value="option.value">
              {{ t(option.key) }}
            </ElRadioButton>
          </ElRadioGroup>

          <span class="label">{{ t('tile.monitor') }}</span>
          <ElSelect v-model="monitor" class="monitor" :disabled="!sync.tilingAvailable">
            <ElOption
              v-for="option in monitorOptions"
              :key="option.value"
              :label="option.label"
              :value="option.value"
            />
          </ElSelect>
        </div>

        <div class="tile-row">
          <ElTooltip :content="tileBlockReason" :disabled="tileBlockReason === ''" placement="top">
            <span class="tip-wrap">
              <ElButton
                type="primary"
                plain
                :disabled="!canTile"
                :loading="sync.busy"
                @click="applyTile"
              >
                {{ sync.busy ? t('tile.applying') : t('tile.apply') }}
              </ElButton>
            </span>
          </ElTooltip>

          <ElButton v-if="sync.tilingError" link size="small" @click="sync.forgetTilingError()">
            {{ t('tile.recheck') }}
          </ElButton>
          <span v-if="tileTargets.length > 0" class="hint targets">
            {{ t('tile.targets', { names: tileTargetNames }) }}
          </span>
        </div>

        <div class="hint">{{ t('tile.monitorHint') }}</div>
        <div v-if="sync.tilingError" class="hint err">
          {{ t('tile.unavailable', { reason: sync.tilingError }) }}
        </div>
      </div>

      <ElAlert class="limit" type="info" :closable="false" show-icon :title="t('sync.limit.title')">
        <div class="alert-body">{{ t('sync.limit.desc') }}</div>
      </ElAlert>
    </div>
  </section>
</template>

<style scoped>
.view {
  flex: 1;
  min-height: 0;
  padding: 14px 16px 20px;
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

.spacer {
  flex: 1;
}

/* The active state has to be readable from across the room: colour, weight and a live counter. */
.state {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 12px 0 10px;
  padding: 10px 14px;
  border: 1px solid var(--vfox-border);
  border-radius: 8px;
  background: var(--vfox-panel);
}

.state.on {
  border-color: #86efac;
  background: #f0fdf4;
}

.state.off {
  border-color: var(--vfox-border);
  background: #f8f9fb;
}

.state-dot {
  width: 10px;
  height: 10px;
  flex: 0 0 10px;
  border-radius: 50%;
  background: var(--vfox-idle);
}

.state.on .state-dot {
  background: var(--vfox-ok);
  animation: pulse 1.4s ease-in-out infinite;
}

@keyframes pulse {
  0%,
  100% {
    opacity: 1;
    transform: scale(1);
  }
  50% {
    opacity: 0.4;
    transform: scale(0.7);
  }
}

.state-body {
  min-width: 0;
}

.state-title {
  font-size: 13px;
  font-weight: 600;
}

.state.on .state-title {
  color: #15803d;
}

.state-desc {
  font-size: 11px;
  color: var(--vfox-muted);
  line-height: 1.6;
}

.state-since {
  font-size: 11px;
  color: var(--vfox-muted);
}

.counter {
  margin-left: auto;
  text-align: right;
  flex: 0 0 auto;
}

.counter-num {
  font-size: 22px;
  font-weight: 700;
  line-height: 1.1;
  color: #15803d;
  font-variant-numeric: tabular-nums;
}

.counter-label {
  font-size: 11px;
  color: #15803d;
}

.counter-hint {
  font-size: 10px;
  color: var(--vfox-muted);
}

.alert {
  margin-bottom: 10px;
}

.alert-body {
  font-size: 12px;
  line-height: 1.6;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 10px 0;
}

.kbd {
  margin-left: 6px;
  font-size: 10px;
  opacity: 0.75;
}

.summary {
  font-size: 12px;
  white-space: nowrap;
}

.card {
  border: 1px solid var(--vfox-border);
  border-radius: 8px;
  background: var(--vfox-panel);
  padding: 12px 14px;
  margin-bottom: 12px;
}

.card-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 10px;
}

.card-title {
  font-size: 13px;
  font-weight: 600;
}

.hint {
  font-size: 11px;
  color: var(--vfox-muted);
  line-height: 1.6;
  margin-top: 2px;
}

.hint.err {
  color: #b42318;
}

.table-wrap {
  border: 1px solid var(--vfox-border);
  border-radius: 8px;
  overflow: hidden;
}

.name {
  font-weight: 500;
}

.notes {
  margin-left: 8px;
  font-size: 11px;
}

.check-wrap {
  display: inline-flex;
  align-items: center;
}

.tile-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 6px;
}

/*
 * Tiling and the honest limitation note belong together: side by side they both stay above the
 * fold at 1440x900, and the note stacks under the controls on a narrow window.
 */
.duo {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(360px, 1fr));
  gap: 12px;
  align-items: start;
}

.targets {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.label {
  font-size: 12px;
  color: var(--vfox-muted);
}

.monitor {
  width: 148px;
}

.tip-wrap {
  display: inline-flex;
}

.limit {
  margin-bottom: 4px;
}
</style>
