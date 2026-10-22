/**
 * 应用外壳。
 *
 * 三层结构（栅格来自 base.css 的 .shell / .shell-body / .main-column）：
 *   ┌ 标题栏（LOGO + 扩展入口 + 折叠菜单/搜索/窗口控制）—— 唯一常驻的原生 chrome
 *   ├ 侧栏 │ 工具条 + 主滚动区 │ 右侧抽屉
 *   └ 播放条
 *
 * ★ 标题栏以下是**一个可替换的内容面**，两种形态：原生页（上面那三层）或者扩展主框架
 *   （左右分栏，左是扩展侧栏、右是插件商店/插件管理/某个扩展）。扩展不是一个页签，
 *   而是一整块去处 —— 所以它不是主内容区里的一页。
 *
 *   两面**都挂着，只藏不走**（`.surface[data-hidden]`）：切过去再切回来，每一面都还是
 *   离开时的样子（滚动位置、已加载的列表、商店筛到第几页、正在出声的扩展）。
 *   各面停在哪儿由 `useUi` 的两份路由分别记着，见那里的说明。
 *
 * 三件「只该发生一次」的接线也放在这里：
 *   1. 全局快捷键（空格/方向键/Ctrl+K…）
 *   2. 主进程推送（托盘与媒体键发来的命令、菜单发来的导航）
 *   3. 启动编排（读设置 → 校验会话 → 预载歌单/收藏/上次队列）
 * 用 started ref 兜住，避免 HMR 或多次挂载把它们接两遍。
 *
 * ★ 有一样**不能**这么兜：迷你窗那两条接线（开关状态的回声 + 状态推送）。它单独一个 effect
 *   装卸，理由写在那一节 —— 一次性守卫会把「卸下之后的重装」一并挡掉，而严格模式恰好每次都
 *   卸下再重装，于是那条线在 dev 里是断的。
 */

import { useEffect, useRef, useState } from 'react'

import { isNewerVersion } from '@shared/version'
import { checkServerUpgrade, getGithubProxy } from './api/endpoints'
import { AddToPlaylistDialog } from './components/AddToPlaylistDialog'
import { DlnaDialog } from './components/DlnaDialog'
import { CommandPalette } from './components/CommandPalette'
import { ContextMenuHost } from './components/ContextMenu'
import { ExtensionFrame } from './components/ExtensionFrame'
import { FullPlayer } from './components/FullPlayer'
import { IconClose, IconLoader, IconSearch } from './components/Icons'
import { Panel } from './components/Panel'
import { PlayerBar } from './components/PlayerBar'
import { Sidebar } from './components/Sidebar'
import { TitleBar } from './components/TitleBar'
import { Toasts } from './components/Toasts'
import { TooltipHost } from './components/Tooltip'
import { useResponsiveSidebar } from './hooks/useResponsiveSidebar'
import { PageActiveProvider } from './hooks/usePageActive'
import { formatVersion } from './lib/format'
import { FavoritesPage } from './pages/FavoritesPage'
import { HomePage } from './pages/HomePage'
import { LibraryPage } from './pages/LibraryPage'
import { LoginPage } from './pages/LoginPage'
import { PlaylistDetailPage } from './pages/PlaylistDetailPage'
import { PlaylistsPage } from './pages/PlaylistsPage'
import { RecentPage } from './pages/RecentPage'
import { SearchPage } from './pages/SearchPage'
import { SettingsPage } from './pages/SettingsPage'
import { installLocalFileIntake } from './state/useLocalFiles'
import { installMediaCommands } from './state/media-commands'
import { installMiniHost } from './state/mini-host'
import { installMetadataWatch } from './state/song-metadata'
import {
  installMediaSessionHandlers,
  installNowPlayingSync,
  primeAudio,
  usePlayer
} from './state/usePlayer'
import { requireClient, useAuth } from './state/useAuth'
import { subscribeCastState, useDlna } from './state/dlna'
import { useLibrary } from './state/useLibrary'
import { usePlaylists } from './state/usePlaylists'
import { usePlugins } from './state/usePlugins'
import { useSettings, watchSystemTheme } from './state/useSettings'
import { toast } from './state/useToasts'
import { routeFromPath, useUi, type NativeRoute, type Surface } from './state/useUi'

let bootstrapped = false

