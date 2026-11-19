/**
 * 搜索结果页。
 *
 * 关键词同时打三个接口：歌曲 / 歌单 / 分面（歌手+专辑）。原 Flutter 端只搜歌曲，
 * 于是「我记得有个叫 XX 的歌单」这种情况只能靠猜。
 *
 * 歌曲走分页列表（可能几百条命中），歌单与分面只取前几条做「相关结果」——
 * 页面上堆三张长列表只会让人不知道该看哪里。
 */

import { useEffect, useMemo, useState } from 'react'

import type { Song } from '@shared/types'
import { IconDisc, IconListMusic, IconPlay, IconSearch, IconUser } from '@/components/Icons'
import { CardGridSkeleton, Cover } from '@/components/primitives'
import { SelectionBar, shouldShowSelectionBar } from '@/components/SelectionBar'
import { LIBRARY_COLUMNS, SongTable, type SongSort } from '@/components/SongTable'
import { getFacets, getPlaylists } from '@/api/endpoints'
import { useAsync } from '@/hooks/useAsync'
import { usePageActive } from '@/hooks/usePageActive'
import { useSelectAllShortcut } from '@/hooks/useSelectAllShortcut'
import { useSongList } from '@/hooks/useSongList'
import { requireClient } from '@/state/useAuth'
import { usePlayer } from '@/state/usePlayer'
import { useUi } from '@/state/useUi'

