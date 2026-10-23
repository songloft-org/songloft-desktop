/**
 * 主进程出网：把「一条通路」变成一次真实请求。
 *
 * **为什么不直接用 `net.fetch`**：代理是挂在 **Session** 上的，而 `net.fetch` 的 init 里
 * 没有 session 这一项（只有 `bypassCustomProtocolHandlers`）—— 想走客户端自己探活过的那条
 * 代理，只能 `net.request({ session })`。下载安装包又得边收边写盘，正好是同一条路。
 *
 * **通路有两条，按优先级试**：配置的那条（加速前缀 + 探活通过的代理）→ 直连。前者失败就落到
 * 后者，并把「实际用了哪条」报上去（`ClientUpdateRoute`）。服务器上配的代理在本机不一定连得上，
 * 这件事必须让人看得见，不能静默换路。
 */

import { net, session } from 'electron'
import type { ClientRequest, IncomingMessage } from 'electron'

import { applyGithubProxy } from '@shared/github-discovery'
import type { ClientUpdateRoute } from '@shared/ipc'

import type { ProxyPlan } from './proxy'

/** 一条通路：URL 前缀 + 传输层代理，两者可同时生效，空串表示该项不用 */
export interface NetRoute {
  /** 拼在 GitHub 地址前的加速前缀 */
  prefix: string
  /** Chromium 的 proxyRules */
  proxyRules: string
}

const DIRECT: NetRoute = { prefix: '', proxyRules: '' }

/**
 * 这次要试的通路，按优先级排好。
 *
 * 直连永远留在最后一项：它既是「什么都没配」时的唯一一条，也是「配了但用不了」时的兜底 ——
 * 用户要的是把更新查出来 / 装下来，不是先去排查服务器上的代理。
 */
export function routesFor(plan: ProxyPlan): NetRoute[] {
  const configured: NetRoute = { prefix: plan.prefix, proxyRules: plan.proxyRules }
  return configured.prefix || configured.proxyRules ? [configured, DIRECT] : [DIRECT]
}

/** 第 index 条通路成功了，这次算走了什么 */
export function routeLabel(index: number, routes: readonly NetRoute[]): ClientUpdateRoute {
  if (routes.length === 1) return 'direct'
  return index === 0 ? 'proxy' : 'proxy-fallback'
}

function namedError(name: string, message: string, cause?: unknown): Error {
  const error = new Error(message, cause === undefined ? undefined : { cause })
  error.name = name
  return error
}

/** 用户主动取消（重试循环见到它就**不该**再换路重来） */
export function abortError(): Error {
  return namedError('AbortError', '已取消')
}

export interface RequestOptions {
  /** 从发起到收到响应头的上限；下载的大头在响应体里，另有停滞看门狗（见 update-download） */
  timeoutMs: number
  headers?: Record<string, string>
  signal?: AbortSignal
}

export interface NetResponse {
  response: IncomingMessage
  /** 取消下载时用它：`net.request` 没有 pause，能打断流的就是 abort */
  request: ClientRequest
}

/**
 * 下载 / 检查共用的那个 session。
 *
 * 非 `persist:` 前缀 = 只在内存里：不落盘、不共用应用自己的 Cookie 与缓存 —— 安装包下载不需要
 * 记住任何东西，也不该被主界面那边的登录态影响。
 */
const PARTITION = 'songloft-native-net'

/** 这个 session 上**当前生效**的代理规则；为空串表示直连 */
let appliedRules: string | null = null

/**
 * 串行闸：session 上的代理是全局的，两条请求同时改它就会互相串（A 的请求走了 B 的代理）。
 * 只把「配代理 + 发请求 + 等响应头」这一段串起来，响应体各读各的。
 */
let gate: Promise<unknown> = Promise.resolve()

function exclusive<T>(task: () => Promise<T>): Promise<T> {
  const run = gate.then(task, task)
  gate = run.catch(() => undefined)
  return run
}

async function issue(url: string, route: NetRoute, options: RequestOptions): Promise<NetResponse> {
  if (options.signal?.aborted) throw abortError()

  const target = applyGithubProxy(url, route.prefix)
  const netSession = session.fromPartition(PARTITION)

  if (appliedRules !== route.proxyRules) {
    await netSession.setProxy(
      route.proxyRules
        ? { mode: 'fixed_servers', proxyRules: route.proxyRules }
        : { mode: 'direct' }
    )
    appliedRules = route.proxyRules
  }

  const request = net.request({ url: target, session: netSession, redirect: 'follow' })
  for (const [name, value] of Object.entries(options.headers ?? {})) request.setHeader(name, value)

  // 取消信号要一直挂到响应体读完（下面 settle 时**不**摘它）：用户点的「取消」大多发生在
  // 传输过程中，而不是等响应头的那几秒
  const onAbort = (): void => request.abort()
  options.signal?.addEventListener('abort', onAbort, { once: true })

  return new Promise<NetResponse>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      request.abort()
      reject(namedError('TimeoutError', `超过 ${Math.round(options.timeoutMs / 1000)} 秒没有响应`))
    }, options.timeoutMs)

    request.once('response', (response) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ response, request })
    })

    request.once('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      // 取消会让底层报一个 net::ERR_ABORTED：那是我们自己打断的，别当成网络故障
      reject(options.signal?.aborted ? abortError() : namedError('NetError', error.message, error))
    })

    request.end()
  })
}

/** 发一次 GET 并等到响应头。响应体由调用方自己读（下载）或交给 readText（JSON） */
export function getStream(
  url: string,
  route: NetRoute,
  options: RequestOptions
): Promise<NetResponse> {
  return exclusive(() => issue(url, route, options))
}

export interface ReadTextOptions {
  /** 响应体上限：GitHub 的这份接口只有几 KB，超了说明拿到的不是它 */
  limitBytes?: number
  /** 多久没有新数据算卡死 */
  stallMs?: number
}

/**
 * 读完一整段响应体。
 *
 * 带停滞看门狗：`net.request` 的 response 是个纯 EventEmitter（没有 pause / 也没有可用的
 * `setTimeout`），只等 'end' 的话，连接被中间设备挂住时会**永远**停在这里 —— 界面上的表现
 * 就是转圈转到天亮。
 */
export function readText(
  response: IncomingMessage,
  options: ReadTextOptions = {}
): Promise<string> {
  const limit = options.limitBytes ?? 4 * 1024 * 1024
  const stallMs = options.stallMs ?? 15_000

  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let done = false

    function cleanup(): void {
      clearTimeout(timer)
      response.removeListener('data', onData)
      response.removeListener('end', onEnd)
      response.removeListener('error', onError)
      response.removeListener('aborted', onAborted)
    }

    function fail(error: Error): void {
      if (done) return
      done = true
      cleanup()
      reject(error)
    }

    const timer = setTimeout(
      () => fail(namedError('TimeoutError', `响应超过 ${Math.round(stallMs / 1000)} 秒没有数据`)),
      stallMs
    )

    function onData(chunk: Buffer): void {
      timer.refresh()
      size += chunk.length
      if (size > limit) {
        fail(new Error('响应体超过上限'))
        return
      }
      chunks.push(chunk)
    }

    function onEnd(): void {
      if (done) return
      done = true
      cleanup()
      resolve(Buffer.concat(chunks).toString('utf8'))
    }

    function onError(error: Error): void {
      fail(error)
    }

    function onAborted(): void {
      fail(abortError())
    }

    response.on('data', onData)
    response.once('end', onEnd)
    response.once('error', onError)
    response.once('aborted', onAborted)
  })
}
