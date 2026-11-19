/**
 * 本地持久化：一份 JSON，落在 app.getPath('userData')。
 *
 * 为什么放主进程而不是 localStorage：
 *   1. 凭据（access/refresh token）不该躺在渲染层的存储里；
 *   2. 多个服务器要各自隔离凭据（walletKey = 规范化后的服务器 URL），
 *      这份映射需要一个稳定、可原子写的地方。
 *
 * 写盘一律「临时文件 + rename」，避免掉电/崩溃留下半截 JSON 把配置读挂。
 * 而每次写盘之前会**从磁盘现读一份**（见 mutate）：应用允许多实例（双击音频文件会另起一个
 * 只有迷你播放器的实例），各自持一份启动时的快照、整份写回的话，两边会互相抹除对方的改动。
 */

import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { DEFAULT_SETTINGS, type AppSettings, type ServerEntry } from '@shared/ipc'
import { EMPTY_RENDER_CACHE_STATE, type RenderCacheState } from '@shared/render-cache'
import { PLAY_MODES } from '@shared/types'
import type { PendingClientUpdate } from '@shared/update'
import type { StoredCredentials } from '@shared/bridge-types'

export type { StoredCredentials }

export interface WindowBounds {
  x?: number
  y?: number
  width: number
  height: number
  maximized: boolean
}

interface ConfigFile {
  schema: 1
  settings: AppSettings
  servers: ServerEntry[]
  credentials: Record<string, StoredCredentials>
  window: WindowBounds
  /**
   * 上次见到的「客户端 / 后端 / 插件」版本三件套（见 shared/render-cache.ts）。
   *
   * ★ 它不是设置，也不该进 AppSettings：这两者的差别不是审美 —— AppSettings 会经 IPC
   *   整份交给渲染层，而版本记录只有主进程读写，混进去等于把内部簿记也变成「可改的偏好」。
   * ★ 必须落盘：不落盘的话每次启动都会把三件套当成「第一次见到」，于是永远不清缓存 ——
   *   而它要防的正是「旧远端代码跨版本驻留」。
   */
  renderCache: RenderCacheState
  /**
   * 已经下载好、等着在下次启动时提示安装的那一份安装包（见 main/pending-update.ts）。
   *
   * ★ 与 renderCache 同一类：只有主进程读写，**不属于 AppSettings** —— 后者会整份交给
   *   渲染层，而这是一份内部簿记，混进去等于让它变成「可改的偏好」。
   * ★ 必须落盘：从下载完到下次启动之间进程会重启，只放内存就等于没记。
   */
  pendingUpdate: PendingClientUpdate | null
  /**
   * 已经下载过、仍在磁盘上的安装包（目标版本 tag → 下载记录）。
   *
   * ★ 与 pendingUpdate 的分工：后者只记「下次启动要提示安装」的**那一份**（装过就清），
   *   这里记的是**所有**下过的版本 —— 「已下载的版本号不重复下载」靠它判（见
   *   main/update-download.ts 与 index.ts 的 clientUpdateDownload）。
   * ★ 同为内部簿记，不属于 AppSettings：版本与路径只有主进程读写，混进设置等于把它
   *   变成「可改的偏好」。
   */
  downloadedUpdates: Record<string, PendingClientUpdate>
}

const DEFAULT_WINDOW: WindowBounds = { width: 1440, height: 920, maximized: false }

/** 与 Flutter 端 SecureStorageService.walletKey 同义：按服务器 URL 隔离凭据 */
export function walletKeyFor(url: string): string {
  try {
    const u = new URL(url)
    return `${u.protocol}//${u.host}`
  } catch {
    return url.trim().replace(/\/+$/, '')
  }
}

function emptyConfig(): ConfigFile {
  return {
    schema: 1,
    settings: { ...DEFAULT_SETTINGS },
    servers: [],
    credentials: {},
    window: { ...DEFAULT_WINDOW },
    renderCache: { ...EMPTY_RENDER_CACHE_STATE },
    pendingUpdate: null,
    downloadedUpdates: {}
  }
}

