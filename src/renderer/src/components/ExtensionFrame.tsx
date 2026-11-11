/**
 * 扩展主框架 —— 标题栏以下的那一整块，左右分栏。
 *
 *   ┌ 扩展侧栏（插件管理 + 已安装扩展 + 收起）│ 内容面 ┐
 *   └─────────────────────────────────────────────┴────────┘
 *
 * ★ 它**同时**承载「插件管理 / 插件商店」与「某个扩展的 webview」两种内容，
 *   两者只在右侧那一栏里换。标题栏上的「扩展」入口因此是一个**去处**（一个工作台），
 *   而不是一排并排的页签 —— 装、管、用三件事在同一处，不必来回切界面。
 *
 * ★ 侧栏只有**一条**固定入口（插件管理）：插件商店是它下面的一层 —— 从插件管理页
 *   右上角那颗按钮进去，回来走侧栏里这一条（商店那一栏也亮着它，因为商店属于这一节）。
 *   原先两条并排摆着，等于让人先在「逛」和「管」之间做一次没有必要的选择。
 *
 * ★ PluginSurface **一直挂着**（哪怕当前显示的是插件商店），否则「正在出声的那个扩展」
 *   会在用户点一下「插件管理」时被销毁 —— 声音直接断。PluginSurface 自己的不变量就是
 *   「活着的 = 当前显示的那个 ∪ 正在播放的那些」，框架把它整块卸掉等于把那条不变量作废。
 *   代价是它必须容忍 entryPath 为空（= 没有要看的那一个，只保活），见那个组件的说明。
 *
 * ★ 整块框架也**从不卸载**：切到原生面（Songloft）只是把它藏起来（见 App 的 Shell 与
 *   base.css 里 `.surface[data-hidden]`）。所以「上次在看哪个扩展」不必单独记 ——
 *   `useUi.extensionRoute` 在切走时根本没人动它，切回来就是那一页。
 *
 * 侧栏刻意**复用主导航那一套 class**（.sidebar / .nav-item / .sidebar-playlists /
 * .sidebar-toggle）：折叠时的居中、文字淡出、强调条、滚动区让位这些行为都已经在那边调好了，
 * 这里再写一份必然与那边慢慢漂开 —— 两个侧栏宽度相同、折叠动效相同，本来就是一回事。
 */

import { pluginDisplayName, type JSPlugin } from '@shared/plugin'
import { IconChevronLeft, IconChevronRight, IconMusic, IconSliders } from './Icons'
import { openMenuFromEvent } from './ContextMenu'
import { PluginIcon } from './PluginIcon'
import { PluginSurface } from './PluginSurface'
import { TIP_ATTR } from './Tooltip'
import { ExtensionsPage } from '@/pages/ExtensionsPage'
import { PluginStore } from '@/pages/PluginStore'
import { useDisplayablePlugins, useExtensionRuntime, usePlugins } from '@/state/usePlugins'
import { useSettings } from '@/state/useSettings'
import { useUi, type ExtensionPane } from '@/state/useUi'

export function ExtensionFrame(): React.JSX.Element {
  // 读扩展面的路由：它是这一面自己的记忆，切到原生面去的时候**不动它**，
  // 所以切回来还是这一页（正是「记住上一页」的全部来源）
  const route = useUi((state) => state.extensionRoute)
  // 展开 / 折叠 / 隐藏。★ 隐藏时**整个 <nav> 不渲染**（而不是宽度给 0）：
  // 宽度 0 的话 border-right 那条线还在，看着像一道没用的接缝
  const sidebarState = useSettings((state) => state.settings.extensionSidebarState)

  // 「某个扩展」那一页与「固定入口」那一页共用这个框架，只有右侧内容面不同
  const pluginEntry = route.name === 'plugin' ? route.entryPath : ''
  const pane: ExtensionPane | null = route.name === 'extensions' ? route.pane : null

  return (
    <div className="ext-frame" data-sidebar={sidebarState}>
      {sidebarState === 'hidden' ? null : (
        <ExtensionSidebar
          pane={pane}
          pluginEntry={pluginEntry}
          collapsed={sidebarState === 'collapsed'}
        />
      )}

      <div className="ext-content" data-pane={pluginEntry ? 'plugin' : 'native'}>
        {/* 一直挂着：切到「插件商店」不该把正在出声的扩展一起关掉（见文件头那段说明） */}
        <PluginSurface entryPath={pluginEntry} />

        {pluginEntry ? null : (
          // key 跟着栏走：换一栏时滚动位置归零，否则从商店底部切到管理页会停在半空
          <div className="ext-scroll" key={pane ?? 'plugin'}>
            {pane === 'manage' ? <ExtensionsPage /> : <PluginStore />}
          </div>
        )}
      </div>
    </div>
  )
}

/* ─────────────────────────────── 侧栏 ─────────────────────────────── */

interface ExtensionSidebarProps {
  /** 当前停在固定入口的哪一栏；null = 正在用某个扩展 */
  pane: ExtensionPane | null
  /** 当前显示的扩展（空串 = 没在看扩展） */
  pluginEntry: string
  collapsed: boolean
}

