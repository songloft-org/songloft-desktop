/**
 * preload 暴露给渲染层的白名单接口。
 *
 * 渲染层能做的**全部**跨边界动作就在这里，一个不多。类型放 shared 是为了让
 * preload 的实现和渲染层的调用共用同一份签名 —— 两边各写一份必然漂移。
 */

import type {
  AppInfo,
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
  ServerProbeResult,
  TraySnapshot,
  WindowState
} from './ipc'
import type { StoredCredentials } from './bridge-types'
import type { CastAction, CastRequest, DlnaDevice, DlnaStatus } from './dlna'
import type { GithubDiscoveryRequest, GithubDiscoveryResult } from './github-discovery'

export type { StoredCredentials }

export interface CoverBytes {
  base64: string
  mime: string
}

export interface SongloftBridge {
  settings: {
    get(): Promise<AppSettings>
    patch(patch: Partial<AppSettings>): Promise<AppSettings>
    reset(): Promise<AppSettings>
  }
  credentials: {
    get(url: string): Promise<StoredCredentials | null>
    set(url: string, creds: Omit<StoredCredentials, 'savedAt'>): Promise<void>
    clear(url: string): Promise<void>
  }
  servers: {
    list(): Promise<ServerEntry[]>
    upsert(entry: ServerEntry): Promise<ServerEntry[]>
    remove(url: string): Promise<ServerEntry[]>
    probe(url: string): Promise<ServerProbeResult>
    /** 服务器 URL → 该服务器上登录过的账号名（没登录过的没有这一项） */
    accounts(): Promise<Record<string, string>>
  }
  window: {
    /**
     * 这几颗窗口钮一律**作用于调用它自己所在的那个窗口**（主进程按 event.sender 认窗口），
     * 不是「主窗口」：迷你窗那颗关闭只该关掉迷你条，不该把主界面一起收掉
     * （它有「最小化」时同理，那颗钮现在已从界面上撤掉，但这个语义不变）。
     */
    minimize(): Promise<void>
    toggleMaximize(): Promise<boolean>
    close(): Promise<void>
    getState(): Promise<WindowState>
  }
  /**
   * 迷你窗口（独立 BrowserWindow，见 main/mini-window.ts）。
   *
   * 两边各用一半：主窗口用它开关 + 推状态，迷你窗用它报尺寸 + 收状态 + 发遥控命令。
   * 为什么全要经主进程中转：两个渲染层之间没有直接通道，而播放的唯一事实源在主窗口那边。
   */
  mini: {
    /** 主窗口：开 / 关迷你窗 */
    setOpen(open: boolean): Promise<void>
    /**
     * 主窗口：迷你窗**此刻**开着没有。
     *
     * ★ 与下面的 onOpen 不是一回事：那条只在开合的那一刻响一次，而这段接线可能比窗口晚到
     *   （HMR 重新挂载、渲染层刷新都会重装它）——重装时没有事件可听，只能主动问一句
     *   （见 IPC.miniIsOpen）。
     */
    isOpen(): Promise<boolean>
    /** 迷你窗：报一下此刻的布局（条 / 面板 / 菜单），主进程据此算窗口高度 */
    resize(layout: MiniWindowLayout): Promise<void>
    /** 迷你窗：界面与设置都就绪了 —— 主进程据此显示窗口，并请主窗口推一份状态过来 */
    ready(): Promise<void>
    /** 主窗口：推一份播放状态（主进程转给迷你窗） */
    push(snapshot: MiniPlayerSnapshot): Promise<void>
    /** 迷你窗：发一条遥控命令（主进程转给主窗口执行） */
    command(command: MiniCommand): Promise<void>
    /** 主窗口：迷你窗开没开（按钮高亮、要不要继续推送都看它） */
    onOpen(handler: (open: boolean) => void): () => void
    /** 迷你窗：收到播放状态快照 */
    onState(handler: (snapshot: MiniPlayerSnapshot) => void): () => void
    /** 主窗口：迷你窗在要状态，请立刻推一份完整快照 */
    onRequest(handler: () => void): () => void
    /** 主窗口：收到一条遥控命令 */
    onCommand(handler: (command: MiniCommand) => void): () => void
  }
  /**
   * 投送到局域网音箱（DLNA）。
   *
   * ★ 整段都在主进程：SSDP 组播与 SOAP 控制需要 UDP socket / 原生 HTTP，
   *   渲染层做不了。也**没有后端参与** —— 音箱拉的是那条本来就有的播放地址。
   *
   * ★ 状态是主进程**推**过来的（`onState`），不是渲染层轮询：设备状态每 2 秒变一次，
   *   渲染层再去问一遍只会多一层可能不一致的缓存。
   */
  cast: {
    /** 搜索设备；`refresh` 忽略 60 秒缓存 */
    devices(refresh?: boolean): Promise<DlnaDevice[]>
    /** 推一首给设备并开始播放（`url` 由渲染层用 buildSongUrl 拼好，带 token 与转码参数） */
    start(request: CastRequest): Promise<DlnaStatus>
    control(action: CastAction, value?: number): Promise<DlnaStatus>
    /** 读一次状态（渲染层刷新后接回主进程里可能还在跑的投送会话） */
    status(): Promise<DlnaStatus>
    /** 取消投送 */
    stop(): Promise<void>
    /** 投送状态变化（含「这一首播完了」这种一次性事件） */
    onState(handler: (status: DlnaStatus) => void): () => void
  }
  tray: {
    update(snapshot: TraySnapshot): Promise<void>
  }
  shell: {
    openExternal(url: string): Promise<void>
  }
  files: {
    /** 弹保存框把文本写盘；用户取消时 saved 为 false */
    save(suggestedName: string, contents: string): Promise<FileSaveResult>
    /** 弹打开框读文本；取消返回 null */
    open(): Promise<FileOpenResult | null>
  }
  /**
   * 本地文件的入口（播放本地文件不需要登录，所以这条通道与凭据无关）。
   *
   * 路径在主进程里落成绝对路径后才交出来 —— 渲染层不碰文件系统，也不需要知道 cwd。
   */
  localFiles: {
    /** 弹系统文件框挑音频文件（多选）；取消返回空数组 */
    open(): Promise<string[]>
    /** 取走排在主进程里的那批路径（取走即清空） */
    takePending(): Promise<string[]>
    /** 又有本地文件要打开（关联双击、二次启动、菜单）；回调里应当去 takePending() */
    onPending(handler: () => void): () => void
  }
  cache: {
    /** 本机磁盘缓存（Chromium 的 HTTP 缓存）的占用与**生效中**的上限 */
    stats(): Promise<LocalCacheStats>
    /** 清掉本机缓存并返回清理后的占用 */
    clear(): Promise<LocalCacheStats>
  }
  app: {
    info(): Promise<AppInfo>
    /**
     * 查 GitHub 上有没有新的客户端版本（只查不装）。
     *
     * 两项代理都来自**服务端设置**，老后端没有对应端点时传空串即可。主进程代查是因为渲染层
     * 直连第三方会撞上 CORS 与 `User-Agent` 这两个改不动的限制（见 src/main/release.ts）。
     * 服务端配的代理在本机不一定连得上 —— 主进程会先判定（HTTP 代理探 TCP），用不了就直连，
     * 并把实际走的通路回报在 `route` 里。
     */
    checkClientUpdate(proxies: ClientUpdateProxies): Promise<ClientUpdateCheck>
  }
  /**
   * 「GitHub 发现」：插件商店里那一份社区来源。
   *
   * 主进程代查（同 app.checkClientUpdate 的理由），并逐仓库核对 `plugin.json` 与它声明的
   * release 资产 —— 结果里的每一条都是**点安装就能装上**的。失败不抛异常，而是回
   * `{ ok: false, reason }`：跨 IPC 只剩一句 message，`reason` 才是界面分派文案的依据。
   */
  github: {
    discover(request: GithubDiscoveryRequest): Promise<GithubDiscoveryResult>
  }
  cover: {
    /** 取封面缩略图字节（base64），供 canvas 取主色 —— 绕开跨域画布污染 */
    bytes(url: string): Promise<CoverBytes | null>
  }
  /** 订阅主进程推送，返回取消订阅函数 */
  on: {
    mediaCommand(handler: (command: MediaCommand) => void): () => void
    windowState(handler: (state: WindowState) => void): () => void
    navigate(handler: (path: string) => void): () => void
    /** 设置被**别的窗口**改了（两个窗口各有一份 settings，见 shared/ipc.ts 那条说明） */
    settingsChanged(handler: (settings: AppSettings) => void): () => void
  }
}
