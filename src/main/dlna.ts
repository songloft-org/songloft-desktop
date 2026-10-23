/**
 * 投送到局域网音箱：主进程这一侧（SSDP 发现 + SOAP 控制 + 状态轮询）。
 *
 * ★ 为什么必须在主进程：渲染层是浏览器上下文，开不了 UDP socket；而 SSDP 是要往
 *   239.255.255.250:1900 发组播的。主进程就是 Node，`dgram` + `fetch` 足够，
 *   不需要任何原生依赖（本仓库运行期依赖只有 zustand 这一条得守住）。
 *
 * ★ 控制点在**客户端**，服务端一行代码都不需要动。音箱要拉的那条流本来就有
 *   （`<audio>` 一直用的那条 `/songs/{id}/play?access_token=…`），
 *   地址由渲染层的 buildSongUrl 拼好传进来，这里只负责把它交给设备。
 */

import dgram from 'node:dgram'
import { networkInterfaces } from 'node:os'

import {
  absoluteUrl,
  buildDidl,
  buildSearchRequest,
  buildSoapEnvelope,
  escapeXml,
  findService,
  formatSecondsToHms,
  isVirtualInterface,
  MEDIA_RENDERER_ST,
  mimeForFormat,
  parseDescription,
  parseSoapValue,
  parseSsdpResponse,
  parseTimeToSeconds,
  rewriteToLan,
  SSDP_ADDRESS,
  SSDP_PORT,
  type CastAction,
  type CastRequest,
  type DlnaDevice,
  type DlnaStatus,
  type SsdpResponse
} from '@shared/dlna'

/** 设备列表缓存：一轮发现要等 3 秒，别每开一次对话框就重搜一遍 */
const DISCOVERY_TTL_MS = 60_000
/**
 * 状态轮询间隔（**上一轮回来之后再等这么久**，不是固定节拍）。
 *
 * ★ 这里一次轮询就是两台机器之间两三个 HTTP 请求，而设备同时还在自己拉音频流。
 *   低端 DLNA 设备的 HTTP 服务很弱（有的几乎是单线程），控制请求一多，它读流就断 ——
 *   所以宁可让进度条动得慢半拍，也不能给它加压。见 schedulePoll 的说明。
 */
const POLL_INTERVAL_MS = 2_000
/**
 * 投送刚开始的前几轮**每轮都读音量**。
 *
 * ★ 起播那一次读不到（设备正忙着 TRANSITIONING，实测小爱会拒绝），而底栏那根滑条要等
 *   读到值才可用 —— 头几轮密集读是为了让它尽快恢复正常。
 */
const VOLUME_DENSE_ROUNDS = 10
/** 之后每这么多轮读一次：音量不是每两秒都会变的东西，读太勤等于白给设备添活 */
const VOLUME_EVERY_ROUNDS = 5

interface Session {
  device: DlnaDevice
  songId: number
  title: string
  /** 已经改写好的音频地址（音箱能访问的那一份） */
  url: string
  format: string | null
  /** 设备上报的原始传输状态 */
  state: string
  playing: boolean
  /**
   * 此刻是**暂停**，不是「在放」。
   *
   * ★ 用途只有一个：把「暂停」与「播完」分开。实测小爱 S12 收到 Pause 后传输状态直接
   *   掉到 STOPPED（过一两秒又自己回到 PLAYING），而下面 poll 里把「放起来过 + STOPPED」
   *   当成播完 —— 于是一按暂停就自动跳下一首。位置兜底那一条同理：停在最后一秒内会被
   *   误判成播完。两条判据都要先问一句 `!paused`。
   */
  paused: boolean
  /**
   * 按下暂停那一刻的位置（0 = 没有）。
   *
   * ★ 为什么不能只看 `position`：小爱这类设备收到 Pause 会真的 Stop 掉，之后 RelTime 就报
   *   0:00:00。继续播放是从「暂停那一刻」接着放的（见 control('play')），所以那个位置得
   *   单独记着 —— 否则一继续就从头开始，而底栏还显示着 0:00。
   */
  pausedPosition: number
  /** 见过 PLAYING 没有：切歌瞬间设备会短暂 STOPPED，没见过就判完成会一次跳两首 */
  started: boolean
  /** 有一个还没被推走的「播完」事件 */
  completed: boolean
  /** 这一首已经报过完成了（有些设备会循环播，不拦会每轮都报） */
  completionFired: boolean
  position: number
  duration: number
  volume: number
  error: string
}

