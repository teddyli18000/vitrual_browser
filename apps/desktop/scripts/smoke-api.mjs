/**
 * Contract smoke test for the HTTP surface the desktop renderer depends on.
 *
 * It boots the *real* `@vfox/server` in-process (exactly like the Electron main process does),
 * then walks every route the GUI calls — including the SSE stream — and asserts the exact
 * envelope, status code and payload shape the renderer's `src/renderer/src/api/*` expects.
 *
 * Why it exists: the renderer talks to the API over plain HTTP, so a route rename, a changed
 * envelope or a wrong method is invisible to `tsc` and only shows up when a user clicks a button.
 * This catches that class of breakage without needing Electron or a bundler.
 *
 *   node scripts/smoke-api.mjs            # everything except launching a real browser
 *   node scripts/smoke-api.mjs --launch   # also launch + stop one profile (opens a window)
 */

import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { startServer } from '@vfox/server'
import { API_ROUTES, API_TOKEN_HEADER, SSE_EVENT_RUNTIME } from '@vfox/shared'

const withLaunch = process.argv.includes('--launch')
const dataDir = join(process.cwd(), '.cache', 'tmp', `vfox-smoke-${process.pid}`)
await rm(dataDir, { recursive: true, force: true })
await mkdir(dataDir, { recursive: true })

let failures = 0
let checks = 0

function record(ok, label, detail = '') {
  checks += 1
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`)
}

/** Fastify answers 201 for creates; the renderer only reads the envelope, so both are success. */
function isOk(status) {
  return status === 200 || status === 201
}

function why(res) {
  if (res.json?.error) return `HTTP ${res.status} ${res.json.error.code}: ${res.json.error.message}`
  return `HTTP ${res.status}`
}

const server = await startServer({ dataDir, port: 0 })
const base = server.url
console.log(`server      ${base}  (dataDir ${dataDir})\n`)

async function call(path, { method = 'GET', body, token = server.token, raw = false } = {}) {
  const headers = {}
  if (token) headers[API_TOKEN_HEADER] = token
  if (body !== undefined && !raw) headers['content-type'] = 'application/json'
  if (raw) headers['content-type'] = 'application/zip'
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
  })
  // `raw` describes the REQUEST body; only the response content type decides how to read it.
  if (res.headers.get('content-type')?.includes('zip')) {
    const bytes = new Uint8Array(await res.arrayBuffer())
    return { status: res.status, bytes, contentType: res.headers.get('content-type') }
  }
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    json = null
  }
  return { status: res.status, json, text, contentType: res.headers.get('content-type') }
}

/* ------------------------------------------------------------------ auth + health */

{
  const res = await call(API_ROUTES.health, { token: '' })
  record(res.status === 401, 'GET /health without x-vfox-token is rejected', `HTTP ${res.status}`)
}

/*
 * CORS. The renderer is a browser context: in production it is loaded from `file://` (opaque
 * origin) and in dev from the Vite server on another port, so every call to the API is
 * cross-origin, and `x-vfox-token` is not a CORS-safelisted header — the browser sends a
 * preflight. Without `access-control-allow-origin` the GUI cannot talk to its own API at all,
 * and the user sees the "core service is not connected" banner while the server is perfectly
 * healthy.
 */
{
  const preflight = await fetch(`${base}${API_ROUTES.health}`, {
    method: 'OPTIONS',
    headers: {
      origin: 'null',
      'access-control-request-method': 'GET',
      'access-control-request-headers': API_TOKEN_HEADER,
    },
  })
  record(
    preflight.headers.get('access-control-allow-origin') !== null,
    '[server] preflight OPTIONS is answered with access-control-allow-origin',
    `HTTP ${preflight.status} acao=${preflight.headers.get('access-control-allow-origin')}`,
  )
  const simple = await fetch(`${base}${API_ROUTES.health}`, {
    headers: { origin: 'null', [API_TOKEN_HEADER]: server.token },
  })
  record(
    simple.headers.get('access-control-allow-origin') !== null,
    '[server] GET carries access-control-allow-origin (renderer is file:// in production)',
    `HTTP ${simple.status} acao=${simple.headers.get('access-control-allow-origin')}`,
  )
}

