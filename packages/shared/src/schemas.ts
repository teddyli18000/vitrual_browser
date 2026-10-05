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

/**
 * The device identity a profile was born with.
 *
 * The engine's fingerprint generator is **not reproducible across launches** — upstream Camoufox's
 * ROADMAP still lists "the same seed gives the same device, including its canvas and audio output"
 * as unfinished. So VFox generates the identity exactly ONCE at profile creation, stores it here,
 * and re-injects it on every launch. Without this a profile would present a different device every
 * time it is opened, which silently destroys the product's central promise.
 */
export const FingerprintIdentitySchema = z.object({
  version: z.literal(1),
  /** Engine version the identity was generated against; a different engine may need a re-roll. */
  engine: z.string().nullable().default(null),
  generatedAt: z.string(),
  /** The generated fingerprint object, passed back verbatim as the engine's `fingerprint` option. */
  fingerprint: z.record(z.string(), z.unknown()),
})
export type FingerprintIdentity = z.infer<typeof FingerprintIdentitySchema>

export const ProfileSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  groupId: z.string().nullable().default(null),
  notes: z.string().default(''),
  color: z.string().nullable().default(null),
  proxy: ProxySchema.nullable().default(null),
  fingerprint: FingerprintSchema,
  /** Generated once, re-injected on every launch. See {@link FingerprintIdentitySchema}. */
  identity: FingerprintIdentitySchema.nullable().default(null),
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

/**
 * Hard cap for one batch creation. Every profile is a real browser window with its own engine
 * process, so this is a guard against an unbounded loop rather than a target. It lives in the
 * shared contract because the core, the HTTP API and the CLI all validate against it.
 */
export const MAX_BATCH_PROFILES = 50

/**
 * Create `count` profiles in one call, each with its own generated identity.
 *
 * Names are `<namePrefix> <index>` starting at 1. `proxy`, `launch` and `fingerprint` apply to every
 * profile in the batch, with `fingerprint` layered on top of the generated identity — so a batch of
 * twenty is twenty different machines that share one platform, proxy and launch preference.
 */
export const ProfileBatchCreateSchema = z.object({
  count: z.number().int().min(1).max(MAX_BATCH_PROFILES),
  namePrefix: z.string().min(1).max(80),
  groupId: z.string().nullable().optional(),
  proxy: ProxySchema.nullable().optional(),
  launch: LaunchPrefsSchema.partial().optional(),
  fingerprint: FingerprintSchema.partial().optional(),
})
export type ProfileBatchCreate = z.infer<typeof ProfileBatchCreateSchema>

/* ---------------------------------------------------------------------- runtime */

export const RuntimeStatusSchema = z.enum(['stopped', 'starting', 'running', 'stopping', 'error'])
export type RuntimeStatus = z.infer<typeof RuntimeStatusSchema>

