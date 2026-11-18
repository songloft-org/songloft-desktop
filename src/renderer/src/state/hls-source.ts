/**
 * HLS（m3u8）播放通道。
 *
 * ★ 为什么需要它：Chromium **桌面版不支持** `<audio src="…m3u8">` 直接播放 —— 只有
 *   Android Chrome / Safari 自带 HLS 解析。而后端对 HLS 电台返回的恰好是
 *   `/api/v1/songs/{id}/play.m3u8`（见 songloft 的 `Song.PlaybackURL()`，那是为 ExoPlayer /
 *   AVPlayer 按后缀识别媒体类型而加的）。于是把这条地址丢给 `<audio>` 必然拿到
 *   `MEDIA_ERR_SRC_NOT_SUPPORTED`，底栏只显示「播放失败」。
 *   上游 Web 端能放是因为它也接了 hls.js（songloft-player 的 web_audio_platform_web.dart）。
 *
 * ★ 为什么懒加载：hls.js 是几百 KB 的包，而绝大多数播放是本地文件与网络歌曲，一条 HLS
 *   都用不到。动态 import 让它单独成块，普通播放一字节都不多下载。
 *
 * ★ 这里只管「把一条 m3u8 变成能出声的流」，不管换源、不管文案。失败按**种类**交给调用方
 *   （state/player-core），由它决定是重试 HLS 还是回落到服务端转码（`radio_transcode=mp3`）。
 *
 * ★ **没有 CORS 的源**（视频源尤其常见）由主进程代取，见 `relay` 选项与 shared/hls-relay：
 *   这里只是在 loadSource 之前把地址换成中继地址，其余一切照旧（loader / 失败分类都不变）。
 */

import type Hls from 'hls.js'
import type { ErrorData } from 'hls.js'

import { relayUrlFor } from '@shared/hls-relay'

/** 失败的种类：调用方据此决定说什么话（跨域是唯一「有明确解法」的那一种） */
export type HlsFailure = 'cors' | 'network' | 'media'

export type HlsFatalHandler = (failure: HlsFailure, detail: string) => void

export interface HlsLoadOptions {
  /**
   * 走主进程中继（`songloft-hls://`，见 shared/hls-relay）。
   *
   * ★ 什么时候该开：源站没有 CORS 头，或者我们根本不知道它有没有 —— 视频源属于后者
   *   （后端 `?media=video` 一律 302 到源站，最终响应头由源站说了算），外链电台也是。
   *   后端自己的地址（`/songs/{id}/play…`）**不开**：那份响应本来就带着放行头，直连更短。
   */
  relay?: boolean
}

/**
 * 这条地址是不是 HLS 播放列表。
 *
 * 只看**路径后缀**（忽略 query / hash，大小写不敏感）—— 与后端 `isHLSURL` 的口径一致。
 * 后端把 HLS 电台的播放地址刻意写成 `/play.m3u8`，所以客户端不必去猜 song.type。
 */
export function isHlsUrl(url: string): boolean {
  if (!url) return false
  let path = url
  const hash = path.indexOf('#')
  if (hash >= 0) path = path.slice(0, hash)
  const query = path.indexOf('?')
  if (query >= 0) path = path.slice(0, query)
  const lower = path.toLowerCase()
  return lower.endsWith('.m3u8') || lower.endsWith('.m3u')
}

/**
 * 这个环境有没有 MSE（hls.js 的前提）。
 *
 * 不在这里 `Hls.isSupported()`：那需要先把几百 KB 的包下载下来。MSE 不存在时直接让调用方
 * 走服务端转码，比「下载完再说不行」划算。
 */
export function supportsHls(): boolean {
  return typeof window !== 'undefined' && typeof window.MediaSource !== 'undefined'
}

/** fatal 错误归类。跨域的判据是「请求根本没拿到状态码」 */
function classify(data: ErrorData): HlsFailure {
  if (data.type === 'mediaError') return 'media'
  if (data.type === 'networkError') {
    const status = data.response?.code
    // 0 = 浏览器把响应挡在 JS 之外（CORS 未通过、DNS 失败、连接被拒都落在这里）。
    // 后端 302 到源站时，源站的切片/子清单若没有 Access-Control-Allow-Origin 就走这一支。
    if (status === 0 || status === undefined) return 'cors'
  }
  return 'network'
}

/**
 * 底栏那一行要放得下：一句短话，指明用户能做什么。
 *
 * ★ 不把「取不到」一律说成跨域：status 0 也包含 DNS 失败 / 连接被拒（hls.js 在浏览器侧
 *   本来就分不出这两者）。这里给出**唯一有解法的那个动作**，同时保留「网络不通」的可能。
 * ★ 走中继时不提那个开关：中继已经在主进程代取了，跨域这一层根本不存在，剩下的可能只有
 *   「源站自己不通 / 拒绝这台机器」—— 再让用户去服务器上开一个对视频无效的开关，是误导。
 */
