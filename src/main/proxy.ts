/**
 * 「服务器上配的那个代理，本机能不能用」。
 *
 * 设置页里那两项代理（HTTP 代理 / GitHub 加速代理）都是**服务端设置** —— 它们管的是后端
 * 访问外链（导入歌单、抓封面、拉插件包）。客户端借来下载安装包只是顺手，于是必须先判断：
 * 代理很可能跑在服务器本机（`127.0.0.1:7890`）或只在服务器所在的内网里，客户端根本摸不到。
 *
 * 两类代理能探到什么程度，差别是本质的：
 *   · **HTTP 代理**有确定的 host:port，可以探一次 TCP —— 连不上就直接不用它；
 *   · **GitHub 加速代理**是个 URL 前缀，本身没有可探的端点（任何探测都是拿真请求去打），
 *     所以不在这里探，交给调用方「先试它、失败再用直连试一次」（见 net-path.ts 的 routesFor）。
 *
 * 判定结果**不缓存**：用户可能刚关掉代理或换了地址，而这件事是低频动作，一次 TCP 握手的
 * 代价可以忽略；缓存反而会让「刚改完设置还是连不上」变成一个新谜题。
 *
 * 本模块刻意只依赖 `node:net`，不 import electron —— 这样解析那段能直接单测。
 */

import { connect } from 'node:net'

/** 探活的等待上限：代理就在本机或局域网，1.5 秒还没握上手就不必再等 */
const PROBE_TIMEOUT_MS = 1500

/**
 * 看起来像「加速前缀」的写法才认（与 shared/github-discovery.ts 的 applyGithubProxy 同口径）。
 * 认不出来的值当作没配 —— 拿它去拼地址只会拼出一个必定 404 的 URL。
 */
const PREFIX_PATTERN = /^https?:\/\/[^\s?#@\\]+$/i

/** 一个代理的 host:port */
export interface ProxyTarget {
  host: string
  port: number
}

/** 服务端设置里那两项代理，原样（可能是空串） */
export interface ClientUpdateProxySettings {
  /** 「GitHub 加速代理」：拼在 GitHub 地址前面的前缀，如 https://ghfast.top/ */
  githubProxy: string
  /** 「HTTP 代理」：后端访问外链用的代理，形如 http://192.168.1.1:7890 */
  httpProxy: string
}

/**
 * 这次打算怎么出网。两项可以同时生效：前缀是 URL 层面的拼接，代理规则是传输层的。
 * 空串统一表示「这一项不用」。
 */
export interface ProxyPlan {
  /** 可以直接拼在 GitHub 地址前的前缀 */
  prefix: string
  /** 交给 Chromium 的 proxyRules（探活通过才会填） */
  proxyRules: string
  /** 配了 HTTP 代理、但本机连不上 —— 界面要据此说明「已改为直连」 */
  httpProxyUnreachable: boolean
}

/** 前缀写法是否可用；不可用一律折成空串 */
export function usablePrefix(raw: string): string {
  const value = raw.trim()
  return PREFIX_PATTERN.test(value) ? value : ''
}

/**
 * 把设置里那串代理地址解析成 host:port；认不出来返回 null。
 *
 * 兼容三种写法（设置页的提示就是这三种）：`http://h:p`、`h:p`、`socks5://h:p`。
 * 省协议的写法按 http 处理 —— 只为算出端口，探活只关心 TCP 能不能连上。
 */
export function parseProxyTarget(raw: string): ProxyTarget | null {
  const value = raw.trim()
  if (!value) return null

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`
  let parsed: URL
  try {
    parsed = new URL(withScheme)
  } catch {
    return null
  }

  // IPv6 的 hostname 带方括号（`[::1]`），而 net.connect 要的是裸地址
  const host = parsed.hostname.replace(/^\[|\]$/g, '')
  if (!host) return null

  const scheme = parsed.protocol.slice(0, -1).toLowerCase()
  const fallbackPort = scheme === 'https' ? 443 : scheme.startsWith('socks') ? 1080 : 80
  const port = parsed.port ? Number(parsed.port) : fallbackPort
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null

  return { host, port }
}

/**
 * 探一次 TCP：连得上就返回 true。
 *
 * 只证明「这台机器能建到那个地址的连接」，不证明它是个能干活的代理 —— 那要靠后面的真请求
 * 验证（失败还有直连兜底）。反过来，连不上是**确定的**不可用，这一条就足够把整条代理跳过。
 */
export function probeTcpReachable(
  target: ProxyTarget,
  timeoutMs: number = PROBE_TIMEOUT_MS
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: target.host, port: target.port })
    let settled = false
    const finish = (reachable: boolean): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(reachable)
    }

    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

/**
 * 把设置折成一份「这次怎么出网」的计划。
 *
 * ★ 探活失败**不抛异常**：用户要的是把更新查出来 / 装下来，不是被一个连不上的代理拦住。
 *   计划里如实记下 `httpProxyUnreachable`，界面上说明一句，然后照常直连。
 */
export async function planProxies(settings: ClientUpdateProxySettings): Promise<ProxyPlan> {
  const prefix = usablePrefix(settings.githubProxy)
  const httpProxy = settings.httpProxy.trim()

  if (!httpProxy) return { prefix, proxyRules: '', httpProxyUnreachable: false }

  const target = parseProxyTarget(httpProxy)
  // 写法认不出来时按「不可用」处理：拿一串解析不了的值去配 Chromium，只会让请求直接失败
  if (!target) return { prefix, proxyRules: '', httpProxyUnreachable: true }

  const reachable = await probeTcpReachable(target)
  return {
    prefix,
    proxyRules: reachable ? httpProxy : '',
    httpProxyUnreachable: !reachable
  }
}
