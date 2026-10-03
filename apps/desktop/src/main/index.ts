/**
 * VFox desktop main process.
 *
 * Responsibilities, and nothing else:
 *  - own the single-instance lock and the one BrowserWindow;
 *  - start `@vfox/server` in-process on `app.getPath('userData')` and hand `url` + `token`
 *    to the renderer through the preload bridge;
 *  - tray (显示主界面 / 全部停止 / 退出), window bounds restore, quit stops every profile.
 *
 * No business logic lives here: the GUI, the CLI and the API all speak the same HTTP contract.
 * No auto-updater, no crash reporter, no devtools in production, no telemetry.
 */

import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BrowserWindow, Menu, Tray, app, dialog, ipcMain, shell } from 'electron'
import { APP_ID, PRODUCT_NAME } from '@vfox/shared'
import { BRIDGE_ARG_PREFIX, type BridgePayload } from '../shared/bridge'
import { probeProxy, resolveDataDir, startService, stopAllProfiles, stopService } from './service.js'
import { createTray } from './tray.js'
import { loadUiState, saveUiState, trackWindowState, type UiState } from './window-state.js'

const isDev = !app.isPackaged
const here = dirname(fileURLToPath(import.meta.url))

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let uiState: UiState
let dataDir = ''
let quitting = false

/* ------------------------------------------------------------------ single instance */

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => showWindow())
  void bootstrap()
}

/* ------------------------------------------------------------------------- bootstrap */

async function bootstrap(): Promise<void> {
  // Must happen before `ready`: in dev and CI the sandbox only allows writes inside the repo,
  // so VFOX_DATA_DIR moves BOTH Chromium's user data and the profile store there. In a normal
  // install it is unset and everything lands in %APPDATA%\VFox.
  const override = resolveDataDir('')
  if (override) {
    mkdirSync(override, { recursive: true })
    app.setPath('userData', override)
    app.setPath('sessionData', override)
  }

  app.setAppUserModelId(APP_ID)
  Menu.setApplicationMenu(null)

  await app.whenReady()

  dataDir = resolveDataDir(app.getPath('userData'))
  mkdirSync(dataDir, { recursive: true })
  uiState = loadUiState(dataDir)

  const service = await startService(dataDir)

  registerIpc(dataDir)
  createWindow(service.url, service.token, service.error)

  tray = createTray(join(resourceRoot(), 'tray.png'), {
    show: () => showWindow(),
    stopAll: () => void handleStopAll(),
    quit: () => app.quit(),
  })

  app.on('activate', () => showWindow())
}

/** `resources/` in dev, `process.resourcesPath` once packaged (electron-builder extraResources). */
function resourceRoot(): string {
  return app.isPackaged ? process.resourcesPath : join(here, '..', '..', 'resources')
}

/* ---------------------------------------------------------------------------- window */

