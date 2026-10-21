/**
 * 主进程 ↔ 渲染层的 IPC 契约。
 *
 * 渲染层**不能**直接 import electron（ESLint 会拦）。所有跨边界能力都经 preload
 * 白名单暴露成 `window.songloft`，渠道名只能从这里取 —— 避免两边各写一份字符串。
 */

import type { GithubInstalls } from './github-discovery'
import type { ParsedLyric } from './lyric'
import type { PlayMode, Song } from './types'

export const IPC = {
  // ── 配置持久化（主进程持有 JSON 文件，渲染层只透过 IPC 读写）────────────────
  settingsGet: 'settings:get',
  settingsPatch: 'settings:patch',
  settingsReset: 'settings:reset',

  // ── 凭据：token 落主进程，渲染层启动时拉一次 ──────────────────────────────
  credentialsGet: 'credentials:get',
  credentialsSet: 'credentials:set',
  credentialsClear: 'credentials:clear',

  // ── 服务器列表 ─────────────────────────────────────────────────────────
  serversList: 'servers:list',
  serversUpsert: 'servers:upsert',
  serversRemove: 'servers:remove',
  serversProbe: 'servers:probe',
  /** 各已保存服务器上登录过的账号名（只回非敏感的那一半，不含 token） */
  serversAccounts: 'servers:accounts',

  // ── 窗口 / 托盘 / 系统集成 ─────────────────────────────────────────────
  windowMinimize: 'window:minimize',
  windowToggleMaximize: 'window:toggle-maximize',
  windowClose: 'window:close',
  windowGetState: 'window:get-state',
  trayUpdate: 'tray:update',
  openExternal: 'shell:open-external',
  /** 弹保存框把文本写盘（导出歌单备份；渲染层没有文件系统权限） */
  fileSave: 'file:save',
  /** 弹打开框读文本（导入歌单备份）；取消返回 null */
  fileOpen: 'file:open',
  /**
   * 弹系统文件框挑**本地音频文件**（取消返回空数组）。
   *
   * ★ 与上面 fileOpen 是两件事，别合并：那个读的是「一首歌的备份文本」，这个挑的是
   *   「要拿去播放的音频文件」—— 过滤器、是否多选、返回什么（路径 vs 内容）全不一样。
   */
  localFilesOpen: 'localfile:open',
  /**
   * 取走主进程替我们排好的那批本地文件路径（**取走即清空**）。
   *
   * ★ 为什么是「取」而不是「推」：路径可能在任何时刻产生（启动参数、macOS 的 open-file、
   *   第二次启动），而渲染层可能还没装好监听。只推送的话那几条消息会直接消失（用户双击了
   *   文件却什么都没发生）；排队 + 取走，则「早到晚到都只处理一次」。
   *   与 miniIsOpen 是同一条理由（见那条的说明）。
   */
  localFilesTakePending: 'localfile:take-pending',
  /** 本机磁盘缓存（Chromium 的 HTTP 缓存）占用。服务端缓存那套走 HTTP 接口，这个是本机自己的 */
  localCacheStats: 'cache:stats',
  /** 清掉本机磁盘缓存，返回清理后的占用 */
  localCacheClear: 'cache:clear',
  /** 主进程代取封面字节（canvas 取主色需要，绕开跨域画布污染） */
  colorExtract: 'cover:extract',
  appInfo: 'app:info',
  /** 主进程代查 GitHub 上的最新 release（渲染层不直连第三方，也省掉 CORS 与 UA 的坑） */
  clientUpdateCheck: 'app:check-client-update',
  /**
   * 主进程代查「GitHub 发现」（插件商店里的那一份社区来源）。
   *
   * 与 clientUpdateCheck 同一条理由 —— 渲染层不直连第三方。另外这里还要逐仓库核对清单与
   * release 资产，一页就是几十个请求，放在主进程才能共享那份 1 小时的清单缓存。
   */
  githubDiscovery: 'github:discover',

  // ── 迷你窗口（独立 BrowserWindow，见 main/mini-window.ts）──────────────────
  //
  // 四个来回都经过主进程转手，原因只有一条：**两个渲染层之间没有直接通道**
  // （contextIsolation + 各自独立的 webContents），而播放的唯一事实源在主窗口那边。
  // 主进程在这里只做「转发 + 算窗口尺寸」，不碰任何播放状态。
  /** 主窗口 → 主进程：开 / 关迷你窗 */
  miniSetOpen: 'mini:set-open',
  /** 迷你窗 → 主进程：报一下此刻的布局（条 / 面板 / 菜单），由它算窗口高度 */
  miniResize: 'mini:resize',
  /** 迷你窗 → 主进程：界面与设置都就绪了（主进程据此显示窗口，并把请求转给主窗口） */
  miniReady: 'mini:ready',
  /** 主窗口 → 主进程：推一份播放状态（转给迷你窗） */
  miniPush: 'mini:push',
  /** 迷你窗 → 主进程：发一条遥控命令（转给主窗口执行） */
  miniCommand: 'mini:command',
  /**
   * 主窗口 → 主进程：迷你窗**此刻**开着没有。
   *
   * ★ 已经有 onMiniOpen 那条推送了，为什么还要这一条问的通道：那条只在**开合的那一刻**响一次，
   *   而主窗口那两份接线可能比窗口晚到 —— dev 的 HMR 重新挂载、渲染层刷新（Ctrl+R）或崩溃重载
   *   都会把它们重装一遍，那时迷你窗还开着，却再没有任何事件会告诉新装上的那一份。
   *   不问一句的话它会一直以为「没开」——而那个布尔量正是「要不要推状态」的闸门，
   *   于是迷你窗冻在重载前的那一帧上（还显示着，就是不动了）。
   * ★ 窗口是主进程开的，「开着没有」也只有它说了算（见 main/mini-window.ts 的 isMiniWindowOpen）。
   */
  miniIsOpen: 'mini:is-open',

  // ── 主进程 → 渲染层（单向推送）────────────────────────────────────────
  onMediaCommand: 'media:command',
  onWindowState: 'window:state',
  onNavigate: 'app:navigate',
  /** 有本地文件等着被打开（推给主窗口：来取一下，见 localFilesTakePending） */
  onLocalFilesPending: 'localfile:pending',
  /** 迷你窗开没开（推给主窗口：那颗按钮的高亮、以及要不要继续推送状态都看它） */
  onMiniOpen: 'mini:open',
  /** 播放状态快照（推给迷你窗） */
  onMiniState: 'mini:state',
  /** 迷你窗在要状态（推给主窗口：请立刻推一份完整快照） */
  onMiniRequest: 'mini:request',
  /** 遥控命令（推给主窗口：落到真播放器上） */
  onMiniCommand: 'mini:command',
  /**
   * 设置被某个窗口改了（推给**其余**窗口）。
   *
   * 两个窗口各有一份 useSettings，而主题 / 强调色 / 两份不透明度都是「一改就该两处同时变」
   * 的东西。只靠调用方自己刷新的话，主窗口改主题、迷你条还停在旧主题上。
   */
  onSettingsChanged: 'settings:changed'
} as const

