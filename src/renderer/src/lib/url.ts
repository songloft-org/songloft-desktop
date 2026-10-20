/**
 * 资源 URL 构造（封面 / 播放 / 歌词）。
 *
 * 与 songloft Flutter 端 core/utils/url_helper.dart 的行为对齐：
 *   * 相对路径（`/api/v1/...`）→ 拼上服务器地址 + `?access_token=...`
 *   * 绝对 http(s) 地址 → 原样返回（CDN 封面、外链音频）
 *
 * ★ 为什么要带 access_token 查询参数：封面与音频是交给 `img` / `audio` 元素直接请求的，
 *   走不了我们自己的 fetch 封装（也就拿不到 Authorization 头）。后端的媒体端点专门
 *   接受 `access_token` 查询参数就是为了这个场景。
 *
 * 这些都是纯函数 —— 传入 baseUrl 与 token，不读全局。这样音频 URL 的拼接逻辑可以
 * 直接单测，也避免了「token 刷新后旧 URL 还挂在 DOM 上」这类时序坑。
 */

import { isLocalFileUrl } from '@shared/local-file'
import type { Song } from '@shared/types'

export interface ResourceContext {
  /** 服务器地址（不带 /api/v1），例如 http://localhost:58091 */
  baseUrl: string
  accessToken: string
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '')
}

