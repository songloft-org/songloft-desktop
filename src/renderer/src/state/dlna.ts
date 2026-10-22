/**
 * 「投送到局域网音箱」的界面侧状态。
 *
 * 三条边界，写在这里免得后来的人再猜：
 *
 * 1. **网络那一半在主进程**（`main/dlna.ts`）：SSDP 发现、SOAP 控制、设备状态轮询都在那边，
 *    渲染层是浏览器上下文，开不了 UDP socket。这里只经 `window.songloft.cast.*` 说话。
 * 2. **服务端不参与**。控制点在客户端，与上游 Flutter 版一致；音箱拉的是那条本来就有的
 *    播放地址（`buildSongUrl` 拼好、带 access_token），后端一行代码都不用改。
 * 3. **播放的出口换了，播放器本身没换**。投送时仍然用 `state/player-core` 的队列、游标、
 *    歌词、播放模式 —— 只是 `startSong` 最后一米交给这里（见 player-core 的 CastBridge）。
 *    于是「下一首 / 播完自动推进 / 底栏那些控件」一行都不用改。
 *
 * ★ 状态是主进程**推**过来的，这里不轮询：设备状态每 2 秒变一次，再问一遍只会多一层
 *   可能不一致的缓存。`usingState` 那个订阅在 App 挂载时接上（见 App.tsx）。
 */

import { create } from 'zustand'

import type { CastAction, DlnaDevice, DlnaStatus } from '@shared/dlna'
import { isLocalFileUrl } from '@shared/local-file'
import type { Song } from '@shared/types'
import { buildSongUrl } from '@/lib/url'
import {
  playerCore,
  restoreLocalOutput,
  setCastBridge,
  unloadLocalAudio,
  type CastBridge
} from './player-core'
import { useAuth } from './useAuth'

interface DlnaState {
  /** 设备选择对话框是否打开 */
  dialogOpen: boolean
  devices: DlnaDevice[]
  /** 正在发现（一轮 SSDP 大约 3 秒） */
  discovering: boolean
  /** 正在把当前歌推给设备 */
  busy: boolean
  /** 发现 / 投送失败的原因（对话框里显示） */
  error: string | null

  activeDevice: DlnaDevice | null
  status: DlnaStatus | null
  /** 是否正在投送（= activeDevice !== null，单独存一份是为了让组件少推导一层） */
  casting: boolean
  /**
   * 投送期间设备最后一次**非零**的音量。
   *
   * 用途只有一个：底栏那颗静音键。音箱是另一台设备，本机的 `muted` 对它无效，
   * 所以「静音 / 取消静音」得记住原来的音量才能还原 —— 设备自己不会告诉我们它原本多大。
   */
  lastVolume: number
  /**
   * 开始投送**之前**本机这一路输出的快照（音量 + 静音；null = 没记过 / 没在投送）。
   *
   * 投送期间这两项都会被改写：`volume` 的所指换成「设备音量」（见 applyStatus），
   * `muted` 则恒为 false（音箱没有 muted 概念，投送时「静音」是把音量设成 0）。
   * 取消投送要把本机那一路原样还回来 —— 否则用户会发现自己的音量偏好被音箱的音量顶掉、
   * 或者「滑条 60% 却一点声都没有」（投送前本来就是静音的）。
   */
  localBeforeCast: { volume: number; muted: boolean } | null
  /**
   * 是不是「我们把它静音了」。
   *
   * ★ 不能靠 `status.volume === 0` 判断：实测小爱音箱不接受 0，会把 SetVolume(0)
   *   收到 1（最小档）。只看回读值的话，点完静音图标不会变、滑条停在 1%，
   *   用户看到的就是「这个键没反应」。所以静音这件事由**我们这边**记着，
   *   回读值 > 1（说明用户或音箱自己把音量调上去了）时自动复位。
   */
  mutedOnDevice: boolean

