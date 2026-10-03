import {
  API_ROUTES,
  type Group,
  type Health,
  type KernelInfo,
  type Profile,
  type ProfileCreate,
  type ProfileRuntime,
  type ProfileUpdate,
} from '@vfox/shared'
import { apiBytes, apiGet, apiSend, apiSendBytes, fromBase64, toBase64 } from './http'

/* ------------------------------------------------------------------------- profiles */

export function listProfiles(): Promise<Profile[]> {
  return apiGet<Profile[]>(API_ROUTES.profiles)
}

export function createProfile(input: ProfileCreate): Promise<Profile> {
  return apiSend<Profile>(API_ROUTES.profiles, 'POST', input)
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