export interface WindowState {
  maximized: boolean
  fullscreen: boolean
  focused: boolean
}

/**
 * 迷你窗的固定尺寸与下限。
 *
 * ★ 只有宽度与「播放条那一档高度」是死的：面板高度可由用户拖（见 MiniWindowLayout），
 *   拖出来的值存进设置 —— 歌词与队列**各记一份**（AppSettings.miniLyricsPanelHeight /
 *   miniQueuePanelHeight），两块于是可以不一样高。
 * ★ MINI_BAR_HEIGHT 必须与样式表里 `.mini-player` 的高度一致（styles/components.css 的
 *   `--mini-bar-h`）—— 两边差一档就是「条里空出一截」或「控件被裁掉」。
 * ★ 宽度 380 这一档实测（拿一首长歌名 + 时长 1:02:05 的歌压中栏）：中栏 174px、悬浮那一层
 *   的音量条 84px，五颗控件与右上角那颗窗口钮的右边缘都正好落在 380 上 —— 一个不裁。
 *   再往下调就是中栏与音量条互相让位（两者都是可收缩的 flex 项），歌名那头先开始看不见字。
 * ★ MINI_MENU_HEIGHT 是为什么存在：菜单（components/ContextMenu 那一份，那几根滑块就挂在它
 *   上面）是页面里的 DOM，**画不出窗口** —— 而条自己只有 64px 高，一份「几根滑块」的菜单压不
 *   进去：它几行加起来两百来像素，而 .context-menu 的 max-height 是 60vh，窗口只有 64px 时
 *   60% × 64 = 38px，菜单当场变成一条带滚动条的缝。所以菜单一开就把窗口临时加高到这一档
 *   （面板展开的那一档本来就比它高，不必再让）。菜单里加减内容时要回来看看够不够 ——
 *   这一档是为**四根滑块**算的（整窗浓度 + 两块面板的浓度 + 歌词字号），再多一行就不够了。
 */