  openDialog: () => void
  closeDialog: () => void
  loadDevices: (refresh?: boolean) => Promise<void>
  /**
   * 选中这台设备作为输出（**不改变播放状态，也不发任何 SOAP**）。
   * 真正投送发生在用户点播放时（startPlayback）。
   */
  /**
   * 选一台设备并把声音交过去。
   *
   * ★ 现在它会**接着本机当前的进度**把歌投给设备（本机在放就继续放、本机暂停就停在原位），
   *   所以是异步的：投送要等设备装载好、Seek 到位。
   */
  castTo: (device: DlnaDevice) => Promise<void>
  /** 音箱静音 / 取消静音（投送期间底栏那颗喇叭键走这里） */
  toggleDeviceMute: () => void
  disconnect: () => Promise<void>
  /** 应用启动 / 渲染层刷新后接回主进程里可能还在跑的投送会话 */
  sync: () => Promise<void>
}

/**
 * 把 IPC 抛回来的错误变成一句人话。
 *
 * ★ Electron 会把主进程的错误包成 `Error invoking remote method 'cast:start': Error: 真正原因`，
 *   不剥掉的话界面上会顶着这串前缀，用户读不出重点。
 */
function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message
    .replace(/^Error invoking remote method '[^']*':\s*/i, '')
    .replace(/^Error:\s*/i, '')
    .trim()
}

/**
 * 把设备状态同时写进本地播放器 store。
 *
 * ★ 为什么两边都写：底栏、满窗播放、迷你窗、托盘全读 `usePlayer`，而投送期间的
 *   「在不在放 / 播到哪儿了」只有设备知道。只写本 store 的话，那些界面会一致地停在
 *   「暂停、0:00」上。
 */
function applyStatus(status: DlnaStatus): void {
  const player = playerCore.getState()
  playerCore.setState({
    playing: status.playing,
    currentTime: status.position,
    // 设备没报时长（0）时保留本机那一份：曲库里本来就有 duration
    duration: status.duration > 0 ? status.duration : player.duration,
    // 进度是设备来的，别再把「缓冲中…」挂在底栏上
    buffering: false,
    status: null
  })

  // 记下设备上一次「有声」的音量：底栏那颗静音键靠它还原（见 DlnaState.lastVolume）
  if (status.volume > 0 && status.volume !== useDlna.getState().lastVolume) {
    useDlna.setState({ lastVolume: status.volume })
  }

  /*
   * ★ 投送期间「音量」这个概念的所指换成了**设备**音量。
   *
   *   理由：读 `usePlayer().volume` 的地方不止底栏一处 —— 满窗播放、迷你条、
   *   托盘菜单、媒体键、键盘音量键全都读它。只在底栏做分流的话，另外几处会继续
   *   对着本机那个数字加减，然后把它发给音箱（19% 的音箱被一键推到 75%）。
   *   把 player.volume 对齐成设备音量，这四处不必知道「现在是投送」。
   *
   *   `muted: false`：音箱没有 muted 概念，「静音」在投送时就是把音量设成 0。
   */
  if (status.volume >= 0) {
    playerCore.setState({ volume: status.volume / 100, muted: false })
  }
  // 音量被调大到 1 以上（用户转了音箱旋钮 / 用小爱 App 调过）：不再算「我们静音的那一档」
  if (status.volume > 1 && useDlna.getState().mutedOnDevice) {
    useDlna.setState({ mutedOnDevice: false })
  }
}

/**
 * 收尾：把声音与控件交回本机。取消投送、以及设备那边自己掉了（见 subscribeCastState）
 * 都走这里 —— 两条路要清的东西完全一样，各写一份必然只改一处。
 *
 * ★ 与早先版本最大的不同：**不再把播放停掉**。投送与不投送只是「声音从哪儿出」，
 *   用户按的是「切回本机」，不是「停止播放」。所以：
 *     · 位置 —— 用设备那边的进度（`handoff`），本机接着那一处往下走；
 *     · 状态 —— 设备在放就本机接着放，设备是暂停的就本机载入后停在原地；
 *     · 队列 / 游标 / 播放模式 —— 一个字都不动（见 player-core 的 resumeLocal）。
 *
 * ★ 顺序不能换，三条各自防的是一处残留：
 *   1. 先摘桥（`setCastBridge(null)`）—— 之后任何一次 `startSong` / `setVolume` 都走本机
 *      那一路；晚一步的话，下面第 2 步「还原音量」会被当成「把音量发给音箱」；
 *   2. 再还原本机输出（音量 + 静音）—— 投送期间 `volume` 的所指是设备音量、`muted` 恒为
 *      false，得换回开始投送前那一份快照；
 *   3. 最后才让 player-core 重新载入这一首（`resumeLocal`）—— 它会换掉 `audio.src`，
 *      所以不需要再单独 unload；反过来，先载入再摘桥的话，那次加载会被当成「投给音箱」。
 *
 * ★ buffering / status / error 一并清掉：它们可能正停在「正在投送到音箱…」或
 *   「投送失败：…」，留着就会一直转圈、或者把一句投送过程的话挂在本机的底栏上。
 */
