/**
 * 我喜欢的音乐。
 *
 * 就是内置歌单 1（后端约定），所以这一页直接复用歌单的加载与操作路径 ——
 * 不另造一套「收藏」数据结构，避免两处状态漂移。
 */

import { useMemo, useState } from 'react'

import type { Song } from '@shared/types'
import { IconHeart, IconPlay, IconRefresh, IconShuffle } from '@/components/Icons'
import { SelectionBar, shouldShowSelectionBar } from '@/components/SelectionBar'
import { PLAYLIST_COLUMNS, SongTable, type SongSort } from '@/components/SongTable'
import { usePageActive } from '@/hooks/usePageActive'
import { usePlaylistSongs } from '@/hooks/usePlaylistSongs'
import { useSelectAllShortcut } from '@/hooks/useSelectAllShortcut'
import { usePlayer } from '@/state/usePlayer'
import { FAVORITE_PLAYLIST_ID } from '@/state/usePlaylists'
import { useUi } from '@/state/useUi'

export function FavoritesPage(): React.JSX.Element {
  const navigate = useUi((s) => s.navigate)
  const playSongs = usePlayer((s) => s.playSongs)
  const [sort, setSort] = useState<SongSort | null>(null)
  const [selection, setSelection] = useState<number[]>([])
  const [selectAllIds, setSelectAllIds] = useState<number[] | null>(null)
  /** 这一页现在看不看得见：Ctrl+A 只在看得见的那一页生效（见 useSelectAllShortcut） */
  const pageActive = usePageActive()

  const list = usePlaylistSongs(FAVORITE_PLAYLIST_ID, {
    sort: sort?.field,
    order: sort?.order
  })

  const selectedSongs = useMemo(
    () => selection.map((i) => list.songs[i]).filter((s): s is Song => Boolean(s)),
    [selection, list.songs]
  )

  const clearSelection = (): void => {
    setSelection([])
    setSelectAllIds(null)
  }

  const handleSelectAll = async (): Promise<void> => {
    // 乐观置位（空数组 = 全选已请求、id 在路上）：操作条必须立刻按全选口径行动，
    // 否则用户看到提示就点播放，会被当成行选中只播已加载的那部分（见 SelectionBar 文件头）
    setSelectAllIds([])
    try {
      setSelectAllIds(await list.fetchAllIds())
      // 已经在手的那些行也标成选中：只设 id 账本的话，屏幕上一条高亮都没有
      setSelection(list.songs.map((_, index) => index))
    } catch {
      setSelectAllIds(null)
    }
  }

  /*
   * Ctrl/⌘+A 全选（见 hooks/useSelectAllShortcut）：整份在手就选行，还有没拉完的则先问一句，
   * 第二下才去后端要全部 id。
   */
  useSelectAllShortcut({
    active: pageActive,
    songs: list.songs,
    total: list.total,
    hasMore: list.hasMore,
    onSelectAllRows: () => {
      setSelection(list.songs.map((_, index) => index))
      setSelectAllIds(null)
    },
    onSelectAllIds: handleSelectAll
  })

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title row" style={{ gap: 10 }}>
            <IconHeart size={24} filled />
            我喜欢的音乐
          </h1>
          <p className="page-subtitle">
            {list.loading && list.songs.length === 0 ? '正在读取…' : `${list.total} 首`}
          </p>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <button type="button" className="btn" onClick={() => list.refresh()}>
            <IconRefresh size={15} />
            刷新
          </button>
          <button
            type="button"
            className="btn"
            disabled={list.songs.length === 0}
            data-tip="打乱顺序播放"
            onClick={() => {
              const shuffled = [...list.songs]
              for (let i = shuffled.length - 1; i > 0; i -= 1) {
                const j = Math.floor(Math.random() * (i + 1))
                ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
              }
              void playSongs(shuffled, 0, { type: 'playlist', key: String(FAVORITE_PLAYLIST_ID) })
            }}
          >
            <IconShuffle size={15} />
            随机
          </button>
          <button
            type="button"
            className="btn"
            data-variant="primary"
            disabled={list.songs.length === 0}
            onClick={() =>
              void playSongs(list.songs, 0, { type: 'playlist', key: String(FAVORITE_PLAYLIST_ID) })
            }
          >
            <IconPlay size={15} />
            播放全部
          </button>
        </div>
      </div>

      <SongTable
        songs={list.songs}
        columns={PLAYLIST_COLUMNS}
        loading={list.loading}
        sort={sort}
        onSortChange={setSort}
        onPlayAt={(index) =>
          void playSongs(list.songs, index, { type: 'playlist', key: String(FAVORITE_PLAYLIST_ID) })
        }
        hasMore={list.hasMore}
        loadingMore={list.loadingMore}
        total={list.total}
        onLoadMore={list.loadMore}
        selection={selection}
        onSelectionChange={(indexes) => {
          setSelection(indexes)
          setSelectAllIds(null)
        }}
        menuOptions={{
          playlistId: FAVORITE_PLAYLIST_ID,
          onRemoved: (ids) => list.removeSongs(ids)
        }}
        emptyTitle="还没有喜欢的歌"
        emptyDescription="在任意歌曲行右侧点心形图标，或在歌单里右键「收藏」"
        emptyAction={
          <button type="button" className="btn" onClick={() => navigate({ name: 'library' })}>
            去曲库逛逛
          </button>
        }
      />

      {/* 表尾那颗「全选（N 首）」已并入 Ctrl/⌘+A（见 hooks/useSelectAllShortcut） */}
      {/* 全选模式下（含 id 还没落地的哨兵窗口）按筛选总数判断，否则按选中行数 */}
      {shouldShowSelectionBar(selectAllIds ? list.total : selection.length) ? (
        <SelectionBar
          ids={
            selectAllIds ??
            selection.map((i) => list.songs[i]?.id).filter((x): x is number => x != null)
          }
          songs={selectedSongs}
          /* 「全选」手上只有 id：播放 / 入队前先把整份列表补齐（见 SelectionBar） */
          loadSongs={list.fetchAll}
          selectAll={Boolean(selectAllIds)}
          selectAllTotal={list.total}
          playlistId={FAVORITE_PLAYLIST_ID}
          onClear={clearSelection}
          onRemoved={(ids) => {
            list.removeSongs(ids)
            clearSelection()
          }}
        />
      ) : null}
    </div>
  )
}
