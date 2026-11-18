/**
 * HLS 中继（`songloft-hls://`）：把「渲染层直接去源站取」换成「主进程代取」。
 *
 * ★ 为什么需要它：hls.js 读播放列表与切片走的是浏览器的 XHR —— 源站不回
 *   `Access-Control-Allow-Origin` 就一个字节也读不到（hls.js 只会看到 `status 0`）。
 *   上游 Flutter 端用 libmpv 按裸连接拉流，根本没有 CORS 这一层，所以同一个电台那边能放。
 *   视频源尤其容易踩上：后端 `?media=video` 对**电台/外链**是 302 到源站，最终那份 m3u8
 *   的响应头由源站说了算；而 `<video src>` 本身不受 CORS 限制 —— 这正是「普通 mp4 视频
 *   一直正常、只有 HLS 坏」的原因。
 *
 * ★ 做法：主进程把上游地址编码进一条自己的协议（`songloft-hls://r/<base64url>`），由
 *   `main/hls-relay.ts` 的 `protocol.handle` 用 `net.fetch` 去取（主进程没有 CORS），
 *   把播放列表里每条 URI 改写回同样的中继地址，切片字节原样流回。渲染层与 hls.js 只看见
 *   一条普通地址，一行 loader 都不用换。
 *
 * ★ 为什么不是「给响应补一个 ACAO 头」：切片请求可能带 `Range`（fMP4 的分段取址），那是
 *   需要预检的请求头 —— 源站不答 OPTIONS 照样失败。中继从根上没有这一层。
 *
 * ★ 这里只放**纯函数**（地址编解码、播放列表改写）：两侧都要用，且改写规则必须能单测 ——
 *   漏改写一条 URI 的症状是「播几秒就卡住」，极难定位。
 */

/** 中继协议的 scheme（main/index.ts 里注册为特权协议，见 main/hls-relay.ts） */
export const HLS_RELAY_SCHEME = 'songloft-hls'

/** 协议里的固定 host —— 标准协议的 URL 必须有 host 段，这里只当占位 */
const RELAY_HOST = 'r'

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  // 标准 base64 → URL 安全：`+/` 换掉、`=` 去掉（放进 path 段里不必转义）
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(encoded: string): string | null {
  const normalized = encoded.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
  try {
    const binary = atob(padded)
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
    return new TextDecoder().decode(bytes)
  } catch {
    return null
  }
}

/**
 * 一条上游地址 → 对应的中继地址。
 *
 * ★ 只对 http(s) 成形：别的 scheme（`skd:` 密钥、`data:`)没法由主进程去取，原样留着
 *   让 hls.js 自己处理。
 */
export function relayUrlFor(upstream: string): string {
  return `${HLS_RELAY_SCHEME}://${RELAY_HOST}/${toBase64Url(upstream)}`
}

/**
 * 中继地址 → 上游地址。不是中继地址（或解不出来）返回 null。
 *
 * ★ 主进程只认这一条还原路径：解码结果就是它要去 fetch 的**唯一**东西，
 *   除了 http(s) 之外不接受 —— 别让它变成「任意协议跳板」。
 */
export function upstreamFromRelay(relayUrl: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(relayUrl)
  } catch {
    return null
  }
  if (parsed.protocol !== `${HLS_RELAY_SCHEME}:`) return null
  const encoded = parsed.pathname.replace(/^\/+/, '').replace(/\/+$/, '')
  if (!encoded) return null
  const upstream = fromBase64Url(encoded)
  if (!upstream) return null
  return /^https?:\/\//i.test(upstream) ? upstream : null
}

/**
 * 这段字节是不是一份 m3u8 播放列表（`#EXTM3U` 开头，允许 BOM 与前导空白）。
 *
 * ★ 为什么看**内容**而不是看地址后缀 / `Content-Type`：
 *   · 顶层那条地址常常没有后缀 —— 视频是后端的 `/songs/{id}/play?media=video`，
 *     它 302 到源站，最终地址长什么样只有源站知道；
 *   · 有的源站给 `.m3u8` 发的就是 `application/octet-stream`。
 *   这两种情况下按元信息判断会把播放列表当成切片原样吐回去 —— 里面的 URI 一条都没改写，
 *   hls.js 于是又跑回源站去撞跨域，症状与「没修」一模一样。
 *
 * 判据用前缀而不是全文解析：读到的第一批字节就够判断，切片是二进制，不会以 `#EXTM3U` 开头。
 */
export function isPlaylistText(bytes: Uint8Array): boolean {
  const head = new TextDecoder().decode(bytes.subarray(0, 32))
  return head
    .replace(/^\uFEFF/, '')
    .trimStart()
    .startsWith('#EXTM3U')
}

/** 把一条 URI（可能是相对地址）解析成绝对 http(s) 地址；解析不出来返回 null */
function resolveUri(uri: string, base: string): string | null {
  try {
    const resolved = new URL(uri.trim(), base)
    return resolved.protocol === 'http:' || resolved.protocol === 'https:'
      ? resolved.toString()
      : null
  } catch {
    return null
  }
}

/** 播放列表里的 URI → 中继地址；不是 http(s) 的（`data:` / `skd:`）保持原样 */
function relayUri(uri: string, base: string): string | null {
  const resolved = resolveUri(uri, base)
  return resolved ? relayUrlFor(resolved) : null
}

/**
 * 把一份 m3u8 里的每条 URI 改写成中继地址。
 *
 * `base` 必须是**取到这份播放列表的最终地址**（跟随重定向之后）：相对 URI 要按它解析，
 * 用请求前的地址解析会指到别处去（后端 302 到源站时这两者一定不同）。
 *
 * 两类 URI 都要改：
 *   1. 不带 `#` 的行 —— 子播放列表、切片；
 *   2. 任意标签里的 `URI="…"` 属性 —— `EXT-X-KEY`（加密 key）、`EXT-X-MAP`（init 段）、
 *      `EXT-X-MEDIA`（多音轨 rendition）、`EXT-X-I-FRAME-STREAM-INF` 等。不逐条枚举标签：
 *      带 URI 属性的标签只会越来越多，而 `URI="…"` 这个写法在 m3u8 里没有别的含义。
 */
export function rewritePlaylist(text: string, base: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => rewriteLine(line, base))
    .join('\n')
}

function rewriteLine(line: string, base: string): string {
  const trimmed = line.trim()
  // 空行与注释（不含 URI 属性的那些）原样保留
  if (!trimmed) return line
  if (trimmed.startsWith('#')) {
    return line.replace(/URI="([^"]*)"/g, (whole, uri: string) => {
      const relay = relayUri(uri, base)
      return relay ? `URI="${relay}"` : whole
    })
  }
  return relayUri(trimmed, base) ?? line
}