export const MINI_BAR_HEIGHT = 64
/** 播放条（与面板）自己的宽度 —— **窗口**比它宽，两侧多出来的那圈留给阴影，见 MINI_SHADOW_EDGE */
export const MINI_WIDTH = 380
/**
 * 菜单开着（且面板没展开）时的**窗口总高**：上下那两圈阴影边距 + 播放条 + 一份完整菜单。
 * 加高的是**窗口**，不是播放器：条永远 64px、面板永远是自己那个高度，多出来的全落在
 * .mini-slack 那块透明容器里（见 MiniWindowLayout.menu）。
 *
 * ★ 380 是**四根滑块**那一档（整窗浓度 + 歌词面板 + 队列面板 + 歌词字号，见 MiniPlayer 的
 *   displayMenu）：两道约束都得过，取**下限更高**的那一方 —— 括号里是在真 Chromium 里量出来的数：
 *   1. **菜单要有地方画**：一行 51px（标题 + 一条 range，见 components.css 的 .menu-slider），
 *      四行加菜单自身的内边距与描边是 215px；菜单顶端在**那颗钮的下缘再往下 6px** 处
 *      （见 MiniPlayer 的 toggleMenu），而那颗钮落在条顶部那条空隙里、下缘在窗口顶部
 *      往下 29px —— 于是菜单下缘落在 250px，再留出下边那圈阴影边距（MINI_SHADOW_EDGE）→ 260。
 *      窗口比它矮，菜单就被窗口下边缘**裁掉**（HTML 画不出窗口之外）。
 *   2. **.context-menu 自己的 `max-height: 60vh`**：要放得下 215px 就得 359px 以上（215 / 0.6）
 *      —— 这一条才是真正卡住下限的（低于它菜单会变成一条带滚动条的缝）。
 *   380 给这两道各留了一点余量。
 * ★ 菜单里**加减内容时回来核这一档**：它不跟着菜单一起长，少了就是「菜单被裁 / 出滚动条」。
 *   核法就是把那份菜单放进一个这一档高的页面里量一次 offsetHeight，与 `60vh` 比谁大。
 */
export const MINI_MENU_HEIGHT = 380
/**
 * 窗口四周留给**窗口阴影**的透明边距（每边这么多）。
 *
 * ★ 为什么需要它：窗口是透明的（frame: false + transparent），阴影只能画在窗口**内部** ——
 *   `box-shadow` 画在元素框**外面**，可见面若贴着窗口边缘，那圈阴影就被窗口边界裁掉了。
 *   于是可见面（.mini-player / .shell）从窗口边缘缩进这一圈，缩出来的地方只画阴影
 *   （见 styles/base.css 的 #root 与 --win-shadow）。
 * ★ 与样式表里的 `--win-edge` 是同一个数（那边给渲染层用，这边给主进程算窗口尺寸用）——
 *   与 MINI_WIDTH / --mini-w 是同一个道理：两处差一档，条就会比窗口窄出一块或反过来被裁。
 */
export const MINI_SHADOW_EDGE = 10
/** 迷你窗**窗口**的尺寸 = 播放器本体 + 两侧留给阴影的那一圈 */
export const MINI_WINDOW_WIDTH = MINI_WIDTH + MINI_SHADOW_EDGE * 2
/** 面板能拖到的最小高度：再矮就只剩一行歌词的位置，那个高度没有意义（两块共用同一个下限） */
export const MINI_PANEL_MIN_HEIGHT = 180
/** 两块面板的默认高度（首次打开 / 这块还没拖过时用；两块可以各自拖成不一样高） */
export const MINI_PANEL_DEFAULT_HEIGHT = 416
/**
 * 迷你窗歌词字号的取值范围（px，见 AppSettings.miniLyricFontSize）。
 *
 * ★ 上限比主窗口那一条（设置页里 16–48）低得多：这一块只有 MINI_WIDTH 那么宽（≈380px，
 *   两侧还要各让出 26px 的内边距），字号越大一行剩的字越少 —— 30px 时一行只剩十来个字，
 *   再往上就全是折行，不是「看得更清楚」而是「读不成句」了。
 * ★ 与默认值放在一处（DEFAULT_SETTINGS 里那个 15）：一项设置的「能调到哪儿」与「默认在哪」
 *   分开写，迟早会出现「默认值在范围之外」这种事。
 */
