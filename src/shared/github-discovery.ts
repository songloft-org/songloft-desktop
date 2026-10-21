/**
 * 「GitHub 发现」—— 商店里除订阅源之外的那一份来源。
 *
 * GitHub 上没有注册表文件可读：插件是靠仓库里的 `plugin.json`（默认分支根目录）与
 * 它声明的 `.jsplugin.zip` release 资产自证的。所以发现由两步组成：
 *   1. 按 `topic:songloft-plugin` 搜仓库（GitHub Search API）；
 *   2. 逐个仓库把清单与 release 拉回来**核对**，对不上就过滤掉。
 *
 * 这个模块只放**纯函数**：清单 / release 的校验、URL 解析、搜索语句、以及「这一条现在该
 * 显示哪个按钮」。网络在主进程（见 main/github-discovery.ts），界面在 PluginStore ——
 * 两侧都需要的判定只有这一份，免得「后端说能装、界面说不兼容」这种漂移。
 *
 * ★ 校验的口径与插件包安装（后端 jsplugin/package.go）一致，不是「格式看着像」就行：
 *   清单里 `download_url` 指向的那个 release 必须真的存在、且**确实**挂着同名的、已上传的
 *   资产。否则列出来的东西点下去必然装不上 —— 那比少发现一个更糟。
 */

import type { JSPlugin } from './plugin'

/* ─────────────────────────────── 类型 ─────────────────────────────── */

/**
 * 一个仓库为什么没被列出来。
 *
 * 分开计数的理由：它们对用户的下一步完全不同 —— `rateLimited` 等一会儿再试，
 * `invalidToken` 要去改 Token，`invalidManifest` / `invalidRelease` 是作者那边的发布问题
 * （什么都不用做），`unavailable` 是网络。
 */
export type DiscoveryFailure =
  | 'invalidManifest'
  | 'unpublished'
  | 'invalidRelease'
  | 'unavailable'
  | 'rateLimited'
  | 'invalidToken'

export interface GithubRepository {
  id: number
  /** `owner/repo` */
  fullName: string
  defaultBranch: string
  stars: number
  updatedAt: string
}

/** `plugin.json` 的模型（字段名就是文件里的写法，别在这里改成 camelCase） */
export interface GithubPluginManifest {
  name: string
  version: string
  /** 插件路由前缀，也是「入口身份」 */
  entryPath: string
  main: string
  permissions: string[]
  entryHash: string
  zipHash: string
  description: string
  author: string
  homepage: string
  minHostVersion: string
  renderEngine: '' | 'webview' | 'lynx'
  download_url: string
  updateUrl: string
}

export interface GithubDiscoveryPlugin {
  repository: GithubRepository
  manifest: GithubPluginManifest
  /** 已核对过的 release 资产地址（安装时原样交给服务端） */
  downloadUrl: string
  /** release 页面，供「查看发布」 */
  releaseUrl: string
  publishedAt: string
}

export interface GithubDiscoveryPage {
  plugins: GithubDiscoveryPlugin[]
  /** 这一页总共看了几个仓库（含被过滤的） */
  checked: number
  failures: Partial<Record<DiscoveryFailure, number>>
  /** 下一页页码；没有更多时缺席 */
  nextPage?: number
  /** 被 GitHub 限流时，什么时候可以再试（毫秒时间戳） */
  retryAt?: number
  /** 结果不完整（翻到 GitHub 的 1000 条上限、或中途被限流） */
  incomplete: boolean
  /** GitHub 报的匹配总数（搜索接口只肯给到 1000） */
  total: number
}

export interface GithubDiscoveryRequest {
  page: number
  search: string
  sort: 'updated' | 'stars'
  /** GitHub 加速代理前缀（空串 = 直连） */
  proxy: string
  /** 服务器上保存的共享 Token（空串 = 匿名，每小时只有 60 次） */
  token: string
  /** 越过主进程那份缓存强制重拉（只给「刷新」按钮） */
  force: boolean
}

/**
 * 跨 IPC 的结果。
 *
 * ★ 不抛异常：`ipcRenderer.invoke` 跨过去只剩一句拼好的 message，`reason` 这种结构化的东西
 *   全部丢失，界面就只能弹一句「失败」。失败原因本来是要分派不同文案的。
 */
export type GithubDiscoveryResult =
  | { ok: true; page: GithubDiscoveryPage }
  | { ok: false; reason: DiscoveryFailure; message: string; retryAt?: number }

