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
import { usePlaylistSongs } from '@/hooks/usePlaylistSongs'
import { usePlayer } from '@/state/usePlayer'
import { FAVORITE_PLAYLIST_ID } from '@/state/usePlaylists'
import { useUi } from '@/state/useUi'

export function FavoritesPage(): React.JSX.Element {
  const navigate = useUi((s) => s.navigate)
  const playSongs = usePlayer((s) => s.playSongs)
  const [sort, setSort] = useState<SongSort | null>(null)
  const [selection, setSelection] = useState<number[]>([])
  const [selectAllIds, setSelectAllIds] = useState<number[] | null>(null)

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
    try {
      setSelectAllIds(await list.fetchAllIds())
      setSelection([])
    } catch {
      /* 错误已落在 list.error 上 */
    }
  }

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

      {/* 操作条不出现时（选中 0~1 首）「全选」一直在这儿，别让这一档成了死角 */}
      {list.songs.length > 0 && selection.length < 2 && !selectAllIds ? (
        <div className="load-more">
          <button
            type="button"
            className="btn"
            data-size="sm"
            data-variant="ghost"
            onClick={() => void handleSelectAll()}
          >
            全选（{list.total} 首）
          </button>
        </div>
      ) : null}

      {shouldShowSelectionBar(selectAllIds?.length ?? selection.length) ? (
        <SelectionBar
          ids={
            selectAllIds ??
            selection.map((i) => list.songs[i]?.id).filter((x): x is number => x != null)
          }
          songs={selectedSongs}
          /* 「全选」手上只有 id：播放 / 入队前先把整份列表补齐（见 SelectionBar） */
          loadSongs={list.fetchAll}
          selectAll={Boolean(selectAllIds)}
          selectAllTotal={selectAllIds?.length}
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
