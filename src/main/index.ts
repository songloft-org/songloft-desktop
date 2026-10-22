/**
 * 主进程入口。
 *
 * 职责边界（结构性的，不靠代码自觉）：
 *   * 只有主进程能碰文件系统与系统调用；
 *   * 渲染层没有任何 Node 能力，它要的一切都经 preload 白名单（见 src/preload）；
 *   * 承载界面的窗口 contextIsolation + sandbox 全开。
 */

import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { BrowserWindow, app, ipcMain, session, shell } from 'electron'

import type { StoredCredentials } from '@shared/bridge-types'
import type { GithubDiscoveryRequest } from '@shared/github-discovery'
import {
  IPC,
  type AppInfo,
  type AppSettings,
  type MediaCommand,
  type MiniCommand,
  type MiniPlayerSnapshot,
  type MiniWindowLayout,
  type ServerEntry,
  type TraySnapshot
} from '@shared/ipc'
import { installAppMenu } from './app-menu'
import { applyLocalCacheLimit, clearLocalCache, readLocalCache } from './cache'
import { discoverGithubPlugins } from './github-discovery'
import { checkClientUpdate } from './release'
import { dlnaController } from './dlna'
import { openTextFile, saveTextFile } from './files'
import {
  announceLocalFiles,
  openLocalFilesDialog,
  pathsFromArgv,
  setLocalFilesNotifier,
  takePendingPaths
} from './local-files'
import { registerLocalFileScheme, installLocalFileProtocol } from './media-protocol'
import { registerMediaKeys } from './media-keys'
import {
  applyMiniWindowOnTop,
  closeMiniWindow,
  disposeMiniWindow,
  handleMiniReady,
  handleMiniResize,
  installMiniWindow,
  isMiniWindowOpen,
  openMiniWindow,
  sendMiniSnapshot,
  sendToMiniWindow,
  setMiniWindowOpen,
  showMiniWindow
} from './mini-window'
import { fetchCoverBytes, probeServer } from './probe'
import type { CastAction, CastRequest } from '@shared/dlna'
import { LOCAL_FILE_SCHEME } from '@shared/local-file'
import { PLUGIN_PARTITION } from '@shared/plugin'
import { PORTABLE_MARKER_FILE, chooseUserDataDir, portableDataDir } from '@shared/user-data'
import { ConfigStore } from './store'
import { createTray, destroyTray, render as renderTray, type TrayDeps } from './tray'
import { applyWindowOnTop, createMainWindow } from './windows'

/**
 * ★ Linux 桌面集成身份（Wayland 的 app_id / X11 的 WM_CLASS）。
 *
 *   权威口径：app.setDesktopName(name) 的 name 是 **.desktop 的文件名**；而 name **去掉结尾
 *   那层 .desktop** 才是应用身份 —— GNOME / Dock 就是拿这个身份去找同名条目，并把窗口与
 *   已固定的启动器图标合并。
 *
 *   身份取反域名形态 io.github.edwinhuish.songloft-desktop，**刻意不以 `.desktop` 结尾**。
 *   若身份本身以 `.desktop` 结尾（例如 com.songloft.desktop），"去掉一层后缀"就会把它削成
 *   另一个名字，必须靠多写一层后缀来抵消，极易看错且错法完全静默 —— 详见 electron-builder.yml。
 *
 *   于是三处取值是（身份不以 `.desktop` 结尾，所以不必"多写一层后缀"）：
 *     package.json → desktopName             = 身份
 *     本行入参（setDesktopName）              = 身份
 *     electron-builder.yml → StartupWMClass   = 身份
 *     产物 .desktop 文件名                     = 身份 + ".desktop"
 *
 *   对不上的症状是静默的：图标回落成占位齿轮；GNOME 50 起 xdg-desktop-portal 还会拒绝用该
 *   身份申请的 globalShortcut 授权，而错误不会冒到应用层。
 *   scripts/verify-package.sh 会断言这一组关系。
 */
app.setDesktopName('io.github.edwinhuish.songloft-desktop')

/*
 * 本地文件的播放地址走的自定义协议（见 media-protocol.ts）。★ 这一句必须越过 app ready
 * —— Chromium 只在启动那一刻读特权协议的声明，晚一步注册就会把它当成一个普通（不安全、
 * 且不能流式）的来源，媒体加载直接失败且几乎不给原因。
 */
registerLocalFileScheme()

/**
 * 免安装（绿色）版该用的数据目录 —— 拿不到就返回 null。
 *
 * 判据两件事都要满足：exe 旁边有标记文件（见 shared/user-data.ts 的 PORTABLE_MARKER_FILE），
 * 且那个目录**真建得出来**。只读介质上（U 盘写了保护、解压到 Program Files）落不了数据，
 * 这时宁可退回系统默认位置，也不能让应用因为一个目录建不出来就起不来。
 * ★ 判「能不能写」用的是真去建一次目录，不是 fs.accessSync(W_OK) —— 后者在 Windows 上
 *   只看文件属性里的只读位，目录权限不足时它照样说能写。
 */
