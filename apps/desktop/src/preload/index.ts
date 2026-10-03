/**
 * The only bridge between the renderer and the main process.
 *
 * It carries connection facts (`apiBase` + `token`) and a handful of OS capabilities (open a
 * path, reveal a path, pick/save a file, probe a proxy endpoint, retry the embedded service).
 * Every piece of product logic — profiles, groups, runtime, kernel — travels over plain HTTP
 * to the loopback API, so the GUI, the CLI and external automation share one contract.
 */

import { contextBridge, ipcRenderer } from 'electron'
import { BRIDGE_ARG_PREFIX, type BridgePayload, type VfoxBridge } from '../shared/bridge'

const FALLBACK: BridgePayload = {
  apiBase: '',
  token: '',
  version: '0.0.0',
  platform: process.platform,
  dataDir: '',
  serviceError: '主进程未能传递连接信息',
}

function readPayload(): BridgePayload {
  const raw = process.argv.find((arg) => arg.startsWith(BRIDGE_ARG_PREFIX))
  if (!raw) return FALLBACK
  try {
    const parsed = JSON.parse(decodeURIComponent(raw.slice(BRIDGE_ARG_PREFIX.length))) as Partial<BridgePayload>
    return { ...FALLBACK, ...parsed }
  } catch {
    return FALLBACK
  }
}

const payload = readPayload()

const bridge: VfoxBridge = {
  ...payload,
  openPath: (path) => ipcRenderer.invoke('vfox:open-path', path),
  revealPath: (path) => ipcRenderer.invoke('vfox:reveal-path', path),
  probeProxy: (input) => ipcRenderer.invoke('vfox:probe-proxy', input),
  restartService: () => ipcRenderer.invoke('vfox:restart-service'),
  saveExport: (input) => ipcRenderer.invoke('vfox:save-export', input),
  pickImport: () => ipcRenderer.invoke('vfox:pick-import'),
  profileDir: (profileId) => ipcRenderer.invoke('vfox:profile-dir', profileId),
}

contextBridge.exposeInMainWorld('vfox', bridge)
