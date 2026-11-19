/**
 * 歌单详情。
 *
 * 这一页承担了「歌单」这个概念的绝大部分操作，所以按重要性排布：
 *   1. 一键播放 / 随机 / 继续播放 —— 进详情页最想干的事
 *   2. 歌曲表：手动拖拽排序（仅「自定义顺序」下可用，因为服务端排序下拖拽没有意义）
 *   3. 排序与维护：视图排序（临时、可持久化偏好）+ 服务端永久排序
 *
 * ★ 拖拽排序为什么限定条件：`reorderPlaylistSongs` 写的是 `position` 列。
 *   如果当前视图是按标题排序，用户看到的顺序和 position 没关系，
 *   拖出来的结果会「看起来没生效」。所以只在 sort=position 时开放拖拽，
 *   并在界面上说清原因，而不是默默接受一次会丢的拖拽。
 */

import { useCallback, useEffect, useMemo, useState } from 'react'

import type { Playlist } from '@shared/types'
import {
  IconCheck,
  IconEyeOff,
  IconGrip,
  IconHeart,
  IconListMusic,
  IconPin,
  IconPlay,
  IconRefresh,
  IconShuffle,
  IconTrash,
  IconUpload
} from '@/components/Icons'
import { Cover, EmptyState } from '@/components/primitives'
import { Modal } from '@/components/Modal'
import { SelectionBar, shouldShowSelectionBar } from '@/components/SelectionBar'
import { PLAYLIST_COLUMNS, SongTable } from '@/components/SongTable'
import {
  getPlaylist,
  reorderPlaylistSongs,
  sortPlaylistSongs,
  updatePlaylistSort
} from '@/api/endpoints'
import { useAsync } from '@/hooks/useAsync'
import { usePageActive } from '@/hooks/usePageActive'
import { usePlaylistSongs } from '@/hooks/usePlaylistSongs'
import { useSelectAllShortcut } from '@/hooks/useSelectAllShortcut'
import { formatDuration } from '@/lib/format'
import { requireClient } from '@/state/useAuth'
import { usePlayer } from '@/state/usePlayer'
import { FAVORITE_PLAYLIST_ID, usePlaylists } from '@/state/usePlaylists'
import { useUi } from '@/state/useUi'
import { toast } from '@/state/useToasts'

type ViewSort =
  'position' | 'added_at' | 'file_modified_at' | 'title' | 'artist' | 'duration' | 'file_size'

const VIEW_SORTS: { value: ViewSort; label: string; defaultOrder: 'asc' | 'desc' }[] = [
  { value: 'position', label: '自定义顺序', defaultOrder: 'asc' },
  { value: 'added_at', label: '最近加入', defaultOrder: 'desc' },
  { value: 'file_modified_at', label: '文件时间', defaultOrder: 'desc' },
  { value: 'title', label: '标题', defaultOrder: 'asc' },
  { value: 'artist', label: '歌手', defaultOrder: 'asc' },
  { value: 'duration', label: '时长', defaultOrder: 'asc' },
  { value: 'file_size', label: '文件大小', defaultOrder: 'desc' }
]

const PERMANENT_SORTS: { action: string; label: string }[] = [
  { action: 'name_asc', label: '永久按文件名 A→Z' },
  { action: 'name_desc', label: '永久按文件名 Z→A' },
  { action: 'number_prefix', label: '永久按文件名编号' },
  { action: 'shuffle', label: '永久打乱顺序' }
]

