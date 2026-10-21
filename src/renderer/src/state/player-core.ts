/**
 * **播放核心**：一个模块级的 `HTMLAudioElement` + zustand 状态。
 *
 * ★ 音频、队列、游标、歌词、音轨、音量全在这里，而它**不知道自己跑在哪个窗口里** ——
 *   这正是它与 state/remotePlayer.ts 的分工：谁当**宿主**谁用它，另一侧用镜像，两边靠
 *   IPC 对齐。至于「谁是宿主」只有两种答案（见 @shared/window-role）：
 *     · 主窗口 —— 完整界面那个窗口；
 *     · 迷你窗 · 宿主 —— 本地文件会话（双击音频文件）里，迷你窗自己就是播放器，没有主窗口。
 *   一首歌只能有一个 `HTMLAudioElement` 在放（两个窗口各放一份就是同一首歌响两遍），
 *   所以**同一个进程里**永远只有一侧用它，见 state/usePlayer 那句模块级分流。
 *
 * ★ 于是这个模块里不许出现「主窗口才有的东西」：曲库、会话、页面路由、扩展 webview 一个
 *   都不碰（要用到的会话只经 resourceContext() 问一句「现在拿得到地址和 token 吗」，
 *   拿不到就按没有会话处理）。本地文件会话里它照样要能完整地放音频。
 *
 * 一个模块级的 `HTMLAudioElement` + zustand 状态，刻意不用 React 的 ref：
 * 切歌、切页面、抽屉开关都不该重建音频元素（重建 = 断流 + 丢失缓冲）。
 *
 * ★ 播放失败不是「立刻跳下一首」，而是**换一个音源**（重新向后端要一次地址）：坏的是那个
 *   音源，而找别的音源只有后端做得到（它才有插件、才有跨插件搜索）。客户端在这里只做两件
 *   事 —— 换一个带 `retry` 的地址（绕开浏览器缓存复用）、把话说在**播放条上**而不是弹 toast。
 *   底栏那一行如实汇报每一步（见 handlePlaybackFailure 与 loadingText）：
 *     起播                    → 「正在获取音源…」
 *     超时 / 报错             → 「播放失败，正在切换第 N 个音源…」（最多切 3 次）
 *     切满 3 个仍不出声       → 跳到下一首，重新走一遍
 *     连续 3 首都这样         → 红字「连续 3 首歌曲无法播放，终止播放」，不再自动往下跳
 *     播到一半没数据          → 「缓冲中…」
 *
 *   ★ 换源是**串行**的，同一时刻永远只有一次尝试在飞（见 SOURCE_SWITCH_BACKOFF_MS）：
 *     以前是「3s 一到就再要一次地址」，旧请求并不取消，四次尝试等于四个并行解析挤同一个
 *     插件 worker，越试越慢。现在改成「失败 → 等一段递增的时间（给后端后台换源留出落地的
 *     时间）→ 再要一次」，旧请求在换 src 的那一刻由浏览器中止；首次也给了足够长的预算
 *     （慢插件解析要 9 秒上下）。
 *
 * ★ **预热下一首**（见 state/song-prefetch）：起播成功后请后端把队列里的下一首提前解析 +
 *   下载 + 转码，下一次点播直接命中缓存。这与上面的重试是两件事：一个治「等太久」，一个
 *   治「等到了却是坏的」。
 * ★ 试满之前**不判死**（不写「无法播放」）：一次瞬时失败（直链过期 / 后端正在换源 / IO 抖动）
 *   很常见，切一两次往往就回来了；当场写「不可用」等于把一次抖动报成这首歌坏了。
 * ★ 元数据（封面 / 歌词 / 歌手 / 歌名）缺失的补齐**不在这个文件里**：它跟播放没有耦合
 *   （补齐到达时只换队列里那一个对象，不碰 audio），见 state/song-metadata.ts。
 *
 * 与 Flutter 端的对应关系：
 *   playMode           ↔ AppConstants.playModeLoop/Single/Random（那边的 playModeOrder —— 「顺序
 *                        播放，播完就停」—— 这里没有：本应用只有列表循环 / 单曲循环 / 随机三档，
 *                        老配置里存着 order 的话在 main/store.ts 那一层就被换成合法值了）
 *   order/cursor       ↔ 随机模式下的洗牌序列（原实现是 play_queue）
 *   reportedPlayed     ↔ POST /api/v1/songs/{id}/played
 *   mediaSession       ↔ audio_service / MPRIS（桌面端由 Chromium 直接接 MPRIS）
 */

import { create } from 'zustand'

import type { PlayMode, PlaybackContext, Song } from '@shared/types'
import { getLyric, getSong, reportPlayed } from '@/api/endpoints'
import { fetchCoverAccentFor } from '@/lib/accent'
import { parseLyrics, type ParsedLyric } from '@shared/lyric'
import { songCoverUrl } from '@shared/metadata'
import { buildCoverUrl, buildSongUrl, prefetchSongPath } from '@/lib/url'
import { displayArtist } from '@/lib/format'
import { orderForMode } from './play-order'
import { resourceContext, useAuth } from './useAuth'
import { useSettings } from './useSettings'
import { resetPrefetch, schedulePrefetch } from './song-prefetch'

const EMPTY_LYRIC: ParsedLyric = { lines: [], synced: false, meta: {}, offset: 0 }

export interface PlayerState {
  queue: Song[]
  /** 播放顺序：非随机模式下是 0..n-1，随机模式下是洗牌后的下标序列 */
  order: number[]
  /** order 内的游标；-1 表示还没开始播 */
  cursor: number
  playing: boolean
  buffering: boolean
  currentTime: number
  duration: number
  volume: number
  muted: boolean
  playMode: PlayMode
  /** 真的放不出来 / 已终止播放（底栏用红字） */
  error: string | null
  /**
   * 正在做的那件事（进度性的话，底栏用链接色）：「正在获取音源…」「播放失败，正在切换第 2 个
   * 音源…」「缓冲中…」。与 `error` 分开是因为这两件事的语气不同 —— 这一格不该把「还在努力」
   * 报成「这歌坏了」，见 hooks/useNowPlayingStatus。
   */
  status: string | null
  lyrics: ParsedLyric
  lyricsLoading: boolean
  lyricFailed: boolean
  /** 音轨列表（>1 时界面显示原伴唱切换） */
  tracks: { index: number; title: string | null; language: string | null }[]
  activeTrack: number
  context: PlaybackContext | null

