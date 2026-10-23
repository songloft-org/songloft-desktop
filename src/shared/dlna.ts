/**
 * 投送到局域网音箱（DLNA / UPnP AVTransport）的**纯逻辑**。
 *
 * ★ 控制点在客户端，不在服务端 —— 与上游 Flutter 版一致（它用 `dlna_dart`）。
 *   服务端不需要为投送做任何改动：音箱要拉的那条流本来就有
 *   （`/songs/{id}/play?access_token=…`，`<audio>` 一直这么用）。
 *   所以这里全部是标准协议处理，没有一行业务后端的事。
 *
 * ★ 本文件只放无副作用的纯函数（把字节/字符串翻译成结构），
 *   真正开 socket、发 SOAP 的活在主进程 `main/dlna.ts`。分开是为了能直接单测 ——
 *   SSDP 响应与设备描述都是别家固件写的，格式比文档松得多。
 */

/* ─────────────────────────────── 类型 ─────────────────────────────── */

/** 一台可投送的 DLNA 渲染器（音箱 / 电视 / Soundbar） */
export interface DlnaDevice {
  /** 设备描述里的 UDN；换 IP 也不变，界面上用它做 key */
  id: string
  name: string
  model: string
  manufacturer: string
  /** 设备所在 IP（同名设备靠它区分） */
  host: string
  /** 设备描述文档地址 */
  location: string
  /** AVTransport 的控制地址（绝对地址，直接 POST SOAP） */
  controlUrl: string
  /**
   * AVTransport 的服务类型，原样进 SOAPACTION 头。
   *
   * ★ 不能写死 `:1`：有的设备报的是 `:2`，类型对不上时设备会直接回 401/500，
   *   而错误信息只说着「Invalid Action」，很难反推。
   */
  controlType: string
  /** RenderingControl 的控制地址；设备没有这个服务时为 null（音量就控不了） */
  volumeUrl: string | null
  volumeType: string | null
}

/** 投送状态快照（跨 IPC 传给渲染层） */
export interface DlnaStatus {
  active: boolean
  deviceId?: string
  deviceName?: string
  songId?: number
  title?: string
  /** 设备上报的原始传输状态：PLAYING / PAUSED_PLAYBACK / STOPPED / TRANSITIONING */
  state?: string
  playing: boolean
  position: number
  duration: number
  /** -1 表示设备不支持音量控制 */
  volume: number
  /**
   * **一次性**标志：取走就清。客户端拿到它就该推进队列并投下一首。
   *
   * ★ 有些设备播完不会回 STOPPED 而是从头循环（小爱 S12 实测），
   *   所以判定还有「位置走到末尾」这一条兜底，见 main/dlna.ts 的 poll()。
   */
  completed: boolean
  /**
   * 正在把这一首**变成后端本地文件**（下载 / 转码落盘），还没交给设备。
   *
   * ★ 这一段设备那边什么都没有（`position` / `duration` / `volume` 都还是空的），
   *   界面不能拿它去覆盖播放器状态，只该把底栏那一行换成「正在准备本地缓存…」。
   */
  preparing?: boolean
  /**
   * 一句给底栏看的**普通**提示（不是错误），过一会儿自己消失。
   *
   * 目前只有一种：等不到本地文件、按原地址硬投了，这一首可能断续。
   */
  notice?: string
  error?: string
}

export type CastAction = 'play' | 'pause' | 'stop' | 'seek' | 'volume'

