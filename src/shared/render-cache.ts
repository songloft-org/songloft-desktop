/**
 * 渲染进程的**缓存失效策略**（纯计算，清理由主进程执行）。
 *
 * 为什么需要它：两个 Chromium 会话（默认会话、插件会话）里的字节都是**远端代码与远端数据**，
 * 而它们的 URL 大多不带版本号 —— 服务端换了 shim / web-core / 插件 bundle，客户端不会知道，
 * 只会继续用旧的那一份。踩过一次：`lynx-plugin-bridge-shim.js` 被 `immutable` 缓存了一年，
 * 后端升级到「会设置 `<lynx-view url>`」的新版之后，客户端拿到的仍是不会设置 url 的旧版，
 * 于是 Lynx 插件永久白屏（且没有任何报错）。
 *
 * 三类「更新」各清什么：
 *
 * | 触发 | 判定 | 清理范围 |
 * |---|---|---|
 * | 插件更新 / 安装 / 卸载 | 插件列表签名变化（entryPath + id + version + updatedAt + icon） | 插件会话 |
 * | 后端更新 | `/version` 的 version + git_commit + build_type 变化 | 插件会话 |
 * | 客户端更新 | `app.getVersion()` 变化 | 插件会话 + 默认会话 |
 *
 * 几条刻意的取舍：
 *
 * 1. **插件会话是共享的**（`PLUGIN_PARTITION` 一个分区装所有插件页与公共运行时）。Electron
 *    没有「按 URL 驱逐」的 API，所以「只清某个插件的资源」做不到 —— 一次清理会连带那 620KB
 *    运行时一起重下。这与「清错」相比代价很低，接受。
 * 2. **后端更新不碰默认会话**：那里只有封面图（URL 带歌曲 id，升级不变）与接口响应（没有
 *    验证器，本来就不会被复用）。清它是纯粹的白花。
 * 3. **客户端更新两个会话都清**：客户端自己的资源 URL 约定可能变（封面尺寸参数、媒体地址），
 *    旧字节留着只会让人怀疑「装了假的新版」。
 * 4. **一律不动存储类**：localStorage（插件页的 token 注入）、Cookies、IndexedDB 都不清；
 *    设置与凭据在 ConfigStore 的 JSON 里，更不归这里管。
 * 5. **第一次见到某个版本号时只记录、不清**，唯一的例外是客户端那一档里对**插件会话**的处理：
 *    全新安装时它本来为空（免费），从老版本升上来时它可能正压着旧远端代码 —— 正是要治的病。
 * 6. **插件的启停不进签名**：它不改变任何字节，进签名就成了「点一次开关清一次缓存」。
 */

import type { BackendVersion } from './types'
import type { JSPlugin } from './plugin'

/** 清理目标：主窗口那个默认会话，还是扩展页那个独立分区 */
export type RenderCacheTarget = 'app' | 'plugin'

/**
 * 上次见到的版本三件套。
 *
 * `backend` / `plugins` 都按**服务器**分键：一台机器可能连过多台服务器，各自的后端版本与
 * 插件列表互不相干；共用一个键的话，来回切服务器会互相判成「更新了」。
 */
export interface RenderCacheState {
  /** 上次运行时的客户端版本（空串 = 第一次记录） */
  client: string
  /** 服务器 → 后端构建标识 */
  backend: Record<string, string>
  /** 服务器 → 插件列表签名 */
  plugins: Record<string, string>
}

/**
 * 一次协调要用到的事实。除 `clientVersion` 外都可缺省 ——
 * 后端版本与插件列表是**两个独立时机**拿到的（登录后 / 插件列表加载后），各报各的。
 */
export interface RenderCacheFacts {
  clientVersion: string
  /** 服务器身份（规范化后的 `protocol//host`，见 main/store.ts 的 walletKey） */
  serverKey?: string
  /** 见 backendCacheKey()；空串表示「这次探测不到」，应当跳过 */
  backendVersion?: string
  /** 见 pluginCacheSignature() */
  pluginSignature?: string
}

/** 渲染层经 IPC 报上来的那一份（客户端版本由主进程自己知道，不必过边界） */
export type RenderCacheRequest = Omit<RenderCacheFacts, 'clientVersion'>

export interface RenderCachePlan {
  /** 这次要清的会话 */
  clear: RenderCacheTarget[]
  /** 状态有没有变（没变就不写盘，避免每次启动都动一次 config.json） */
  changed: boolean
  /** 记录用：下一次比较的基准 */
  state: RenderCacheState
}