  currentSong: () => Song | null
  playSongs: (songs: Song[], startIndex?: number, context?: PlaybackContext | null) => Promise<void>
  playSong: (song: Song, context?: PlaybackContext | null) => Promise<void>
  toggle: () => Promise<void>
  pause: () => void
  next: (auto?: boolean) => Promise<void>
  previous: () => Promise<void>
  seek: (seconds: number) => void
  seekBy: (delta: number) => void
  setVolume: (volume: number) => void
  /** 立刻把当前音量写盘（拖动结束/窗口关闭前用），并取消尚未执行的合并写 */
  flushVolume: () => void
  toggleMute: () => void
  cyclePlayMode: () => void
  setPlayMode: (mode: PlayMode) => void
  addToQueue: (songs: Song[], position?: 'end' | 'next') => void
  removeFromQueue: (indexes: number[]) => void
  moveInQueue: (from: number, to: number) => void
  clearQueue: () => void
  jumpTo: (index: number) => Promise<void>
  setActiveTrack: (track: number) => Promise<void>
  restoreLastQueue: () => Promise<void>
  /** 重新拉一次当前歌曲的歌词（歌词加载失败时界面上的「重试」） */
  reloadLyrics: () => Promise<void>
  /** 重取「正在播放」那一首的元数据（曲库扫描 / 刷新元数据之后由 useLibrary 调） */
  refreshCurrentSong: () => Promise<void>
}

const audio = new Audio()
audio.preload = 'auto'

/* ─────────────────────── 歌词缓存 ─────────────────────── */

const lyricCache = new Map<string, ParsedLyric>()

function lyricCacheKey(song: Song): string {
  return `${song.id}:${song.updated_at}`
}

async function loadLyrics(song: Song): Promise<{ parsed: ParsedLyric; failed: boolean }> {
  const key = lyricCacheKey(song)
  const cached = lyricCache.get(key)
  if (cached) return { parsed: cached, failed: false }

  /*
   * 有没有歌词来源：有 lyric_url，或者它是**曲库里的**本地文件（后端扫描入库的本地文件
   * 一样有歌词可给）。
   * ★ 双击打开的那种本地文件（id 为负，见 shared/local-file）不在曲库里，问后端只会白跑
   *   一趟失败的请求；直接跳过，界面也就不会先闪一下「加载中」再变成空。
   */
  const hasLyric = Boolean(song.lyric_url) || (song.type === 'local' && song.id > 0)
  if (!hasLyric) return { parsed: EMPTY_LYRIC, failed: false }

  // 免登录（只听本地文件）时也在这一条上：拿不到 client 就不问，而不是让 requireClient 抛
  const client = useAuth.getState().client
  if (!client) return { parsed: EMPTY_LYRIC, failed: false }

  try {
    const payload = await getLyric(client, song.id)
    const parsed = parseLyrics({
      lyric: payload.lyric ?? '',
      tlyric: payload.tlyric ?? '',
      rlyric: payload.rlyric ?? '',
      lxlyric: payload.lxlyric ?? ''
    })
    if (parsed.lines.length > 0) lyricCache.set(key, parsed)
    return { parsed, failed: false }
  } catch {
    return { parsed: EMPTY_LYRIC, failed: true }
  }
}

/* ─────────────────────── 最近播放（本地）─────────────────────── */

function rememberRecent(songId: number): void {
  const { settings, patch } = useSettings.getState()
  const next = [songId, ...settings.recentSongIds.filter((id) => id !== songId)].slice(0, 200)
  void patch({ recentSongIds: next })
}

/* ─────────────────────── 系统媒体控件 ─────────────────────── */

function updateMediaSession(song: Song, playing: boolean): void {
  if (!('mediaSession' in navigator)) return
  const ctx = resourceContext()
  // 封面走后端出图，缺了就退到原始音源封面（见 shared/metadata 的 songCoverUrl）
  const cover = buildCoverUrl(songCoverUrl(song), ctx, 512)
  navigator.mediaSession.metadata = new MediaMetadata({
    title: song.title,
    artist: displayArtist(song.artist),
    album: song.album ?? '',
    artwork: cover ? [{ src: cover, sizes: '512x512', type: 'image/jpeg' }] : []
  })
  navigator.mediaSession.playbackState = playing ? 'playing' : 'paused'
}

function updatePositionState(): void {
  if (
    !('mediaSession' in navigator) ||
    typeof navigator.mediaSession.setPositionState !== 'function'
  )
    return
  if (!Number.isFinite(audio.duration) || audio.duration <= 0) return
  try {
    navigator.mediaSession.setPositionState({
      duration: audio.duration,
      position: Math.min(audio.currentTime, audio.duration),
      playbackRate: audio.playbackRate
    })
  } catch {
    /* 某些状态下 Chromium 会拒绝，忽略即可 */
  }
}

/* ──────────────────── 音量落盘（合并写） ──────────────────── */

/**
 * 音量的变化形态是「持续连发」：拖音量条每个 pointermove 一次，按住 ↑/↓ 会随按键重复连发。
 * 而每次写盘要走 IPC + 主进程的 `writeFileSync` + `renameSync`（整份 JSON，同步 I/O），
 * 拖一次音量条就是几十次全量落盘，主进程会被拖住。这里把连续改动合并成
 * 「静默 400ms 后的一跳」；拖动结束时再显式 flush，保证最后一次值不会只留在内存里。
 */
const VOLUME_PERSIST_DEBOUNCE_MS = 400
let volumePersistTimer: ReturnType<typeof setTimeout> | null = null

function scheduleVolumePersist(volume: number, immediate = false): void {
  if (volumePersistTimer) {
    clearTimeout(volumePersistTimer)
    volumePersistTimer = null
  }
  if (immediate) {
    void useSettings.getState().patch({ volume })
    return
  }
  volumePersistTimer = setTimeout(() => {
    volumePersistTimer = null
    void useSettings.getState().patch({ volume })
  }, VOLUME_PERSIST_DEBOUNCE_MS)
}

/* ─────────────────────── store ─────────────────────── */

/*
 * 换源的记账（模块级，不进 store）：
 *
 *   · `currentAttempt` —— 这一次收听正在试**第几个音源**（0 = 首次要来的那个）。error 事件与
 *     超时定时器都只注册一次，它们要读的正是「此刻在第几个音源上」；
 *   · `expectedSrc` —— 此刻期望在放哪一个地址。换源时旧地址的 error 可能迟到（浏览器对
 *     「换了 src 之后旧资源报错」没有约定），拿它做闸门，免得把旧地址的失败算到新地址头上
 *     ——那会表现为「刚换到新地址就立刻又切一次」（连切两次、白白切掉一个音源）；
 *   · `requestedTrack` —— 用户点「伴奏」选中的那条音轨。换源要**停在这条轨上**，不能
 *     悄悄退回原唱；undefined = 交给后端决定默认轨（换一首歌就归位）。
 *   · `accountedSong` —— 这一次收听（首次 + 它的所有换源）已经记过账了没有。换源会重跑一遍
 *     startSong 的成功路径，不拦一下的话一次收听会往服务端报好几次播放。
 *   · `consecutiveFailures` —— 连续几首「切满仍不出声」。这已经不是某一首歌的问题了
 *     （后端不可达 / 音源全挂），再往下跳只是把队列刷完、把错误刷掉。
 *   · `sourceTimer` —— 「起播后多久还没出声」的那一下。换歌 / 清队列要把它撤掉，否则会往
 *     新歌头上补一刀。
 *   · `pendingSwitch` —— 已经安排了、但还没到点的换源（退避期间）。它同时充当**串行闸**：
 *     同一首歌的一轮里只允许有一个「待发生」的换源，迟到的错误不再叠加第二次。
 */