/**
 * 启动时悄悄查一次更新：**服务端与客户端各查一次**（「关于与更新」里那个开关控制它）。
 *
 * 为什么只查一次、只在启动时查：一个版本能用很久，更密的轮询除了给 GitHub 刷请求
 * （它还有频率限制）没有别的作用；真想主动看，设置里那两个「检查更新」会明说。
 *
 * **全程静默**：没有新版本不说话、连不上也不说话 —— 启动时的后台动作不该冒泡成人要处理的
 * 东西。真有状况，去设置里点一次就知道原因。
 *
 * 两件事各自独立（`Promise.all` + 各自 catch）：客户端那次是主进程直连 GitHub，服务端那次
 * 是问后端 —— 它们的失败原因完全不同，让一边拖垮另一边没有道理。
 */
async function checkUpdatesInBackground(): Promise<void> {
  if (!useSettings.getState().settings.autoCheckUpdate) return
  const client = requireClient()

  // 代理拿不到（后端不可达）就直连；服务端那次也一样把代理传过去 —— 后端不会自己去读那项配置
  const proxy = await getGithubProxy(client).catch(() => '')
  const [release, upgrade, info] = await Promise.all([
    window.songloft.app.checkClientUpdate(proxy).catch(() => null),
    checkServerUpgrade(client, proxy).catch(() => null),
    window.songloft.app.info().catch(() => null)
  ])

  if (release && info && isNewerVersion(release.latestTag, info.version)) {
    toast(
      '客户端有新版本',
      'info',
      `${formatVersion(release.latestTag)} 已发布，可在「设置 → 关于与更新」查看`
    )
  }
  if (upgrade?.has_update && upgrade.latest_version) {
    toast(
      '服务端有新版本',
      'info',
      upgrade.is_docker
        ? `${formatVersion(upgrade.latest_version)}，可在「设置 → 关于与更新」升级`
        : `${formatVersion(upgrade.latest_version)}（服务端不是容器部署，需在服务器上替换二进制）`
    )
  }
}

/** 只在输入类元素之外响应空格这类「会打字的键」 */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