function createWindow(apiBase: string, token: string, serviceError: string | null): void {
  mainWindow = new BrowserWindow({
    ...uiState.window,
    minWidth: 940,
    minHeight: 600,
    show: false,
    title: PRODUCT_NAME,
    backgroundColor: '#f5f6f8',
    autoHideMenuBar: true,
    icon: join(resourceRoot(), 'icon.png'),
    webPreferences: {
      preload: join(here, '..', 'preload', 'index.mjs'),
      // ESM preload scripts require sandbox: false. contextIsolation stays on and the renderer
      // has no Node access, which is what actually matters here.
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      additionalArguments: [`${BRIDGE_ARG_PREFIX}${encodeURIComponent(JSON.stringify({
        apiBase,
        token,
        version: app.getVersion(),
        platform: process.platform,
        dataDir,
        serviceError,
      } satisfies BridgePayload))}`],
    },
  })

  if (uiState.maximized) mainWindow.maximize()

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
    if (isDev && process.env.VFOX_DEVTOOLS === '1') mainWindow?.webContents.openDevTools({ mode: 'detach' })
  })

  // Closing the window hides it: the profiles keep running and the tray brings it back.
  mainWindow.on('close', (event) => {
    if (quitting) return
    event.preventDefault()
    mainWindow?.hide()
    if (!uiState.trayHintShown) {
      uiState = { ...uiState, trayHintShown: true }
      saveUiState(dataDir, uiState)
      tray?.displayBalloon({ title: 'VFox 仍在后台运行', content: '环境会继续运行，可从托盘图标重新打开主界面。' })
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  trackWindowState(mainWindow, dataDir, () => uiState)

  // External links open in the user's browser, never inside the app shell.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })

  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (isDev && devUrl) {
    void mainWindow.loadURL(devUrl)
  } else {
    void mainWindow.loadFile(join(here, '..', 'renderer', 'index.html'))
  }
}

function showWindow(): void {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

/* ------------------------------------------------------------------------------- ipc */

function registerIpc(storeDir: string): void {
  ipcMain.handle('vfox:open-path', async (_event, target: string) => {
    if (typeof target !== 'string' || target.length === 0) return '无效路径'
    return shell.openPath(target)
  })

  ipcMain.handle('vfox:reveal-path', (_event, target: string) => {
    if (typeof target !== 'string' || target.length === 0) return false
    shell.showItemInFolder(target)
    return true
  })

  ipcMain.handle('vfox:probe-proxy', async (_event, input: { host: string; port: number }) => {
    if (!input || typeof input.host !== 'string' || !Number.isInteger(input.port)) {
      return { ok: false, ms: null, message: '代理地址不完整' }
    }
    return probeProxy(input.host, input.port)
  })

  /** Lets the 重试 button in the renderer re-run the in-process bootstrap after a failure. */
  ipcMain.handle('vfox:restart-service', async () => startService(storeDir))

  ipcMain.handle('vfox:save-export', async (_event, input: { suggestedName: string; base64: string }) => {
    const window = mainWindow
    if (!window) return { saved: false, path: null as string | null }
    const result = await dialog.showSaveDialog(window, {
      title: '导出环境',
      defaultPath: input.suggestedName,
      filters: [{ name: 'VFox 环境包', extensions: ['zip'] }],
    })
    if (result.canceled || !result.filePath) return { saved: false, path: null as string | null }
    const { writeFile } = await import('node:fs/promises')
    await writeFile(result.filePath, Buffer.from(input.base64, 'base64'))
    return { saved: true, path: result.filePath }
  })

  ipcMain.handle('vfox:pick-import', async () => {
    const window = mainWindow
    if (!window) return null
    const result = await dialog.showOpenDialog(window, {
      title: '导入环境',
      properties: ['openFile'],
      filters: [{ name: 'VFox 环境包', extensions: ['zip'] }],
    })
    const file = result.filePaths[0]
    if (result.canceled || !file) return null
    const { readFile } = await import('node:fs/promises')
    const bytes = await readFile(file)
    return { name: file.split(/[\\/]/).pop() ?? file, base64: bytes.toString('base64') }
  })

  ipcMain.handle('vfox:profile-dir', (_event, profileId: string) => {
    if (typeof profileId !== 'string' || profileId.length === 0) return storeDir
    return join(storeDir, 'profiles', profileId, 'userdata')
  })
}

/* ------------------------------------------------------------------------------ quit */

async function handleStopAll(): Promise<void> {
  const stopped = await stopAllProfiles()
  if (stopped > 0) console.info(`[vfox] stopped ${stopped} profile(s)`)
}

app.on('before-quit', (event) => {
  if (quitting) return
  event.preventDefault()
  quitting = true
  void (async () => {
    await handleStopAll()
    await stopService()
    app.quit()
  })()
})

app.on('window-all-closed', () => {
  // Intentionally empty: the tray keeps the app (and the embedded API) alive. Quitting is an
  // explicit user action (tray 退出), which stops every profile first.
})