/** 一页看多少个仓库。与 GitHub Search 的 per_page 是同一个数 */
export const DISCOVERY_PAGE_SIZE = 20

/** GitHub 搜索接口最多只肯翻到第 1000 条 */
export const DISCOVERY_MAX_RESULTS = 1000

/** 发现只认这个 topic —— 作者加上它，才表示「这是一个 Songloft 插件」 */
export const DISCOVERY_TOPIC = 'songloft-plugin'

/* ─────────────────────────── 清单校验 ─────────────────────────── */

/** TextEncoder 不在每个运行环境里都有；按码点算字节，与 Go 那边的 len(string) 同口径 */
export function utf8Size(value: string): number {
  let size = 0
  for (const char of value) {
    const point = char.codePointAt(0) ?? 0
    size += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4
  }
  return size
}

/** 清单里的相对路径不许越界（`..`、绝对路径、盘符、反斜杠一律不认） */
export function safeRelativePath(value: string): boolean {
  return (
    !value.startsWith('/') &&
    !value.includes('\\') &&
    !value.includes(':') &&
    value.split('/').every((part) => part !== '..' && part !== '.')
  )
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/**
 * 校验并归一化 `plugin.json`。
 *
 * 认不出就抛 —— 调用方把它记成 `invalidManifest`，这一条不进列表。可选字段一律补空串
 * 而不是留 undefined：界面到处要拼 `v${version}`，漏一个就渲染出 `undefined`。
 */
export function parseGithubPluginManifest(value: unknown): GithubPluginManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalidManifest')
  }
  const raw = value as Record<string, unknown>
  const name = text(raw.name)
  const version = text(raw.version)
  const entryPath = text(raw.entryPath)
  const main = text(raw.main)
  const permissions = Array.isArray(raw.permissions)
    ? raw.permissions.filter((item): item is string => typeof item === 'string')
    : null

  // 名字按 UTF-8 字节限 2..50：中文名两个字节一个字，按字符数限会放过一屏装不下的名字
  if (utf8Size(name) < 2 || utf8Size(name) > 50) throw new Error('invalidManifest')
  if (!/^\d+\.\d+\.\d+/.test(version)) throw new Error('invalidManifest')
  if (!/^[a-z][a-z0-9-]*$/.test(entryPath)) throw new Error('invalidManifest')
  if (!/\.(js|jsc)$/.test(main) || !safeRelativePath(main)) throw new Error('invalidManifest')
  if (!permissions) throw new Error('invalidManifest')

  const hash = (candidate: string): string => {
    if (!candidate) return ''
    if (!/^[a-f0-9]{64}$/.test(candidate)) throw new Error('invalidManifest')
    return candidate
  }
  const engine = text(raw.renderEngine)

  return {
    name,
    version,
    entryPath,
    main,
    permissions,
    entryHash: hash(text(raw.entryHash)),
    zipHash: hash(text(raw.zipHash)),
    description: text(raw.description),
    author: text(raw.author),
    homepage: text(raw.homepage),
    minHostVersion: text(raw.minHostVersion),
    renderEngine: engine === 'webview' || engine === 'lynx' ? engine : '',
    download_url: text(raw.download_url),
    updateUrl: text(raw.updateUrl)
  }
}

/* ─────────────────────────── URL 解析 ─────────────────────────── */

/**
 * 只认我们自己那个很窄的公开 URL 语法（https + github.com / raw.githubusercontent.com）。
 *
 * 这里是**安全边界**而非便利函数：清单里写的地址会被真的请求出去，放任 `http:`、带端口、
 * 带 query 的写法等于让插件作者指挥客户端去访问任意主机。
 */