export function SearchPage({ keyword }: { keyword: string }): React.JSX.Element {
  const navigate = useUi((s) => s.navigate)
  const playSongs = usePlayer((s) => s.playSongs)
  const [draft, setDraft] = useState(keyword)
  const [sort, setSort] = useState<SongSort | null>(null)
  const [selection, setSelection] = useState<number[]>([])
  const [selectAllIds, setSelectAllIds] = useState<number[] | null>(null)
  /** 这一页现在看不看得见：Ctrl+A 只在看得见的那一页生效（见 useSelectAllShortcut） */
  const pageActive = usePageActive()

  useEffect(() => setDraft(keyword), [keyword])
  // 换关键词时清掉上一次的选中态，否则会拿旧下标去索引新结果
  useEffect(() => {
    setSelection([])
    setSelectAllIds(null)
  }, [keyword])

  const query = useMemo(() => ({ keyword, sort: sort?.field, order: sort?.order }), [keyword, sort])
  const list = useSongList(query, 200)

  const playlists = useAsync(() => getPlaylists(requireClient(), { keyword, limit: 6 }), [keyword])
  const artistFacets = useAsync(
    () => getFacets(requireClient(), 'artist', { keyword, limit: 6, sort: 'count', order: 'desc' }),
    [keyword]
  )
  const albumFacets = useAsync(
    () => getFacets(requireClient(), 'album', { keyword, limit: 6, sort: 'count', order: 'desc' }),
    [keyword]
  )

  const selectedSongs = useMemo(
    () => selection.map((i) => list.songs[i]).filter((s): s is Song => Boolean(s)),
    [selection, list.songs]
  )

  /*
   * Ctrl/⌘+A 全选（见 hooks/useSelectAllShortcut）：整份在手就选行，还有没拉完的则先问一句，
   * 第二下才去后端要全部 id。`pageActive` 保证只有看得见的那一页响应（页面槽常驻）。
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
    onSelectAllIds: () => {
      // 乐观置位（空数组 = 全选已请求、id 在路上）：操作条必须立刻按全选口径行动，
      // 否则用户看到提示就点播放，会被当成行选中只播已加载的那部分（见 SelectionBar 文件头）
      setSelectAllIds([])
      void list
        .fetchAllIds()
        .then((ids) => {
          setSelectAllIds(ids)
          // 已经在手的那些行也标成选中（否则屏幕上一条高亮都没有，看着像没生效）
          setSelection(list.songs.map((_, index) => index))
        })
        .catch(() => {
          setSelectAllIds(null)
        })
    }
  })

  const matchedPlaylists = playlists.data?.playlists ?? []
  const matchedArtists = artistFacets.data?.facets ?? []
  const matchedAlbums = albumFacets.data?.facets ?? []
  const hasRelated =
    matchedPlaylists.length > 0 || matchedArtists.length > 0 || matchedAlbums.length > 0

  const submit = (event: React.FormEvent): void => {
    event.preventDefault()
    const next = draft.trim()
    if (next) navigate({ name: 'search', keyword: next })
  }

  return (
    <div className="page">
      <div className="page-header">
        <div style={{ minWidth: 0 }}>
          <h1 className="page-title">搜索</h1>
          <p className="page-subtitle">
            {list.loading && list.songs.length === 0
              ? `正在搜索「${keyword}」…`
              : `「${keyword}」命中 ${list.total} 首歌曲`}
          </p>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <form className="search-field" style={{ maxWidth: 320 }} onSubmit={submit}>
            <IconSearch size={15} />
            <input
              value={draft}
              placeholder="搜索歌曲、歌手、专辑"
              onChange={(event) => setDraft(event.target.value)}
            />
          </form>
          <button
            type="button"
            className="btn"
            data-variant="primary"
            disabled={list.songs.length === 0}
            onClick={() => void playSongs(list.songs, 0, { type: 'search', key: keyword })}
          >
            <IconPlay size={15} />
            播放结果
          </button>
        </div>
      </div>

      {/* ── 相关结果（歌单 / 歌手 / 专辑）── */}
      {hasRelated ? (
        <div style={{ marginBottom: 22 }}>
          {matchedPlaylists.length > 0 ? (
            <>
              <div className="section-title">
                <span className="row" style={{ gap: 8 }}>
                  <IconListMusic size={16} />
                  相关歌单
                </span>
              </div>
              <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
                {matchedPlaylists.map((playlist) => (
                  <button
                    key={playlist.id}
                    type="button"
                    className="chip"
                    style={{ height: 40, paddingRight: 14 }}
                    onClick={() => navigate({ name: 'playlist', id: playlist.id })}
                  >
                    <Cover
                      coverUrl={playlist.cover_url}
                      width={48}
                      size={26}
                      radius={6}
                      kind="playlist"
                    />
                    {playlist.name}
                    <span style={{ color: 'var(--text-4)', fontSize: 11.5 }}>
                      {playlist.song_count} 首
                    </span>
                  </button>
                ))}
              </div>
            </>
          ) : null}

          {matchedArtists.length > 0 ? (
            <>
              <div className="section-title">
                <span className="row" style={{ gap: 8 }}>
                  <IconUser size={16} />
                  相关歌手
                </span>
              </div>
              <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
                {matchedArtists.map((facet) => (
                  <button
                    key={facet.value}
                    type="button"
                    className="chip"
                    style={{ height: 40, paddingRight: 14 }}
                    onClick={() => navigate({ name: 'search', keyword: facet.value })}
                  >
                    <Cover
                      coverUrl={facet.cover_url}
                      width={48}
                      size={26}
                      radius={13}
                      kind="artist"
                    />
                    {facet.value}
                    <span style={{ color: 'var(--text-4)', fontSize: 11.5 }}>{facet.count} 首</span>
                  </button>
                ))}
              </div>
            </>
          ) : null}

          {matchedAlbums.length > 0 ? (
            <>
              <div className="section-title">
                <span className="row" style={{ gap: 8 }}>
                  <IconDisc size={16} />
                  相关专辑
                </span>
              </div>
              <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
                {matchedAlbums.map((facet) => (
                  <button
                    key={facet.value}
                    type="button"
                    className="chip"
                    style={{ height: 40, paddingRight: 14 }}
                    onClick={() => navigate({ name: 'search', keyword: facet.value })}
                  >
                    <Cover
                      coverUrl={facet.cover_url}
                      width={48}
                      size={26}
                      radius={6}
                      kind="playlist"
                    />
                    {facet.value}
                    <span style={{ color: 'var(--text-4)', fontSize: 11.5 }}>{facet.count} 首</span>
                  </button>
                ))}
              </div>
            </>
          ) : null}
        </div>
      ) : playlists.loading || artistFacets.loading ? (
        <CardGridSkeleton cards={6} />
      ) : null}

      {/* ── 歌曲结果 ── */}
      {list.error ? (
        <div className="probe-result" data-state="error" style={{ marginBottom: 14 }}>
          <span>{list.error}</span>
          <button type="button" className="btn" data-size="sm" onClick={() => list.refresh()}>
            重试
          </button>
        </div>
      ) : null}

      <SongTable
        songs={list.songs}
        columns={LIBRARY_COLUMNS}
        loading={list.loading}
        sort={sort}
        onSortChange={setSort}
        onPlayAt={(index) => void playSongs(list.songs, index, { type: 'search', key: keyword })}
        hasMore={list.hasMore}
        loadingMore={list.loadingMore}
        total={list.total}
        onLoadMore={list.loadMore}
        selection={selection}
        onSelectionChange={(indexes) => {
          setSelection(indexes)
          setSelectAllIds(null)
        }}
        menuOptions={{ onDeleted: (ids) => list.removeSongs(ids) }}
        emptyTitle={`没有找到「${keyword}」`}
        emptyDescription="试试更短的关键词，或者用 Ctrl+K 打开命令面板"
        emptyAction={<EmptyStateInline />}
      />

      {/* 表尾那颗「全选当前筛选（N 首）」已并入 Ctrl/⌘+A（见 hooks/useSelectAllShortcut） */}
      {/* 全选模式下（含 id 还没落地的哨兵窗口）按筛选总数判断，否则按选中行数 */}
      {shouldShowSelectionBar(selectAllIds ? list.total : selection.length) ? (
        <SelectionBar
          ids={
            selectAllIds ??
            selection.map((i) => list.songs[i]?.id).filter((x): x is number => x != null)
          }
          songs={selectedSongs}
          /* 「全选当前筛选」手上只有 id：播放 / 入队前先把整份列表补齐（见 SelectionBar） */
          loadSongs={list.fetchAll}
          selectAll={Boolean(selectAllIds)}
          selectAllTotal={list.total}
          onClear={() => {
            setSelection([])
            setSelectAllIds(null)
          }}
          onRemoved={(ids) => {
            list.removeSongs(ids)
            setSelection([])
            setSelectAllIds(null)
          }}
        />
      ) : null}
    </div>
  )
}

function EmptyStateInline(): React.JSX.Element {
  const setPaletteOpen = useUi((s) => s.setPaletteOpen)
  const navigate = useUi((s) => s.navigate)
  return (
    <div className="row" style={{ gap: 8 }}>
      <button type="button" className="btn" onClick={() => setPaletteOpen(true)}>
        <IconSearch size={15} />
        打开命令面板
      </button>
      <button
        type="button"
        className="btn"
        data-variant="primary"
        onClick={() => navigate({ name: 'library' })}
      >
        回到曲库
      </button>
    </div>
  )
}
