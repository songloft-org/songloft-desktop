/**
 * 歌曲表。
 *
 * 桌面端相对移动端最该做好的地方就是这张表，所以这里把原实现里散在各处的
 * 行内动作、排序、多选、拖拽集中在同一个组件里：
 *   * 表头可排序（点击循环 升序 → 降序 → 取消）
 *   * 行 hover 才出现的快捷动作（播放/收藏/更多），不占常驻视觉
 *   * Ctrl/Cmd 点选、Shift 连选，配合侧栏批量操作
 *   * 行可直接拖到侧栏歌单（dataTransfer 带 `application/x-songloft-songs`）
 *   * 歌单上下文下支持拖拽重排（onReorder）
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { Song, SongSortField } from '@shared/types'
import { fallbackTitle, songCoverUrl } from '@shared/metadata'
import { openMenuFromEvent, type MenuItem } from './ContextMenu'
import { IconGrip, IconHeart, IconMore, IconPause, IconPlay } from './Icons'
import { Cover, EmptyState, InfiniteSentinel, SongRowsSkeleton } from './primitives'
import { buildSongMenuItems, type SongMenuOptions } from './songMenu'
import { usePageActive } from '@/hooks/usePageActive'
import { SONGS_DRAG_TYPE } from '@/lib/dnd'
import { displayAlbum, displayArtist, formatDuration, formatRelative } from '@/lib/format'
import { scrollRowToCenterIfHidden } from '@/lib/scroll'
import { usePlayer } from '@/state/usePlayer'
import { usePlaylists } from '@/state/usePlaylists'

export interface SongColumn {
  /**
   * 单元格种类。注意这里**没有**列表格线的语义，只有「渲染哪种 cell」：
   * 'index' 渲染序号+播放按钮，'actions' 渲染行尾的收藏/更多按钮。
   * 早期把 actions 也写成 key:'index' 会导致 grid 轨道数对不上（表头 7 列、行却多出一列），
   * 所以单列一个 'actions'。
   */
  key: 'index' | 'title' | 'artist' | 'album' | 'added' | 'duration' | 'actions'
  label?: string
  /** grid track 宽度 */
  width: string
  sortField?: SongSortField
  align?: 'left' | 'right'
}

const DURATION: SongColumn = {
  key: 'duration',
  label: '时长',
  width: '72px',
  sortField: 'duration',
  align: 'right'
}
const ACTIONS: SongColumn = { key: 'actions', width: '84px' }
const INDEX: SongColumn = { key: 'index', label: '#', width: '38px' }
const TITLE: SongColumn = {
  key: 'title',
  label: '标题',
  width: 'minmax(180px, 2.6fr)',
  sortField: 'title'
}
const ARTIST: SongColumn = {
  key: 'artist',
  label: '歌手',
  width: 'minmax(110px, 1.4fr)',
  sortField: 'artist'
}
const ALBUM: SongColumn = {
  key: 'album',
  label: '专辑',
  width: 'minmax(110px, 1.4fr)',
  sortField: 'album'
}
const ADDED: SongColumn = { key: 'added', label: '加入时间', width: '104px', sortField: 'added_at' }

export const LIBRARY_COLUMNS: SongColumn[] = [INDEX, TITLE, ARTIST, ALBUM, ADDED, DURATION, ACTIONS]
export const PLAYLIST_COLUMNS: SongColumn[] = [INDEX, TITLE, ARTIST, ALBUM, DURATION, ACTIONS]
export const COMPACT_COLUMNS: SongColumn[] = [INDEX, TITLE, ARTIST, DURATION, ACTIONS]

export interface SongSort {
  field: SongSortField
  order: 'asc' | 'desc'
}

export interface SongTableProps {
  songs: Song[]
  columns?: SongColumn[]
  /** 双击/点行内播放按钮时回调，参数是 songs 里的下标 */
  onPlayAt: (index: number) => void
  loading?: boolean
  /** 还有更多可加载时渲染无限滚动哨兵 */
  onLoadMore?: () => void
  hasMore?: boolean
  sort?: SongSort | null
  onSortChange?: (sort: SongSort | null) => void
  /** 受控多选（下标） */
  selection?: number[]
  onSelectionChange?: (indexes: number[], anchor: number | null) => void
  menuOptions?: SongMenuOptions
  /** 提供时启用拖拽重排 */
  onReorder?: (from: number, to: number) => void
  /** 空态文案 */
  emptyTitle?: string
  emptyDescription?: string
  emptyAction?: React.ReactNode
  /** 额外的行右键项（追加在标准项之后） */
  extraMenuItems?: (song: Song) => MenuItem[]
  /** 虚拟化的行数上限提示：超过这个数只渲染前 N 行（避免一次性挂上万节点） */
  maxRendered?: number
}

