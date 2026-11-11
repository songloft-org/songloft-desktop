/**
 * 界面路由。
 *
 * 只有十来条路由，用不着引 react-router：一个受 discriminated union 约束的
 * `Route` 比字符串路径更难写错（拼错的 path 在编译期就挂，而不是运行时白屏）。
 *
 * ★ **两面各有各的路由**（`nativeRoute` / `extensionRoute`），不是共用一份。
 *   标题栏以下那一整块有两种形态（见 App 的 Shell）：原生面（侧栏 + 主区 + 抽屉 + 播放条）
 *   与扩展面（扩展主框架）。用户在两面之间来回切时，每一面都该还是他离开时的样子 ——
 *   原生面停在哪个页面、扩展面是在商店还是在某个扩展里。共用一份路由必然二选一：
 *   切过去就等于把另一份覆盖掉，「记住之前的状态」从根上做不到。
 */

import { create } from 'zustand'

export type SettingsSection =
  | 'appearance'
  | 'playback'
  | 'library'
  | 'cache'
  | 'network'
  | 'data'
  | 'account'
  | 'shortcuts'
  | 'about'

/** 标题栏以下那一整块显示哪一面 */
export type Surface = 'native' | 'extensions'

/**
 * 扩展主框架右侧内容面的两种固定内容。
 *
 * ★ 侧栏里只有「插件管理」那一条入口：`store`（插件商店）是它下面的一层 ——
 *   从插件管理页右上角那颗按钮进去。两个 pane 都算「插件管理这一节」，
 *   所以侧栏那条入口在两者下都亮着（见 ExtensionFrame）。
 */
export type ExtensionPane = 'store' | 'manage'

/** 扩展那一面的路由：框架右侧内容面显示什么 */
export type ExtensionRoute =
  | { name: 'extensions'; pane: ExtensionPane }
  /**
   * 「某个扩展」那一页：框架不变，只是右侧内容面换成一个 webview。
   *
   * 与上面那条分开而不是合成一条 `{name:'extensions', view: …}`：两者的侧边栏高亮与
   * 语义都不一样，合成一条会让那一堆判断挤在同一个 switch 里。
   */
  | { name: 'plugin'; entryPath: string }

/** 原生那一面（侧栏 + 工具条 + 主区 + 抽屉 + 播放条）的路由 */
export type NativeRoute =
  | { name: 'home' }
  | { name: 'library' }
  /**
   * 本地文件（双击打开 / 菜单挑的那些）。
   *
   * ★ 它是**唯一一页不需要登录**的内容页：曲库、歌单、收藏、搜索都得有会话，而这一页读的是
   *   本机磁盘上的文件（见 state/useLocalFiles）。免登录模式进来就落在这里。
   */
  | { name: 'local' }
  | { name: 'favorites' }
  | { name: 'recent' }
  | { name: 'search'; keyword: string }
  | { name: 'playlists' }
  | { name: 'playlist'; id: number }
  | { name: 'folders'; path: string }
  | { name: 'settings'; section: SettingsSection }

/** 跳转目标的并集：写进哪一份由它的 `name` 决定（见 navigate） */
export type Route = NativeRoute | ExtensionRoute

/** 这个目标属于扩展那一面吗（navigate 靠它决定写哪份路由、切哪一面） */
export function isExtensionRoute(route: Route): route is ExtensionRoute {
  return route.name === 'extensions' || route.name === 'plugin'
}

export type PanelTab = 'now-playing' | 'queue'

