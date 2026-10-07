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
 *
 * The installer must never be able to damage the machine it lands on, so this process
 * registers no protocol handler, no file association, no auto-start entry, no scheduled task
 * and no service, never writes to HKLM, and never touches the hosts file, proxy settings,
 * firewall rules, PATH or Defender exclusions.
 */

import { mkdirSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { APP_ID, HOMEPAGE, PRODUCT_NAME } from '@vfox/shared'
import { app, BrowserWindow, dialog, ipcMain, Menu, shell, type Tray } from 'electron'
import { BRIDGE_CHANNEL, type BridgePayload } from '../shared/bridge'
import { type DataMode, resolveDataLocation } from './data-location.js'
import { profileUsage } from './profile-usage.js'
import {
  configureLogging,
  logInfo,
  probeProxy,
  startService,
  stopAllProfiles,
  stopService,
} from './service.js'
import { createTray } from './tray.js'
import { loadUiState, saveUiState, trackWindowState, type UiState } from './window-state.js'

const isDev = !app.isPackaged

/**
 * `out/main` at runtime. The main bundle is CommonJS (see electron.vite.config.ts), so
 * `__dirname` is the real thing here — `import.meta.url` would not exist.
 */
declare const __dirname: string
const here = __dirname

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let uiState: UiState
let dataDir = ''
let dataMode: DataMode = 'installed'
let quitting = false
let bridgePayload: BridgePayload = {
  apiBase: '',
  token: '',
  version: '0.0.0',
  platform: process.platform,
  dataDir: '',
  dataMode: 'installed',
  serviceError: '主进程尚未就绪',
}

/* ------------------------------------------------------- data location, THEN the instance lock */

/*
 * ORDER IS LOAD-BEARING, and the old order only looked deliberate.
 *
 * `requestSingleInstanceLock()` keys its lock on `app.getPath('userData')` **at the moment of the
 * call**. In portable and custom mode that path is redirected a few lines below, so taking the lock
 * first — which this file did until issue #89 — keyed every copy on the default `%APPDATA%\VFox`:
 * two independent portable folders (separate installs, separate data directories, no shared state)
 * refused to run at the same time, and a portable copy blocked an installed one. The user saw
 * "already running" with no way to tell why.
 *
 * The lock is therefore per DATA DIRECTORY, which is the intended policy, not an accident:
 *   - the same folder launched twice still hits `second-instance`, which focuses the first window
 *     and exits — the case that handler exists for;
 *   - a portable copy and an installed copy, or two portable copies, are different products with
 *     different stores, and must be able to run side by side.
 * Keeping two processes out of ONE store is not this lock's job: `@vfox/core` takes its own
 * exclusive lock on the data directory (issue #39, `acquireDataDirLock`). Both are keyed on the same
 * directory now, which is what makes them complementary rather than accidentally overlapping.
 *
 * Resolved before `ready`, and in portable/custom mode Chromium's own user data is moved too:
 * otherwise a "portable" build would still scatter cache and cookies outside its folder.
 */
const location = resolveDataLocation()
dataDir = location.dir
dataMode = location.mode
mkdirSync(dataDir, { recursive: true })
if (location.mode !== 'installed') {
  app.setPath('userData', dataDir)
  app.setPath('sessionData', dataDir)
}

/* ------------------------------------------------------------------ single instance */

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    // Logged through the app's own sink, so the handover is observable from outside the process:
    // the packaged suite asserts on this line to tell "the second copy handed over" apart from
    // "the second copy refused to start" (issue #89). stdout is not enough — the suite spawns the
    // app with stdout ignored.
    logInfo('second instance launched — focusing the existing window')
    showWindow()
  })
  void bootstrap()
}

/* ------------------------------------------------------------------------- bootstrap */