/** 拼一个后端资源地址；外部绝对地址与本地文件地址原样返回 */
export function buildResourceUrl(url: string | null | undefined, ctx: ResourceContext): string {
  if (!url) return ''
  if (/^https?:\/\//i.test(url)) return url
  // 本地文件走我们自己的协议（见 shared/local-file）：它既不该被拼上服务器地址，
  // 也不该带 access_token —— 那份 token 是给后端认的，与读本机文件无关
  if (isLocalFileUrl(url)) return url
  const base = trimTrailingSlash(ctx.baseUrl)
  const separator = url.includes('?') ? '&' : '?'
  return `${base}${url}${separator}access_token=${encodeURIComponent(ctx.accessToken)}`
}

/** 该后端支持 `?w=` 缩略参数：给封面加一档宽度，弱网/大图时省下大量解码与传输 */
export function buildCoverUrl(
  coverUrl: string | null | undefined,
  ctx: ResourceContext,
  width?: number
): string {
  const full = buildResourceUrl(coverUrl, ctx)
  if (!full || width == null || width <= 0) return full
  // 只对本机后端加：外链 CDN 的 URL 可能带签名，改 query 会失效
  const isBackendUrl =
    !/^https?:\/\//i.test(coverUrl ?? '') || full.startsWith(trimTrailingSlash(ctx.baseUrl))
  if (!isBackendUrl) return full
  if (/[?&]w=\d+/.test(full)) return full
  // ★ 分隔符必须判断：同源的**绝对**地址（`http://host/c.jpg`）本身不带 query，
  //   直接拼 `&w=` 会得到 `http://host/c.jpg&w=96` —— 少了 `?`，这一串会被当成路径的一部分，
  //   后端只会回 404。相对路径走的是上面带 token 的分支，那里已经有 query 才没暴露出来。
  return `${full}${full.includes('?') ? '&' : '?'}w=${Math.round(width)}`
}

/** 歌词地址 */
export function buildLyricUrl(lyricUrl: string | null | undefined, ctx: ResourceContext): string {
  return buildResourceUrl(lyricUrl, ctx)
}

export type QualityPreference = 'original' | '128' | '192' | '320'

/** 当前平台是否需要后端把某些老格式转码（与 Flutter 端 AudioFormatHelper 同义） */
const NEEDS_TRANSCODE = new Set(['wma', 'ape', 'wv', 'tta', 'dsf', 'dff', 'rm', 'ra'])

export function transcodeFormatFor(format: string | null | undefined): string | null {
  if (!format) return null
  return NEEDS_TRANSCODE.has(format.toLowerCase()) ? 'mp3' : null
}

export interface SongUrlOptions {
  quality?: QualityPreference
  /** 音量归一化（后端 EBU R128） */
  normalize?: boolean
  /** 指定音轨（audio-relative index），用于原伴唱切换 */
  track?: number
  /**
   * 第几次重试（0 / 不传 = 首次）。**只用来让地址不同**，后端忽略它。
   *
   * 播放失败后重新要一次地址（见 playerCore 的 error 处理）时带上它，为的是绕开浏览器
   * 对同一个 URL 的 HTTP 缓存复用：上一次拿到的可能是半截响应 / 一个已被判死的资源，
   * 「同一个地址再拉一遍」有可能连请求都不发就复现同一次失败，而我们要的是**重新解析**。
   */
  retry?: number
}

/**
 * 播放地址的查询参数（不含地址、不含 token）。
 *
 * ★ 单独抽出来是为了让**预热**与真实播放用的是同一份口径：后端按「插件 + 源 + 格式 + 码率 +
 *   均衡」算缓存键，两边差一项就会预热出一份谁也命中不了的缓存。
 */
export function buildSongQuery(song: Song, options: SongUrlOptions = {}): string {
  const params: string[] = []
  const { track, quality, normalize, retry } = options
  if (track != null && track >= 0) {
    params.push(`track=${track}`)
  } else {
    const transcode = transcodeFormatFor(song.format)
    if (transcode) params.push(`format=${transcode}`)
  }
  if (quality && quality !== 'original') params.push(`quality=${quality}`)
  if (normalize) params.push('normalize=1')
  if (retry != null && retry > 0) params.push(`retry=${retry}`)
  return params.join('&')
}

/**
 * 歌曲播放地址。
 *
 * 与 Flutter 端一致：指定 track 时**不再附加 format** —— 容器由后端按该音轨编码决定
 * （AAC → m4a 无损 remux，否则 → mp3），两个参数一起给会互相冲突。
 *
 * ★ 「播放失败换源」刻意**不在这里做**：换个码率 / 关掉音量归一化都只是**换一种读取方式**，
 *   坏源还是那个坏源。真正要找的是**另一个音源**，而找源这件事只有后端能做（它才有插件，
 *   才有跨插件搜索）。客户端能做的就是**把地址重新要一次**（重新解析），见 playerCore 的
 *   error 处理；`retry` 参数只为让这次请求是一个「新」地址。
 */
export function buildSongUrl(
  song: Song,
  ctx: ResourceContext,
  options: SongUrlOptions = {}
): string {
  const source = song.url ?? song.source_url ?? ''
  if (!source) return ''
  /*
   * 本地文件：地址就是我们自己的协议，后端那些参数（quality / normalize / track / format）
   * 一个都不适用 —— 拼上去等于把一个本机路径当成后端资源来谈。
   * 只保留 retry：它存在的意义是让「重新要一次」是个**不同的地址**（绕开浏览器对已失败
   * 响应的缓存复用），这件事与音源在哪无关。
   */
  if (isLocalFileUrl(source)) {
    const retry = options.retry ?? 0
    return retry > 0 ? `${source}?retry=${retry}` : source
  }
  const result = buildResourceUrl(source, ctx)
  if (!result) return ''

  const query = buildSongQuery(song, options)
  if (!query) return result
  return `${result}${result.includes('?') ? '&' : '?'}${query}`
}

/**
 * 「预热下一首」的请求路径（`GET /songs/{id}/play?…&prefetch=1`，后端立即回 202）。
 *
 * ★ 返回 null = 这首歌不值得预热，三种情况：
 *   · 本地文件（id ≤ 0 的、双击打开的路径型地址）：不经过网络，没有什么可预热的；
 *   · 外链直连（绝对 http(s)）：真实播放根本走不到后端，预热只会让后端白下一份；
 *   · 地址为空：连播放地址都没有，预热必然 404。
 * ★ 路径里刻意不带 `track`：切轨是用户随后的选择，预热按默认轨（原唱）更可能命中。
 */
export function prefetchSongPath(song: Song, options: SongUrlOptions = {}): string | null {
  if (song.id <= 0 || song.type === 'local') return null
  const source = song.url ?? song.source_url ?? ''
  if (!source.startsWith('/')) return null
  const query = buildSongQuery(song, options)
  return `/songs/${song.id}/play?${query ? `${query}&` : ''}prefetch=1`
}