function endCasting(handoff?: { position: number; playing: boolean }): void {
  const state = useDlna.getState()
  const snapshot = state.localBeforeCast
  /*
   * ★ 交接的是「放到哪儿了、在不在放」。优先用调用方刚问来的真值（disconnect 会先向主进程
   *   要一次）；拿不到就退回 store 里那份 —— 它来自 2 秒一轮的轮询，最多落后两秒。
   */
  const at = handoff ?? {
    position: state.status?.position ?? 0,
    playing: state.status?.playing ?? false
  }
  setCastBridge(null)
  useDlna.setState({
    activeDevice: null,
    status: null,
    casting: false,
    busy: false,
    // 这三项只对「正在投送」有意义，留着就是下一次投送的残留
    lastVolume: 0,
    mutedOnDevice: false,
    localBeforeCast: null
  })
  if (snapshot) restoreLocalOutput(snapshot)

  const position = Math.max(0, at.position)
  playerCore.setState({
    playing: false,
    currentTime: position,
    buffering: false,
    status: null,
    error: null
  })

  const song = playerCore.getState().currentSong()
  if (!song) {
    // 没有歌（例如刚清空队列就取消了投送）：把 audio 上挂着的那一首卸掉，别让它以后响错歌
    unloadLocalAudio()
    return
  }
  // 接着上一路：本机把这一首载到刚才那个位置，播放状态跟着设备那边走
  void playerCore.getState().resumeLocal(position, at.playing)
}

/**
 * 音量命令的合并句柄。
 *
 * 拖动滑条时 `castBridge.volume` 每帧都会响一次。每帧发一条 SOAP 过去，音箱那边会卡，
 * 而且它本来也跟不上 —— 合并成「停下来之后再发最后那个值」。
 * 本地 `player.volume` 照样实时变（拖动跟手靠它），所以这里只影响发往设备的那一路。
 */
let volumeTimer: number | null = null

/** 让 player-core 在起播时把歌交给设备（投送期间才挂上，取消投送就摘掉）。 */
const castBridge: CastBridge = {
  load: async (song) => {
    await useDlna.getState().pushSong(song)
    return
  },
  play: () => {
    // 可能是「刚选完设备、还没投过」，也可能是「暂停中继续」—— 由 startPlayback 分辨
    void useDlna.getState().startPlayback()
  },
  pause: () => {
    void useDlna.getState().send('pause')
  },
  seek: (seconds: number) => {
    void useDlna.getState().send('seek', Math.round(seconds))
  },
  volume: (volume: number) => {
    if (volumeTimer !== null) window.clearTimeout(volumeTimer)
    volumeTimer = window.setTimeout(() => {
      volumeTimer = null
      void useDlna.getState().send('volume', volume)
    }, 120)
  }
}

export const useDlna = create<
  DlnaState & {
    /**
     * 内部：把某一首推给设备并让它开始播（切歌、以及「选完设备后第一次点播放」都走它）。
     * 返回 null 表示没投出去 —— 原因已经写进 `error` 与底栏那一行了。
     *
     * `options.position` / `options.autoplay` 是「本机 → 投送」无缝切换用的：从本机那一刻的
     * 进度接着放，本机是暂停的就把设备也停在那个位置。
     */
    pushSong: (
      song: Song,
      target?: DlnaDevice,
      options?: { position?: number; autoplay?: boolean }
    ) => Promise<DlnaStatus | null>
    /** 内部：投送路径上的「播放」（见 startPlayback 的实现说明） */
    startPlayback: () => Promise<void>
    /** 内部：发一条控制命令 */
    send: (action: CastAction, value?: number) => Promise<void>
  }
