/**
 * 自绘标题栏。
 *
 * 窗口是 frame: false 的，所以窗口控制要自己画。三条容易做错的：
 *   1. 拖动区必须 `-webkit-app-region: drag`，且**交互控件要显式 no-drag**，
 *      否则按钮点不动（点在 drag 区域上的事件会被拿去拖窗口）；
 *   2. 双击标题栏要能最大化/还原，这是桌面系统的肌肉记忆；
 *   3. 最大化状态要从主进程推过来，不能靠本地猜（用户用键盘快捷键也可能改）。
 *
 * ★ 未登录（solo）时也要渲染这个组件：窗口是 frameless 的，全部拖拽能力都来自
 *   `.titlebar` 的 -webkit-app-region —— 登录页若不带标题栏，那个窗口就既拖不动、
 *   也关不掉（只能靠 Alt+F4）。所以 App 在任何状态下都把标题栏放在最外层，
 *   这里只是把「两个下拉 / 搜索」这类需要已登录的元素藏起来。
 *
 * 布局：`[Songloft ▾][🧩 扩展 ▾] ⟪拖拽区⟫ [搜索][窗口控制]`。
 * 左起是两处**去处**，各自是一颗**拆分按钮**（左半执行主操作、右半那颗小三角开下拉）：
 *   * Songloft —— 左半回到原生面（**停在离开时那一页**，不是回首页；回首页请看右半那份菜单），
 *                 右半是原来的「折叠菜单」（导航项，去掉扩展）；
 *   * 扩展     —— 左半回到扩展面（上次在商店就在商店、上次在某个扩展里就还是它），
 *                 右半列出所有已开启的扩展（每项挂着对它的操作）。
 * 两半都是 `showSurface` 而不是 `navigate`：只换面、不动两份路由 —— 这正是「切回原处」。
 * 为什么拆成两颗而不是留一颗「折叠菜单」：菜单里原来那两项（扩展 / 设置）本来就不是一类 ——
 * 前者是**一整个工作台**（装了还得管），后者是去改配置；把它们并排放在标题栏上，
 * 「去哪儿」就不必先展开一层菜单了。
 *
 * 中间刻意不显示当前曲目 —— 曲目信息本来在播放条与右侧抽屉里各有一份。
 */

import { useEffect, useRef, useState } from 'react'

import { pluginDisplayName } from '@shared/plugin'
import {
  IconChevronDown,
  IconClock,
  IconClose,
  IconHeart,
  IconHome,
  IconLibrary,
  IconListMusic,
  IconMaximize,
  IconMinimize,
  IconPin,
  IconPuzzle,
  IconRestore,
  IconSearch,
  IconSettings,
  IconSliders
} from './Icons'
import { openMenuFromEvent, useContextMenu, type MenuItem } from './ContextMenu'
import { PluginIcon } from './PluginIcon'
import { Cover } from './primitives'
import { useAuth } from '@/state/useAuth'
import { useSettings } from '@/state/useSettings'
import { useUi } from '@/state/useUi'
import { regularPlaylists, usePlaylists } from '@/state/usePlaylists'
import { useDisplayablePlugins, usePlugins } from '@/state/usePlugins'

export interface TitleBarProps {
  /** 未登录/启动中：只保留窗口控制，去掉需要登录态的元素 */
  solo?: boolean
}

