/**
 * The only bridge between the renderer and the main process.
 *
 * It carries connection facts (`apiBase` + `token`) and a handful of OS capabilities (open a
 * path, reveal a path, pick/save a file, probe a proxy endpoint, retry the embedded service,
 * open the first-party homepage). Every piece of product logic — profiles, groups, runtime,
 * kernel — travels over plain HTTP to the loopback API, so the GUI, the CLI and external
 * automation share one contract.
 *
 * Only named functions cross the bridge: `ipcRenderer`, `require`, `process` and any generic
 * `invoke(channel, ...)` stay on this side of the wall.
 */

import { contextBridge, ipcRenderer } from 'electron'
import { BRIDGE_CHANNEL, type BridgePayload, type VfoxBridge } from '../shared/bridge'

const FALLBACK: BridgePayload = {
  apiBase: '',
  token: '',
  version: '0.0.0',
  platform: process.platform,
  dataDir: '',
  serviceError: '主进程未能传递连接信息',
}

function readPayload(): BridgePayload {
  try {
    const payload = ipcRenderer.sendSync(BRIDGE_CHANNEL) as Partial<BridgePayload> | undefined
    return { ...FALLBACK, ...(payload ?? {}) }
  } catch {
    return FALLBACK
  }
}

const bridge: VfoxBridge = {
  ...readPayload(),
  openPath: path => ipcRenderer.invoke('vfox:open-path', path),
  revealPath: path => ipcRenderer.invoke('vfox:reveal-path', path),
  openHomepage: () => ipcRenderer.invoke('vfox:open-homepage'),
  probeProxy: input => ipcRenderer.invoke('vfox:probe-proxy', input),
  restartService: () => ipcRenderer.invoke('vfox:restart-service'),
  profileDir: profileId => ipcRenderer.invoke('vfox:profile-dir', profileId),
  profileUsage: profileId => ipcRenderer.invoke('vfox:profile-usage', profileId),
  saveExport: input => ipcRenderer.invoke('vfox:save-export', input),
  pickImport: () => ipcRenderer.invoke('vfox:pick-import'),
}

contextBridge.exposeInMainWorld('vfox', bridge)