function portableUserDataDir(): string | null {
  const exeDir = dirname(app.getPath('exe'))
  const dir = portableDataDir(exeDir, existsSync(join(exeDir, PORTABLE_MARKER_FILE)))
  if (!dir) return null

  try {
    mkdirSync(dir, { recursive: true })
    return dir
  } catch (error) {
    console.warn(`[songloft] 免安装版的数据目录建不出来（${dir}），改用系统默认位置`, error)
    return null
  }
}

/**
 * 配置目录落在哪儿，三档里挑一个（优先级见 shared/user-data.ts 的 chooseUserDataDir）：
 *   1. `SONGLOFT_USER_DATA` 显式指定 —— 自动化冒烟测试给一份预置凭据的配置，不去碰用户真实的
 *      ~/.config/songloft-desktop；用户想同时挂两套服务器配置时也可以自己指定；
 *   2. 免安装（绿色）版：数据放在 exe 旁边，整个文件夹拷走就带走全部配置；
 *   3. 系统默认位置（`%APPDATA%\Songloft Desktop` / `~/.config/…` / `~/Library/Application Support/…`）。
 * 必须在任何 app.getPath('userData') 被读取之前定下来，所以放在 ConfigStore 实例化之前。
 */
const systemUserDataDir = app.getPath('userData')
const userDataDir = chooseUserDataDir({
  override: process.env.SONGLOFT_USER_DATA ?? '',
  portableDir: portableUserDataDir(),
  fallback: systemUserDataDir
})
if (userDataDir !== systemUserDataDir) app.setPath('userData', userDataDir)

/**
 * Linux 下改用 X11 后端（XWayland）—— **只在显式要求时**（`SONGLOFT_OZONE=x11`），默认不动。
 *
 * 这个口子是为了「置顶」：Wayland 的 xdg-shell 里没有这个请求，GNOME 也没实现替代扩展，
 * window.setAlwaysOnTop() 在那条路上会被合成器**无声忽略**（见 windows.ts 的
 * setWindowOnTop）；走 XWayland 之后它落到 _NET_WM_STATE_ABOVE 上，窗口图标
 * （_NET_WM_ICON）与 globalShortcut 的 X11 抓取也一并回到正常路径。
 *
 * ★ 但**不能默认切**：本机实测（GNOME 45 / Wayland + XWayland）一进 dev 就
 *   `GPU process exited unexpectedly: exit_code=139`（SIGSEGV）连发三发、窗口整个画不出来，
 *   紧跟一句 `XGetWindowAttributes failed for window 1`。默认切过去等于把「能用的应用」换成
 *   「要置顶但打不开的应用」—— 所以默认一切照平台走（本机 = 原生 Wayland），
 *   只有明确要置顶的人才吃这份代价。默认态下置顶在 GNOME 上就是不成立，这是平台的账。
 * ★ 连着 `--disable-gpu` 一起给：崩的是 XWayland 那条 GPU 路径，而这条路的唯一目的是置顶，
 *   用软件合成换它稳定（e2e 那条路也是这么跑的，见 scripts/e2e/run.sh）。
 *
 * ★ 必须赶在 app ready 之前设：Chromium 只在启动时读一次平台，运行中改不了 —— 所以它和
 *   SONGLOFT_USER_DATA 一样放在文件顶部这一段。
 */
if (process.platform === 'linux' && process.env.SONGLOFT_OZONE === 'x11') {
  app.commandLine.appendSwitch('ozone-platform', 'x11')
  app.commandLine.appendSwitch('disable-gpu')
}

/**
 * 当前这份会话是**原生 Wayland** 吗。
 *
 * ★ 只有一处用它（collapseWindow），但那一处不这么判就会错：Wayland 下把窗口 hide() 掉再
 *   show()，合成器会把它当成**新窗口**重新摆放（GNOME 直接放到屏幕中间），而 Wayland
 *   **禁止客户端自己定位** —— `win.setPosition()` 是空操作（Electron 官方口径），实测那一路上
 *   `getPosition()` 从头到尾只是最后一次 SetBounds 的缓存值，跟真位置无关。所以「原位回来」
 *   在那条路上做不到「show 之前先摆回去」，只能**不拆掉这次映射**（用 minimize）。
 * ★ 判据以**命令行上的 ozone 开关优先**：`--ozone-platform=x11` 意味着「这次跑的是 XWayland」，
 *   窗口语义按 X11 算（hide→show 原位回来）。本应用自己的 SONGLOFT_OZONE=x11 走的正是上面那两行
 *   appendSwitch，所以也落在这一条上；e2e 是直接在命令行上给的这个开关。
 * ★ 其余靠会话变量：XDG_SESSION_TYPE 是桌面给的，WAYLAND_DISPLAY 兜底。
 */
function usesNativeWayland(): boolean {
  if (process.platform !== 'linux') return false
  const forced = app.commandLine.getSwitchValue('ozone-platform')
  if (forced) return forced === 'wayland'
  return process.env.XDG_SESSION_TYPE === 'wayland' || Boolean(process.env.WAYLAND_DISPLAY)
}

