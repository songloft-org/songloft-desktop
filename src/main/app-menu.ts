/**
 * 应用菜单。
 *
 * 窗口是无边框的，菜单栏看不见 —— 但它仍然提供**全局加速键**（F11 全屏、
 * Ctrl+Shift+I 开发者工具、Ctrl+Q 退出…），这些键需要在渲染层之外也能生效，
 * 所以菜单还是要挂上。
 *
 * 播放相关快捷键（空格、方向键…）不在这里，交给渲染层的 keydown 处理：
 * 那些键有上下文（输入框聚焦时不该触发），放在主进程会失去上下文判断。
 */

import { Menu, app, shell } from 'electron'
import type { BrowserWindow } from 'electron'
import { IPC } from '@shared/ipc'
import { REPO_URL, UPSTREAM_URL } from '@shared/links'
import { announceLocalFiles, openLocalFilesDialog } from './local-files'

export function installAppMenu(getWindow: () => BrowserWindow | null): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: '文件',
      submenu: [
        {
          /**
           * 本地文件的主要入口。菜单栏在无边框窗口里看不见，但加速键照旧生效 ——
           * 而「打开本地文件」这件事本就该有一个键（Ctrl+O 是这一行的通用约定）。
           * 挑完之后交给 announceLocalFiles：它与「双击关联文件」是同一条路。
           */
          label: '打开本地文件…',
          accelerator: 'CmdOrCtrl+O',
          click: async () => {
            announceLocalFiles(await openLocalFilesDialog(getWindow()))
          }
        },
        { type: 'separator' },
        {
          label: '设置',
          accelerator: 'CmdOrCtrl+,',
          click: () => getWindow()?.webContents.send(IPC.onNavigate, '/settings')
        },
        { type: 'separator' },
        { label: '退出', accelerator: 'CmdOrCtrl+Q', role: 'quit' }
      ]
    },
    {
      label: '编辑',
      submenu: [
        { label: '撤销', role: 'undo' },
        { label: '重做', role: 'redo' },
        { type: 'separator' },
        { label: '剪切', role: 'cut' },
        { label: '复制', role: 'copy' },
        { label: '粘贴', role: 'paste' },
        {
          /**
           * ★ 这一项刻意**不用 `role: 'selectAll'`**：那个角色会自带一条
           *   `CmdOrCtrl+A` 加速键，而菜单的加速键在**窗口之前**就把按键吃掉了 ——
           *   渲染层永远收不到这一下，列表里的「Ctrl+A 全选歌曲」于是成了死键
           *   （界面上只会看见一段文字被刷蓝）。
           *   改成普通的 click（无加速键）之后：菜单项照样能用；而输入框里的
           *   Ctrl+A 仍由 Chromium 自带的编辑行为处理 —— 那是浏览器的默认动作，
           *   不依赖菜单里的这一条。
           */
          label: '全选',
          click: () => getWindow()?.webContents.selectAll()
        }
      ]
    },
    {
      label: '视图',
      submenu: [
        { label: '重新加载', accelerator: 'CmdOrCtrl+R', role: 'reload' },
        { label: '开发者工具', accelerator: 'CmdOrCtrl+Shift+I', role: 'toggleDevTools' },
        { type: 'separator' },
        { label: '实际大小', role: 'resetZoom' },
        { label: '放大', role: 'zoomIn' },
        { label: '缩小', role: 'zoomOut' },
        { type: 'separator' },
        { label: '全屏', accelerator: 'F11', role: 'togglefullscreen' }
      ]
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '本仓库（songloft-desktop）',
          click: () => void shell.openExternal(REPO_URL)
        },
        {
          label: '原项目（songloft-player）',
          click: () => void shell.openExternal(UPSTREAM_URL)
        },
        { type: 'separator' },
        {
          label: '打开配置目录',
          click: () => void shell.openPath(app.getPath('userData'))
        }
      ]
    }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
