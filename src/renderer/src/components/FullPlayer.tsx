/**
 * 满窗播放：底栏那颗封面点出来的那一层。
 *
 * 标题栏以下整块换成「大封面 + 歌曲信息 + 歌词 + 控制条」，底栏与曲库此刻都被它盖住。
 *
 * ★ 为什么是**浮层**而不是第三种 surface / 一条新路由（见 state/useUi 的 fullPlayer）：
 *   它要的就是「盖在原处」。曲面与路由都是「换一个地方」的语义，而进这一层时
 *   底下的列表、滚动位置、已加载的曲库**一个都不该被换掉** —— 收起后应该还是刚才那一页，
 *   所以底下的原生面只是被盖住、没有卸载（同 .surface 两面互藏的那个理由）。
 *
 * ★ 「播放状态与当前曲目一致」不是同步出来的，而是**同一份状态的另一种画法**：
 *   这里读同一个 usePlayer、同一个进度组件（PlayerProgress）、同一份歌词（LyricsView）。
 *   音频是模块级对象（见 state/usePlayer 的 audio），换不换这一层界面都不影响它出声 ——
 *   所以既不会重新缓冲，也不存在「两处状态谁说了算」。
 *
 * ★ 三条退出路径：左上那颗收起钮、Esc（见 App 的全局键）、以及切去扩展面 / 进迷你
 *   （那是「跟着原生面一起被藏」，回来时原样还在）。**大封面刻意不绑点击**：
 *   那一下在满窗里没有明确含义，误触一次就退出很难受。
 *
 * ★ 布局：左封面右信息（两栏）。歌名一行、歌手与专辑一行，下面是铺满剩余高度的歌词。
 *   底部一条控制带（进度线贴它的上边缘、与底栏同一套组件与手感）。窗口最小 1080×660
 *   （见 main/windows.ts 的 MIN_WIDTH），两栏放得下，不必做窄屏降级。
 */

import { useMemo, useState } from 'react'

import {
  IconChevronDown,
  IconHeart,
  IconMusic,
  IconPause,
  IconPlay,
  IconSkipBack,
  IconSkipForward,
  IconVolume,
  IconVolumeX
} from './Icons'
import { LyricsView } from './LyricsView'
import { MODE_ICON, MODE_LABEL } from './play-mode'
import { PlayerProgress } from './PlayerProgress'
import { Cover, EmptyState, Slider } from './primitives'
import { VideoStage } from './VideoStage'
import { fallbackTitle, songCoverUrl } from '@shared/metadata'
import { useNowPlayingStatus } from '@/hooks/useNowPlayingStatus'
import { displayArtist, formatDuration } from '@/lib/format'
import { buildCoverUrl } from '@/lib/url'
import { resourceContext } from '@/state/useAuth'
import { usePlayer } from '@/state/usePlayer'
import { usePlaylists } from '@/state/usePlaylists'
import { useUi } from '@/state/useUi'

/**
 * 这一层上的图标尺寸。
 *
 * 与底栏同一套思路（主播放键最大、传输键居中、其余更小），数值整体再放大一档：
 * 底栏是一屏里的一条，而这里一屏只有播放器，钮太小会显得空旷。
 */
const ICON_SM = 26 // 收藏、播放模式
const ICON_LG = 34 // 上一首 / 下一首

