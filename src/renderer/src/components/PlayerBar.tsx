/**
 * 底部播放栏。
 *
 * 一条细节值得说明：进度条做成贴在栏**顶部**的一条 3px 细线（hover 时变粗到 5px），
 * 而不是占一整行的独立控件 —— 桌面宽屏下这样能省掉一整行垂直空间，
 * 同时滚动的进度始终可见。这是相对 Flutter 端移动优先布局最明显的桌面化调整。
 * 它的实现在 components/PlayerProgress.tsx（迷你模式那条栏与它共用同一份）。
 */

import { useMemo, useState } from 'react'

import { fallbackTitle, songCoverUrl } from '@shared/metadata'
import { useNowPlayingStatus } from '@/hooks/useNowPlayingStatus'
import {
  IconCast,
  IconHeart,
  IconLyrics,
  IconMini,
  IconPause,
  IconPlay,
  IconQueue,
  IconSkipBack,
  IconSkipForward,
  IconVolume,
  IconVolumeX
} from './Icons'
import { PlayerProgress } from './PlayerProgress'
import { MODE_ICON, MODE_LABEL } from './play-mode'
import { Cover, Slider } from './primitives'
import { displayArtist, formatDuration } from '@/lib/format'
import { useDlna } from '@/state/dlna'
import { usePlayer } from '@/state/usePlayer'
import { usePlaylists } from '@/state/usePlaylists'
import { useUi } from '@/state/useUi'

/**
 * 底栏里的图标尺寸。
 *
 * ★ 规则：**除主播放键外一律是原值的 1.5 倍**（16 → 24、17 → 26、19 → 28）。
 *   原来那几颗在宽屏底栏上偏小，一眼看不出画的是什么；放大之后主次仍然清楚 ——
 *   主播放键（44px 实心圆 + 19px 图标）刻意没动：它靠「整条上唯一的实心圆 + accent 填充」
 *   立在那儿，不必再靠尺寸压别人一头。旁边的钮跟着长了一档（38px，见 components.css
 *   的 .playerbar .icon-btn），否则 1.5 倍的字形会顶到悬浮底色的边上。
 * ★ 播放模式那一颗的尺寸不在这三档里：它由 play-mode.tsx 自己定（三处播放界面共用，
 *   包括跑在另一个窗口里的迷你条），底栏只是取用方。
 */
const ICON_SM = 24 // 原 16：收藏
const ICON_MD = 26 // 原 17：歌词 / 队列 / 迷你 / 音量
const ICON_LG = 28 // 原 19：上一首 / 下一首