>((set, get) => ({
  dialogOpen: false,
  devices: [],
  discovering: false,
  busy: false,
  error: null,
  activeDevice: null,
  status: null,
  casting: false,
  lastVolume: 0,
  localBeforeCast: null,
  mutedOnDevice: false,

  openDialog: () => {
    set({ dialogOpen: true, error: null })
    void get().loadDevices(false)
  },

  closeDialog: () => set({ dialogOpen: false }),

  loadDevices: async (refresh = false) => {
    set({ discovering: true, error: null })
    try {
      const devices = await window.songloft.cast.devices(refresh)
      set({ devices, discovering: false })
    } catch (error) {
      set({ discovering: false, error: describe(error) })
    }
  },

  castTo: async (device) => {
    const player = playerCore.getState()
    const song = player.currentSong()
    if (!song) {
      set({ error: '先选一首歌再投送' })
      return
    }
    /*
     * id 为负 = 双击打开的本地文件（见 shared/local-file）。它压根不在曲库里，
     * 后端没有它的流地址 —— 音箱读不到这台机器的磁盘，投不过去。
     * 曲库里扫描进来的本地文件 id 是正的，后端自己读得到，可以投。
     */
    if (song.id <= 0) {
      set({ error: '本机打开的文件没法投送，请改用曲库里的歌曲' })
      return
    }

    /*
     * ★ 「本机 → 投送」要**接上**正在放的那一处，不是从 0 重新开始：
     *   记下此刻的进度与「在不在放」，等把声音交给音箱时原样交过去。
     */
    const resumeAt = player.currentTime
    const wasPlaying = player.playing
    /*
     * 声音要改从音箱出：本机这一路先停。
     * ★ 必须在挂桥**之前**停 —— 挂上之后 `pause()` 就成了「暂停音箱」（见 player-core 的 pause）。
     */
    if (wasPlaying) player.pause()

    setCastBridge(castBridge)
    set({
      activeDevice: device,
      status: null,
      casting: true,
      busy: false,
      dialogOpen: false,
      error: null,
      /*
       * 记下本机这一路（音量 + 静音）：投送期间这两项都会被改写，取消时要原样还回来。
       * ★ 已经在投送中（UI 上走不到：投送时那颗钮是「取消投送」）就沿用上一份快照 ——
       *   此刻 `player.volume` 已经是**设备**音量，拿它当「本机原值」，取消时就会把
       *   音箱的音量写成用户自己的音量。
       */
      localBeforeCast: get().casting
        ? get().localBeforeCast
        : { volume: player.volume, muted: player.muted }
    })

    if (!wasPlaying) {
      /*
       * 本机是**暂停**的：这时候不把歌推给设备。
       *
       * 设备收到 SetAVTransportURI 就会自己开演（实测小爱 S12，客户端按不住 —— Pause 会被它
       * 一两秒后恢复），推过去等于「一启用投送就开唱」，而用户此刻按的是暂停。
       * 位置与本机那一份都留在原地：进度条仍停在 1:47，等用户点播放时再由 startPlayback
       * 带着这个位置投过去。切换前后状态因此完全一致。
       */
      playerCore.setState({
        duration: song.duration > 0 ? song.duration : 0,
        error: null,
        status: null,
        buffering: false
      })
      return
    }

    // 在放：把这一首以同一个位置交给设备，接着响
    await get().pushSong(song, device, { position: resumeAt, autoplay: true })
  },

  /**
   * 「播放」在投送路径上的入口（底栏播放键 → CastBridge.play）。
   *
   * 两种情形：还没真正投放（刚选完设备、或者选的时候本机是暂停的）→ 此刻才把歌交过去并播放；
   * 已经在放（暂停过）→ 只是继续。
   */
  startPlayback: async () => {
    const { activeDevice, status } = get()
    if (!activeDevice) return
    if (!status?.active) {
      const local = playerCore.getState()
      const song = local.currentSong()
      if (!song) return
      /*
       * 位置取**本机此刻的进度**：选设备那一步没有动过 currentTime（见 castTo），
       * 所以这里交过去的正是用户看到的那个位置 —— 从那一处接着放才叫无缝。
       */
      await get().pushSong(song, activeDevice, { position: local.currentTime, autoplay: true })
      return
    }
    await get().send('play')
  },

  toggleDeviceMute: () => {
    const { status, lastVolume, mutedOnDevice } = get()
    const current = status?.volume ?? -1
    if (current < 0) return
    if (mutedOnDevice || current <= 1) {
      set({ mutedOnDevice: false })
      void get().send('volume', Math.max(1, lastVolume || 20))
      return
    }
    set({ mutedOnDevice: true })
    void get().send('volume', 0)
  },

  disconnect: async () => {
    /*
     * ★ 先向主进程要一次现场：「放到哪儿了、在不在放」。
     *   交接给本机要的是**此刻**的真值 —— store 里那份来自 2 秒一轮的轮询，可能落后一两秒，
     *   用户是从进度条上看出来的。而且必须在 stop 之前问：stop 之后会话没了，读回来的是
     *   一份「没有在投送」。
     */
    const before = await window.songloft.cast.status().catch(() => null)
    const local = playerCore.getState()
    // 本地这一套（桥 / 音量 / 静音 / 播放栏）一次性退回去，见 endCasting 的说明
    endCasting(
      before?.active
        ? { position: before.position, playing: before.playing }
        : /*
           * 主进程那边**还没有会话**（刚选完设备就取消、投送还没真正起来）：位置以本机那一份
           * 为准 —— 选设备那一步没有动过它，进度条上显示的就是这个数。
           */
          { position: local.currentTime, playing: local.playing }
    )
    /*
     * ★ 本地已经显示「没在投送」也仍然发一次 stop：主进程里的会话与渲染层可能并不同步
     *   （渲染层刷新过一轮、sync 还没跑完用户就点了取消）。这条命令是幂等的 ——
     *   没有会话时主进程只会回一句「本来就没在投送」。
     */
    try {
      await window.songloft.cast.stop()
    } catch {
      // 设备可能已经断电：解除绑定这件事不能在界面上失败
    }
  },

  sync: async () => {
    if (get().casting) return
    try {
      const status = await window.songloft.cast.status()
      if (!status.active || !status.deviceId) return
      // 设备列表可能已经缓存过：优先拿完整对象，拿不到就只填界面上会用到的那两个字段
      const devices =
        get().devices.length > 0 ? get().devices : await window.songloft.cast.devices(false)
      const device =
        devices.find((item) => item.id === status.deviceId) ??
        ({
          id: status.deviceId,
          name: status.deviceName ?? '音箱',
          model: '',
          manufacturer: '',
          host: '',
          location: '',
          controlUrl: '',
          controlType: '',
          volumeUrl: null,
          volumeType: null
        } satisfies DlnaDevice)
      const local = playerCore.getState()
      set({
        devices,
        activeDevice: device,
        status,
        casting: true,
        // 渲染层刷新过一轮：此刻本机那一路就是持久化里那份，正是取消时要还原的
        localBeforeCast: { volume: local.volume, muted: local.muted }
      })
      setCastBridge(castBridge)
      applyStatus(status)
    } catch {
      // 主进程里没有会话（或者刚起来）：当作「没在投送」，不打扰用户
    }
  },

  pushSong: async (
    song,
    target?: DlnaDevice,
    options?: { position?: number; autoplay?: boolean }
  ) => {
    const device = target ?? get().activeDevice
    if (!device) return null
    const account = useAuth.getState()
    if (!account.baseUrl) {
      set({ error: '连接服务器之后才能投送' })
      return null
    }
    /*
     * id 为负 = 双击打开的本地文件（见 shared/local-file）。它压根不在曲库里，
     * 后端没有它的流地址 —— 音箱读不到这台机器的磁盘，投不过去。
     * 曲库里扫描进来的本地文件 id 是正的，后端自己读得到，可以投。
     */
    if (song.id <= 0) {
      const message = '本机打开的文件没法投送，请改用曲库里的歌曲'
      playerCore.setState({ buffering: false, status: null, error: message })
      set({ error: message })
      return null
    }

    const url = buildSongUrl(song, {
      baseUrl: account.baseUrl,
      accessToken: account.accessToken
    })
    if (!url || isLocalFileUrl(url)) {
      const message = '这首歌没有可投送的音源'
      playerCore.setState({ buffering: false, status: null, error: message })
      set({ error: message })
      return null
    }

    playerCore.setState({ buffering: true, status: '正在投送到音箱…', error: null })
    try {
      const status = await window.songloft.cast.start({
        deviceId: device.id,
        songId: song.id,
        title: song.title,
        url,
        format: song.format,
        // 从本机那一刻的进度接着放（缺省 0），并且沿用本机「在放 / 暂停」的状态
        position: Math.max(0, options?.position ?? 0),
        autoplay: options?.autoplay !== false
      })
      /*
       * ★ 这一趟在飞的时候用户可能**已经取消了投送**（或者改投了另一台设备）。此刻再把这些
       *   状态写进播放器，等于让刚复位好的底栏跳回投送那一套；而且主进程那边刚被 stop 掉，
       *   这一次 start 又把会话建了回来 —— 音箱会自己在那儿放。所以：先确认还在投送同一台
       *   设备，不是就顺手把刚建起来的会话收掉，一个字都不往界面上写。
       */
      if (!get().casting || get().activeDevice?.id !== device.id) {
        void window.songloft.cast.stop().catch(() => undefined)
        return null
      }
      set({ status })
      applyStatus(status)
      return status
    } catch (error) {
      /*
       * 与本地播放失败同一套口径：把话说在底栏那一行上，不弹 toast。
       * 「期间取消了投送」的那一种除外 —— 那时这句「投送失败」已经没有意义，
       * 写在刚复位好的底栏上只会让人以为本机放不出来。
       */
      if (!get().casting) return null
      const message = `投送失败：${describe(error)}`
      playerCore.setState({ buffering: false, status: null, playing: false, error: message })
      set({ error: message })
      return null
    }
  },

  send: async (action, value = 0) => {
    // 只选了设备还没真正投放（status 为空）时，设备上什么都还没有 —— 发命令只会得到报错
    if (!get().casting || !get().status?.active) return
    try {
      const status = await window.songloft.cast.control(action, value)
      /*
       * ★ 命令在飞的时候用户可能已经取消了投送（拖动音量 / 暂停都走这条路）。
       *   回声不能再写回来：那会把刚复位好的底栏重新拉回「在放 / 设备音量」。
       */
      if (!get().casting) return
      set({ status })
      applyStatus(status)
    } catch (error) {
      if (!get().casting) return
      playerCore.setState({ error: `控制音箱失败：${describe(error)}` })
    }
  }
}))