type Listener = (status: DlnaStatus) => void

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** 参与发现的本机地址（跳过 docker / vbox / virbr 这些虚拟网桥） */
function candidateAddresses(): string[] {
  const out: string[] = []
  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    if (isVirtualInterface(name)) continue
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) out.push(address.address)
    }
  }
  return out
}

/**
 * 「从这里出发到那台设备」用的是哪块网卡的本机地址。
 *
 * ★ 用 UDP connect 问操作系统：它不发任何包，只让内核选出路由与源地址，
 *   然后从 socket 上读回来。比「猜默认网卡」准 —— 家里常有多块网卡（有线 + 无线 +
 *   一堆虚拟网桥），猜错就会把 `192.168.x.x` 写成另一张网段的地址，
 *   表现是投送成功但设备一直 TRANSITIONING（它连不上那个地址）。
 */
function localAddressFor(host: string): Promise<string | null> {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4')
    let settled = false
    const finish = (value: string | null): void => {
      if (settled) return
      settled = true
      try {
        socket.close()
      } catch {
        // 已经关了
      }
      resolve(value)
    }
    socket.once('error', () => finish(null))
    socket.connect(SSDP_PORT, host, () => {
      try {
        finish(socket.address().address)
      } catch {
        finish(null)
      }
    })
    setTimeout(() => finish(null), 1_000)
  })
}

async function soapAction(
  controlUrl: string,
  serviceType: string,
  action: string,
  inner: string,
  timeoutMs = 8_000
): Promise<string> {
  const response = await fetch(controlUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/xml; charset="utf-8"',
      SOAPACTION: `"${serviceType}#${action}"`
    },
    body: buildSoapEnvelope(serviceType, action, inner),
    signal: AbortSignal.timeout(timeoutMs)
  })
  const text = await response.text()
  if (!response.ok) {
    // UPnP 的错误码在 body 里，比 HTTP 状态码有用得多（701 = 不认这个 URI）
    const code = parseSoapValue(text, 'errorCode')
    const description = parseSoapValue(text, 'errorDescription')
    throw new Error(
      code
        ? `设备拒绝了${action}（${code} ${description || 'UPnP 错误'}）`
        : `设备拒绝了${action}（HTTP ${response.status}）`
    )
  }
  return text
}

export class DlnaController {
  private devices: DlnaDevice[] = []
  private discoveredAt = 0
  private session: Session | null = null
  private pollTimer: NodeJS.Timeout | null = null
  private pollCount = 0
  /** 上一轮音量查询还没回来时不再发新的（慢设备上它会和下一轮甚至下下轮叠在一起） */
  private volumeInFlight = false
  private listener: Listener | null = null
  private discovering: Promise<DlnaDevice[]> | null = null

  /** 主进程把状态推给渲染层（main/index.ts 注册） */
  onUpdate(listener: Listener): void {
    this.listener = listener
  }

  /**
   * 发现设备。`force` 忽略缓存。
   *
   * ★ 并发去重：用户连点两下「重新搜索」不该同时跑两轮 SSDP（两轮会抢同一个 UDP
   *   端口，还可能各自只收到一半响应）。
   */
  async discover(force = false): Promise<DlnaDevice[]> {
    if (!force && this.devices.length > 0 && Date.now() - this.discoveredAt < DISCOVERY_TTL_MS) {
      return this.devices
    }
    if (this.discovering) return this.discovering

    this.discovering = this.runDiscovery().finally(() => {
      this.discovering = null
    })
    return this.discovering
  }