interface UiState {
  surface: Surface
  /** 原生那一面停在哪儿。切去扩展面时**不动它** —— 切回来就是离开时的样子 */
  nativeRoute: NativeRoute
  /** 扩展那一面停在哪儿（含「上次在看哪个扩展」）。同一份理由 */
  extensionRoute: ExtensionRoute
  /** 只记原生面的足迹：Alt+← 是「上一页」，不该退回扩展面里去 */
  history: NativeRoute[]
  /** 右侧抽屉是否展开 */
  panelOpen: boolean
  panelTab: PanelTab
  sidebarCollapsed: boolean
  /**
   * 侧栏是被「窗口太窄」自动收起的（见 hooks/useResponsiveSidebar.ts）。
   *
   * 刻意与用户偏好分开存：窗口重新变宽时只该回滚**自动收的那一次**，
   * 而不能把用户手动收起的选择也一起改掉。
   */
  sidebarAutoCollapsed: boolean
  paletteOpen: boolean
  /**
   * 迷你窗开着没有。
   *
   * ★ 它只是**主进程那一份的回声**（那个窗口是主进程开的，见 main/mini-window.ts），
   *   渲染层没有任何渠道能自己知道 —— 由 App 里一条模块级订阅从主进程推来。
   *   底栏那颗按钮靠它决定高亮，别处不依赖它。
   * ★ 相关的那些状态都不在这儿：面板开合与高度、是否置顶、两个窗口各自的浓度，
   *   全在迷你窗自己那棵树里（state/useMiniView）或设置里。这个 store 管的是**主窗口**的
   *   界面路由，迷你窗只是「另一个窗口开着没有」这一件事。
   */
  miniOpen: boolean
  /**
   * 满窗播放：底栏那颗封面点出来的那一层（大封面 + 歌词 + 控制条，见 components/FullPlayer.tsx）。
   *
   * ★ 刻意**不是** `surface` 的第三种形态。surface 管的是「原生 / 扩展」两个工作台，
   *   而它只是原生面上的一个浮层 —— 于是进迷你、切去扩展面时它跟着一起被藏起来
   *   （不会孤零零地留在屏幕上），切回来时又原样还在。
   * ★ 它也不进 nativeRoute：路由是「去哪一页」，这个是「换个看播放器的姿势」，
   *   混进历史会让 Alt+← 退回到「收起满窗播放」这种莫名其妙的中间态。
   */
  fullPlayer: boolean
  /** 「加入歌单」对话框的待加入歌曲 id；null = 对话框关闭 */
  addToPlaylistTarget: number[] | null
  /** 播放队列多选的下标集合 */
  selection: number[]
  /** 播放列表选中态锚点（Shift 连选用） */
  selectionAnchor: number | null

  navigate: (route: Route) => void
  /**
   * 直接把原生面钉在某一页上，**不进历史、不切面**。
   *
   * ★ 只给「启动时决定默认落点」用（见 App 的启动编排：没会话就落在「本地文件」那一页）。
   *   那不是用户走的一步 —— 走 navigate 的话，Alt+← 会退回到默认那一页（首页），
   *   而那一页在没有会话时读不了任何数据（`requireClient()` 同步抛，见 hooks/useAsync）。
   */
  setNativeRoute: (route: NativeRoute) => void
  /**
   * 只换面，两份路由都不动。
   *
   * 标题栏那两个入口的主点击用它（Songloft / 扩展）——「回到那一面」而不是「回到某一页」，
   * 所以那里必须是这一条而不是 `navigate`。
   */
  showSurface: (surface: Surface) => void
  back: () => void
  setPanelOpen: (open: boolean) => void
  togglePanel: (tab?: PanelTab) => void
  setPanelTab: (tab: PanelTab) => void
  /** 用户偏好（启动回填 / 手动切换），会一并清掉「自动收起」标记 */
  setSidebarCollapsed: (collapsed: boolean) => void
  toggleSidebar: () => void
  /** 由布局自动收起 / 展开：只动界面状态，不写设置 */
  setSidebarAutoCollapsed: (collapsed: boolean) => void
  setPaletteOpen: (open: boolean) => void
  /** 进 / 出满窗播放。只有这一条（没有 toggle）——「点封面就是进去」不该被一个开关语义盖住 */
  setFullPlayer: (open: boolean) => void
  /** 只由主进程那条推送调用（见 miniOpen 的说明），界面自己不设它 */
  setMiniOpen: (open: boolean) => void
  setAddToPlaylistTarget: (songIds: number[] | null) => void
  setSelection: (selection: number[], anchor?: number | null) => void
  clearSelection: () => void
}

const MAX_HISTORY = 40

const sameRoute = (a: Route, b: Route): boolean => JSON.stringify(a) === JSON.stringify(b)

