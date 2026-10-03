/**
 * The demo profile set, shared by `seed-demo.mjs` (manual QA, screenshots) and
 * `screenshot-ui.mjs` (CI). It writes through `@vfox/core` rather than hand-rolling JSON, so the
 * store is guaranteed to satisfy the shared zod schemas and to use the same format the app reads.
 */

import { createCore } from '@vfox/core'

export const DEMO_GROUPS = ['Facebook', 'TikTok', '测试环境']

/** `null` for a fingerprint field means 自动 — the engine generates that value. */
export const DEMO_PROFILES = [
  {
    name: 'Facebook-01',
    group: 'Facebook',
    notes: '主号 · 美国住宅代理',
    os: 'windows',
    proxy: {
      type: 'socks5',
      host: '127.0.0.1',
      port: 1080,
      username: 'user01',
      password: 'pass01',
    },
  },
  {
    name: 'Facebook-02',
    group: 'Facebook',
    notes: '备用号',
    os: 'windows',
    proxy: { type: 'socks5', host: '127.0.0.1', port: 1080 },
  },
  { name: 'Facebook-03', group: 'Facebook', notes: '', os: 'macos', proxy: null },
  {
    name: 'TikTok-US-01',
    group: 'TikTok',
    notes: '美区 · 洛杉矶',
    os: 'macos',
    proxy: { type: 'http', host: '127.0.0.1', port: 8080, username: 'tt', password: 'secret' },
  },
  {
    name: 'TikTok-UK-01',
    group: 'TikTok',
    notes: '英区',
    os: 'windows',
    proxy: { type: 'https', host: '127.0.0.1', port: 8443 },
  },
  { name: 'TikTok-JP-01', group: 'TikTok', notes: '', os: 'linux', proxy: null },
  {
    name: '测试-无代理',
    group: '测试环境',
    notes: '本机直连，用于对比指纹',
    os: 'windows',
    proxy: null,
  },
  {
    name: '测试-自动化',
    group: '测试环境',
    notes: '无头模式，仅供脚本调用',
    os: 'linux',
    proxy: null,
    headless: true,
  },
]

const silent = { debug() {}, info() {}, warn() {}, error() {} }

/**
 * Idempotent: profiles that already exist are skipped, so re-running never duplicates or
 * overwrites what a human has been testing with.
 */
export async function seedDemoData(dataDir, log = console.log) {
  const core = await createCore({ dataDir, logger: silent })
  try {
    const groupIds = new Map()
    for (const name of DEMO_GROUPS) {
      const existing = (await core.groups.list()).find(group => group.name === name)
      const group = existing ?? (await core.groups.create(name))
      groupIds.set(name, group.id)
    }

    for (const spec of DEMO_PROFILES) {
      if ((await core.profiles.list()).some(profile => profile.name === spec.name)) {
        log(`  skip   ${spec.name} (already present)`)
        continue
      }
      const profile = await core.profiles.create({
        name: spec.name,
        groupId: groupIds.get(spec.group) ?? null,
        notes: spec.notes,
        proxy: spec.proxy,
        fingerprint: { os: spec.os },
        launch: { headless: spec.headless === true, startUrl: null },
      })
      log(`  create ${profile.name}  (${profile.id})`)
    }

    return { profiles: await core.profiles.list(), groups: await core.groups.list() }
  } finally {
    await core.close()
  }
}
