/**
 * preload：唯一的「渲染层 ↔ 系统能力」白名单桥。
 *
 * 三条硬约束（改这个文件前先读一遍）：
 *   1. 只暴露**具体方法**，绝不暴露 ipcRenderer 本身 —— 否则等于把整条 IPC 通道
 *      交给页面脚本，contextIsolation 就白开了。
 *   2. sandbox: true 下 preload 是 CJS，且只能用 electron 的 ipcRenderer / contextBridge。
 *   3. 订阅类接口必须返回「取消订阅」函数，否则 React 严格模式下的双次挂载会堆监听。
 */

import { contextBridge, ipcRenderer } from 'electron'

import { IPC } from '@shared/ipc'
import type {
  AppSettings,
  ClientUpdateCheck,
  ClientUpdateProxies,
  FileOpenResult,
  FileSaveResult,
  LocalCacheStats,
  MediaCommand,
  MiniCommand,
  MiniPlayerSnapshot,
  MiniWindowLayout,
  ServerEntry,
  TraySnapshot,
  WindowState
} from '@shared/ipc'
import type { CoverBytes, SongloftBridge, StoredCredentials } from '@shared/bridge'
import type { CastAction, CastRequest, DlnaDevice, DlnaStatus } from '@shared/dlna'
import type { GithubDiscoveryRequest, GithubDiscoveryResult } from '@shared/github-discovery'

function subscribe<T>(channel: string, handler: (payload: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, payload: T): void => handler(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const bridge: SongloftBridge = {
  settings: {
    get: () => ipcRenderer.invoke(IPC.settingsGet) as Promise<AppSettings>,
    patch: (patch) => ipcRenderer.invoke(IPC.settingsPatch, patch) as Promise<AppSettings>,
    reset: () => ipcRenderer.invoke(IPC.settingsReset) as Promise<AppSettings>
  },
  credentials: {
    get: (url) => ipcRenderer.invoke(IPC.credentialsGet, url) as Promise<StoredCredentials | null>,
    set: (url, creds) => ipcRenderer.invoke(IPC.credentialsSet, url, creds) as Promise<void>,
    clear: (url) => ipcRenderer.invoke(IPC.credentialsClear, url) as Promise<void>
  },
  servers: {
    list: () => ipcRenderer.invoke(IPC.serversList) as Promise<ServerEntry[]>,
    upsert: (entry) => ipcRenderer.invoke(IPC.serversUpsert, entry) as Promise<ServerEntry[]>,
    remove: (url) => ipcRenderer.invoke(IPC.serversRemove, url) as Promise<ServerEntry[]>,
    probe: (url) => ipcRenderer.invoke(IPC.serversProbe, url),
    accounts: () => ipcRenderer.invoke(IPC.serversAccounts) as Promise<Record<string, string>>
  },
  window: {
    minimize: () => ipcRenderer.invoke(IPC.windowMinimize) as Promise<void>,
    toggleMaximize: () => ipcRenderer.invoke(IPC.windowToggleMaximize) as Promise<boolean>,
    close: () => ipcRenderer.invoke(IPC.windowClose) as Promise<void>,
    getState: () => ipcRenderer.invoke(IPC.windowGetState) as Promise<WindowState>
  },
  mini: {
    setOpen: (open) => ipcRenderer.invoke(IPC.miniSetOpen, open) as Promise<void>,
    isOpen: () => ipcRenderer.invoke(IPC.miniIsOpen) as Promise<boolean>,
    resize: (layout: MiniWindowLayout) =>
      ipcRenderer.invoke(IPC.miniResize, layout) as Promise<void>,
    ready: () => ipcRenderer.invoke(IPC.miniReady) as Promise<void>,
    push: (snapshot: MiniPlayerSnapshot) =>
      ipcRenderer.invoke(IPC.miniPush, snapshot) as Promise<void>,
    command: (command: MiniCommand) =>
      ipcRenderer.invoke(IPC.miniCommand, command) as Promise<void>,
    onOpen: (handler) => subscribe<boolean>(IPC.onMiniOpen, handler),
    onState: (handler) => subscribe<MiniPlayerSnapshot>(IPC.onMiniState, handler),
    onRequest: (handler) => subscribe<void>(IPC.onMiniRequest, () => handler()),
    onCommand: (handler) => subscribe<MiniCommand>(IPC.onMiniCommand, handler)
  },
  cast: {
    devices: (refresh) =>
      ipcRenderer.invoke(IPC.castDevices, refresh ?? false) as Promise<DlnaDevice[]>,
    start: (request: CastRequest) =>
      ipcRenderer.invoke(IPC.castStart, request) as Promise<DlnaStatus>,
    control: (action: CastAction, value) =>
      ipcRenderer.invoke(IPC.castControl, action, value ?? 0) as Promise<DlnaStatus>,
    status: () => ipcRenderer.invoke(IPC.castStatus) as Promise<DlnaStatus>,
    stop: () => ipcRenderer.invoke(IPC.castStop) as Promise<void>,
    onState: (handler) => subscribe<DlnaStatus>(IPC.onCastState, handler)
  },
  tray: {
    update: (snapshot: TraySnapshot) =>
      ipcRenderer.invoke(IPC.trayUpdate, snapshot) as Promise<void>
  },
  shell: {
    openExternal: (url) => ipcRenderer.invoke(IPC.openExternal, url) as Promise<void>
  },
  files: {
    save: (suggestedName, contents) =>
      ipcRenderer.invoke(IPC.fileSave, suggestedName, contents) as Promise<FileSaveResult>,
    open: () => ipcRenderer.invoke(IPC.fileOpen) as Promise<FileOpenResult | null>
  },
  localFiles: {
    open: () => ipcRenderer.invoke(IPC.localFilesOpen) as Promise<string[]>,
    takePending: () => ipcRenderer.invoke(IPC.localFilesTakePending) as Promise<string[]>,
    onPending: (handler) => subscribe<void>(IPC.onLocalFilesPending, () => handler())
  },
  cache: {
    stats: () => ipcRenderer.invoke(IPC.localCacheStats) as Promise<LocalCacheStats>,
    clear: () => ipcRenderer.invoke(IPC.localCacheClear) as Promise<LocalCacheStats>
  },
  app: {
    info: () => ipcRenderer.invoke(IPC.appInfo),
    checkClientUpdate: (proxies: ClientUpdateProxies) =>
      ipcRenderer.invoke(IPC.clientUpdateCheck, proxies) as Promise<ClientUpdateCheck>
  },
  github: {
    discover: (request: GithubDiscoveryRequest) =>
      ipcRenderer.invoke(IPC.githubDiscovery, request) as Promise<GithubDiscoveryResult>
  },
  cover: {
    bytes: (url) => ipcRenderer.invoke(IPC.colorExtract, url) as Promise<CoverBytes | null>
  },
  on: {
    mediaCommand: (handler) => subscribe<MediaCommand>(IPC.onMediaCommand, handler),
    windowState: (handler) => subscribe<WindowState>(IPC.onWindowState, handler),
    navigate: (handler) => subscribe<string>(IPC.onNavigate, handler),
    settingsChanged: (handler) => subscribe<AppSettings>(IPC.onSettingsChanged, handler)
  }
}

contextBridge.exposeInMainWorld('songloft', bridge)