/** 渲染层发起一次投送时要告诉主进程的全部信息 */
export interface CastRequest {
  deviceId: string
  songId: number
  /** 投送的曲名（写进设备的 DIDL 元数据，音箱屏幕上显示的就是它） */
  title: string
  /**
   * 音频地址（**已经**带好 access_token 与 format 参数，由渲染层的 buildSongUrl 拼）。
   *
   * ★ 为什么让渲染层拼：token、码率偏好、要转码的格式都在那边，
   *   主进程再拼一份必然与真实播放的那条地址漂移（后端缓存键敏感）。
   */
  url: string
  /** 曲库里的格式，用来决定 DIDL 里的 mime（ape 之类已经被 buildSongUrl 转成 mp3 了） */
  format?: string | null
  /**
   * 从第几秒开始放（缺省 0 = 从头）。
   *
   * ★ 「本机 → 投送」互切时用它接上进度：用户在 1:47 时切到音箱，听到的仍是 1:47，
   *   而不是从头再来一遍。
   */
  position?: number
  /**
   * 交付之后是否立刻开始放（缺省 true）。
   *
   * 本机那边是**暂停**时传 false：设备把这一首装好、停在 `position` 处 —— 播放状态
   * 不因「切到投送」而改变。
   */
  autoplay?: boolean
  /**
   * 这是**直播流**（电台），没有「整首落盘」这回事。
   *
   * ★ 用来跳过投送前那段「等本地文件」：电台永远等不到（后端对它可以忽略 prefetch，
   *   而播放地址背后是 m3u8 / 裸流），干等只会让用户白看 60 秒转圈。
   */
  live?: boolean
}

/* ───────────────────────────── SSDP 发现 ───────────────────────────── */

export const SSDP_ADDRESS = '239.255.255.250'
export const SSDP_PORT = 1900

/** 只找「能放音视频的渲染器」：电视、音箱、功放都会应答这个 ST */
export const MEDIA_RENDERER_ST = 'urn:schemas-upnp-org:device:MediaRenderer:1'

/** 一条 M-SEARCH 请求。`MX` 给设备 2 秒随机延迟，太短时部分固件干脆不回 */
export function buildSearchRequest(st: string, mx = 2): string {
  return [
    'M-SEARCH * HTTP/1.1',
    `HOST: ${SSDP_ADDRESS}:${SSDP_PORT}`,
    'MAN: "ssdp:discover"',
    `MX: ${mx}`,
    `ST: ${st}`,
    '',
    ''
  ].join('\r\n')
}

export interface SsdpResponse {
  location: string
  st: string
  usn: string
  server: string
}

/**
 * 解析一条 SSDP 应答。
 *
 * 不是 200 的一律返回 null（会有设备把 NOTIFY 也发到这个 socket 上）；
 * 没有 LOCATION 的也丢掉 —— 那后面什么都做不了。
 */