export const MINI_LYRIC_FONT_SIZE_MIN = 12
export const MINI_LYRIC_FONT_SIZE_MAX = 30

/**
 * 迷你窗此刻的布局。
 *
 * 三个量共同决定窗口高度（`main/mini-window.ts` 的 applyBounds），**必须一起传**：
 * 分两次传的话，主进程会在两次调用之间先摆出一个中间尺寸 —— 那一下是看得见的。
 *
 * ★ 面板里装的是歌词还是播放队列，主进程**不关心**：两块各有各的高度（见
 *   AppSettings.miniLyricsPanelHeight / miniQueuePanelHeight），但窗口只需要知道**开着的那一块**
 *   此刻多高 —— 所以这里只有一个布尔量与一个高度，而不是 `panel: 'lyrics' | 'queue' | null`。
 * ★ `menu` 同理：菜单里有哪几项、滑块在调什么，主进程不关心；它只需要知道「页面上有个菜单
 *   开着，而 HTML 画的菜单出不了这个 64px 高的窗口」——高度那一档是死的（MINI_MENU_HEIGHT），
 *   所以给布尔量就够了。
 */
export interface MiniWindowLayout {
  /** 下方面板展开了没有 */
  expanded: boolean
  /** **开着的那一块**面板希望的高度（px；展开时才有意义，下限见 MINI_PANEL_MIN_HEIGHT） */
  panelHeight: number
  /** 窗口里正开着菜单（上部那颗钮拉出来的显示设置菜单） */
  menu: boolean
}

/**
 * 迷你窗要显示的播放状态 —— **轻的那一半**，跟着播放进度走（约每秒几次）。
 *
 * 拆成轻 / 重两半不是为了省几个字节，而是为了让「每秒四次的推送」不必带上队列与歌词
 * （队列最多 500 首、歌词可能上百行，都塞进每秒四次的包里纯属白烧）。
 */
export interface MiniPlayerLight {
  /** 当前曲目在 order 里的游标；-1 = 还没开始播 */
  cursor: number
  playing: boolean
  position: number
  duration: number
  volume: number
  muted: boolean
  playMode: PlayMode
  /** 当前曲目收没收藏（主窗口那份收藏表是唯一事实源） */
  favorite: boolean
  /** 主窗口按封面取出的强调色。迷你窗自己算不了（那要 canvas + 主进程代取字节） */
  accent: string | null
  /**
   * 播放条上那句状态（见 PlayerState 的 `status` / `error`）：正在获取音源、正在切换第 N 个
   * 音源、缓冲中、以及真的放不出来时的那句结论。
   *
   * ★ 文案本身**由主窗口的播放核心写**（state/player-core 的状态机），迷你窗只负责显示 ——
   *   两边各写一套措辞迟早会漂成两句不一样的话。它俩跟 `accent` 一样属于「主窗口知道、
   *   迷你窗算不出」的那一类。
   */
  status: string | null
  error: string | null
}

/**
 * **重的那一半**：只在队列 / 歌词真的变了时才发（换歌时也会重发 —— 歌词跟着换）。
 *
 * ★ 顺序要紧：两者同时变化时**先发这一份、再发 light**。反过来的话，迷你窗会拿新 cursor 去
 *   查旧 queue，取到的是另一首歌（或 undefined）。
 * ★ media 也在这里：封面是交给 `img` 直接请求的，地址里得带 `access_token`，而迷你窗**没有
 *   会话**（见 MiniApp 的说明）——服务器地址与 token 只能由主窗口喂过来。
 * ★ 字段与 state/usePlayer 的 PlayerState 一一对应，迷你窗那边的镜像 store 直接照着贴。
 */
export interface MiniPlayerHeavy {
  queue: Song[]
  order: number[]
  lyrics: ParsedLyric
  lyricsLoading: boolean
  lyricFailed: boolean
  media: { baseUrl: string; accessToken: string }
}

export interface MiniPlayerSnapshot {
  light: MiniPlayerLight
  heavy: MiniPlayerHeavy
}

