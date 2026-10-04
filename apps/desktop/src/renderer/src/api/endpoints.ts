import {
  API_ROUTES,
  type CookieImportRequest,
  type CookieImportResult,
  type Group,
  type Health,
  type KernelInfo,
  type Profile,
  type ProfileBatchCreate,
  type ProfileCreate,
  type ProfileRuntime,
  type ProfileUpdate,
  type SyncSession,
  type SyncStart,
  type TileRequest,
} from '@vfox/shared'
import {
  apiBytes,
  apiGet,
  apiSend,
  apiSendBytes,
  apiText,
  fromBase64,
  type TextDownload,
  toBase64,
} from './http'

/* ------------------------------------------------------------------------- profiles */

export function listProfiles(): Promise<Profile[]> {
  return apiGet<Profile[]>(API_ROUTES.profiles)
}

export function createProfile(input: ProfileCreate): Promise<Profile> {
  return apiSend<Profile>(API_ROUTES.profiles, 'POST', input)
}

/**
 * One request, `count` profiles, each with its own generated identity. All or nothing: a failure
 * means the store is untouched, so the caller must report "nothing was created" rather than a
 * partial count. The result is in creation order.
 */
export function createProfilesBatch(input: ProfileBatchCreate): Promise<Profile[]> {
  return apiSend<Profile[]>(API_ROUTES.createProfilesBatch, 'POST', input)
}

export function updateProfile(id: string, patch: ProfileUpdate): Promise<Profile> {
  return apiSend<Profile>(API_ROUTES.profile(id), 'PATCH', patch)
}

export function deleteProfile(id: string): Promise<void> {
  return apiSend<void>(API_ROUTES.profile(id), 'DELETE')
}

export function cloneProfile(id: string, name?: string): Promise<Profile> {
  return apiSend<Profile>(API_ROUTES.cloneProfile(id), 'POST', name ? { name } : {})
}

export function launchProfile(id: string): Promise<ProfileRuntime> {
  return apiSend<ProfileRuntime>(API_ROUTES.launchProfile(id), 'POST')
}

export function stopProfile(id: string): Promise<ProfileRuntime> {
  return apiSend<ProfileRuntime>(API_ROUTES.stopProfile(id), 'POST')
}

/** Export = download the zip, then let the main process ask for a destination and write it. */
export async function exportProfile(id: string, suggestedName: string): Promise<string | null> {
  const bytes = await apiBytes(API_ROUTES.exportProfile(id))
  const result = await window.vfox.saveExport({ suggestedName, base64: toBase64(bytes) })
  return result.saved ? result.path : null
}

export function importProfile(zip: ArrayBuffer): Promise<Profile> {
  return apiSendBytes<Profile>(API_ROUTES.importProfile, zip)
}

/** Picks a zip through the OS dialog, then POSTs the raw bytes. */
export async function importProfileFromDialog(): Promise<Profile | null> {
  const picked = await window.vfox.pickImport()
  if (!picked) return null
  return importProfile(fromBase64(picked.base64))
}

/* --------------------------------------------------------------------------- runtime */

export function listRuntime(): Promise<ProfileRuntime[]> {
  return apiGet<ProfileRuntime[]>(API_ROUTES.runtime)
}

/* ---------------------------------------------------------------------------- groups */

export function listGroups(): Promise<Group[]> {
  return apiGet<Group[]>(API_ROUTES.groups)
}

export function createGroup(name: string): Promise<Group> {
  return apiSend<Group>(API_ROUTES.groups, 'POST', { name })
}

export function renameGroup(id: string, name: string): Promise<Group> {
  return apiSend<Group>(API_ROUTES.group(id), 'PATCH', { name })
}

export function deleteGroup(id: string): Promise<void> {
  return apiSend<void>(API_ROUTES.group(id), 'DELETE')
}

/* --------------------------------------------------------------------------- cookies */

/**
 * The profile's Netscape `cookies.txt`, straight from the server. That route answers raw
 * `text/plain` with a `Content-Disposition` on purpose (`curl -O` has to work against it), so it
 * cannot go through `apiGet` — see `apiText`.
 *
 * Both cookie routes answer 409 while the profile is running: the jar on disk is what is read and
 * written, and a running browser owns it.
 */
export function exportCookies(id: string): Promise<TextDownload> {
  return apiText(API_ROUTES.exportCookies(id))
}

export function importCookies(id: string, input: CookieImportRequest): Promise<CookieImportResult> {
  return apiSend<CookieImportResult>(API_ROUTES.importCookies(id), 'POST', input)
}

/* -------------------------------------------------------------- window synchroniser */

/**
 * The live session, or `null` when nothing is being mirrored. The same object arrives on the
 * `sync` SSE event; this call is only the seed for a view that opens after the session started.
 */
export function getSync(): Promise<SyncSession | null> {
  return apiGet<SyncSession | null>(API_ROUTES.sync)
}

export function startSync(input: SyncStart): Promise<SyncSession> {
  return apiSend<SyncSession>(API_ROUTES.syncStart, 'POST', input)
}

/** Stopping while nothing is active is a no-op on the server, not an error. */
export function stopSync(): Promise<void> {
  return apiSend<void>(API_ROUTES.syncStop, 'POST')
}

/**
 * Arrange real OS windows. Fails with `ApiError.code === 'tiling_unavailable'` (HTTP 501) when the
 * host cannot do it — a non-Windows platform, a missing `koffi`, or a display index that does not
 * exist. The message is written to be shown to the user as-is.
 */
export function tileWindows(input: TileRequest): Promise<void> {
  return apiSend<void>(API_ROUTES.syncTile, 'POST', input)
}

/* ---------------------------------------------------------------------------- kernel */

export function getHealth(): Promise<Health> {
  return apiGet<Health>(API_ROUTES.health)
}

export function getKernel(): Promise<KernelInfo> {
  return apiGet<KernelInfo>(API_ROUTES.kernel)
}

export function installKernel(): Promise<{ started: boolean }> {
  return apiSend<{ started: boolean }>(API_ROUTES.kernelInstall, 'POST')
}