let currentAttempt = 0
let expectedSrc = ''
let requestedTrack: number | undefined
let accountedSong = -1
let consecutiveFailures = 0
let sourceTimer: number | null = null
let pendingSwitch: { songId: number; attempt: number; timer: number } | null = null

/**
 * 起播后多久还没出声，就认定这个音源不行。
 *
 * ★ 首次给 12 秒：慢插件解析本来就要 9 秒上下（后端注释里写着「B站 music/url 解析要 ~9s」），
 *   早先那个 3 秒等于给慢源判了死刑 —— 每次都被我们自己的表掐断，然后重发一次同样慢的请求，
 *   四次尝试全部撞死在同一个地方。HTMLAudioElement 不像 libmpv / 小爱音箱那样有「几秒无数据
 *   就断连」的硬上限，给足时间是**没有代价**的。
 * ★ 换源之后（attempt ≥ 1）给 8 秒：解析路径没变，重来一次通常一样慢，但也不能再回到 3 秒。
 */
const FIRST_ATTEMPT_TIMEOUT_MS = 12_000
const RETRY_ATTEMPT_TIMEOUT_MS = 8_000

/** 本地文件读不出来：只再试一次，而且很快就该有结论（IO 抖动而已） */
const LOCAL_ATTEMPT_TIMEOUT_MS = 5_000

/**
 * 第 N 次换源前的等待（N = 1, 2, 3），**递增**。
 *
 * ★ 为什么必须等：后端解析失败时只是**同步**回一个 502，真正的换源是**后台**做的
 *   （`serveRemote` 里的 AsyncReassign：跨插件找候选、候选之间还有 3s 间隔、成功后才回写
 *   数据库）。刚报错就重发，命中的几乎必然是同一个还没被换掉的坏源 —— 以前那四次「切换
 *   音源」大多是这样白白烧掉的。递增的等待正是留给它落地的时间。
 * ★ 为什么不能更久：再长用户就是在盯一个不动的播放条。三条加起来最坏也就十来秒。
 */
const SOURCE_SWITCH_BACKOFF_MS = [2_000, 4_000, 6_000]

/** 本地文件没有「换源」这回事，重试只是确认不是瞬时抖动，等半秒就够 */
const LOCAL_SWITCH_BACKOFF_MS = 500

/**
 * 一次收听最多**切换**几次音源（首次要来的那个不算）。切满还不出声就跳到下一首。
 *
 * ★ 次数没变（还是 3 次），变的是每次之间的节奏：见上面的超时与退避。最坏总时长 ≈
 *   12 + 2+8 + 4+8 + 6+8 = 48s，只有「后端一直挂着不回应」才会走到；真到那一步前面的
 *   连续失败计数也会先把它拦下来。
 */
const MAX_SOURCE_SWITCHES = 3

/** 本地文件没有别的音源可换：读不出来只再试一次（确认不是瞬时 IO 抖动） */
const MAX_LOCAL_PLAY_ATTEMPTS = 2

/**
 * 连续几首都切满仍不出声，就**终止播放**（不再一首首往下跳）。
 *
 * ★ 判据是「连续」：中间只要有一首真的出声了，计数就归零（见 startSong 的记账那一段）。
 * ★ 3 首：最常见的那条路（后端直接 4xx/502 快速失败）每首只花十来秒，三首就是半分钟以上
 *   没有任何声音 —— 足够了；真遇上后端一直挂着不回应，本来就该由用户在底栏那句话上叫停。
 */
const MAX_CONSECUTIVE_FAILURES = 3

/** 这一次收听最多试几个音源（首次 + 切换） */
function maxAttemptsFor(song: Song): number {
  return song.type === 'local' ? MAX_LOCAL_PLAY_ATTEMPTS : MAX_SOURCE_SWITCHES + 1
}

/**
 * 底栏此刻该说的那句话（进度性的、不判死的那句）。
 *
 * ★ `attempt` 是「正在试第几个音源」（0 = 首次要来的那个）：首次说「正在获取」；之后每一次
 *   都是上一次失败了换来的，所以直说「播放失败，正在切换第 N 个音源」。
 * ★ 本地文件没有「音源」可切换，别给它安一个不存在的动作。
 */
function loadingText(song: Song, attempt: number): string {
  if (song.type === 'local') {
    return attempt === 0 ? '正在读取音频文件…' : '播放失败，正在重试…'
  }
  return attempt === 0 ? '正在获取音源…' : `播放失败，正在切换第 ${attempt + 1} 个音源…`
}

function clearSourceTimer(): void {
  if (sourceTimer !== null) {
    window.clearTimeout(sourceTimer)
    sourceTimer = null
  }
}

/** 这一次尝试最多等多久（本地文件与网络源、首次与换源的预算都不同，见上面三条常量） */
function sourceTimeoutFor(song: Song, attempt: number): number {
  if (song.type === 'local') return LOCAL_ATTEMPT_TIMEOUT_MS
  return attempt === 0 ? FIRST_ATTEMPT_TIMEOUT_MS : RETRY_ATTEMPT_TIMEOUT_MS
}

/** 第 `nextAttempt` 次尝试之前要等多久（见 SOURCE_SWITCH_BACKOFF_MS） */
function sourceSwitchBackoffFor(song: Song, nextAttempt: number): number {
  if (song.type === 'local') return LOCAL_SWITCH_BACKOFF_MS
  const index = Math.min(nextAttempt - 1, SOURCE_SWITCH_BACKOFF_MS.length - 1)
  return SOURCE_SWITCH_BACKOFF_MS[Math.max(0, index)]
}

function cancelPendingSwitch(): void {
  if (pendingSwitch === null) return
  window.clearTimeout(pendingSwitch.timer)
  pendingSwitch = null
}

/** `MediaError.code` → 一句能放在播放条上短话（底栏那一行放不下完整原因） */
function describeMediaError(code: number | undefined): string {
  switch (code) {
    case 2:
      return '网络中断'
    case 3:
      return '音频无法解码'
    case 4:
      return '源不可用或无法解码'
    default:
      return '资源加载失败'
  }
}