export const EMPTY_RENDER_CACHE_STATE: RenderCacheState = {
  client: '',
  backend: {},
  plugins: {}
}

/** 「一个插件都没装」的签名（空串在协议里表示「这一项没报」，两者不能混） */
export const EMPTY_PLUGIN_SIGNATURE = '-'

/**
 * 后端构建标识：**三项一起**才有意义。
 *
 * - `version` 是发布号；
 * - `git_commit` 分得开同一版本号下的不同构建（dev 构建的 version 常年是同一个值）；
 * - `build_type` 分得开 `full` 与 `lite` —— 后者**根本没有内嵌 web-core**，同一版本号下
 *   `jsplugin-assets/web-core/*` 的行为完全不同（见服务端 `web_embed_lite.go`）。
 *
 * 三项都拿不到时回空串，调用方应当跳过比较（宁可少清一次，也不要每次启动都判成「更新了」）。
 */
export function backendCacheKey(version: BackendVersion | null | undefined): string {
  if (!version) return ''
  const parts = [version.version, version.git_commit, readText(version, 'build_type')]
  return parts
    .map((part) => (typeof part === 'string' ? part.trim() : ''))
    .filter(Boolean)
    .join('|')
}

/**
 * 插件列表签名：**只取会改变字节的字段**。
 *
 * `updatedAt` / `version` / `icon`（后端给的图标名带内容哈希）任一变化都意味着包装过；
 * `id` 与 `entryPath` 一起定身份（重装会换 id，路径可能相同）。
 * `status` 刻意**不在**里面：启停只改后端的运行时状态，不换任何静态资源。
 *
 * 一个插件都不剩时给 `EMPTY_PLUGIN_SIGNATURE` 而不是空串：空串在调用方那里表示「这一项没报」，
 * 而「全卸了」是一件真事 —— 它也该把那几个插件留下的 static 清掉。
 */
export function pluginCacheSignature(plugins: JSPlugin[]): string {
  if (plugins.length === 0) return EMPTY_PLUGIN_SIGNATURE
  return plugins
    .map((plugin) =>
      [plugin.entryPath, plugin.id, plugin.version, plugin.updatedAt, plugin.icon].join(':')
    )
    .sort()
    .join('|')
}

/** 比对上一份状态与这一批事实，给出「清哪几个会话」与「新的基准」 */
export function planRenderCacheReconcile(
  prev: RenderCacheState,
  facts: RenderCacheFacts
): RenderCachePlan {
  const next: RenderCacheState = {
    client: prev.client,
    backend: { ...prev.backend },
    plugins: { ...prev.plugins }
  }
  const clear = new Set<RenderCacheTarget>()
  let changed = false

  if (facts.clientVersion && facts.clientVersion !== prev.client) {
    /*
     * 插件会话**一律**清，含「第一次记录」这一档（升级前装的老版本没有这项记录）：
     *   · 全新安装时它本来就是空的，清一次是纯 no-op；
     *   · 从老版本升上来时，里面可能正压着旧远端代码 —— 而这正是这套机制要治的病
     *     （旧的 shim 让 Lynx 插件永久白屏，见文件头）。
     * 默认会话只在**确实换过版本**时清：那里是封面，清了要重下几十上百兆。
     */
    clear.add('plugin')
    if (prev.client) clear.add('app')
    next.client = facts.clientVersion
    changed = true
  }

  const serverKey = facts.serverKey
  if (serverKey) {
    const backendVersion = facts.backendVersion ?? ''
    if (backendVersion) {
      const before = prev.backend[serverKey]
      // 后端换了构建：插件会话里的公共运行时（shim / common.js / web-core）全变了
      if (before && before !== backendVersion) clear.add('plugin')
      if (before !== backendVersion) {
        next.backend[serverKey] = backendVersion
        changed = true
      }
    }

    const signature = facts.pluginSignature ?? ''
    if (signature) {
      const before = prev.plugins[serverKey]
      // 插件换了包：它的 static（含 main.web.bundle）在插件会话里
      if (before && before !== signature) clear.add('plugin')
      if (before !== signature) {
        next.plugins[serverKey] = signature
        changed = true
      }
    }
  }

  return { clear: [...clear], changed, state: next }
}

/** 从任意对象里读一个字符串字段（`/version` 的响应是开放结构，见 BackendVersion） */
function readText(source: BackendVersion, key: string): string {
  const value = source[key]
  return typeof value === 'string' ? value : ''
}