export function SongTable({
  songs,
  columns = LIBRARY_COLUMNS,
  onPlayAt,
  loading,
  onLoadMore,
  hasMore,
  sort,
  onSortChange,
  selection = [],
  onSelectionChange,
  menuOptions,
  onReorder,
  emptyTitle = '这里还没有歌曲',
  emptyDescription,
  emptyAction,
  extraMenuItems,
  maxRendered = 1200
}: SongTableProps): React.JSX.Element {
  const currentSongId = usePlayer((s) =>
    s.cursor >= 0 && s.cursor < s.order.length ? (s.queue[s.order[s.cursor]]?.id ?? null) : null
  )
  const playing = usePlayer((s) => s.playing)
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null)
  const dragSource = useRef<number | null>(null)
  const selectionSet = useMemo(() => new Set(selection), [selection])

  const gridTemplate = useMemo(() => columns.map((c) => c.width).join(' '), [columns])

  const cycleSort = (field: SongSortField): void => {
    if (!onSortChange) return
    if (sort?.field !== field) onSortChange({ field, order: 'asc' })
    else if (sort.order === 'asc') onSortChange({ field, order: 'desc' })
    else onSortChange(null)
  }

  const handleRowClick = useCallback(
    (event: React.MouseEvent, index: number) => {
      if (!onSelectionChange) return
      const additive = event.ctrlKey || event.metaKey
      const ranged = event.shiftKey
      if (ranged && selection.length > 0) {
        const anchor = selection[selection.length - 1]
        const [from, to] = anchor < index ? [anchor, index] : [index, anchor]
        const next: number[] = []
        for (let i = from; i <= to; i += 1) next.push(i)
        onSelectionChange(next, index)
        return
      }
      if (additive) {
        const next = selectionSet.has(index)
          ? selection.filter((i) => i !== index)
          : [...selection, index]
        onSelectionChange(next, index)
        return
      }
      onSelectionChange([index], index)
    },
    [onSelectionChange, selection, selectionSet]
  )

  const visibleSongs = songs.length > maxRendered ? songs.slice(0, maxRendered) : songs

  /*
   * 当前曲在这份列表里的下标；不在列表里就是 -1。
   *
   * 三种「不在」共用一个 -1，因为它们该做的事完全一样 —— 什么都不做：
   *   · 列表为空（歌单空 / 还在加载）；
   *   · 播的是别处来的歌（播放源不是这张列表）；
   *   · 歌已经被移出这张列表（右键「从歌单移除」/ 服务端刷新掉了）。
   * 此时既不滚、也不高亮任何一行，界面回到「这一页只是一份列表」的状态。
   *
   * ★ 用 id 找而不是拿播放队列的下标去对：队列顺序（含随机）与列表顺序是两回事，
   *   同一首歌在一张歌单里还可能出现两次 —— 那种情况下定位到**第一个**出现的位置。
   */
  const currentIndex = useMemo(
    () => (currentSongId == null ? -1 : songs.findIndex((s) => s.id === currentSongId)),
    [songs, currentSongId]
  )

  /*
   * 当前曲**看不见**的时候，把它摆到列表中间。
   *
   * ★ 「看不见才动」是这条规则的要点：切走再切回来时，这一页的滚动位置本来就还在
   *   （页面槽常驻，见 App 的 PageSlot）；当前曲还在那一屏里，就一个字都别改 ——
   *   用户回来看的正是他离开时那一屏。反过来，每切回来一次都重新居中，等于把他翻到
   *   的那一段扔掉。
   * ★ 要动的时候是**居中**，不是「推回边缘」：贴着上/下边缘的那一下同样像跳，而且
   *   刚被推到边缘的那一行，上下文只剩一半。
   * ★ 为什么不是只在挂载时跑一次：页面不会重新挂载（页面槽常驻），所以靠 `pageActive`
   *   （这一页现在看不看得见）与 `currentIndex`（换曲）驱动。
   * ★ 依赖里**没有** songs 本身：列表内容变了但当前曲的相对位置没变时（在歌单内筛选、
   *   搜索框改一个字母）不该再滚一次 —— 那会把用户刚看上的一屏又拽走。
   * ★ 首尾的夹取在 lib/scroll.ts 里：滚到 0 或滚到底就停，不会为了「居中」拉出空白。
   */
  const pageActive = usePageActive()
  const tableRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!pageActive || currentIndex < 0) return
    // 排在 maxRendered 之后的行根本不渲染（列表底部那条提示就是这么说的），找不到就什么都不做
    const row = tableRef.current?.querySelector<HTMLElement>(`[data-song-index="${currentIndex}"]`)
    scrollRowToCenterIfHidden(row ?? null)
  }, [pageActive, currentIndex])

  if (loading && songs.length === 0) {
    return (
      <div className="song-table">
        <div className="song-head" style={{ gridTemplateColumns: gridTemplate }}>
          {columns.map((column, i) => (
            <div key={`${column.key}-${i}`} style={{ textAlign: column.align ?? 'left' }}>
              {column.label ?? ''}
            </div>
          ))}
        </div>
        <SongRowsSkeleton rows={14} columns={columns.length} />
      </div>
    )
  }

  if (!loading && songs.length === 0) {
    return <EmptyState title={emptyTitle} description={emptyDescription} action={emptyAction} />
  }

  return (
    <div className="song-table" ref={tableRef}>
      <div className="song-head" style={{ gridTemplateColumns: gridTemplate }}>
        {columns.map((column, i) => {
          const sortable = Boolean(column.sortField && onSortChange)
          const active = Boolean(column.sortField && sort?.field === column.sortField)
          return (
            <div key={`${column.key}-${i}`} style={{ textAlign: column.align ?? 'left' }}>
              {sortable ? (
                <button
                  type="button"
                  data-active={active}
                  onClick={() => cycleSort(column.sortField!)}
                  data-tip={`按${column.label ?? ''}排序`}
                >
                  {column.label}
                  {active ? <span>{sort?.order === 'asc' ? '↑' : '↓'}</span> : null}
                </button>
              ) : (
                (column.label ?? '')
              )}
            </div>
          )
        })}
      </div>

      {visibleSongs.map((song, index) => (
        <SongRow
          key={`${song.id}-${index}`}
          song={song}
          index={index}
          gridTemplate={gridTemplate}
          columns={columns}
          current={song.id === currentSongId}
          playing={playing}
          selected={selectionSet.has(index)}
          onPlay={() => onPlayAt(index)}
          onClick={(event) => handleRowClick(event, index)}
          onContextMenu={(event) =>
            openMenuFromEvent(event, [
              ...buildSongMenuItems(
                selectionSet.has(index) && selection.length > 1
                  ? selection.map((i) => songs[i]).filter(Boolean)
                  : [song],
                menuOptions
              ),
              ...(extraMenuItems?.(song) ?? [])
            ])
          }
          onMoreClick={(event) => {
            // 多选状态下对任一选中行点「更多」，操作的是整批
            const targets =
              selectionSet.has(index) && selection.length > 1
                ? selection.map((i) => songs[i]).filter(Boolean)
                : [song]
            openMenuFromEvent(event, buildSongMenuItems(targets, menuOptions))
          }}
          reorderable={Boolean(onReorder)}
          dropBefore={dragOverIndex === index}
          onDragStart={() => {
            dragSource.current = index
          }}
          onDragOver={(event) => {
            if (!onReorder || dragSource.current === null) return
            event.preventDefault()
            setDragOverIndex(index)
          }}
          onDrop={() => {
            if (onReorder && dragSource.current !== null && dragSource.current !== index) {
              onReorder(dragSource.current, index)
            }
            dragSource.current = null
            setDragOverIndex(null)
          }}
          onDragEnd={() => {
            dragSource.current = null
            setDragOverIndex(null)
          }}
        />
      ))}

      {songs.length > maxRendered ? (
        <div style={{ padding: '16px 14px', fontSize: 12.5, color: 'var(--text-4)' }}>
          已渲染前 {maxRendered} 首，继续滚动或缩小筛选范围以查看其余 {songs.length - maxRendered}{' '}
          首
        </div>
      ) : null}

      {hasMore && onLoadMore ? (
        <InfiniteSentinel onVisible={onLoadMore} disabled={!hasMore} />
      ) : null}
    </div>
  )
}