/**
 * 迷你窗发来的**遥控命令**。
 *
 * 命名与 PlayerState 上的方法一一对应，主窗口那份执行器于是就是一张直白的 switch
 * （见 renderer 的 state/mini-host.ts）—— 换一套名字只会多出一层翻译。
 *
 * ★ 这里刻意**没有**「播放某一批歌」「加入队列」这类带歌曲数组的命令：迷你窗里没有能触发它
 *   们的入口（曲库、歌单、搜索都在主窗口那边），凭空多一条通道等于多一份要维护的语义。
 *   真需要时再加，别顺手补全。
 */
export type MiniCommand =
  | { kind: 'toggle' }
  | { kind: 'pause' }
  | { kind: 'next'; auto: boolean }
  | { kind: 'previous' }
  | { kind: 'seek'; seconds: number }
  | { kind: 'seek-by'; delta: number }
  | { kind: 'set-volume'; volume: number }
  | { kind: 'flush-volume' }
  | { kind: 'toggle-mute' }
  | { kind: 'cycle-play-mode' }
  | { kind: 'set-play-mode'; mode: PlayMode }
  | { kind: 'toggle-favorite' }
  | { kind: 'jump-to'; index: number }
  | { kind: 'remove-from-queue'; indexes: number[] }
  | { kind: 'move-in-queue'; from: number; to: number }
  | { kind: 'clear-queue' }
  | { kind: 'reload-lyrics' }

/** 迷你窗里那两个面板装什么（与主窗口抽屉的 PanelTab 同一套语义，只是少一个「正在播放」） */
export type MiniPanel = 'lyrics' | 'queue'

export type MediaCommand =
  | { kind: 'play-pause' }
  | { kind: 'next' }
  | { kind: 'previous' }
  | { kind: 'seek'; delta: number }
  | { kind: 'volume'; delta: number }
  | { kind: 'toggle-mute' }
  | { kind: 'toggle-favorite' }
  | { kind: 'toggle-lyrics' }

/** 托盘菜单要显示的当前播放概要 */
export interface TraySnapshot {
  title: string | null
  artist: string | null
  playing: boolean
  favorite: boolean
}

/** 写盘结果：用户取消对话框时为 saved=false */
export interface FileSaveResult {
  saved: boolean
  path: string | null
}

/** 读到的文件（只回文本内容，路径不出主进程） */
export interface FileOpenResult {
  name: string
  contents: string
}

/**
 * 本机磁盘缓存（客户端自己的那份）。
 *
 * 与 `CacheStats`（服务端音乐缓存）是两码事：那份在服务器上、所有设备共用；这份是本机
 * Chromium 会话的 HTTP 缓存，落在 userData 里，换服务器 / 换账号都清，换台机器就没有。
 */
export interface LocalCacheStats {
  /** 已占用字节 */
  size: number
  /** 生效中的上限字节（0 = 交给 Chromium 按可用磁盘空间自行决定） */
  maxSize: number
}

export interface ServerProbeResult {
  ok: boolean
  /** 探到的后端版本（`/api/v1/version`） */
  version: string | null
  /** `/api/v1/health` 是否 200 */
  healthy: boolean
  /** 失败原因，ok 为 false 时给出 */
  error: string | null
  /** 探测耗时（毫秒） */
  elapsedMs: number
}

export interface AppInfo {
  name: string
  version: string
  electron: string
  chrome: string
  node: string
  platform: string
  /** 是否以 AppImage 运行（决定要不要提示手动装 AppArmor profile） */
  appImage: boolean
  /** 打包态 / 开发态 */
  packaged: boolean
}

/**
 * 「客户端更新」的检查结果。
 *
 * 只报「有没有新版本」与发布页地址，**不含**下载与安装：桌面端的二进制归安装包与包管理器管，
 * 应用自己去换自己这件事另有代价（见 settings 里那条说明），不在这一步里。
 */
export interface ClientUpdateCheck {
  /** GitHub 上最新 release 的 tag（一般是 v1.2.3） */
  latestTag: string
  /** 该 release 的页面地址 —— 「打开发布页」用的就是它 */
  latestUrl: string
  /** 发布时间（ISO 字符串；拿不到就是空串） */
  publishedAt: string
}

/** 扩展主框架里那条侧边栏的形态：展开 / 折叠成图标条 / 整个隐藏 */
export type ExtensionSidebarState = 'expanded' | 'collapsed' | 'hidden'