function publicRepositoryUrl(address: string): { host: string; path: string } | null {
  const match = /^https:\/\/(github\.com|raw\.githubusercontent\.com)(\/[^\s?#\\]*)$/i.exec(address)
  if (!match) return null
  try {
    // 百分号编码的点段也算越界（`%2e%2e`），所以先解码再比
    for (const segment of match[2]!.split('/')) {
      const decoded = decodeURIComponent(segment)
      if (decoded === '.' || decoded === '..' || decoded.includes('\\')) return null
    }
    return { host: match[1]!.toLowerCase(), path: match[2]! }
  } catch {
    return null
  }
}

/** 这份 URL 指向哪个仓库（`owner/repo`），认不出返回 null */
export function githubUrlRepository(address: string): string | null {
  const url = publicRepositoryUrl(address)
  if (!url) return null
  const parts = url.path.split('/')
  if (
    parts.length < 4 ||
    !/^[A-Za-z0-9_.-]+$/.test(parts[1]!) ||
    !/^[A-Za-z0-9_.-]+$/.test(parts[2]!)
  ) {
    return null
  }
  return `${parts[1]}/${parts[2]}`
}

/**
 * 这个地址是不是**该仓库自己的**清单地址（raw 或 github.com/…/raw/…）。
 *
 * 用来挡住「清单里写一个别的仓库的更新源」—— 那等于把更新权交出去，而界面还会写着
 * 这个仓库的名字。
 */
export function isRepositoryMetadataUrl(address: string, repository: string): boolean {
  const url = publicRepositoryUrl(address)
  if (!url) return false
  const path = url.path.toLowerCase()
  const repo = repository.toLowerCase()
  return (
    (url.host === 'raw.githubusercontent.com' && path.startsWith(`/${repo}/`)) ||
    (url.host === 'github.com' && path.startsWith(`/${repo}/raw/`))
  )
}

/** `.jsplugin.zip` 的 release 下载地址 → 仓库 / tag / 文件名 */
export function parseReleaseDownload(
  address: string
): { repository: string; tag: string; file: string } | null {
  const repository = githubUrlRepository(address)
  if (!repository) return null
  const download = releaseDownload(address, repository)
  return download ? { repository, ...download } : null
}

/** 这个下载地址是不是 `该仓库/releases/download/<tag>/<file>.jsplugin.zip` */
export function releaseDownload(
  address: string,
  repository: string
): { tag: string; file: string } | null {
  try {
    const url = publicRepositoryUrl(address)
    const prefix = `/${repository}/releases/download/`
    if (
      !url ||
      url.host !== 'github.com' ||
      !url.path.toLowerCase().startsWith(prefix.toLowerCase())
    ) {
      return null
    }
    const parts = url.path.slice(prefix.length).split('/')
    if (parts.length !== 2) return null
    const tag = decodeURIComponent(parts[0]!)
    const file = decodeURIComponent(parts[1]!)
    return tag && file.endsWith('.jsplugin.zip') && !file.includes('/') && !file.includes('\\')
      ? { tag, file }
      : null
  } catch {
    return null
  }
}

/** 这条插件实际是从哪个仓库发的（下载地址里的那个，允许跨仓库） */
export function downloadRepository(plugin: GithubDiscoveryPlugin): string {
  return parseReleaseDownload(plugin.downloadUrl)?.repository ?? plugin.repository.fullName
}

/* ─────────────────────────── 搜索 ─────────────────────────── */

/**
 * GitHub 搜索语句。
 *
 * 关键词只留字母数字、汉字、`.` `/` `-` 与空格（`owner/repo` 那种写法要能搜）：
 * 其余标点会被 GitHub 当成限定符（`user:` `language:`），用户打的普通词会变成过滤条件。
 */
export function discoverySearchQuery(search: string): string {
  const keyword = search
    .trim()
    .replace(/[^\w\u0080-\uffff./ -]/g, '')
    .slice(0, 100)
  return `topic:${DISCOVERY_TOPIC} archived:false fork:false${
    keyword ? ` ${keyword} in:name,description,readme` : ''
  }`
}

/** 搜索地址（排序与翻页都在 query 里） */
export function discoverySearchUrl(
  request: Pick<GithubDiscoveryRequest, 'page' | 'search' | 'sort'>
): string {
  const query = encodeURIComponent(discoverySearchQuery(request.search))
  return `https://api.github.com/search/repositories?q=${query}&sort=${request.sort}&order=desc&per_page=${DISCOVERY_PAGE_SIZE}&page=${request.page}`
}

/**
 * 关键词能不能命中这张卡片上的**身份字段**：插件名 / 入口 / 作者 / `owner/repo`。
 *
 * ★ 为什么在本地还要再比一遍：GitHub 那边只能按**仓库**的 name / description / readme 搜，
 *   而卡片上写着的是清单里的 `name`（例如仓库叫 `songloft-plugin-radio`、插件叫「电台时光」）。
 *   用户照着卡片上的名字搜，GitHub 一句都匹配不上 —— 于是「明明在列表里，搜名字却搜不到」。
 *   清单只有核对（安装发现页时会拉）之后才知道，所以这一比只能发生在客户端，而且只在
 *   **已经核对过的那些卡片**上做。
 *
 * ★ 只比身份字段，不比 `description`：描述是一整段话，拿它做子串匹配几乎什么都能命中，
 *   搜出来的列表就不再是「你要找的那个」。
 */
export function matchesDiscoveryKeyword(plugin: GithubDiscoveryPlugin, keyword: string): boolean {
  const term = keyword.trim().toLowerCase()
  if (!term) return true
  const { manifest, repository } = plugin
  return [manifest.name, manifest.entryPath, manifest.author, repository.fullName].some((field) =>
    field.toLowerCase().includes(term)
  )
}

/** 一个 issue/PR/仓库列表项 → 仓库。（不符合发现规则的返回 null，直接丢掉） */
export function toGithubRepository(value: unknown): GithubRepository | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const repo = value as Record<string, unknown>
  if (
    !Number.isSafeInteger(repo.id) ||
    typeof repo.full_name !== 'string' ||
    !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(repo.full_name) ||
    typeof repo.default_branch !== 'string' ||
    !repo.default_branch ||
    repo.archived !== false ||
    repo.fork !== false ||
    repo.private !== false ||
    !Array.isArray(repo.topics) ||
    !repo.topics.includes(DISCOVERY_TOPIC)
  ) {
    return null
  }
  return {
    id: repo.id as number,
    fullName: repo.full_name,
    defaultBranch: repo.default_branch,
    stars: typeof repo.stargazers_count === 'number' ? repo.stargazers_count : 0,
    updatedAt: text(repo.updated_at)
  }
}

/* ─────────────────────────── 版本 ─────────────────────────── */

/**
 * 插件版本比较（`1.2.3` / `1.2.3.4`）。
 *
 * 与客户端自己的版本协议刻意分开：插件允许第四段（作者用它发补丁版），而客户端不认。
 * 认不出返回 null —— 调用方据此判「不比它新」，不拿看不懂的字符串吓人。
 */
export function comparePluginVersions(a: string, b: string): number | null {
  const pattern =
    /^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})(?:\.(0|[1-9][0-9]{0,8}))?$/
  const left = a.replace(/^v/, '')
  const right = b.replace(/^v/, '')
  if (!pattern.test(left) || !pattern.test(right)) return null
  const first = left.split('.').map(Number)
  const second = right.split('.').map(Number)
  for (let index = 0; index < Math.max(first.length, second.length); index += 1) {
    const delta = (first[index] ?? 0) - (second[index] ?? 0)
    if (delta) return Math.sign(delta)
  }
  return 0
}