export function App(): React.JSX.Element {
  const status = useAuth((s) => s.status)
  /**
   * 免登录模式。与 status 一起决定「能不能进主界面」（见下面那一处判断）：
   * 曲库那几页确实需要会话，但**播放**不需要，本地文件也不需要。
   */
  const guest = useAuth((s) => s.guest)
  const started = useRef(false)
  /**
   * 启动编排（读设置 → 校验会话 → 定落点）走完了没有。走完之前只给启动占位。
   *
   * ★ 主界面必须等它，不能只看 status：**落点是跟着会话一起定下来的**（没会话要落到
   *   「本地文件」那一页，见下面那段启动编排）。而 useAuth 与 useUi 是两份 store、各走各的
   *   调度（zustand 走 useSyncExternalStore，那一帧是在微任务边界上刷的）—— 会话那一位先到、
   *   落点晚一步的话，中间会实打实地挂出一帧**默认路由（首页）**的主界面。
   *   而首页一挂就出事：它的每个请求都要会话，`requireClient()` 是**同步抛**的，
   *   抛在 effect 里会掀掉整棵组件树（表现为整个窗口一片空白）。
   *   「走完了」与那个落点在同一个同步块里置位，中间就插不进这么一帧。
   */
  const [booted, setBooted] = useState(false)

  /* ── 窗级订阅：迷你窗那两条 + 窗口状态（可以、也必须反复装卸）────────── */
  /*
   * 一条是 installMiniHost()：把播放状态推给迷你窗、把它发来的遥控命令落到真播放器上
   * （见 state/mini-host.ts）。装在这里而不是某个组件里，因为全应用只有**这一个**真播放器
   * （就在这个窗口里）；也不能等下面那段启动编排（读设置 → 校验会话）走完 —— 底栏那颗按钮
   * 随时可能被点，而它点什么都要靠这两条。
   * 另一条是「迷你窗此刻开着没有」：底栏那颗按钮的高亮要看它（窗口是主进程开的，渲染层没有
   * 别的渠道知道这件事）。两条都走模块级订阅而不是 React —— 它们只影响一个布尔量与几份快照，
   * 让整棵界面树为它重渲染一次不划算（理由同 ContextMenuHost 那条 dataset）。
   * 再加上一条窗口状态（最大化 / 全屏）：自绘标题栏要知道什么时候显示「还原」图标，而
   * 「窗口四周那圈阴影」也要知道 —— 最大化 / 全屏时不留边距、不画阴影（见 base.css 的 #root）。
   * 它同样写成 dataset，两个消费者都只是「换一层样式」。
   *
   * ★★ 这一段**刻意不放进下面那个带一次性守卫的 effect**里，这坑已经踩过：
   *   严格模式（dev）会「挂上 → 卸下 → 再挂上」，而守卫让第二次挂载直接 return ——
   *   于是第一次挂上、又被那次卸下拆掉的订阅**再也装不回来**：迷你窗从此收不到任何状态
   *   （表现是它一直停在「未在播放」，底栏那颗按钮也不会变成按下态），dev 里 100% 复现。
   *   同样的写法在 MiniApp.tsx 里已经踩过一次（见那里的注释），这里是同一个理由。
   * ★ 重装是安全的：installMiniHost 自己会在装上时问一句「迷你窗现在开着没有」，
   *   所以 HMR 重新挂载、渲染层刷新之后推送能自己接上（见 IPC.miniIsOpen）。
   */
  useEffect(() => {
    const disposeHost = installMiniHost()
    /*
     * 本地文件的收件线（installLocalFileIntake）：它在这里装上，与上面那条同一个位置与
     * 同一个理由 —— 双击一个音频文件启动时，主进程**在页面还没加载完**就把文件排好队了，
     * 而这条线一装上就会去取一次（见 state/useLocalFiles）。放进下面那个带一次性守卫的
     * 启动编排里就会漏掉「dev 里 HMR 重新挂载」那一轮 —— 取走是幂等的，重装无害。
     */
    const disposeLocalFiles = installLocalFileIntake()
    /*
     * 投送状态（主进程轮询设备得到的那一份）。与上面两条同一处装：它也要能接上
     * 「dev 里 HMR 重新挂载」那一轮 —— 主进程里的投送会话是常驻的，
     * 重新挂载后不重新订阅的话，底栏会以为没在投送（设备其实还在放）。
     */
    const disposeCast = subscribeCastState()
    const disposeOpen = window.songloft.mini.onOpen((open) => useUi.getState().setMiniOpen(open))
    const disposeState = window.songloft.on.windowState((state) => {
      const root = document.documentElement
      root.toggleAttribute('data-maximized', state.maximized)
      root.toggleAttribute('data-fullscreen', state.fullscreen)
    })
    return () => {
      disposeHost()
      disposeLocalFiles()
      disposeCast()
      disposeOpen()
      disposeState()
    }
  }, [])

  /* ── 启动编排（一次）───────────────────────────────────────────── */
  useEffect(() => {
    if (started.current) return
    started.current = true

    const disposers: (() => void)[] = []

    void (async () => {
      // 先读设置：主题/强调色要在第一帧就正确，否则会闪一下默认配色
      await useSettings.getState().load()
      // ★ 侧栏折叠状态的「写」在 Sidebar 里（切一次就 patch 进设置），但界面初值是
      //   useUi 自己的 state、硬编码 false。不在这里回填的话，那个设置等于写了个寂寞：
      //   用户收起侧栏 → 重启 → 又展开了。
      useUi.getState().setSidebarCollapsed(useSettings.getState().settings.sidebarCollapsed)
      watchSystemTheme()
      primeAudio()

      if (!bootstrapped) {
        bootstrapped = true
        disposers.push(installMediaSessionHandlers())
        disposers.push(installNowPlayingSync())
        /*
         * 起播时补齐缺失的元数据（封面 / 歌词 / 歌手 / 歌名）。
         * 与上面两条同一类「只该发生一次」的接线：它是一条模块级订阅，多装一次只是白占一份
         * 监听（每次播放状态变化都会被叫起来，靠内部的缓存与缺口判定收敛开销，见 song-metadata）。
         */
        disposers.push(installMetadataWatch())
      }

      await useAuth.getState().bootstrap()
      if (useAuth.getState().status === 'authenticated') {
        void usePlaylists.getState().load()
        void usePlaylists.getState().loadFavorites()
        void usePlayer.getState().restoreLastQueue()
        /*
         * 接回后端可能还开着的投送会话（渲染层刷新 / 重开窗口都会走到这里）：
         * 会话在后端是常驻的，设备这会儿可能还在放 —— 不接回来界面就会以为没在投送。
         * 拿不到（没投送 / 后端旧版本）时它自己安静退出，不打扰任何人。
         */
        void useDlna.getState().sync()
        // 查不到、没新版本都不出声（见函数注释）
        void checkUpdatesInBackground().catch(() => undefined)
      } else {
        /*
         * 没有会话 —— 免登录是默认形态（见 useAuth.guest），落在「本地文件」那一页：
         * 侧栏这时只剩「曲库（本地）」与「连接服务器」，而它是唯一真有内容的去处
         * （首页 / 歌单 / 收藏 / 搜索都要会话，读起来就是一片错误）。
         *
         * ★ 用 setNativeRoute 而不是 navigate：这不是「用户走了一步」。进了历史的话，
         *   Alt+← 会退回到默认那一页（首页），而那一页在没有会话时读不了任何数据
         *   （`requireClient()` 是同步抛的，见 hooks/useAsync）。
         * ★ 已经带着本地文件启动的那一趟（双击音频文件）不归这里管：文件的播放由
         *   state/useLocalFiles 自己接（它只负责放出声，落点仍是这里定的这一页）。
         */
        useUi.getState().setNativeRoute({ name: 'local' })
      }

      /*
       * 编排到此为止，主界面 / 登录页可以挂了（见 booted 的说明）。
       * ★ 这一步与上面那个落点必须在**同一个同步块**里（中间不能有 await）：晚一步就会先挂出
       *   一帧拿默认路由的主界面。
       */
      setBooted(true)
    })()

    return () => {
      for (const dispose of disposers) dispose()
    }
  }, [])

  /* ── 主进程推送 ─────────────────────────────────────────────────── */
  useEffect(() => {
    /*
     * 媒体命令（托盘菜单 / 全局媒体键）落在这一窗的播放器上。那一份实现在 state/media-commands
     * 里，因为**迷你宿主窗**（本地文件会话）也要装同一份 —— 差别只有「显示歌词」那一条落在
     * 哪儿：这一窗是右侧那只抽屉，那一窗是下方的歌词面板。
     */
    const offMedia = installMediaCommands({
      toggleLyrics: () => useUi.getState().togglePanel('now-playing')
    })
    const offNavigate = window.songloft.on.navigate((path) => {
      const route = routeFromPath(path)
      if (route) useUi.getState().navigate(route)
    })
    return () => {
      offMedia()
      offNavigate()
    }
  }, [])

  /* ── 全局快捷键 ─────────────────────────────────────────────────── */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const mod = event.ctrlKey || event.metaKey
      const ui = useUi.getState()
      const player = usePlayer.getState()

      // 命令面板优先，且在任何输入状态下都能唤起。
      // ★ 免登录模式下不唤起：面板里那几项（搜索曲库、跳去歌单/收藏）全都要会话，
      //   打开它等于把人引到一串「尚未登录」上。
      if (mod && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        if (useAuth.getState().guest) return
        ui.setPaletteOpen(!ui.paletteOpen)
        return
      }

      if (mod && event.key.toLowerCase() === 'f') {
        event.preventDefault()
        document.querySelector<HTMLInputElement>('.toolbar .search-field input')?.focus()
        return
      }

      if (mod && event.key === 'ArrowRight') {
        event.preventDefault()
        void player.next(false)
        return
      }
      if (mod && event.key === 'ArrowLeft') {
        event.preventDefault()
        void player.previous()
        return
      }
      if (event.altKey && event.key === 'ArrowLeft') {
        event.preventDefault()
        ui.back()
        return
      }
      if (mod && event.key.toLowerCase() === 'l') {
        event.preventDefault()
        ui.togglePanel('now-playing')
        return
      }

      if (isTypingTarget(event.target)) return

      /*
        Esc 收起满窗播放。刻意排在输入框那道判断**之后**：命令面板的 Esc 绑在它自己的输入框上
        （那是「关掉面板」），目标在输入框里时这里就该让开，否则一下把面板与满窗一起收掉。
      */
      if (event.key === 'Escape') {
        if (ui.fullPlayer) {
          event.preventDefault()
          ui.setFullPlayer(false)
        }
        return
      }

      if (event.key === ' ' || event.code === 'Space') {
        event.preventDefault()
        void player.toggle()
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        player.setVolume(Math.min(1, player.volume + 0.05))
        return
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        player.setVolume(Math.max(0, player.volume - 0.05))
        return
      }
      if (event.key === 'f' && !mod && !event.altKey) {
        // 单键 f 只在有当前歌曲时生效，避免误触
        const song = player.currentSong()
        if (song) void usePlaylists.getState().toggleFavorite(song)
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  /* ── 认证后预载数据 ─────────────────────────────────────────────── */
  useEffect(() => {
    if (status !== 'authenticated') {
      // 退出登录 / 切服务器都要清干净：留着的话标题栏会继续挂着**上一台服务器**的扩展
      usePlugins.getState().reset()
      /*
       * ★ 免登录模式下**不复位播放相关的界面**：用户正拿这个应用放本地文件，把迷你窗关掉、
       *   把满窗播放收起来，等于「你没连服务器，所以我先把界面收了」。只有真的去登录页
       *   （未认证且不在免登录形态）才做这两下 —— 那时原生面整块要换成登录页。
       *
       *   迷你窗在登录页没有对应界面（那一窗只有一条播放条 + 一块面板），而它显示的播放
       *   状态正是刚被清空的东西 —— 留着就是一个点不动的空条。满窗播放同理：它挂在原生面上。
       *   ★ 进登录页的代价里也含这一条：从「连接服务器」进去、再按返回出来，迷你窗是关着的
       *     那一趟的播放不受影响（音频不挂在界面上，见 state/usePlayer 的 audio）。
       */
      if (!guest) {
        void window.songloft.mini.setOpen(false)
        useUi.getState().setFullPlayer(false)
      }
      return
    }
    void usePlaylists.getState().load()
    void usePlaylists.getState().loadFavorites()
    void usePlayer.getState().restoreLastQueue()
    /*
     * 守望曲库的后台任务（扫描 / 刷新元数据）：进应用时服务端可能正在扫（上一次会话没跑完、
     * 或另一台客户端起的），那种情况下没有任何页面会去问进度 —— 由这里一直跟到它结束，
     * 结束时 useLibrary 会把号 +1，各处的曲库副本随之重取。见 state/useLibrary。
     */
    useLibrary.getState().watchTasks()
    // 拿不到扩展不该弹错：标题栏少几个按钮，总好过开机弹一条红字
    void usePlugins
      .getState()
      .load()
      .catch(() => undefined)
  }, [status, guest])

  /**
   * 这一帧显示哪一层。
   *
   * ★ `booting` 必须单独一档、且排在最前，判据是「会话还没验完（status）**或**启动编排还没
   *   走完（booted）」：那会儿既答不出该给主界面还是登录页，落点也还没定下来（见 booted）。
   *   省掉它的话，有会话的人会先看见半秒免登录的主界面再跳成已登录，而没会话的人会先挂出
   *   一帧默认路由（首页）—— 后者不只是闪一下，首页在没有会话时会直接把树掀掉。
   *   这就是原来那个 `.shell-solo` 启动占位存在的理由。
   * ★ 登录页是**一个目的地**，不是默认落点：没有会话时默认给的是免登录的主界面
   *   （`guest` 默认 true），只有用户自己要去（侧栏「连接服务器」/「切换账号」/ 退出登录）
   *   或者存着的凭据失效（见 useAuth 的 bootstrap）才落到这儿。
   */
  const screen: 'booting' | 'login' | 'main' =
    !booted || status === 'booting'
      ? 'booting'
      : status === 'authenticated'
        ? 'main'
        : guest
          ? 'main'
          : 'login'

  /*
   * 启动中 / 登录页：同样是 frameless 窗口，必须带上标题栏才有拖拽区与窗口控制。
   * 少了它，登录页会变成一个既拖不动也关不掉的窗口（只能 Alt+F4）。
   */
  if (screen !== 'main') {
    return (
      <div className="shell">
        <TitleBar solo />
        <div className="shell-solo">
          {screen === 'booting' ? (
            <div className="solo-splash">
              <IconLoader size={26} />
              <div>正在恢复上次的会话…</div>
            </div>
          ) : (
            <LoginPage />
          )}
        </div>
      </div>
    )
  }

  return <Shell />
}

/* ─────────────────────────── 已登录后的外壳 ─────────────────────────── */

function Shell(): React.JSX.Element {
  // 窄窗口自动收成图标条。只动界面状态，不覆盖用户保存的偏好。
  useResponsiveSidebar()

  const surface = useUi((s) => s.surface)
  const route = useUi((s) => s.nativeRoute)
  const panelOpen = useUi((s) => s.panelOpen)
  const sidebarCollapsed = useUi((s) => s.sidebarCollapsed)
  const fullPlayer = useUi((s) => s.fullPlayer)

  /**
   * 扩展面**第一次**被打开过没有（之后就一直挂着，见下面那段说明）。
   *
   * 为什么要这一道：没人打开过它的时候，挂上它只会在开机时白发几个请求（拉订阅源、
   * 刷新商店 —— 后者还可能要服务端去访问远端源）。所以等第一次真要用它再挂，
   * 从第一次之后就不再卸载了。
   */
  const [extensionsVisited, setExtensionsVisited] = useState(surface === 'extensions')
  useEffect(() => {
    if (surface === 'extensions') setExtensionsVisited(true)
  }, [surface])
  /**
   * 这一帧要不要挂上扩展面。
   *
   * 不能只看 `extensionsVisited`：它在 effect 里才置位，直接用它会让「第一次切过去」的
   * 那一帧**整块内容区是空的**。把当前这一面也算进来，第一次就是当场挂上。
   */
  const mountExtensions = extensionsVisited || surface === 'extensions'

  return (
    <div
      className="shell"
      data-surface={surface}
      /* 满窗播放：标题栏那一层的底色也跟着换（见 components.css 里 .shell[data-fullplayer]） */
      data-fullplayer={fullPlayer ? 'true' : undefined}
    >
      <TitleBar />

      {/*
        标题栏以下是**一个可替换的内容面**，两种形态：
          * native     —— 侧栏 + 工具条 + 主区 + 抽屉 + 播放条；
          * extensions —— 扩展主框架（左扩展侧栏 + 右内容面）。

        ★ 两面**都挂在 DOM 里**，只把不走的那一面藏起来（`.surface[data-hidden]`，用
          visibility 而不是 display —— 见 base.css 那段说明）。这样来回切时每一面都还是
          离开时的样子：原生面的滚动位置与已加载的列表、扩展面在商店的第几页、正在出声的
          那个扩展。反过来（谁走就卸载谁）会把这些全丢掉，而它们正是「记住状态」的全部内容。
          扩展面是**第一次打开之后**才挂上的（`extensionsVisited`），免得没人用它也白跑请求。

        两面各有一套自己的栅格：原生面是「上半 shell-body / 下半播放条」，扩展面整块交给
        框架（它自己再分左右两栏）。所以下面这两块的布局互不相干。
      */}
      <div className="surface surface-native" data-hidden={surface !== 'native'}>
        <div
          className="shell-body"
          data-panel={panelOpen ? 'open' : 'closed'}
          data-sidebar={sidebarCollapsed ? 'collapsed' : 'expanded'}
        >
          <Sidebar />

          <div className="main-column">
            <Toolbar />
            {/*
              主内容区：**所有去过的页面都挂在这里**，走的那一页只是被藏起来
              （见下面 NativePages 的说明）。所以这里没有 key —— 路由变化不再卸载重建。
              （原先那个 key={route.name} 是「换页就重来」：列表与封面每次都被冲掉，
              页面里的筛选、排序、滚动位置也跟着没了。）
            */}
            <div className="main-scroll">
              <NativePages route={route} surface={surface} />
            </div>
          </div>

          <Panel />
        </div>

        <PlayerBar />

        {/*
          满窗播放：盖在原生面**之上**（底栏那颗封面点出来，见 components/FullPlayer.tsx）。
          放在这一面里面而不是挂在 Shell 上：它跟着原生面一起被藏（切去扩展面时不会孤零零
          留在屏幕上），切回来时又原样还在。
        */}
        {fullPlayer ? <FullPlayer /> : null}
      </div>

      {/* 第一次打开过之后就一直挂着（见上面 mountExtensions 的说明） */}
      {mountExtensions ? (
        <div className="surface surface-extensions" data-hidden={surface !== 'extensions'}>
          <ExtensionFrame />
        </div>
      ) : null}

      {/*
        ★ 这里**不再有**迷你播放器：它是另一个窗口里的一棵独立界面树（components/MiniPlayer.tsx
          + MiniApp.tsx），底栏那颗按钮只是开 / 关那个窗（见 PlayerBar 的 mini 按钮）。
          以前那套「把这一整块藏起来、钉住尺寸、让 <html> 带 data-mini」的机制（连同
          --mini-restore-w/h）都随之去掉了：主窗口从此不必为迷你条改尺寸或重排任何东西。
      */}

      <CommandPalette />
      <AddToPlaylistDialog />
      <DlnaDialog />
      <ContextMenuHost />
      <TooltipHost />
      <Toasts />
    </div>
  )
}

function Toolbar(): React.JSX.Element {
  const route = useUi((s) => s.nativeRoute)
  const navigate = useUi((s) => s.navigate)
  const setPaletteOpen = useUi((s) => s.setPaletteOpen)
  /** 免登录：搜索与命令面板都读后端，这时把它们收起来（而不是让人搜出一页「尚未登录」） */
  const guest = useAuth((s) => s.guest)
  const [draft, setDraft] = useState('')

  // 已进入搜索页时，输入框直接跟着路由走（改词即时生效，不用再回车一次）
  const isSearch = route.name === 'search'
  const value = isSearch ? route.keyword : draft

  const submit = (event: React.FormEvent): void => {
    event.preventDefault()
    const keyword = draft.trim()
    if (keyword) navigate({ name: 'search', keyword })
  }

  return (
    <div className="toolbar">
      <form className="search-field" onSubmit={submit}>
        <IconSearch size={16} />
        <input
          value={value}
          disabled={guest}
          placeholder={
            guest
              ? '免登录模式：连接服务器后即可搜索曲库'
              : '搜索歌曲、歌手、专辑（Ctrl+K 打开命令面板）'
          }
          spellCheck={false}
          onChange={(event) => {
            const next = event.target.value
            setDraft(next)
            if (isSearch && next.trim()) navigate({ name: 'search', keyword: next })
          }}
        />
        {value && !guest ? (
          <button
            type="button"
            className="search-clear"
            aria-label="清空搜索"
            onClick={() => {
              setDraft('')
              if (isSearch) navigate({ name: 'library' })
            }}
          >
            <IconClose size={13} />
          </button>
        ) : null}
      </form>

      <div className="grow" />

      {guest ? null : (
        <button type="button" className="btn" data-size="sm" onClick={() => setPaletteOpen(true)}>
          命令面板
          <span className="badge">Ctrl K</span>
        </button>
      )}
    </div>
  )
}

/**
 * 原生面的页面槽名：一条原生路由一个槽。
 *
 * ★ `library` / `folders` / `local` 三条路由虽然落在同一个组件里（见 LibraryPage：
 *   同一页的三种内容），仍然**各占一个槽** —— 一个槽的话，「换一种看法」就是在同一个实例里
 *   换渲染分支，切过去会把「曲库」那一半的筛选条件与模式一并卸掉，而它们正是切回来时要留住
 *   的东西。三个槽各留一份，页头在每份里各画一次（只显示一个，看不出重复）。
 */
type PageSlotName = NativeRoute['name']

/** 槽的顺序（固定即可，只为让 DOM 有个稳定次序） */
const PAGE_SLOTS: readonly PageSlotName[] = [
  'home',
  'library',
  'folders',
  'local',
  'favorites',
  'recent',
  'search',
  'playlists',
  'playlist',
  'settings'
]

/**
 * 原生面的页面槽：**去过的页面都挂着，只藏不走**。
 *
 * ★ 与两面之间用的是同一套办法（见文件头与 base.css 里 `.surface` 那段），理由也一样：
 *   切页时若把离开的那一页卸载掉，它里面的一切就都没了 —— 曲库的筛选条件与排序方式、
 *   歌单页的视图模式（网格/列表）、歌单详情里在歌单内筛的关键词、滚动到哪儿了。
 *   而这些正是用户切回来时期待的「还是我离开时的样子」。
 *
 *   代价是数据的新鲜度不再由「重新挂载」自动保证，改由数据 hook 自己盯：切回来时静默
 *   重取一次，**数据没变就一个字都不改**（见 hooks/usePageActive 与三个数据 hook）。
 *
 * ★ 只藏不卸载的另一个后果是 DOM 里同时存在好几页，所以不活跃的槽带 `data-hidden`：
 *   它让那一页不画、不收事件、不进 tab 序（CSS 里是 visibility: hidden，不是 display: none
 *   —— 后者会让页面失去布局，滚动位置与已加载的列表就不再保证），也让 E2E 那份全局选择器
 *   能把范围收回当前这一页（见 scripts/e2e/drive.mjs 的 `vis()`）。
 *
 * ★ **首次访问才挂**：没人去过的页面不该在开机时就替它发请求（与扩展面的 mountExtensions
 *   同一个理由）。挂上之后就不再卸载，所以「第一次切过去」的那一帧也要算进去
 *   （`name === route.name`），否则会白一帧。
 */
function NativePages({
  route,
  surface
}: {
  route: NativeRoute
  surface: Surface
}): React.JSX.Element {
  /*
   * 每个槽最后停在的那条路由。非活跃槽必须用「自己离开时的那一份」，而不是当前 route
   * —— 后者只有一条、属于活跃槽，而歌单详情 / 文件夹 / 搜索都要靠各自那份参数渲染
   * （共用一份的话，它们会被别人的参数覆盖成另一个歌单、另一个目录）。
   */
  const lastRoutes = useRef<Partial<Record<PageSlotName, NativeRoute>>>({})
  lastRoutes.current[route.name] = route

  const [visited, setVisited] = useState<ReadonlySet<PageSlotName>>(() => new Set([route.name]))
  useEffect(() => {
    setVisited((prev) => (prev.has(route.name) ? prev : new Set(prev).add(route.name)))
  }, [route.name])

  return (
    <>
      {PAGE_SLOTS.filter((name) => name === route.name || visited.has(name)).map((name) => {
        const slotRoute = lastRoutes.current[name]
        if (!slotRoute) return null
        return (
          // 活跃 = 既在原生面上，又正是当前这一页（切去扩展面时，面上的页面一起停摆）
          <PageSlot key={name} active={surface === 'native' && name === route.name}>
            {renderRoute(slotRoute)}
          </PageSlot>
        )
      })}
    </>
  )
}

/** 一个页面槽。active 同时经 context 告诉页面里的数据 hook「你现在看得见吗」 */
function PageSlot({
  active,
  children
}: {
  active: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="page-slot" data-hidden={active ? undefined : 'true'}>
      <PageActiveProvider value={active}>{children}</PageActiveProvider>
    </div>
  )
}

/**
 * 原生面的页面。
 *
 * 扩展那两条路由（`extensions` / `plugin`）**刻意不在这里** —— 它们不走主内容区，而是把
 * 标题栏以下整块换成扩展主框架（见 Shell 里那两块 `.surface`）。所以入参是 `NativeRoute`：
 * 哪天有人把扩展路由塞进来，类型检查会先拦住，而不是渲染出一块空白。
 */
function renderRoute(route: NativeRoute): React.JSX.Element {
  switch (route.name) {
    case 'home':
      return <HomePage />
    /*
     * 「曲库」这一页有三种内容（见 LibraryPage）：服务器的曲库（按标签）/ 服务器的文件夹
     * （按目录）/ 本机磁盘上的文件。页头那颗来源切换只在三种之间跳，所以三条路由都落到它。
     * ★ 免登录模式进来落的是 `local` 那一份 —— 它是唯一不读后端的内容。
     */
    case 'library':
    case 'folders':
    case 'local':
      return <LibraryPage route={route} />
    case 'favorites':
      return <FavoritesPage />
    case 'recent':
      return <RecentPage />
    case 'search':
      return <SearchPage keyword={route.keyword} />
    case 'playlists':
      return <PlaylistsPage />
    case 'playlist':
      return <PlaylistDetailPage playlistId={route.id} />
    case 'settings':
      return <SettingsPage section={route.section} />
    // NativeRoute 在上面已经穷举完了，这一条只是让「将来漏了一条」不会变成白屏
    default:
      return <HomePage />
  }
}