/** 桌面端偏好设置（纯本地，不属于后端 configs） */
export interface AppSettings {
  /** 上次使用的服务器（按 URL 定位） */
  activeServerUrl: string | null
  theme: 'system' | 'dark' | 'light'
  accent: string
  /** 主题色是否跟随封面取色 */
  accentFromCover: boolean
  /** 界面密度 */
  density: 'comfortable' | 'compact'
  /** 玻璃质感强度 0–100（标题栏 / 侧栏 / 右侧抽屉共用的那层「统一浓度」） */
  glassIntensity: number
  /**
   * **普通（非迷你）窗口**的整窗不透明度 0–100：100 = 完全实心（默认，观感与改动前一致），
   * 0 = 整窗消失。也就是设置页里那个「主播放器不透明度」。
   *
   * ★ 它调的是**整个程序这一层窗口**，与 glassIntensity / lyricPanelOpacity 那种
   *   「某个面**自己那层底色**」不是一类东西，别混着看：底色浓度只能透出同一窗口里它下面的
   *   一层，**桌面永远进不来**。
   *   要让整个客户端透出后面的桌面 / 别的窗口，只能动窗口这一层，且必须**两件事同时成立**：
   *     1. 主进程把窗口做成透明窗口（main/windows.ts 的 `transparent`）——
   *        否则渲染层再淡，也只是与窗口那块不透明底色混在一起，看着像「变暗」而不是「透明」；
   *     2. 渲染层给整棵界面树一个 opacity（styles/base.css 的 body）。
   *   ★ 这个值**只在渲染层生效**，主进程不读它：透明窗口是**恒开**的（见 windows.ts 的说明），
   *     所以调它不需要重建窗口、也不需要重启。
   */
  windowOpacity: number
  /**
   * **迷你窗口**的整窗不透明度 0–100，与 windowOpacity **各存一份、互不影响**。
   *
   * ★ 两个窗口各有一份自己的界面树（迷你窗是独立 BrowserWindow），所以分开靠的是
   *   <html> 上的 data-mini 标记（见 base.css 里那两条 opacity）。
   * ★ 为什么不与 windowOpacity 共用一个值：它们想要的通透程度本来就不一样 —— 主窗常与
   *   别的窗口并排看，迷你条则要浮在屏幕角上、还能瞧见底下在放什么。
   */
  miniWindowOpacity: number
  /**
   * 迷你窗**歌词面板**自己的底色浓度 0–100。
   *
   * ★ 它是相对**播放条那层底色**的浓度（样式表里 `color-mix(--mini-tint …)`），所以 100 就是
   *   「与播放条一致」—— 深浅两个主题下都成立，不必为两边各写一个默认值。
   * ★ 与 windowOpacity / miniWindowOpacity 不是一回事：那两个调的是**整窗**（桌面会透进来），
   *   这一个只在窗口内部透 —— 面板淡下去露出的是同一窗口里它下面那层。
   *   与 lyricPanelOpacity 也不是一个：那个只作用于歌词区域，且只在歌词那边生效。
   * ★★ 它还牵动**窗口那圈阴影**（面板淡下去之后，围着一块透明区域画阴影就是错的）：
   *   围着「条 + 面板」那一圈按同一比例淡出，围着播放条自己那一圈按互补比例淡入 ——
   *   面板透到 0 时，挂件的下边缘就是**条的下边缘**，阴影跟过来围住它。
   *   两份权重在 components.css 的 .mini-player（--mini-shadow-keep / --mini-shadow-bar），
   *   两个落点在 .mini-surface 与 .mini-player::before。
   * ★ 歌词与队列**各存一份**（两块要能分别调）：这里存的是两个候选值，「此刻生效的是哪一份」
   *   由样式表按 .mini-player 上的 data-panel 挑 —— 挑选需要一个组件上的选择器，JS 不掺和。
   */
  miniLyricsPanelOpacity: number
  /** 迷你窗**播放队列面板**的底色浓度。与 miniLyricsPanelOpacity 同义、各管各的 */
  miniQueuePanelOpacity: number
  /**
   * 迷你窗歌词面板的高度 px（用户拖着调的，见 main/mini-window.ts 与 MiniPlayer 底部那根把手）。
   *
   * 存下来是因为「我拖到这么高」是个偏好而不是临时值：迷你窗每次打开都是新窗口，
   * 不记的话拖出来的高度一关就没了。下限见 MINI_PANEL_MIN_HEIGHT。
   * ★ 两块各存一份：拖歌词那根把手改的是这一项，切到队列时用的是 miniQueuePanelHeight ——
   *   于是「歌词拉高看歌词、队列留矮一点」这种组合是可能的（两块互不影响）。
   */
  miniLyricsPanelHeight: number
  /** 迷你窗播放队列面板的高度 px。与 miniLyricsPanelHeight 同义、各管各的 */
  miniQueuePanelHeight: number
  /**
   * 迷你窗歌词面板的字号 px（上下限见 MINI_LYRIC_FONT_SIZE_MIN / MAX）。
   *
   * ★ 与 lyricFontSize（设置页「歌词」那一栏）**是两个量，刻意不共用**：
   *   主窗口那几处歌词（底栏抽屉、满窗播放）在整窗尺度上看，迷你窗那一块只有 380px 宽、
   *   还是挂在屏幕角上的一个挂件 —— 两处的「合适字号」差着一档。共用一个值的结果是
   *   「调好抽屉、迷你窗就糊成一片；调好迷你窗、抽屉又小得看不清」。
   *   所以迷你窗右上角那颗钮里的那根滑块只改这一项（只作用在迷你窗那块面板上）。
   * ★ 默认 15 不是随手挑的：它正是这一块此前**写死**的那个字号（见 components.css 的
   *   .lyric-line 与紧随其后的 html[data-mini] 那条）—— 于是装上这条设置之后，谁的字号
   *   都不会当场变样，只有「拖得动」这件事是新的。
   */
  miniLyricFontSize: number
  /** 歌词字号 px */
  lyricFontSize: number
  /**
   * 歌词区域自身底色不透明度 0–100：100 = 完全不透明，0 = 完全透明（默认）。
   *
   * 它只是**叠在**宿主（右侧抽屉 / 迷你窗口）玻璃质感之上的一层 —— 0 时完全透出宿主，
   * 也就是改动前的观感。与 glassIntensity 同为「底色浓度」，但作用于哪个面互不相干。
   */
  lyricPanelOpacity: number
  /** 歌词字体颜色（`#rrggbb`；空串 = 跟随主题文字色） */
  lyricFontColor: string
  /** 歌词字体不透明度 0–100。只影响歌词文字，不动上面那层底色 */
  lyricFontOpacity: number
  /** 歌词是否显示翻译 / 罗马音 */
  lyricShowTranslation: boolean
  lyricShowRoman: boolean
  /** 关闭窗口时最小化到托盘而不是退出 */
  closeToTray: boolean
  /**
   * 普通（非迷你）窗口是否置顶。
   *
   * ★ 与 miniAlwaysOnTop **各存一份、互不影响**：它们是「两种形态各自的窗口偏好」，不是同一个
   *   开关的两种读法。合并成一个的话，用户为了不让大窗口挡着别人而关掉置顶，迷你条也会跟着
   *   掉下去 —— 而迷你条的整个用法就是浮在别的窗口之上。
   */
  alwaysOnTop: boolean
  /**
   * 迷你窗口是否置顶。**默认开**：迷你模式就是「挂在屏幕一角、停在别的东西旁边」，
   * 不浮着就失去意义了（想让它安静待着的人可以在迷你条上右键关掉）。
   */
  miniAlwaysOnTop: boolean
  /** 默认音量 0–1 */
  volume: number
  playMode: PlayMode
  /** 播放时是否把音量归一化参数带给后端 */
  volumeNormalize: boolean
  /** 音质偏好：'original' | '128' | '192' | '320' */
  quality: 'original' | '128' | '192' | '320'
  /** 忽略 TLS 证书校验（自签/内网证书）。只影响 Chromium 网络栈的本机会话。 */
  allowInsecureTls: boolean
  /**
   * 本机磁盘缓存上限（字节，0 = 不限）。
   *
   * Chromium 只在启动那一刻读一次上限（`--disk-cache-size`），运行中改不了 —— 所以这个值
   * 存下来、下次启动时交给它，设置页会明说「重启后生效」。
   */
  localCacheMaxSize: number
  /**
   * 启动时自动检查更新（服务端与客户端各查一次）。
   *
   * 两次都是普通读取：客户端那次由主进程直连 GitHub，服务端那次是问后端 `/upgrade/check`。
   * 关掉就完全不因为这件事联网（两边都不查）。
   */
  autoCheckUpdate: boolean
  /** 侧栏是否折叠 */
  sidebarCollapsed: boolean
  /**
   * 扩展主框架里那条侧边栏的形态：展开 / 折叠成图标条 / 整个隐藏。
   *
   * 与主侧栏分开存（两者宽度与用途都不同）。**它既是「默认」也是「当前」**：
   * 右下角那颗按钮只在前两者之间来回切，三档选择器在插件管理页 —— 一个设置而已，
   * 不必再分「默认值」与「临时值」两份（那两份迟早对不上）。
   */
  extensionSidebarState: ExtensionSidebarState
  /**
   * 歌单页的呈现形式：封面网格 / 紧凑列表。
   *
   * 做成设置而不是页面内 state：桌面端换了形式就该一直记着，下次打开还是这个样子
   * （与 sidebarCollapsed 同一类「界面偏好」，不是临时值）。
   */
  playlistView: 'grid' | 'list'
  /** 记住的播放队列（会话恢复） */
  lastQueue: number[]
  lastQueueIndex: number
  lastQueueContext: { type: string; key: string } | null
  /** 最近播放（本地，最多 200 条，最新在前） */
  recentSongIds: number[]
  /**
   * 从「GitHub 发现」装上的插件：`entryPath → 来源（仓库 id + 版本）`。
   *
   * ★ 必须**跟着设置一起落盘**，不能只是商店页的临时 state：插件包装上之后服务端存的是
   *   **包内**清单（多半没有 `download_url`、`updateUrl` 也可能为空），除此之外没有任何东西
   *   能证明「本机这一份就是从那个仓库装的」。丢了它，同一张卡片再进商店就会被判成
   *   「入口冲突」（警告要替换掉的其实是它自己）。
   */
  githubInstalls: GithubInstalls
}