function ExtensionSidebar({
  pane,
  pluginEntry,
  collapsed
}: ExtensionSidebarProps): React.JSX.Element {
  const plugins = useDisplayablePlugins()
  const navigate = useUi((state) => state.navigate)
  const patch = useSettings((state) => state.patch)

  /**
   * 折叠态只剩图标，名字改由全局浮层交代（与主导航同一套）。
   * 展开态文字就摆在那儿，什么都不挂。
   */
  const tip = (label: string): { [TIP_ATTR]?: string } => (collapsed ? { [TIP_ATTR]: label } : {})

  return (
    <nav className="sidebar ext-sidebar" data-collapsed={collapsed} aria-label="扩展导航">
      {/*
        唯一的固定入口。插件商店不再与它并排（见文件头那段）：它是这一节下面的一层，
        所以商店那一栏也亮着这一条 —— 它属于「插件管理」这一节，而不是「什么都没选中」。
      */}
      <div className="nav-group">
        <button
          type="button"
          className="nav-item"
          aria-current={pane !== null ? true : undefined}
          onClick={() => navigate({ name: 'extensions', pane: 'manage' })}
          {...tip('插件管理')}
        >
          <IconSliders size={18} />
          <span className="nav-text">插件管理</span>
        </button>
      </div>

      {/* 这一组没有标题行：原先那行写着「已安装扩展」，只是把分组本身的意思又说了一遍 ——
          上面两条固定入口 + 下面这一列插件名已经交代得很清楚。
          去掉之后列表的顶部留白改由样式给（见 base.css 的 .ext-sidebar .sidebar-playlists），
          否则第一行的胶囊会贴着分组分割线。 */}
      <div className="nav-group">
        <div className="sidebar-playlists">
          {plugins.length === 0 ? (
            <div className="nav-empty">
              还没有装扩展
              <br />
              右上角「插件商店」里能装
            </div>
          ) : null}

          {plugins.map((plugin) => (
            <ExtensionNavItem
              key={plugin.entryPath}
              plugin={plugin}
              collapsed={collapsed}
              active={pluginEntry === plugin.entryPath}
            />
          ))}
        </div>
      </div>

      {/* 收起 / 展开。与主导航那颗同一个做法（压在右下角、不占一行，见 .sidebar-toggle）；
          文字没了，所以提示任何时候都要挂。
          ★ 它只在「展开 ↔ 折叠」之间切：第三档「隐藏」在这颗按钮上做不到 —— 侧栏都藏了，
            按钮自然也跟着没了，所以那一档只留在插件管理页的显式选择器里（也是找回来的路）。 */}
      <button
        type="button"
        className="icon-btn sidebar-toggle"
        aria-label={collapsed ? '展开侧栏' : '收起侧栏'}
        data-tip={collapsed ? '展开侧栏' : '收起侧栏'}
        onClick={() => void patch({ extensionSidebarState: collapsed ? 'expanded' : 'collapsed' })}
      >
        {/* 12px：那颗钮只有 13px 宽（见 .sidebar-toggle），图标再大就顶出去了 */}
        {collapsed ? <IconChevronRight size={12} /> : <IconChevronLeft size={12} />}
      </button>
    </nav>
  )
}

/* ─────────────────────────── 单个扩展的入口 ─────────────────────────── */

interface ExtensionNavItemProps {
  plugin: JSPlugin
  collapsed: boolean
  active: boolean
}

function ExtensionNavItem({ plugin, collapsed, active }: ExtensionNavItemProps): React.JSX.Element {
  const entryPath = plugin.entryPath
  const runtime = useExtensionRuntime(entryPath)
  const toggleMuted = usePlugins((state) => state.toggleMuted)
  const navigate = useUi((state) => state.navigate)
  const name = pluginDisplayName(plugin)

  return (
    <button
      type="button"
      className="nav-item"
      aria-current={active ? true : undefined}
      // 名称被省略号截断时，浮层里还能读到全名
      {...(collapsed ? { [TIP_ATTR]: name } : {})}
      onClick={() => navigate({ name: 'plugin', entryPath })}
      // 右键只放「静音」：这是宿主对扩展唯一能做的干预（见 PluginSurface —— guest 的
      // 音频只能整台静音，做不到按轨道调音量）。
      onContextMenu={(event) =>
        openMenuFromEvent(event, [
          {
            key: 'mute',
            label: runtime.muted ? '取消静音' : '静音',
            onClick: () => toggleMuted(entryPath)
          }
        ])
      }
    >
      {/* 蒙版只盖图标那一小块（图标 18px，蒙版外扩 3px 压在上面） */}
      <span className="ext-nav-icon">
        <PluginIcon plugin={plugin} size={18} />
        {runtime.playing ? (
          <span className="ext-playing" aria-hidden="true">
            <IconMusic size={11} />
          </span>
        ) : null}
      </span>
      <span className="nav-text truncate grow">{name}</span>
    </button>
  )
}