export function PlayerBar(): React.JSX.Element {
  const player = usePlayer()
  const { panelOpen, panelTab, togglePanel, miniOpen, setFullPlayer } = useUi()
  const favoriteIds = usePlaylists((s) => s.favoriteIds)
  const toggleFavorite = usePlaylists((s) => s.toggleFavorite)
  /** 投送状态：底栏这颗按钮的高亮与「取消」语义都看它 */
  const dlnaCasting = useDlna((s) => s.casting)
  const dlnaDeviceName = useDlna((s) => s.activeDevice?.name ?? '音箱')
  /*
   * 投送期间的音量滑条 / 静音键控的是**音箱**的音量（DLNA RenderingControl）。
   * 本机正静着，拖它却没反应会让人以为坏了；反过来，滑条位置也该显示音箱的真实音量，
   * 不然「显示 70%、实际 19%」一拖就跳。
   * volume < 0 = 这台设备没有 RenderingControl，那还是本机语义（并把提示说清楚）。
   */
  const dlnaVolume = useDlna((s) => s.status?.volume ?? -1)
  const dlnaMuted = useDlna((s) => s.mutedOnDevice)
  const volumeOnDevice = dlnaCasting && dlnaVolume >= 0
  /** 拖动进度条时手上的位置；null = 没在拖（见 PlayerProgress 的说明） */
  const [scrub, setScrub] = useState<number | null>(null)

  const song = useMemo(
    () =>
      player.cursor >= 0 && player.cursor < player.order.length
        ? player.queue[player.order[player.cursor]]
        : null,
    [player.cursor, player.order, player.queue]
  )

  const duration = player.duration || song?.duration || 0
  // 拖动中显示手上的位置（下面那行时长文字也跟着走），松手后才回到播放器的真实进度
  const position = scrub ?? player.currentTime
  const favorited = song ? favoriteIds.has(song.id) : false
  const hasTrackSwitch = player.tracks.length > 1

  /*
   * 歌手那一行兼作**播放状态行**（优先级见 hooks/useNowPlayingStatus）：
   * 放不出来时它就是错误信息，正在补齐元数据时它说「正在获取歌曲信息…」，正常时才是歌手名。
   *
   * ★ 播放失败**刻意不走 toast**：音源成片失效时 toast 会一首歌弹三条、堆满一屏，把错误本身
   *   挤没（改之前就是这样）。底栏这一行一直在用户眼前，位置固定、不遮挡、也不会互相盖掉。
   */
  const status = useNowPlayingStatus(song, player.error)

  return (
    <footer className="playerbar">
      {/* 拖动 / 键盘那一整套在 PlayerProgress 里，与迷你模式那条栏共用同一份 */}
      <PlayerProgress
        duration={duration}
        position={player.currentTime}
        scrub={scrub}
        onScrub={setScrub}
        onSeek={(seconds) => player.seek(seconds)}
        onSeekBy={(delta) => player.seekBy(delta)}
      />

      {/*
        播放时间固定在底栏**右上角**（绝对定位，见 components.css 的 .playerbar-time）。
        之所以放在角上而不是塞进某一组里：它是这一整条唯一的**读数**，不属于任何一组
        操作 —— 左格是「放的是哪一首」、中格是「怎么放」、右格是「换个看法」。
        挂在角上之后，歌名再长、右格再多几颗钮，都挤不到它。
        拖动进度条时这里跟着手上的位置走（position 就是 scrub ?? currentTime）。
      */}
      <span className="playerbar-time">
        {formatDuration(position)} / {formatDuration(duration)}
      </span>

      {/* 左侧：当前曲目 */}
      <div className="playerbar-now">
        {/*
          封面 = **进满窗播放**（见 components/FullPlayer.tsx）：大封面 + 歌词 + 控制条盖住
          标题栏以下整块。它原先开的是右侧抽屉 —— 抽屉没被砍掉，入口改成上面那颗
          「歌词面板」与 Ctrl+L（「看一眼歌词」和「把播放器铺满一屏」本来就是两件事）。
        */}
        <button
          type="button"
          className="playerbar-cover"
          data-tip="满窗播放"
          aria-label="满窗播放"
          onClick={() => setFullPlayer(true)}
        >
          {/* 缺后端出图时退到原始音源封面（见 shared/metadata 的 songCoverUrl） */}
          <Cover coverUrl={songCoverUrl(song)} width={112} size={54} radius={10} kind="song" />
        </button>
        {/*
          这一格**不设 flex: 1**（只留 min-width: 0）：占满整格的话，右边那颗收藏钮
          会被推到左格的最右端，离歌名隔着半条栏。这里要的是「名字读完了就挨着收藏钮」——
          所以宽度交给内容，只有内容比格子长时才收缩（min-width: 0 让 truncate 生效）。
        */}
        <div style={{ minWidth: 0 }}>
          {/* 标题兜底：元数据里没有标题时用文件名，再没有才说「未知歌曲」 */}
          <div className="playerbar-title truncate">{fallbackTitle(song)}</div>
          {/*
            歌手那一行兼作**播放状态行**（见上面 status 的说明）：放不出来时它就是错误信息，
            正常时才是歌手名。`data-state` 只负责上色（错误主题色），文案本身已经说清了事。
            错误时提示「点播放键重试」——底栏那颗播放键已经把「再试一次」接在这个语义上了。
          */}
          <div
            className="playerbar-artist truncate"
            data-state={player.error ? 'error' : status ? 'loading' : undefined}
            data-tip={player.error ? `${player.error}（点中间的播放键重试）` : undefined}
          >
            {status ?? (song ? displayArtist(song.artist) : '从曲库选一首开始播放')}
          </div>
        </div>
        {song ? (
          <button
            type="button"
            className="icon-btn"
            data-active={favorited}
            data-tip={favorited ? '取消收藏' : '收藏'}
            aria-label={favorited ? '取消收藏' : '收藏'}
            onClick={() => void toggleFavorite(song)}
          >
            <IconHeart size={ICON_SM} filled={favorited} />
          </button>
        ) : null}
      </div>

      {/* 中间：传输控制 */}
      <div className="playerbar-controls">
        {/*
          播放模式钮刻意**不带 data-active**：当前是哪一档由图标本身示意
          （每档一颗不同的图标，见 play-mode.tsx），再点一层 accent 色没有多说明任何事，
          却让它在传输控制这一排里单独亮着 —— 与相邻几颗钮不是一个观感。
        */}
        <button
          type="button"
          className="icon-btn"
          data-tip={MODE_LABEL[player.playMode]}
          aria-label={MODE_LABEL[player.playMode]}
          onClick={() => player.cyclePlayMode()}
        >
          {MODE_ICON[player.playMode]}
        </button>

        <button
          type="button"
          className="icon-btn"
          data-tip="上一首"
          aria-label="上一首"
          disabled={!song}
          onClick={() => void player.previous()}
        >
          <IconSkipBack size={ICON_LG} />
        </button>

        <button
          type="button"
          className="play-btn"
          data-tip={player.playing ? '暂停' : '播放'}
          aria-label={player.playing ? '暂停' : '播放'}
          disabled={!song}
          onClick={() => void player.toggle()}
        >
          {player.playing ? <IconPause size={19} /> : <IconPlay size={19} />}
        </button>

        <button
          type="button"
          className="icon-btn"
          data-tip="下一首"
          aria-label="下一首"
          disabled={!song}
          onClick={() => void player.next(false)}
        >
          <IconSkipForward size={ICON_LG} />
        </button>

        {/*
          投送到音箱：**无论投送与否，点它都只是打开那个框**（见 DlnaDialog —— 框里摆着
          「本机播放」和每台设备，谁在当前出口带一枚标记，切换出口全在那儿点）。
          不再按状态改行为：「取消投送」本身就是有副作用的（本机开始出声 / 音箱那边停掉），
          不该藏在一颗随状态换语义的钮上；换设备也就不必先取消一次。
          ★ 也因此**不再 `disabled={!song}`**：投送中清空队列会让 song 变 null，那一版会把
          「切回本机」这条路一起关掉，声音留在音箱上再也拿不回来。
          它与左右邻居是同一类东西（都作用于「此刻这一首怎么放」），所以留在中间这一排、
          紧跟在「下一首」后面；右边的歌词 / 队列 / 迷你 / 音量属于「换个看法」，不混。
        */}
        <button
          type="button"
          className="icon-btn"
          data-active={dlnaCasting}
          data-tip={
            dlnaCasting ? `正在投送到「${dlnaDeviceName}」，点击更换` : '投送到音箱（DLNA）'
          }
          aria-label={dlnaCasting ? '更换投送设备' : '投送到音箱'}
          onClick={() => useDlna.getState().openDialog()}
        >
          <IconCast size={ICON_MD} />
        </button>
      </div>

      {/* 右侧：视图与音量 */}
      <div className="playerbar-right">
        {hasTrackSwitch ? (
          <select
            className="input"
            style={{ width: 96, height: 30, fontSize: 12 }}
            value={player.activeTrack}
            onChange={(event) => void player.setActiveTrack(Number(event.target.value))}
            data-tip="切换音轨（原唱 / 伴奏）"
          >
            {player.tracks.map((track) => (
              <option key={track.index} value={track.index}>
                {track.title || track.language || `音轨 ${track.index + 1}`}
              </option>
            ))}
          </select>
        ) : null}

        <button
          type="button"
          className="icon-btn"
          data-active={panelOpen && panelTab === 'now-playing'}
          data-tip="歌词面板"
          aria-label="歌词面板"
          onClick={() => togglePanel('now-playing')}
        >
          <IconLyrics size={ICON_MD} />
        </button>

        <button
          type="button"
          className="icon-btn"
          data-active={panelOpen && panelTab === 'queue'}
          data-tip="播放队列"
          aria-label="播放队列"
          onClick={() => togglePanel('queue')}
        >
          <IconQueue size={ICON_MD} />
        </button>

        {/*
          迷你播放器。它与上面两颗「面板」按钮是同一类（换一个看播放器的姿势），所以并排放在
          这里；点一下**开一个独立的迷你窗口**，再点一下关掉它 —— data-active 就是它此刻开着
          没有（那是主进程的回声，见 useUi.miniOpen）。

          ★ 主窗口本身**一点都不动**：不缩、不重排、不换界面，也不丢焦点之外的任何状态。
            这颗按钮要的就只是「那条挂件开着没有」这一个布尔量 —— 从前那种「点一下整个窗口
            缩成 400×64」的做法，会把主界面里的一切都按 400px 重排一次（扩展的 webview 尤其
            经不起），也正是它被拆成独立窗口的原因。
        */}
        <button
          type="button"
          className="icon-btn"
          data-active={miniOpen}
          data-tip={miniOpen ? '关闭迷你播放器' : '迷你播放器'}
          aria-label={miniOpen ? '关闭迷你播放器' : '迷你播放器'}
          onClick={() => void window.songloft.mini.setOpen(!miniOpen)}
        >
          <IconMini size={ICON_MD} />
        </button>

        <div className="volume-group" data-disabled={dlnaCasting && dlnaVolume < 0}>
          <button
            type="button"
            className="icon-btn"
            data-tip={
              volumeOnDevice
                ? dlnaMuted
                  ? '取消音箱静音'
                  : '音箱静音'
                : player.muted
                  ? '取消静音'
                  : '静音'
            }
            aria-label={volumeOnDevice ? '音箱静音' : player.muted ? '取消静音' : '静音'}
            onClick={() => {
              if (volumeOnDevice) {
                /*
                 * 音箱是另一台设备，本机的 muted 对它无效 —— 只能把音量真的设到最小，
                 * 再点一次还原（原值靠 lastVolume 记着，见 state/dlna 的说明）。
                 * ★ 为什么看 dlnaMuted 而不是「音量是不是 0」：小爱会把这个 0 收到 1，
                 *   只看回读值的话图标永远不变，用户会以为这个键没反应。
                 */
                useDlna.getState().toggleDeviceMute()
                return
              }
              player.toggleMute()
            }}
          >
            {volumeOnDevice ? (
              dlnaMuted ? (
                <IconVolumeX size={ICON_MD} />
              ) : (
                <IconVolume level={dlnaVolume > 55 ? 2 : 1} size={ICON_MD} />
              )
            ) : player.muted || player.volume === 0 ? (
              <IconVolumeX size={ICON_MD} />
            ) : (
              <IconVolume level={player.volume > 0.55 ? 2 : 1} size={ICON_MD} />
            )}
          </button>
          <Slider
            ariaLabel="音量"
            /*
             * 投送时这一格读到的已经是**设备音量**（state/dlna 的 applyStatus 会把它写进
             * player.volume），所以这里不必再分流 —— 满窗播放、迷你条、媒体键同理。
             * 发往设备的那一路由 player-core.setVolume → CastBridge.volume 合并后发出。
             */
            value={player.muted ? 0 : player.volume * 100}
            max={100}
            // 拖动期间只改内存（setVolume 内部会把落盘合并成一跳），
            // 松手再立刻 flush，避免「拖完就退出」丢掉最后一次音量
            onChange={(value) => player.setVolume(value / 100)}
            onCommit={(value) => {
              player.setVolume(value / 100)
              // 投送时不该把设备音量当成用户的本机偏好立刻落盘（见 player-core 的说明）
              if (!volumeOnDevice) player.flushVolume()
            }}
          />
        </div>
      </div>
    </footer>
  )
}