/**
 * 这一次启动是不是「双击音频文件」叫起来的（Windows / Linux 的文件关联把路径追加在 argv 里）。
 *
 * ★ 它必须在**抢锁之前**算出来：本地文件会话刻意不抢单实例锁 —— 要的就是「双击一个文件就
 *   另起一个只有迷你播放器的实例」，而不是把文件塞给已经在跑的那个主界面（见下面 localSession）。
 */
const launchFiles = pathsFromArgv(process.argv.slice(1))

/** macOS：`open-file` 在 `ready` **之前**到达（双击关联文件启动那一趟就是这样，见下面 localSession） */
let openedByFileBeforeReady = false
/** `whenReady` 跑过了没有（用来认「这个 open-file 是启动那一下，还是应用开着时又双击的」） */
let startupDone = false

// 普通启动只允许一个实例：第二次启动就把已有窗口顶到前面，而不是再开一个播放器。
const gotTheLock = launchFiles.length > 0 || app.requestSingleInstanceLock()
if (!gotTheLock) {
  app.quit()
}

/**
 * 本地文件的三个来源里，有两个**可能早于窗口**（见 local-files.ts）：先把它们收下排进队，
 * 渲染层就绪后会自己来取（它开机就来取一次）。
 *
 * 没拿到锁的那个进程马上就会退出，它 argv 里的文件由 `second-instance` 那条路交给真正在跑的
 * 这个实例 —— 那条路只有**普通启动**才有（本地文件会话不抢锁，也就没有「转交」这回事）。
 */
if (gotTheLock) {
  // macOS：双击关联文件启动、或应用已开着时再双击一个
  app.on('open-file', (event, path) => {
    event.preventDefault()
    if (!startupDone) openedByFileBeforeReady = true
    announceLocalFiles([path])
  })
  announceLocalFiles(launchFiles)
}

const store = new ConfigStore()

// 本机缓存上限得赶在 ready 之前交给 Chromium（它只在解析启动参数时读一次，运行中改不了），
// 所以放在这里、而不是等界面来要。设置页会照这个事实提示「重启后生效」。
applyLocalCacheLimit(store.getSettings().localCacheMaxSize)

let mainWindow: BrowserWindow | null = null
let isQuitting = false
let disposeMediaKeys: (() => void) | null = null

/**
 * 这一趟会话是**本地文件会话**吗（双击音频文件起的那一趟）。
 *
 * ★ 判据在 `whenReady` 里才落定（那时才知道 macOS 那份 `open-file` 来没来），此后全程不变。
 *   它同时决定四件事，缺一样都会露馅：
 *     · **不创建主窗口**，只开一个宿主身份的迷你窗（见 mini-window.ts 的 role）；
 *     · 托盘里**没有**「显示 / 隐藏主窗口」那一项 —— 没有那个窗口，迷你条就是全部界面；
 *     · 关掉迷你条就退出应用（那一趟里它是唯一的界面，留着只剩一个看不见的进程）；
 *     · 主进程要往渲染层送的东西（本地文件的摇铃、托盘与媒体键的命令）一律送给**迷你窗**。
 *   「主播放器保持关闭状态且不可打开」这条需求，落到实现上就是上面这四句。
 */
let localSession = false

/** 自签证书开关：只作用于本应用的默认会话，不动系统设置。 */
function applyTlsPolicy(allowInsecure: boolean): void {
  const ses = session.defaultSession
  ses.setCertificateVerifyProc((_request, callback) => {
    // 0 = 接受；-3 = 交回 Chromium 默认校验
    callback(allowInsecure ? 0 : -3)
  })
}

/**
 * ★ CSP 只在打包态注入。开发态要连 electron-vite 的 HMR websocket 与内联的
 *   react-refresh preamble，套上 CSP 会直接把热更新打断 —— 开发体验与安全性在
 *   这里是有取舍的，选择「打包态严格」。
 *
 * 打包后渲染层需要的东西其实只有三样：自己的 bundle（file://）、后端地址
 * （http/https，地址由用户在设置里填）、以及封面取色的 blob:/data:。
 */
function applyCsp(): void {
  if (!app.isPackaged) return
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          [
            "default-src 'self'",
            "script-src 'self'",
            // 样式里大量用了行内 style（尺寸/进度条 width），必须放开 inline style
            "style-src 'self' 'unsafe-inline'",
            "img-src 'self' data: blob: http: https:",
            // ★ 带上媒体协议：本地文件的播放地址走的是它（见 main/media-protocol.ts）。
            //   漏掉这一项时打包态下本地文件一首也放不出来，且 CSP 的拦截**只写在控制台**里。
            `media-src 'self' blob: http: https: ${LOCAL_FILE_SCHEME}:`,
            "connect-src 'self' http: https: ws: wss:",
            "font-src 'self' data:",
            "object-src 'none'",
            "frame-src 'none'",
            "base-uri 'self'",
            "form-action 'none'"
          ].join('; ')
        ]
      }
    })
  })
}

