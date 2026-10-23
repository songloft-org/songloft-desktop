/**
 * 设置。
 *
 * 分成「本地偏好」与「服务端设置」两类，并在界面上明确分区 —— 这一区分很重要：
 * 主题/歌词字号是本机的，改了不影响别的设备；音乐目录/扫描策略是服务端的，改了对所有客户端生效。
 * 原 Flutter 端把两类混在同一个长列表里，用户改完不知道到底改了谁。
 */

import { useCallback, useEffect, useId, useRef, useState } from 'react'

import type { AppInfo, ClientUpdateCheck, ServerProbeResult } from '@shared/ipc'
import { REPO_RELEASES_URL, REPO_URL, UPSTREAM_URL } from '@shared/links'
import type {
  AutoScanSetting,
  CacheConfigInput,
  CacheDirCheck,
  DuplicatesResult,
  FailedFingerprint,
  FingerprintProgress,
  MetadataRefreshProgress,
  MetadataRefreshStatus,
  MusicPathSetting,
  PlaylistImportResult,
  PlaylistMode,
  ScanProgress,
  ScanTitleSource,
  ServerUpgradeCheck,
  ServerUpgradeProgress,
  ServerUpdateTarget,
  UploadedServerBinary
} from '@shared/types'
import { isNewerVersion } from '@shared/version'
import { useContextMenu, type MenuItem } from '@/components/ContextMenu'
import { ExcludeDirsEditor } from '@/components/ExcludeDirsEditor'
import {
  IconAlert,
  IconCheck,
  IconChevronDown,
  IconDownload,
  IconEdit,
  IconExternal,
  IconFingerprint,
  IconLoader,
  IconLogout,
  IconMonitor,
  IconMoon,
  IconRefresh,
  IconServer,
  IconSliders,
  IconSparkle,
  IconSun,
  IconTrash,
  IconUpload
} from '@/components/Icons'
import { Modal } from '@/components/Modal'
import { EmptyState, Switch } from '@/components/primitives'
import { SettingSelect, type SelectOption } from '@/components/SettingSelect'
import {
  cancelFingerprintCompute,
  cancelMetadataRefresh,
  cancelScan,
  checkServerUpgrade,
  cleanCache,
  cleanMissingSongs,
  computeFingerprints,
  confirmServerUploadUpgrade,
  deleteSong,
  exportPlaylists,
  exportServerLogs,
  findDuplicates,
  getAutoScan,
  getCacheConfig,
  getCacheStats,
  getFailedFingerprints,
  getFingerprintProgress,
  getFingerprintStatus,
  getGithubProxy,
  getHlsProxyEnabled,
  getHttpProxy,
  getLogLevel,
  getMetadataRefreshProgress,
  getMusicPath,
  getProxyAllowlist,
  getRemoteTitleSource,
  getScanProgress,
  getServerUpgradeProgress,
  getScanAutoCreatePlaylists,
  getScanAutoFingerprint,
  getScanPlaylistMode,
  getScanTitleSource,
  getTagSyncToFile,
  getVolumeNormalize,
  importPlaylists,
  setAutoScan,
  setGithubProxy,
  setHlsProxyEnabled,
  setHttpProxy,
  setLogLevel,
  setProxyAllowlist,
  setRemoteTitleSource,
  setScanAutoCreatePlaylists,
  setScanAutoFingerprint,
  setScanPlaylistMode,
  setScanTitleSource,
  setTagSyncToFile,
  setVolumeNormalize,
  startMetadataRefresh,
  startScan,
  startServerUpgrade,
  updateCacheConfig,
  updateMusicPath,
  uploadServerBinary,
  validateCacheDir,
  type LogLevel
} from '@/api/endpoints'
import { useAsync } from '@/hooks/useAsync'
import {
  formatBytes,
  formatCount,
  formatDate,
  formatRelative,
  formatVersion,
  latencyLevel
} from '@/lib/format'
import { requireClient, useAuth } from '@/state/useAuth'
import { isMetadataRefreshRunning, isScanRunning, useLibrary } from '@/state/useLibrary'
import { usePlayer } from '@/state/usePlayer'
import { currentAccentHex, useSettings } from '@/state/useSettings'
import { useUi, type SettingsSection } from '@/state/useUi'
import { toast } from '@/state/useToasts'

const SECTIONS: { key: SettingsSection; label: string }[] = [
  { key: 'appearance', label: '外观' },
  { key: 'playback', label: '播放与歌词' },
  { key: 'library', label: '曲库与扫描' },
  { key: 'cache', label: '缓存管理' },
  { key: 'network', label: '网络设置' },
  { key: 'data', label: '数据管理' },
  { key: 'account', label: '账号' },
  { key: 'shortcuts', label: '快捷键' },
  { key: 'about', label: '关于与更新' }
]

const ACCENT_PRESETS = ['#7c5cff', '#22a7d6', '#ee5a8a', '#f08a3c', '#3fb27f', '#c9c2b6']

/**
 * 免登录模式（useAuth 的 guest）下**整节**都收掉的分区。
 *
 * ★ 判据是「这一节里还有没有本机内容」，而不是「有没有服务端内容」：
 *   · `library`（曲库与扫描）—— 每一行都是服务端设置（逐行标了 `server`）
 *   · `network`（网络设置）—— 代理那张卡是服务端的；「忽略 SSL 证书校验」虽是本机偏好，
 *     但它管的是**与服务器之间**的连接，没有服务器时无从谈起
 *   · `account`（账号）—— 通篇是「连了哪台服务器、以谁登录」
 *   · `data`（数据管理）—— 目前只有「歌单备份」，导出 / 导入的都是后端那份歌单
 *   收掉整个分区，而不是让人点进去看一页空的 —— 与侧栏、标题栏那份菜单同一口径：
 *   不摆出来，而不是灰掉（见 Sidebar.tsx 里 guest 那一段）。
 * ★ 其余分区留着：里面还有本机内容（外观 / 播放与歌词 / 本机缓存 / 快捷键 / 关于与更新），
 *   由 Row 把带「服务端」徽标的行逐行抽掉，几处**不是**服务端设置、但离不开服务器的
 *   （服务端更新、后端版本、歌词的翻译与罗马音）在各自那里单独收掉。
 */
const HIDDEN_WHEN_GUEST: readonly SettingsSection[] = ['library', 'network', 'account', 'data']

export function SettingsPage({ section }: { section: SettingsSection }): React.JSX.Element {
  const navigate = useUi((s) => s.navigate)
  const guest = useAuth((s) => s.guest)

  const sections = guest
    ? SECTIONS.filter((item) => !HIDDEN_WHEN_GUEST.includes(item.key))
    : SECTIONS

  /**
   * 真正显示哪一节。
   *
   * ★ 免登录时路由可能正停在刚被收掉的那一节上（上一位用户停在「曲库与扫描」、退出登录后
   *   又从免登录进来）：落回第一节，别给人一页没有任何导航项高亮的空白。
   */
  const active = sections.some((item) => item.key === section) ? section : sections[0].key

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">设置</h1>
          <p className="page-subtitle">
            {guest
              ? '免登录模式：这里只列本机设置，连接服务器后才会出现影响所有设备的服务端设置'
              : '带「服务端」标志的项会影响所有连接到同一后端的设备'}
          </p>
        </div>
      </div>

      <div className="settings-layout">
        <nav className="settings-nav" aria-label="设置分区">
          {sections.map((item) => (
            <button
              key={item.key}
              type="button"
              aria-current={active === item.key}
              onClick={() => navigate({ name: 'settings', section: item.key })}
            >
              {item.label}
            </button>
          ))}
        </nav>

        <div>
          {active === 'appearance' ? <AppearanceSettings /> : null}
          {active === 'playback' ? <PlaybackSettings /> : null}
          {active === 'library' ? <LibrarySettings /> : null}
          {active === 'cache' ? (
            <>
              {/* 服务端音乐缓存整卡都是服务端设置，整块不挂 —— 挂上就等于把它的读请求也发出去 */}
              {guest ? null : <ServerCacheSettings />}
              <LocalCacheSettings />
            </>
          ) : null}
          {active === 'network' ? <NetworkSettings /> : null}
          {active === 'data' ? <DataSettings /> : null}
          {active === 'account' ? <AccountSettings /> : null}
          {active === 'shortcuts' ? <ShortcutsSettings /> : null}
          {active === 'about' ? <AboutSettings /> : null}
        </div>
      </div>
    </div>
  )
}

/* ───────────────────────────── 通用行 ───────────────────────────── */

interface RowProps {
  /** ReactNode 而非 string：账号页要在标题后面缀「版本 · 耗时」或红色的「断开链接」 */
  title: React.ReactNode
  desc?: React.ReactNode
  /** 该项是服务端设置（对所有设备生效） */
  server?: boolean
  /** 子选项：从属于上一行，左缩进 + 竖线标出这层关系 */
  nested?: boolean
  /**
   * 正文落到标题下方、占满整行（排除目录编辑器、扫描按钮区这类宽内容）。
   * 这时右侧控件要从 `control` 给 —— `children` 已经被正文占用了。
   */
  block?: boolean
  /** 右侧控件。与 block 搭配时它仍留在标题行右侧（开关/展开按钮属于标题，不属于正文） */
  control?: React.ReactNode
  /**
   * 给了它就整行标题区可点（展开/收起这类）。这时**不要**再在 control 里放按钮：
   * 按钮套在可点区里，一次点击会触发两遍（先冒泡到行上、再执行按钮自己的 onClick）。
   * 右侧改用 `.collapse-hint` 那种纯展示的提示。
   */
  onToggle?: () => void
  /** 配合 onToggle：把展开态说给读屏；状态本身由外面持有 */
  expanded?: boolean
  children?: React.ReactNode
}

function Row({
  title,
  desc,
  server,
  nested,
  block,
  control,
  onToggle,
  expanded,
  children
}: RowProps): React.JSX.Element | null {
  /**
   * 免登录模式：带「服务端」标记的项一律不摆。
   *
   * ★ 它们要会话才有意义，摆出来只会得到一行「尚未登录」或一行点不动的控件（与侧栏、
   *   标题栏那份菜单同一口径）。收在这里而不在每一行上各写一遍，是为了让这条规矩**没有
   *   漏网的机会**：将来往某张本机卡片里再加一行 `server` 行，这里自动收掉。
   * ★ 整卡都是服务端内容的那几块（服务端缓存 / 网络代理 / 日志 / 曲库与扫描）不靠这里 ——
   *   它们**整个组件都不挂**（见 SettingsPage 与 AboutSettings），否则组件里的读请求照发，
   *   而 `requireClient()` 在没有会话时是同步抛的，抛在 effect 里会掀掉整棵组件树。
   */
  const guest = useAuth((s) => s.guest)
  if (guest && server) return null

  // 非 block 行的 children 就是右侧控件（设置页的历史写法），block 行才是正文
  const trailing = control ?? (block ? null : children)
  const clickable = onToggle !== undefined

  return (
    <div
      className="setting-row"
      data-nested={nested ? 'true' : undefined}
      data-block={block ? 'true' : undefined}
    >
      <div
        className="setting-row-head"
        data-clickable={clickable ? 'true' : undefined}
        role={clickable ? 'button' : undefined}
        tabIndex={clickable ? 0 : undefined}
        aria-expanded={clickable ? expanded : undefined}
        onClick={onToggle}
        onKeyDown={
          clickable
            ? (event) => {
                // div 扮按钮就得自己补键盘：空格还得挡掉默认的翻页滚动
                if (event.key !== 'Enter' && event.key !== ' ') return
                event.preventDefault()
                onToggle?.()
              }
            : undefined
        }
      >
        <div className="setting-row-text">
          <div className="setting-row-title">
            {title}
            {server ? (
              <span className="badge" data-tone="accent" style={{ marginLeft: 8 }}>
                服务端
              </span>
            ) : null}
          </div>
          {desc ? <div className="setting-row-desc">{desc}</div> : null}
        </div>
        {trailing ? <div className="setting-row-control">{trailing}</div> : null}
      </div>
      {block && children ? <div className="setting-row-body">{children}</div> : null}
    </div>
  )
}

interface CardProps {
  title: string
  /** 标题右侧的操作区（例如计数与刷新），与标题同一行 */
  action?: React.ReactNode
  children: React.ReactNode
}

function Card({ title, action, children }: CardProps): React.JSX.Element {
  return (
    <section className="setting-card">
      <div className="setting-card-title">
        {title}
        {action ? <div className="setting-card-actions">{action}</div> : null}
      </div>
      {children}
    </section>
  )
}

/* ───────────────────────────── 外观 ───────────────────────────── */