{
  const res = await call(API_ROUTES.health)
  const data = res.json?.data
  record(
    res.status === 200 && res.json?.success === true,
    'GET /health -> ApiResult envelope',
    `HTTP ${res.status}`,
  )
  record(
    typeof data?.version === 'string' && typeof data?.kernel?.installed === 'boolean',
    'GET /health exposes version + kernel.installed (settings + banner read these)',
    `version=${data?.version} kernel.installed=${data?.kernel?.installed}`,
  )
}

/* ----------------------------------------------------------------------- profiles */

let profileId = ''
{
  const res = await call(API_ROUTES.profiles, { method: 'POST', body: { name: '冒烟测试环境' } })
  profileId = res.json?.data?.id ?? ''
  record(isOk(res.status) && profileId !== '', 'POST /profiles creates a profile', why(res))
}
{
  const res = await call(API_ROUTES.profiles)
  record(
    Array.isArray(res.json?.data) && res.json.data.length === 1,
    'GET /profiles returns an array',
    `HTTP ${res.status} n=${res.json?.data?.length}`,
  )
}
{
  // Exactly the payload the 指纹 tab sends: every nullable field present and explicitly null.
  const fingerprint = {
    os: 'macos',
    screen: null,
    window: null,
    webgl: null,
    fonts: null,
    locale: null,
    geoip: true,
    humanize: false,
    blockImages: false,
    blockWebrtc: false,
    blockWebgl: false,
    disableCoop: false,
    hardwareConcurrency: null,
    deviceMemory: null,
    userAgent: null,
    config: {},
  }
  const res = await call(API_ROUTES.profile(profileId), {
    method: 'PATCH',
    body: {
      name: '冒烟测试环境',
      groupId: null,
      notes: '备注',
      proxy: null,
      fingerprint,
      launch: { headless: false, startUrl: null },
    },
  })
  const fp = res.json?.data?.fingerprint
  record(
    res.status === 200 && fp?.os === 'macos',
    'PATCH /profiles/:id accepts a full fingerprint',
    `HTTP ${res.status}`,
  )
  record(
    fp?.screen === null && fp?.webgl === null && fp?.userAgent === null,
    'PATCH keeps null = 自动 round-trip',
    JSON.stringify({ screen: fp?.screen, webgl: fp?.webgl, ua: fp?.userAgent }),
  )
}
{
  const res = await call(API_ROUTES.profile('does-not-exist'))
  record(
    res.status === 404 && res.json?.success === false,
    'GET unknown profile -> 404 + error envelope',
    `HTTP ${res.status}`,
  )
}

/* ------------------------------------------------------------------------- groups */

let groupId = ''
{
  const res = await call(API_ROUTES.groups, { method: 'POST', body: { name: '冒烟分组' } })
  groupId = res.json?.data?.id ?? ''
  record(isOk(res.status) && groupId !== '', 'POST /groups creates a group', why(res))
}
{
  const res = await call(API_ROUTES.group(groupId), {
    method: 'PATCH',
    body: { name: '冒烟分组2' },
  })
  record(
    res.status === 200 && res.json?.data?.name === '冒烟分组2',
    'PATCH /groups/:id renames',
    why(res),
  )
}
{
  const res = await call(API_ROUTES.profile(profileId), { method: 'PATCH', body: { groupId } })
  record(
    res.json?.data?.groupId === groupId,
    'PATCH /profiles/:id assigns a group (分组管理)',
    why(res),
  )
}
{
  const res = await call(API_ROUTES.group(groupId), { method: 'DELETE' })
  record(res.status === 200, 'DELETE /groups/:id succeeds', why(res))
}

/* ------------------------------------------------------------------ clone + export */