/**
 * `url` 是否已经不在 `base` 这个源上了。
 *
 * 解析不出来的一律按「离开了」处理：宁可把它交给系统浏览器，也不要在应用窗口里
 * 导航到一个来路不明的地址（同一条取舍见 windows.ts 主窗口的 will-navigate）。
 */
function isForeignOrigin(url: string, base: string): boolean {
  try {
    return new URL(url).origin !== new URL(base).origin
  } catch {
    return true
  }
}

/**
 * ★ 扩展页（webview guest）的 session 隔离与围栏。
 *
 * 两条与主窗口不同的地方：
 *   1. **独立 session**（见 shared/plugin.ts 的 PLUGIN_PARTITION）。上面那个 applyCsp()
 *      是 `session.defaultSession.webRequest.onHeadersReceived`，它改写的是整个会话的
 *      响应头 —— 插件页那份 HTML 也在同一个来源上，不隔离就会被套上宿主的 CSP，
 *      表现为插件莫名其妙地坏掉、且没有任何报错。代价是权限、证书校验这些要给
 *      这份 session 单独配一遍。
 *   2. guest 是**第三方代码**：开新窗口一律拒绝并改用系统浏览器，非 http(s) 的导航
 *      直接拦掉。与主窗口同一条围栏，只是对象不同。
 */
function hardenPluginSession(): void {
  const pluginSession = session.fromPartition(PLUGIN_PARTITION)

  // 麦克风/摄像头/通知/地理位置：候选页要的一个都不给，与主窗口一致
  pluginSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))

  // 「忽略自签证书」这项要跟着走，否则会出现「接口连得上、插件页打不开」的怪状态。
  // 读的是当前设置而不是启动时那份：这一项在设置页随时可改。
  pluginSession.setCertificateVerifyProc((_request, callback) => {
    callback(store.getSettings().allowInsecureTls ? 0 : -3)
  })

  app.on('web-contents-created', (_event, contents) => {
    if (contents.getType() !== 'webview') return

    contents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) void shell.openExternal(url)
      return { action: 'deny' }
    })
    /**
     * 插件页里的链接走哪条路，看它是不是「离开了插件页」：
     *
     *   * **同源** → 让它自己跳。插件内部换页是正常的（`pushState` / hash 这类更是连
     *     这个事件都不产生，只有顶层导航才会走到这里）；
     *   * **跨源** → 判为离开，改交给系统浏览器，guest 留在原地。不做这一条的话，点一个
     *     普通的 `<a href="https://…">`（作者没写 `target`）会把这**一整格**换成那个外部
     *     站点 —— 而扩展框架里没有「后退」，用户只能切走再切回来。
     *
     * ★ 判据取 guest **当前**的 URL，不是当初那个 src：插件自己也可能换过页（同源），
     *   拿起始地址比会把它自己的后续导航误判成外链。
     * ★ 最初那一次加载不经过这里（`<webview src>` 等同 loadURL，本就不派发 will-navigate），
     *   所以后端连不上、重定向这些加载期的事不受影响。
     */
    contents.on('will-navigate', (event, url) => {
      // 非 http(s)（file:// 、自定义协议）一律挡掉：同一条围栏，主窗口那边也是这么写的
      if (!/^https?:/i.test(url)) {
        event.preventDefault()
        return
      }
      if (!isForeignOrigin(url, contents.getURL())) return
      event.preventDefault()
      void shell.openExternal(url)
    })
  })
}

function sendToRenderer(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload)
  }
}

/**
 * 送给**正在播放的那个窗口**（见 renderer 的 state/usePlayer 分流）。
 *
 * 两个窗口都可能是宿主：普通会话里是主窗口，本地文件会话里是迷你窗。凡是有明确「主人」的
 * 推送都走这一句 —— 各自写 sendToRenderer 的话，本地会话里那些东西（第二个双击的文件、
 * 托盘上按下的播放键）会静默地掉进一个不存在的窗口里，症状是「点了没反应，也没有报错」。
 */
function sendToHost(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload)
    return
  }
  sendToMiniWindow(channel, payload)
}

/**
 * 这条 IPC 是哪个窗口发来的。
 *
 * ★ 几颗窗口钮（最小化 / 最大化 / 关闭）一律作用于**它自己**：迷你窗那颗关闭只该关掉迷你条，
 *   不该把主界面一起收掉（迷你条上那颗最小化已撤掉，但语义照旧）。原先一律打到 mainWindow 上，
 *   是因为当时只有一个窗。
 */
function senderWindow(event: Electron.IpcMainInvokeEvent): BrowserWindow | null {
  return BrowserWindow.fromWebContents(event.sender)
}

/**
 * 设置被改了：把新的一份推给**其余**窗口。
 *
 * 两个窗口各有一份 useSettings（迷你窗是另一个渲染进程），而主题 / 强调色 / 两份整窗浓度
 * 都是「一改就该两处同时变」的东西 —— 只靠调用方自己刷新的话，主窗口改主题、迷你条还停在
 * 旧主题上。不改调用的那个窗口是因为它拿到的返回值就是新的一份，再推一遍只是白跑。
 */