/** 服务器版本够不够装这个插件。`dev` 一律算够（自己编的版本没得比） */
export function hostCompatibility(
  minimum: string,
  current: string
): 'compatible' | 'incompatible' | 'unknown' {
  if (current === 'dev' || !minimum) return 'compatible'
  if (!current) return 'unknown'
  const comparison = comparePluginVersions(current.replace(/^v/, ''), minimum.replace(/^v/, ''))
  return comparison == null ? 'unknown' : comparison < 0 ? 'incompatible' : 'compatible'
}

/* ─────────────────────────── 已装状态 ─────────────────────────── */

/** 本机这份插件能不能**证明**是从这个仓库装的 */
export function installedFromRepository(
  plugin: GithubDiscoveryPlugin,
  installed: JSPlugin | null | undefined
): boolean {
  if (!installed) return false
  return (
    isRepositoryMetadataUrl(installed.updateUrl, plugin.repository.fullName) ||
    releaseDownload(installed.downloadUrl, downloadRepository(plugin)) != null
  )
}

/** 一条「这条插件是从哪个仓库装上的」记忆 */
export interface GithubInstallSource {
  repositoryId: number
  /** 装上时的版本。本机清单读得到版本时以它为准，这里只在读不到时兜底 */
  version: string
}

/**
 * 从「GitHub 发现」装上的那些：`entryPath → 来源`。
 *
 * 为什么需要它：插件包装上之后，服务端存的是**包内**清单（多半没有 `download_url`、
 * `updateUrl` 也可能为空），于是 `installedFromRepository` 认不出「这就是刚才那一条」，
 * 卡片会当场翻成「覆盖安装」并警告要替换别人的插件。
 *
 * ★ 它必须**持久化**（落在 `AppSettings.githubInstalls`，见 shared/ipc）。早先它只是商店页
 *   的一个 `useState`，于是离开商店页（或重启应用）就丢了 —— 再次进来时同一张卡片立刻被
 *   判成「入口冲突」，警告要替换掉的其实是它自己。
 */