let cloneId = ''
{
  const res = await call(API_ROUTES.cloneProfile(profileId), {
    method: 'POST',
    body: { name: '冒烟副本' },
  })
  cloneId = res.json?.data?.id ?? ''
  record(
    isOk(res.status) && cloneId !== '',
    'POST /profiles/:id/clone copies config + userdata',
    why(res),
  )
}
let zipBytes = null
{
  const res = await call(API_ROUTES.exportProfile(profileId))
  zipBytes = res.bytes
  record(
    res.status === 200 && res.bytes?.length > 4 && res.bytes[0] === 0x50 && res.bytes[1] === 0x4b,
    'GET /profiles/:id/export returns zip bytes (PK header)',
    why(res),
  )
}
{
  const res = await call(API_ROUTES.importProfile, { method: 'POST', body: zipBytes, raw: true })
  record(
    isOk(res.status) && !!res.json?.data?.id,
    'POST /profiles/import accepts raw zip bytes',
    `${why(res)} content-type=${res.contentType} body=${(res.text ?? '').slice(0, 200)}`,
  )
}

/* ------------------------------------------------------------------------ runtime */

{
  const res = await call(API_ROUTES.runtime)
  record(
    Array.isArray(res.json?.data),
    'GET /runtime returns the live list (SSE seed)',
    `HTTP ${res.status}`,
  )
}
{
  const res = await call(API_ROUTES.runtimeFor(profileId))
  record(
    res.json?.data?.status === 'stopped',
    'GET /runtime/:id reports stopped',
    `status=${res.json?.data?.status}`,
  )
}

/* ------------------------------------------------------------------------- kernel */

{
  const res = await call(API_ROUTES.kernel)
  const info = res.json?.data
  record(
    res.status === 200 && typeof info?.installed === 'boolean' && typeof info?.source === 'string',
    'GET /kernel returns KernelInfo (设置 page)',
    `installed=${info?.installed} version=${info?.version} source=${info?.source}`,
  )
}

/* ---------------------------------------------------------------------------- SSE */

{
  const controller = new AbortController()
  const res = await fetch(`${base}${API_ROUTES.events}`, {
    headers: { [API_TOKEN_HEADER]: server.token, accept: 'text/event-stream' },
    signal: controller.signal,
  })
  record(
    res.status === 200 && res.headers.get('content-type')?.includes('text/event-stream'),
    'GET /events is text/event-stream',
    `HTTP ${res.status}`,
  )

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  const received = { runtime: 0 }
  const pump = (async () => {
    let buffer = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n')
      let at = buffer.indexOf('\n\n')
      while (at !== -1) {
        const chunk = buffer.slice(0, at)
        buffer = buffer.slice(at + 2)
        if (chunk.includes(`event: ${SSE_EVENT_RUNTIME}`)) received.runtime += 1
        at = buffer.indexOf('\n\n')
      }
    }
  })()

  // Anything that changes runtime state must arrive on the stream: this is what drives the dots.
  await call(API_ROUTES.stopProfile(profileId), { method: 'POST' })
  await new Promise(resolve => setTimeout(resolve, 400))
  controller.abort()
  await pump.catch(() => {})
  record(
    received.runtime > 0,
    'SSE pushes a runtime event after a state change',
    `${received.runtime} event(s)`,
  )
}

/* ----------------------------------------------------------- launch (opt-in) */

if (withLaunch) {
  const launch = await call(API_ROUTES.launchProfile(profileId), { method: 'POST' })
  record(
    launch.status === 200,
    'POST /profiles/:id/launch',
    `HTTP ${launch.status} ${launch.json?.error?.message ?? ''}`,
  )
  const runtime = await call(API_ROUTES.runtimeFor(profileId))
  console.log(`      runtime -> ${JSON.stringify(runtime.json?.data)}`)
  const stop = await call(API_ROUTES.stopProfile(profileId), { method: 'POST' })
  record(stop.status === 200, 'POST /profiles/:id/stop', `HTTP ${stop.status}`)
} else {
  console.log('SKIP  launch/stop (pass --launch to open and close a real browser window)')
}

/* ------------------------------------------------------------------------ cleanup */

{
  const res = await call(API_ROUTES.profile(profileId), { method: 'DELETE' })
  record(res.status === 200, 'DELETE /profiles/:id removes the profile', `HTTP ${res.status}`)
  await call(API_ROUTES.profile(cloneId), { method: 'DELETE' })
}

await server.close()
await rm(dataDir, { recursive: true, force: true })

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)
