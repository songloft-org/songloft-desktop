/**
 * **跟随者**那一侧的「播放器」：宿主那一份的**镜像**（只在普通迷你窗里用）。
 *
 * ★ 谁需要它：迷你窗在**普通会话**里只是主界面旁边挂着的一条播放条 —— 播放的唯一事实源
 *   在主窗口那边。而本地文件会话里的迷你窗是**宿主**（自己就是播放器，见 state/usePlayer
 *   的分流），那种窗口用不到这个模块。
 * ★ 为什么要有它，而不是让每个窗口都自己建一个播放器：一首歌只能有一个 `HTMLAudioElement`
 *   在放（两个窗口各放一份就是同一首歌响两遍）。所以镜像这一侧只做两件事：
 *     · 把主窗口推来的快照贴进 store（数据）；
 *     · 把界面上的动作变成**遥控命令**发过去（动作，见 shared/ipc.ts 的 MiniCommand）。
 *
 * ★ 形状刻意与 PlayerState 一模一样 —— 于是 Queue / LyricsView 这些组件两边都能直接用，
 *   不必为了「迷你窗里能不能用」再分出一份实现（那两份迟早分叉：拖拽排序、歌词跟随、
 *   点行跳转都得各写一遍）。store 类型就是 PlayerState，见 state/usePlayer.ts 那个分流器。
 *
 * ★ 这里**不做任何乐观更新**，只有音量与播放模式例外（见下面两处：拖着音量条时值要跟着手
 *   走，等一个来回会明显发涩）。其余一律等主窗口的回推 —— 本地先改、再被真实值覆盖，
 *   中间那一帧是假的，而「迷你条显示的与在放的不一致」是最难查的那种 bug。
 */

import { create } from 'zustand'

import type { MiniCommand, MiniPlayerSnapshot } from '@shared/ipc'
import type { ParsedLyric } from '@shared/lyric'
import type { PlayerState } from './player-core'
import { useAuth } from './useAuth'
import { useMiniView } from './useMiniView'
import { useSettings } from './useSettings'

const EMPTY_LYRIC: ParsedLyric = { lines: [], synced: false, meta: {}, offset: 0 }

/** 发一条遥控命令（主进程转给主窗口执行）。命令的语义全在共享类型里 */
function send(command: MiniCommand): void {
  void window.songloft.mini.command(command)
}

/**
 * 迷你窗里没有入口去触发的动作。
 *
 * 它们留在 store 上只为满足 PlayerState 的形状（复用那两个组件时，类型必须是完整的一份）。
 * 真被调到就说明有人把**主窗口才有的界面**搬到了迷你窗（曲库、歌单、命令面板…），
 * 那种情况下什么也不做才是对的 —— 凭空猜一个「大概想干嘛」只会把话说错。
 * 留一条 warn 让人当场看见，而不是静默地没反应。
 */
function unsupported(name: string): void {
  console.warn(`[mini] 迷你窗里没有「${name}」的入口，这一下被忽略了`)
}