function broadcastSettings(settings: AppSettings, from: Electron.WebContents): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents === from) continue
    win.webContents.send(IPC.onSettingsChanged, settings)
  }
}

/**
 * 托盘菜单与全局媒体键的命令：送给**当宿主的那一个窗口**执行。
 *
 * ★ 不能写死主窗口：本地文件会话里播放器在迷你窗手里（见 renderer 的 local-session），
 *   送给不存在的窗口 = 托盘按了没反应。
 */
function broadcastMediaCommand(command: MediaCommand): void {
  sendToHost(IPC.onMediaCommand, command)
}

/**
 * 把主窗口「收起来」—— 托盘那颗图标、托盘菜单里那一项、closeToTray 拦下的关闭，都走这一句。
 *
 * ★ Wayland 下用 minimize() 而不是 hide()：hide 会**拆掉窗口的映射**，再显示时合成器把它当新
 *   窗口摆（GNOME 直接居中）——「双击托盘回来」于是变成「窗口跳到屏幕中间」。minimize 只把窗口
 *   挂起来，映射不动，几何留在合成器手里，唤回时自然落在原处。
 *   （为什么不能「show 之前再 setPosition 摆回去」：见 usesNativeWayland 那段。）
 * ★ 代价写在明处：Wayland 下它会出现在任务栏 / Alt-Tab 里 —— skipTaskbar 在 Wayland 没有对应
 *   协议（Electron 20 的说明）。两害相权，把「原样回来」放在前面。
 * ★ 其余平台照旧 hide()：Windows / macOS / X11 上 hide→show 本来就会原位回来。
 *   另外实测（本机 GNOME/Wayland）：minimize() 之后 isVisible()=false、isMinimized()=true，
 *   restore() 与 show() 都能叫回来 —— 所以上面那份「看得见吗」的判据一个字都不用改。
 */
function collapseWindow(window: BrowserWindow): void {
  if (usesNativeWayland()) window.minimize()
  else window.hide()
}

/**
 * 托盘那颗图标 / 托盘菜单里那一项：把主窗口收起来或叫回来。
 *
 * ★ 只作用于**主窗口**：本地文件会话里压根没有它（`mainWindow` 一直是 null），这一句于是
 *   什么都不做 —— 「主播放器不可打开」是这么落地的（那一趟的托盘里也没有这一项，
 *   见下面 trayDeps 的 windowItem）。
 */
function toggleWindowVisibility(): void {
  if (!mainWindow) return
  if (mainWindow.isVisible() && !mainWindow.isMinimized()) {
    collapseWindow(mainWindow)
  } else {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  }
}

/**
 * 装配一个主窗口的监听。
 *
 * ★ 必须可重复调用：macOS 在「窗口都关掉但应用还活着」时会走 `activate` 重建窗口。
 *   原先只在启动路径上挂这两个监听，重建出来的窗口于是既不会在关闭时把 mainWindow
 *   置空（留下野引用），也不受 `closeToTray` 约束 —— 一次重建就静默丢掉两个行为。
 */
function attachWindowHandlers(window: BrowserWindow): void {
  window.on('closed', () => {
    // 只清理「当前这一个」：旧窗口延迟到达的 closed 不该抹掉新窗口的引用
    if (mainWindow !== window) return
    mainWindow = null
    /*
     * 主界面没了，迷你条也就失去了宿主：播放由它驱动、遥控命令要它执行、连它上那份状态
     * 也是它推的。留着一个既放不出声、点也点不动的条没有意义，一并关掉。
     */
    if (isMiniWindowOpen()) closeMiniWindow()
  })

  // 关闭即最小化到托盘（默认关）：拦下 close，改成收起（hide / Wayland 下 minimize，见 collapseWindow）
  window.on('close', (event) => {
    if (isQuitting) return
    if (!store.getSettings().closeToTray) return
    event.preventDefault()
    collapseWindow(window)
  })

  // ── 进程级异常：不能让用户对着一个白窗口，也不能陷入重载死循环 ──────────
  // 渲染进程崩掉（OOM / GPU 驱动）后 Chromium 不会自行恢复，重新加载是最直白的兜底；
  // 但连续崩溃必须有闸门 —— 反复 reload 比白窗口更糟，这里退化成「只记日志」。
  let lastCrashReloadAt = 0
  const CRASH_RELOAD_COOLDOWN_MS = 30_000

  window.webContents.on('render-process-gone', (_event, details) => {
    console.error(`[main] 渲染进程退出：${details.reason}（exitCode=${details.exitCode}）`)
    if (details.reason === 'clean-exit') return
    if (Date.now() - lastCrashReloadAt < CRASH_RELOAD_COOLDOWN_MS) {
      console.error('[main] 短时间内重复退出，放弃自动重载，请看上方日志')
      return
    }
    lastCrashReloadAt = Date.now()
    console.warn('[main] 正在重新加载界面')
    window.webContents.reload()
  })

  // 卡死**不**自动重载：那会把用户正在做的事直接丢掉，只留日志等它自己缓过来
  window.on('unresponsive', () => {
    console.warn('[main] 界面无响应，等待其自行恢复')
  })
  window.on('responsive', () => {
    console.warn('[main] 界面已恢复响应')
  })

  // file:// 加载失败（产物损坏、路径不对）时只剩白屏，至少要留下可查的日志。
  // -3 是 ABORTED（正常的导航取消），不算错误。
  window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    if (errorCode === -3) return
    console.error(`[main] 页面加载失败：${errorDescription}（${errorCode}）${validatedURL}`)
  })
}