/**
 * 接上主进程推来的投送状态。**在 App 挂载时调用一次**，返回取消订阅。
 *
 * ★ 「播完了」（`completed`）是一次性事件：主进程推过一次就清，所以这里收到就该推进队列。
 *   推进走 `playerCore.next(true)` 而不是自己算下一首 —— 队列、随机序、单曲循环的语义
 *   全在 step() 里，复制一份必然漂移。next 会移到下一首并调 startSong，
 *   而 startSong 又经 castBridge 投下一首。
 */
export function subscribeCastState(): () => void {
  return window.songloft.cast.onState((status) => {
    const store = useDlna.getState()

    if (!status.active) {
      // 设备被别的 App 抢走 / 主进程那边会话没了：安静地解除绑定，不弹任何东西。
      // 清的东西与「用户自己点取消」完全一样，见 endCasting
      if (!store.casting) return
      endCasting()
      return
    }

    /*
     * ★ 已经取消（或者压根没在投送）：设备那边**迟到的状态**不能再往播放器里写。
     *   主进程的 stop 是异步的，取消之后还会再来一两帧 active 的状态 —— 写下去就是
     *   「没有声音，进度条却在走、音量显示的是音箱那个值」，刚复位好的底栏又被拉回投送。
     */
    if (!store.casting) return

    useDlna.setState({ status })
    applyStatus(status)
    if (status.completed) void playerCore.getState().next(true)
  })
}