function describe(failure: HlsFailure, relay: boolean): string {
  switch (failure) {
    case 'cors':
      return relay
        ? '取不到媒体流（网络不通或源站拒绝）'
        : '跨域受限或网络不通，可开启服务端「HLS 代理」'
    case 'media':
      return '音频无法解码'
    default:
      return '网络中断'
  }
}

/**
 * 一个进程只有一条输出通道（与 player-core 那颗媒体元素对应），所以这里也是单例。
 *
 * 生命周期约定：**换源之前先 `stop()`**。hls.js 的 `destroy()` 会自己摘掉 media 上的
 * object URL，所以紧接着设 `audio.src = …` 不会撞车。
 */
class HlsChannel {
  private hls: Hls | null = null
  /** 世代号：动态 import 期间用户可能已经换歌/换源，回来时用它判断自己作不作数 */
  private generation = 0

  /** 此刻 audio 上挂的是不是 hls.js（MSE 给的 blob: 地址，不能拿它跟逻辑地址比） */
  isActive(): boolean {
    return this.hls !== null
  }

  /**
   * 把 `url` 交给 hls.js 播放。
   *
   * 返回值：`true` = 这一路归 hls.js 管（也让出 `audio.src` 的所有权）；`false` = 这个环境
   * 干不了（没有 MSE / 包加载失败 / 明说不支持），调用方应当退回「直接设 `audio.src`」。
   *
   * ★ 不等 playlist 解析完：起播预算由 player-core 的超时表管（见 sourceTimeoutFor），
   *   而解析失败会走 `onFatal` → 换源链，比在这里再堆一套超时更简单，也不会与它打架。
   */
  // 参数是 HTMLMediaElement 而不是 HTMLAudioElement：视频电台要挂到 `<video>` 上
  // （见 state/player-core 那颗媒体元素）。hls.js 的 attachMedia 本来就只认这个父类型。
  async load(
    audio: HTMLMediaElement,
    url: string,
    onFatal: HlsFatalHandler,
    options: HlsLoadOptions = {}
  ): Promise<boolean> {
    this.stop()
    if (!supportsHls()) return false
    const relay = options.relay === true

    const generation = ++this.generation
    let HlsCtor: typeof Hls
    try {
      HlsCtor = (await import('hls.js')).default
    } catch {
      // 包没下载下来（离线 / 打包漏了 chunk）：当作不支持，让调用方走服务端转码
      return false
    }
    // 加载期间已经换源 / 停止 / 又开了一路：这一路作废，但别让调用方去抢 audio.src
    if (generation !== this.generation) return true
    if (!HlsCtor.isSupported()) return false

    const hls = new HlsCtor({
      /*
       * 直播电台不需要低延迟：低延迟模式在网络抖动时更激进地丢缓冲，换来的却是更容易卡顿。
       * 电台听的是「不断」，不是「不差那两秒」。
       */
      lowLatencyMode: false,
      /*
       * 电台可能连听几小时：只留最近 30 秒，别让 MSE 的 SourceBuffer 与内存一直长。
       */
      backBufferLength: 30,
      maxBufferLength: 30,
      /*
       * 打包态的 CSP 是 `script-src 'self'`，hls.js 的转封装 worker 是 blob: URL —— 会被挡掉，
       * 然后它自己退回主线程并打一条告警。直接关掉：音频流几十 KB/s，主线程转封装毫无压力。
       */
      enableWorker: false
    })

    hls.on(HlsCtor.Events.ERROR, (_event, data: ErrorData) => {
      // 非 fatal 的错误 hls.js 自己会恢复（重试 / 丢坏片），不该被打断
      if (!data.fatal) return
      if (this.hls !== hls) return
      const failure = classify(data)
      this.stop()
      onFatal(failure, describe(failure, relay))
    })

    this.hls = hls
    hls.attachMedia(audio)
    // 中继只换「第一条地址」：主进程会把列表里每条 URI 都改写成中继地址（见 shared/hls-relay）
    hls.loadSource(relay ? relayUrlFor(url) : url)
    return true
  }

  /** 摘掉 HLS 通道（audio 上的 blob: 地址也由 hls.js 自己收回） */
  stop(): void {
    this.generation += 1
    const hls = this.hls
    this.hls = null
    if (hls) hls.destroy()
  }
}

export const hlsChannel = new HlsChannel()