export const ProfileRuntimeSchema = z.object({
  profileId: z.string().min(1),
  status: RuntimeStatusSchema,
  pid: z.number().int().nullable().default(null),
  /**
   * Playwright (Juggler) websocket endpoint for this running profile. External automation attaches
   * with `firefox.connect(wsEndpoint)` from playwright-core — the Firefox engine has no CDP port.
   * Populated while the profile is running; null when stopped.
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

export const KernelPhaseSchema = z.enum([
  'idle',
  'checking',
  'downloading',
  'extracting',
  'done',
  'error',
])
export type KernelPhase = z.infer<typeof KernelPhaseSchema>

/** Pushed on the `kernel` SSE event while the engine is being installed. */
export const KernelProgressSchema = z.object({
  phase: KernelPhaseSchema,
  percent: z.number().min(0).max(100).nullable().default(null),
  receivedBytes: z.number().int().nonnegative().nullable().default(null),
  totalBytes: z.number().int().nonnegative().nullable().default(null),
  message: z.string().nullable().default(null),
})
export type KernelProgress = z.infer<typeof KernelProgressSchema>

/* --------------------------------------------------------------------- cookies */

/**
 * Cookie interchange uses the Netscape `cookies.txt` format — the one curl, wget, yt-dlp and the
 * other anti-detect browsers read and write — so a session moved out of VFox stays usable and a
 * session captured elsewhere can be moved in. The format is lossy in exactly two ways, both
 * documented on the export path: `SameSite` has no field (imports land as "unspecified", which
 * Firefox treats as Lax) and cookies carrying a non-empty `originAttributes` (container or
 * partitioned cookies) cannot be represented at all, so they are skipped and reported.
 */

/** How an import treats cookies the profile already has. */
export const CookieImportModeSchema = z.enum(['merge', 'replace'])
export type CookieImportMode = z.infer<typeof CookieImportModeSchema>

/** A cookie file larger than this is refused before it is parsed. Real jars are a few hundred KB. */
export const MAX_COOKIE_FILE_BYTES = 4 * 1024 * 1024

/** One line the parser or the jar writer could not use, with the reason. */
export const CookieSkipSchema = z.object({
  /** 1-based line in the source file, when the skip came from parsing. */
  line: z.number().int().positive().nullable().default(null),
  /** What the skip is about: `name@host`, or the raw line when it could not be parsed. */
  detail: z.string(),
  reason: z.string(),
})
export type CookieSkip = z.infer<typeof CookieSkipSchema>

export const CookieImportRequestSchema = z.object({
  /** Netscape `cookies.txt` content. */
  content: z.string().min(1).max(MAX_COOKIE_FILE_BYTES),
  /**
   * `merge` (default) upserts each cookie by `(host, name, path)` and leaves everything else in the
   * jar alone. `replace` empties the jar first, so the profile ends up with exactly the file.
   */
  mode: CookieImportModeSchema.default('merge'),
})
export type CookieImportRequest = z.infer<typeof CookieImportRequestSchema>

export const CookieImportResultSchema = z.object({
  profileId: z.string().min(1),
  mode: CookieImportModeSchema,
  /** Usable data lines the file contained. */
  parsed: z.number().int().nonnegative(),
  /** Cookies written — inserted or updated. */
  written: z.number().int().nonnegative(),
  /** Of those, cookies the profile already had and that were overwritten. */
  updated: z.number().int().nonnegative(),
  /** Cookies deleted first by `replace` mode. Always 0 for `merge`. */
  removed: z.number().int().nonnegative(),
  /** Lines that could not be used, with the reason. */
  skipped: z.array(CookieSkipSchema),
})
export type CookieImportResult = z.infer<typeof CookieImportResultSchema>

/* --------------------------------------------------------- window synchroniser */

/**
 * A synchroniser session: input performed in the master profile is replayed into every slave
 * profile. This is the multi-account "do it once, apply everywhere" feature.
 */
export const SyncSessionSchema = z.object({
  id: z.string().min(1),
  masterProfileId: z.string().min(1),
  slaveProfileIds: z.array(z.string().min(1)),
  active: z.boolean().default(false),
  startedAt: z.string().nullable().default(null),
  /** Events mirrored so far. Local diagnostic counter only — never reported anywhere. */
  mirroredEvents: z.number().int().nonnegative().default(0),
})
export type SyncSession = z.infer<typeof SyncSessionSchema>

export const SyncStartSchema = z.object({
  masterProfileId: z.string().min(1),
  slaveProfileIds: z.array(z.string().min(1)).min(1),
})
export type SyncStart = z.infer<typeof SyncStartSchema>

export const TileLayoutSchema = z.enum(['grid', 'rows', 'columns'])
export type TileLayout = z.infer<typeof TileLayoutSchema>

export const TileRequestSchema = z.object({
  profileIds: z.array(z.string().min(1)).min(1),
  layout: TileLayoutSchema.default('grid'),
  /** 0-based monitor index; null = primary monitor. */
  displayIndex: z.number().int().nonnegative().nullable().default(null),
})
export type TileRequest = z.infer<typeof TileRequestSchema>

/* ---------------------------------------------------------------------- addons */

/**
 * Per-profile browser addons.
 *
 * The engine's unit is an **extracted addon directory**, not an `.xpi`. `camoufox-js` requires every
 * path passed as `addons` to be an existing directory containing `manifest.json` (`dist/addons.js`
 * `confirmPaths` throws `InvalidAddonPath` otherwise), and the engine's own `properties.json`
 * declares `addons` as an accepted config key. VFox therefore extracts an `.xpi`/`.zip` at install
 * time, stores the extracted tree, and hands the launcher absolute paths.
 */

/**
 * One addon a profile will load, as it exists on disk.
 *
 * Every field except `source` is read from the addon's own `manifest.json`, so the record cannot
 * drift from what the engine will actually load, and an addon directory copied in by hand still
 * lists correctly.
 */
export const ProfileAddonSchema = z.object({
  /** Directory name inside the profile's addon store, derived from the gecko id so it is stable. */
  slug: z.string().min(1),
  /** Gecko id from the manifest, when it has one. This is what Firefox keys the addon on. */
  id: z.string().min(1).nullable().default(null),
  name: z.string().min(1),
  version: z.string().min(1),
  /**
   * `vfox` — installed into this profile by the user.
   * `engine` — supplied by the engine itself (the bundled uBlock Origin). Read-only in v1: it is
   * loaded because the engine's launcher adds it, and excluding it needs per-profile state that
   * does not exist yet.
   */
  source: z.enum(['vfox', 'engine']).default('vfox'),
  /** Files and bytes on disk, so the UI can show what a profile carries. */
  files: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
  installedAt: z.string(),
})
export type ProfileAddon = z.infer<typeof ProfileAddonSchema>

/**
 * Caps applied while unpacking an `.xpi`. They are guards against a pathological archive, not a
 * judgement about the addon: a real addon is a few hundred files and a few MB.
 */
export const MAX_ADDON_FILES = 20_000
export const MAX_ADDON_BYTES = 512 * 1024 * 1024

export const AddonInstallRequestSchema = z.object({
  /**
   * Path to an extracted addon directory (containing `manifest.json`), or to an `.xpi`/`.zip` file
   * that VFox extracts for you. Local by design: the API is loopback-only behind a token and the
   * caller is on this machine.
   */
  path: z.string().min(1),
  /** Replace an addon already installed under the same slug instead of refusing. */
  replace: z.boolean().default(false),
})
export type AddonInstallRequest = z.infer<typeof AddonInstallRequestSchema>

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