function AppearanceSettings(): React.JSX.Element {
  const { settings, patch, reset, coverAccent } = useSettings()
  const accent = currentAccentHex()

  return (
    <>
      <Card title="主题">
        <Row title="配色模式" desc="跟随系统时会随 GNOME 的浅色/深色偏好实时切换">
          <div className="segmented" role="group" aria-label="配色模式">
            {[
              { value: 'system' as const, label: '跟随系统', icon: <IconMonitor size={14} /> },
              { value: 'dark' as const, label: '深色', icon: <IconMoon size={14} /> },
              { value: 'light' as const, label: '浅色', icon: <IconSun size={14} /> }
            ].map((option) => (
              <button
                key={option.value}
                type="button"
                aria-pressed={settings.theme === option.value}
                onClick={() => void patch({ theme: option.value })}
              >
                {option.icon}
                {option.label}
              </button>
            ))}
          </div>
        </Row>

        <Row
          title="强调色跟随封面"
          desc={
            coverAccent
              ? `当前由封面推导：${coverAccent} —— 换歌时整页光晕会平滑过渡`
              : '播放时从封面提取主色，让界面色调跟着专辑走'
          }
        >
          <Switch
            ariaLabel="强调色跟随封面"
            checked={settings.accentFromCover}
            onChange={(checked) => void patch({ accentFromCover: checked })}
          />
        </Row>

        <Row title="固定强调色" desc="关闭「跟随封面」后生效">
          <div className="row" style={{ gap: 6 }}>
            {ACCENT_PRESETS.map((preset) => (
              <button
                key={preset}
                type="button"
                aria-label={`使用强调色 ${preset}`}
                data-tip={preset}
                onClick={() => void patch({ accent: preset, accentFromCover: false })}
                style={{
                  width: 26,
                  height: 26,
                  borderRadius: 8,
                  border:
                    accent.toLowerCase() === preset
                      ? '2px solid var(--text-1)'
                      : '1px solid var(--line-2)',
                  background: preset,
                  cursor: 'pointer'
                }}
              />
            ))}
            <input
              type="color"
              aria-label="自定义强调色"
              value={settings.accent}
              onChange={(event) =>
                void patch({ accent: event.target.value, accentFromCover: false })
              }
              style={{
                width: 34,
                height: 26,
                border: 'none',
                background: 'transparent',
                cursor: 'pointer'
              }}
            />
          </div>
        </Row>

        <Row
          title="界面密度"
          desc="舒适：侧栏更大（图标与行高 1.5×）；紧凑：列表行高 38px、侧栏折叠更窄，一屏多看几首"
        >
          <div className="segmented" role="group" aria-label="界面密度">
            <button
              type="button"
              aria-pressed={settings.density === 'comfortable'}
              onClick={() => void patch({ density: 'comfortable' })}
            >
              舒适
            </button>
            <button
              type="button"
              aria-pressed={settings.density === 'compact'}
              onClick={() => void patch({ density: 'compact' })}
            >
              紧凑
            </button>
          </div>
        </Row>

        <Row title="玻璃质感强度" desc={`侧栏与标题栏的模糊程度：${settings.glassIntensity}`}>
          <input
            type="range"
            min={0}
            max={100}
            value={settings.glassIntensity}
            aria-label="玻璃质感强度"
            onChange={(event) => void patch({ glassIntensity: Number(event.target.value) })}
            style={{ width: 180 }}
          />
        </Row>
      </Card>

      {/* 整窗透明度：调低了**连窗口本身一起**透出桌面（窗口是透明窗口，见 main/windows.ts）。
          与「某个面自己的底色」不是一回事 —— 那些怎么调都只在窗口内部透，桌面始终进不来
          （见 shared/ipc.ts 的 windowOpacity / miniWindowOpacity）。

          主窗与迷你窗各一个滑块：两者想要的通透程度本来就不同 —— 主窗常与别的窗口并排看，
          迷你条则要浮在屏幕角上、还能瞧见底下在放什么，所以各管各的而不是共用一个 */}
      <Card title="窗口透明度">
        <Row
          title="主播放器不透明度"
          desc={`${settings.windowOpacity}%：整个窗口的浓度，100 为不透明；调低后连文字一起透出后面的桌面`}
        >
          <input
            type="range"
            min={0}
            max={100}
            value={settings.windowOpacity}
            aria-label="主播放器不透明度"
            onChange={(event) => void patch({ windowOpacity: Number(event.target.value) })}
            style={{ width: 180 }}
          />
        </Row>

        <Row
          title="迷你播放器不透明度"
          desc={`${settings.miniWindowOpacity}%：迷你窗的浓度，与主播放器各管各的（调一个不动另一个）`}
        >
          <input
            type="range"
            min={0}
            max={100}
            value={settings.miniWindowOpacity}
            aria-label="迷你播放器不透明度"
            onChange={(event) => void patch({ miniWindowOpacity: Number(event.target.value) })}
            style={{ width: 180 }}
          />
        </Row>

        {/*
          迷你窗里那两块面板**各自**的底色浓度（歌词 / 队列）。与上面那两条不是一回事：那两条调
          的是整窗（桌面会透进来），这两条只在窗口内部透 —— 面板淡下去露出的是同一个窗口里
          它下面那层。
          ★ 两块**分开**是有用的：歌词看两眼就够、队列常要多看几首，压暗一块、另一块留亮，
            两块才不会是同一张底。迷你窗那颗下拉里也有这两根（标题与这里逐字相同，见
            MiniPlayer 的 opacityMenu）—— 一处「找得到」，一处「就在手边」。
          ★ 高度不在这里：那是拖出来的（迷你窗面板的下边缘上压着一根把手），两块也各记一份。
        */}
        <Row
          title="歌词面板不透明度"
          desc={`${settings.miniLyricsPanelOpacity}%：迷你窗歌词面板那层底色的浓度，100 与播放条一致`}
        >
          <input
            type="range"
            min={0}
            max={100}
            value={settings.miniLyricsPanelOpacity}
            aria-label="歌词面板不透明度"
            onChange={(event) => void patch({ miniLyricsPanelOpacity: Number(event.target.value) })}
            style={{ width: 180 }}
          />
        </Row>

        <Row
          title="队列面板不透明度"
          desc={`${settings.miniQueuePanelOpacity}%：迷你窗播放队列面板那层底色的浓度，100 与播放条一致`}
        >
          <input
            type="range"
            min={0}
            max={100}
            value={settings.miniQueuePanelOpacity}
            aria-label="队列面板不透明度"
            onChange={(event) => void patch({ miniQueuePanelOpacity: Number(event.target.value) })}
            style={{ width: 180 }}
          />
        </Row>
      </Card>

      {/*
        迷你窗自己的几项。★ 置顶那一项必须在这里有个落点：迷你窗的右键菜单从前有它，
        现在只有那两个不透明度滑块（见 MiniPlayer.tsx 封面菜单）—— 没有这一条的话，
        「迷你条浮不浮在别的窗口之上」就只剩下手改配置文件一个办法了。
      */}
      <Card title="迷你播放器">
        <Row
          title="窗口置顶"
          desc="让迷你条浮在别的窗口之上（默认开；它是挂在屏幕角上的挂件，关掉后会被别的窗口盖住）"
        >
          <Switch
            ariaLabel="迷你播放器置顶"
            checked={settings.miniAlwaysOnTop}
            onChange={(checked) => void patch({ miniAlwaysOnTop: checked })}
          />
        </Row>
      </Card>

      <Card title="重置">
        <Row title="恢复默认设置" desc="只重置本机偏好，不会动服务器上的任何数据">
          <button
            type="button"
            className="btn"
            data-variant="danger"
            onClick={() => {
              if (window.confirm('恢复全部本机设置为默认值？')) void reset()
            }}
          >
            <IconRefresh size={15} />
            恢复默认
          </button>
        </Row>
      </Card>
    </>
  )
}

/* ───────────────────────────── 播放与歌词 ───────────────────────────── */

function PlaybackSettings(): React.JSX.Element {
  const { settings, patch } = useSettings()
  const guest = useAuth((s) => s.guest)

  /*
   * 取色器必须拿到一个具体色值（不能是空串）。跟随主题时按「当前实际生效的主题」
   * 推一个对立的颜色：空着直接点开，浅色主题下会落在白色上，选出来一片看不见的浅色歌词。
   * （data-theme 是 applyToDocument 写下的**已解析**主题，system 也已经被换算了。）
   */
  const fallbackLyricColor =
    document.documentElement.dataset.theme === 'light' ? '#12141f' : '#ffffff'

  return (
    <>
      <Card title="播放">
        <Row title="默认音量" desc={`新会话的初始音量：${Math.round(settings.volume * 100)}%`}>
          <input
            type="range"
            min={0}
            max={100}
            value={Math.round(settings.volume * 100)}
            aria-label="默认音量"
            onChange={(event) => void patch({ volume: Number(event.target.value) / 100 })}
            style={{ width: 180 }}
          />
        </Row>

        <Row title="播放模式" desc="关掉窗口重开后沿用">
          <select
            className="input"
            style={{ width: 150 }}
            /*
             * 显示值读 settings.playMode（它跟着模式一起落盘、重启沿用），但**改动必须走播放
             * 核心的 setPlayMode**：切到随机要顺手把播放顺序重洗一遍。只 patch 设置的话，
             * 播放核心那边仍是旧模式 + 顺序的 order —— 底栏图标不变、点「下一首」照旧按队列
             * 顺序走（这个缺陷就是这么来的，见 state/player-core 的 setPlayMode）。
             */
            value={settings.playMode}
            onChange={(event) =>
              usePlayer.getState().setPlayMode(event.target.value as typeof settings.playMode)
            }
          >
            <option value="loop">列表循环</option>
            <option value="single">单曲循环</option>
            <option value="random">随机播放</option>
          </select>
        </Row>

        <Row title="音质上限" desc="只有后端配了对应转码等级才有效；「原始」表示不做任何处理">
          <select
            className="input"
            style={{ width: 150 }}
            value={settings.quality}
            onChange={(event) =>
              void patch({ quality: event.target.value as typeof settings.quality })
            }
          >
            <option value="original">原始</option>
            <option value="320">320 kbps</option>
            <option value="192">192 kbps</option>
            <option value="128">128 kbps</option>
          </select>
        </Row>

        <Row title="关闭窗口时最小化到托盘" desc="开启后窗口不会退出，托盘图标继续控制播放">
          <Switch
            ariaLabel="关闭窗口时最小化到托盘"
            checked={settings.closeToTray}
            onChange={(checked) => void patch({ closeToTray: checked })}
          />
        </Row>

        {/* 服务端那一项单独一个组件：免登录时整块不挂，它的读请求也就不会发出去 */}
        {guest ? null : <VolumeNormalizeRow />}
      </Card>

      <Card title="歌词">
        {/* ★ 这一根是**主窗口**那几处歌词（底栏抽屉、满窗播放）的字号；迷你窗那一块有它自己的
            一根（miniLyricFontSize），在迷你窗右上角那颗钮那份菜单里 —— 两处刻意分开，见
            shared/ipc.ts 那两项上的说明。
            ⚠ 它目前**拖了没反应**：样式表里 .lyric-line 有一条写死的 15px 把行内这份挡回去了
            （见 components.css 那两处注释）。这是既有缺陷，与迷你窗那一项无关。 */}
        <Row title="歌词字号" desc={`${settings.lyricFontSize}px（歌词面板与抽屉同步）`}>
          <input
            type="range"
            min={16}
            max={48}
            value={settings.lyricFontSize}
            aria-label="歌词字号"
            onChange={(event) => void patch({ lyricFontSize: Number(event.target.value) })}
            style={{ width: 180 }}
          />
        </Row>
        <Row
          title="歌词字体颜色"
          desc={settings.lyricFontColor ? `当前 ${settings.lyricFontColor}` : '跟随主题文字色'}
        >
          <div className="row" style={{ gap: 6 }}>
            <input
              type="color"
              aria-label="歌词字体颜色"
              value={settings.lyricFontColor || fallbackLyricColor}
              onChange={(event) => void patch({ lyricFontColor: event.target.value })}
              style={{
                width: 34,
                height: 26,
                border: 'none',
                background: 'transparent',
                cursor: 'pointer'
              }}
            />
            <button
              type="button"
              className="btn"
              data-size="sm"
              data-variant="ghost"
              disabled={!settings.lyricFontColor}
              onClick={() => void patch({ lyricFontColor: '' })}
            >
              跟随主题
            </button>
          </div>
        </Row>

        <Row
          title="歌词字体不透明度"
          desc={`${settings.lyricFontOpacity}%（只影响歌词文字；当前行依旧最亮，其余按比例变淡）`}
        >
          <input
            type="range"
            min={0}
            max={100}
            value={settings.lyricFontOpacity}
            aria-label="歌词字体不透明度"
            onChange={(event) => void patch({ lyricFontOpacity: Number(event.target.value) })}
            style={{ width: 180 }}
          />
        </Row>

        <Row
          title="歌词面板不透明度"
          desc={`歌词区域自身的底色：${settings.lyricPanelOpacity}%（0 为默认，完全透出所在面板的玻璃质感）`}
        >
          <input
            type="range"
            min={0}
            max={100}
            value={settings.lyricPanelOpacity}
            aria-label="歌词面板不透明度"
            onChange={(event) => void patch({ lyricPanelOpacity: Number(event.target.value) })}
            style={{ width: 180 }}
          />
        </Row>

        {/* 翻译与罗马音这两行是**本机偏好**（所以不打「服务端」徽标），但内容来自后端的
            tlyric / rlyric —— 免登录时不光没有服务器可取，本地也根本拿不到这两种歌词，
            于是免登录时一并收掉，只留纯样式那几行 */}
        {guest ? null : (
          <>
            <Row title="显示翻译" desc="后端返回 tlyric 时显示在原文下方">
              <Switch
                ariaLabel="显示歌词翻译"
                checked={settings.lyricShowTranslation}
                onChange={(checked) => void patch({ lyricShowTranslation: checked })}
              />
            </Row>
            <Row title="显示罗马音" desc="后端返回 rlyric 时显示">
              <Switch
                ariaLabel="显示罗马音"
                checked={settings.lyricShowRoman}
                onChange={(checked) => void patch({ lyricShowRoman: checked })}
              />
            </Row>
          </>
        )}
      </Card>
    </>
  )
}

/**
 * 音量均衡（服务端设置）。
 *
 * ★ 为什么从 PlaybackSettings 里拆出来、单独成一个组件：开关在服务端，读它要一个
 *   ApiClient，而没有会话时 `requireClient()` 是**同步抛**的 —— 抛在 `useAsync` 的
 *   effect 里会把整棵组件树掀掉（见 hooks/useAsync）。所以它不能跟本机那几行同生共死：
 *   免登录时由调用方把它整块摘掉。Row 自己也会收掉带「服务端」标记的行，但那发生在渲染
 *   之后，救不了已经跑起来的 hook。
 */
function VolumeNormalizeRow(): React.JSX.Element {
  const { settings, patch } = useSettings()
  const normalize = useAsync(() => getVolumeNormalize(requireClient()), [])

  // 「音量均衡」的开关在服务端，本机的 volumeNormalize 只是它的镜像 ——
  // 音频 URL 由 audio 元素直接请求，拼装时没机会再问一次服务端。
  // 所以服务端状态一到（或被别的设备改过）就把本机对齐，两处不再各说各话。
  const serverNormalize = normalize.data?.enabled
  useEffect(() => {
    if (serverNormalize === undefined || serverNormalize === settings.volumeNormalize) return
    void patch({ volumeNormalize: serverNormalize })
  }, [serverNormalize, settings.volumeNormalize, patch])

  return (
    <Row
      server
      title="音量均衡"
      desc="启用 EBU R128 响度均衡，消除不同音源之间的音量差异。需要 ffmpeg，会增加 CPU 和首次播放延迟"
    >
      {normalize.loading ? (
        <IconLoader size={16} />
      ) : (
        <Switch
          ariaLabel="音量均衡"
          checked={normalize.data?.enabled ?? false}
          onChange={(checked) => {
            void setVolumeNormalize(requireClient(), {
              enabled: checked,
              loudness: normalize.data?.loudness ?? -16
            })
              // 本机镜像一起写：不然要等下一次拉设置才跟上，中间这段时间
              // 界面已经是「开」，音频 URL 里却没带 normalize=1
              .then(() => patch({ volumeNormalize: checked }))
              .then(() => normalize.reload())
              .then(() => toast(checked ? '已开启音量均衡' : '已关闭音量均衡', 'success'))
              .catch((error: unknown) =>
                toast('设置失败', 'error', error instanceof Error ? error.message : undefined)
              )
          }}
        />
      )}
    </Row>
  )
}

/* ───────────────────────────── 曲库与扫描 ───────────────────────────── */

/** 「标题来源」的两个选项。文案对齐上游 Flutter 版的语义（标签 vs 文件名） */
const TITLE_SOURCES: SelectOption<ScanTitleSource>[] = [
  { value: 'tag', label: '歌曲元数据', desc: '优先读音频文件里的标题 / 歌手标签' },
  {
    value: 'filename',
    label: '文件名',
    desc: '直接拿文件名（去掉扩展名）当标题，适合文件名已编号的情况'
  }
]

/**
 * 「扫描后自动创建歌单」的下拉。
 *
 * 「关闭」与三档创建方式**放进同一个选框**：它们本来就是同一个决定的不同取值，
 * 拆成「开关 + 子下拉」要额外解释「关掉开关时下面这项不生效」，还多占一行。
 */
type PlaylistChoice = 'off' | PlaylistMode

const PLAYLIST_CHOICES: SelectOption<PlaylistChoice>[] = [
  { value: 'off', label: '关闭', desc: '扫描后不自动生成歌单' },
  { value: 'directory', label: '按文件夹', desc: '每个文件夹生成独立歌单' },
  { value: 'top_level', label: '按顶层文件夹', desc: '子文件夹的歌曲合并到一级文件夹歌单' },
  { value: 'bubble_up', label: '包含子目录', desc: '歌曲同时出现在所有上级文件夹歌单' }
]

/**
 * 「自动扫描间隔」的下拉：开关与间隔是同一个决定（多久扫一次），所以合成一档，
 * 关掉就是选了「关闭」。后端只收秒且限 60 ~ 86400，用固定档位也就省掉一轮越界校验。
 */
type AutoScanChoice = 'off' | number

