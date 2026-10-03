/**
 * Tray icon: the app keeps running (and keeps browsers alive) when the window is closed,
 * so the tray is the only way back — and the only place 全部停止 / 退出 live.
 */

import { Menu, nativeImage, Tray } from 'electron'

export interface TrayActions {
  show(): void
  stopAll(): void
  quit(): void
}

export function createTray(iconPath: string, actions: TrayActions): Tray {
  const image = nativeImage.createFromPath(iconPath)
  const tray = new Tray(
    image.isEmpty() ? nativeImage.createEmpty() : image.resize({ width: 16, height: 16 }),
  )
  tray.setToolTip('VFox 指纹浏览器')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示主界面', click: () => actions.show() },
      { type: 'separator' },
      { label: '全部停止', click: () => actions.stopAll() },
      { type: 'separator' },
      { label: '退出', click: () => actions.quit() },
    ]),
  )
  // Double click is the Windows muscle memory for "bring the window back".
  tray.on('double-click', () => actions.show())
  return tray
}