/**
 * 待安装记录的形状归一：任何一项对不上就当没记过（返回 null）。
 *
 * ★ 这份 JSON 是用户（以及别的程序）能改的：宁可当成「没有待安装的更新」，也不要拿半截
 *   记录去碰文件系统或 shell —— 那正是这条路里最危险的一步（主进程会按它 openPath）。
 */
function pendingUpdateOf(value: unknown): PendingClientUpdate | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Partial<PendingClientUpdate>
  if (typeof raw.path !== 'string' || !raw.path) return null
  if (typeof raw.version !== 'string' || !raw.version) return null
  if (typeof raw.name !== 'string' || !raw.name) return null
  if (typeof raw.size !== 'number' || !Number.isFinite(raw.size) || raw.size <= 0) return null
  if (typeof raw.downloadedAt !== 'number' || !Number.isFinite(raw.downloadedAt)) return null
  return {
    path: raw.path,
    version: raw.version,
    name: raw.name,
    size: raw.size,
    downloadedAt: raw.downloadedAt
  }
}

/**
 * 已下载安装包的形状归一：键与记录里的版本必须一致，记录本身过一遍 pendingUpdateOf。
 * 对不上的整条当没记过 —— 宁可重下一次，也不要拿坏记录去碰文件系统。
 */
function downloadedUpdatesOf(value: unknown): Record<string, PendingClientUpdate> {
  if (!value || typeof value !== 'object') return {}
  const result: Record<string, PendingClientUpdate> = {}
  for (const [version, item] of Object.entries(value as Record<string, unknown>)) {
    const record = pendingUpdateOf(item)
    if (record && record.version === version) result[version] = record
  }
  return result
}

/** 版本记录里那两张表只要「字符串 → 字符串」，别的形状一律当没写过 */
function stringMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') return {}
  const result: Record<string, string> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === 'string' && item) result[key] = item
  }
  return result
}

export class ConfigStore {
  private readonly file: string
  private data: ConfigFile

  constructor(fileName = 'config.json') {
    this.file = join(app.getPath('userData'), fileName)
    this.data = this.load()
  }

  private load(): ConfigFile {
    try {
      if (!existsSync(this.file)) return emptyConfig()
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<ConfigFile>
      // 逐段回退：任何一段坏掉都不该让整个配置失效。
      const persisted: Partial<AppSettings> = raw.settings ?? {}
      const settings = { ...DEFAULT_SETTINGS, ...persisted }
      /*
       * 播放模式少了一档（「顺序播放」，见 shared/types.ts 的 PLAY_MODES）：老配置里存着 'order'
       * 的话得当场换成合法值 —— 否则那一档的图标与文案都取不到（模式键会变成空白按钮），
       * 而用户要一直点到它才会被纠回来。归一放在这一层，而不是让每个消费者各自兜底。
       */
      if (!PLAY_MODES.includes(settings.playMode)) settings.playMode = DEFAULT_SETTINGS.playMode
      /*
       * 「启动时自动检查更新」的开关（boolean）换成了三档的「更新方式」（见 AppSettings.updateMode）：
       * 老配置里明确存着 false 的接成「关闭更新」，true 与缺失都落默认档「仅检查更新」。
       * 旧键留在文件里无害 —— patch 是合并不删键，而没人再读它。
       */
      const legacySettings = persisted as Partial<AppSettings> & { autoCheckUpdate?: boolean }
      if (legacySettings.updateMode === undefined && legacySettings.autoCheckUpdate === false) {
        settings.updateMode = 'off'
      }
      /*
       * 对象型的设置项要**逐项**归一：上面那次展开是浅的，老配置里若只存了半截
       * （这一项此前还带过 `present` / `name` 两个字段），缺的那几档就是 undefined ——
       * 而 `enabled: undefined` 在界面上既不是开也不是关。多出来的旧字段留着无害：没人再读它们。
       */
      settings.githubDiscovery = {
        ...DEFAULT_SETTINGS.githubDiscovery,
        ...persisted.githubDiscovery
      }
      /*
       * 迷你窗那两块面板从前**共用**一份底色浓度与高度，现在各存一份（见 AppSettings）：
       * 老配置里那两个单份的值接给两块 —— 用户拖出来的高度、调好的浓度不该因为这次拆分被打回
       * 默认值。
       * ★ 逐项只在**对应的新键还没落进配置**时接：旧键拆分之后一直留在文件里（patch 是合并、
       *   不删键），每次都接一遍的话，用户之后再调出来的值下次启动会被那个旧值盖回去。
       * ★ 「那两块以前不一样」这种情况不存在，所以一份值接给两块就是等价迁移；接下来各自拖、
       *   各自拧，两份值从此分岔。
       */
      const legacy = persisted as { miniPanelOpacity?: number; miniPanelHeight?: number }
      if (typeof legacy.miniPanelOpacity === 'number') {
        if (persisted.miniLyricsPanelOpacity === undefined) {
          settings.miniLyricsPanelOpacity = legacy.miniPanelOpacity
        }
        if (persisted.miniQueuePanelOpacity === undefined) {
          settings.miniQueuePanelOpacity = legacy.miniPanelOpacity
        }
      }
      if (typeof legacy.miniPanelHeight === 'number') {
        if (persisted.miniLyricsPanelHeight === undefined) {
          settings.miniLyricsPanelHeight = legacy.miniPanelHeight
        }
        if (persisted.miniQueuePanelHeight === undefined) {
          settings.miniQueuePanelHeight = legacy.miniPanelHeight
        }
      }
      return {
        schema: 1,
        settings,
        servers: Array.isArray(raw.servers)
          ? raw.servers.filter((s) => s && typeof s.url === 'string')
          : [],
        credentials: raw.credentials && typeof raw.credentials === 'object' ? raw.credentials : {},
        window: { ...DEFAULT_WINDOW, ...(raw.window ?? {}) },
        renderCache: {
          client: typeof raw.renderCache?.client === 'string' ? raw.renderCache.client : '',
          backend: stringMap(raw.renderCache?.backend),
          plugins: stringMap(raw.renderCache?.plugins)
        },
        pendingUpdate: pendingUpdateOf(raw.pendingUpdate),
        downloadedUpdates: downloadedUpdatesOf(raw.downloadedUpdates)
      }
    } catch (error) {
      console.error('[store] 配置读取失败，回退到默认值', error)
      return emptyConfig()
    }
  }