export function FullPlayer(): React.JSX.Element {
  const player = usePlayer()
  const setFullPlayer = useUi((s) => s.setFullPlayer)
  const favoriteIds = usePlaylists((s) => s.favoriteIds)
  const toggleFavorite = usePlaylists((s) => s.toggleFavorite)
  /** 与底栏、迷你条同一份用途：拖动进度时手上的位置（那行时长也跟着走，见 PlayerProgress） */
  const [scrub, setScrub] = useState<number | null>(null)
  /**
   * 视频字幕开关（只在 video 那条分支上有意义）。
   *
   * ★ 默认**开**：视频时整块歌词列表被画面替换，字幕是歌词唯一的出口 —— 默认关等于
   *   让用户一进满窗就丢掉歌词（原版顶栏那颗开关的默认值不必照抄，取舍理由在这）。
   */
  const [subtitle, setSubtitle] = useState(true)

  const song = useMemo(
    () =>
      player.cursor >= 0 && player.cursor < player.order.length
        ? player.queue[player.order[player.cursor]]
        : null,
    [player.cursor, player.order, player.queue]
  )

  const duration = player.duration || song?.duration || 0
  const position = scrub ?? player.currentTime
  const favorited = song ? favoriteIds.has(song.id) : false
  const hasTrackSwitch = player.tracks.length > 1
  /** 封面：后端出图缺了就退到原始音源封面（见 shared/metadata） */
  const coverUrl = songCoverUrl(song)
  /** 歌手那一行的状态（放不出来 / 正在补齐元数据 / null），与底栏共用一份优先级 */
  const status = useNowPlayingStatus(song, player.error)

  /*
   * 背景那张糊封面的地址。走 buildCoverUrl 而不是自己拼字符串：它认得「相对路径要带
   * access_token、外链 CDN 不能乱加 ?w=」那两条（见 lib/url.ts）。
   * 只问 96px：它要被糊到 60px 以上，给原图纯粹是白拉几百 KB。
   * 解构两个字符串当依赖：resourceContext() 每次返回新对象，直接依赖它会每帧重算。
   */
  const { baseUrl, accessToken } = resourceContext()
  const artUrl = useMemo(
    () => buildCoverUrl(coverUrl, { baseUrl, accessToken }, 96),
    [coverUrl, baseUrl, accessToken]
  )

  return (
    <section className="fullplayer" aria-label="满窗播放" data-video={Boolean(song?.is_video)}>
      {/*
        背景：同一张封面糊成的大色块。aria-hidden —— 它是氛围不是内容，
        真正的封面在下面那张（读屏不该把同一张图读两遍）。
        视频时整层让位给黑底（见 components.css 的 .fullplayer[data-video]）——画面四周
        露出一点糊封面会很脏，原版视频界面也是整屏黑底。
      */}
      <div
        className="fullplayer-bg"
        aria-hidden="true"
        style={artUrl ? { backgroundImage: `url("${artUrl}")` } : undefined}
      />

      <header className="fullplayer-head">
        <button
          type="button"
          className="icon-btn"
          data-tip="收起满窗播放（Esc）"
          aria-label="收起满窗播放"
          onClick={() => setFullPlayer(false)}
        >
          <IconChevronDown size={22} />
        </button>
        <div className="grow" />
        {/* 字幕开关：只有视频那条分支上才有意义（音频那边歌词本来就是整块列表） */}
        {song?.is_video ? (
          <button
            type="button"
            className="icon-btn"
            data-active={subtitle}
            data-tip={subtitle ? '关闭字幕' : '显示字幕'}
            aria-label="字幕"
            onClick={() => setSubtitle((v) => !v)}
          >
            <span className="cc-mark">CC</span>
          </button>
        ) : null}
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
      </header>

      {/*
        视频歌曲（is_video）整块换成画面 —— 与原版桌面端一致：满窗播放器里「左封面右歌词」
        被整屏替换，没有「视频 ↔ 歌词/封面」的切换，歌词只剩叠加字幕这一条出口
        （见 components/VideoStage）。音频歌曲一个像素都不变。
      */}
      {song?.is_video ? (
        <div className="fullplayer-body" data-video="true">
          <VideoStage subtitle={subtitle} />
        </div>
      ) : song ? (
        <div className="fullplayer-body">
          <div className="fullplayer-art">
            <div className="fullplayer-art-box">
              {/* 大封面要的是原图级别：这一张会铺到几百像素宽（width 给它 768） */}
              <Cover coverUrl={coverUrl} width={768} size="100%" radius="var(--r-lg)" kind="song" />
            </div>
          </div>

          <div className="fullplayer-info">
            <div className="fullplayer-title">{fallbackTitle(song)}</div>
            {/*
              歌手这一行兼作播放状态行（与底栏同一份优先级，见 hooks/useNowPlayingStatus）——
              满窗播放会把底栏整个盖住，只在底栏报「放不出来」等于开着满窗就看不到。
            */}
            <div className="fullplayer-sub" data-state={player.error ? 'error' : undefined}>
              {status ?? (
                <>
                  {displayArtist(song.artist)}
                  {song.album ? ` · ${song.album}` : ''}
                </>
              )}
            </div>
            {/* 徽标与抽屉里「正在播放」那一份同源同序（见 components/Panel.tsx） */}
            <div className="fullplayer-badges">
              {player.context ? (
                <span className="badge">
                  来自{player.context.type === 'playlist' ? '歌单' : player.context.type}
                </span>
              ) : null}
              {song.format ? <span className="badge">{song.format.toUpperCase()}</span> : null}
              {song.bit_rate ? (
                <span className="badge">{Math.round(song.bit_rate / 1000)}k</span>
              ) : null}
              {song.year ? <span className="badge">{song.year}</span> : null}
            </div>
            {/* 歌词自带 flex: 1 + overflow-y: auto，但要外面先是一个 flex 列，那份比例才有处生效 */}
            <div className="fullplayer-lyrics">
              <LyricsView />
            </div>
          </div>
        </div>
      ) : (
        <div className="fullplayer-body" data-empty="true">
          <EmptyState
            icon={<IconMusic size={26} />}
            title="还没有在播放"
            description="从曲库挑一首，或按 Ctrl+K 搜索"
          />
        </div>
      )}

      <footer className="fullplayer-foot">
        {/* 与底栏、迷你条共用同一份：拖动期间只动本地 scrub、松手才 seek 那套只有一份实现 */}
        <PlayerProgress
          duration={duration}
          position={player.currentTime}
          scrub={scrub}
          onScrub={setScrub}
          onSeek={(seconds) => player.seek(seconds)}
          onSeekBy={(delta) => player.seekBy(delta)}
        />

        <span className="fullplayer-time">
          {formatDuration(position)} / {formatDuration(duration)}
        </span>

        <div className="fullplayer-controls">
          {/* 与底栏那颗同口径：模式由图标示意，不靠变色（见 PlayerBar.tsx 的说明） */}
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
            {/* 两颗图标刻意不同尺寸：三角形那个字形只占方框四成宽，同一个 size 下看着矮一截
                （与底栏、迷你条同一个理由，见 PlayerBar 的说明） */}
            {player.playing ? <IconPause size={22} /> : <IconPlay size={24} />}
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
        </div>

        <div className="fullplayer-right">
          {hasTrackSwitch ? (
            <select
              className="input"
              style={{ width: 104, height: 32, fontSize: 12.5 }}
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

          <div className="volume-group">
            <button
              type="button"
              className="icon-btn"
              data-tip={player.muted ? '取消静音' : '静音'}
              aria-label={player.muted ? '取消静音' : '静音'}
              onClick={() => player.toggleMute()}
            >
              {player.muted || player.volume === 0 ? (
                <IconVolumeX size={ICON_SM} />
              ) : (
                <IconVolume level={player.volume > 0.55 ? 2 : 1} size={ICON_SM} />
              )}
            </button>
            <Slider
              ariaLabel="音量"
              value={player.muted ? 0 : player.volume * 100}
              max={100}
              // 拖动期间只改内存，松手立刻 flush —— 「拖完就退出」不该丢掉最后一次音量（同底栏）
              onChange={(value) => player.setVolume(value / 100)}
              onCommit={(value) => {
                player.setVolume(value / 100)
                player.flushVolume()
              }}
            />
          </div>
        </div>
      </footer>
    </section>
  )
}
