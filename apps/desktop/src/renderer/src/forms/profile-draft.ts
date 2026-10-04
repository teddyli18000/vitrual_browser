/**
 * The dialog's form model.
 *
 * `Profile.fingerprint` uses `null` for "let the engine decide". A form cannot bind to `null`
 * cleanly, so the draft keeps an explicit `*Auto` boolean per nullable field plus a concrete
 * value, and converts in both directions. That is what makes every empty field visibly 自动
 * instead of silently meaning "empty string".
 */

import type { FingerprintConfig, OsTarget, Profile, ProfileCreate, ProxyConfig } from '@vfox/shared'

export type ProxyType = 'http' | 'https' | 'socks5'

export interface ScreenDraft {
  minWidth: number
  maxWidth: number
  minHeight: number
  maxHeight: number
}

export interface WindowDraft {
  width: number
  height: number
}

export interface WebglDraft {
  vendor: string
  renderer: string
}

export interface ProxyDraft {
  type: ProxyType
  host: string
  port: number
  username: string
  password: string
}

export interface ProfileDraft {
  name: string
  groupId: string | null
  notes: string
  startUrl: string
  headless: boolean

  os: OsTarget

  screenAuto: boolean
  screen: ScreenDraft
  windowAuto: boolean
  window: WindowDraft
  webglAuto: boolean
  webgl: WebglDraft
  fontsAuto: boolean
  fontsText: string
  localeAuto: boolean
  locale: string
  hardwareConcurrencyAuto: boolean
  hardwareConcurrency: number
  userAgentAuto: boolean
  userAgent: string

  geoip: boolean
  humanize: boolean

  proxyEnabled: boolean
  proxy: ProxyDraft

  blockImages: boolean
  blockWebrtc: boolean
  blockWebgl: boolean
  disableCoop: boolean
  configText: string
}

export const DEFAULT_SCREEN: ScreenDraft = {
  minWidth: 1024,
  maxWidth: 2560,
  minHeight: 720,
  maxHeight: 1440,
}
export const DEFAULT_WINDOW: WindowDraft = { width: 1280, height: 800 }
export const DEFAULT_PROXY: ProxyDraft = {
  type: 'http',
  host: '',
  port: 8080,
  username: '',
  password: '',
}

export function emptyDraft(): ProfileDraft {
  return {
    name: '',
    groupId: null,
    notes: '',
    startUrl: '',
    headless: false,
    os: 'windows',
    screenAuto: true,
    screen: { ...DEFAULT_SCREEN },
    windowAuto: true,
    window: { ...DEFAULT_WINDOW },
    webglAuto: true,
    webgl: { vendor: '', renderer: '' },
    fontsAuto: true,
    fontsText: '',
    localeAuto: true,
    locale: '',
    hardwareConcurrencyAuto: true,
    hardwareConcurrency: 8,
    userAgentAuto: true,
    userAgent: '',
    geoip: true,
    humanize: false,
    proxyEnabled: false,
    proxy: { ...DEFAULT_PROXY },
    blockImages: false,
    blockWebrtc: false,
    blockWebgl: false,
    disableCoop: false,
    configText: '',
  }
}

function text(value: string | null | undefined): string {
  return value ?? ''
}

export function draftFrom(profile: Profile): ProfileDraft {
  const fp = profile.fingerprint
  const draft = emptyDraft()
  draft.name = profile.name
  draft.groupId = profile.groupId
  draft.notes = profile.notes
  draft.startUrl = text(profile.launch.startUrl)
  draft.headless = profile.launch.headless
  draft.os = fp.os

  draft.screenAuto = fp.screen === null
  if (fp.screen) draft.screen = { ...fp.screen }
  draft.windowAuto = fp.window === null
  if (fp.window) draft.window = { ...fp.window }
  draft.webglAuto = fp.webgl === null
  if (fp.webgl) draft.webgl = { ...fp.webgl }
  draft.fontsAuto = fp.fonts === null
  draft.fontsText = fp.fonts ? fp.fonts.join('\n') : ''
  draft.localeAuto = fp.locale === null
  draft.locale = text(fp.locale)
  draft.hardwareConcurrencyAuto = fp.hardwareConcurrency === null
  draft.hardwareConcurrency = fp.hardwareConcurrency ?? 8
  draft.userAgentAuto = fp.userAgent === null
  draft.userAgent = text(fp.userAgent)

  draft.geoip = fp.geoip
  draft.humanize = fp.humanize

  draft.proxyEnabled = profile.proxy !== null
  if (profile.proxy) {
    draft.proxy = {
      type: profile.proxy.type,
      host: profile.proxy.host,
      port: profile.proxy.port,
      username: text(profile.proxy.username),
      password: text(profile.proxy.password),
    }
  }

  draft.blockImages = fp.blockImages
  draft.blockWebrtc = fp.blockWebrtc
  draft.blockWebgl = fp.blockWebgl
  draft.disableCoop = fp.disableCoop
  draft.configText = Object.keys(fp.config).length > 0 ? JSON.stringify(fp.config, null, 2) : ''
  return draft
}