export type GithubInstalls = Readonly<Record<string, GithubInstallSource>>

/**
 * 本机清单里那条更新元数据指向的是不是**别的仓库**。
 *
 * 有这种硬证据时，「记下来的来源」不作数：同一个 entryPath 完全可能换过主人（上一份被卸掉、
 * 另一个仓库的插件占了同一个入口），而记录还留在设置里。
 */
function pointsAtAnotherRepository(plugin: GithubDiscoveryPlugin, installed: JSPlugin): boolean {
  const repository = githubUrlRepository(installed.updateUrl)
  return repository != null && repository.toLowerCase() !== plugin.repository.fullName.toLowerCase()
}

/**
 * 本机这份插件与卡片上的那一条**是不是同一个插件**（软证据）：插件名与作者都对得上。
 *
 * 给「来源记录机制上线之前就装好的」那些兜底 —— 它们没有任何凭据，否则一进商店就被判成
 * 撞了别人的入口。作者为空不算数：那说明清单没写，凭一个名字就认人太随意。
 */
function samePluginIdentity(plugin: GithubDiscoveryPlugin, installed: JSPlugin | null): boolean {
  if (!installed) return false
  const author = plugin.manifest.author.trim()
  if (!author) return false
  return (
    installed.name === plugin.manifest.name &&
    installed.author.trim().toLowerCase() === author.toLowerCase()
  )
}

export type DiscoveryAction = 'install' | 'update' | 'reinstall' | 'overwrite' | 'blocked'

export interface DiscoveryInstallState {
  action: DiscoveryAction
  /** 占着同一个 entryPath 的本机插件（不管能不能证明同源） */
  occupant: JSPlugin | null
  /** 能证明同源时，本机装着的那一版 */
  installedVersion: string
  hasUpdate: boolean
  /** 服务器版本低于插件要求 */
  incompatible: boolean
}

/**
 * 这一条现在该显示什么。
 *
 * ★ 判定顺序：先看兼容性（不兼容时按钮该是禁用的，不能让人一路点到失败），
 *   再看撞名（撞名的那一条 `installed` 是 false，先看它会显示成「安装」）。
 */
export function discoveryInstallState(input: {
  plugin: GithubDiscoveryPlugin
  installed: readonly JSPlugin[]
  /** 当前连接的服务器版本（拿不到传空串 → 不拦，与上游一致） */
  hostVersion: string
  /** 「从哪个仓库装上的」——见 GithubInstalls（持久化在设置里） */
  installs: GithubInstalls
}): DiscoveryInstallState {
  const { plugin, installed, hostVersion, installs } = input
  const entryPath = plugin.manifest.entryPath
  const occupant = installed.find((item) => item.entryPath === entryPath) ?? null
  /*
   * ★ 「同源」只在**本机真有一份占着这个入口**时才谈得上：没有占用者就没有「同的是谁」，
   *   动作只能是「安装」。这条同时收掉一类过期记录 —— 插件早已卸载，记录还留在设置里。
   * ★ 三条证据，硬的一句优先：
   *     · 清单证据（`installedFromRepository`）—— 包内清单还留着这个仓库的地址，最硬；
   *     · 记下来的来源（`githubInstalls`）—— 包内清单什么都没留时的唯一凭据；
   *     · 同名同作者（`lookalike`）—— 给**记录机制上线之前**就装好的那些兜底：它们本来没有
   *       任何凭据，一进商店就会被判成撞名。作者非空才认，避免「两个作者都没写作者名」时
   *       凭一个名字就把别人的插件当成自己的。
   *   ★ 而清单一旦指着**别的仓库**，那就是相反的硬证据，上面两条软证据一并作废。
   */
  const foreign = occupant !== null && pointsAtAnotherRepository(plugin, occupant)
  const recorded =
    occupant !== null && !foreign && installs[entryPath]?.repositoryId === plugin.repository.id
  const lookalike = !foreign && samePluginIdentity(plugin, occupant)
  const sameRepository =
    occupant !== null && (recorded || lookalike || installedFromRepository(plugin, occupant))

  /*
   * 版本以**本机清单**为准：记录是安装那一刻的，之后插件若被别的途径更新过，它已经旧了，
   * 拿它比版本会把「已是最新」误报成「有新版本」。
   */
  const installedVersion = sameRepository
    ? occupant?.version || installs[entryPath]?.version || ''
    : ''
  const comparison = comparePluginVersions(plugin.manifest.version, installedVersion)
  const hasUpdate = sameRepository && comparison != null && comparison > 0
  const incompatible =
    hostCompatibility(plugin.manifest.minHostVersion, hostVersion) === 'incompatible'

  const action: DiscoveryAction = incompatible
    ? 'blocked'
    : occupant && !sameRepository
      ? 'overwrite'
      : sameRepository
        ? hasUpdate
          ? 'update'
          : 'reinstall'
        : 'install'

  return { action, occupant, installedVersion, hasUpdate, incompatible }
}