// ────────────────────────────────── IPC ──────────────────────────────────

/**
 * patch 里**显式**给了这一项吗。
 *
 * 用 hasOwnProperty 而不是判值：`{ volume: 0 }` 与「没提 volume」是两回事，
 * 有些 patch 项带着副作用（改置顶要落窗口、改 TLS 要重装策略），只有显式给了才该触发。
 */
function has(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key)
}

function registerIpcHandlers(): void {
  // 设置
  ipcMain.handle(IPC.settingsGet, () => store.getSettings())
  ipcMain.handle(IPC.settingsPatch, (event, patch: Partial<AppSettings>) => {
    const next = store.patchSettings(patch)
    if (has(patch, 'allowInsecureTls')) {
      applyTlsPolicy(next.allowInsecureTls)
    }
    /*
     * 置顶是**窗口状态**而不是界面状态：写入配置只是记住了偏好，还得当场落到真窗口上。
     * 两个窗口各有一份（主窗 / 迷你窗），所以两项都要看一眼 —— 只落其中一份的话，
     * 用户勾了「迷你窗置顶」要等下次开迷你窗才生效。
     */
    if (has(patch, 'alwaysOnTop')) applyWindowOnTop()
    if (has(patch, 'miniAlwaysOnTop')) applyMiniWindowOnTop()
    broadcastSettings(next, event.sender)
    return next
  })
  ipcMain.handle(IPC.settingsReset, (event) => {
    const next = store.resetSettings()
    applyTlsPolicy(next.allowInsecureTls)
    // 复位会把两份置顶设置一起打回默认（大窗口关、迷你开），两个窗口都得跟着回去
    applyWindowOnTop()
    applyMiniWindowOnTop()
    broadcastSettings(next, event.sender)
    return next
  })

  // 凭据
  ipcMain.handle(IPC.credentialsGet, (_event, url: string) => store.getCredentials(url))
  ipcMain.handle(
    IPC.credentialsSet,
    (_event, url: string, creds: Omit<StoredCredentials, 'savedAt'>) => {
      store.setCredentials(url, creds)
    }
  )
  ipcMain.handle(IPC.credentialsClear, (_event, url: string) => {
    store.clearCredentials(url)
  })

  // 服务器
  ipcMain.handle(IPC.serversList, () => store.listServers())
  ipcMain.handle(IPC.serversUpsert, (_event, entry: ServerEntry) => store.upsertServer(entry))
  ipcMain.handle(IPC.serversRemove, (_event, url: string) => store.removeServer(url))
  ipcMain.handle(IPC.serversProbe, (_event, url: string) => probeServer(url))
  ipcMain.handle(IPC.serversAccounts, () => store.listAccounts())

  // 窗口（一律作用于**发来这条 IPC 的那个窗口**，见 senderWindow 的说明）
  ipcMain.handle(IPC.windowMinimize, (event) => senderWindow(event)?.minimize())
  ipcMain.handle(IPC.windowToggleMaximize, (event) => {
    const win = senderWindow(event)
    if (!win) return false
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
    return win.isMaximized()
  })
  ipcMain.handle(IPC.windowClose, (event) => senderWindow(event)?.close())
  ipcMain.handle(IPC.windowGetState, (event) => {
    const win = senderWindow(event)
    return {
      maximized: win?.isMaximized() ?? false,
      fullscreen: win?.isFullScreen() ?? false,
      focused: win?.isFocused() ?? false
    }
  })

  // ── 迷你窗口（几何与转发都在 mini-window.ts 里，见那里的说明）───────────────
  ipcMain.handle(IPC.miniSetOpen, (event, open: boolean) => {
    // 只认主窗口这一个来源：本应用只有主界面能开迷你窗，迷你窗自己不该再开一个
    if (senderWindow(event) !== mainWindow) return
    setMiniWindowOpen(open)
  })
  /*
   * 「迷你窗此刻开着没有」：窗口是主进程开的，这个事实只有它知道（见 IPC.miniIsOpen 的说明）。
   * 不限定来源 —— 主窗口与迷你窗问到的都是同一个答案，为一个查询分来源没有意义。
   */
  ipcMain.handle(IPC.miniIsOpen, () => isMiniWindowOpen())
  ipcMain.handle(IPC.miniResize, (_event, layout: MiniWindowLayout) => handleMiniResize(layout))
  ipcMain.handle(IPC.miniReady, () => handleMiniReady())
  ipcMain.handle(IPC.miniPush, (_event, snapshot: MiniPlayerSnapshot) => sendMiniSnapshot(snapshot))
  ipcMain.handle(IPC.miniCommand, (_event, command: MiniCommand) => {
    sendToRenderer(IPC.onMiniCommand, command)
  })

  /*
   * 投送到局域网音箱（DLNA）。整组都在主进程：SSDP 要 UDP 组播，渲染层开不了 socket。
   * 状态由 dlnaController 推回渲染层（下面 onUpdate 那一句），渲染层不再自己轮询。
   */
  ipcMain.handle(IPC.castDevices, (_event, refresh: boolean) => dlnaController.discover(refresh))
  ipcMain.handle(IPC.castStart, (_event, request: CastRequest) => dlnaController.cast(request))
  ipcMain.handle(IPC.castControl, (_event, action: CastAction, value: number) =>
    dlnaController.control(action, value)
  )
  ipcMain.handle(IPC.castStatus, () => dlnaController.status())
  ipcMain.handle(IPC.castStop, () => dlnaController.stop())
  dlnaController.onUpdate((status) => sendToRenderer(IPC.onCastState, status))

  // 托盘 / 系统
  ipcMain.handle(IPC.trayUpdate, (_event, snapshot: TraySnapshot) => {
    renderTray(trayDeps, snapshot)
  })
  ipcMain.handle(IPC.openExternal, (_event, url: string) => {
    // 只放行 http(s)，别让渲染层用 file:// 或自定义协议拉起本机程序
    if (/^https?:\/\//i.test(url)) return shell.openExternal(url)
    return Promise.resolve()
  })
  ipcMain.handle(IPC.fileSave, (_event, suggestedName: string, contents: string) =>
    saveTextFile(mainWindow, suggestedName, contents)
  )
  ipcMain.handle(IPC.fileOpen, () => openTextFile(mainWindow))
  // 本地文件：挑一批（对话框）+ 取走排着队的那批（推给我们的是「有新的」这条摇铃）
  ipcMain.handle(IPC.localFilesOpen, (event) =>
    openLocalFilesDialog(senderWindow(event) ?? mainWindow)
  )
  ipcMain.handle(IPC.localFilesTakePending, () => takePendingPaths())
  ipcMain.handle(IPC.localCacheStats, () => readLocalCache())
  ipcMain.handle(IPC.localCacheClear, () => clearLocalCache())
  ipcMain.handle(IPC.colorExtract, (_event, url: string) => fetchCoverBytes(url))
  ipcMain.handle(IPC.appInfo, (): AppInfo => ({
    name: app.getName(),
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: `${process.platform} ${process.arch}`,
    appImage: Boolean(process.env.APPIMAGE),
    packaged: app.isPackaged
  }))
  ipcMain.handle(IPC.clientUpdateCheck, (_event, proxyPrefix?: string) =>
    checkClientUpdate(proxyPrefix)
  )
  ipcMain.handle(IPC.githubDiscovery, (_event, request: GithubDiscoveryRequest) =>
    discoverGithubPlugins(request)
  )
}

// ───────────────────────────── 托盘依赖（提前声明）─────────────────────────────
const trayDeps: TrayDeps = {
  onCommand: (command: MediaCommand) => broadcastMediaCommand(command),
  /*
   * 点托盘图标：本地文件会话里把迷你条唤回来（那是那一趟唯一的窗口），其余照旧切主窗口。
   * ★ 迷你条关掉就退出应用（见下面 whenReady 里 onOpenChanged 那一段），所以这条路上不会
   *   留下「窗口关掉了、托盘还在，却没有任何界面」的僵尸。
   */
  onActivate: () => (localSession ? showMiniWindow() : toggleWindowVisibility()),
  windowItem: () =>
    localSession
      ? null
      : {
          label: mainWindow?.isVisible() ? '隐藏主窗口' : '显示主窗口',
          click: () => toggleWindowVisibility()
        },
  onQuit: () => {
    isQuitting = true
    app.quit()
  }
}

// ─────────────────────────────── 生命周期 ───────────────────────────────
if (gotTheLock) {
  /*
   * ★ 本地文件会话没有这一条：它**刻意不抢单实例锁**（双击一个音频文件就该另起一个只有
   *   迷你播放器的实例，而不是把文件塞给在跑的那个主界面），没抢锁的进程收不到
   *   `second-instance`，也就没有「转交」这回事。
   */
  if (launchFiles.length === 0) {
    app.on('second-instance', (_event, argv, workingDirectory) => {
      /*
       * 第二次启动被拦下了，但它命令行里的东西不能丢：`songloft-desktop song.mp3` 在应用
       * 已开着时正是「再加一首放进去」。相对路径按**那个进程**的目录解（见 pathsFromArgv）。
       */
      announceLocalFiles(pathsFromArgv(argv, workingDirectory))

      if (!mainWindow) return
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    })
  }

  app.whenReady().then(() => {
    /*
     * ★ 先落定「这一趟是不是本地文件会话」，再建任何窗口 —— 它决定建**哪一个**窗口。
     *   两个来源：启动参数里有音频文件（Windows / Linux 的文件关联把路径追加在 argv 里），
     *   或 macOS 那份 `open-file` 赶在 ready 之前就到了（双击关联文件启动那一趟正是如此）。
     * ★ startupDone 同时在这里置位：此后到达的 open-file 都算「应用开着时又双击了一个文件」，
     *   那一条走的是普通会话（拖进已开着的界面），不该把这一趟变成本地会话。
     */
    localSession = launchFiles.length > 0 || openedByFileBeforeReady
    startupDone = true

    applyTlsPolicy(store.getSettings().allowInsecureTls)
    applyCsp()
    // 本地文件的播放地址由它来读（必须在页面开始请求之前装好）
    installLocalFileProtocol()
    // 「又有本地文件要打开」送到**当宿主的那一个窗口**：渲染层收到后回来 takePendingPaths()
    setLocalFilesNotifier(() => sendToHost(IPC.onLocalFilesPending, null))
    // 必须早于任何 webview 挂载：它注册的 web-contents-created 只在创建时生效一次
    hardenPluginSession()
    registerIpcHandlers()
    installAppMenu(() => mainWindow)

    /*
     * 迷你窗的接线：跟随时它要的三样东西分别是「通知主窗口开/关」「问主窗口要一份状态」
     * 「把遥控命令交给主窗口执行」—— 全是转发，主进程自己一个播放状态都不持有。
     * ★ 必须**早于**下面开窗那两句：本地会话里 openMiniWindow 当场就会问它要第一份状态
     *   （见 onRequestSnapshot），接线晚一步那一窗只能等 1.5 秒的兜底才露面。
     */
    installMiniWindow(store, {
      onOpenChanged: (open) => {
        sendToRenderer(IPC.onMiniOpen, open)
        /*
         * ★ 本地文件会话里「关掉迷你条」= 退出应用：那一趟只有这一个界面，留着它只剩一个
         *   看不见的进程（音频照放、托盘之外没有任何入口）。普通会话不这么做 —— 迷你条只是
         *   主界面旁边的一条挂件，关掉它不该把整个应用带走（那是 closeToTray 的事）。
         */
        if (!open && localSession) app.quit()
      },
      onRequestSnapshot: () => {
        /*
         * 迷你窗在要第一份状态：普通会话转问主窗口 —— 主窗口推回来，窗口随之露面。
         * ★ 本地会话里**没有人在推**（那一窗自己就是播放器），所以直接让它露面，
         *   别让它干等 handleMiniReady 那 1.5 秒的兜底。
         */
        if (mainWindow) sendToRenderer(IPC.onMiniRequest, null)
        else showMiniWindow()
      },
      onCommand: (command) => sendToRenderer(IPC.onMiniCommand, command)
    })

    /*
     * 两个窗口只会有**一个**：
     *   · 普通启动 → 主窗口（完整界面），迷你窗按需由它开出来（跟随者身份）；
     *   · 本地文件会话 → **只有**迷你窗，而且是宿主身份 —— 它自己就是播放器（音频、队列、
     *     歌词都在它手里），主窗口压根不创建。这就是「仅启动迷你播放器，主播放器保持关闭
     *     状态且不可打开」：没有那个窗口，也就没有「打开」这回事（托盘里那一项也随之撤掉，
     *     见上面 trayDeps 的 windowItem）。
     */
    if (localSession) {
      openMiniWindow('mini-host')
    } else {
      mainWindow = createMainWindow(store)
      attachWindowHandlers(mainWindow)
    }

    createTray(trayDeps)
    disposeMediaKeys = registerMediaKeys(broadcastMediaCommand)

    app.on('activate', () => {
      // 本地会话：唯一那个窗口就是迷你条，唤回它（它关掉就等于退出，见上面那一段）
      if (localSession) {
        openMiniWindow('mini-host')
        return
      }
      if (BrowserWindow.getAllWindows().length === 0) {
        mainWindow = createMainWindow(store)
        // ★ 重建的窗口也要挂上监听，否则 closeToTray 与 mainWindow 置空就只对首个窗口有效
        attachWindowHandlers(mainWindow)
      } else {
        mainWindow?.show()
      }
    })
  })

  app.on('before-quit', () => {
    isQuitting = true
  })

  app.on('will-quit', () => {
    disposeMediaKeys?.()
    disposeMediaKeys = null
    destroyTray()
    disposeMiniWindow()
  })

  app.on('window-all-closed', () => {
    // Linux 上托盘常驻是常见用法，但这个应用默认「关掉窗口就退出」，
    // 只有用户显式开了 closeToTray 才留在后台（那条路径下窗口不会真的 close）。
    if (process.platform !== 'darwin') app.quit()
  })
}