const AUTO_SCAN_CHOICES: SelectOption<AutoScanChoice>[] = [
  { value: 'off', label: '关闭' },
  { value: 600, label: '每 10 分钟' },
  { value: 1800, label: '每 30 分钟' },
  { value: 3600, label: '每 1 小时' },
  { value: 10800, label: '每 3 小时' },
  { value: 21600, label: '每 6 小时' },
  { value: 43200, label: '每 12 小时' },
  { value: 86400, label: '每 24 小时' }
]

/** 后端默认值：关闭 / 1 小时 */
const DEFAULT_SCAN_INTERVAL = 3600

/**
 * 把后端的「开关 + 秒数」折成下拉里的一档。
 * 档位外的秒数是防「别的客户端写进来的值」—— 直接给下拉会落到空标签上，
 * 看着像设置坏了；折到默认档位至少显示的是一个真值（后端仍按原值跑）。
 */
function toAutoScanChoice(setting: AutoScanSetting | null | undefined): AutoScanChoice {
  if (!setting?.enabled) return 'off'
  return AUTO_SCAN_CHOICES.some((item) => item.value === setting.interval_seconds)
    ? setting.interval_seconds
    : DEFAULT_SCAN_INTERVAL
}

const REFRESH_STATUS_LABEL: Record<MetadataRefreshStatus, string> = {
  idle: '空闲',
  running: '进行中',
  cancelling: '正在取消',
  done: '已完成',
  cancelled: '已取消',
  failed: '执行失败'
}