export const playerCore = create<PlayerState>((set, get) => {
  /**
   * 给「这一次尝试」上表：预算内还没出声就算这个音源不行（判据是 `playing`，不是 `canplay`
   * ——有数据不等于真的响起来了）。
   *
   * ★ 预算按「第几次尝试」与「是不是本地文件」区分，见 sourceTimeoutFor。首次给得最宽：
   *   慢插件解析本来就要 9 秒上下，早先的 3 秒只会把它判死。
   * ★ 出声（playing 事件）与失败（error 事件 / play() 被拒）都会把它撤掉，这里只是兜底，
   *   以及覆盖「请求一直挂着、什么都不发生」的那一种。
   */
  function armSourceTimer(song: Song, attempt: number): void {
    clearSourceTimer()
    sourceTimer = window.setTimeout(
      () => {
        sourceTimer = null
        // 等待期间换了歌 / 清了队列：这一刀不该补到别人头上
        if (get().currentSong()?.id !== song.id) return
        if (get().playing) return
        handlePlaybackFailure(song, '音源响应超时')
      },
      sourceTimeoutFor(song, attempt)
    )
  }

  /**
   * 真正把某首歌灌进 audio 元素。
   *
   * `attempt` 是「这首歌正在试第几个音源」（0 = 首次）。报错或超时由 handlePlaybackFailure
   * 安排下一次尝试（退避后），切满仍不出声才跳到下一首。
   */
  async function startSong(song: Song, ctx: PlaybackContext | null, attempt = 0): Promise<void> {
    const settings = useSettings.getState().settings
    clearSourceTimer()
    // 真的开始新一次加载了：上一轮安排过的换源（如果有）作废
    cancelPendingSwitch()
    // 首次尝试 = 一次新的收听：上一首选的音轨、上一次的记账都在这时归位
    if (attempt === 0) {
      requestedTrack = undefined
      accountedSong = -1
    }
    const url = buildSongUrl(song, resourceContext(), {
      quality: settings.quality,
      normalize: settings.volumeNormalize,
      track: requestedTrack,
      // 换源时换一个地址：绕开浏览器对同一 URL 的缓存复用，确保真的重新去后端解析一次
      retry: attempt
    })
    if (!url) {
      set({ error: '这首歌没有可播放的地址', status: null, buffering: false, playing: false })
      return
    }

    currentAttempt = attempt

    set({
      error: null,
      /*
       * ★ 一按下去就说清在做什么，不等超时到点：用户该知道「正在获取音源」而不是对着
       *   一个不动的播放条猜。换源之后这一句变成「播放失败，正在切换第 N 个音源」。
       */
      status: loadingText(song, attempt),
      buffering: true,
      context: ctx,
      /*
       * 歌词与音轨只在首次尝试时清空：换源时把它们清掉，界面会先白一下再重新填回来
       * （歌词有缓存、音轨要再探一次），而这两样与「用哪个音源拉同一份音频」无关。
       */
      ...(attempt === 0
        ? { lyrics: EMPTY_LYRIC, lyricsLoading: true, tracks: [], activeTrack: -1 }
        : {})
    })
    audio.src = url
    // 读回来的是 DOM 解析过的绝对地址 —— 与 error 事件里的 audio.src 才是同一口径
    expectedSrc = audio.src
    audio.volume = settings.volume

    // 预算内还没出声就算这个音源不行（见 sourceTimeoutFor）
    armSourceTimer(song, attempt)

    try {
      await audio.play()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      /*
       * NotAllowedError 只会在「没有用户手势」时出现，属于程序问题而非资源问题 ——
       * 这一条**不换源**（换个地址照样会被拦），也不该把它算进尝试次数里。
       */
      if (message.includes('NotAllowed')) {
        clearSourceTimer()
        set({
          buffering: false,
          playing: false,
          status: null,
          error: '浏览器阻止了自动播放，请点一下播放按钮'
        })
        return
      }
      /*
       * AbortError = 这次 play() 被**更新的加载**打断了（用户切歌 / 重试换了地址 / 用户按了暂停），
       * 属于正常的加载取消，不是「这个源不行」。算成失败会让新歌一开播就顶着上一首的
       * 「无法播放」，还白扣一次尝试次数。
       * 此时状态归新的那一次加载所有（它自己会设 buffering）—— 只有在「用户按了暂停」
       * 这一种情况下才需要我们把加载态收掉，否则会一直转圈。
       */
      if (message.includes('Abort') || message.includes('interrupted')) {
        // 用户自己按的暂停：加载态与那句提示都该跟着收掉（新的加载会自己重新上表）
        if (audio.paused) {
          clearSourceTimer()
          set({ buffering: false, status: null })
        }
        return
      }
      // 其余 play() 失败与 error 事件同路：都可能是「这个源不行」，交给同一套判定
      handlePlaybackFailure(song, '资源加载失败')
      return
    }

    /*
     * 播放成功后才记账 —— 且一次收听只记一次：首次失败、重试才出声时，成功的是第二次调用，
     * 账要记在这一次上；反过来，能出声之后又重试（不该发生，但真发生了也别重复报）。
     *
     * ★ 「记账」这一整块只对**曲库里的歌**成立，两个条件缺一不可：
     *   · 有会话（没登录时后端不认识我们，也没必要为此拦下播放）；
     *   · id 为正（本地文件的 id 是负的，见 shared/local-file —— 拿负数去问后端只会 404）。
     *   「最近播放」同理不算本地文件：那个列表是靠 id 反查曲库的，放进去只会得到一行
     *   「已从曲库删除」。
     */
    const client = useAuth.getState().client
    if (accountedSong !== song.id) {
      accountedSong = song.id
      // 真出声了就说明这一轮不是「整条路都断了」，连续失败的计数重新开始
      consecutiveFailures = 0
      /*
       * 换源的次数也归零：这一次收听已经有了能用的音源，之后再出问题（比如播到一半断了）
       * 应当从「第 1 个音源」重新开始数，而不是接着上次切到第 3 个继续。
       */
      currentAttempt = 0
      if (client && song.id > 0) {
        void reportPlayed(client, song.id, { type: 'play', context: ctx }).catch(() => undefined)
        rememberRecent(song.id)
      }
      // 这一首已经出声了，才轮到「让下一首别再等」—— 失败/换源途中不预热，免得雪上加霜
      prefetchUpcoming()
    }

    // 封面主色 → 整页强调色（本地文件没有封面可取，只有从曲库那边凑得出地址时才去取）
    if (settings.accentFromCover) {
      const coverAbsolute = buildCoverUrl(songCoverUrl(song), resourceContext(), 96)
      if (coverAbsolute) {
        void fetchCoverAccentFor(coverAbsolute).then((hex) => {
          if (hex && get().currentSong()?.id === song.id) useSettings.getState().setCoverAccent(hex)
        })
      }
    }

    void loadLyrics(song).then(({ parsed, failed }) => {
      if (get().currentSong()?.id !== song.id) return
      set({ lyrics: parsed, lyricsLoading: false, lyricFailed: failed })
    })

    // 原伴唱多音轨探测（失败静默：绝大多数歌都是单轨；本地文件与未登录时不探）
    if (client && song.id > 0) {
      void client
        .request<{ tracks: { index: number; title: string | null; language: string | null }[] }>(
          `/songs/${song.id}/audio-tracks`
        )
        .then((res) => {
          if (get().currentSong()?.id !== song.id) return
          const tracks = res.tracks ?? []
          /*
           * 「此刻在放哪一条轨」：用户点过切轨就以他选的为准（重试路径上尤其重要 ——
           * 否则界面会跳回原唱，而声音还在伴奏上）。没点过才取第一条可用轨。
           */
          const preferred =
            requestedTrack != null && tracks.some((t) => t.index === requestedTrack)
              ? requestedTrack
              : tracks.length > 1
                ? tracks[0].index
                : -1
          set({
            tracks: tracks.map((t) => ({ index: t.index, title: t.title, language: t.language })),
            activeTrack: preferred
          })
        })
        .catch(() => set({ tracks: [], activeTrack: -1 }))
    }
  }

  /**
   * 起播成功后，把**队列里的下一首**交给后端预热（`?prefetch=1`）。
   *
   * ★ 只预热一首、而且要按顺序来：随机播放的「下一首」由 order 决定，不能拿 queue 的下标猜。
   * ★ 单曲循环不预热：下一首就是正在放的这一首，已经在缓存/播放中了。
   * ★ 本地文件不预热（`prefetchSongPath` 会返回 null）：它们不经过网络，预热没有意义。
   */
  function prefetchUpcoming(): void {
    const client = useAuth.getState().client
    if (!client) return
    const { queue, order, cursor, playMode } = get()
    if (playMode === 'single' || cursor < 0 || order.length <= 1) return
    const nextCursor = cursor + 1 >= order.length ? 0 : cursor + 1
    const next = queue[order[nextCursor]]
    if (!next) return
    const { settings } = useSettings.getState()
    schedulePrefetch(
      client,
      prefetchSongPath(next, {
        quality: settings.quality,
        normalize: settings.volumeNormalize
      })
    )
  }

  /**
   * 播放失败时的统一处置：**换下一个音源**；切满仍不出声就跳到下一首。
   *
   * ★ 提示一律落在**播放控制栏的歌手位置**（PlayerBar 读 `status` / `error`），**不发 toast**：
   *   音源成片失效时 toast 会一屏一屏地堆（一首歌就好几条），把用户真正要看的那句话挤没。
   * ★ 换源是**重新向后端要一次地址**而不是「同一个地址再拉一遍」：找别的音源只有后端做得到
   *   （它才有插件、才有跨插件搜索），`retry` 参数保证这次请求不被浏览器缓存吃掉。
   * ★ 切满之前**不判死**：底栏说的是「正在切换第 N 个音源」，不是「无法播放」。一次瞬时失败
   *   （直链过期 / 后端正在换源 / IO 抖动）很常见，切一两次往往就回来了。
   * ★ 换源**不在这一下立刻发生**（见 SOURCE_SWITCH_BACKOFF_MS）：等一段递增的时间再要新
   *   地址 —— 一来给后端后台换源留出落地的时间（它才是真正会换源的那一方），二来保证同一
   *   时刻只有一次尝试在飞（以前是每 3s 再叠一层，四次尝试等于四个并行解析）。
   *   `pendingSwitch` 同时是「已经安排过了」的闸，迟到的错误不会再叠一次。
   */
  function handlePlaybackFailure(song: Song, detail: string): void {
    /*
     * ★ 只认「此刻正在放的那一首」：切歌 / 换源之后，上一次加载的失败会迟到 —— `play()` 的
     *   promise 被新一次加载打断时尤其常见。放它进来就会在**新歌刚起播的瞬间**把「无法播放」
     *   写到播放条上（新歌其实一点问题都没有），还白扣一次尝试次数。
     */
    if (get().currentSong()?.id !== song.id) return
    // 同一轮里已经安排过换源：error 事件与 play() 拒绝常常成对到达，只认第一下
    if (pendingSwitch?.songId === song.id) return
    clearSourceTimer()

    const nextAttempt = currentAttempt + 1

    if (nextAttempt < maxAttemptsFor(song)) {
      /*
       * 状态先摆出来：退避期间底栏要如实显示「正在换源」，而不是停在那儿一动不动。
       * 文案与 startSong 里那一句一致（loadingText 是唯一口径）。
       */
      set({ status: loadingText(song, nextAttempt), buffering: true, error: null })
      pendingSwitch = {
        songId: song.id,
        attempt: nextAttempt,
        timer: window.setTimeout(
          () => {
            pendingSwitch = null
            // 退避期间用户可能已经切歌 / 暂停：那就不该再替他把这首放起来
            if (get().currentSong()?.id !== song.id) return
            // 退避期间它自己出声了（超时那一路尤其可能）：那就别再打断它
            if (get().playing) return
            void startSong(song, get().context, nextAttempt)
          },
          sourceSwitchBackoffFor(song, nextAttempt)
        )
      }
      /*
       * ★ 不在这里主动掐断 audio（`removeAttribute('src') + load()`）：那会在退避期间再触发一次
       *   pause / durationchange，把刚摆上去的「正在切换音源」和进度一起刷掉，而且可能误伤
       *   「慢一拍才出声」的那一次加载。旧请求会在下一次 startSong 换 src 时由浏览器中止 ——
       *   那时它本来也已经没用了。
       */
      return
    }

    consecutiveFailures += 1
    set({ buffering: false, playing: false, status: null, error: `无法播放：${detail}` })

    /*
     * 连续几首都切满仍不出声 —— 这不是「某首歌的源坏了」，而是整条路都断了（后端不可达 /
     * 音源配置全失效）。继续自动往下跳只会一首首地试、把用户晾在跳动的界面上。停下来，
     * 把结论留在底栏上（红字），由用户决定什么时候再试。
     */
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      set({ error: `连续 ${MAX_CONSECUTIVE_FAILURES} 首歌曲无法播放，终止播放` })
      return
    }

    // 队列里只有这一首：没有「下一首」可跳，就把上面那句留在底栏
    if (get().order.length <= 1) return
    // force：单曲循环下也要真的换一首，否则坏源会在原地无限重放（见 step 的说明）
    void step(1, true, true)
  }

  /**
   * 按 order 前进/后退，返回是否成功移动游标。
   *
   * `force` 只给「这首歌放不出来」那条路用：单曲循环下（single + auto）它必须**真的换一首**，
   * 而 step 平时在那种模式下的语义是「把当前这首从头再放一遍」—— 对一首放不出来的歌，
   * 那等于原地打转。
   */
  async function step(direction: 1 | -1, auto: boolean, force = false): Promise<void> {
    const { order, cursor, queue, playMode } = get()
    if (order.length === 0) return

    // 用户自己点的上一首/下一首：这一下不算「自动跳」，连续失败的计数重新开始
    if (!auto) consecutiveFailures = 0

    if (playMode === 'single' && auto && !force) {
      audio.currentTime = 0
      await audio.play().catch(() => undefined)
      return
    }

    let nextCursor = cursor + direction
    /* 放完队尾接回队首：三档模式都接着放（曾经还有一档「顺序播放」是播完就停，那一档已去掉） */
    if (nextCursor >= order.length) nextCursor = 0
    if (nextCursor < 0) nextCursor = order.length - 1

    set({ cursor: nextCursor })
    const song = queue[order[nextCursor]]
    if (song) await startSong(song, get().context)
  }

  /* ── audio 事件接线（只接一次）── */
  audio.addEventListener('timeupdate', () => {
    set({ currentTime: audio.currentTime })
    updatePositionState()
  })
  audio.addEventListener('durationchange', () => {
    set({ duration: Number.isFinite(audio.duration) ? audio.duration : 0 })
  })
  /*
   * 真出声了：撤掉起播超时的表，并把「正在获取音源 / 切换音源」那几句一次收掉。`error` 在
   * 这里兜的是迟到的那一笔 —— 错误事件比成功晚到一帧时，一首正在正常播放的歌会一直挂着红字。
   * ★ 还要撤掉**已安排但还没到点**的换源：退避期间它自己出声了（慢一拍的那一次加载），
   *   再按计划换一次就等于把刚响起来的歌打断。
   */
  audio.addEventListener('playing', () => {
    clearSourceTimer()
    cancelPendingSwitch()
    set({ playing: true, buffering: false, error: null, status: null })
  })
  audio.addEventListener('pause', () => {
    /*
     * 一并收掉加载态与那句提示：暂停之后没有「正在等数据」这回事。留着的话，界面会一边显示
     * 暂停、一边还在转圈并说「正在获取音源…」（state/useNowPlayingStatus 就是按它们判的）。
     * 重新播放时 play() / waiting 会把它再置起来。
     * ★ 例外：正在等换源（pendingSwitch）时，这个 pause 往往是**加载失败自己停下来的**副产物，
     *   不是用户按的。那一句「正在切换第 N 个音源…」要留着，加载态也要留着。
     *   「用户真的按了暂停」走的是 pause()/toggle() 两个动作，它们在那里显式取消换源。
     */
    clearSourceTimer()
    set(pendingSwitch ? { playing: false } : { playing: false, buffering: false, status: null })
    // 通过暂停操作（而非自动播放）也要同步到托盘与系统媒体控件
    const song = get().currentSong()
    if (song) {
      updateMediaSession(song, false)
      void window.songloft.tray.update({
        title: song.title,
        artist: song.artist,
        playing: false,
        favorite: false
      })
    }
  })
  /*
   * 「等数据」有两种，说法也不一样：
   *   · 还没开声（currentTime === 0）—— 那是在找音源 / 打开文件，那句提示由 startSong 摆着，
   *     这里不要覆盖它；
   *   · 播到一半没数据了 —— 这才是缓冲，单独说一句（用户能分辨「换源」和「网络慢」）。
   */
  audio.addEventListener('waiting', () => {
    set(audio.currentTime > 0 ? { buffering: true, status: '缓冲中…' } : { buffering: true })
  })
  audio.addEventListener('canplay', () => set({ buffering: false }))
  audio.addEventListener('ended', () => {
    void step(1, true)
  })
  audio.addEventListener('error', () => {
    // 重试时旧地址的失败会迟到：只认「此刻期望在放的那一个」（见 expectedSrc 的说明）
    if (expectedSrc && audio.src !== expectedSrc) return

    /*
     * code 1 = MEDIA_ERR_ABORTED：加载是被**我们自己**中止的（换 src / 切歌 / 暂停），
     * 不是源坏了。重试换地址时它几乎必然出现一次，算成失败就会把重试链一次烧掉。
     */
    if (audio.error?.code === 1) return

    const song = get().currentSong()
    if (!song) return
    handlePlaybackFailure(song, describeMediaError(audio.error?.code))
  })

  return {
    queue: [],
    order: [],
    cursor: -1,
    playing: false,
    buffering: false,
    currentTime: 0,
    duration: 0,
    volume: useSettings.getState().settings.volume,
    muted: false,
    playMode: useSettings.getState().settings.playMode,
    error: null,
    status: null,
    lyrics: EMPTY_LYRIC,
    lyricsLoading: false,
    lyricFailed: false,
    tracks: [],
    activeTrack: -1,
    context: null,

    currentSong: () => {
      const { queue, order, cursor } = get()
      if (cursor < 0 || cursor >= order.length) return null
      return queue[order[cursor]] ?? null
    },

    playSongs: async (songs, startIndex = 0, context = null) => {
      if (songs.length === 0) return
      // 用户挑的歌单/歌曲：这是一轮新的播放，接着上一轮「全放不出来」的账不该算到它头上
      consecutiveFailures = 0
      const mode = get().playMode
      const order = orderForMode(mode, songs.length, startIndex)
      const cursor = order.indexOf(startIndex)
      set({ queue: songs, order, cursor: cursor >= 0 ? cursor : 0, context })
      await startSong(songs[startIndex], context)
    },

    playSong: async (song, context = null) => {
      await get().playSongs([song], 0, context)
    },

    toggle: async () => {
      if (get().cursor < 0) {
        // 队列空：让调用方决定放什么，这里只提示
        return
      }
      /*
       * 正在等换源：这一下「播放」交给那次换源，不要另起一次加载 —— 此刻 audio 上还挂着
       * 上一次失败的加载，play() 只会再报一次错，把「正在切换」的提示换成红字。
       */
      if (pendingSwitch) return
      if (!audio.paused) {
        cancelPendingSwitch()
        audio.pause()
        return
      }
      /*
       * 上一轮已经放不出来（底栏还挂着那句结论）时，这一下「播放」应当被理解成**再试一次这首歌**
       * —— 重新向后端要地址（重新解析 / 重新找源），而不是拿同一个旧地址再拉一遍。
       * 计数归零，于是它又享有完整的一轮换源；用户手点一下也算「不是自动跳」。
       */
      const song = get().currentSong()
      if (get().error && song) {
        consecutiveFailures = 0
        await startSong(song, get().context, 0)
        return
      }
      await audio.play().catch((error: unknown) => {
        set({ error: error instanceof Error ? error.message : '播放失败' })
      })
    },

    // 用户按下暂停 = 此刻不要自动放歌：退避中的那次换源一并作废（见 pause 事件的说明）
    pause: () => {
      cancelPendingSwitch()
      audio.pause()
    },

    next: async (auto = false) => step(1, auto),

    previous: async () => {
      // 播过 5 秒以上先回到开头，这是播放器的通用约定
      if (audio.currentTime > 5) {
        audio.currentTime = 0
        return
      }
      await step(-1, false)
    },

    seek: (seconds) => {
      if (!Number.isFinite(audio.duration) || audio.duration <= 0) return
      audio.currentTime = Math.max(0, Math.min(seconds, audio.duration))
      set({ currentTime: audio.currentTime })
      updatePositionState()
    },

    seekBy: (delta) => get().seek(audio.currentTime + delta),

    reloadLyrics: async () => {
      const song = get().currentSong()
      if (!song) return
      // 「重试」的语义是「现在再去后端问一次」，所以要先丢掉这一首的缓存键 ——
      // 否则后端刚补齐歌词也拿不到（失败态下缓存里虽然没有，但重试前成功过一次的情况需要它）
      lyricCache.delete(lyricCacheKey(song))
      set({ lyricsLoading: true, lyricFailed: false })
      const { parsed, failed } = await loadLyrics(song)
      // 期间用户可能已经切歌，回来的结果不能再往界面上贴
      if (get().currentSong()?.id !== song.id) return
      set({ lyrics: parsed, lyricsLoading: false, lyricFailed: failed })
    },

    refreshCurrentSong: async () => {
      const song = get().currentSong()
      // 本地文件（id 为负）不在曲库里，没有「再取一次」这回事
      if (!song || song.id <= 0) return
      const client = useAuth.getState().client
      if (!client) return
      try {
        const fresh = await getSong(client, song.id)
        /*
         * 只换队列里那一个对象，别的一律不动：
         *   · 不碰 audio —— 变的是元数据（标题/封面/时长），正在播的那一轨不该被打断；
         *   · 不动 order / cursor —— 队列顺序与位置是用户的东西，跟元数据没关系。
         * 拉不到就维持原样（多半是这首歌刚被删掉）：播放器自己会走「播不了」那条路，
         * 这里不替它做决定。
         */
        set((state) => ({
          queue: state.queue.map((item) => (item.id === fresh.id ? fresh : item))
        }))
      } catch {
        // 静默：这是后台同步，失败不值得打断用户
      }
    },

    setVolume: (volume) => {
      const clamped = Math.max(0, Math.min(1, volume))
      audio.volume = clamped
      audio.muted = false
      set({ volume: clamped, muted: false })
      scheduleVolumePersist(clamped)
    },

    flushVolume: () => scheduleVolumePersist(get().volume, true),

    toggleMute: () => {
      const muted = !get().muted
      audio.muted = muted
      set({ muted })
    },

    cyclePlayMode: () => {
      /* 三档一圈：列表循环 → 单曲循环 → 随机 → 回到列表循环（曾经第一档是「顺序播放」，已去掉） */
      const modes: PlayMode[] = ['loop', 'single', 'random']
      const current = get().playMode
      get().setPlayMode(modes[(modes.indexOf(current) + 1) % modes.length])
    },

    /*
     * ★ 切换播放模式必须走这里，**不许只改设置**：`order` 与 `playMode` 是同一条语义的两半
     *   —— 只把 `playMode` 改成 random 而 `order` 还是 identity，`step()` 照样按队列顺序走
     *   （表现是「界面上是随机，下一首却按顺序」）。设置页那个下拉框曾经就是直接 patch
     *   设置的，缺陷正是这么来的；它现在也调用这个动作。
     */
    setPlayMode: (mode) => {
      const { queue, cursor, order } = get()
      const currentIndex = cursor >= 0 && cursor < order.length ? order[cursor] : -1
      const nextOrder = orderForMode(mode, queue.length, currentIndex)
      const nextCursor = currentIndex >= 0 ? nextOrder.indexOf(currentIndex) : -1
      set({ playMode: mode, order: nextOrder, cursor: nextCursor })
      void useSettings.getState().patch({ playMode: mode })
    },

    addToQueue: (songs, position = 'end') => {
      const { queue, order, cursor } = get()
      if (position === 'next') {
        const insertAt = cursor + 1
        const nextQueue = [...queue]
        nextQueue.splice(insertAt, 0, ...songs)
        const nextOrder = [
          ...order.slice(0, insertAt),
          ...songs.map((_, i) => queue.length + i),
          ...order.slice(insertAt)
        ]
        set({ queue: nextQueue, order: nextOrder })
      } else {
        set({
          queue: [...queue, ...songs],
          order: [...order, ...songs.map((_, i) => queue.length + i)]
        })
      }
    },

    removeFromQueue: (indexes) => {
      const remove = new Set(indexes)
      const { queue, order, cursor } = get()
      const currentIndex = cursor >= 0 && cursor < order.length ? order[cursor] : -1
      const nextQueue = queue.filter((_, i) => !remove.has(i))
      const remap = new Map<number, number>()
      let write = 0
      queue.forEach((_, i) => {
        if (!remove.has(i)) remap.set(i, write++)
      })
      const nextOrder = order.filter((i) => !remove.has(i)).map((i) => remap.get(i) ?? 0)
      const nextCursor =
        currentIndex >= 0 && remap.has(currentIndex)
          ? nextOrder.indexOf(remap.get(currentIndex)!)
          : -1
      set({ queue: nextQueue, order: nextOrder, cursor: nextCursor })
    },

    moveInQueue: (from, to) => {
      const { queue, order, cursor, playMode } = get()
      if (from === to || from < 0 || to < 0 || from >= queue.length || to >= queue.length) return
      const currentIndex = cursor >= 0 && cursor < order.length ? order[cursor] : -1
      const nextQueue = [...queue]
      const [moved] = nextQueue.splice(from, 1)
      nextQueue.splice(to, 0, moved)
      /*
       * 队列重排后按**当前模式**重建顺序：非随机就是新队列的顺序，随机则重新洗牌。
       * ★ 这里曾经一律写成 identity —— 拖着队列整理一次，随机模式就当场退化成「按队列顺序
       *   一首一首来」，而图标还挂着随机。当前曲跟着它被拖到的新位置走，游标因此不跳。
       */
      const movedIndex = currentIndex < 0 || from !== currentIndex ? currentIndex : to
      const nextOrder = orderForMode(playMode, nextQueue.length, movedIndex)
      const nextCursor = movedIndex >= 0 ? nextOrder.indexOf(movedIndex) : -1
      set({ queue: nextQueue, order: nextOrder, cursor: nextCursor })
    },

    clearQueue: () => {
      // 队列没了就没有「下一首」可预热，退避中的换源也不该再发生
      cancelPendingSwitch()
      resetPrefetch()
      audio.pause()
      audio.removeAttribute('src')
      clearSourceTimer()
      // 队列清空后没有「期望地址」了：留着旧值会让下一首的 error 被误判成迟到的旧错误
      expectedSrc = ''
      currentAttempt = 0
      requestedTrack = undefined
      accountedSong = -1
      consecutiveFailures = 0
      set({
        queue: [],
        order: [],
        cursor: -1,
        playing: false,
        buffering: false,
        currentTime: 0,
        duration: 0,
        lyrics: EMPTY_LYRIC,
        error: null,
        status: null
      })
    },

    jumpTo: async (index) => {
      const { queue, order, context } = get()
      const cursor = order.indexOf(index)
      if (cursor < 0) return
      // 用户自己点的：撤掉上一首的定时器与待发生的换源，连续失败的账也不带过去
      clearSourceTimer()
      cancelPendingSwitch()
      consecutiveFailures = 0
      set({ cursor })
      const song = queue[index]
      if (song) await startSong(song, context)
    },

    setActiveTrack: async (track) => {
      const song = get().currentSong()
      if (!song) return
      set({ activeTrack: track })
      // 记下这份意图：这一轨若加载失败，换源要停在同一条轨上（见 requestedTrack）
      requestedTrack = track
      const settings = useSettings.getState().settings
      const url = buildSongUrl(song, resourceContext(), {
        quality: settings.quality,
        normalize: settings.volumeNormalize,
        track
      })
      const wasPlaying = !audio.paused
      // 切轨要打断的可能正是「退避中的换源」：那条路安排的重试属于上一轨，作废
      cancelPendingSwitch()
      audio.src = url
      // 换了 src 就要把「期望地址」一起换掉，否则这一轨自己失败时会被 error 处理当成旧地址的迟到错误
      expectedSrc = audio.src
      // 切轨是一次新的尝试：计数归零，让这一轨也享有一整条候选链；起播超时表同样要重新上
      currentAttempt = 0
      armSourceTimer(song, 0)
      if (wasPlaying) await audio.play().catch(() => undefined)
    },

    restoreLastQueue: async () => {
      const { settings } = useSettings.getState()
      if (settings.lastQueue.length === 0) return
      const client = useAuth.getState().client
      // 队列里存的都是曲库 id，没有会话就取不回来（免登录时开机照常不恢复，不是错误）
      if (!client) return
      try {
        const songs = await Promise.all(
          settings.lastQueue.map((id) => client.request<Song>(`/songs/${id}`).catch(() => null))
        )
        const valid = songs.filter((s): s is Song => s !== null)
        if (valid.length === 0) return
        /*
         * 顺序按**当前播放模式**重建（`primeAudio()` 已在 App 启动编排里先跑过，这里的
         * playMode 就是设置里那一档）：随机模式下写成 identity，重启后就会「图标是随机、
         * 下一首却按队列顺序」—— 那是同一个缺陷的另一条入口。
         */
        const currentIndex = Math.min(Math.max(0, settings.lastQueueIndex), valid.length - 1)
        const order = orderForMode(get().playMode, valid.length, currentIndex)
        const cursor = order.indexOf(currentIndex)
        set({
          queue: valid,
          order,
          cursor,
          // ★ 上下文也要一并还原：它标着「这个队列是从哪儿播起来的」，
          //   Panel 的「来自歌单/歌手」徽标、以及后续 /songs/{id}/played 的上报都读它。
          //   只恢复 lastQueue/lastQueueIndex 而丢掉这一项，等于每次重启都忘了来源。
          context: settings.lastQueueContext,
          // 不自动播放：恢复会话时突然出声是很糟的体验
          playing: false,
          currentTime: 0,
          duration: 0
        })
        const song = valid[currentIndex]
        if (song) {
          const url = buildSongUrl(song, resourceContext(), {
            quality: settings.quality,
            normalize: settings.volumeNormalize
          })
          audio.src = url
          // 与 startSong 同一套记账：这里也是「准备好一首但不播」，之后 play() 失败时要能按链换源
          expectedSrc = audio.src
          currentAttempt = 0
          audio.volume = settings.volume
          updateMediaSession(song, false)
          void loadLyrics(song).then(({ parsed, failed }) =>
            set({ lyrics: parsed, lyricFailed: failed })
          )
        }
      } catch {
        /* 队列恢复失败不该拦住启动 */
      }
    }
  }
})