export function TitleBar({ solo = false }: TitleBarProps): React.JSX.Element {
  const [state, setState] = useState({ maximized: false, fullscreen: false, focused: true })
  const setPaletteOpen = useUi((s) => s.setPaletteOpen)
  const navigate = useUi((s) => s.navigate)
  const showSurface = useUi((s) => s.showSurface)
  const surface = useUi((s) => s.surface)
  /** 普通窗口那份置顶设置（与迷你窗口那份分开存，见 AppSettings 的说明） */
  const alwaysOnTop = useSettings((s) => s.settings.alwaysOnTop)
  /** 整窗不透明度（0–100）：菜单里那根滑块的初值，也是「窗口菜单」里唯一能就地调的量 */
  const windowOpacity = useSettings((s) => s.settings.windowOpacity)
  const patchSettings = useSettings((s) => s.patch)
  const playlists = usePlaylists((s) => s.playlists)
  // 与侧栏「我的歌单」用同一个过滤器，两处名单不会各自漂移
  const myPlaylists = regularPlaylists(playlists)
  // 扩展下拉与扩展侧栏同源：两处列出来的扩展因此永远是同一批
  const extensions = useDisplayablePlugins()
  /**
   * 免登录模式：搜索与扩展这两处入口都要收起来。
   *
   * 两者都要会话：命令面板里那几项问的是曲库，扩展那一面（商店 / 管理 / 某个扩展页）全都要后端
   * 报数据。留着它们，点进去只会得到一片「尚未登录」—— 而这两颗钮旁边没有任何文字说得出这一点。
   */
  const guest = useAuth((s) => s.guest)
  // 只为在标签后面缀一句「播放中」：菜单项的文字是字符串，没有别的地方能挂这个状态
  const runtime = usePlugins((s) => s.runtime)

  /**
   * 两颗下拉各自的触发器。
   *
   * aria-expanded 要答的是「**我这份**菜单开着吗」，不是「有没有菜单开着」——
   * 只看 `open` 的话，打开 Songloft 那颗菜单会让扩展那颗也报 expanded。
   */
  const songloftMenuRef = useRef<HTMLButtonElement>(null)
  const extensionMenuRef = useRef<HTMLButtonElement>(null)
  const songloftOpen = useContextMenu((s) => s.open && s.anchor === songloftMenuRef.current)
  const extensionOpen = useContextMenu((s) => s.open && s.anchor === extensionMenuRef.current)

  // 「扩展」入口据此高亮。看的是**面**而不是路由：插件商店 / 插件管理 / 某个扩展三者
  // 都落在扩展面上，而它们各自的最后位置由那一面自己的路由记着
  const inExtensions = surface === 'extensions'

  useEffect(() => {
    void window.songloft.window.getState().then(setState)
    return window.songloft.on.windowState(setState)
  }, [])

  /**
   * 双击标题栏空白处 = 最大化/还原。
   *
   * 为什么要在 JS 里补一手：拖拽区（`-webkit-app-region: drag`）在 Windows 上会被
   * 当成非客户区交给系统处理，事件根本送不到页面；Linux 上则不会自动最大化。两边都
   * 给同一个入口才有一致行为 —— 系统处理过的事件不会冒到这里，所以不会重复切换。
   *
   * 落在窗口按钮上的双击要排除：那些按钮是 no-drag 区，本来就能收到事件，
   * 「双击最小化按钮」不该顺带把窗口最大化。
   */
  const handleDoubleClick = (event: React.MouseEvent<HTMLElement>): void => {
    if ((event.target as HTMLElement).closest('button')) return
    void window.songloft.window.toggleMaximize()
  }

  /**
   * 打开某一颗下拉。
   *
   * 复用 ContextMenuHost 而不是自己造一个下拉：宿主已经处理了贴边翻转、Esc、失焦关闭、
   * 「点同一个按钮 = 收起」，再造一份就是两份要同步维护的行为。代价是必须把触发器元素
   * 一起传进去 —— 见 ContextMenu.tsx 里 anchor 的说明（不传的话「再点一次收起」做不出来）。
   *
   * 面板左缘贴那颗**小三角**的左缘：它是这一组里最右的东西，面板往右铺开正好盖在按钮
   * 下方，不会自己压到自己头上（贴整颗胶囊的左缘就会这样）。
   */
  const openDropdown = (event: React.MouseEvent<HTMLButtonElement>, items: MenuItem[]): void => {
    const menu = useContextMenu.getState()
    // 宿主对「点触发器」刻意不关（anchor），所以这里读到的仍是开着 → 收起
    if (menu.open) {
      menu.hide()
      return
    }
    const rect = event.currentTarget.getBoundingClientRect()
    menu.show(rect.left, rect.bottom + 6, items, {
      anchor: event.currentTarget,
      align: 'left',
      anchorRect: rect
    })
  }

  /**
   * Songloft 下拉的菜单项：按「浏览 → 收藏与历史 → 设置」排，只放「去哪儿」不放管理动作。
   * 「文件夹」不单列 —— 它是曲库页里的一个标签；「扩展」也不在这里 —— 它有自己那颗按钮与下拉。
   */
  const navMenuItems = (): MenuItem[] => {
    /*
     * 免登录模式（见 useAuth）：这份菜单只留「曲库 + 设置」。
     * 其余每一项点下去都是一页「尚未登录」（它们全都要会话），摆着不如不摆 —— 与侧栏同一口径。
     * 「曲库」落在**本地**那一半（读本机磁盘、不要会话，见 pages/LibraryPage），
     * 名字跟着侧栏走而不叫「本地文件」：落到的那一页大标题就是「曲库」。
     * ★ 设置落在**外观**那一节、与已登录那份菜单同一个默认：免登录时设置里只有本机内容
     *   （服务端那几节整节收掉，带「服务端」徽标的行逐行抽掉，见 SettingsPage），所以不能再
     *   指向「账号」——回服务器走侧栏那颗「连接服务器」。
     */
    if (guest) {
      return [
        {
          key: 'local',
          label: '曲库',
          icon: <IconLibrary size={16} />,
          onClick: () => navigate({ name: 'local' })
        },
        { key: 'sep-manage', label: '', separator: true },
        {
          key: 'settings',
          label: '设置',
          icon: <IconSettings size={16} />,
          onClick: () => navigate({ name: 'settings', section: 'appearance' })
        }
      ]
    }

    return [
      {
        key: 'home',
        label: '首页',
        icon: <IconHome size={16} />,
        onClick: () => navigate({ name: 'home' })
      },
      {
        key: 'library',
        label: '曲库',
        icon: <IconLibrary size={16} />,
        onClick: () => navigate({ name: 'library' })
      },

      {
        key: 'playlists',
        label: '歌单',
        icon: <IconListMusic size={16} />,
        /**
         * 「双面」项：悬浮列出歌单名单（跳到某个歌单的捷径），单击进歌单列表页 ——
         * 想直奔某个歌单还是想先看总览，两种意图都不必再绕一步。
         * 名单为空时给一条不可点的说明，而不是弹一个空框 —— 空框会让人以为是坏了。
         */
        onClick: () => navigate({ name: 'playlists' }),
        children: myPlaylists.length
          ? myPlaylists.map((playlist) => ({
              key: `playlist-${playlist.id}`,
              label: playlist.name,
              icon: (
                <Cover
                  coverUrl={playlist.cover_url}
                  width={48}
                  size={20}
                  radius={4}
                  kind="playlist"
                />
              ),
              onClick: () => navigate({ name: 'playlist', id: playlist.id })
            }))
          : [{ key: 'playlists-empty', label: '还没有歌单', disabled: true }]
      },
      {
        key: 'favorites',
        label: '我喜欢',
        icon: <IconHeart size={16} />,
        onClick: () => navigate({ name: 'favorites' })
      },
      {
        key: 'recent',
        label: '最近播放',
        icon: <IconClock size={16} />,
        onClick: () => navigate({ name: 'recent' })
      },
      // 设置与上面那串「去哪儿」不是一类：分割线把这一段单独划出来
      { key: 'sep-manage', label: '', separator: true },
      {
        key: 'settings',
        label: '设置',
        icon: <IconSettings size={16} />,
        onClick: () => navigate({ name: 'settings', section: 'appearance' })
      }
    ]
  }

  /**
   * 扩展下拉的内容：**插件管理 → 分割线 → 已开启的扩展**。
   *
   * * 「插件商店」不在这份菜单里（也没有自己的侧栏入口）：它是插件管理页下面的一层，
   *   入口就是那一页右上角那颗按钮。菜单只留**最常去的那个去处**，其余沿着页面里的路走。
   * * 已开启的扩展**不带二级菜单**：这一份菜单的用途是**快速跳转**，再挂一层
   *   「静音 / 停用 / 卸载」等于把管理动作藏进悬浮里。要管扩展请走「插件管理」那一栏 ——
   *   那儿有整行位置摆开关与按钮；「静音」也仍在扩展侧栏的右键菜单里。
   * * 用 useDisplayablePlugins 而不是「plugins 里 enabled 为真那些」：只有后端报 active
   *   的才真点得进去，把运行异常的也列出来只会让人点出一片空白。与扩展侧栏同一份过滤。
   * * 菜单项在**渲染期**算好（不是一个被调用的函数）：每一项要读「正在出声」这份运行时
   *   状态，而 hook 不能在事件回调里调用。
   * * 空列表给一条不可点的说明：空框会让人以为是坏了（与「歌单」那一项同一个做法）。
   */
  const extensionMenuItems: MenuItem[] = [
    {
      key: 'extensions-manage',
      label: '插件管理',
      icon: <IconSliders size={16} />,
      onClick: () => navigate({ name: 'extensions', pane: 'manage' })
    },
    // 固定入口与「已开启的扩展」不是一类：分割线把它们划开
    { key: 'sep-extensions', label: '', separator: true },
    ...(extensions.length
      ? extensions.map((plugin) => {
          const live = runtime[plugin.entryPath]
          const name = pluginDisplayName(plugin)
          return {
            key: `extension-${plugin.entryPath}`,
            // 名字后面缀上「播放中」：菜单项的标签只能是字符串，而「哪个在出声」正是
            // 这里唯一能顺带交代的状态（侧栏那边是靠图标上的蒙版）
            label: live?.playing ? `${name} · 播放中` : name,
            icon: <PluginIcon plugin={plugin} size={16} />,
            onClick: () => navigate({ name: 'plugin', entryPath: plugin.entryPath })
          }
        })
      : [{ key: 'extension-empty', label: '还没有开启的扩展', disabled: true }])
  ]

  return (
    <header
      className="titlebar"
      onDoubleClick={handleDoubleClick}
      /*
       * 右键标题栏 = 它的「窗口菜单」。这里只放**窗口级**的开关，与标题栏上那排按钮不重复：
       * 置顶（普通窗口那份，与迷你窗口那份各存各的，见 shared/ipc 的 AppSettings），
       * 外加一根**不透明度滑块** —— 整窗浓度是那种「要一边拖一边看」的量，就地调比
       * 「去设置页 → 找到「窗口透明度」那一栏 → 再拖」少绕一大圈。
       * 拖拽区里右键仍然能收到 contextmenu（左键才被拿去拖窗口），与按钮的 no-drag 无关。
       */
      onContextMenu={(event) =>
        openMenuFromEvent(event, [
          {
            key: 'always-on-top',
            label: alwaysOnTop ? '取消窗口置顶' : '窗口置顶',
            icon: <IconPin size={15} />,
            onClick: () => void patchSettings({ alwaysOnTop: !alwaysOnTop })
          },
          // 开关与「连续量」不是一类：分割线划开（与导航菜单里那条同样的用法）
          { key: 'sep-window-menu', label: '', separator: true },
          {
            key: 'window-opacity',
            // 与设置页那一栏同一个量（windowOpacity），只是换了个更近的地方调
            label: '窗口不透明度',
            slider: {
              min: 0,
              max: 100,
              value: windowOpacity,
              onChange: (value) => void patchSettings({ windowOpacity: value })
            }
          }
        ])
      }
    >
      <div className="titlebar-brand">
        {/* 拆分按钮：左半回播放页，右半开导航菜单。
            它落在拖拽区里，靠 base.css 的 `.titlebar button { -webkit-app-region: no-drag }`
            才点得动。 */}
        <div className="titlebar-split" data-open={songloftOpen ? 'true' : undefined}>
          {/* 左半是「回到 Songloft 那一面」而不是「回首页」：那一面停在哪儿就回哪儿，
              否则从扩展面点回来会把用户正在看的那一页冲掉（回首页请走右边那份菜单） */}
          <button
            type="button"
            className="titlebar-home"
            data-tip="回到上次的页面"
            aria-label="回到上次的页面"
            onClick={() => showSurface('native')}
          >
            <img
              src="./icon.png"
              alt=""
              onError={(e) => (e.currentTarget.style.display = 'none')}
            />
            <span className="truncate">Songloft</span>
          </button>

          {!solo ? (
            <button
              ref={songloftMenuRef}
              type="button"
              className="titlebar-split-caret"
              data-tip="导航菜单"
              aria-label="导航菜单"
              aria-haspopup="menu"
              aria-expanded={songloftOpen}
              onClick={(event) => openDropdown(event, navMenuItems())}
            >
              <IconChevronDown size={12} />
            </button>
          ) : null}
        </div>
      </div>

      {!solo && !guest ? (
        /**
         * 扩展入口。同样是一颗拆分按钮：左半进扩展主框架（落上次那一栏），右半列出
         * 已开启的扩展。
         *
         * 图标复用 IconPuzzle：拼图就是「扩展」这个概念的通用图形，插件管理的标题
         * 那一项也是它 —— 同一个去处给同一种记号，比再造一个语义重复的图形好。
         */
        <div
          className="titlebar-split"
          data-active={inExtensions ? 'true' : undefined}
          data-open={extensionOpen ? 'true' : undefined}
        >
          {/* 左半同理：回到扩展那一面（上次在商店就在商店、上次在某个扩展里就还是它） */}
          <button
            type="button"
            className="titlebar-entry"
            aria-label="扩展"
            aria-current={inExtensions ? 'page' : undefined}
            onClick={() => showSurface('extensions')}
          >
            <IconPuzzle size={16} />
            <span className="titlebar-entry-text">扩展</span>
          </button>

          <button
            ref={extensionMenuRef}
            type="button"
            className="titlebar-split-caret"
            data-tip="已开启的扩展"
            aria-label="已开启的扩展"
            aria-haspopup="menu"
            aria-expanded={extensionOpen}
            onClick={(event) => openDropdown(event, extensionMenuItems)}
          >
            <IconChevronDown size={12} />
          </button>
        </div>
      ) : null}

      {/* 右端固定在右缘：左侧那几项都是 flex:none，中间空出来的就是拖拽区 */}
      <div className="titlebar-actions">
        {!solo && !guest ? (
          <button
            type="button"
            className="win-btn"
            data-tip="搜索与命令（Ctrl+K）"
            aria-label="打开命令面板"
            onClick={() => setPaletteOpen(true)}
          >
            <IconSearch size={15} />
          </button>
        ) : null}
        <button
          type="button"
          className="win-btn"
          data-tip="最小化"
          aria-label="最小化"
          onClick={() => void window.songloft.window.minimize()}
        >
          <IconMinimize size={15} />
        </button>
        <button
          type="button"
          className="win-btn"
          data-tip={state.maximized ? '还原' : '最大化'}
          aria-label={state.maximized ? '还原' : '最大化'}
          onClick={() => void window.songloft.window.toggleMaximize()}
        >
          {state.maximized ? <IconRestore size={15} /> : <IconMaximize size={14} />}
        </button>
        <button
          type="button"
          className="win-btn"
          data-variant="close"
          data-tip="关闭"
          aria-label="关闭"
          onClick={() => void window.songloft.window.close()}
        >
          <IconClose size={15} />
        </button>
      </div>
    </header>
  )
}