function LibrarySettings(): React.JSX.Element {
  const musicPath = useAsync(() => getMusicPath(requireClient()), [])
  const autoPlaylists = useAsync(() => getScanAutoCreatePlaylists(requireClient()), [])
  const playlistMode = useAsync(() => getScanPlaylistMode(requireClient()), [])
  const titleSource = useAsync(() => getScanTitleSource(requireClient()), [])
  const autoScan = useAsync(() => getAutoScan(requireClient()), [])
  const autoFingerprint = useAsync(() => getScanAutoFingerprint(requireClient()), [])
  const tagSync = useAsync(() => getTagSyncToFile(requireClient()), [])
  // 与「标题来源」是两个设置：这一项只管「刷新元数据」时要不要用标签标题覆盖网络歌曲
  const remoteTitleSource = useAsync(() => getRemoteTitleSource(requireClient()), [])
  const fingerprints = useAsync(() => getFingerprintStatus(requireClient()), [])
  // useAsync 返回的对象每次渲染都是新的，但 reload 本身是 useCallback 稳定的；
  // 单独取出来给 effect 当依赖，免得把整只对象塞进去让定时器反复重建
  const reloadFingerprints = fingerprints.reload

  const [progress, setProgress] = useState<ScanProgress | null>(null)
  // 排除目录的三个字段是一次覆盖写，所以整份配置只留一处草稿，三个页签共改它
  const [pathDraft, setPathDraft] = useState<MusicPathSetting | null>(null)
  // 排除目录默认收起：它是一坨配置，占位置远多于改动频率
  const [excludeOpen, setExcludeOpen] = useState(false)
  const [refresh, setRefresh] = useState<MetadataRefreshProgress | null>(null)
  const [duplicates, setDuplicates] = useState<DuplicatesResult | null>(null)
  const [checkingDuplicates, setCheckingDuplicates] = useState(false)
  // 指纹任务的运行态；`null` = 还没读到（区别于「读到了但空闲」）
  const [fpProgress, setFpProgress] = useState<FingerprintProgress | null>(null)
  // 失败清单只在点开弹窗时拉：它是「偶尔看一眼」的详情，不该跟着页面常驻请求
  const [fpFailedOpen, setFpFailedOpen] = useState(false)
  const [fpFailed, setFpFailed] = useState<FailedFingerprint[]>([])
  const [fpFailedLoading, setFpFailedLoading] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const pollRef = useRef<number | null>(null)
  const refreshPollRef = useRef<number | null>(null)
  const fpPollRef = useRef<number | null>(null)
  // 「检测重复」右侧那个下拉触发器的元素：既给它对位，也让 aria-expanded 说准
  const fpMenuRef = useRef<HTMLButtonElement | null>(null)
  // 只为读菜单宿主的真实状态，不另存一份「我开着」
  const fpMenuOpen = useContextMenu((s) => s.open && s.anchor === fpMenuRef.current)

  // 配置到达后填充草稿（用户已经在编辑就别覆盖）
  useEffect(() => {
    if (!musicPath.data) return
    setPathDraft((prev) => prev ?? musicPath.data!)
  }, [musicPath.data])

  const stopPolling = useCallback(() => {
    if (pollRef.current !== null) {
      window.clearInterval(pollRef.current)
      pollRef.current = null
    }
  }, [])

  const stopRefreshPolling = useCallback(() => {
    if (refreshPollRef.current !== null) {
      window.clearInterval(refreshPollRef.current)
      refreshPollRef.current = null
    }
  }, [])

  const stopFpPolling = useCallback(() => {
    if (fpPollRef.current !== null) {
      window.clearInterval(fpPollRef.current)
      fpPollRef.current = null
    }
  }, [])

  /*
   * 「在跑」的判定只有一份，在 state/useLibrary 里 —— 进度显示与那边的守望必须同时认同一套
   * 状态表：各写一份的话，后端加一个中间态就会出现「进度条已经停了，但同步还没开始」。
   */
  const isScanning = isScanRunning(progress?.status)

  const refreshRunning = isMetadataRefreshRunning(refresh?.status)

  // 指纹任务的运行态只有一个值（后端没有单独的 cancelling 态）
  const fpRunning = fpProgress?.status === 'running'

  // 扫描中才轮询；停下就清掉定时器，别让后台一直发请求
  useEffect(() => {
    if (!isScanning) {
      stopPolling()
      return
    }
    if (pollRef.current !== null) return
    pollRef.current = window.setInterval(() => {
      void getScanProgress(requireClient())
        .then(setProgress)
        .catch(() => undefined)
    }, 1200)
    return stopPolling
  }, [isScanning, stopPolling])

  // 刷新元数据同理：后端是全局单例任务，可能上一次还没跑完就又进了这页
  useEffect(() => {
    if (!refreshRunning) {
      stopRefreshPolling()
      return
    }
    if (refreshPollRef.current !== null) return
    refreshPollRef.current = window.setInterval(() => {
      void getMetadataRefreshProgress(requireClient())
        .then(setRefresh)
        .catch(() => undefined)
    }, 2000)
    return stopRefreshPolling
  }, [refreshRunning, stopRefreshPolling])

  // 指纹计算同一套：它比元数据刷新更慢（每首都要起一次 ffmpeg），轮询间隔放长一点
  useEffect(() => {
    if (!fpRunning) {
      stopFpPolling()
      return
    }
    if (fpPollRef.current !== null) return
    fpPollRef.current = window.setInterval(() => {
      void getFingerprintProgress(requireClient())
        .then((next) => {
          setFpProgress(next)
          // 轮询是唯一能知道「跑完了」的地方：看到非 running 就把统计重读一次，
          // 否则「已算 N」会一直停在任务开始前的旧数字
          if (next.status !== 'running') reloadFingerprints()
        })
        .catch(() => undefined)
    }, 1500)
    return stopFpPolling
  }, [fpRunning, stopFpPolling, reloadFingerprints])

  // 进页面先各读一次，避免「明明在扫（或在刷元数据/算指纹）但界面显示空闲」
  useEffect(() => {
    void getScanProgress(requireClient())
      .then(setProgress)
      .catch(() => undefined)
    void getMetadataRefreshProgress(requireClient())
      .then(setRefresh)
      .catch(() => undefined)
    void getFingerprintProgress(requireClient())
      .then(setFpProgress)
      .catch(() => undefined)
  }, [])

  /** 服务端单项设置的通用写回：失败提示 + 回读。开关/下拉本身就是成功反馈，不再弹 toast。 */
  const writeSetting = useCallback((action: Promise<void>, reload: () => void): void => {
    void action
      .then(reload)
      .catch((error: unknown) =>
        toast('设置失败', 'error', error instanceof Error ? error.message : undefined)
      )
  }, [])

  /**
   * 一次性动作的统一跑法：占住 busy、成功提示、失败提示。
   * `after` 只在**成功之后**跑 —— 例如保存排除目录要顺带收起那块折叠区，
   * 保存失败还收起来的话，用户就只能自己再展开一遍才能改回去。
   */
  const run = useCallback(
    async (
      key: string,
      action: () => Promise<void>,
      successMessage: string,
      after?: () => void
    ) => {
      setBusy(key)
      try {
        await action()
        after?.()
        toast(successMessage, 'success')
      } catch (error) {
        toast('操作失败', 'error', error instanceof Error ? error.message : undefined)
      } finally {
        setBusy(null)
      }
    },
    []
  )

  const percent =
    progress && progress.total_files > 0
      ? Math.floor((progress.scanned_files * 100) / progress.total_files)
      : 0

  const refreshPercent =
    refresh && refresh.total > 0 ? Math.floor((refresh.processed * 100) / refresh.total) : 0

  // 分母优先用任务自己的 total：它一开始就是「本次要算几首」，而统计接口的 total 是曲库总数
  const fpTotal = fpProgress?.total || fingerprints.data?.total || 0
  const fpPercent =
    fpProgress && fpTotal > 0 ? Math.floor((fpProgress.computed * 100) / fpTotal) : 0

  /**
   * 触发一次指纹计算（界面只有「重试识别」与「全量重算」两条路）并立刻把进度读回来，
   * 好让轮询这一帧就接上（否则要等下一个 tick 才动）。
   */
  const startFingerprint = (mode: 'retryFailed' | 'recomputeAll'): Promise<void> =>
    run(
      'fingerprint',
      async () => {
        await computeFingerprints(requireClient(), {
          recomputeAll: mode === 'recomputeAll',
          retryFailed: mode === 'retryFailed'
        })
        setFpProgress(await getFingerprintProgress(requireClient()))
      },
      mode === 'recomputeAll' ? '已开始全量重算指纹（后台进行）' : '已开始重试失败的指纹'
    )

  /** 检测重复：后端要逐首比对指纹，慢，所以按钮上给转圈 */
  const checkDuplicates = (): void => {
    setCheckingDuplicates(true)
    void findDuplicates(requireClient())
      .then(setDuplicates)
      .catch((error: unknown) =>
        toast('检测失败', 'error', error instanceof Error ? error.message : undefined)
      )
      .finally(() => setCheckingDuplicates(false))
  }

  /** 失败清单只在点开时拉；先把弹窗开起来，加载态由弹窗自己交代 */
  const openFailedList = (): void => {
    setFpFailedOpen(true)
    setFpFailedLoading(true)
    void getFailedFingerprints(requireClient())
      .then(setFpFailed)
      .catch((error: unknown) => {
        setFpFailedOpen(false)
        toast('读取失败清单失败', 'error', error instanceof Error ? error.message : undefined)
      })
      .finally(() => setFpFailedLoading(false))
  }

  /** 全量重算会清空已有指纹，先说清后果再动手 */
  const recomputeAllFingerprints = (): void => {
    const total = fingerprints.data?.total ?? 0
    if (!window.confirm(`清空并重算全部 ${total} 首的指纹？期间检测结果不可用，耗时可能很长。`))
      return
    void startFingerprint('recomputeAll')
  }

  /**
   * 「检测重复」右侧的下拉：一次性与重算类动作都收进来，行里只留一个主按钮。
   * 面板复用 ContextMenuHost（同 SettingSelect），贴边翻转/点别处关闭/Esc 都不用再写一遍。
   */
  const openFingerprintMenu = (event: React.MouseEvent<HTMLButtonElement>): void => {
    const menu = useContextMenu.getState()
    // 宿主对「点触发器」刻意不关（anchor 放行），所以这里读到开着 = 该收起
    if (menu.open) {
      menu.hide()
      return
    }
    const failed = fingerprints.data?.failed ?? 0
    const ready = Boolean(fingerprints.data?.chromaprint_available)
    const items: MenuItem[] = [
      {
        key: 'retry',
        label: '重试识别',
        icon: <IconRefresh size={15} />,
        disabled: !ready || failed === 0,
        onClick: () => void startFingerprint('retryFailed')
      },
      {
        key: 'failed',
        label: '失败详情',
        icon: <IconAlert size={15} />,
        disabled: failed === 0,
        onClick: openFailedList
      },
      { key: 'divider', label: '', separator: true },
      {
        key: 'recompute',
        label: '全量重算',
        icon: <IconSparkle size={15} />,
        disabled: !ready,
        onClick: recomputeAllFingerprints
      }
    ]
    const rect = event.currentTarget.getBoundingClientRect()
    // 右对齐：触发器长在行的右端，左对齐会让面板往卡片外探出一截
    menu.show(rect.left, rect.bottom + 6, items, {
      anchor: event.currentTarget,
      align: 'right',
      anchorRect: rect
    })
  }

  // 开关也并进这个下拉：关掉就是选了「关闭」这一档
  const playlistChoice: PlaylistChoice = autoPlaylists.data
    ? (playlistMode.data ?? 'directory')
    : 'off'
  // 三档创建方式的差别不在名字上，而在「一首歌到底会进哪几个歌单」，所以说明跟着选中项走
  const playlistDesc =
    PLAYLIST_CHOICES.find((item) => item.value === playlistChoice)?.desc ?? PLAYLIST_CHOICES[0].desc

  /** 排除目录收起时的摘要：不展开也知道自己排了些什么 */
  const excludeSummary = pathDraft
    ? `名称 ${pathDraft.exclude_dirs.length} · 路径 ${pathDraft.exclude_paths.length} · 歌单 ${pathDraft.auto_create_exclude_dirs.length}`
    : ''

  /** 同理：开关也并进「自动扫描间隔」这一档下拉 */
  const autoScanChoice = toAutoScanChoice(autoScan.data)

  /** 选「关闭」时把原间隔留着不丢，下次开启还是原来那一档 */
  const changeAutoScan = (choice: AutoScanChoice): void => {
    writeSetting(
      setAutoScan(requireClient(), {
        enabled: choice !== 'off',
        interval_seconds:
          choice === 'off' ? (autoScan.data?.interval_seconds ?? DEFAULT_SCAN_INTERVAL) : choice
      }),
      () => autoScan.reload()
    )
  }

  /**
   * 一档切换 = 两个后端字段（模式 + 开关）。写的顺序有讲究：必须**先落模式再开开关**，
   * 反过来的话，开关已生效而模式还没落库的那一小段，后端会按旧模式（默认 directory）建歌单。
   */
  const changePlaylistChoice = (choice: PlaylistChoice): void => {
    const reload = (): void => {
      autoPlaylists.reload()
      playlistMode.reload()
    }
    if (choice === 'off') {
      writeSetting(setScanAutoCreatePlaylists(requireClient(), false), reload)
      return
    }
    void setScanPlaylistMode(requireClient(), choice)
      .then(() => setScanAutoCreatePlaylists(requireClient(), true))
      .then(reload)
      .catch((error: unknown) =>
        toast('设置失败', 'error', error instanceof Error ? error.message : undefined)
      )
  }

  return (
    <>
      <Card title="扫描">
        {/*
          顺序照上游 Flutter 版的 `scan_manager.dart`：建歌单 → 歌单方式 → 标题来源 →
          自动扫描（含间隔）→ 自动指纹 → 回写标签 → 排除目录 → 扫描进度。
          排除目录贴着扫描进度是有意的：一个决定「扫什么」，一个是「扫到哪了」。
          音乐根目录的输入框则撤掉了 —— 它属于部署配置，改错一个字符整库就扫不到，
          不该跟日常开关放在一起（原 Flutter 版也没在这放）。
        */}
        <Row
          server
          title="扫描后自动创建歌单"
          desc={autoPlaylists.loading ? '正在读取…' : playlistDesc}
          control={
            <SettingSelect
              ariaLabel="扫描后自动创建歌单"
              value={playlistChoice}
              options={PLAYLIST_CHOICES}
              disabled={autoPlaylists.loading || playlistMode.loading}
              onChange={changePlaylistChoice}
              width={170}
            />
          }
        />

        <Row
          server
          title="标题来源"
          desc="改完要用「强制扫描」再扫一次才生效（那一档会重读已入库文件的元数据）"
          control={
            <SettingSelect
              ariaLabel="标题来源"
              value={titleSource.data ?? 'tag'}
              options={TITLE_SOURCES}
              disabled={titleSource.loading}
              onChange={(next) =>
                writeSetting(setScanTitleSource(requireClient(), next), () => titleSource.reload())
              }
              width={150}
            />
          }
        />

        <Row
          server
          title="自动扫描间隔"
          desc="每隔这么久自动扫一次新文件；选「关闭」就只在手动点「重新扫描」时扫"
          control={
            autoScan.loading ? (
              <IconLoader size={16} />
            ) : (
              <SettingSelect
                ariaLabel="自动扫描间隔"
                value={autoScanChoice}
                options={AUTO_SCAN_CHOICES}
                onChange={changeAutoScan}
                width={128}
              />
            )
          }
        />

        <Row
          server
          title="扫描后自动计算音频指纹"
          desc="指纹只用于重复歌曲检测。大曲库开启后会长时间占用 CPU；关着也能在「曲库维护」里手动算"
        >
          {autoFingerprint.loading ? (
            <IconLoader size={16} />
          ) : (
            <Switch
              ariaLabel="扫描后自动计算音频指纹"
              checked={autoFingerprint.data ?? false}
              onChange={(checked) =>
                writeSetting(setScanAutoFingerprint(requireClient(), checked), () =>
                  autoFingerprint.reload()
                )
              }
            />
          )}
        </Row>

        <Row
          server
          title="编辑元数据时回写音频文件"
          desc="关闭后只改数据库，本地文件的标签保持原样"
        >
          {tagSync.loading ? (
            <IconLoader size={16} />
          ) : (
            <Switch
              ariaLabel="回写音频文件标签"
              checked={tagSync.data ?? false}
              onChange={(checked) =>
                writeSetting(setTagSyncToFile(requireClient(), checked), () => tagSync.reload())
              }
            />
          )}
        </Row>

        <Row
          server
          block
          title="排除目录"
          desc={
            excludeOpen
              ? '扫描时跳过这些目录；三种排除的作用范围不同，切页签看说明'
              : `扫描时跳过这些目录${excludeSummary ? ` · 当前 ${excludeSummary}` : ''}`
          }
          onToggle={() => setExcludeOpen((open) => !open)}
          expanded={excludeOpen}
          control={
            <span className="collapse-hint">
              {excludeOpen ? '收起' : '展开'}
              <IconChevronDown
                size={15}
                className="collapse-caret"
                data-open={excludeOpen ? 'true' : undefined}
              />
            </span>
          }
        >
          {excludeOpen ? (
            <div id="exclude-dirs-editor">
              {pathDraft ? (
                <ExcludeDirsEditor
                  value={pathDraft}
                  onChange={setPathDraft}
                  saving={busy === 'exclude'}
                  // 存完就收起来：这块折叠区是为「改一改」临时打开的，
                  // 保存成功说明这次改动结束了，再摊着只是挡住下面的扫描按钮
                  onSave={() =>
                    void run(
                      'exclude',
                      async () => {
                        await updateMusicPath(requireClient(), pathDraft)
                        musicPath.reload()
                      },
                      '排除目录已保存，后台正在清理被排除目录中的歌曲',
                      () => setExcludeOpen(false)
                    )
                  }
                />
              ) : (
                <div className="field-hint">
                  {musicPath.error ? `读取排除配置失败：${musicPath.error}` : '正在读取排除配置…'}
                </div>
              )}
            </div>
          ) : null}
        </Row>

        <Row
          server
          block
          title="扫描进度"
          desc={
            progress
              ? progress.status === 'idle'
                ? '当前空闲'
                : `${progress.status} · ${progress.scanned_files}/${progress.total_files} · 导入 ${progress.imported_files} / 跳过 ${progress.skipped_files} / 失败 ${progress.failed_files}`
              : '正在读取…'
          }
        >
          {isScanning ? (
            <>
              <div className="progress-track">
                <div className="progress-fill" style={{ width: `${percent}%` }} />
              </div>
              <div className="setting-row-desc" style={{ marginTop: 8 }}>
                {percent}%{progress?.current_file ? ` · ${progress.current_file}` : ''}
                {progress && progress.cue_split_sources > 0
                  ? ` · 已切 CUE 整轨 ${progress.cue_split_sources} 个`
                  : ''}
              </div>
              {/* 扫描中只剩「停下来」这一件事可做：两个入口一起消失，不留能按的假按钮 */}
              <button
                type="button"
                className="btn"
                data-variant="danger"
                style={{ width: '100%', marginTop: 10 }}
                disabled={busy === 'cancel'}
                onClick={() =>
                  void run('cancel', () => cancelScan(requireClient()), '已请求取消扫描')
                }
              >
                取消扫描
              </button>
            </>
          ) : (
            <div className="scan-actions">
              <button
                type="button"
                className="btn"
                data-variant="primary"
                style={{ flex: 1 }}
                disabled={busy === 'scan'}
                data-tip="扫描尚未入库的新文件（已在库里的按修改时间跳过）"
                onClick={() =>
                  void run(
                    'scan',
                    async () => {
                      await startScan(requireClient(), false)
                      // 扫完要把各处的曲库副本同步一遍：守望交给 useLibrary（它一直跟到任务结束）
                      useLibrary.getState().watchTasks()
                      setProgress(await getScanProgress(requireClient()))
                    },
                    '扫描已开始'
                  )
                }
              >
                <IconRefresh size={15} />
                重新扫描
              </button>
              <button
                type="button"
                className="btn"
                style={{ flex: 'none' }}
                disabled={busy === 'force'}
                data-tip="忽略缓存：已入库的文件也重新读一遍元数据（改了「标题来源」就该跑它），慢"
                onClick={() =>
                  void run(
                    'force',
                    async () => {
                      await startScan(requireClient(), true)
                      // 同上（强制扫描：已入库的也会重读元数据，更需要同步）
                      useLibrary.getState().watchTasks()
                      setProgress(await getScanProgress(requireClient()))
                    },
                    '强制扫描已开始'
                  )
                }
              >
                <IconSparkle size={15} />
                强制扫描
              </button>
            </div>
          )}
        </Row>
      </Card>

      <Card title="元数据维护">
        <Row
          server
          title="使用标签覆盖标题"
          // 副标题逐字照上游 Flutter 版（metadata_refresh_manager.dart）：这两个开关
          // 方向相反（我们的「标题来源」是「开 = 用文件名」），差别全靠这两句话交代
          desc={
            remoteTitleSource.loading
              ? '正在读取…'
              : remoteTitleSource.data === 'tag'
                ? '网络歌曲元数据刷新时用音频标签覆盖标题'
                : '网络歌曲标题保持文件名，不使用标签覆盖'
          }
          control={
            remoteTitleSource.loading ? (
              <IconLoader size={16} />
            ) : (
              <Switch
                ariaLabel="使用标签覆盖标题"
                checked={remoteTitleSource.data === 'tag'}
                onChange={(checked) =>
                  writeSetting(
                    setRemoteTitleSource(requireClient(), checked ? 'tag' : 'filename'),
                    () => remoteTitleSource.reload()
                  )
                }
              />
            )
          }
        />

        <Row
          server
          block
          title="刷新进度"
          desc={
            refreshRunning
              ? `刷新中 · 已完成 ${refresh?.processed ?? 0}/${refresh?.total ?? 0}${
                  refresh && refresh.failed > 0 ? `，失败 ${refresh.failed}` : ''
                }`
              : refresh && refresh.status !== 'idle'
                ? `上次刷新${REFRESH_STATUS_LABEL[refresh.status]}：成功 ${Math.max(
                    0,
                    refresh.processed - refresh.failed
                  )} 首${refresh.failed > 0 ? `，失败 ${refresh.failed} 首` : ''}`
                : '重新探测元数据缺失的歌曲（本地文件与已缓存的网络歌曲），只补空缺，不改动音频文件里的标签'
          }
        >
          {/* 与上面「扫描进度」同一套：空闲一个大按钮，跑起来就换成
              进度条 + 百分比 + 满宽的取消，不给「再点一次」留位置 */}
          {refreshRunning ? (
            <>
              <div className="progress-track">
                <div className="progress-fill" style={{ width: `${refreshPercent}%` }} />
              </div>
              <div className="setting-row-desc" style={{ marginTop: 8 }}>
                {refreshPercent}%
              </div>
              <button
                type="button"
                className="btn"
                data-variant="danger"
                style={{ width: '100%', marginTop: 10 }}
                disabled={refresh?.status === 'cancelling'}
                onClick={() =>
                  void run(
                    'refresh-cancel',
                    () => cancelMetadataRefresh(requireClient()),
                    '已请求取消刷新'
                  )
                }
              >
                取消刷新
              </button>
            </>
          ) : (
            <button
              type="button"
              className="btn"
              data-variant="primary"
              style={{ width: '100%' }}
              disabled={busy === 'refresh'}
              onClick={() =>
                void run(
                  'refresh',
                  async () => {
                    await startMetadataRefresh(requireClient())
                    // 同上：刷完的元数据要同步到曲库列表、歌单、正在播放那一首
                    useLibrary.getState().watchTasks()
                    setRefresh(await getMetadataRefreshProgress(requireClient()))
                  },
                  '已开始刷新元数据（后台进行）'
                )
              }
            >
              <IconRefresh size={15} />
              刷新元数据
            </button>
          )}
        </Row>
      </Card>

      <Card title="曲库维护">
        <Row server title="清理失效歌曲" desc="把数据库里文件已经不存在的记录清掉（不动任何文件）">
          <button
            type="button"
            className="btn"
            disabled={busy === 'clean'}
            onClick={() =>
              void run(
                'clean',
                async () => {
                  const result = await cleanMissingSongs(requireClient())
                  toast(
                    `清理完成：共 ${result.total} 条（文件不存在 ${result.file_not_found}，在排除目录 ${result.in_excluded_dir}）`,
                    'success'
                  )
                  // 删掉记录也是曲库变了：列表、歌单计数、统计那几处副本要跟上
                  useLibrary.getState().invalidate()
                },
                '已执行清理'
              )
            }
          >
            开始清理
          </button>
        </Row>

        <Row
          server
          block
          title="重复歌曲检测"
          desc={
            fingerprints.data && !fingerprints.data.chromaprint_available
              ? '后端未安装带 chromaprint 的 ffmpeg，算不出指纹（检测重复要先有指纹）'
              : fingerprints.loading
                ? '正在读取指纹状态…'
                : '同一段音频的不同副本指纹相同，靠它才能认出改过名的重复。指纹没算完时检测结果不完整。'
          }
        >
          {/* 与「扫描进度」同一套：跑起来就换成进度条 + 中断，不给「再点一次」留位置 */}
          {fpRunning ? (
            <>
              <div className="progress-track">
                <div className="progress-fill" style={{ width: `${fpPercent}%` }} />
              </div>
              <div className="setting-row-desc" style={{ marginTop: 8 }}>
                {fpPercent}% · 已算 {fpProgress?.computed ?? 0}/{fpTotal}
                {fpProgress && fpProgress.failed > 0 ? ` · 失败 ${fpProgress.failed}` : ''}
              </div>
              <button
                type="button"
                className="btn"
                data-variant="danger"
                style={{ width: '100%', marginTop: 10 }}
                disabled={busy === 'cancel-fp'}
                onClick={() =>
                  void run(
                    'cancel-fp',
                    () => cancelFingerprintCompute(requireClient()),
                    '已请求中断指纹计算'
                  )
                }
              >
                中断计算
              </button>
            </>
          ) : (
            <>
              <div className="stat-list">
                {fingerprints.data ? (
                  <>
                    <div className="stat-row">
                      <span>本地歌曲</span>
                      <span className="stat-row-value">{fingerprints.data.total}</span>
                    </div>
                    <div className="stat-row">
                      <span>已算指纹</span>
                      <span className="stat-row-value">{fingerprints.data.computed}</span>
                    </div>
                    <div className="stat-row">
                      <span>待计算</span>
                      <span className="stat-row-value">{fingerprints.data.missing}</span>
                    </div>
                    <div className="stat-row">
                      <span>失败</span>
                      <span
                        className="stat-row-value"
                        style={
                          fingerprints.data.failed > 0 ? { color: 'var(--danger)' } : undefined
                        }
                      >
                        {fingerprints.data.failed}
                      </span>
                    </div>
                  </>
                ) : fingerprints.error ? (
                  <div className="field-hint">读取指纹状态失败：{fingerprints.error}</div>
                ) : (
                  <div className="field-hint">正在读取指纹状态…</div>
                )}
              </div>

              {/* 一个动作 + 它的更多用法：重试/详情/重算都收进主按钮右侧的下拉，
                  行里只留「检测重复」这一个入口 */}
              <div className="scan-actions" style={{ marginTop: 12 }}>
                <div className="split-btn">
                  <button
                    type="button"
                    className="btn"
                    data-variant="primary"
                    disabled={checkingDuplicates}
                    data-tip="按音频指纹找出内容相同的副本"
                    onClick={checkDuplicates}
                  >
                    {checkingDuplicates ? <IconLoader size={15} /> : <IconFingerprint size={15} />}
                    检测重复
                  </button>
                  <button
                    ref={fpMenuRef}
                    type="button"
                    className="btn"
                    data-variant="primary"
                    aria-label="指纹与检测的更多操作"
                    aria-haspopup="menu"
                    aria-expanded={fpMenuOpen}
                    onClick={openFingerprintMenu}
                  >
                    <IconChevronDown size={15} />
                  </button>
                </div>
              </div>
            </>
          )}
        </Row>
      </Card>

      {duplicates ? (
        <DuplicatesModal result={duplicates} onClose={() => setDuplicates(null)} />
      ) : null}

      {fpFailedOpen ? (
        <FailedFingerprintsModal
          items={fpFailed}
          loading={fpFailedLoading}
          onRetry={() => {
            setFpFailedOpen(false)
            void startFingerprint('retryFailed')
          }}
          onClose={() => setFpFailedOpen(false)}
        />
      ) : null}
    </>
  )
}

