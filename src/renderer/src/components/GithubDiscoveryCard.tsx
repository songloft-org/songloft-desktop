/**
 * 「GitHub 发现」里的一张卡片。
 *
 * 与商店卡片（PluginStore 的 StoreCard）共用同一套 `.store-card` 类名，形态刻意保持一致：
 * 同一个列表里两种长相会让人以为它们是两种东西。
 *
 * 不同的只有信息本身的来源：
 *   * 没有服务端代理来的图标（仓库里没有登记图标名），所以一律走首字母兜底图；
 *   * 来源那一格写的是**仓库**，底行给「源码 / 发布」两个链接 —— 社区插件唯一能查证的
 *     就是这两处；
 *   * 申请的权限放在悬停提示里：它是安装前该看的东西，但铺在卡片上会把描述挤没。
 */

import type { DiscoveryInstallState, GithubDiscoveryPlugin } from '@shared/github-discovery'
import type { JSPlugin } from '@shared/plugin'
import { IconDownload, IconLoader, IconRefresh } from './Icons'
import { PluginIconFallback } from './PluginIcon'

interface Action {
  label: string
  /** 无障碍名。只有「⟳ v1.2.3」这一档看不出动词，才需要另给一句 */
  ariaLabel?: string
  variant?: 'primary' | 'danger'
  tone?: 'accent' | 'danger'
  tip?: string
  /** 用「⟳」而不是「⤓」：说的是「把这一版重新装一遍」，不是从商店下载 */
  refresh?: boolean
  /** 按钮本身不可点（不兼容 / 已经装了这一版且没有新版 —— 后者按商店的语义仍可重装） */
  disabled: boolean
}

/**
 * 五档文案。
 *
 * ★ 顺序与商店那张卡一致（撞名优先于「已装」，不兼容又拦在最前）；`update` 说的是**它会变成
 *   哪个版本**（清单里那个），不是本机现在这个 —— 后者正是 `installedVersion`。
 */
function describeAction(state: DiscoveryInstallState, targetVersion: string): Action {
  switch (state.action) {
    case 'blocked':
      return { label: '不兼容', disabled: true, tip: '先升级连接的服务器' }
    case 'overwrite':
      return { label: '覆盖安装', variant: 'danger', tone: 'danger', disabled: false }
    case 'update':
      return { label: `更新至 v${targetVersion || '—'}`, tone: 'accent', disabled: false }
    case 'reinstall':
      return {
        label: `v${state.installedVersion || '—'}`,
        ariaLabel: `重新安装 v${state.installedVersion || '—'}`,
        tip: '重新安装',
        refresh: true,
        disabled: false
      }
    default:
      return { label: '安装', variant: 'primary', disabled: false }
  }
}

export interface GithubDiscoveryCardProps {
  plugin: GithubDiscoveryPlugin
  /** 本机装着的那一份（同源 / 撞名都在 discoveryInstallState 里判好了） */
  state: DiscoveryInstallState
  pending: boolean
  /** 别的卡片正在装（同一时刻只允许一个） */
  disabled: boolean
  onInstall: () => void
}

export function GithubDiscoveryCard({
  plugin,
  state,
  pending,
  disabled,
  onInstall
}: GithubDiscoveryCardProps): React.JSX.Element {
  const { repository, manifest } = plugin
  const name = manifest.name
  const action = describeAction(state, manifest.version)
  const repositoryUrl = `https://github.com/${repository.fullName}`

  return (
    <li className="store-card">
      <div className="store-card-top">
        <PluginIconFallback name={name} size={40} />

        <span className="store-card-name truncate" title={name}>
          {name}
        </span>

        <button
          type="button"
          className="btn store-card-action"
          data-size="sm"
          data-variant={action.variant}
          aria-label={action.ariaLabel}
          data-tip={action.tip}
          disabled={pending || disabled || action.disabled}
          onClick={onInstall}
        >
          {pending ? (
            <IconLoader size={14} />
          ) : action.refresh ? (
            <IconRefresh size={14} />
          ) : (
            <IconDownload size={14} />
          )}
          {action.label}
        </button>
      </div>

      <p className="store-card-desc">{manifest.description || '暂无描述'}</p>

      <div className="store-card-tags">
        {/*
          来源标签摆在最前，与商店卡片上那个订阅源名（`sourceName`）同一格、同一样式：
          搜索把两半来源混排进同一个网格，而卡片的形态又刻意做得一模一样 —— 不标出来，
          哪些是「社区仓库里发现、未经审核」的就分不清了（那句话的免责也就不指向任何一张卡）。
        */}
        <span className="badge">GitHub 发现</span>
        {/* 仓库名在底行；这里给最容易被拿来比较的那两项：热度与申请了多少权限 */}
        <span className="badge">★ {repository.stars}</span>
        {action.tone ? (
          <span className="badge" data-tone={action.tone}>
            {state.action === 'overwrite' ? '入口冲突' : '有新版本'}
          </span>
        ) : null}
        <span
          className="badge"
          data-tip={
            manifest.permissions.length
              ? `申请的权限：${manifest.permissions.join('、')}`
              : '没有申请额外权限'
          }
        >
          权限 {manifest.permissions.length}
        </span>
        <span className="store-card-code truncate" title={manifest.entryPath}>
          {manifest.entryPath}
        </span>
      </div>

      {state.action === 'overwrite' && state.occupant ? (
        <p className="store-card-note">已被 {occupantName(state.occupant)} 占用，安装会替换它</p>
      ) : null}

      {state.action === 'blocked' ? (
        <p className="store-card-note">需要服务器 {manifest.minHostVersion} 或更高版本</p>
      ) : null}

      <div className="store-card-foot">
        <span className="truncate" title={repository.fullName}>
          {repository.fullName}
        </span>
        {/* 外链交给系统浏览器：渲染层自己开窗会被主进程的导航围栏拦下（见 main/windows.ts） */}
        <button
          type="button"
          className="link"
          onClick={() => void window.songloft.shell.openExternal(repositoryUrl)}
        >
          源码
        </button>
        <button
          type="button"
          className="link"
          onClick={() => void window.songloft.shell.openExternal(plugin.releaseUrl)}
        >
          发布
        </button>
      </div>
    </li>
  )
}

function occupantName(plugin: JSPlugin): string {
  return `${plugin.name || plugin.entryPath} v${plugin.version}`
}
