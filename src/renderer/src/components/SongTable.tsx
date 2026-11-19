/**
 * 歌曲表。
 *
 * 桌面端相对移动端最该做好的地方就是这张表，所以这里把原实现里散在各处的
 * 行内动作、排序、多选、拖拽集中在同一个组件里：
 *   * 表头可排序（点击循环 升序 → 降序 → 取消）
 *   * 行 hover 才出现的快捷动作（播放/收藏/更多），不占常驻视觉
 *   * 多选照 Windows 资源管理器的口径：Ctrl/Cmd 单击单独增减、Shift 单击按区间连选，
 *     配合侧栏批量操作
 *   * 行可直接拖到侧栏歌单（dataTransfer 带 `application/x-songloft-songs`）
 *   * 歌单上下文下支持拖拽重排（onReorder）
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { Song, SongSortField } from '@shared/types'
import { fallbackTitle, songCoverUrl } from '@shared/metadata'
import { openMenuFromEvent, type MenuItem } from './ContextMenu'
import { IconGrip, IconHeart, IconLoader, IconMore, IconPause, IconPlay } from './Icons'
import { Cover, EmptyState, InfiniteSentinel, SongRowsSkeleton } from './primitives'
import { buildSongMenuItems, type SongMenuOptions } from './songMenu'
import { usePageActive } from '@/hooks/usePageActive'
import { useRowWindow } from '@/hooks/useRowWindow'
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
  /**
   * 正在加载下一批（无限滚动／「播放全部」后台补列表都算）。
   *
   * 表尾会摆一行「正在加载更多歌曲…」：滚到底之后什么都不画的观感是「列表就这么多」，
   * 而实际上下一次分页正在路上 —— 那一行就是这两件事的区别。
   */
  loadingMore?: boolean
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
}