export function PlaylistDetailPage({ playlistId }: { playlistId: number }): React.JSX.Element {
  const navigate = useUi((s) => s.navigate)
  const playSongs = usePlayer((s) => s.playSongs)
  const playlistsStore = usePlaylists()

  const [sort, setSort] = useState<ViewSort>('position')
  const [order, setOrder] = useState<'asc' | 'desc'>('asc')
  const [keyword, setKeyword] = useState('')
  const [selection, setSelection] = useState<number[]>([])
  const [selectAllIds, setSelectAllIds] = useState<number[] | null>(null)
  /** 这一页现在看不看得见：Ctrl+A 只在看得见的那一页生效（见 useSelectAllShortcut） */
  const pageActive = usePageActive()
  const [editing, setEditing] = useState(false)
  const [editName, setEditName] = useState('')
  const [editDesc, setEditDesc] = useState('')
  const [localMeta, setLocalMeta] = useState<Playlist | null>(null)

  const metaResult = useAsync(() => getPlaylist(requireClient(), playlistId), [playlistId])
  const list = usePlaylistSongs(playlistId, { sort, order, keyword })

  const meta = localMeta ?? metaResult.data

  // 后端持久化的排序偏好：首次加载时套用，省掉每次进歌单都要重选一次
  useEffect(() => {
    if (!metaResult.data || localMeta) return
    const saved = metaResult.data.sort_by as ViewSort
    if (VIEW_SORTS.some((v) => v.value === saved)) {
      setSort(saved)
      setOrder(metaResult.data.sort_order === 'desc' ? 'desc' : 'asc')
    }
  }, [metaResult.data, localMeta])

  const isFavorite = playlistId === FAVORITE_PLAYLIST_ID
  const canReorder =
    sort === 'position' && !keyword && list.songs.length === list.total && list.total > 1

  const selectedSongs = useMemo(
    () => selection.map((i) => list.songs[i]).filter((s): s is NonNullable<typeof s> => Boolean(s)),
    [selection, list.songs]
  )

  const totalDuration = useMemo(
    () => list.songs.reduce((sum, song) => sum + (song.duration || 0), 0),
    [list.songs]
  )

  const clearSelection = useCallback(() => {
    setSelection([])
    setSelectAllIds(null)
  }, [])

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
    onSelectAllIds: () => {
      void list
        .fetchAllIds()
        .then((ids) => {
          setSelectAllIds(ids)
          // 已经在手的那些行也标成选中（否则屏幕上一条高亮都没有，看着像没生效）
          setSelection(list.songs.map((_, index) => index))
        })
        .catch(() => undefined)
    }
  })

  const applySort = useCallback(
    (next: ViewSort) => {
      const preset = VIEW_SORTS.find((v) => v.value === next)
      if (!preset) return
      const nextOrder = sort === next ? (order === 'asc' ? 'desc' : 'asc') : preset.defaultOrder
      setSort(next)
      setOrder(nextOrder)
      clearSelection()
      // 记住偏好；失败也不影响本次浏览
      void updatePlaylistSort(requireClient(), playlistId, next, nextOrder).catch(() => undefined)
    },
    [sort, order, playlistId, clearSelection]
  )

  const handleReorder = useCallback(
    (from: number, to: number) => {
      if (!canReorder) return
      const next = [...list.songs]
      const [moved] = next.splice(from, 1)
      next.splice(to, 0, moved)
      // 先本地生效，再落服务端：拖完立刻看到结果，网络慢也不会「弹回去」
      list.setSongs(next)
      void reorderPlaylistSongs(
        requireClient(),
        playlistId,
        next.map((s) => s.id)
      ).catch((error) => {
        toast('顺序保存失败，已恢复', 'error', error instanceof Error ? error.message : undefined)
        list.refresh()
      })
    },
    [canReorder, list, playlistId]
  )

  const permanentSort = useCallback(
    async (action: string, label: string) => {
      try {
        await sortPlaylistSongs(requireClient(), playlistId, action)
        setSort('position')
        setOrder('asc')
        list.refresh()
        toast(label.replace('永久', '已') + '完成', 'success')
      } catch (error) {
        toast('排序失败', 'error', error instanceof Error ? error.message : undefined)
      }
    },
    [list, playlistId]
  )

  if (metaResult.error) {
    return (
      <div className="page">
        <EmptyState
          icon={<IconListMusic size={26} />}
          title="歌单打不开"
          description={metaResult.error}
          action={
            <div className="row" style={{ gap: 8 }}>
              <button type="button" className="btn" onClick={() => metaResult.reload()}>
                重试
              </button>
              <button type="button" className="btn" onClick={() => navigate({ name: 'playlists' })}>
                返回歌单列表
              </button>
            </div>
          }
        />
      </div>
    )
  }

  return (
    <div className="page">
      {/* ── Hero ── */}
      <div className="detail-hero">
        <div className="detail-hero-art" style={{ position: 'relative' }}>
          <Cover coverUrl={meta?.cover_url} width={640} size="100%" radius={0} kind="playlist" />
          <button
            type="button"
            className="btn"
            data-size="sm"
            style={{ position: 'absolute', right: 10, bottom: 10 }}
            data-tip="上传本地图片作为封面（≤8MB）"
            onClick={() => pickCover(playlistId)}
          >
            <IconUpload size={14} />
            换封面
          </button>
        </div>

        <div className="detail-hero-body grow">
          <div className="detail-kind">
            {meta?.type === 'radio' ? '电台歌单' : isFavorite ? '我喜欢的音乐' : '歌单'}
            {meta?.labels.includes('built_in') ? ' · 内置' : ''}
          </div>
          <h1 className="detail-name">{meta?.name ?? '…'}</h1>
          <div className="detail-meta">
            <span>{list.total} 首</span>
            {list.songs.length > 0 ? <span>· {formatDuration(totalDuration)}</span> : null}
            {meta?.pinned_at ? (
              <span className="badge" data-tone="accent">
                已置顶
              </span>
            ) : null}
            {meta && meta.remote_count > 0 ? (
              <span className="badge">含网络歌曲 {meta.remote_count}</span>
            ) : null}
          </div>
          {meta?.description ? <div className="detail-desc">{meta.description}</div> : null}

          <div className="row" style={{ marginTop: 18, gap: 8, flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn"
              data-variant="primary"
              disabled={list.songs.length === 0}
              onClick={() =>
                void playSongs(list.songs, 0, { type: 'playlist', key: String(playlistId) })
              }
            >
              <IconPlay size={15} />
              播放全部
            </button>
            <button
              type="button"
              className="btn"
              disabled={list.songs.length === 0}
              onClick={() => {
                const shuffled = [...list.songs]
                for (let i = shuffled.length - 1; i > 0; i -= 1) {
                  const j = Math.floor(Math.random() * (i + 1))
                  ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
                }
                void playSongs(shuffled, 0, { type: 'playlist', key: String(playlistId) })
              }}
            >
              <IconShuffle size={15} />
              随机
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => void list.refresh()}
              data-tip="重新拉取歌单内容"
            >
              <IconRefresh size={15} />
              刷新
            </button>

            {!isFavorite ? (
              <>
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    setEditName(meta?.name ?? '')
                    setEditDesc(meta?.description ?? '')
                    setEditing(true)
                  }}
                >
                  编辑信息
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    void playlistsStore.setPinned(playlistId, !meta?.pinned_at).then(() => {
                      setLocalMeta((prev) =>
                        prev
                          ? { ...prev, pinned_at: prev.pinned_at ? null : new Date().toISOString() }
                          : prev
                      )
                    })
                  }}
                  data-tip={meta?.pinned_at ? '取消置顶' : '置顶到歌单列表最前'}
                >
                  <IconPin size={15} />
                  {meta?.pinned_at ? '取消置顶' : '置顶'}
                </button>
                <button
                  type="button"
                  className="btn"
                  data-variant="danger"
                  onClick={() => {
                    if (
                      !window.confirm(
                        `确定删除歌单「${meta?.name ?? ''}」？只删歌单，不动歌曲文件。`
                      )
                    )
                      return
                    void playlistsStore
                      .remove(playlistId, false)
                      .then(() => navigate({ name: 'playlists' }))
                  }}
                >
                  <IconTrash size={15} />
                  删除歌单
                </button>
              </>
            ) : (
              <span className="badge">
                <IconHeart size={12} filled />
                收藏歌单不能删除或改封面
              </span>
            )}

            <button
              type="button"
              className="btn"
              data-tip="隐藏后不出现在歌单列表里（可用「显示隐藏的歌单」找回）"
              onClick={() => void playlistsStore.setHidden(playlistId, true)}
            >
              <IconEyeOff size={15} />
              隐藏
            </button>
          </div>
        </div>
      </div>

      {/* ── 排序 / 搜索 ── */}
      <div className="row-between" style={{ gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <select
            className="input"
            style={{ width: 170, height: 32, fontSize: 12.5 }}
            value={sort}
            onChange={(event) => {
              const next = event.target.value as ViewSort
              const preset = VIEW_SORTS.find((v) => v.value === next)
              setSort(next)
              setOrder(preset?.defaultOrder ?? 'asc')
              clearSelection()
              void updatePlaylistSort(
                requireClient(),
                playlistId,
                next,
                preset?.defaultOrder ?? 'asc'
              ).catch(() => undefined)
            }}
            data-tip="视图排序（不改动歌单本身）"
          >
            {VIEW_SORTS.map((v) => (
              <option key={v.value} value={v.value}>
                {v.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn"
            data-size="sm"
            onClick={() => applySort(sort)}
            data-tip="点击在升序/降序之间切换"
          >
            {order === 'asc' ? '升序 ↑' : '降序 ↓'}
          </button>
          <span className="badge" data-tone={canReorder ? 'accent' : 'default'}>
            <IconGrip size={12} />
            {canReorder
              ? '可拖动排序'
              : sort === 'position'
                ? '加载全部后可拖动'
                : '切到「自定义顺序」才能拖动'}
          </span>
        </div>

        <div className="row" style={{ gap: 8 }}>
          <div className="search-field" style={{ maxWidth: 220 }}>
            <input
              value={keyword}
              placeholder="在歌单内筛选"
              onChange={(event) => setKeyword(event.target.value)}
            />
          </div>
          <select
            className="input"
            style={{ width: 168, height: 32, fontSize: 12.5 }}
            value=""
            onChange={(event) => {
              const preset = PERMANENT_SORTS.find((p) => p.action === event.target.value)
              if (preset) void permanentSort(preset.action, preset.label)
              event.target.value = ''
            }}
            data-tip="服务端永久排序（会真的改写歌单顺序，不可撤销）"
          >
            <option value="">永久排序…</option>
            {PERMANENT_SORTS.map((p) => (
              <option key={p.action} value={p.action}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
      </div>

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
        columns={PLAYLIST_COLUMNS}
        loading={list.loading}
        onPlayAt={(index) =>
          void playSongs(list.songs, index, { type: 'playlist', key: String(playlistId) })
        }
        hasMore={list.hasMore}
        onLoadMore={list.loadMore}
        selection={selection}
        onSelectionChange={(indexes) => {
          setSelection(indexes)
          setSelectAllIds(null)
        }}
        onReorder={canReorder ? handleReorder : undefined}
        menuOptions={{
          playlistId,
          onRemoved: (ids) => {
            list.removeSongs(ids)
            clearSelection()
          }
        }}
        extraMenuItems={(song) =>
          isFavorite
            ? []
            : [
                {
                  key: 'perm-sort-here',
                  label: `把「${song.title}」移到最前`,
                  icon: <IconCheck size={15} />,
                  disabled: sort !== 'position',
                  onClick: () => {
                    const index = list.songs.findIndex((s) => s.id === song.id)
                    if (index > 0) handleReorder(index, 0)
                  }
                }
              ]
        }
        emptyTitle={keyword ? '歌单里没有匹配的歌' : '歌单还是空的'}
        emptyDescription={
          keyword
            ? '换个关键词试试'
            : '在曲库选中歌曲后右键「加入歌单」，或者直接把歌曲行拖到侧栏的歌单上'
        }
        emptyAction={
          keyword ? null : (
            <button
              type="button"
              className="btn"
              data-variant="primary"
              onClick={() => navigate({ name: 'library' })}
            >
              去曲库选歌
            </button>
          )
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
            onClick={() => {
              void list
                .fetchAllIds()
                .then(setSelectAllIds)
                .catch(() => undefined)
            }}
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
          playlistId={playlistId}
          onClear={clearSelection}
          onRemoved={(ids) => {
            list.removeSongs(ids)
            clearSelection()
          }}
        />
      ) : null}

      {editing ? (
        <Modal
          title="编辑歌单信息"
          onClose={() => setEditing(false)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setEditing(false)}>
                取消
              </button>
              <button
                type="button"
                className="btn"
                data-variant="primary"
                disabled={!editName.trim()}
                onClick={() => {
                  void playlistsStore
                    .rename(playlistId, { name: editName.trim(), description: editDesc.trim() })
                    .then(() => {
                      setLocalMeta((prev) =>
                        prev
                          ? { ...prev, name: editName.trim(), description: editDesc.trim() || null }
                          : prev
                      )
                      setEditing(false)
                    })
                }}
              >
                保存
              </button>
            </>
          }
        >
          <div className="field">
            <label className="field-label" htmlFor="edit-name">
              名称
            </label>
            <input
              id="edit-name"
              className="input"
              autoFocus
              value={editName}
              onChange={(event) => setEditName(event.target.value)}
            />
          </div>
          <div className="field">
            <label className="field-label" htmlFor="edit-desc">
              描述（可选）
            </label>
            <textarea
              id="edit-desc"
              className="input"
              style={{ height: 84, padding: 10, resize: 'vertical', lineHeight: 1.6 }}
              value={editDesc}
              placeholder="这张歌单是干什么用的"
              onChange={(event) => setEditDesc(event.target.value)}
            />
          </div>
        </Modal>
      ) : null}
    </div>
  )
}

/** 换封面：临时建一个 file input，用完即弃（歌单数量可能很多，不该人人常驻一个） */
function pickCover(playlistId: number): void {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'image/*'
  input.addEventListener('change', () => {
    const file = input.files?.[0]
    if (!file) return
    if (file.size > 8 * 1024 * 1024) {
      toast('封面不能超过 8MB', 'error')
      return
    }
    void usePlaylists.getState().uploadCover(playlistId, file)
  })
  input.click()
}