/** 列表行的稳定标识：同一 entryPath 可能出现在两个仓库里（撞名），所以带上仓库 */
export function discoveryRowKey(plugin: GithubDiscoveryPlugin): string {
  return `${plugin.repository.id}::${plugin.manifest.entryPath}`
}

/* ─────────────────────────── Release 校验 ─────────────────────────── */

export interface GithubReleaseAsset {
  name: string
  url: string
  size: number
  state: string
}

export interface GithubRelease {
  tagName: string
  publishedAt: string
  draft: boolean
  prerelease: boolean
  assets: GithubReleaseAsset[]
}

/** 解析 release 接口的响应；结构不对抛错（调用方记成 `invalidRelease`） */
export function parseGithubRelease(value: unknown): GithubRelease {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalidRelease')
  const raw = value as Record<string, unknown>
  if (!Array.isArray(raw.assets)) throw new Error('invalidRelease')
  const assets: GithubReleaseAsset[] = []
  for (const item of raw.assets) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('invalidRelease')
    const asset = item as Record<string, unknown>
    if (
      typeof asset.name !== 'string' ||
      typeof asset.browser_download_url !== 'string' ||
      typeof asset.size !== 'number' ||
      typeof asset.state !== 'string'
    ) {
      throw new Error('invalidRelease')
    }
    assets.push({
      name: asset.name,
      url: asset.browser_download_url,
      size: asset.size,
      state: asset.state
    })
  }
  return {
    tagName: text(raw.tag_name),
    publishedAt: text(raw.published_at),
    draft: raw.draft === true,
    prerelease: raw.prerelease === true,
    assets
  }
}

/**
 * 核对「这个 release 真的发布了这份资产吗」。
 *
 * `unpublished`（资产不在 / 没传完）与 `invalidRelease`（草稿、预发布、tag 对不上）分开：
 * 前者多半是作者还没点发布，后者是清单写错了 —— 但**都**不该进列表。
 */
export function verifyRelease(
  raw: unknown,
  download: { tag: string; file: string },
  downloadUrl: string
): { ok: true; publishedAt: string } | { ok: false; failure: 'invalidRelease' | 'unpublished' } {
  let release: GithubRelease
  try {
    release = parseGithubRelease(raw)
  } catch {
    return { ok: false, failure: 'invalidRelease' }
  }
  if (
    release.draft ||
    release.prerelease ||
    release.tagName !== download.tag ||
    !release.publishedAt ||
    !Number.isFinite(Date.parse(release.publishedAt))
  ) {
    return { ok: false, failure: 'invalidRelease' }
  }
  const asset = release.assets.find(
    (item) =>
      item.name === download.file &&
      item.url === downloadUrl &&
      item.size > 0 &&
      item.state === 'uploaded'
  )
  return asset
    ? { ok: true, publishedAt: release.publishedAt }
    : { ok: false, failure: 'unpublished' }
}

/**
 * 给发现请求套上 GitHub 加速代理（拼接式，如 `https://ghfast.top/` + 原始地址）。
 *
 * ★ 只有 GitHub 域名才套（与后端 httputil.ApplyGithubProxy 同口径）：清单里可能写着
 *   跨仓库的 release 地址，但它同样在 github.com 上，套上去是安全的。
 * ★ 看起来就不像前缀的写法（没有协议、带 query）原样返回：那种值套上去只会拼出
 *   一个必定 404 的地址，而调用方本来就有「代理失败再直连」的兜底。
 */
export function applyGithubProxy(address: string, proxy: string): string {
  const prefix = proxy.trim()
  if (!prefix || !/^https?:\/\/[^\s?#@\\]+$/i.test(prefix)) return address
  if (!githubUrlRepository(address) && !/^https:\/\/api\.github\.com\//i.test(address)) {
    return address
  }
  return `${prefix.endsWith('/') ? prefix : `${prefix}/`}${address}`
}