export function SongTable({
  songs,
  columns = LIBRARY_COLUMNS,
  onPlayAt,
  loading,
  onLoadMore,
  hasMore,
  loadingMore,
  sort,
  onSortChange,
  selection = [],
  onSelectionChange,
  menuOptions,
  onReorder,
  emptyTitle = '这里还没有歌曲',
  emptyDescription,
  emptyAction,
  extraMenuItems
}: SongTableProps): React.JSX.Element {
  const currentSongId = usePlayer((s) =>
    s.cursor >= 0 && s.cursor < s.order.length ? (s.queue[s.order[s.cursor]]?.id ?? null) : null
  )
  const playing = usePlayer((s) => s.playing)
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null)
  const dragSource = useRef<number | null>(null)
  const selectionSet = useMemo(() => new Set(selection), [selection])
  /** Shift 连选的锚点：上一次**不带 Shift** 的点击落点（见 handleRowClick 的说明） */
  const selectionAnchor = useRef<number | null>(null)
  /**
   * 只挂视口附近那几十行（见 hooks/useRowWindow）。
   *
   * ★ 它替掉了原先那个「最多渲染前 1200 行」的上限：那个上限到了 1200 之后就再也
   *   看不到后面的歌（数据还在加载，行却永远不挂出来），用户会以为加载停了。
   *   窗口化之后 DOM 一样有界，而**每一行都到得了**。
   * ★ 行下标仍然是**整份列表里的绝对下标**（窗口外的行也一样），所以选中、播放、
   *   拖拽重排、`data-song-index` 这些全都照旧。
   */
  const rowWindow = useRowWindow(songs.length)
  const tableRef = rowWindow.tableRef

  const gridTemplate = useMemo(() => columns.map((c) => c.width).join(' '), [columns])

  const cycleSort = (field: SongSortField): void => {
    if (!onSortChange) return
    if (sort?.field !== field) onSortChange({ field, order: 'asc' })
    else if (sort.order === 'asc') onSortChange({ field, order: 'desc' })
    else onSortChange(null)
  }

  /*
   * 行点击的选中语义，照 Windows 资源管理器：
   *   · 单击                → 只留这一行
   *   · Ctrl / Cmd 单击     → 单独增减这一行，其余不动
   *   · Shift 单击          → 从锚点到这一行整段替换选择
   *   · Ctrl + Shift 单击   → 把这一段叠到已有选择上，不丢掉原来选的那些
   *
   * ★ 锚点必须是「上一次不带 Shift 的点击」，不能拿选中集的末项顶替：按住 Shift 先点远处、
   *   再点近处时，末项口径会以第二次的落点为准把区间越收越小，而 Windows 里区间始终绕同一个
   *   锚点伸缩。所以它单独记在 ref 里；`onSelectionChange` 的第二个参数照旧把它报给父级 ——
   *   「谁选中的、从哪儿量起」属于这一层的事实，父级眼下用不上也不该让它猜。
   * ★ 锚点会过期，唯一的情形是列表变短到锚点那一行不再存在（删歌 / 换筛选）。这时当作没有
   *   锚点、退回单击语义，否则会拿一个越界下标铺出一条几千项的空区间。
   * ★ 结果一律按行号排好序：连点的先后不该决定「播放选中」放出来的顺序。
   */
  const handleRowClick = useCallback(
    (event: React.MouseEvent, index: number) => {
      if (!onSelectionChange) return
      const additive = event.ctrlKey || event.metaKey
      const raw = selectionAnchor.current
      const anchor = raw != null && raw >= 0 && raw < songs.length ? raw : null

      if (event.shiftKey && anchor !== null) {
        const [from, to] = anchor < index ? [anchor, index] : [index, anchor]
        const range: number[] = []
        for (let i = from; i <= to; i += 1) range.push(i)
        const next = additive
          ? Array.from(new Set([...selection, ...range])).sort((a, b) => a - b)
          : range
        // 锚点不动：接着按 Shift 点，区间还是在同一个锚点上伸缩
        onSelectionChange(next, anchor)
        return
      }

      if (additive) {
        const next = (
          selectionSet.has(index) ? selection.filter((i) => i !== index) : [...selection, index]
        ).sort((a, b) => a - b)
        selectionAnchor.current = index
        onSelectionChange(next, index)
        return
      }

      selectionAnchor.current = index
      onSelectionChange([index], index)
    },
    [onSelectionChange, selection, selectionSet, songs.length]
  )

  /** 这一帧真正挂出来的那一段（窗口外的行由上下两块等高空白代替，见 hooks/useRowWindow） */
  const visibleSongs = songs.slice(rowWindow.start, rowWindow.end)
  const topPad = rowWindow.start * rowWindow.rowHeight
  const bottomPad = Math.max(0, (songs.length - rowWindow.end) * rowWindow.rowHeight)

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
  /** 窗口化之后这里要调用它（centerRow 的 identity 跟着行高变） */
  const centerRow = rowWindow.centerRow
  useEffect(() => {
    if (!pageActive || currentIndex < 0) return
    const row = tableRef.current?.querySelector<HTMLElement>(`[data-song-index="${currentIndex}"]`)
    // 那一行可能还不在窗口里（窗口化之后这是常态）：按几何滚过去，下一帧它就会被挂出来
    if (row) scrollRowToCenterIfHidden(row)
    else centerRow(currentIndex)
  }, [pageActive, currentIndex, centerRow, tableRef])

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

      {/* 窗口上方的行：用一块等高空白顶住，滚动位置与滚动条长度都与「全部挂出来」时一致 */}
      {topPad > 0 ? <div style={{ height: topPad }} aria-hidden="true" /> : null}

      {visibleSongs.map((song, offset) => {
        // 行下标是**整份列表里的绝对下标**：选中、播放、拖拽、data-song-index 全靠它
        const index = rowWindow.start + offset
        return (
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
        )
      })}

      {/* 窗口下方的行：同一块等高空白（见 hooks/useRowWindow） */}
      {bottomPad > 0 ? <div style={{ height: bottomPad }} aria-hidden="true" /> : null}

      {/*
        表尾那一行「正在加载更多歌曲…」：无限滚动的反馈只有这一处（滚到底之后表格下方是
        空的，什么都不画就与「已经到底了」长得一模一样）。
        ★ 哨兵在加载期间 disabled：否则它会拿同一个 offset 再要一次（loadMore 自己也有闸，
          但那是一层兜底，不该让它靠「多半能挡住」来工作）。
      */}
      {loadingMore && hasMore ? (
        <div className="list-loading" role="status" aria-live="polite">
          <IconLoader size={14} className="spin" />
          <span>正在加载更多歌曲…</span>
        </div>
      ) : null}

      {hasMore && onLoadMore ? (
        <InfiniteSentinel onVisible={onLoadMore} disabled={!hasMore || loadingMore} />
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