export const useUi = create<UiState>((set, get) => ({
  surface: 'native',
  nativeRoute: { name: 'home' },
  // 初始落在插件管理：商店是它下面的一层，进框架先看到的是「装了什么、怎么管」
  extensionRoute: { name: 'extensions', pane: 'manage' },
  history: [],
  panelOpen: false,
  panelTab: 'now-playing',
  sidebarCollapsed: false,
  sidebarAutoCollapsed: false,
  paletteOpen: false,
  miniOpen: false,
  fullPlayer: false,
  addToPlaylistTarget: null,
  selection: [],
  selectionAnchor: null,

  navigate: (route) => {
    const state = get()

    if (isExtensionRoute(route)) {
      // 同一条路由重复点（比如连点侧栏的「插件管理」）不该白跑一趟
      if (state.surface === 'extensions' && sameRoute(state.extensionRoute, route)) return
      set({ surface: 'extensions', extensionRoute: route, selection: [], selectionAnchor: null })
      return
    }

    const unchanged = sameRoute(state.nativeRoute, route)
    if (state.surface === 'native' && unchanged) return
    set({
      surface: 'native',
      nativeRoute: route,
      /**
       * 从扩展面点回原生页**不算新的一步**：Alt+← 该退回「原生面自己的上一页」，
       * 而不是被来回切换的两面塞满历史。
       */
      history:
        state.surface === 'native' && !unchanged
          ? [state.nativeRoute, ...state.history].slice(0, MAX_HISTORY)
          : state.history,
      selection: [],
      selectionAnchor: null
    })
  },

  // 启动时的默认落点（见接口上的说明）：只改路由，不动面、不记历史
  setNativeRoute: (nativeRoute) => set({ nativeRoute }),

  // 只换脸。这就是「切回来还是离开时的样子」的全部实现 —— 没有别的机关
  showSurface: (surface) => {
    if (get().surface === surface) return
    set({ surface })
  },

  back: () => {
    const [prev, ...rest] = get().history
    if (!prev) return
    // 后退只发生在原生面内部，所以顺带切回原生面
    set({
      surface: 'native',
      nativeRoute: prev,
      history: rest,
      selection: [],
      selectionAnchor: null
    })
  },

  setPanelOpen: (open) => set({ panelOpen: open }),

  togglePanel: (tab) =>
    set((state) => {
      if (tab && state.panelOpen && state.panelTab === tab) return { panelOpen: false }
      return { panelOpen: true, panelTab: tab ?? state.panelTab }
    }),

  setPanelTab: (tab) => set({ panelTab: tab, panelOpen: true }),
  setSidebarCollapsed: (collapsed) =>
    set({ sidebarCollapsed: collapsed, sidebarAutoCollapsed: false }),
  toggleSidebar: () =>
    set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed, sidebarAutoCollapsed: false })),
  setSidebarAutoCollapsed: (collapsed) =>
    set({ sidebarCollapsed: collapsed, sidebarAutoCollapsed: collapsed }),
  setPaletteOpen: (open) => set({ paletteOpen: open }),
  setFullPlayer: (open) => set({ fullPlayer: open }),
  setMiniOpen: (miniOpen) => set({ miniOpen }),
  setAddToPlaylistTarget: (songIds) => set({ addToPlaylistTarget: songIds }),
  setSelection: (selection, anchor) =>
    set({ selection, selectionAnchor: anchor === undefined ? null : anchor }),
  clearSelection: () => set({ selection: [], selectionAnchor: null })
}))

/** 把主进程菜单发来的路径字符串映射为 Route（只会是原生面那几条） */
export function routeFromPath(path: string): NativeRoute | null {
  if (path === '/settings' || path.startsWith('/settings/')) {
    const section = path.split('/')[2]
    return {
      name: 'settings',
      section: (
        [
          'appearance',
          'playback',
          'library',
          'cache',
          'network',
          'data',
          'account',
          'shortcuts',
          'about'
        ] as const
      ).includes(section as never)
        ? (section as SettingsSection)
        : 'appearance'
    }
  }
  if (path === '/home') return { name: 'home' }
  if (path === '/library') return { name: 'library' }
  return null
}