export interface DraftConversion {
  payload: ProfileCreate
  error: 'invalidJson' | null
}

/**
 * Convert the draft into the wire payload. The fingerprint is always sent complete, with
 * explicit `null`s: a partial patch would leave a field the user just switched back to 自动
 * stuck on its previous value.
 */
export function payloadFrom(draft: ProfileDraft): DraftConversion {
  let config: Record<string, unknown> = {}
  let error: 'invalidJson' | null = null
  const raw = draft.configText.trim()
  if (raw.length > 0) {
    try {
      const parsed = JSON.parse(raw) as unknown
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        config = parsed as Record<string, unknown>
      } else {
        error = 'invalidJson'
      }
    } catch {
      error = 'invalidJson'
    }
  }

  const fonts = draft.fontsAuto
    ? null
    : draft.fontsText
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0)

  const fingerprint: FingerprintConfig = {
    os: draft.os,
    screen: draft.screenAuto ? null : { ...draft.screen },
    window: draft.windowAuto ? null : { ...draft.window },
    webgl: draft.webglAuto ? null : { vendor: draft.webgl.vendor, renderer: draft.webgl.renderer },
    fonts: fonts && fonts.length > 0 ? fonts : null,
    locale: draft.localeAuto || draft.locale.trim().length === 0 ? null : draft.locale.trim(),
    geoip: draft.geoip,
    humanize: draft.humanize,
    blockImages: draft.blockImages,
    blockWebrtc: draft.blockWebrtc,
    blockWebgl: draft.blockWebgl,
    disableCoop: draft.disableCoop,
    hardwareConcurrency: draft.hardwareConcurrencyAuto ? null : draft.hardwareConcurrency,
    // Hard-coded null, and the GUI has no control for it: Firefox does not implement
    // `navigator.deviceMemory`, so the engine has no property to spoof and camoufox-js's own
    // mapping says "deviceMemory not in Firefox". The key is absent from the installed engine's
    // `properties.json`, and passing it makes camoufox-js throw `UnknownProperty`, which aborts the
    // launch. The field stays in the shared schema for contract stability, so it is always sent
    // empty rather than omitted.
    deviceMemory: null,
    userAgent:
      draft.userAgentAuto || draft.userAgent.trim().length === 0 ? null : draft.userAgent.trim(),
    config,
  }

  let proxy: ProxyConfig | null = null
  if (draft.proxyEnabled) {
    proxy = {
      type: draft.proxy.type,
      host: draft.proxy.host.trim(),
      port: Number(draft.proxy.port),
      ...(draft.proxy.username.trim() ? { username: draft.proxy.username.trim() } : {}),
      ...(draft.proxy.password ? { password: draft.proxy.password } : {}),
    }
  }

  return {
    payload: {
      name: draft.name.trim(),
      groupId: draft.groupId,
      notes: draft.notes,
      proxy,
      fingerprint,
      launch: {
        headless: draft.headless,
        startUrl: draft.startUrl.trim().length > 0 ? draft.startUrl.trim() : null,
      },
    },
    error,
  }
}

/** How many fields the user left on 自动 — shown as a one-line summary in the fingerprint tab. */
export function autoCount(draft: ProfileDraft): number {
  return [
    draft.screenAuto,
    draft.windowAuto,
    draft.webglAuto,
    draft.fontsAuto,
    draft.localeAuto,
    draft.hardwareConcurrencyAuto,
    draft.userAgentAuto,
  ].filter(Boolean).length
}