  private persist(): void {
    const dir = dirname(this.file)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8')
    renameSync(tmp, this.file)
  }

  /**
   * 现读现改：把**磁盘上那一份**读回来、交给 `mutate` 改、再整份写回去。
   *
   * ★ 为什么不是直接改内存里这份（以前就是这么写的）：**应用允许多实例** —— 双击音频文件会
   *   另起一个只有迷你播放器的实例，而各实例共享同一个 userData 目录（见 AGENTS.md 的
   *   「本地文件会话」）。于是「各自持一份启动时的快照 + 整份写回」等于「后写的把先写的抹掉」：
   *   那边刚存下的播放队列 / 音量 / 面板高度，会被这边一次毫不相干的写入打回旧值 ——
   *   症状是「我明明拖高了面板，过一会儿它自己变回去了」，而两次写入之间看不出任何关系。
   *   每次写都从磁盘重读一次，这种互相抹除就不存在了。
   * ★ 代价可以忽略：这些写入都是用户动作（改设置、存凭据、拖窗口）或退出时的收尾，
   *   不是每帧一次；文件本身也只有几 KB。
   * ★ 读回来那一份会**替换**内存里这份，顺带让本进程看到别的实例刚写下的值。
   */
  private mutate(change: (data: ConfigFile) => void): void {
    const next = this.load()
    change(next)
    this.data = next
    this.persist()
  }

  // ── settings ───────────────────────────────────────────────────────────
  getSettings(): AppSettings {
    return { ...this.data.settings }
  }

  patchSettings(patch: Partial<AppSettings>): AppSettings {
    this.mutate((data) => {
      data.settings = { ...data.settings, ...patch }
    })
    return this.getSettings()
  }

  resetSettings(): AppSettings {
    this.mutate((data) => {
      data.settings = { ...DEFAULT_SETTINGS }
    })
    return this.getSettings()
  }

  // ── servers ────────────────────────────────────────────────────────────
  listServers(): ServerEntry[] {
    return this.data.servers.map((s) => ({ ...s }))
  }