/* ─────────────────────── 持久化播放进度 ─────────────────────── */

let persistTimer: number | null = null

playerCore.subscribe(() => {
  /*
   * ★ 只有**已登录的那个会话**才拥有「上次队列」这一份记录（见「本地文件会话」那一节）。
   *
   * 「上次队列」是在线播放列表在客户端唯一的落点：登录时由 usePlayer.restoreLastQueue
   * 还原，之后由这里随时覆写。而下面两种会话答不上「在线队列长什么样」：
   *   · 本地文件会话（迷你宿主窗：没有主窗口，也没有任何会话）；
   *   · 主窗口里的免登录模式（用户双击文件、只听本机音乐的那一趟）。
   * 让它们写进去的后果是把上一次登录留下的那份抹成空 —— 表现是「听了几首本地文件，
   * 再登录回来，上次的播放队列没了」。
   */
  if (useAuth.getState().status !== 'authenticated') return
  if (persistTimer !== null) return
  persistTimer = window.setTimeout(() => {
    persistTimer = null
    const { queue, order, cursor, context } = playerCore.getState()
    /*
     * 只记曲库里的歌：本地文件（id 为负）重启之后是取不回来的，写进去只会在下次开机时
     * 白跑一批注定失败的请求。
     * ★ 落盘的游标要按**留下来的那一份**重算：直接写 queue 里的下标，一旦前面有本地文件
     *   被筛掉，恢复出来的位置就整体前移了（表现是「开机后队列停在了别的歌上」）。
     */
    const persisted = queue.filter((song) => song.id > 0).slice(0, 500)
    /*
     * ★ 队列非空、却一首曲库的歌都没有 = 整队都是本机文件（负 id 只有这一种来源）。
     *   这一趟不该动落盘那一份：用户在已登录的窗口里双击一个音频文件，把「上次队列」
     *   清成空，等于用本地播放列表的**内容**改写了在线播放列表 —— 正是要避免的那件事。
     *   （队列真的空掉是另一回事：那是用户自己清空队列，照记不误。）
     */
    if (persisted.length === 0 && queue.length > 0) return
    const current = cursor >= 0 && cursor < order.length ? queue[order[cursor]] : undefined
    void useSettings.getState().patch({
      lastQueue: persisted.map((song) => song.id),
      lastQueueIndex: current && current.id > 0 ? persisted.indexOf(current) : -1,
      lastQueueContext: context
    })
  }, 1500)
})

