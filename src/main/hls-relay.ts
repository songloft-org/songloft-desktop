/**
 * HLS 中继协议（`songloft-hls://`）—— 主进程代取，绕开源站的 CORS。
 *
 * 起因与整体做法见 `shared/hls-relay.ts` 顶部那段。这里只负责「真的去取」：
 *
 *   1. 中继地址解出一条 http(s) 上游地址（别的协议一律拒绝，别让它变成跳板）；
 *   2. 主进程 `net.fetch` 去取 —— 主进程没有 CORS，也不需要源站给任何放行头；
 *   3. 看**内容**分流：`#EXTM3U` 开头 → 读完、把每条 URI 改写成中继地址再回写
 *      （`no-store`，直播列表一直在变）；否则就是切片 / key / init 段 → **原样流回**，
 *      状态码与 Range 相关头都透传。
 *
 * ★ 为什么用 `net.fetch` 而不是 `net.request`（本项目别处代取用的是后者）：`net-path.ts`
 *   那一套是给 GitHub / 安装包用的，它要的是「服务端配的那个代理」。媒体这里要的是
 *   **与渲染层完全一致的出网路径**（同一个默认会话、同一份系统代理、同一套自签证书策略），
 *   而 `net.fetch` 走的正是默认会话 —— 换一条自己配代理的路，反而会出现「直连能放、中继
 *   放不了」这种更难解释的差异。
 *
 * ★ 不替用户补 `Referer`：上游 Flutter 端（libmpv）也不带。凭空造一个来源头，对一个
 *   「只放行某个白名单 referer」的源站反而会从「没带」变成「带了错的」。
 */

import { net, protocol } from 'electron'

import {
  HLS_RELAY_SCHEME,
  isPlaylistText,
  rewritePlaylist,
  upstreamFromRelay
} from '@shared/hls-relay'

/** 判断「是不是播放列表」先读这么多字节：够看到 `#EXTM3U`，又不至于为一段切片吃满内存 */
const HEAD_BYTES = 512

/** 判断阶段最多读这么多：极小块流（源站逐字节吐）不该把我们拖在这里 */
const MAX_HEAD_READ = 256 * 1024

/** 播放列表的上限：正常一份是几 KB，超过这个数说明拿到的不是播放列表 */
const MAX_PLAYLIST_BYTES = 4 * 1024 * 1024

/**
 * 中继响应要带的 CORS 头。
 *
 * ★ 这条协议在渲染层眼里是**跨源**的（页面来自 `file://` 或 dev 的 localhost），而它被声明成
 *   `corsEnabled` 的特权协议，所以响应必须自己放行 —— 否则 hls.js 的 XHR 会在**我们自己的**
 *   协议上撞到同一个跨域错误，白绕一圈。
 */
const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,HEAD,OPTIONS',
  'Access-Control-Allow-Headers': '*'
}

/** 切片要透传的响应头（其余如 `set-cookie` 之类与媒体无关，不必也不该带过来） */
const PASSTHROUGH_HEADERS = [
  'content-type',
  'content-length',
  'content-range',
  'accept-ranges',
  'last-modified',
  'etag'
] as const

function forwardHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = { ...CORS_HEADERS }
  for (const name of PASSTHROUGH_HEADERS) {
    const value = headers.get(name)
    if (value) out[name] = value
  }
  return out
}