/* ─────────────────────────────── 单行 ─────────────────────────────── */

interface SongRowProps {
  song: Song
  index: number
  gridTemplate: string
  columns: SongColumn[]
  current: boolean
  playing: boolean
  selected: boolean
  onPlay: () => void
  onClick: (event: React.MouseEvent) => void
  onContextMenu: (event: React.MouseEvent) => void
  onMoreClick: (event: React.MouseEvent) => void
  reorderable: boolean
  dropBefore: boolean
  onDragStart: () => void
  onDragOver: (event: React.DragEvent) => void
  onDrop: () => void
  onDragEnd: () => void
}

function SongRow({
  song,
  index,
  gridTemplate,
  columns,
  current,
  playing,
  selected,
  onPlay,
  onClick,
  onContextMenu,
  onMoreClick,
  reorderable,
  dropBefore,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd
}: SongRowProps): React.JSX.Element {
  const favoriteIds = usePlaylists((s) => s.favoriteIds)
  const toggleFavorite = usePlaylists((s) => s.toggleFavorite)
  const favorited = favoriteIds.has(song.id)
  const togglePlay = usePlayer((s) => s.toggle)

  const renderCell = (column: SongColumn): React.ReactNode => {
    switch (column.key) {
      case 'index':
        return (
          <div className="song-index">
            <span className="song-index-num">{index + 1}</span>
            <button
              type="button"
              className="song-index-play"
              aria-label={current && playing ? '暂停' : '播放'}
              onClick={(event) => {
                event.stopPropagation()
                // 当前曲这一格画的就是播放/暂停（见 aria-label）：点它必须是暂停/继续，
                // 而不是「从头再放一遍」。别的行仍然是「从这首开始播」。
                if (current) void togglePlay()
                else onPlay()
              }}
            >
              {current && playing ? <IconPause size={13} /> : <IconPlay size={13} />}
            </button>
          </div>
        )
      case 'title':
        return (
          <div className="row" style={{ minWidth: 0 }}>
            <Cover coverUrl={songCoverUrl(song)} width={88} size={34} radius={7} kind="song" />
            <div style={{ minWidth: 0 }}>
              <div className="song-title truncate">{fallbackTitle(song)}</div>
            </div>
          </div>
        )
      case 'artist':
        return <div className="song-cell truncate">{displayArtist(song.artist)}</div>
      case 'album':
        return <div className="song-cell truncate">{displayAlbum(song.album)}</div>
      case 'added':
        return (
          <div className="song-cell truncate" style={{ fontSize: 12 }}>
            {formatRelative(song.added_at)}
          </div>
        )
      case 'duration':
        return (
          <div className="song-duration">
            {song.is_live ? 'LIVE' : formatDuration(song.duration)}
          </div>
        )
      default:
        return null
    }
  }

  /*
   * data-song-index：当前曲定位靠它找行（见 SongTable 里那段 effect）。用**行下标**而
   * 不是歌 id —— 同一首歌在一张歌单里出现两次时，id 认不出是哪一行。
   */
  return (
    <div
      className="song-row"
      style={{ gridTemplateColumns: gridTemplate }}
      data-song-index={index}
      data-current={current}
      data-selected={selected}
      data-drop-before={dropBefore}
      draggable={reorderable}
      onClick={onClick}
      onDoubleClick={onPlay}
      onContextMenu={onContextMenu}
      onDragStart={(event) => {
        // 给侧栏歌单用的负载：拖到歌单上就能加进去
        event.dataTransfer.setData(SONGS_DRAG_TYPE, JSON.stringify([song.id]))
        event.dataTransfer.effectAllowed = 'copyMove'
        onDragStart()
      }}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
    >
      {columns.map((column, i) =>
        column.key === 'actions' ? (
          <div key="actions" className="song-actions" style={{ justifyContent: 'flex-end' }}>
            {reorderable ? (
              <span className="queue-drag" data-tip="拖动调整顺序" style={{ width: 24 }}>
                <IconGrip size={14} />
              </span>
            ) : null}
            <button
              type="button"
              className="icon-btn"
              data-active={favorited}
              aria-label={favorited ? '取消收藏' : '收藏'}
              data-tip={favorited ? '取消收藏' : '收藏'}
              onClick={(event) => {
                event.stopPropagation()
                void toggleFavorite(song)
              }}
            >
              <IconHeart size={15} filled={favorited} />
            </button>
            <button
              type="button"
              className="icon-btn"
              aria-label="更多操作"
              data-tip="更多操作"
              onClick={(event) => {
                event.stopPropagation()
                onMoreClick(event)
              }}
            >
              <IconMore size={15} />
            </button>
          </div>
        ) : (
          <div
            key={`${column.key}-${i}`}
            style={{ minWidth: 0, textAlign: column.align ?? 'left' }}
          >
            {renderCell(column)}
          </div>
        )
      )}
    </div>
  )
}