  private async runDiscovery(): Promise<DlnaDevice[]> {
    const answers = await this.ssdpSearch()
    const seen = new Set<string>()
    const devices: DlnaDevice[] = []

    const described = await Promise.all(
      answers.map(async (answer) => {
        if (seen.has(answer.location)) return null
        seen.add(answer.location)
        return this.describe(answer.location)
      })
    )

    for (const device of described) {
      if (device) devices.push(device)
    }
    // 名字排一下，界面上顺序稳定（不然每次搜索顺序都不一样）
    devices.sort((a, b) => a.name.localeCompare(b.name))
    this.devices = devices
    this.discoveredAt = Date.now()
    return devices
  }

  private async ssdpSearch(timeoutMs = 3_000): Promise<SsdpResponse[]> {
    const addresses = candidateAddresses()
    if (addresses.length === 0) throw new Error('这台机器没有可用的局域网网卡')

    const found = new Map<string, SsdpResponse>()
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    socket.on('message', (message) => {
      const parsed = parseSsdpResponse(message.toString('utf8'))
      // USN 区分「同一台设备的多个服务」，LOCATION 相同的描述只取一次
      if (parsed) found.set(`${parsed.location}|${parsed.usn}`, parsed)
    })

    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject)
      socket.bind({ address: '0.0.0.0', port: 0 }, () => resolve())
    })

    const request = Buffer.from(buildSearchRequest(MEDIA_RENDERER_ST))
    for (const address of addresses) {
      try {
        socket.setMulticastInterface(address)
      } catch {
        // 某块网卡配不上组播：跳过它，别让整轮发现失败
        continue
      }
      for (let attempt = 0; attempt < 2; attempt++) {
        await new Promise<void>((resolve) => {
          socket.send(request, SSDP_PORT, SSDP_ADDRESS, () => resolve())
        })
        await delay(120)
      }
    }

    await delay(timeoutMs)
    socket.close()
    return [...found.values()]
  }

  private async describe(location: string): Promise<DlnaDevice | null> {
    try {
      const response = await fetch(location, { signal: AbortSignal.timeout(4_000) })
      if (!response.ok) return null
      const xml = await response.text()
      const description = parseDescription(xml)
      const transport = findService(description.services, 'AVTransport')
      // 没有 AVTransport 的设备放不了：列出来只会让人点进去失败
      if (!transport) return null
      const volume = findService(description.services, 'RenderingControl')

      let host = ''
      try {
        host = new URL(location).hostname
      } catch {
        // 设备报了个怪地址：host 留空，界面少显示一项而已
      }

      return {
        id: description.udn || location,
        name: description.friendlyName || host || 'DLNA 音箱',
        model: description.modelName,
        manufacturer: description.manufacturer,
        host,
        location,
        controlUrl: absoluteUrl(location, transport.controlUrl),
        controlType: transport.serviceType,
        volumeUrl: volume ? absoluteUrl(location, volume.controlUrl) : null,
        volumeType: volume?.serviceType ?? null
      }
    } catch {
      // 设备刚离线 / 描述页 500：这一台就算了
      return null
    }
  }

  /**
   * 投送一首歌并开始播放。
   *
   * ★ 只有「真的要出声」的时候才调它（用户点播放、或主动切歌）。
   *   仅仅「选中一台设备」不该走到这里 —— 这些设备收到 SetAVTransportURI 就会自己播，
   *   客户端按不住（实测 Pause / Stop 都会被它 1~2 秒后恢复）。
   *   选设备这一步留在渲染层（只记 activeDevice），见 state/dlna 的 castTo。
   */
  async cast(request: CastRequest): Promise<DlnaStatus> {
    const devices = await this.discover(false)
    const device =
      devices.find((item) => item.id === request.deviceId) ??
      (await this.discover(true)).find((item) => item.id === request.deviceId)
    if (!device) throw new Error('这台音箱已经不在线了，请重新搜索')

    // 旧会话先收掉：不然两台会话共用同一台设备，状态会互相污染
    await this.clearSession()

    // 音箱必须能自己访问到这个地址：后端跑在本机时这里是唯一需要动手的地方
    const lanIp = await localAddressFor(device.host)

    const session: Session = {
      device,
      songId: request.songId,
      title: request.title,
      url: rewriteToLan(request.url, lanIp),
      format: request.format ?? null,
      state: 'TRANSITIONING',
      playing: false,
      paused: false,
      pausedPosition: 0,
      started: false,
      completed: false,
      completionFired: false,
      position: 0,
      duration: 0,
      volume: -1,
      error: ''
    }
    this.session = session

    /*
     * 从渲染层过来的位置开始（「本机 → 投送」互切时接上进度）；缺省 0 = 从头。
     * 与「从暂停里重来」共用同一段：它会等设备把这一首装好，再 Seek 到那一秒。
     */
    const position = Math.max(0, request.position ?? 0)
    await this.loadTransport(session, position)
    session.playing = true

    if (request.autoplay === false) {
      /*
       * 本机那边是**暂停**：设备也停在同一个位置上，播放状态不因切到投送而改变。
       * 有些设备会自己恢复播放（小爱 1~2 秒后回到 PLAYING），那种情况下轮询会把状态
       * 纠正成「在放」—— 那是设备行为，界面跟着真实状态走，不假装暂停。
       */
      session.paused = true
      session.pausedPosition = position
      await soapAction(
        device.controlUrl,
        device.controlType,
        'Pause',
        '<InstanceID>0</InstanceID>'
      ).catch(() => '')
      session.playing = false
    }

    this.startPolling()
    void this.readVolume()
    this.emit()
    return this.snapshot()
  }

  async control(action: CastAction, value = 0): Promise<DlnaStatus> {
    const session = this.session
    if (!session) throw new Error('当前没有正在投送的音箱')
    const { device } = session

    switch (action) {
      case 'play': {
        /*
         * ★ 「从暂停里继续」不试标准 Play，直接**把这一首重新交给设备**（URI + Seek + Play）。
         *
         *   为什么连「试试 Play」都不做：实测小爱 S12 的 Pause 实际是 Stop（传输状态
         *   STOPPED、RelTime 归零），此后发 Play 只有两条死路 ——
         *     · 被设备拒绝：回 SOAP Fault 701 "Transition not available"，soapAction
         *       直接抛错，画面只剩「控制音箱失败」，一次都不会重来；
         *     · 假成功：回 200 但传输状态一动不动，甚至自报 PLAYING 却不出声 ——
         *       所以「发完再问一句状态」也不可靠（问到的可能是假的）。
         *   唯一确定能响的是重新 SetAVTransportURI，再用 Seek 回到暂停那一刻。
         *   对能正常暂停的设备这条路同样成立，只是多花几百毫秒重新拉一次流。
         *
         * ★ 判断依据用 `pausedPosition` 而不是 `paused`：暂停之后设备的传输状态可能自己翻回
         *   PLAYING（小爱就会），轮询跟着把 `paused` 清掉 —— 那时用 `paused` 判断就又会走回
         *   上面那条死路。`pausedPosition` 只在「下一次投送」和「真的继续了」时归零。
         */
        const resumeAt = session.pausedPosition
        if (resumeAt > 0 || session.paused) {
          // 留一行日志：这条路真出问题时，`pnpm dev` 那个终端里能看见设备当时处在什么状态
          console.info(
            `[dlna] 继续播放：设备处于 ${session.state}，把这一首重新交给它，从 ${Math.round(resumeAt || session.position)}s 接着放`
          )
          await this.loadTransport(session, resumeAt || session.position)
        } else {
          // 没暂停过（例如刚选完设备就点了播放）：按标准来
          await soapAction(
            device.controlUrl,
            device.controlType,
            'Play',
            '<InstanceID>0</InstanceID><Speed>1</Speed>'
          )
        }
        session.playing = true
        session.paused = false
        session.pausedPosition = 0
        break
      }
      case 'pause': {
        /*
         * ★ 先把「这是暂停」记上，**再**发 SOAP：有些设备（实测小爱 S12）收到 Pause 会直接
         *   掉到 STOPPED，而 STOPPED 在 poll 里是「播完了」的判据；它随后连 RelTime 也归零。
         *   设备反应可能比这个 await 还快，等回来再记就晚了。
         */
        session.paused = true
        /*
         * 「暂停在哪儿」要现量一次：会话里的 position 来自 2 秒一轮的轮询，可能落后一两秒，
         * 而继续播放正是要回到这个位置 —— 差一两秒是听得出来的。量不到就用会话里那个值。
         */
        const exact = await this.readPosition(session).catch(() => null)
        session.pausedPosition = exact?.position || session.position
        await soapAction(
          device.controlUrl,
          device.controlType,
          'Pause',
          '<InstanceID>0</InstanceID>'
        )
        session.playing = false
        break
      }
      case 'stop':
        await soapAction(
          device.controlUrl,
          device.controlType,
          'Stop',
          '<InstanceID>0</InstanceID>'
        )
        session.playing = false
        break
      case 'seek':
        await soapAction(
          device.controlUrl,
          device.controlType,
          'Seek',
          `<InstanceID>0</InstanceID><Unit>REL_TIME</Unit><Target>${formatSecondsToHms(value)}</Target>`
        )
        session.position = Math.max(0, value)
        // 暂停中拖进度条：继续播放要从这个新位置接着走（见 pausedPosition 的说明）
        if (session.paused) session.pausedPosition = session.position
        break
      case 'volume': {
        if (!device.volumeUrl || !device.volumeType) throw new Error('这台音箱不支持音量控制')
        await soapAction(
          device.volumeUrl,
          device.volumeType,
          'SetVolume',
          `<InstanceID>0</InstanceID><Channel>Master</Channel><DesiredVolume>${Math.round(value)}</DesiredVolume>`
        )
        session.volume = Math.round(value)
        break
      }
    }

    this.emit()
    return this.snapshot()
  }

  /**
   * 把「放什么」交给设备（`position > 0` 时跳到那一秒再放）。
   *
   * ★ 两处共用：新投送一首（位置 0），以及**从暂停里重来**（见 control('play') 那段说明）。
   * ★ 后者的位置必须显式 Seek 一次 —— SetAVTransportURI 之后设备是从头开始的；而且这一步
   *   必须**等设备把这一首装好**再做，见 waitForMediaReady 的说明。
   */
  private async loadTransport(session: Session, position: number): Promise<void> {
    const { device } = session
    const didl = buildDidl(session.title, session.url, mimeForFormat(session.format))
    await soapAction(
      device.controlUrl,
      device.controlType,
      'SetAVTransportURI',
      `<InstanceID>0</InstanceID>` +
        `<CurrentURI>${escapeXml(session.url)}</CurrentURI>` +
        `<CurrentURIMetaData>${escapeXml(didl)}</CurrentURIMetaData>`
    )
    let at = Math.max(0, position)
    if (at > 0) {
      // 先等它把这一首装好，再按「跳过去 + 量一遍确认」的办法挪位置
      await this.waitForMediaReady(session)
      at = await this.seekWithRetry(session, at)
    }
    try {
      await soapAction(
        device.controlUrl,
        device.controlType,
        'Play',
        '<InstanceID>0</InstanceID><Speed>1</Speed>'
      )
    } catch (error) {
      /*
       * 有些设备（小爱实测）收到 SetAVTransportURI 就已经开演了，此时再发 Play 反被它回一句
       * 701「Transition not available」。所以不能一见错就判失败：先问一句状态，真的在放就
       * 当成功；否则把错误抛出去 —— 界面上总得有个交代。
       */
      const state = await this.transportState(session).catch(() => '')
      if (state !== 'PLAYING') throw error
    }
    // 用**量到的**位置：Seek 没被接受时设备其实是从头在放，界面别显示一个假的进度
    session.position = Math.max(0, at)
    session.state = 'PLAYING'
    session.started = true
  }

  /** 读一次传输状态（失败抛错，交给调用方决定怎么兜） */
  private async transportState(session: Session): Promise<string> {
    const info = await soapAction(
      session.device.controlUrl,
      session.device.controlType,
      'GetTransportInfo',
      '<InstanceID>0</InstanceID>',
      4_000
    )
    return parseSoapValue(info, 'CurrentTransportState').toUpperCase()
  }

  /** 读一次进度与时长（失败抛错） */
  private async readPosition(session: Session): Promise<{ position: number; duration: number }> {
    const xml = await soapAction(
      session.device.controlUrl,
      session.device.controlType,
      'GetPositionInfo',
      '<InstanceID>0</InstanceID>',
      4_000
    )
    return {
      position: parseTimeToSeconds(parseSoapValue(xml, 'RelTime')),
      duration: parseTimeToSeconds(parseSoapValue(xml, 'TrackDuration'))
    }
  }

  /**
   * 等设备把刚交给它的那一首**装好**，判据是能读出 `TrackDuration`。
   *
   * ★ 这一步不是可有可无的等待：`SetAVTransportURI` 只是把 URI 递过去，设备还要去拉流、
   *   解析、拿到时长。在它装好之前发的 `Seek` 会被默默丢掉（回 200、位置不动），
   *   于是「继续播放」就成了从头重新放 —— 这正是用户报的那个现象。
   * ★ 最多等 3 秒；等不到也往下走：有的设备对实时流永远报 `NOT_IMPLEMENTED`（时长恒为 0），
   *   不能让它们卡死在这里。
   */
  private async waitForMediaReady(session: Session): Promise<void> {
    for (let attempt = 0; attempt < 12; attempt++) {
      if (attempt > 0) await delay(250)
      const info = await this.readPosition(session).catch(() => null)
      if (info && info.duration > 0) return
    }
  }

  /**
   * 把播放位置挪到 `target` 并**确认真的挪过去了**，返回最后量到的位置。
   *
   * ★ `Seek` 回 200 不等于生效：设备可能还在装流、也可能压根不认 `REL_TIME`。所以每 250ms
   *   重发一次，并且要**连续两次**读到接近目标才算成（刚 Seek 完那一次读数有时是缓存的旧值）。
   * ★ 4 秒还不成就算了：此时它多半是在从头放，把量到的位置返回给调用方，界面跟着真实位置走，
   *   别显示一个假的进度。日志里留一句，方便下次对着看是哪台设备不认。
   */
  private async seekWithRetry(session: Session, target: number): Promise<number> {
    const { device } = session
    const deadline = Date.now() + 4_000
    let measured = 0
    while (Date.now() < deadline) {
      try {
        await soapAction(
          device.controlUrl,
          device.controlType,
          'Seek',
          `<InstanceID>0</InstanceID><Unit>REL_TIME</Unit><Target>${formatSecondsToHms(target)}</Target>`,
          4_000
        )
      } catch {
        /*
         * 设备明确拒绝 —— 常见的是 701「Transition not available」，意思就是「还没准备好」。
         * 这正是要重试的那一种，别在这里放弃。
         */
        measured = (await this.readPosition(session).catch(() => null))?.position ?? measured
        await delay(250)
        continue
      }
      measured = (await this.readPosition(session).catch(() => null))?.position ?? measured
      if (Math.abs(measured - target) <= 3) {
        await delay(250)
        const again = (await this.readPosition(session).catch(() => null))?.position
        if (again !== undefined && Math.abs(again - target) <= 3) return again
        measured = again ?? measured
      }
      await delay(250)
    }
    console.warn(
      `[dlna] 设备没接受 Seek（想跳到 ${Math.round(target)}s，实际停在 ${Math.round(measured)}s）`
    )
    return measured
  }

  /** 只读查询（渲染层应用启动时接回会话用）。**不消费** completed —— 那只由推送消费 */
  status(): DlnaStatus {
    return this.snapshot()
  }

  async stop(): Promise<void> {
    await this.clearSession()
    this.emit()
  }

  private async clearSession(): Promise<void> {
    const session = this.session
    this.session = null
    this.stopPolling()
    if (!session) return
    try {
      await soapAction(
        session.device.controlUrl,
        session.device.controlType,
        'Stop',
        '<InstanceID>0</InstanceID>',
        3_000
      )
    } catch {
      // 设备可能已经断电或被别的 App 抢走：解除绑定这件事不能在界面上失败
    }
  }

  private startPolling(): void {
    this.stopPolling()
    this.pollCount = 0
    this.schedulePoll()
  }

  /**
   * 排下一轮，**在本轮真正结束之后**。
   *
   * ★ 这里曾经用 `setInterval`，那是断断续续的一个直接来源：一轮里串着 `GetTransportInfo`
   *   与 `GetPositionInfo`（各 4 秒超时），设备一慢，2 秒的节拍就赶在上一轮回来之前又叠一轮 ——
   *   并发数越滚越多。而音箱此刻正自己拉着音频流，这些控制请求压在它的 HTTP 服务上
   *   （低端设备几乎是单线程），它读流就断。
   *   改成「上一轮结束 + 一个间隔」之后，慢设备只会让轮询变慢，不会让请求堆积。
   */
  private schedulePoll(): void {
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null
      void this.poll().finally(() => {
        // 轮询期间会话可能已经被收掉（clearSession 里 stopPolling 清过 timer），别再排
        if (this.session) this.schedulePoll()
      })
    }, POLL_INTERVAL_MS)
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer)
      this.pollTimer = null
    }
  }

  private async poll(): Promise<void> {
    const session = this.session
    if (!session) return

    try {
      const state = await this.transportState(session)
      if (state) session.state = state

      if (state === 'PLAYING') {
        session.playing = true
        session.started = true
        // 真的在放：暂停那一档作废（设备可能自己从暂停里恢复了）
        session.paused = false
      } else if (state.startsWith('PAUSED')) {
        session.playing = false
        session.paused = true
      } else if (state === 'STOPPED' || state === 'NO_MEDIA_PRESENT') {
        session.playing = false
        /*
         * ★ 只有「没在暂停」的 STOPPED 才算播完。小爱 S12 收到 Pause 会先报 STOPPED
         *   （1~2 秒后自己回到 PLAYING），照旧判完成的话用户一按暂停就跳下一首 ——
         *   而那不是这首歌放完了，是用户不想听了。
         */
        if (session.started && !session.paused) this.markCompleted(session)
      }

      const positionXml = await soapAction(
        session.device.controlUrl,
        session.device.controlType,
        'GetPositionInfo',
        '<InstanceID>0</InstanceID>',
        4_000
      ).catch(() => '')
      if (positionXml) {
        const rel = parseTimeToSeconds(parseSoapValue(positionXml, 'RelTime'))
        /*
         * ★ 暂停期间设备常把 RelTime 归零（小爱把 Pause 当成 Stop 的副作用）。照抄回去的话，
         *   底栏会从「暂停在 2:31」跳成 0:00，而继续播放是从 2:31 接着放的（见 control('play')）
         *   —— 显示与实际当场对不上。所以暂停中不接受这个 0；反而是非 0 的值要收下，
         *   那才是真正的暂停位置。
         */
        if (!(session.paused && rel === 0)) session.position = rel
        if (session.paused && rel > 0) session.pausedPosition = rel
        const duration = parseTimeToSeconds(parseSoapValue(positionXml, 'TrackDuration'))
        if (duration > 0) session.duration = duration

        /*
         * 兜底：位置走到末尾也算播完。
         *
         * ★ 小爱 S12 实测——DLNA 投送一首 6 秒的歌，它播到第 5 秒会**跳回第 1 秒继续播**，
         *   永远不回 STOPPED。只认 STOPPED 的话「播完自动下一首」在这类设备上永远不生效，
         *   用户看到的就是一首歌无限循环。
         * ★ completionFired 保证一首只报一次，否则这种循环设备每轮轮询都会判一次，
         *   队列会被每 2 秒推进一次。
         * ★ 暂停中也跳过：停在最后一秒里按下暂停，位置本来就贴着 duration，那不是播完。
         */
        if (
          session.started &&
          !session.paused &&
          session.duration > 0 &&
          session.position > 0 &&
          session.position >= session.duration - 1
        ) {
          this.markCompleted(session)
        }
      }

      session.error = ''
      this.pollCount += 1
      /*
       * 音量**不能每轮都读**：投送刚开始的那一次读不到（设备正忙着 TRANSITIONING，实测小爱会拒绝），
       * 但一直每轮读就是每 2 秒多一个 HTTP 请求压在正在拉流的设备上。
       * 折中是「头几轮密集读（滑条尽快恢复）、之后降频」—— 音量不是每两秒都会变的东西。
       */
      if (this.pollCount <= VOLUME_DENSE_ROUNDS || this.pollCount % VOLUME_EVERY_ROUNDS === 0) {
        void this.readVolume()
      }
    } catch (error) {
      // 单次失败不当作会话结束（网络抖动 / 设备忙着切歌），把原因挂上去让人看见
      session.error = error instanceof Error ? error.message : String(error)
    }

    this.emit()
  }

  private async readVolume(): Promise<void> {
    const session = this.session
    if (!session?.device.volumeUrl || !session.device.volumeType) return
    /*
     * ★ 一次只放一个在飞：这个调用是 `void` 发出去的（不阻塞轮询），设备慢的时候
     *   上一次还没回来下一次又发，等于在轮询之外又长出一条会堆积的请求线。
     */
    if (this.volumeInFlight) return
    this.volumeInFlight = true
    try {
      const xml = await soapAction(
        session.device.volumeUrl,
        session.device.volumeType,
        'GetVolume',
        '<InstanceID>0</InstanceID><Channel>Master</Channel>',
        3_000
      )
      const volume = Number.parseInt(parseSoapValue(xml, 'CurrentVolume'), 10)
      // 只有值真的变了才推：无脑 emit 就是每一轮多余一次渲染
      if (Number.isFinite(volume) && volume !== session.volume) {
        session.volume = volume
        this.emit()
      }
    } catch (error) {
      // 不支持音量控制就一直是 -1，界面据此把滑条置灰；日志留在主进程便于排查
      console.warn('[dlna] 读设备音量失败：', error instanceof Error ? error.message : error)
    } finally {
      this.volumeInFlight = false
    }
  }

  /** 一首只报一次完成（调用方持有会话） */
  private markCompleted(session: Session): void {
    session.started = false
    if (session.completionFired) return
    session.completionFired = true
    session.completed = true
  }

  private snapshot(): DlnaStatus {
    const session = this.session
    if (!session) {
      return {
        active: false,
        playing: false,
        position: 0,
        duration: 0,
        volume: -1,
        completed: false
      }
    }
    return {
      active: true,
      deviceId: session.device.id,
      deviceName: session.device.name,
      songId: session.songId,
      title: session.title,
      state: session.state,
      playing: session.playing,
      position: session.position,
      duration: session.duration,
      volume: session.volume,
      completed: session.completed,
      ...(session.error ? { error: session.error } : {})
    }
  }

  /**
   * 推一份状态给渲染层，并**取走** completed。
   *
   * ★ 为什么在这里消费而不是等渲染层来取：渲染层收到「播完」就要推进队列，
   *   如果这个标志留着，下一轮轮询还会再带一次 —— 队列会被同一首歌推进两次。
   */
  private emit(): void {
    const snapshot = this.snapshot()
    if (this.session) this.session.completed = false
    this.listener?.(snapshot)
  }
}

export const dlnaController = new DlnaController()