/* ─────────────────────── 系统媒体控件接线 ─────────────────────── */

export function installMediaSessionHandlers(): () => void {
  if (!('mediaSession' in navigator)) return () => undefined
  const session = navigator.mediaSession
  const player = playerCore.getState()

  const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
    ['play', () => void player.toggle()],
    ['pause', () => player.pause()],
    ['previoustrack', () => void player.previous()],
    ['nexttrack', () => void player.next(false)],
    ['seekbackward', (details) => player.seekBy(-(details.seekOffset ?? 10))],
    ['seekforward', (details) => player.seekBy(details.seekOffset ?? 10)],
    [
      'seekto',
      (details) => {
        if (details.seekTime != null) player.seek(details.seekTime)
      }
    ],
    ['stop', () => player.pause()]
  ]

  for (const [action, handler] of handlers) {
    try {
      session.setActionHandler(action, handler)
    } catch {
      /* 个别动作在该平台上不支持，跳过 */
    }
  }

  return () => {
    for (const [action] of handlers) {
      try {
        session.setActionHandler(action, null)
      } catch {
        /* 同上 */
      }
    }
  }
}

/** 当前歌曲 / 播放状态变化时刷新系统媒体控件与托盘 */
export function installNowPlayingSync(): () => void {
  let lastKey = ''
  return playerCore.subscribe((state) => {
    const song =
      state.cursor >= 0 && state.cursor < state.order.length
        ? state.queue[state.order[state.cursor]]
        : null
    if (!song) return
    const key = `${song.id}:${state.playing}`
    if (key === lastKey) return
    lastKey = key
    updateMediaSession(song, state.playing)
    void window.songloft.tray.update({
      title: song.title,
      artist: song.artist,
      playing: state.playing,
      favorite: false
    })
  })
}

/**
 * 把音量 / 播放模式同步给 audio 元素。
 *
 * 由**宿主**在设置读完之后调一次：主窗口是 App 的启动编排，迷你宿主窗是本地会话的接线
 * （见 state/local-session.ts）。必须赶在第一次起播之前 —— 否则第一首歌会按默认音量出声。
 */
export function primeAudio(): void {
  const settings = useSettings.getState().settings
  audio.volume = settings.volume
  playerCore.setState({ volume: settings.volume, playMode: settings.playMode })
}

export { audio as audioElement }