  upsertServer(entry: ServerEntry): ServerEntry[] {
    const key = walletKeyFor(entry.url)
    this.mutate((data) => {
      const rest = data.servers.filter((s) => walletKeyFor(s.url) !== key)
      data.servers = [{ ...entry, url: key }, ...rest]
    })
    return this.listServers()
  }

  removeServer(url: string): ServerEntry[] {
    const key = walletKeyFor(url)
    this.mutate((data) => {
      data.servers = data.servers.filter((s) => walletKeyFor(s.url) !== key)
      delete data.credentials[key]
    })
    return this.listServers()
  }

  // ── credentials ────────────────────────────────────────────────────────
  getCredentials(url: string): StoredCredentials | null {
    return this.data.credentials[walletKeyFor(url)] ?? null
  }

  setCredentials(url: string, creds: Omit<StoredCredentials, 'savedAt'>): void {
    const key = walletKeyFor(url)
    this.mutate((data) => {
      // 合并而不是整条覆盖：token 静默刷新时只带 token 三件套，
      // 覆盖写会把登录时记下的 username 抹掉（界面上的账号名就没了）。
      data.credentials[key] = { ...data.credentials[key], ...creds, savedAt: Date.now() }
    })
  }

  clearCredentials(url: string): void {
    const key = walletKeyFor(url)
    this.mutate((data) => {
      delete data.credentials[key]
    })
  }

  /**
   * 本机存着凭据的服务器 → 那台服务器上登录过的账号名（walletKey → username，可能为空串）。
   *
   * 登录页要在服务器列表里显示两件事：「这台机器上用的是哪个账号」，以及**哪些服务器还有
   * 凭据**（没有的那几台不该算「已保存的登录」）。但渲染层不该为了一个标签就把 token 也
   * 一起取走 —— 所以单独开一条只回账号名的读路径。
   *
   * ★ 因此**键集本身就是信息**：有键 = 有凭据；值空 = 有凭据但没记下账号名
   *   （正常情况下不会出现：登录时一定把 username 一起写进来）。别改回「只收有账号名的」——
   *   那样「哪些还有凭据」就无从判断，退出登录后的服务器会继续挂在登录页的「已保存的登录」里。
   */
  listAccounts(): Record<string, string> {
    const accounts: Record<string, string> = {}
    for (const [key, creds] of Object.entries(this.data.credentials)) {
      accounts[key] = creds.username ?? ''
    }
    return accounts
  }

  // ── 渲染缓存版本记录（见 shared/render-cache.ts）──────────────────────────
  getRenderCacheState(): RenderCacheState {
    return {
      client: this.data.renderCache.client,
      backend: { ...this.data.renderCache.backend },
      plugins: { ...this.data.renderCache.plugins }
    }
  }

  setRenderCacheState(state: RenderCacheState): void {
    this.mutate((data) => {
      data.renderCache = {
        client: state.client,
        backend: { ...state.backend },
        plugins: { ...state.plugins }
      }
    })
  }

  // ── 待安装的客户端更新（见 main/pending-update.ts）────────────────────────
  getPendingUpdate(): PendingClientUpdate | null {
    return this.data.pendingUpdate ? { ...this.data.pendingUpdate } : null
  }

  setPendingUpdate(update: PendingClientUpdate | null): void {
    this.mutate((data) => {
      data.pendingUpdate = update ? { ...update } : null
    })
  }

  // ── 已下载过的安装包（同版本去重，见 main/update-download.ts）──────────────
  getDownloadedUpdate(version: string): PendingClientUpdate | null {
    const record = this.data.downloadedUpdates[version]
    return record ? { ...record } : null
  }

  setDownloadedUpdate(update: PendingClientUpdate): void {
    this.mutate((data) => {
      data.downloadedUpdates[update.version] = { ...update }
    })
  }

  // ── window ─────────────────────────────────────────────────────────────
  getWindowBounds(): WindowBounds {
    return { ...this.data.window }
  }

  saveWindowBounds(bounds: Partial<WindowBounds>): void {
    this.mutate((data) => {
      data.window = { ...data.window, ...bounds }
    })
  }
}
