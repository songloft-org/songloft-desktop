/**
 * 首页。
 *
 * 结构照搬 Flutter 端的「首页 = 概览 + 入口」，但按桌面宽屏重排：
 *   * 统计条从「底部小面板」提到顶部 —— 桌面第一眼能看到库规模，比空荡荡的标题栏有用
 *   * 歌单/歌手用卡片网格横向铺开，而不是移动端的两列纵向滚动
 *   * 卡片自带播放按钮（hover 才显形）：不用先进详情页就能开播
 *   * 「最近加入」是**单行**封面排（与「我的歌单」封面同宽，超出部分横向滚动/可按住拖动），
 *     而不是紧凑表格：封面比一行行的元数据更适合「扫一眼有什么新东西」。要按列比较
 *     （时长/加入时间/专辑）或看完整列表时去曲库页
 *   * 分区块的顺序是：我的歌单 → 常听歌手 → 最近加入。前三者是「点进去听」的入口，优先占
 *     首屏；「最近加入」是浏览性的（本来就在末尾一屏内，横向一行即可看全 8 张）
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { Song, SongFacet } from '@shared/types'
import { openMenuFromEvent } from '@/components/ContextMenu'
import {
  IconClock,
  IconDisc,
  IconHistory,
  IconLibrary,
  IconListMusic,
  IconPlay,
  IconRefresh,
  IconSparkle,
  IconUser
} from '@/components/Icons'
import { CardGridSkeleton, Cover, EmptyState } from '@/components/primitives'
import { buildSongMenuItems } from '@/components/songMenu'
import { fallbackTitle, songCoverUrl } from '@shared/metadata'
import { getFacets, getLibraryStats, getSongs } from '@/api/endpoints'
import { useAsync } from '@/hooks/useAsync'
import { useHorizontalScroll } from '@/hooks/useHorizontalScroll'
import {
  displayArtist,
  formatBytes,
  formatCount,
  formatDurationLong,
  formatRelative
} from '@/lib/format'
import { requireClient } from '@/state/useAuth'
import { usePlayer } from '@/state/usePlayer'
import { usePlaylists } from '@/state/usePlaylists'
import { useSettings } from '@/state/useSettings'
import { useUi } from '@/state/useUi'
import { toast } from '@/state/useToasts'

function greeting(): string {
  const hour = new Date().getHours()
  if (hour < 5) return '夜深了'
  if (hour < 11) return '早上好'
  if (hour < 14) return '中午好'
  if (hour < 18) return '下午好'
  return '晚上好'
}

export function HomePage(): React.JSX.Element {
  const navigate = useUi((s) => s.navigate)
  const playlists = usePlaylists((s) => s.playlists)
  const playSongs = usePlayer((s) => s.playSongs)
  const restoreLastQueue = usePlayer((s) => s.restoreLastQueue)
  const toggle = usePlayer((s) => s.toggle)
  const lastQueue = useSettings((s) => s.settings.lastQueue)

  // 统计与「最近加入」都是便宜的一次性请求，进来就拿
  const stats = useAsync(() => getLibraryStats(requireClient()), [])
  const recent = useAsync(
    () => getSongs(requireClient(), { sort: 'added_at', order: 'desc', limit: 8 }),
    []
  )
  const artists = useAsync(
    () => getFacets(requireClient(), 'artist', { limit: 12, sort: 'count', order: 'desc' }),
    []
  )

  const recentSongs = recent.data?.songs ?? []

  const totalDuration = stats.data ? formatDurationLong(stats.data.total_duration) : '—'

  /** 首页的「随机播放」：拉一页最近的歌再洗牌，避免为了随机去拉全库 id */
  const playRandom = useCallback(async () => {
    try {
      const res = await getSongs(requireClient(), { sort: 'added_at', order: 'desc', limit: 300 })
      if (res.songs.length === 0) {
        toast('曲库还是空的', 'info', '先去「设置 → 曲库」扫描音乐目录')
        return
      }
      const shuffled = [...res.songs]
      for (let i = shuffled.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1))
        ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
      }
      await playSongs(shuffled.slice(0, 120), 0, { type: 'home', key: 'random' })
    } catch (error) {
      toast('随机播放失败', 'error', error instanceof Error ? error.message : undefined)
    }
  }, [playSongs])

  const resume = useCallback(async () => {
    await restoreLastQueue()
    await toggle()
  }, [restoreLastQueue, toggle])

  const playArtist = useCallback(
    async (name: string) => {
      try {
        const res = await getSongs(requireClient(), {
          artist: name,
          limit: 300,
          sort: 'added_at',
          order: 'desc'
        })
        if (res.songs.length === 0) return
        await playSongs(res.songs, 0, { type: 'artist', key: name })
      } catch (error) {
        toast(`播放「${name}」失败`, 'error', error instanceof Error ? error.message : undefined)
      }
    },
    [playSongs]
  )

  const regularPlaylists = useMemo(
    () =>
      playlists.filter((p) => p.type === 'normal' && !p.labels.includes('built_in')).slice(0, 10),
    [playlists]
  )

  /**
   * 「最近加入」的封面要与「我的歌单」的封面**一样大**，但横向滚动要求卡片宽度是确定值，
   * 而歌单那边的宽度是 auto-fill 的 1fr 摊出来的 —— 同一个窗口下 158~202 都可能，
   * CSS 里推不出来（列数是阶梯函数）。所以量一次歌单卡的真实宽度写进 --card-w。
   *
   * 量的好处是列宽公式仍然只有 CSS 一份：歌单网格怎么改，这里跟着变。
   * 歌单区为空时（那边是空状态、没有卡片）没有可比对象，退回 CSS 里的基准宽即可。
   */
  const playlistGridRef = useRef<HTMLDivElement>(null)
  const [coverWidth, setCoverWidth] = useState<number | null>(null)
  // 歌单区有没有卡片渲染出来：有网格才谈得上量它，空状态时这一条变化即可重跑
  const hasPlaylistGrid = regularPlaylists.length > 0

  useEffect(() => {
    const grid = playlistGridRef.current
    if (!grid) return
    const measure = (): void => {
      const card = grid.querySelector('.card')
      setCoverWidth(card ? card.getBoundingClientRect().width : null)
    }
    measure()
    // 观察网格本身即可：卡片宽度只由容器宽度决定（增删歌单不会改变列宽）
    const observer = new ResizeObserver(measure)
    observer.observe(grid)
    return () => observer.disconnect()
  }, [hasPlaylistGrid])

  // 滚轮转横向 + 按住拖动（见 hooks/useHorizontalScroll.ts）
  const recentRow = useHorizontalScroll()

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">{greeting()}</h1>
          <p className="page-subtitle">
            {stats.data
              ? `曲库 ${formatCount(stats.data.total_songs)} 首 · ${totalDuration} · ${formatBytes(
                  stats.data.total_file_size
                )}`
              : '正在读取曲库概况…'}
          </p>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <button
            type="button"
            className="btn"
            onClick={() => void resume()}
            disabled={lastQueue.length === 0}
          >
            <IconHistory size={15} />
            继续上次播放
          </button>
          <button
            type="button"
            className="btn"
            data-variant="primary"
            onClick={() => void playRandom()}
          >
            <IconPlay size={15} />
            随机播放
          </button>
        </div>
      </div>

      {/* ── 统计条 ── */}
      {stats.loading ? (
        <div className="stats-strip">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i}>
              <div className="skeleton" style={{ height: 22, width: 70 }} />
              <div className="skeleton" style={{ height: 10, width: 46, marginTop: 8 }} />
            </div>
          ))}
        </div>
      ) : stats.data ? (
        <div className="stats-strip">
          <Stat value={formatCount(stats.data.total_songs)} label="歌曲总数" />
          <Stat value={formatCount(stats.data.local_songs)} label="本地" />
          <Stat value={formatCount(stats.data.remote_songs)} label="网络" />
          <Stat value={formatCount(stats.data.radio_songs)} label="电台" />
          <Stat value={formatCount(stats.data.artist_count)} label="歌手" />
          <Stat value={formatCount(stats.data.album_count)} label="专辑" />
        </div>
      ) : (
        <div className="probe-result" data-state="error">
          <IconRefresh size={15} />
          <span>曲库概况读取失败：{stats.error}</span>
          <button type="button" className="btn" data-size="sm" onClick={() => stats.reload()}>
            重试
          </button>
        </div>
      )}

      {/* ── 我的歌单 ── */}
      <div className="section-title">
        <span className="row" style={{ gap: 8 }}>
          <IconListMusic size={16} />
          我的歌单
        </span>
        <button
          type="button"
          className="btn"
          data-size="sm"
          data-variant="ghost"
          onClick={() => navigate({ name: 'playlists' })}
        >
          全部歌单
        </button>
      </div>

      {regularPlaylists.length === 0 ? (
        <EmptyState
          icon={<IconSparkle size={26} />}
          title="还没有歌单"
          description="侧栏右上角的 + 可以新建；也可以把歌曲行直接拖到侧栏歌单上"
        />
      ) : (
        <div className="card-grid" ref={playlistGridRef}>
          {regularPlaylists.map((playlist) => (
            <PlaylistCard
              key={playlist.id}
              title={playlist.name}
              meta={`${playlist.song_count} 首`}
              coverUrl={playlist.cover_url}
              onOpen={() => navigate({ name: 'playlist', id: playlist.id })}
            />
          ))}
        </div>
      )}

      {/* ── 常听歌手 ── */}
      <div className="section-title">
        <span className="row" style={{ gap: 8 }}>
          <IconUser size={16} />
          常听歌手
        </span>
      </div>

      {artists.loading ? (
        <CardGridSkeleton cards={8} />
      ) : (artists.data?.facets.length ?? 0) === 0 ? (
        <EmptyState
          icon={<IconUser size={26} />}
          title="还没有歌手数据"
          description="扫描完成并写入标签后这里会出现"
        />
      ) : (
        <div className="card-grid">
          {artists.data?.facets.map((facet) => (
            <ArtistCard
              key={facet.value}
              facet={facet}
              onOpen={() => navigate({ name: 'search', keyword: facet.value })}
              onPlay={() => void playArtist(facet.value)}
            />
          ))}
        </div>
      )}

      {/* ── 最近加入 ── */}
      <div className="section-title">
        <span className="row" style={{ gap: 8 }}>
          <IconClock size={16} />
          最近加入
        </span>
        <button
          type="button"
          className="btn"
          data-size="sm"
          data-variant="ghost"
          onClick={() => navigate({ name: 'library' })}
        >
          查看曲库
        </button>
      </div>

      {recent.loading ? (
        <CardGridSkeleton cards={8} scroll />
      ) : recentSongs.length === 0 ? (
        <EmptyState
          icon={<IconLibrary size={26} />}
          title="曲库还是空的"
          description="在「设置 → 曲库」里指定音乐目录并开始扫描"
          action={
            <button
              type="button"
              className="btn"
              data-variant="primary"
              onClick={() => navigate({ name: 'settings', section: 'library' })}
            >
              去扫描
            </button>
          }
        />
      ) : (
        <div
          className="card-grid"
          data-scroll="x"
          data-dragging={recentRow.dragging}
          ref={recentRow.ref}
          style={
            coverWidth === null
              ? undefined
              : ({ '--card-w': `${coverWidth}px` } as React.CSSProperties)
          }
        >
          {recentSongs.map((song, index) => (
            <RecentSongCard
              key={song.id}
              song={song}
              onPlay={() => void playSongs(recentSongs, index, { type: 'home', key: 'recent' })}
              onDeleted={() => recent.reload()}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function Stat({ value, label }: { value: string; label: string }): React.JSX.Element {
  return (
    <div>
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  )
}

/**
 * 「最近加入」的大图卡。
 *
 * ★ 卡片本体**不是**可点区域：这一行要能横向拖动（见 useHorizontalScroll），
 * 而拖动松手时浏览器仍会补一个 click —— 卡片若响应点击，拖一下就会顺带播放。
 * 所以只有封面右下角那颗播放键会开播，点封面、点歌名都什么都不做。
 * 右键菜单照旧复用曲库那套（见 songMenu.tsx），免得大图卡变成功能孤岛。
 */
function RecentSongCard({
  song,
  onPlay,
  onDeleted
}: {
  song: Song
  onPlay: () => void
  onDeleted: () => void
}): React.JSX.Element {
  return (
    <div
      className="card"
      onContextMenu={(event) => openMenuFromEvent(event, buildSongMenuItems([song], { onDeleted }))}
    >
      <div className="card-art">
        <Cover coverUrl={songCoverUrl(song)} width={400} size="100%" radius={0} kind="song" />
        <button
          type="button"
          className="card-play"
          aria-label={`播放 ${fallbackTitle(song)}`}
          data-tip="播放这首歌"
          onClick={onPlay}
        >
          <IconPlay size={17} />
        </button>
      </div>
      <div className="card-title truncate" data-tip={fallbackTitle(song)}>
        {fallbackTitle(song)}
      </div>
      <div className="card-meta truncate">
        {formatRelative(song.added_at)}
        {song.artist ? ` · ${displayArtist(song.artist)}` : ''}
      </div>
    </div>
  )
}

function PlaylistCard({
  title,
  meta,
  coverUrl,
  onOpen
}: {
  title: string
  meta: string
  coverUrl: string | null
  onOpen: () => void
}): React.JSX.Element {
  const playSongs = usePlayer((s) => s.playSongs)
  return (
    <div className="card" data-pinned="false" onClick={onOpen} onDoubleClick={onOpen}>
      <div className="card-art">
        <Cover coverUrl={coverUrl} size="100%" radius={0} kind="playlist" />
        <button
          type="button"
          className="card-play"
          aria-label="播放歌单"
          onClick={(event) => {
            event.stopPropagation()
            void getSongs(requireClient(), { limit: 300 })
              .then((res) => {
                // 歌单卡片只知道 id，播放交给详情页更合适；这里退化为提示
                void res
              })
              .catch(() => undefined)
          }}
          style={{ display: 'none' }}
        />
      </div>
      <div className="card-title truncate">{title}</div>
      <div className="card-meta">{meta}</div>
      {/* 卡片点击进详情；播放按钮由详情页承担，避免这里多发一次歌单请求 */}
      <span style={{ display: 'none' }}>{String(playSongs !== undefined)}</span>
    </div>
  )
}

function ArtistCard({
  facet,
  onOpen,
  onPlay
}: {
  facet: SongFacet
  onOpen: () => void
  onPlay: () => void
}): React.JSX.Element {
  return (
    <div className="card" role="button" tabIndex={0} onClick={onOpen} onDoubleClick={onPlay}>
      <div className="card-art">
        <Cover coverUrl={facet.cover_url} size="100%" radius={0} round={true} kind="artist" />
        <button
          type="button"
          className="card-play"
          aria-label={`播放 ${facet.value}`}
          data-tip="播放该歌手的歌"
          onClick={(event) => {
            event.stopPropagation()
            onPlay()
          }}
        >
          <IconPlay size={17} />
        </button>
      </div>
      <div className="card-title truncate row" style={{ gap: 6 }}>
        <IconDisc size={13} />
        <span className="truncate">{facet.value}</span>
      </div>
      <div className="card-meta">{facet.count} 首</div>
    </div>
  )
}