export const remotePlayer = create<PlayerState>((set, get) => ({
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
  /* 状态行（正在获取音源 / 正在切换第 N 个音源 / 缓冲中… / 放不出来）：由快照带过来 */
  status: null,
  lyrics: EMPTY_LYRIC,
  lyricsLoading: false,
  lyricFailed: false,
  tracks: [],
  activeTrack: -1,
  context: null,

  /** 与真播放器同一套算法：当前曲 = queue[order[cursor]]。队列与游标都是镜像来的 */
  currentSong: () => {
    const { queue, order, cursor } = get()
    if (cursor < 0 || cursor >= order.length) return null
    return queue[order[cursor]] ?? null
  },

  toggle: async () => send({ kind: 'toggle' }),
  pause: () => send({ kind: 'pause' }),
  /* 「取消投送后接着上一路继续」只有主窗口那条路会走（投送状态只在那里），迷你窗里没有 */
  resumeLocal: async () => unsupported('resumeLocal'),
  next: async (auto = false) => send({ kind: 'next', auto }),
  previous: async () => send({ kind: 'previous' }),
  seek: (seconds) => send({ kind: 'seek', seconds }),
  seekBy: (delta) => send({ kind: 'seek-by', delta }),
  toggleMute: () => send({ kind: 'toggle-mute' }),
  cyclePlayMode: () => send({ kind: 'cycle-play-mode' }),

  /*
   * 音量：本地先落一步再发命令。拖动期间每个 pointermove 都调它，等一个来回的话手上的
   * 位置与条上的填充会差着十几毫秒 —— 那点延迟在拖动里看得出来（填充跟不上手指）。
   * 松手时 flushVolume 让主窗口把值写盘，与底栏那条音量条走的是同一条路。
   */
  setVolume: (volume) => {
    const clamped = Math.max(0, Math.min(1, volume))
    set({ volume: clamped, muted: false })
    send({ kind: 'set-volume', volume: clamped })
  },
  flushVolume: () => send({ kind: 'flush-volume' }),

  setPlayMode: (mode) => {
    // 同上：模式切换是「点一下」的动作，本地先反映出来，回推再校正
    set({ playMode: mode })
    send({ kind: 'set-play-mode', mode })
  },

  jumpTo: async (index) => send({ kind: 'jump-to', index }),
  removeFromQueue: (indexes) => send({ kind: 'remove-from-queue', indexes }),
  moveInQueue: (from, to) => send({ kind: 'move-in-queue', from, to }),
  clearQueue: () => send({ kind: 'clear-queue' }),
  reloadLyrics: async () => send({ kind: 'reload-lyrics' }),

  /* ── 迷你窗里没有入口的那些（见 unsupported 的说明）──────────────────── */
  playSongs: async () => unsupported('播放某一批歌曲'),
  playSong: async () => unsupported('播放某一首歌'),
  addToQueue: () => unsupported('加入播放队列'),
  setActiveTrack: async () => unsupported('切换音轨'),
  restoreLastQueue: async () => unsupported('恢复上次队列'),
  refreshCurrentSong: async () => unsupported('重取当前曲目元数据')
}))

/**
 * 贴一份主窗口推来的快照。
 *
 * ★ 顺序上假设「重的那半先到」：换歌时主窗口会先把 heavy（新队列 / 新游标）推出去再推
 *   light（新位置），否则这里会出现「新游标 + 旧队列」的中间态 —— 取到的是另一首歌。
 *   两份走的是同一条 IPC，顺序有保证（见 state/mini-host.ts 的 push）。
 */
export function applyMiniSnapshot(snapshot: MiniPlayerSnapshot): void {
  const { light, heavy } = snapshot

  remotePlayer.setState({
    queue: heavy.queue,
    order: heavy.order,
    lyrics: heavy.lyrics,
    lyricsLoading: heavy.lyricsLoading,
    lyricFailed: heavy.lyricFailed,
    cursor: light.cursor,
    playing: light.playing,
    currentTime: light.position,
    duration: light.duration,
    volume: light.volume,
    muted: light.muted,
    playMode: light.playMode,
    // 状态行（正在获取音源 / 正在切换第 N 个音源 / 缓冲中… / 放不出来）照抄主窗口那一份：
    // 措辞归播放核心的状态机所有，迷你窗一个字都不该自己拼（见 shared/ipc 的 MiniPlayerLight）
    status: light.status,
    error: light.error
  })

  // 收藏与强调色不在 PlayerState 上，各有各的家（收藏见 useMiniView，强调色见 useSettings）
  useMiniView.getState().setFavorite(light.favorite)
  /*
   * 强调色跟着封面走。★ 必须比较后再说：每份快照都调一次 setCoverAccent 意味着每秒四次
   * 重算整套 CSS 变量（它会写 <html> 上的 --accent / --on-accent …），纯属白烧。
   */
  if (useSettings.getState().coverAccent !== light.accent) {
    useSettings.getState().setCoverAccent(light.accent)
  }
  /*
   * 封面的 token：迷你窗**没有会话**（登录、刷新令牌都由主窗口一个人负责 —— 两个渲染层各
   * 建一份 client 会在轮换 refresh token 时互相把对方踢下线）。而封面是交给 img 直接请求的，
   * 地址里得有 token，所以这一份上下文只能由快照喂进来（见 useAuth 的 setMirroredMedia）。
   */
  const { baseUrl, accessToken } = useAuth.getState().mirroredMedia ?? {
    baseUrl: '',
    accessToken: ''
  }
  if (baseUrl !== heavy.media.baseUrl || accessToken !== heavy.media.accessToken) {
    useAuth.getState().setMirroredMedia(heavy.media)
  }
}

/** 迷你窗启动时接一次：剩下的都靠主窗口推（首次的那一份由 MiniApp 要，见那里的 ready） */
export function installMiniBridge(): () => void {
  return window.songloft.mini.onState(applyMiniSnapshot)
}
