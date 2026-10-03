/**
 * Frozen domain contract for the whole product.
 *
 * Every package (core, server, cli, desktop) validates against these zod schemas and
 * derives its TypeScript types from them, so the contract cannot drift between the
 * launcher, the HTTP API, the CLI and the GUI.
 */

import { z } from 'zod'

/* ------------------------------------------------------------------ fingerprint */

export const OsTargetSchema = z.enum(['windows', 'macos', 'linux'])
export type OsTarget = z.infer<typeof OsTargetSchema>

export const ProxySchema = z.object({
  type: z.enum(['http', 'https', 'socks5']),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  username: z.string().optional(),
  password: z.string().optional(),
})
export type ProxyConfig = z.infer<typeof ProxySchema>

export const ScreenConstraintSchema = z.object({
  minWidth: z.number().int().positive().default(1024),
  maxWidth: z.number().int().positive().default(2560),
  minHeight: z.number().int().positive().default(720),
  maxHeight: z.number().int().positive().default(1440),
})
export type ScreenConstraint = z.infer<typeof ScreenConstraintSchema>

export const WebglPairSchema = z.object({
  vendor: z.string().min(1),
  renderer: z.string().min(1),
})
export type WebglPair = z.infer<typeof WebglPairSchema>

/**
 * Maps 1:1 onto the engine launch options documented at https://camoufox.com/python/usage/.
 * `null` means "let the engine generate a statistically consistent value".
 */
export const FingerprintSchema = z.object({
  os: OsTargetSchema.default('windows'),
  screen: ScreenConstraintSchema.nullable().default(null),
  window: z
    .object({ width: z.number().int().positive(), height: z.number().int().positive() })
    .nullable()
    .default(null),
  webgl: WebglPairSchema.nullable().default(null),
  fonts: z.array(z.string().min(1)).nullable().default(null),
  /** e.g. "en-US", "US", or a comma separated accept-language list. null = derive from geoip. */
  locale: z.string().nullable().default(null),
  /** Match timezone / geolocation / locale to the proxy egress IP. */
  geoip: z.boolean().default(true),
  humanize: z.boolean().default(false),
  blockImages: z.boolean().default(false),
  blockWebrtc: z.boolean().default(false),
  blockWebgl: z.boolean().default(false),
  disableCoop: z.boolean().default(false),
  hardwareConcurrency: z.number().int().min(1).max(64).nullable().default(null),
  deviceMemory: z.number().int().min(1).max(64).nullable().default(null),
  userAgent: z.string().nullable().default(null),
  /** Raw engine config escape hatch (advanced). Merged last. */
  config: z.record(z.string(), z.unknown()).default({}),
})
export type FingerprintConfig = z.infer<typeof FingerprintSchema>

/* ---------------------------------------------------------------------- profile */

export const LaunchPrefsSchema = z.object({
  headless: z.boolean().default(false),
  startUrl: z.string().nullable().default(null),
})
export type LaunchPrefs = z.infer<typeof LaunchPrefsSchema>

export const GroupSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  createdAt: z.string(),
})
export type Group = z.infer<typeof GroupSchema>

export const ProfileSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  groupId: z.string().nullable().default(null),
  notes: z.string().default(''),
  color: z.string().nullable().default(null),
  proxy: ProxySchema.nullable().default(null),
  fingerprint: FingerprintSchema,
  launch: LaunchPrefsSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type Profile = z.infer<typeof ProfileSchema>

export const ProfileCreateSchema = z.object({
  name: z.string().min(1).max(120),
  groupId: z.string().nullable().optional(),
  notes: z.string().max(4000).optional(),
  color: z.string().nullable().optional(),
  proxy: ProxySchema.nullable().optional(),
  fingerprint: FingerprintSchema.partial().optional(),
  launch: LaunchPrefsSchema.partial().optional(),
})
export type ProfileCreate = z.infer<typeof ProfileCreateSchema>

export const ProfileUpdateSchema = ProfileCreateSchema.partial()
export type ProfileUpdate = z.infer<typeof ProfileUpdateSchema>

/* ---------------------------------------------------------------------- runtime */

export const RuntimeStatusSchema = z.enum(['stopped', 'starting', 'running', 'stopping', 'error'])
export type RuntimeStatus = z.infer<typeof RuntimeStatusSchema>

export const ProfileRuntimeSchema = z.object({
  profileId: z.string().min(1),
  status: RuntimeStatusSchema,
  pid: z.number().int().nullable().default(null),
  /**
   * Playwright (Juggler) server endpoint for this profile. External automation attaches with
   * `firefox.connect(wsEndpoint)` from playwright-core — the Firefox engine has no CDP port.
   */
  wsEndpoint: z.string().nullable().default(null),
  startedAt: z.string().nullable().default(null),
  lastError: z.string().nullable().default(null),
})
export type ProfileRuntime = z.infer<typeof ProfileRuntimeSchema>

/* ----------------------------------------------------------------------- kernel */

export const KernelInfoSchema = z.object({
  installed: z.boolean(),
  version: z.string().nullable(),
  path: z.string().nullable(),
  source: z.enum(['cache', 'bundled', 'missing']),
})
export type KernelInfo = z.infer<typeof KernelInfoSchema>

/* ------------------------------------------------------------------ api envelope */

export const ApiErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  details: z.unknown().optional(),
})
export type ApiError = z.infer<typeof ApiErrorSchema>

export type ApiResult<T> = { success: true; data: T } | { success: false; error: ApiError }

export const HealthSchema = z.object({
  ok: z.literal(true),
  product: z.string(),
  version: z.string(),
  pid: z.number().int(),
  kernel: KernelInfoSchema,
  runningProfiles: z.number().int(),
})
export type Health = z.infer<typeof HealthSchema>