export const DEFAULT_SETTINGS: AppSettings = {
  activeServerUrl: null,
  theme: 'system',
  accent: '#7c5cff',
  accentFromCover: true,
  density: 'comfortable',
  glassIntensity: 62,
  // 两个整窗浓度都默认实心：透明窗口只是提供可能，要不要真透由用户拧滑块决定
  windowOpacity: 100,
  // 迷你窗同样默认实心（与主窗各管各的）
  miniWindowOpacity: 100,
  // 两块面板各自一份；100 = 与播放条一致（相对浓度，见 AppSettings.miniLyricsPanelOpacity 的说明）
  miniLyricsPanelOpacity: 100,
  miniQueuePanelOpacity: 100,
  // 两块各自一份高度：默认一样，用户拖过之后才分岔
  miniLyricsPanelHeight: MINI_PANEL_DEFAULT_HEIGHT,
  miniQueuePanelHeight: MINI_PANEL_DEFAULT_HEIGHT,
  // 15 正是迷你窗歌词这块此前写死的那个字号（见 AppSettings.miniLyricFontSize 的说明）
  miniLyricFontSize: 15,
  lyricFontSize: 30,
  // 默认不铺额外底色：歌词区域透出所在面板的玻璃质感（与改动前一致）
  lyricPanelOpacity: 0,
  // 空串 = 跟随主题的文字色
  lyricFontColor: '',
  lyricFontOpacity: 100,
  lyricShowTranslation: true,
  lyricShowRoman: false,
  closeToTray: false,
  // 大窗口默认不置顶：它是要跟别的窗口并排用的，浮在最上层只会碍事
  alwaysOnTop: false,
  // 迷你条默认置顶：见 AppSettings.miniAlwaysOnTop 的说明
  miniAlwaysOnTop: true,
  volume: 0.8,
  playMode: 'loop',
  volumeNormalize: false,
  quality: 'original',
  allowInsecureTls: false,
  // 与上游客户端的默认档一致：本机缓存默认给 1 GB，再多就该自己清或调小了
  localCacheMaxSize: 1024 ** 3,
  // 默认开着：查一次很便宜，而「不知道自己落后了」的代价更大；嫌烦的人可以关掉
  autoCheckUpdate: true,
  sidebarCollapsed: false,
  extensionSidebarState: 'expanded',
  // 默认网格：封面是歌单最主要的识别信息（见 PlaylistsPage 的说明）
  playlistView: 'grid',
  lastQueue: [],
  lastQueueIndex: -1,
  lastQueueContext: null,
  recentSongIds: [],
  // 没装过任何 GitHub 插件时是空的；老配置读回来由 { ...DEFAULT_SETTINGS, ...persisted } 补齐
  githubInstalls: {}
}

export interface ServerEntry {
  url: string
  name: string
  lastUsedAt: number
}