export function parseSsdpResponse(raw: string): SsdpResponse | null {
  const text = raw.replace(/\r\n/g, '\n')
  const [first, ...rest] = text.split('\n')
  if (!/^HTTP\/1\.[01]\s+200/i.test(first ?? '')) return null

  const headers: Record<string, string> = {}
  for (const line of rest) {
    const index = line.indexOf(':')
    if (index <= 0) continue
    headers[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim()
  }

  const location = headers.location
  if (!location) return null
  return {
    location,
    st: headers.st ?? '',
    usn: headers.usn ?? '',
    server: headers.server ?? ''
  }
}

/* ──────────────────────── 设备描述（description XML）──────────────────────── */

export interface UpnpService {
  serviceType: string
  controlUrl: string
  eventUrl: string
}

export interface UpnpDescription {
  friendlyName: string
  manufacturer: string
  modelName: string
  udn: string
  services: UpnpService[]
}

function tagValue(xml: string, tag: string): string {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i').exec(xml)
  return match ? decodeXml(match[1].trim()) : ''
}

/**
 * 解析设备描述文档。
 *
 * ★ 只扫**全文**的 `<service>` 块，不按 `<device>` 层级递归：音箱的描述常常是
 *   「根设备 + 一个子设备」，AVTransport 挂在哪一层各家不一样，而我们要的是
 *   「这台机器上有没有 AVTransport、控制地址是什么」，层级对结果没有影响。
 */
export function parseDescription(xml: string): UpnpDescription {
  const services: UpnpService[] = []
  for (const match of xml.matchAll(/<service>([\s\S]*?)<\/service>/gi)) {
    const block = match[1]
    const serviceType = tagValue(block, 'serviceType')
    const controlUrl = tagValue(block, 'controlURL')
    if (!serviceType || !controlUrl) continue
    services.push({ serviceType, controlUrl, eventUrl: tagValue(block, 'eventSubURL') })
  }

  return {
    friendlyName: tagValue(xml, 'friendlyName'),
    manufacturer: tagValue(xml, 'manufacturer'),
    modelName: tagValue(xml, 'modelName'),
    udn: tagValue(xml, 'UDN'),
    services
  }
}

/** 把描述文档里的相对 controlURL 拼成绝对地址（描述里的路径是相对 LOCATION 的） */
export function absoluteUrl(base: string, path: string): string {
  if (/^https?:\/\//i.test(path)) return path
  try {
    return new URL(path, base).toString()
  } catch {
    return path
  }
}

export function findService(
  services: UpnpService[],
  type: 'AVTransport' | 'RenderingControl'
): UpnpService | null {
  return services.find((s) => s.serviceType.includes(`:service:${type}:`)) ?? null
}

/* ───────────────────────────── SOAP / DIDL ───────────────────────────── */

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/** SOAP 信封。action 的具体参数由调用方拼在 inner 里（各家要的参数不一样，见 main/dlna.ts） */
export function buildSoapEnvelope(serviceType: string, action: string, inner: string): string {
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ' +
    's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
    `<s:Body><u:${action} xmlns:u="${serviceType}">${inner}</u:${action}></s:Body>` +
    '</s:Envelope>'
  )
}

/** 从 SOAP 应答里取一个字段（`<RelTime>00:00:12</RelTime>`） */
export function parseSoapValue(xml: string, tag: string): string {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i').exec(xml)
  return match ? decodeXml(match[1].trim()) : ''
}

/**
 * DIDL-Lite 元数据。设备没有它也能放，但**曲名会显示成 URL 或空**，
 * 小爱这类带屏音箱尤其明显 —— 所以一律带上。
 */
export function buildDidl(title: string, url: string, mime: string): string {
  return (
    '<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" ' +
    'xmlns:dc="http://purl.org/dc/elements/1.1/" ' +
    'xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">' +
    '<item id="1" parentID="0" restricted="1">' +
    `<dc:title>${escapeXml(title)}</dc:title>` +
    '<upnp:class>object.item.audioItem.musicTrack</upnp:class>' +
    `<res protocolInfo="http-get:*:${mime}:*">${escapeXml(url)}</res>` +
    '</item></DIDL-Lite>'
  )
}

/**
 * 格式 → MIME。
 *
 * ★ 走不到这里的格式（ape / wma / dsd…）说明渲染层的 `buildSongUrl` 已经要求后端
 *   转成 mp3 了（`transcodeFormatFor`），所以这里默认给 `audio/mpeg` 是**对的**，
 *   不是偷懒：那些格式的 URL 出来本来就是 mp3。
 */
export function mimeForFormat(format: string | null | undefined): string {
  switch ((format ?? '').toLowerCase()) {
    case 'flac':
      return 'audio/flac'
    case 'wav':
      return 'audio/wav'
    case 'ogg':
    case 'opus':
      return 'audio/ogg'
    case 'm4a':
    case 'alac':
      return 'audio/mp4'
    case 'aac':
      return 'audio/aac'
    default:
      return 'audio/mpeg'
  }
}

/** `00:03:45` / `0:03:45.120` / `03:45` → 秒。解析不了返回 0（设备常有各种怪写法） */
export function parseTimeToSeconds(value: string): number {
  if (!value) return 0
  const parts = value.trim().split(':')
  if (parts.length === 0 || parts.length > 3) return 0
  let seconds = 0
  for (const part of parts) {
    const number = Number.parseFloat(part)
    if (!Number.isFinite(number) || number < 0) return 0
    seconds = seconds * 60 + number
  }
  return seconds
}

/** 秒 → `HH:MM:SS`（Seek 动作要这个格式） */
export function formatSecondsToHms(total: number): string {
  const clamped = Math.max(0, Math.floor(total))
  const hours = Math.floor(clamped / 3600)
  const minutes = Math.floor((clamped % 3600) / 60)
  const seconds = clamped % 60
  return [hours, minutes, seconds].map((n) => String(n).padStart(2, '0')).join(':')
}

/* ───────────────────────────── 网络小工具 ───────────────────────────── */

/**
 * 是不是「不该用来发现音箱」的网卡。
 *
 * ★ 本机常年挂着 docker / vbox / virbr 这些虚拟网桥。对它们发 M-SEARCH 只是
 *   白等一轮超时（有时还会拖慢整轮），而音箱永远只会在物理网卡那一侧。
 */
export function isVirtualInterface(name: string): boolean {
  const lowered = name.toLowerCase()
  if (lowered === 'lo' || lowered.startsWith('lo:')) return true
  const prefixes = [
    'docker',
    'br-',
    'veth',
    'virbr',
    'vmnet',
    'vboxnet',
    'tun',
    'tap',
    'utun',
    'wg',
    'zt',
    'tailscale',
    'cni',
    'flannel',
    'kube'
  ]
  return prefixes.some((prefix) => lowered.startsWith(prefix))
}

/**
 * 把「只在本机有效」的媒体地址换成局域网地址。
 *
 * ★ 什么时候需要：后端跑在**这台机器**上时，渲染层拼出来的地址是
 *   `http://localhost:58091/...`，音箱照着这个地址去拉只会连到它自己。
 *   后端跑在另一台机器（地址本来就是局域网 IP）时这里原样返回。
 */
export function rewriteToLan(url: string, lanIp: string | null): string {
  if (!lanIp) return url
  try {
    const parsed = new URL(url)
    const host = parsed.hostname.toLowerCase()
    if (host !== 'localhost' && host !== '127.0.0.1' && host !== '::1' && host !== '[::1]') {
      return url
    }
    parsed.hostname = lanIp
    return parsed.toString()
  } catch {
    return url
  }
}

/**
 * 「请后端把这一首落到本地」的地址：在同一条播放地址上加 `prefetch=1`（后端立即回 202）。
 *
 * ★ 必须加在**投送真正会用的那条地址**上：后端按「插件 + 源 + 格式 + 码率 + 均衡」算缓存键，
 *   预热与真实播放差一项，预热出来的就是一份谁也命中不了的产物。
 * ★ 也正因为这一条，投送前要先有渲染层拼好的那份 URL，主进程不自己拼。
 */
export function prefetchUrl(url: string): string {
  if (!url) return ''
  return `${url}${url.includes('?') ? '&' : '?'}prefetch=1`
}

/** 只取响应头的一个最小接口 —— 不引入 DOM 的 Headers 类型，`shared/` 里保持纯 */
export interface ResponseHeadersLike {
  get(name: string): string | null
}

/**
 * 这个响应是不是**后端本地文件**（而不是边转边发 / 边下边发的那条流）。
 *
 * ★ 为什么判据成立：落盘的文件交给 `http.ServeFile`，一定带 `Content-Length` 与
 *   `Accept-Ranges: bytes`；实时转码那条流给不出确定长度（`Content-Length` 是按 CBR 估算的、
 *   还挂着 `Cache-Control: no-store`），边下边发那条更是拿不到总长。
 * ★ 为什么这件事要紧：设备拿不到总长的流，缓冲策略普遍很差 —— 投送一首歌听到一半断断续续、
 *   或者播完不进入下一首，都是这么来的（见 AGENTS.md §8.20 的实测记录）。
 */
export function isBackendLocalFile(headers: ResponseHeadersLike): boolean {
  const length = Number.parseInt(headers.get('content-length') ?? '', 10)
  const ranges = (headers.get('accept-ranges') ?? '').toLowerCase()
  return Number.isFinite(length) && length > 0 && ranges === 'bytes'
}