function DuplicatesModal({
  result,
  onClose
}: {
  result: DuplicatesResult
  onClose: () => void
}): React.JSX.Element {
  const [busyId, setBusyId] = useState<number | null>(null)
  const [removed, setRemoved] = useState<number[]>([])

  return (
    <Modal
      title={`重复歌曲：${result.total_groups} 组 / ${result.total_duplicates} 首`}
      size="wide"
      onClose={onClose}
      footer={
        <button type="button" className="btn" data-variant="primary" onClick={onClose}>
          关闭
        </button>
      }
    >
      {result.groups.length === 0 ? (
        <EmptyState
          icon={<IconCheck size={26} />}
          title="没有发现重复"
          description="要么曲库本来就干净，要么指纹还没算完（指纹没算完时这个结果不可靠）"
        />
      ) : (
        <>
          <div className="probe-result">
            <IconAlert size={15} />
            <span>
              同一指纹说明是同一段音频的不同副本。删除只移除曲库记录，不会删本地文件；
              留哪一份请自己决定（一般留码率更高的）。
            </span>
          </div>
          <div style={{ maxHeight: '46vh', overflowY: 'auto' }}>
            {result.groups.map((group, groupIndex) => (
              <div key={group.fingerprint || groupIndex} style={{ marginBottom: 16 }}>
                <div className="setting-row-title" style={{ marginBottom: 6 }}>
                  第 {groupIndex + 1} 组 · {group.songs.length} 个副本
                </div>
                {group.songs.map((song) => (
                  <div
                    key={song.id}
                    className="row-between"
                    style={{
                      padding: '8px 10px',
                      borderBottom: '1px solid var(--line-1)',
                      opacity: removed.includes(song.id) ? 0.4 : 1
                    }}
                  >
                    <div style={{ minWidth: 0 }}>
                      <div className="truncate" style={{ fontSize: 13 }}>
                        {song.title}
                        {song.artist ? (
                          <span style={{ color: 'var(--text-3)' }}> — {song.artist}</span>
                        ) : null}
                      </div>
                      <div className="truncate" style={{ fontSize: 11.5, color: 'var(--text-4)' }}>
                        {song.format?.toUpperCase() || '?'} · {Math.round(song.bit_rate / 1000)}kbps
                        · {formatBytes(song.file_size)} · {song.file_path}
                      </div>
                    </div>
                    <button
                      type="button"
                      className="btn"
                      data-size="sm"
                      data-variant="danger"
                      disabled={busyId === song.id || removed.includes(song.id)}
                      onClick={() => {
                        if (
                          !window.confirm(`从曲库删除记录「${song.title}」？（不会删除本地文件）`)
                        )
                          return
                        setBusyId(song.id)
                        void deleteSong(requireClient(), song.id, false)
                          .then(() => {
                            setRemoved((prev) => [...prev, song.id])
                            toast('已从曲库删除该记录', 'success')
                          })
                          .catch((error: unknown) =>
                            toast(
                              '删除失败',
                              'error',
                              error instanceof Error ? error.message : undefined
                            )
                          )
                          .finally(() => setBusyId(null))
                      }}
                    >
                      <IconTrash size={14} />
                      删这条
                    </button>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </>
      )}
    </Modal>
  )
}

/** 后端给的是 unix 秒（0 = 没试过），转成 formatRelative 认的 ISO 串 */
function unixSecondsToIso(seconds: number): string {
  return seconds > 0 ? new Date(seconds * 1000).toISOString() : ''
}

function FailedFingerprintsModal({
  items,
  loading,
  onRetry,
  onClose
}: {
  items: FailedFingerprint[]
  loading: boolean
  onRetry: () => void
  onClose: () => void
}): React.JSX.Element {
  return (
    <Modal
      title={loading ? '指纹计算失败' : `指纹计算失败：${items.length} 首`}
      size="wide"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            关闭
          </button>
          <button
            type="button"
            className="btn"
            data-variant="primary"
            disabled={loading || items.length === 0}
            onClick={onRetry}
          >
            <IconRefresh size={15} />
            重试这些歌曲
          </button>
        </>
      }
    >
      {loading ? (
        <div className="field-hint">正在读取失败清单…</div>
      ) : items.length === 0 ? (
        <EmptyState
          icon={<IconCheck size={26} />}
          title="没有失败的歌曲"
          description="当前所有本地歌曲都算出了指纹"
        />
      ) : (
        <>
          <div className="probe-result">
            <IconAlert size={15} />
            <span>
              这些歌曲反复算不出指纹，后端已记下「试过了」—— 不会每轮扫描再把它们捞出来白跑
              ffmpeg。常见原因：文件损坏、没有音轨、格式不受支持。文件修好后点「重试这些歌曲」。
            </span>
          </div>
          <div className="fail-list">
            {items.map((item) => (
              <div key={item.id} className="fail-item">
                <div className="truncate" style={{ fontSize: 13 }}>
                  {item.title}
                  {item.artist ? (
                    <span style={{ color: 'var(--text-3)' }}> — {item.artist}</span>
                  ) : null}
                </div>
                <div className="truncate" style={{ fontSize: 11.5, color: 'var(--text-4)' }}>
                  {item.file_path}
                  {item.attempted_at > 0
                    ? ` · ${formatRelative(unixSecondsToIso(item.attempted_at))}`
                    : ''}
                </div>
                <div className="fail-item-reason">{item.error || '未知原因'}</div>
              </div>
            ))}
          </div>
        </>
      )}
    </Modal>
  )
}

/* ───────────────────────────── 缓存管理 ───────────────────────────── */

const GB = 1024 ** 3

type SizeStep = { value: number; label: string }

/** 服务端缓存上限档位（字节，0 = 不限）。给档位而不是任意值：上限差几百兆没有实际意义 */
const CACHE_SIZE_STEPS: SizeStep[] = [
  { value: 0, label: '不限' },
  { value: GB / 2, label: '512 MB' },
  { value: GB, label: '1 GB' },
  { value: 2 * GB, label: '2 GB' },
  { value: 5 * GB, label: '5 GB' },
  { value: 10 * GB, label: '10 GB' },
  { value: 20 * GB, label: '20 GB' },
  { value: 50 * GB, label: '50 GB' },
  { value: 100 * GB, label: '100 GB' }
]

/**
 * 本机缓存上限档位。
 *
 * 档位比服务端那组小：这是**用户自己的盘**，不是服务器的大盘；上游客户端也是这个尺度
 * （100 MB ~ 10 GB，默认 1 GB）。「不限」保留 —— 那时交回 Chromium 自己按可用空间决定。
 */
const LOCAL_CACHE_SIZE_STEPS: SizeStep[] = [
  { value: 0, label: '不限' },
  { value: 100 * 1024 ** 2, label: '100 MB' },
  { value: 500 * 1024 ** 2, label: '500 MB' },
  { value: GB, label: '1 GB' },
  { value: 2 * GB, label: '2 GB' },
  { value: 5 * GB, label: '5 GB' },
  { value: 10 * GB, label: '10 GB' }
]

/**
 * 上限的显示文案。
 *
 * 优先用档位自己的名字 —— 下拉里写的是「2 GB」，同一张卡片里的「上限」那行若用通用字节
 * 格式化写成「2.00 GB」，看上去就像两个不同的值。只有存着档位外的值时才退回通用写法。
 */
function sizeLabel(steps: SizeStep[], size: number): string {
  if (size <= 0) return '不限'
  return steps.find((step) => step.value === size)?.label ?? formatBytes(size)
}

/** 档位之外的当前值补进选项里，别让它显示成别的档 */
function withCurrentStep(steps: SizeStep[], current: number): SizeStep[] {
  return steps.some((step) => step.value === current)
    ? steps
    : [...steps, { value: current, label: formatBytes(current) }]
}

/** 占用比例（0–1）。没设上限就没有分母，返回 0 */
function usageRatio(used: number, max: number): number {
  return max > 0 ? Math.min(1, used / max) : 0
}

/**
 * 占用进度条（服务端缓存与本机缓存共用一条规则）。
 *
 * 不限时没有分母，索性不画 —— 画一条恒接近 0 的条只会让人以为「还剩这么多」。
 */
function UsageBar({ used, max }: { used: number; max: number }): React.JSX.Element | null {
  if (max <= 0) return null
  const ratio = usageRatio(used, max)
  return (
    <div className="progress-track" style={{ marginTop: 10 }}>
      <div
        className="progress-fill"
        // 逼近上限时换警示色：快用满这件事得看得出来
        data-tone={ratio >= 0.9 ? 'danger' : undefined}
        style={{ width: `${Math.round(ratio * 100)}%` }}
      />
    </div>
  )
}

/** 落盘转码目标格式；空值 = 不转码（后端语义） */
const TRANSCODE_FORMATS: SelectOption<string>[] = [
  { value: '', label: '原始（不转码）' },
  { value: 'mp3', label: 'MP3' },
  { value: 'm4a', label: 'M4A' },
  { value: 'ogg', label: 'OGG' },
  { value: 'flac', label: 'FLAC' },
  { value: 'wav', label: 'WAV' }
]

/** 转码码率；空值 = 最高质量，且只对有损格式生效 */
const TRANSCODE_QUALITIES: SelectOption<string>[] = [
  { value: '', label: '最高质量' },
  { value: '320', label: '320 kbps' },
  { value: '192', label: '192 kbps' },
  { value: '128', label: '128 kbps' }
]

function ServerCacheSettings(): React.JSX.Element {
  const stats = useAsync(() => getCacheStats(requireClient()), [])
  const config = useAsync(() => getCacheConfig(requireClient()), [])
  const [busy, setBusy] = useState<string | null>(null)
  const [dirEditing, setDirEditing] = useState(false)

  const used = stats.data?.total_size ?? 0
  const max = stats.data?.max_size ?? 0
  const ratio = usageRatio(used, max)
  // 后端可能存着一个不在档位里的上限（被别的客户端设过）
  const sizeOptions = withCurrentStep(CACHE_SIZE_STEPS, max)

  /** 配置写入统一走这里：后端 PUT 收的是完整配置，写完回读，界面永远显示真正落下的值 */
  const writeConfig = (patch: Partial<CacheConfigInput>): void => {
    const current = config.data
    if (!current) return
    setBusy('config')
    void updateCacheConfig(requireClient(), {
      max_size: patch.max_size ?? current.max_size,
      cache_dir: patch.cache_dir ?? current.cache_dir,
      transcode_format: patch.transcode_format ?? current.transcode_format,
      transcode_quality: patch.transcode_quality ?? current.transcode_quality
    })
      .then(() => {
        config.reload()
        // 上限变了，占用比例跟着变
        stats.reload()
      })
      .catch((error: unknown) =>
        toast('保存失败', 'error', error instanceof Error ? error.message : undefined)
      )
      .finally(() => setBusy(null))
  }

  return (
    <>
      <Card
        title="服务端音乐缓存"
        action={
          <button
            type="button"
            className="btn"
            data-size="sm"
            onClick={() => {
              config.reload()
              stats.reload()
            }}
          >
            <IconRefresh size={14} />
            刷新
          </button>
        }
      >
        <Row
          server
          block
          title="占用"
          desc={
            stats.error
              ? `读取失败：${stats.error}`
              : `${formatCount(stats.data?.file_count ?? 0)} 个文件${
                  max > 0 ? `，已用 ${Math.round(ratio * 100)}%` : '，未设上限'
                }`
          }
        >
          <div className="stat-list">
            <div className="stat-row">
              <span>已用</span>
              <span className="stat-row-value">{formatBytes(used)}</span>
            </div>
            <div className="stat-row">
              <span>上限</span>
              <span className="stat-row-value">{sizeLabel(CACHE_SIZE_STEPS, max)}</span>
            </div>
            <div className="stat-row">
              <span>文件数</span>
              <span className="stat-row-value">{formatCount(stats.data?.file_count ?? 0)}</span>
            </div>
          </div>
          <UsageBar used={used} max={max} />
        </Row>

        <Row
          server
          title="最大缓存大小"
          desc="超出后按最近最少使用淘汰旧文件；选「不限」缓存会一直长下去"
        >
          <select
            className="input"
            style={{ width: 150 }}
            value={String(max)}
            disabled={config.loading || busy === 'config'}
            aria-label="最大缓存大小"
            onChange={(event) => writeConfig({ max_size: Number(event.target.value) })}
          >
            {sizeOptions.map((step) => (
              <option key={step.value} value={String(step.value)}>
                {step.label}
              </option>
            ))}
          </select>
        </Row>

        <Row
          server
          title="缓存目录"
          desc={
            <span className="mono selectable">
              {config.data?.cache_dir || `${config.data?.default_cache_dir ?? ''}（默认）`}
            </span>
          }
        >
          <div className="row" style={{ gap: 8 }}>
            <button
              type="button"
              className="btn"
              data-size="sm"
              disabled={config.loading}
              onClick={() => setDirEditing(true)}
            >
              <IconEdit size={14} />
              修改
            </button>
            <button
              type="button"
              className="btn"
              data-size="sm"
              disabled={config.loading || !config.data?.cache_dir || busy === 'config'}
              onClick={() => writeConfig({ cache_dir: '' })}
            >
              恢复默认
            </button>
          </div>
        </Row>

        <Row
          server
          title="缓存转码格式"
          desc="网络歌曲落盘时统一转成这个格式；「原始」按上游原格式存。转码需要后端有 ffmpeg"
        >
          <SettingSelect
            ariaLabel="缓存转码格式"
            width={150}
            value={config.data?.transcode_format ?? ''}
            options={TRANSCODE_FORMATS}
            disabled={config.loading || busy === 'config'}
            onChange={(next) => writeConfig({ transcode_format: next })}
          />
        </Row>

        {/* 码率只对有损格式有意义：选了 FLAC / WAV 还问码率是误导 */}
        {(config.data?.transcode_format ?? '') !== '' ? (
          <Row
            nested
            server
            title="转码码率"
            desc="只对有损格式（MP3 / M4A / OGG）生效；FLAC / WAV 是无损，不受影响"
          >
            <SettingSelect
              ariaLabel="转码码率"
              width={150}
              value={config.data?.transcode_quality ?? ''}
              options={TRANSCODE_QUALITIES}
              disabled={config.loading || busy === 'config'}
              onChange={(next) => writeConfig({ transcode_quality: next })}
            />
          </Row>
        ) : null}

        <Row
          server
          title="清理缓存"
          desc="删掉已落盘的缓存文件；曲库、歌单与播放记录都不受影响，下次播放重新拉取"
        >
          <button
            type="button"
            className="btn"
            data-variant="danger"
            disabled={busy === 'clean' || (stats.data?.file_count ?? 0) === 0}
            onClick={() => {
              if (!window.confirm(`清理全部缓存（约 ${formatBytes(used)}）？`)) return
              setBusy('clean')
              void cleanCache(requireClient())
                .then(() => {
                  toast('缓存已清理', 'success')
                  stats.reload()
                })
                .catch((error: unknown) =>
                  toast('清理失败', 'error', error instanceof Error ? error.message : undefined)
                )
                .finally(() => setBusy(null))
            }}
          >
            {busy === 'clean' ? <IconLoader size={15} /> : <IconTrash size={15} />}
            清理缓存
          </button>
        </Row>
      </Card>

      {dirEditing ? (
        <CacheDirModal
          current={config.data?.cache_dir ?? ''}
          fallback={config.data?.default_cache_dir ?? ''}
          onSave={(path) => {
            setDirEditing(false)
            writeConfig({ cache_dir: path })
          }}
          onClose={() => setDirEditing(false)}
        />
      ) : null}
    </>
  )
}

/** 改缓存目录：先在弹窗里验证目录可用，再保存 */
function CacheDirModal({
  current,
  fallback,
  onSave,
  onClose
}: {
  current: string
  fallback: string
  onSave: (path: string) => void
  onClose: () => void
}): React.JSX.Element {
  const [path, setPath] = useState(current)
  const [check, setCheck] = useState<CacheDirCheck | null>(null)
  const [checking, setChecking] = useState(false)
  const fieldId = useId()

  const runCheck = (): void => {
    const target = path.trim()
    if (!target) return
    setChecking(true)
    void validateCacheDir(requireClient(), target)
      .then(setCheck)
      .catch((error: unknown) =>
        setCheck({
          valid: false,
          created: false,
          total_size: 0,
          free_size: 0,
          error: error instanceof Error ? error.message : '验证失败'
        })
      )
      .finally(() => setChecking(false))
  }

  return (
    <Modal
      title="缓存目录"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="btn"
            data-variant="primary"
            disabled={path.trim() === current}
            onClick={() => onSave(path.trim())}
          >
            保存
          </button>
        </>
      }
    >
      <div className="field">
        <label className="field-label" htmlFor={fieldId}>
          目录路径
        </label>
        <input
          id={fieldId}
          className="input"
          value={path}
          placeholder={fallback}
          onChange={(event) => {
            setPath(event.target.value)
            // 改过之后旧的验证结论就不作数了，别让它挂在那儿
            setCheck(null)
          }}
        />
        <div className="field-hint">
          留空表示用后端默认目录（{fallback}
          ）。换目录不会自动搬走旧缓存，旧目录里的文件得自己清理。
        </div>
      </div>

      <div className="row" style={{ gap: 8, marginTop: 12 }}>
        <button
          type="button"
          className="btn"
          data-size="sm"
          disabled={checking || !path.trim()}
          onClick={runCheck}
        >
          {checking ? <IconLoader size={14} /> : <IconCheck size={14} />}
          验证
        </button>
        <button
          type="button"
          className="btn"
          data-size="sm"
          onClick={() => {
            setPath('')
            setCheck(null)
          }}
        >
          使用默认
        </button>
      </div>

      {check ? (
        <div
          className="probe-result"
          data-state={check.valid ? 'ok' : 'error'}
          style={{ marginTop: 10 }}
        >
          {check.valid ? <IconCheck size={15} /> : <IconAlert size={15} />}
          <span>
            {check.valid
              ? `可用${check.created ? '（已创建目录）' : ''} · 所在磁盘剩余 ${formatBytes(check.free_size)}`
              : (check.error ?? '这个目录不可用')}
          </span>
        </div>
      ) : null}
    </Modal>
  )
}

/**
 * 本机缓存（客户端自己那一份）。
 *
 * 与服务端音乐缓存分开成两张卡：那份在服务器上、所有设备共用；这份只落在**这台机器**上，
 * 换服务器、换账号都自己一份，也不会跟着走到别的设备。
 */
function LocalCacheSettings(): React.JSX.Element {
  const { settings, patch } = useSettings()
  const cache = useAsync(() => window.songloft.cache.stats(), [])
  const [clearing, setClearing] = useState(false)

  const size = cache.data?.size ?? 0
  /*
   * 「上限」显示主进程回传的**生效值**，而不是设置里那个。
   * 用户刚调完还没重启时两者不同 —— 那时把设置值摆成「上限」就是在说谎，
   * 而真实生效值有个明确的去处：下拉的说明里会补一句「已改为 X，重启应用后生效」。
   */
  const applied = cache.data?.maxSize ?? 0
  const wanted = settings.localCacheMaxSize
  const ratio = usageRatio(size, applied)
  const sizeOptions = withCurrentStep(LOCAL_CACHE_SIZE_STEPS, wanted)

  const usageDesc = (): string => {
    if (cache.error) return `读取失败：${cache.error}`
    if (cache.loading) return '正在统计本机缓存占用…'
    // 上限为 0 时没有分母，只说「未设上限」而不是编一个百分比出来
    const head = applied > 0 ? `已用 ${Math.round(ratio * 100)}%` : '未设上限'
    return `${head} · 封面图与接口响应缓存在本机磁盘上（Chromium 的会话缓存）`
  }

  const limitDesc = (): string => {
    if (wanted !== applied) {
      return `已改为 ${sizeLabel(LOCAL_CACHE_SIZE_STEPS, wanted)}，重启应用后生效 —— 上限只能由启动参数交给 Chromium，运行中改不了`
    }
    if (wanted === 0) return '不限时交给 Chromium 按可用磁盘空间自行决定'
    return '超出上限后 Chromium 按最近最少使用淘汰旧文件'
  }

  const clean = (): void => {
    if (
      !window.confirm(
        `清理本机缓存（约 ${formatBytes(size)}）？封面图与接口响应之后要重新从服务器拉取。`
      )
    )
      return
    setClearing(true)
    const before = size
    void window.songloft.cache
      .clear()
      .then((next) => {
        cache.reload()
        const freed = before - next.size
        toast(freed > 0 ? `已清理，释放 ${formatBytes(freed)}` : '已清理', 'success')
      })
      .catch((error: unknown) =>
        toast('清理失败', 'error', error instanceof Error ? error.message : undefined)
      )
      .finally(() => setClearing(false))
  }

  return (
    <Card
      title="本地缓存"
      action={
        <button type="button" className="btn" data-size="sm" onClick={cache.reload}>
          <IconRefresh size={14} />
          刷新
        </button>
      }
    >
      <Row block title="占用" desc={usageDesc()}>
        <div className="stat-list">
          <div className="stat-row">
            <span>已用</span>
            <span className="stat-row-value">{cache.loading ? '统计中…' : formatBytes(size)}</span>
          </div>
          <div className="stat-row">
            <span>上限</span>
            <span className="stat-row-value">
              {cache.loading ? '统计中…' : sizeLabel(LOCAL_CACHE_SIZE_STEPS, applied)}
            </span>
          </div>
        </div>
        <UsageBar used={size} max={applied} />
      </Row>

      <Row title="最大本地缓存大小" desc={limitDesc()}>
        <select
          className="input"
          style={{ width: 150 }}
          value={String(wanted)}
          aria-label="最大本地缓存大小"
          onChange={(event) => void patch({ localCacheMaxSize: Number(event.target.value) })}
        >
          {sizeOptions.map((step) => (
            <option key={step.value} value={String(step.value)}>
              {step.label}
            </option>
          ))}
        </select>
      </Row>

      <Row
        title="清理本地缓存"
        desc="封面图与接口响应会被清掉，下次用到时重新从服务器拉取；曲库数据、登录状态与设置都不受影响"
      >
        <button
          type="button"
          className="btn"
          data-variant="danger"
          disabled={clearing}
          onClick={clean}
        >
          {clearing ? <IconLoader size={15} /> : <IconTrash size={15} />}
          清理本地缓存
        </button>
      </Row>
    </Card>
  )
}

/* ───────────────────────────── 网络设置 ───────────────────────────── */

/**
 * 网络设置。**整节都是服务端侧的**，所以免登录时整个分区从导航里撤掉（见 HIDDEN_WHEN_GUEST）。
 *
 * 代理那张卡自不必说；「忽略 SSL 证书校验」虽然是写在本机设置里的偏好，但它管的是**与服务器
 * 之间**的连接 —— 一台服务器都没连的时候，这一项无从谈起。
 */
function NetworkSettings(): React.JSX.Element {
  const { settings, patch } = useSettings()
  const httpProxy = useAsync(() => getHttpProxy(requireClient()), [])
  const githubProxy = useAsync(() => getGithubProxy(requireClient()), [])
  const allowlist = useAsync(() => getProxyAllowlist(requireClient()), [])
  const hls = useAsync(() => getHlsProxyEnabled(requireClient()), [])
  const [editing, setEditing] = useState<'http' | 'github' | 'allowlist' | null>(null)

  /** 手动弹窗里的「保存」都落到这里：写成功后回读，失败弹提示 */
  const saveProxy = (which: 'http' | 'github' | 'allowlist', value: string): void => {
    setEditing(null)
    const write =
      which === 'http'
        ? setHttpProxy(requireClient(), value.trim())
        : which === 'github'
          ? setGithubProxy(requireClient(), value.trim())
          : setProxyAllowlist(
              requireClient(),
              value
                .split('\n')
                .map((line) => line.trim())
                .filter(Boolean)
            )
    void write
      .then(() => {
        if (which === 'http') httpProxy.reload()
        else if (which === 'github') githubProxy.reload()
        else allowlist.reload()
        toast('已保存', 'success')
      })
      .catch((error: unknown) =>
        toast('保存失败', 'error', error instanceof Error ? error.message : undefined)
      )
  }

  return (
    <>
      <Card title="代理">
        <Row
          server
          title="HTTP 代理"
          desc={
            httpProxy.data
              ? `当前：${httpProxy.data}`
              : '未设置（直连）。填了之后后端访问外链（如导入歌单、抓取封面）都走它'
          }
        >
          <button type="button" className="btn" data-size="sm" onClick={() => setEditing('http')}>
            <IconEdit size={14} />
            修改
          </button>
        </Row>

        <Row
          server
          title="GitHub 加速代理"
          desc={githubProxy.data ? `当前：${githubProxy.data}` : '未设置。只在检查服务端更新时用到'}
        >
          <button type="button" className="btn" data-size="sm" onClick={() => setEditing('github')}>
            <IconEdit size={14} />
            修改
          </button>
        </Row>

        <Row
          server
          title="私网代理白名单"
          desc={
            (allowlist.data?.length ?? 0) > 0
              ? `已放行 ${allowlist.data?.length} 条：${allowlist.data?.join('、')}`
              : '未设置。后端默认拒绝代理私网 / 回环地址（这是 SSRF 防护），要代理内网资源才需要在这里放行'
          }
        >
          <button
            type="button"
            className="btn"
            data-size="sm"
            onClick={() => setEditing('allowlist')}
          >
            <IconEdit size={14} />
            修改
          </button>
        </Row>

        <Row server title="HLS 代理" desc="播放 m3u8 时由服务端代理切片，解决跨域与防盗链">
          {hls.loading ? (
            <IconLoader size={16} />
          ) : (
            <Switch
              ariaLabel="HLS 代理"
              checked={hls.data ?? false}
              onChange={(checked) => {
                void setHlsProxyEnabled(requireClient(), checked)
                  .then(() => hls.reload())
                  .catch((error: unknown) =>
                    toast('设置失败', 'error', error instanceof Error ? error.message : undefined)
                  )
              }}
            />
          )}
        </Row>
      </Card>

      <Card title="安全">
        <Row
          title="忽略 SSL 证书校验"
          desc="自签证书或内网证书才需要打开。开启后任何证书都会被接受，中间人能读到与服务器之间的全部内容"
        >
          <Switch
            ariaLabel="忽略 SSL 证书校验"
            checked={settings.allowInsecureTls}
            onChange={(checked) => {
              if (
                checked &&
                !window.confirm(
                  '开启后不再校验服务器证书：中间人可以读到你的登录凭据与所有请求内容。确定继续？'
                )
              )
                return
              void patch({ allowInsecureTls: checked })
            }}
          />
        </Row>
      </Card>

      {editing === 'http' || editing === 'github' ? (
        <TextPromptModal
          title={editing === 'http' ? 'HTTP 代理' : 'GitHub 加速代理'}
          label="代理地址"
          placeholder="http://192.168.1.1:7890"
          hint="留空表示不使用代理。支持 http / https / socks5。"
          initial={editing === 'http' ? (httpProxy.data ?? '') : (githubProxy.data ?? '')}
          onSave={(value) => saveProxy(editing, value)}
          onClose={() => setEditing(null)}
        />
      ) : null}

      {editing === 'allowlist' ? (
        <TextPromptModal
          title="私网代理白名单"
          label="放行的地址（每行一条）"
          placeholder={'192.168.1.0/24\n10.0.0.8'}
          hint="每条可以是单个 IP 或 CIDR 网段。只在命中白名单时后端才允许代理访问私网地址，其余仍按 SSRF 防护拒绝。"
          initial={(allowlist.data ?? []).join('\n')}
          multiline
          onSave={(value) => saveProxy('allowlist', value)}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </>
  )
}

/**
 * 单 / 多行文本输入弹窗。
 *
 * 代理地址、白名单这些是「一整串值」，直接内嵌在设置行右侧会让行高跳动，也让「保存」
 * 失去明确的确认点 —— 统一走弹窗。
 */
function TextPromptModal({
  title,
  label,
  placeholder,
  hint,
  initial,
  multiline,
  onSave,
  onClose
}: {
  title: string
  label: string
  placeholder: string
  hint: string
  initial: string
  multiline?: boolean
  onSave: (value: string) => void
  onClose: () => void
}): React.JSX.Element {
  const [value, setValue] = useState(initial)
  const fieldId = useId()

  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="btn"
            data-variant="primary"
            disabled={value === initial}
            onClick={() => onSave(value)}
          >
            保存
          </button>
        </>
      }
    >
      <div className="field">
        <label className="field-label" htmlFor={fieldId}>
          {label}
        </label>
        {multiline ? (
          <textarea
            id={fieldId}
            className="input"
            rows={6}
            value={value}
            placeholder={placeholder}
            style={{ height: 'auto', padding: '8px 12px', resize: 'vertical' }}
            onChange={(event) => setValue(event.target.value)}
          />
        ) : (
          <input
            id={fieldId}
            className="input"
            value={value}
            placeholder={placeholder}
            onChange={(event) => setValue(event.target.value)}
          />
        )}
        <div className="field-hint">{hint}</div>
      </div>
    </Modal>
  )
}

/* ───────────────────────────── 数据管理 ───────────────────────────── */

/** 备份文件名里的日期戳：2026-10-13 */
function dateStamp(): string {
  const now = new Date()
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

function DataSettings(): React.JSX.Element {
  const [busy, setBusy] = useState<string | null>(null)
  const [result, setResult] = useState<PlaylistImportResult | null>(null)

  const doExport = (): void => {
    setBusy('export')
    void exportPlaylists(requireClient())
      .then((data) => {
        // 写盘交给主进程（渲染层没有文件系统权限）；备份就是一份 JSON 文档
        return window.songloft.files.save(
          `songloft-playlists-${dateStamp()}.json`,
          JSON.stringify(data, null, 2)
        )
      })
      .then((saved) => {
        if (saved.saved) toast('已导出', 'success', saved.path ?? undefined)
      })
      .catch((error: unknown) =>
        toast('导出失败', 'error', error instanceof Error ? error.message : undefined)
      )
      .finally(() => setBusy(null))
  }

  const doImport = (): void => {
    setBusy('import')
    setResult(null)
    void window.songloft.files
      .open()
      .then((file) => (file ? importPlaylists(requireClient(), file.name, file.contents) : null))
      .then((imported) => {
        if (!imported) return
        setResult(imported)
        toast(
          '导入完成',
          'success',
          `新建 ${imported.playlists_created} 个歌单 · 匹配 ${imported.songs_matched} 首歌`
        )
      })
      .catch((error: unknown) =>
        toast('导入失败', 'error', error instanceof Error ? error.message : undefined)
      )
      .finally(() => setBusy(null))
  }

  return (
    <>
      <Card title="歌单备份">
        <Row title="导出歌单" desc="把全部歌单连歌曲关系导出成一份 JSON，可用于换服务器或留档">
          <button
            type="button"
            className="btn"
            data-variant="success"
            disabled={busy === 'export'}
            onClick={doExport}
          >
            {busy === 'export' ? <IconLoader size={15} /> : <IconDownload size={15} />}
            导出
          </button>
        </Row>

        <Row title="导入歌单" desc="从备份 JSON 恢复；同名歌单并入已有，不会重复创建">
          <button type="button" className="btn" disabled={busy === 'import'} onClick={doImport}>
            {busy === 'import' ? <IconLoader size={15} /> : <IconUpload size={15} />}
            导入
          </button>
        </Row>

        {result ? (
          <Row
            block
            title="上次导入结果"
            desc="同名歌单按「并入」处理，所以「合并」那一项通常不为零"
          >
            <div className="stat-list">
              <div className="stat-row">
                <span>新建歌单</span>
                <span className="stat-row-value">{result.playlists_created}</span>
              </div>
              <div className="stat-row">
                <span>合并歌单</span>
                <span className="stat-row-value">{result.playlists_merged}</span>
              </div>
              <div className="stat-row">
                <span>新增歌曲</span>
                <span className="stat-row-value">{result.songs_created}</span>
              </div>
              <div className="stat-row">
                <span>匹配到已有歌曲</span>
                <span className="stat-row-value">{result.songs_matched}</span>
              </div>
              <div className="stat-row">
                <span>跳过</span>
                <span className="stat-row-value">{result.songs_skipped}</span>
              </div>
            </div>
          </Row>
        ) : null}
      </Card>
    </>
  )
}

/* ───────────────────────────── 账号 ───────────────────────────── */

function AccountSettings(): React.JSX.Element {
  const { baseUrl, serverName, username, status, logout, openLogin } = useAuth()
  const [probe, setProbe] = useState<ServerProbeResult | null>(null)
  const [probing, setProbing] = useState(false)

  /**
   * 探一次服务器。
   * `announce` 只给手动点「测试连接」用：进页面时那次是自动的，不该弹提示 ——
   * 每次切到这一页都冒一条 toast 是噪音。
   */
  const runProbe = useCallback(
    async (announce = false): Promise<void> => {
      if (!baseUrl) return
      setProbing(true)
      try {
        const next = await window.songloft.servers.probe(baseUrl)
        setProbe(next)
        if (announce) {
          if (next.ok) {
            const level = latencyLevel(next.elapsedMs)
            toast('连接正常', 'success', `${next.elapsedMs}ms · ${level.label}`)
          } else {
            toast('连接失败', 'error', next.error ?? undefined)
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : '探测失败'
        setProbe({ ok: false, version: null, healthy: false, error: message, elapsedMs: 0 })
        if (announce) toast('连接失败', 'error', message)
      } finally {
        setProbing(false)
      }
    },
    [baseUrl]
  )

  // 进页面自动探一次：版本号与连接耗时就是「已连接」这个状态的展示内容，
  // 不该等用户先点一下「测试连接」才肯出现。
  useEffect(() => {
    void runProbe()
  }, [runProbe])

  // probe 结果是「此刻能不能连上」的可信来源；还没探完时退回登录态判断，
  // 免得刚进页面就闪一下「断开链接」。
  const connected = probe ? probe.ok : status === 'authenticated'
  // 版本号走 formatVersion：后端发版返回值自带 `v`，再拼一个就成了 vv2.13.1
  const version = probe?.version ? formatVersion(probe.version) : null
  // 耗时单独做成带分级的标签，比混在「v2.13.1 · 42ms」里更容易看出快慢
  const latency = probe && probe.ok && probe.elapsedMs > 0 ? latencyLevel(probe.elapsedMs) : null

  return (
    <>
      <Card title="账号管理">
        <Row
          title={
            <>
              {serverName ?? baseUrl ?? '未配置服务器'}
              {connected ? (
                <>
                  {version ? <span className="setting-row-meta">{version}</span> : null}
                  {latency ? (
                    <span className="badge setting-row-tag" data-tone={latency.tone}>
                      {probe?.elapsedMs}ms · {latency.label}
                    </span>
                  ) : null}
                </>
              ) : (
                <span className="setting-row-meta" data-tone="danger">
                  断开链接
                </span>
              )}
            </>
          }
          desc={
            baseUrl
              ? `服务器地址 ${baseUrl}${!connected && probe?.error ? ` · ${probe.error}` : ''}`
              : '尚未连接任何服务器'
          }
        >
          <button
            type="button"
            className="btn"
            disabled={!baseUrl || probing}
            onClick={() => void runProbe(true)}
          >
            {probing ? <IconLoader size={15} /> : <IconServer size={15} />}
            测试连接
          </button>
        </Row>

        <Row title={username ?? '未知账号'} desc="当前登录账号，凭据保存在本机">
          <div className="row" style={{ gap: 6 }}>
            <button type="button" className="btn" data-size="sm" onClick={openLogin}>
              切换账号
            </button>
            <button
              type="button"
              className="btn"
              data-size="sm"
              data-variant="danger"
              onClick={() => {
                if (window.confirm('退出登录？')) void logout()
              }}
            >
              <IconLogout size={15} />
              退出登录
            </button>
          </div>
        </Row>
      </Card>
    </>
  )
}

/* ───────────────────────────── 快捷键 ───────────────────────────── */

function ShortcutsSettings(): React.JSX.Element {
  return (
    <Card title="快捷键">
      <Row title="Ctrl / Cmd + K" desc="打开命令面板：搜索歌曲、跳转页面、控制播放">
        <span className="badge">全局</span>
      </Row>
      <Row
        title="Ctrl / Cmd + ,"
        desc="打开设置（走应用菜单的加速键，窗口无边框看不到菜单栏，键仍在）"
      >
        <span className="badge">全局</span>
      </Row>
      <Row title="空格" desc="播放 / 暂停（输入框内不生效）">
        <span className="badge">播放</span>
      </Row>
      <Row title="Ctrl / Cmd + ← →" desc="上一首 / 下一首">
        <span className="badge">播放</span>
      </Row>
      <Row title="↑ / ↓" desc="音量增减 5%">
        <span className="badge">播放</span>
      </Row>
      <Row title="f" desc="收藏 / 取消收藏当前曲目（输入框内不生效）">
        <span className="badge">收藏</span>
      </Row>
      <Row title="Ctrl / Cmd + L" desc="打开歌词面板；再按一次收起">
        <span className="badge">面板</span>
      </Row>
      <Row title="Esc" desc="收起满窗播放（点底栏那颗封面进去的那一层）">
        <span className="badge">面板</span>
      </Row>
      <Row title="Ctrl / Cmd + F" desc="聚焦到搜索框">
        <span className="badge">导航</span>
      </Row>
      <Row title="Alt + ←" desc="返回上一页">
        <span className="badge">导航</span>
      </Row>
      <Row
        title="媒体键 / 托盘"
        desc="键盘上的播放暂停、上一首、下一首键直接接管；最小化到托盘后仍可控制"
      >
        <IconSliders size={15} />
      </Row>
    </Card>
  )
}

/* ───────────────────────────── 关于与更新 ───────────────────────────── */

/** 关于页要打开的两个项目地址：本仓库在前，上游原项目在后 */
const ABOUT_LINKS: { href: string; label: string }[] = [
  { href: REPO_URL, label: '本仓库' },
  { href: UPSTREAM_URL, label: '原项目' }
]

/**
 * 日志等级的可选项。
 *
 * 文案照原播放器：这四个名字光看是分不出方向的 —— Debug 要说明「详细，调试用」，
 * Info 要说明「默认」，否则用户不知道该往哪边调。
 */
const LOG_LEVEL_OPTIONS: SelectOption<LogLevel>[] = [
  { value: 'debug', label: 'Debug', desc: '详细，调试用' },
  { value: 'info', label: 'Info', desc: '默认' },
  { value: 'warn', label: 'Warn', desc: '只记警告与错误' },
  { value: 'error', label: 'Error', desc: '仅错误' }
]

function logLevelLabel(level: LogLevel): string {
  const option = LOG_LEVEL_OPTIONS.find((item) => item.value === level)
  return option ? `${option.label}（${option.desc}）` : level
}

/**
 * 日志。
 *
 * 两项都作用于**服务端**，这点必须在文案里说清：
 *   * 等级是后端 slog 的全局等级 —— 改了对所有客户端生效，且即时生效（不用重启后端）；
 *   * 导出的是后端落盘的日志（最近 10 MiB，逐行脱敏后是纯文本），供提 issue 时附上。
 *
 * 桌面端自己不落盘日志，所以这里没有「客户端日志」这一项 —— 与其在文案里含糊，不如说清。
 */
function LogSettings(): React.JSX.Element {
  const level = useAsync(() => getLogLevel(requireClient()), [])
  const [exporting, setExporting] = useState(false)

  const doExport = (): void => {
    setExporting(true)
    void exportServerLogs(requireClient())
      // 写盘交给主进程（渲染层没有文件系统权限）。后端返回的就是纯文本正文，不需要解包
      .then((text) =>
        window.songloft.files.save(
          `songloft-backend-logs-${dateStamp().replace(/-/g, '')}.log`,
          text
        )
      )
      .then((saved) => {
        if (saved.saved) toast('已导出后端日志', 'success', saved.path ?? undefined)
      })
      .catch((error: unknown) =>
        toast('导出日志失败', 'error', error instanceof Error ? error.message : undefined)
      )
      .finally(() => setExporting(false))
  }

  return (
    <Card title="日志">
      <Row
        server
        title="日志等级"
        desc={
          level.error
            ? `读取失败：${level.error}`
            : '后端日志的详细程度，对所有客户端生效；调高只是多写字，不影响播放与扫描'
        }
      >
        <SettingSelect
          ariaLabel="日志等级"
          width={150}
          value={level.data ?? 'info'}
          options={LOG_LEVEL_OPTIONS}
          disabled={level.loading}
          onChange={(next) => {
            void setLogLevel(requireClient(), next)
              .then((saved) => {
                level.reload()
                toast(`日志等级已切换为 ${logLevelLabel(saved)}`, 'success')
              })
              .catch((error: unknown) =>
                toast(
                  '切换日志等级失败',
                  'error',
                  error instanceof Error ? error.message : undefined
                )
              )
          }}
        />
      </Row>

      <Row
        server
        title="导出日志"
        desc="把后端最近 10 MiB 日志脱敏后导出成文本文件（token、密钥、内网地址之类会抹掉），提 issue 时附上它"
      >
        <button type="button" className="btn" disabled={exporting} onClick={doExport}>
          {exporting ? <IconLoader size={15} /> : <IconDownload size={15} />}
          导出日志
        </button>
      </Row>
    </Card>
  )
}

function AboutSettings(): React.JSX.Element {
  const { backendVersion, guest } = useAuth()
  const info = useAsync<AppInfo>(() => window.songloft.app.info(), [])

  /** 运行信息。**「后端版本」不在这里** —— 它要有后端才有得报，免登录时单独收掉（见下面） */
  const rows: [string, string][] = info.data
    ? [
        ['应用版本', formatVersion(info.data.version)],
        ['Electron', info.data.electron],
        ['Chromium', info.data.chrome],
        ['Node', info.data.node],
        ['平台', info.data.platform],
        [
          '运行方式',
          info.data.packaged ? (info.data.appImage ? 'AppImage' : '已安装包') : '开发模式'
        ]
      ]
    : []

  return (
    <>
      {/* 顺序照原播放器的「关于与更新」分类：先更新、再日志，最后才是关于本身 */}
      <UpdateCard />
      {/* 日志两项都作用于服务端（见 LogSettings 的注释）：免登录时整卡不挂，读等级的请求也就不会发 */}
      {guest ? null : <LogSettings />}

      <Card title="关于">
        <Row
          title="这是什么"
          desc="songloft-player 的 Electron 桌面重写版：只做桌面端，用一套 Web 技术栈换取更小的体积与更顺的宽屏布局。数据与后端协议完全沿用原项目。"
        >
          <div className="row" style={{ gap: 8 }}>
            {ABOUT_LINKS.map(({ href, label }) => (
              <button
                key={href}
                type="button"
                className="btn"
                data-size="sm"
                onClick={() => void window.songloft.shell.openExternal(href)}
              >
                <IconExternal size={14} />
                {label}
              </button>
            ))}
          </div>
        </Row>

        {info.loading ? (
          <Row title="正在读取运行信息…">
            <IconLoader size={16} />
          </Row>
        ) : (
          <>
            {rows.map(([label, value]) => (
              <Row
                key={label}
                title={label}
                desc={<span className="mono selectable">{value}</span>}
              >
                <span />
              </Row>
            ))}
            {/* 后端版本：要有后端才有得报。它不是服务端「设置」（不打徽标），所以在这里单独收掉 */}
            {guest ? null : (
              <Row
                title="后端版本"
                desc={<span className="mono selectable">{formatVersion(backendVersion)}</span>}
              >
                <span />
              </Row>
            )}
          </>
        )}
      </Card>
    </>
  )
}

/**
 * 更新。
 *
 * 服务端那条开弹窗（UpgradeModal）：检查 → 选通道 → 在线升级或上传二进制 → 盯进度，
 * 这一整套塞不进一行设置里。客户端那条只给一个发布页入口 —— 桌面端由安装包 / 包管理器更新，
 * 应用不该去换自己的二进制（换到一半失败，用户手上就剩一个跑不起来的东西）。
 */
function UpdateCard(): React.JSX.Element {
  const { settings, patch } = useSettings()
  const guest = useAuth((s) => s.guest)
  const [upgradeOpen, setUpgradeOpen] = useState(false)
  const [clientOpen, setClientOpen] = useState(false)

  return (
    <Card title="更新">
      {/* 「服务端更新」免登录时整行不摆：没有服务端可升级，而它下面每一次请求都要会话 */}
      {guest ? null : (
        <Row
          title="服务端更新"
          desc="检查服务端有没有新版本；Docker 部署可以直接在线升级，也可以上传本地的二进制文件"
        >
          <button
            type="button"
            className="btn"
            data-variant="primary"
            onClick={() => setUpgradeOpen(true)}
          >
            <IconRefresh size={15} />
            检查更新
          </button>
        </Row>
      )}

      <Row
        title="客户端更新"
        desc="桌面端从 GitHub Releases 分发：应用不会自己替换自身的二进制，有新版本时到发布页下载，或由包管理器升级"
      >
        <button type="button" className="btn" onClick={() => setClientOpen(true)}>
          <IconRefresh size={15} />
          检查更新
        </button>
      </Row>

      {/* 不再挂在「客户端更新」下面：它管的是上面**两行**（服务端与客户端各查一次） */}
      <Row
        title="启动时自动检查更新"
        desc="每次启动各查一次服务端与客户端：有新版本才提示，连不上就不出声"
      >
        <Switch
          checked={settings.autoCheckUpdate}
          onChange={(next) => void patch({ autoCheckUpdate: next })}
          ariaLabel="启动时自动检查更新"
        />
      </Row>

      {upgradeOpen ? <UpgradeModal onClose={() => setUpgradeOpen(false)} /> : null}
      {clientOpen ? <ClientUpdateModal onClose={() => setClientOpen(false)} /> : null}
    </Card>
  )
}

/**
 * 客户端更新（桌面端自己）。
 *
 * 只报「有没有新版本」并把发布页交出去 —— 不做下载、不做安装。理由是桌面端的二进制归安装包
 * 与包管理器管：应用替自己换二进制一旦半路失败（下载中断、目录不可写、替换到一半），用户手上
 * 就剩一个跑不起来的客户端，而且那一套流程**没有回滚**（见 src/main/release.ts 的注释）。
 */
function ClientUpdateModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  // 本机版本走 app.info：它是本地的、必定拿得到，于是检查失败时这张表也不会空着
  const info = useAsync(() => window.songloft.app.info(), [])
  const [check, setCheck] = useState<ClientUpdateCheck | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [checking, setChecking] = useState(true)

  useEffect(() => {
    // 代理从后端读，但**读不到也照查**：客户端更新不该被后端可达性牵连，直连 GitHub 试一次。
    // ★ 取代理那一步得先包进 Promise 里再调用：没有会话时 `requireClient()` 是**同步抛**的，
    //   直接 `getGithubProxy(requireClient())` 会抛在 effect 里、把整棵组件树掀掉 —— 而免登录
    //   模式下这一页是能进来的（见 SettingsPage 的 guest 过滤）。包进去之后它变成「读不到」，
    //   落到下面那个 catch 上，正好就是这句注释本来要的意思。
    void Promise.resolve()
      .then(() => {
        const client = requireClient()
        // 两项代理都要：GitHub 加速前缀决定走哪条通路，HTTP 代理要由主进程探一次 TCP
        // 才知道本机能不能用（它们是服务端设置，客户端未必连得到）
        return Promise.all([
          getGithubProxy(client).catch(() => ''),
          getHttpProxy(client).catch(() => '')
        ])
      })
      .then(([githubProxy, httpProxy]) =>
        window.songloft.app.checkClientUpdate({ githubProxy, httpProxy })
      )
      .then(setCheck)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : '检查更新失败'))
      .finally(() => setChecking(false))
  }, [])

  const current = info.data?.version ?? ''
  const newer = check !== null && isNewerVersion(check.latestTag, current)
  const released = formatDate(check?.publishedAt)

  return (
    <Modal
      title="客户端更新"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            关闭
          </button>
          {/* 检查失败时也给这条路：网络能到发布页而查不到 API 是常见情形（代理只挑了 API） */}
          <button
            type="button"
            className="btn"
            data-variant="primary"
            onClick={() =>
              void window.songloft.shell.openExternal(check?.latestUrl || REPO_RELEASES_URL)
            }
          >
            <IconExternal size={15} />
            打开发布页
          </button>
        </>
      }
    >
      {/* 当前版本永远有：它来自本机，不必等网络 */}
      <div className="stat-list">
        <div className="stat-row">
          <span>当前版本</span>
          <span className="stat-row-value">{formatVersion(current)}</span>
        </div>
        {check?.latestTag ? (
          <div className="stat-row">
            <span>最新版本</span>
            <span className="stat-row-value">{formatVersion(check.latestTag)}</span>
          </div>
        ) : null}
        {released ? (
          <div className="stat-row">
            <span>发布时间</span>
            <span className="stat-row-value">{released}</span>
          </div>
        ) : null}
      </div>

      <div className="probe-result" data-state={error ? 'error' : 'ok'} style={{ marginTop: 10 }}>
        {error ? (
          <IconAlert size={15} />
        ) : checking ? (
          <IconLoader size={15} />
        ) : newer ? (
          <IconSparkle size={15} />
        ) : (
          <IconCheck size={15} />
        )}
        <span>
          {error ??
            (checking
              ? '正在检查 GitHub 上的最新版本…'
              : newer
                ? `有新版本 ${formatVersion(check?.latestTag ?? '')}，到发布页下载`
                : '已经是最新版本')}
        </span>
      </div>

      {check && (check.route === 'proxy-fallback' || check.httpProxyUnreachable) ? (
        <p className="field-hint" style={{ marginTop: 10 }}>
          服务端配的代理在本机用不上（HTTP 代理探不通，或加速前缀连不上），这次已改为直连。
        </p>
      ) : null}

      <p className="field-hint" style={{ marginTop: 10 }}>
        桌面端由安装包 / 包管理器分发，应用不会去替换自身的二进制 ——
        换到一半失败会留下一个跑不起来的客户端， 而且没有回滚。所以这里只负责告诉你有新版本。
      </p>
    </Modal>
  )
}

/* ───────────────────────── 服务端升级弹窗 ───────────────────────── */

/** 进度状态 → 文案。取值见 ServerUpgradeProgress */
const UPGRADE_STATUS_LABEL: Record<string, string> = {
  idle: '空闲',
  uploading: '正在上传',
  downloading: '正在下载升级包',
  testing: '正在校验',
  replacing: '正在替换二进制',
  resetting: '正在回退',
  restarting: '正在重启服务',
  failed: '升级失败'
}

/**
 * 「已经收工」的状态。
 *
 * ★ 协议里**没有** completed —— 后端换完二进制就 exit(0) 交给容器重启，那一帧的 status 是
 *   restarting。拿 completed 当完成判据会永远等不到。
 */
const UPGRADE_DONE_STATUS = new Set(['restarting', 'completed'])

/** 通道名（后端给的是 stable / dev） */
function channelLabel(channel: string): string {
  if (channel === 'stable') return '正式版'
  if (channel === 'dev') return '测试版'
  return channel || '未知通道'
}

/**
 * 服务端升级。
 *
 * 两条路：让服务端自己去 GitHub 拉（Docker 部署可用），或者把本地那份二进制传上去。
 * 上传刻意分两段（上传校验 → 确认替换）：先让服务端把文件读一遍、把版本与通道报回来，
 * 由人确认「这确实是我要装的那份」，再落地。跨通道升级尤其需要这一道 —— 装错了会把通道切过去。
 */
function UpgradeModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [check, setCheck] = useState<ServerUpgradeCheck | null>(null)
  const [checking, setChecking] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState(0)
  /** 上传完成、等着人确认的那份文件 */
  const [uploaded, setUploaded] = useState<UploadedServerBinary | null>(null)
  const [uploadPercent, setUploadPercent] = useState<number | null>(null)
  const [starting, setStarting] = useState(false)
  const [progress, setProgress] = useState<ServerUpgradeProgress | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const pollRef = useRef<number | null>(null)
  /** GitHub 代理：检查与升级都得显式带给后端（后端不会去读自己存的那份配置） */
  const proxyRef = useRef('')

  const runCheck = useCallback((): void => {
    setChecking(true)
    setError(null)
    // 已经收工的进度（失败 / 重启完）别再占着版面：重新检查就是要回到「能不能升」这一页，
    // 但**正在跑**的那份要留着 —— 打开弹窗时它会先被拉回来，清掉就等于把进度抹了
    setProgress((prev) =>
      prev && (UPGRADE_DONE_STATUS.has(prev.status) || prev.status === 'failed') ? null : prev
    )
    void checkServerUpgrade(requireClient(), proxyRef.current)
      .then((next) => {
        setCheck(next)
        setSelected(0)
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : '检查更新失败'))
      .finally(() => setChecking(false))
  }, [])

  useEffect(() => {
    // 升级可能是上次打开弹窗时起的（甚至是别的客户端起的）：先问一句进度，
    // 否则关掉再打开，进度条会从零开始，看着像又升了一遍
    void getServerUpgradeProgress(requireClient())
      .then((next) => {
        if (next.status !== 'idle') setProgress(next)
      })
      .catch(() => undefined)
    // 代理取回来再查：墙内没有它，/upgrade/check 会一直等到超时（后端不会自动读那项配置）
    void getGithubProxy(requireClient())
      .catch(() => '')
      .then((value) => {
        proxyRef.current = value
        runCheck()
      })
  }, [runCheck])

  const status = progress?.status ?? 'idle'
  const done = UPGRADE_DONE_STATUS.has(status)
  const failed = status === 'failed'
  const running = progress !== null && !done && !failed
  const busy = checking || starting || uploadPercent !== null || running

  // 只要还在跑就一直问，1 秒一次：后端那几步都是秒级推进，再密没必要
  useEffect(() => {
    if (!running) return
    pollRef.current = window.setInterval(() => {
      void getServerUpgradeProgress(requireClient())
        .then((next) => {
          // idle 是「还没开始」：刚点完升级时后端还在调度，丢掉这一帧，别把进度打回去
          if (next.status !== 'idle') setProgress(next)
        })
        // 升级成功后服务端会 exit，重启那几秒连不上是正常的，别把弹窗画成失败
        .catch(() => undefined)
    }, 1000)
    return () => {
      if (pollRef.current !== null) {
        window.clearInterval(pollRef.current)
        pollRef.current = null
      }
    }
  }, [running])

  const targets = check?.updates ?? []
  /*
   * 老后端只给扁平的 latest_version / release_notes（没有 updates）。那时退回一条，
   * 通道按 stable 走 —— 后端自己挑扁平字段时也是「优先 stable，其次 dev」。
   */
  const fallback: ServerUpdateTarget[] =
    check?.has_update && check.latest_version
      ? [{ type: 'stable', version: check.latest_version, release_notes: check.release_notes }]
      : []
  const list = targets.length > 0 ? targets : fallback
  const target = list[selected] ?? list[0]

  const canUpload = (check?.is_docker ?? true) && !busy && progress === null
  const canStartOnline =
    Boolean(check?.is_docker && check.has_update && target) && !busy && progress === null

  const onFile = (event: React.ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0]
    // 清掉 value：同一个文件想再选一次时，change 也得照样触发
    event.target.value = ''
    if (!file) return
    setError(null)
    setUploaded(null)
    setUploadPercent(0)
    void uploadServerBinary(requireClient(), file, (sent, total) => {
      setUploadPercent(total > 0 ? Math.round((sent / total) * 100) : 0)
    })
      .then((info) => {
        setUploaded(info)
        toast('已上传，等待确认', 'success', info.version ? formatVersion(info.version) : undefined)
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : '上传失败'))
      .finally(() => setUploadPercent(null))
  }

  const startOnline = (): void => {
    if (!target) return
    setStarting(true)
    setError(null)
    void startServerUpgrade(requireClient(), target.type, proxyRef.current)
      .then(() =>
        setProgress({
          status: 'downloading',
          progress: 0,
          current_step: '已请求升级，等待服务端开始'
        })
      )
      .catch((err: unknown) => setError(err instanceof Error ? err.message : '升级请求失败'))
      .finally(() => setStarting(false))
  }

  const confirmUpload = (): void => {
    setStarting(true)
    setError(null)
    void confirmServerUploadUpgrade(requireClient())
      .then(() => {
        setUploaded(null)
        setProgress({ status: 'replacing', progress: 0, current_step: '已确认，正在替换二进制' })
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : '确认失败'))
      .finally(() => setStarting(false))
  }

  const body = (): React.ReactNode => {
    if (uploaded) {
      return (
        <>
          <div className="probe-result" data-state={uploaded.channel_mismatch ? 'error' : 'ok'}>
            {uploaded.channel_mismatch ? <IconAlert size={15} /> : <IconCheck size={15} />}
            <span>
              已上传 {channelLabel(uploaded.channel)} {formatVersion(uploaded.version)}
              {uploaded.build_type ? ` · ${uploaded.build_type}` : ''}
            </span>
          </div>
          <p className="field-hint" style={{ marginTop: 8 }}>
            {uploaded.channel_mismatch
              ? `这份文件走 ${channelLabel(uploaded.channel)} 通道，而服务端现在跑的是 ${channelLabel(
                  uploaded.current_channel
                )}（${formatVersion(uploaded.current_version)}）—— 装上去会把通道一起切过去。`
              : `服务端现在是 ${formatVersion(uploaded.current_version)}，确认后替换并重启。`}
          </p>
          {uploaded.build_time ? (
            <p className="field-hint" style={{ marginTop: 6 }}>
              文件构建时间 {uploaded.build_time}
            </p>
          ) : null}
        </>
      )
    }

    if (progress) {
      const percent = Math.min(100, Math.max(0, progress.progress))
      return (
        <>
          <div className="stat-list">
            <div className="stat-row">
              <span>状态</span>
              <span className="stat-row-value">{UPGRADE_STATUS_LABEL[status] ?? status}</span>
            </div>
            <div className="stat-row">
              <span>进度</span>
              <span className="stat-row-value">{Math.round(percent)}%</span>
            </div>
          </div>
          <div className="progress-track" style={{ marginTop: 10 }}>
            <div
              className="progress-fill"
              data-tone={failed ? 'danger' : undefined}
              style={{ width: `${percent}%` }}
            />
          </div>
          {progress.current_step ? (
            <p className="field-hint" style={{ marginTop: 8 }}>
              {progress.current_step}
            </p>
          ) : null}
          {done ? (
            <p className="field-hint" style={{ marginTop: 8 }}>
              服务端正在重启，界面会短暂连不上，稍后自动恢复。
            </p>
          ) : null}
          {running ? (
            <p className="field-hint" style={{ marginTop: 8 }}>
              升级在服务端后台进行，关掉这个弹窗不会中断它。
            </p>
          ) : null}
        </>
      )
    }

    if (checking) {
      return (
        <div className="probe-result">
          <IconLoader size={15} />
          <span>正在检查服务端版本…</span>
        </div>
      )
    }

    if (!check) return null

    return (
      <>
        <div className="stat-list">
          <div className="stat-row">
            <span>当前版本</span>
            <span className="stat-row-value">
              {formatVersion(check.current_version)}
              {check.current_channel ? ` · ${channelLabel(check.current_channel)}` : ''}
            </span>
          </div>
          <div className="stat-row">
            <span>部署方式</span>
            <span className="stat-row-value">{check.current_build_type || '未知'}</span>
          </div>
        </div>

        {list.length === 0 ? (
          <p className="field-hint" style={{ marginTop: 8 }}>
            已是最新版本。
          </p>
        ) : (
          <>
            <div className="segmented" role="group" aria-label="升级通道" style={{ marginTop: 10 }}>
              {list.map((item, index) => (
                <button
                  key={item.type}
                  type="button"
                  aria-pressed={selected === index}
                  onClick={() => setSelected(index)}
                >
                  {channelLabel(item.type)} {formatVersion(item.version)}
                </button>
              ))}
            </div>
            {target?.release_notes ? (
              <div className="notes-block">{target.release_notes}</div>
            ) : null}
            {target?.build_time ? (
              <p className="field-hint" style={{ marginTop: 8 }}>
                文件构建时间 {target.build_time}
              </p>
            ) : null}
          </>
        )}

        {!check.is_docker ? (
          <p className="field-hint" style={{ marginTop: 8 }}>
            服务端不是 Docker 部署：在线升级与上传都用不了，到发布页拿新版本、在服务器上替换二进制。
          </p>
        ) : null}
      </>
    )
  }

  const footer = uploaded ? (
    <>
      <button type="button" className="btn" disabled={starting} onClick={() => setUploaded(null)}>
        取消
      </button>
      <button
        type="button"
        className="btn"
        data-variant="danger"
        disabled={starting}
        onClick={confirmUpload}
      >
        {starting ? <IconLoader size={15} /> : <IconUpload size={15} />}
        确认升级
      </button>
    </>
  ) : (
    <>
      {/* 升级是服务端的后台任务，关掉弹窗不会中断它 —— 所以关闭永远可用，别把人锁在里面 */}
      <button type="button" className="btn" onClick={onClose}>
        关闭
      </button>
      {canUpload ? (
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={() => fileRef.current?.click()}
        >
          {uploadPercent === null ? <IconUpload size={15} /> : <IconLoader size={15} />}
          {uploadPercent === null ? '上传升级' : `上传中 ${uploadPercent}%`}
        </button>
      ) : null}
      {canStartOnline ? (
        <button
          type="button"
          className="btn"
          data-variant="primary"
          disabled={busy}
          onClick={startOnline}
        >
          {starting ? <IconLoader size={15} /> : <IconDownload size={15} />}
          立即升级
        </button>
      ) : null}
      {error !== null || failed ? (
        <button type="button" className="btn" disabled={busy} onClick={runCheck}>
          <IconRefresh size={15} />
          重新检查
        </button>
      ) : null}
    </>
  )

  return (
    <Modal title="服务端更新" onClose={onClose} closeOnBackdrop={!busy} footer={footer}>
      {error ? (
        <div className="probe-result" data-state="error" style={{ marginBottom: 12 }}>
          <IconAlert size={15} />
          <span>{error}</span>
        </div>
      ) : null}

      {body()}

      {/* 选文件必须由点击直接触发，所以这个 input 一直挂着、只是看不见 */}
      <input ref={fileRef} type="file" hidden onChange={onFile} />
    </Modal>
  )
}