/** 日志里只写「是哪台主机的哪个路径」—— 地址上常常挂着 access_token，不该进日志 */
function describeTarget(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.origin}${parsed.pathname}`
  } catch {
    return '(无法解析的地址)'
  }
}

function concat(chunks: Uint8Array[], size: number): Uint8Array {
  const merged = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return merged
}

/** 已经读出来的头一段，加上「还没读完的那条流」 */
interface BodyHead {
  bytes: Uint8Array
  reader: ReadableStreamDefaultReader<Uint8Array> | null
}

/** 读头一段（够判断类型就行）；读不出来返回 null */
async function readHead(response: Response): Promise<BodyHead | null> {
  const body = response.body
  if (!body) return { bytes: new Uint8Array(0), reader: null }

  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (size < HEAD_BYTES) {
      const { done, value } = await reader.read()
      if (done) return { bytes: concat(chunks, size), reader: null }
      if (!value) continue
      chunks.push(value)
      size += value.byteLength
      if (size >= MAX_HEAD_READ) break
    }
  } catch {
    return null
  }
  return { bytes: concat(chunks, size), reader }
}

/** 把剩下的流读完（含已读的头一段），超过 `limit` 就放弃并返回 null */
async function readAll(head: BodyHead, limit: number): Promise<string | null> {
  const chunks = [head.bytes]
  let size = head.bytes.byteLength
  const reader = head.reader
  if (reader) {
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value) continue
        size += value.byteLength
        if (size > limit) {
          await reader.cancel()
          return null
        }
        chunks.push(value)
      }
    } catch {
      return null
    }
  }
  return new TextDecoder().decode(concat(chunks, size))
}

/** 头一段 + 剩下的流拼成一条新的流（切片原样透传，一个字节都不改） */
function continueStream(head: BodyHead): ReadableStream<Uint8Array> {
  const prefix = head.bytes
  const reader = head.reader
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (prefix.byteLength > 0) controller.enqueue(prefix)
    },
    async pull(controller) {
      if (!reader) {
        controller.close()
        return
      }
      try {
        const { done, value } = await reader.read()
        if (done) {
          controller.close()
          return
        }
        if (value) controller.enqueue(value)
      } catch (error) {
        controller.error(error)
      }
    },
    cancel(reason) {
      void reader?.cancel(reason)
    }
  })
}

/** 装上协议处理器（app ready 之后调用一次；scheme 的声明在 media-protocol.ts） */
export function installHlsRelayProtocol(): void {
  protocol.handle(HLS_RELAY_SCHEME, async (request) => {
    // 预检：带 Range 的切片请求在部分源站上会先来一发 OPTIONS（源站答不答由不得我们）
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS })
    }

    const upstream = upstreamFromRelay(request.url)
    if (!upstream) return new Response('bad relay url', { status: 400, headers: CORS_HEADERS })

    const headers: Record<string, string> = {}
    const range = request.headers.get('Range')
    if (range) headers.Range = range
    const accept = request.headers.get('Accept')
    if (accept) headers.Accept = accept

    let upstreamResponse: Response
    try {
      upstreamResponse = await net.fetch(upstream, { headers })
    } catch {
      // 源站不可达 / DNS 失败 / 连接被拒：与「hls.js 自己取」的 HTTP 失败同一口径
      console.warn(`[hls-relay] 取不到 ${describeTarget(upstream)}`)
      return new Response(null, { status: 502, headers: CORS_HEADERS })
    }

    /*
     * 上游不成功（4xx/5xx）：原样回，连状态码一起 —— hls.js 靠它区分「源站没有这份列表」
     * 与「网络不通」。这类响应体是错误页，不值得再读一遍去猜类型。
     */
    if (!upstreamResponse.ok) {
      return new Response(upstreamResponse.body, {
        status: upstreamResponse.status,
        headers: forwardHeaders(upstreamResponse.headers)
      })
    }

    const head = await readHead(upstreamResponse)
    if (!head) {
      console.warn(`[hls-relay] 读不到响应体：${describeTarget(upstreamResponse.url || upstream)}`)
      return new Response(null, { status: 502, headers: CORS_HEADERS })
    }

    if (isPlaylistText(head.bytes)) {
      // 重定向之后的**最终**地址：相对 URI 必须按它解析（后端 `?media=video` 就是 302 到源站）
      const finalUrl = upstreamResponse.url || upstream
      const text = await readAll(head, MAX_PLAYLIST_BYTES)
      if (text == null) {
        console.warn(`[hls-relay] 播放列表读不出来或过大：${describeTarget(finalUrl)}`)
        return new Response(null, { status: 502, headers: CORS_HEADERS })
      }
      return new Response(rewritePlaylist(text, finalUrl), {
        status: 200,
        headers: {
          ...CORS_HEADERS,
          'Content-Type': 'application/vnd.apple.mpegurl',
          // 直播列表每次都在变；点播列表复用一份旧的改写结果同样不对
          'Cache-Control': 'no-store'
        }
      })
    }

    /*
     * 其余全是字节：切片、init 段、加密 key。
     * 状态码（200 / 206）与 Content-Range 一并透传 —— hls.js 靠 206 判断分段取址成没成，
     * 自己编一个 200 会让它以为拿到了整段。
     */
    return new Response(continueStream(head), {
      status: upstreamResponse.status,
      headers: forwardHeaders(upstreamResponse.headers)
    })
  })
}