async function bootstrap(): Promise<void> {
  // `dataDir` and Chromium's own user data are already resolved and redirected above, before the
  // lock — see the comment there for why that order is not negotiable.

  // Sandbox every renderer, including any future one.
  app.enableSandbox()
  app.setAppUserModelId(APP_ID)
  Menu.setApplicationMenu(null)

  await app.whenReady()

  // Logs live inside the data directory, so they move with a portable folder.
  configureLogging(join(dataDir, 'logs'))
  uiState = loadUiState(dataDir)

  // Point the engine at a stable, app-owned directory BEFORE @vfox/server (and therefore
  // @vfox/core and camoufox-js) is loaded, but never override an explicit setting: local
  // development keeps using the repo cache and must not re-download 550 MB.
  if (!process.env.CAMOUFOX_INSTALL_DIR) {
    process.env.CAMOUFOX_INSTALL_DIR = join(dataDir, 'engine')
  }

  const service = await startService(dataDir)
  bridgePayload = {
    apiBase: service.url,
    token: service.token,
    version: app.getVersion(),
    platform: process.platform,
    dataDir,
    dataMode,
    serviceError: service.error,
  }

  registerIpc()
  createWindow()

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

function createWindow(): void {
  mainWindow = new BrowserWindow({
    ...uiState.window,
    minWidth: 1024,
    minHeight: 700,
    show: false,
    title: PRODUCT_NAME,
    backgroundColor: '#f5f6f8',
    autoHideMenuBar: true,
    icon: join(resourceRoot(), 'icon.png'),
    webPreferences: {
      preload: join(here, '..', 'preload', 'index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      nodeIntegrationInWorker: false,
      webviewTag: false,
      spellcheck: false,
      devTools: isDev,
    },
  })

  if (uiState.maximized) mainWindow.maximize()

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
    if (isDev && process.env.VFOX_DEVTOOLS === '1')
      mainWindow?.webContents.openDevTools({ mode: 'detach' })
  })

  // Closing the window hides it: the profiles keep running and the tray brings it back.
  mainWindow.on('close', event => {
    if (quitting) return
    event.preventDefault()
    mainWindow?.hide()
    if (!uiState.trayHintShown) {
      uiState = { ...uiState, trayHintShown: true }
      saveUiState(dataDir, uiState)
      tray?.displayBalloon({
        title: 'VFox 仍在后台运行',
        content: '环境会继续运行，可从托盘图标重新打开主界面。',
      })
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  trackWindowState(mainWindow, dataDir, () => uiState)

  // Nothing may open a new window, ever — not the app, not a profile, not a remote page.
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  // The renderer is the only thing allowed to navigate this window.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const current = mainWindow?.webContents.getURL() ?? ''
    const sameDocument = current.length > 0 && url.startsWith(current.split('#')[0] ?? current)
    if (!sameDocument) event.preventDefault()
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

/** True when `target` really is inside the app's own data directory. */
function insideDataDir(target: string): boolean {
  const root = resolve(dataDir)
  const rel = relative(root, resolve(target))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

const PROFILE_ID = /^[A-Za-z0-9._-]+$/

function profileUserDataDir(profileId: string): string | null {
  if (!PROFILE_ID.test(profileId)) return null
  return join(dataDir, 'profiles', profileId, 'userdata')
}

function registerIpc(): void {
  // Synchronous on purpose: the preload needs the connection facts before the page runs, and
  // this keeps the bridge a plain object instead of a promise the renderer has to await.
  ipcMain.on(BRIDGE_CHANNEL, event => {
    event.returnValue = bridgePayload
  })

  ipcMain.handle('vfox:open-path', async (_event, target: string) => {
    if (typeof target !== 'string' || target.length === 0) return '无效路径'
    if (!insideDataDir(target)) return '出于安全考虑，只允许打开 VFox 数据目录内的路径'
    mkdirSync(target, { recursive: true })
    return shell.openPath(target)
  })

  ipcMain.handle('vfox:reveal-path', (_event, target: string) => {
    if (typeof target !== 'string' || target.length === 0) return false
    if (!insideDataDir(target)) return false
    shell.showItemInFolder(target)
    return true
  })

  // Zero-argument capability: the renderer cannot pass a URL, so it cannot open anything but
  // this one hardcoded, first-party documentation link.
  ipcMain.handle('vfox:open-homepage', async () => {
    await shell.openExternal(HOMEPAGE)
    return HOMEPAGE
  })

  ipcMain.handle('vfox:probe-proxy', async (_event, input: { host: string; port: number }) => {
    if (!input || typeof input.host !== 'string' || !Number.isInteger(input.port)) {
      return { ok: false, ms: null, message: '代理地址不完整' }
    }
    return probeProxy(input.host, input.port)
  })

  /** Lets the 重试 button in the renderer re-run the in-process bootstrap after a failure. */
  ipcMain.handle('vfox:restart-service', async () => {
    const state = await startService(dataDir)
    bridgePayload = {
      ...bridgePayload,
      apiBase: state.url,
      token: state.token,
      serviceError: state.error,
    }
    return state
  })

  ipcMain.handle('vfox:profile-dir', (_event, profileId: string) => profileUserDataDir(profileId))

  ipcMain.handle('vfox:profile-usage', async (_event, profileId: string) => {
    const dir = profileUserDataDir(profileId)
    if (!dir) return { path: '', exists: false, bytes: 0, files: 0 }
    return profileUsage(dir)
  })

  ipcMain.handle(
    'vfox:save-export',
    async (_event, input: { suggestedName: string; base64: string }) => {
      const window = mainWindow
      if (!window) return { saved: false, path: null as string | null }
      const result = await dialog.showSaveDialog(window, {
        title: '导出环境',
        defaultPath: input.suggestedName,
        filters: [{ name: 'VFox 环境包', extensions: ['zip'] }],
      })
      if (result.canceled || !result.filePath) return { saved: false, path: null as string | null }
      await writeFile(result.filePath, Buffer.from(input.base64, 'base64'))
      return { saved: true, path: result.filePath }
    },
  )

  /**
   * Same shape as `vfox:save-export`, for text that is not a profile package. The title and the
   * filter are the point: a cookie jar is a `.txt` file, and offering it as a `*.zip` package (or
   * appending `.zip` to a cleared filename) would hand the user a file nothing can read back.
   */
  ipcMain.handle(
    'vfox:save-text',
    async (_event, input: { suggestedName: string; content: string }) => {
      const window = mainWindow
      if (!window) return { saved: false, path: null as string | null }
      const result = await dialog.showSaveDialog(window, {
        title: '导出 Cookie',
        defaultPath: input.suggestedName,
        filters: [{ name: 'Cookie 文件', extensions: ['txt'] }],
      })
      if (result.canceled || !result.filePath) return { saved: false, path: null as string | null }
      await writeFile(result.filePath, input.content, 'utf8')
      return { saved: true, path: result.filePath }
    },
  )

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
    const bytes = await readFile(file)
    return { name: file.split(/[\\/]/).pop() ?? file, base64: bytes.toString('base64') }
  })
}

/* ------------------------------------------------------------------------------ quit */

async function handleStopAll(): Promise<void> {
  const stopped = await stopAllProfiles()
  if (stopped > 0) console.info(`[vfox] stopped ${stopped} profile(s)`)
}

app.on('before-quit', event => {
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
