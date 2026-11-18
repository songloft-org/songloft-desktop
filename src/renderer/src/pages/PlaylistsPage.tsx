/**
 * 歌单总览。
 *
 * 两种呈现形式由设置里的 `playlistView` 记住（见 shared/ipc 的说明）：
 *   * **网格** —— 封面是歌单最主要的识别信息，卡片里它最大；
 *   * **列表** —— 一屏能看更多，勾选框落在行首，多选删除时更像一张表。
 * 卡片顺序沿用后端给的位置序（置顶在前），拖动重排不做在这里 —— 侧栏才是天天用的重排入口。
 *
 * ★ 多选（两种形式通用）：行首勾选框 / Ctrl·Cmd 点 / Shift 连选一段。
 *   **已经有选中项时，普通点击不再进歌单，而是继续加选** —— 否则刚勾两个、手一滑点到第三个
 *   就直接跳走，选择也一起丢了；要退出选择点「取消选择」。
 *   内置收藏歌单（我喜欢的音乐 / 电台收藏）后端不给删，所以它们连勾选框都没有，
 *   「全选」也只圈可删的那些（口径只有 isDeletablePlaylist 一份）。
 *
 * ★ 数据来自 usePlaylists（含侧栏、命令面板共用的那一份），所以它的新鲜度由本页盯：
 *   重新被看见时静默刷新一次，条件与三条底线见下面那个 effect 与 state/usePlaylists 的 load。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { Playlist } from '@shared/types'
import {
  IconCheck,
  IconEyeOff,
  IconGrid,
  IconHeart,
  IconMore,
  IconPin,
  IconPlus,
  IconRadio,
  IconRefresh,
  IconRows,
  IconTrash
} from '@/components/Icons'
import { CardGridSkeleton, Cover, EmptyState, SongRowsSkeleton } from '@/components/primitives'
import { openMenuFromEvent, type MenuItem } from '@/components/ContextMenu'
import { Modal } from '@/components/Modal'
import { SelectionBarShell, shouldShowSelectionBar } from '@/components/SelectionBar'
import { usePageActive } from '@/hooks/usePageActive'
import { isDeletablePlaylist, usePlaylists, FAVORITE_PLAYLIST_ID } from '@/state/usePlaylists'
import { useSettings } from '@/state/useSettings'
import { useUi } from '@/state/useUi'
import { toast } from '@/state/useToasts'

type Filter = 'normal' | 'radio' | 'all'

export function PlaylistsPage(): React.JSX.Element {
  const navigate = useUi((s) => s.navigate)
  /** 这一槽现在是不是看得见的那一页（见 hooks/usePageActive）：下面那个 effect 靠它判「切回来了」 */
  const active = usePageActive()
  const { playlists, loading, error, load } = usePlaylists()
  const view = useSettings((s) => s.settings.playlistView)
  const patchSettings = useSettings((s) => s.patch)
  const [filter, setFilter] = useState<Filter>('normal')
  const [showHidden, setShowHidden] = useState(false)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [renaming, setRenaming] = useState<Playlist | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  /** 选中的歌单 id：存 id 而不是下标 —— 筛选、刷新都会让下标措位 */
  const [pickedIds, setPickedIds] = useState<number[]>([])
  /** Shift 连选用的锚点（可见列表里的下标） */
  const [anchor, setAnchor] = useState<number | null>(null)

  const visible = useMemo(
    () => playlists.filter((p) => (filter === 'all' ? true : p.type === filter)),
    [playlists, filter]
  )
  // 只认「当前列表里还看得见」的那些：歌单在别处被删掉后，残留的 id 不该还计入选择
  const picked = useMemo(
    () => visible.filter((p) => pickedIds.includes(p.id)),
    [visible, pickedIds]
  )
  const pickedSet = useMemo(() => new Set(picked.map((p) => p.id)), [picked])
  const selectable = useMemo(() => visible.filter(isDeletablePlaylist), [visible])
  const allPicked = selectable.length > 0 && picked.length === selectable.length

  const reload = useCallback(() => void load({ includeHidden: showHidden }), [load, showHidden])

  /**
   * 重新被看见时静默刷新一次。
   *
   * ★ 触发条件只有「由藏变显」这一跳，但它把两件事一起覆盖了：从别的页切回来（页面槽常驻，
   *   见 App 的 NativePages）、以及从扩展面切回原生面（那时这一槽同样失活，见 App 的 PageSlot）。
   *   窗口重新聚焦**不算** —— 与 useAsync / useSongList / usePlaylistSongs 同一口径，
   *   不给这一页开特例（每次 Alt+Tab 回来都重取一轮并不划算）。
   * ★ 首次挂载也算一跳（ref 的初值是 false）：这一页可能开机很久之后才第一次被打开，
   *   而 store 里那份是启动编排取的，早该对一遍了。切页面时本页一直挂着，不会再挂第二次。
   * ★ 带着**本页当前那个「显示隐藏的歌单」条件**去取（那颗开关由本页自己说，不由 store 猜）：
   *   不传的话静默刷新会把隐藏歌单从列表里抹掉，而开关还亮着 —— 看起来就像刷新把数据弄丢了。
   * ★ 静默：不显示加载态，取回来与手头一致时连 set 都不做（见 state/usePlaylists 的 load），
   *   于是滚动位置、勾选、筛选都还是离开时的样子；失败也不冒泡（手头这份还能用）。
   */
  const wasActive = useRef(false)
  useEffect(() => {
    if (active && !wasActive.current) void load({ silent: true, includeHidden: showHidden })
    wasActive.current = active
  }, [active, load, showHidden])

  const clearSelection = useCallback(() => {
    setPickedIds([])
    setAnchor(null)
  }, [])

  const handleCreate = async (): Promise<void> => {
    const name = newName.trim()
    if (!name) return
    const playlist = await usePlaylists.getState().create({
      type: filter === 'radio' ? 'radio' : 'normal',
      name
    })
    setCreating(false)
    setNewName('')
    if (playlist) navigate({ name: 'playlist', id: playlist.id })
  }

  /**
   * 点歌单本体。
   * 没有选中项时是「进歌单」；已有选中项（或按着 Ctrl / Cmd）时是加选 / 减选。
   */
  const handleItemClick = (index: number, event: React.MouseEvent): void => {
    const playlist = visible[index]
    if (!playlist) return
    // 内置收藏删不掉，也就没有勾选框：任何时候点它都是「进歌单」
    if (!isDeletablePlaylist(playlist)) {
      navigate({ name: 'playlist', id: playlist.id })
      return
    }
    if (event.shiftKey && anchor !== null) {
      const [from, to] = anchor < index ? [anchor, index] : [index, anchor]
      setPickedIds(
        visible
          .slice(from, to + 1)
          .filter(isDeletablePlaylist)
          .map((p) => p.id)
      )
      return
    }
    if (event.ctrlKey || event.metaKey || picked.length > 0) {
      setPickedIds((prev) =>
        prev.includes(playlist.id)
          ? prev.filter((id) => id !== playlist.id)
          : [...prev, playlist.id]
      )
      setAnchor(index)
      return
    }
    navigate({ name: 'playlist', id: playlist.id })
  }

  const togglePick = (id: number): void => {
    setPickedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }

  const removePlaylists = (targets: Playlist[]): void => {
    if (targets.length === 0) return
    if (!confirmDelete(targets)) return
    void usePlaylists
      .getState()
      .removeMany(targets.map((p) => p.id))
      .then((ok) => {
        if (!ok) return
        // 右键单个时删的只是选中集里的一部分，所以按实际删掉的 id 重算，而不是整份清空
        const removed = new Set(targets.map((p) => p.id))
        setPickedIds((prev) => prev.filter((id) => !removed.has(id)))
      })
  }

  const menuFor = (playlist: Playlist): MenuItem[] => {
    // 多选状态里对某一行点右键，「删除」作用于整批 —— 与歌曲行的右键同一套语义
    const asBatch = pickedSet.has(playlist.id) && picked.length > 1
    const targets = asBatch ? picked : [playlist]
    return [
      { key: 'header', label: playlist.name, header: true },
      {
        key: 'open',
        label: '打开',
        onClick: () => navigate({ name: 'playlist', id: playlist.id })
      },
      {
        key: 'rename',
        label: '重命名 / 改描述',
        onClick: () => {
          setRenaming(playlist)
          setRenameDraft(playlist.name)
        }
      },
      {
        key: 'cover',
        label: '更换封面…',
        onClick: () => pickCover(playlist)
      },
      { key: 'sep-1', label: '', separator: true },
      {
        key: 'pin',
        label: playlist.pinned_at ? '取消置顶' : '置顶',
        icon: <IconPin size={15} />,
        onClick: () => void usePlaylists.getState().setPinned(playlist.id, !playlist.pinned_at)
      },
      {
        key: 'hide',
        label: '隐藏（不出现在列表里）',
        icon: <IconEyeOff size={15} />,
        onClick: () => void usePlaylists.getState().setHidden(playlist.id, true)
      },
      ...(isDeletablePlaylist(playlist)
        ? [
            { key: 'sep-2', label: '', separator: true },
            {
              key: 'delete',
              label: asBatch ? `删除选中的 ${picked.length} 个歌单` : '删除歌单',
              icon: <IconTrash size={15} />,
              variant: 'danger' as const,
              onClick: () => removePlaylists(targets)
            }
          ]
        : [])
    ]
  }

  const titleIcons = (playlist: Playlist): React.ReactNode => (
    <>
      {playlist.type === 'radio' ? <IconRadio size={13} /> : null}
      {playlist.id === FAVORITE_PLAYLIST_ID ? <IconHeart size={13} filled /> : null}
    </>
  )

  const metaOf = (playlist: Playlist): string =>
    `${playlist.song_count} 首${playlist.remote_count > 0 ? ` · 网络 ${playlist.remote_count}` : ''}${
      playlist.pinned_at ? ' · 已置顶' : ''
    }`

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">歌单</h1>
          <p className="page-subtitle">
            {loading
              ? '正在读取…'
              : `${visible.length} 个${filter === 'radio' ? '电台歌单' : '歌单'}`}
          </p>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <button type="button" className="btn" onClick={reload}>
            <IconRefresh size={15} />
            刷新
          </button>
          <button
            type="button"
            className="btn"
            data-variant="primary"
            onClick={() => setCreating(true)}
          >
            <IconPlus size={15} />
            新建歌单
          </button>
        </div>
      </div>

      <div className="row-between" style={{ marginBottom: 18, gap: 14, flexWrap: 'wrap' }}>
        <div className="segmented" role="group" aria-label="歌单类型">
          <button
            type="button"
            aria-pressed={filter === 'normal'}
            onClick={() => {
              setFilter('normal')
              clearSelection()
            }}
          >
            我的歌单
          </button>
          <button
            type="button"
            aria-pressed={filter === 'radio'}
            onClick={() => {
              setFilter('radio')
              clearSelection()
            }}
          >
            电台
          </button>
          <button
            type="button"
            aria-pressed={filter === 'all'}
            onClick={() => {
              setFilter('all')
              clearSelection()
            }}
          >
            全部
          </button>
        </div>

        <div className="row" style={{ gap: 8 }}>
          {selectable.length > 1 ? (
            <button
              type="button"
              className="btn"
              data-size="sm"
              data-variant={allPicked ? 'primary' : 'default'}
              data-tip="内置收藏歌单删不掉，不在全选范围内"
              onClick={() => {
                if (allPicked) clearSelection()
                else setPickedIds(selectable.map((p) => p.id))
              }}
            >
              {allPicked ? '取消全选' : '全选'}
            </button>
          ) : null}
          {/* 切换的是呈现形式（不是筛选），所以走 .segmented */}
          <div className="segmented" role="group" aria-label="歌单呈现形式">
            <button
              type="button"
              aria-pressed={view === 'grid'}
              aria-label="网格视图"
              data-tip="网格视图"
              onClick={() => void patchSettings({ playlistView: 'grid' })}
            >
              <IconGrid size={15} />
            </button>
            <button
              type="button"
              aria-pressed={view === 'list'}
              aria-label="列表视图"
              data-tip="列表视图"
              onClick={() => void patchSettings({ playlistView: 'list' })}
            >
              <IconRows size={15} />
            </button>
          </div>
          <button
            type="button"
            className="btn"
            data-size="sm"
            data-variant={showHidden ? 'primary' : 'default'}
            onClick={() => {
              const next = !showHidden
              setShowHidden(next)
              void load({ includeHidden: next })
            }}
          >
            显示隐藏的歌单
          </button>
        </div>
      </div>

      {/*
        取数失败：把原因与出口一起摆出来（与搜索页那条同款）。它只可能来自**明着**加载的那几趟
        —— 手动刷新、切条件、启动编排；切回本页那一趟是静默的，失败了不往这里冒泡
        （手头这份还能用，见 state/usePlaylists 的 load）。
      */}
      {error ? (
        <div className="probe-result" data-state="error" style={{ marginBottom: 14 }}>
          <span>{error}</span>
          <button type="button" className="btn" data-size="sm" onClick={reload}>
            重试
          </button>
        </div>
      ) : null}

      {loading && playlists.length === 0 ? (
        view === 'list' ? (
          <SongRowsSkeleton rows={8} columns={4} />
        ) : (
          <CardGridSkeleton cards={10} />
        )
      ) : error && playlists.length === 0 ? null : visible.length === 0 ? (
        <EmptyState
          icon={<IconPlus size={26} />}
          title="这里还没有歌单"
          description="新建一个歌单，或者把歌曲行直接拖到侧栏的歌单上"
          action={
            <button
              type="button"
              className="btn"
              data-variant="primary"
              onClick={() => setCreating(true)}
            >
              新建歌单
            </button>
          }
        />
      ) : view === 'list' ? (
        <div className="playlist-list" data-selecting={picked.length > 0}>
          {visible.map((playlist, index) => (
            <div
              key={playlist.id}
              className="playlist-row"
              data-pinned={Boolean(playlist.pinned_at)}
              data-selected={pickedSet.has(playlist.id)}
              role="button"
              tabIndex={0}
              data-tip={playlist.name}
              onClick={(event) => handleItemClick(index, event)}
              onContextMenu={(event) => openMenuFromEvent(event, menuFor(playlist))}
            >
              {isDeletablePlaylist(playlist) ? (
                <PickBox
                  checked={pickedSet.has(playlist.id)}
                  label={`选择歌单「${playlist.name}」`}
                  onToggle={() => togglePick(playlist.id)}
                />
              ) : (
                <span />
              )}
              <Cover
                coverUrl={playlist.cover_url}
                width={96}
                size={44}
                radius={8}
                kind="playlist"
              />
              <div style={{ minWidth: 0 }}>
                <div className="card-title row" style={{ gap: 6, minWidth: 0 }}>
                  {titleIcons(playlist)}
                  <span className="truncate">{playlist.name}</span>
                </div>
                <div className="card-meta truncate">{metaOf(playlist)}</div>
              </div>
              <button
                type="button"
                className="icon-btn"
                aria-label="更多操作"
                data-tip="更多操作"
                onClick={(event) => {
                  event.stopPropagation()
                  openMenuFromEvent(event, menuFor(playlist))
                }}
              >
                <IconMore size={15} />
              </button>
            </div>
          ))}
        </div>
      ) : (
        <div className="card-grid" data-selecting={picked.length > 0}>
          {visible.map((playlist, index) => (
            <div
              key={playlist.id}
              className="card"
              data-pinned={Boolean(playlist.pinned_at)}
              data-selected={pickedSet.has(playlist.id)}
              role="button"
              tabIndex={0}
              data-tip={playlist.name}
              onClick={(event) => handleItemClick(index, event)}
              onContextMenu={(event) => openMenuFromEvent(event, menuFor(playlist))}
            >
              <div className="card-art">
                <Cover coverUrl={playlist.cover_url} size="100%" radius={0} kind="playlist" />
                {isDeletablePlaylist(playlist) ? (
                  <PickBox
                    checked={pickedSet.has(playlist.id)}
                    label={`选择歌单「${playlist.name}」`}
                    onToggle={() => togglePick(playlist.id)}
                  />
                ) : null}
              </div>
              <div className="card-title truncate row" style={{ gap: 6 }}>
                {titleIcons(playlist)}
                <span className="truncate">{playlist.name}</span>
              </div>
              <div className="card-meta">{metaOf(playlist)}</div>
            </div>
          ))}
        </div>
      )}

      {shouldShowSelectionBar(picked.length) ? (
        <SelectionBarShell
          label={
            <span className="badge" data-tone="accent">
              <IconCheck size={12} />
              已选 {picked.length} 个歌单
            </span>
          }
          onClear={clearSelection}
        >
          <button
            type="button"
            className="btn"
            data-size="sm"
            data-variant="danger"
            onClick={() => removePlaylists(picked)}
          >
            <IconTrash size={14} />
            删除歌单
          </button>
        </SelectionBarShell>
      ) : null}

      {creating ? (
        <Modal
          title="新建歌单"
          onClose={() => setCreating(false)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setCreating(false)}>
                取消
              </button>
              <button
                type="button"
                className="btn"
                data-variant="primary"
                disabled={!newName.trim()}
                onClick={() => void handleCreate()}
              >
                创建
              </button>
            </>
          }
        >
          <div className="field">
            <label className="field-label" htmlFor="playlist-create-name">
              歌单名称
            </label>
            <input
              id="playlist-create-name"
              className="input"
              autoFocus
              value={newName}
              placeholder="例如：通勤路上"
              onChange={(event) => setNewName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void handleCreate()
              }}
            />
          </div>
        </Modal>
      ) : null}

      {renaming ? (
        <Modal
          title="重命名歌单"
          onClose={() => setRenaming(null)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setRenaming(null)}>
                取消
              </button>
              <button
                type="button"
                className="btn"
                data-variant="primary"
                disabled={!renameDraft.trim()}
                onClick={() => {
                  void usePlaylists.getState().rename(renaming.id, { name: renameDraft.trim() })
                  setRenaming(null)
                }}
              >
                保存
              </button>
            </>
          }
        >
          <div className="field">
            <label className="field-label" htmlFor="playlist-rename">
              新名称
            </label>
            <input
              id="playlist-rename"
              className="input"
              autoFocus
              value={renameDraft}
              onChange={(event) => setRenameDraft(event.target.value)}
            />
          </div>
        </Modal>
      ) : null}
    </div>
  )
}

/* ─────────────────────────────── 勾选框 ─────────────────────────────── */

/**
 * 歌单的勾选框。网格卡片与列表行共用同一个 —— 两处各写一套的话，
 * 「点勾选框不该顺带打开歌单」这种细节迟早有一处忘掉。
 */
function PickBox({
  checked,
  label,
  onToggle
}: {
  checked: boolean
  label: string
  onToggle: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      className="pick"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      data-checked={checked}
      onClick={(event) => {
        // 勾选只是勾选：别让冒泡到卡片上的点击把歌单也打开了
        event.stopPropagation()
        onToggle()
      }}
    >
      {checked ? <IconCheck size={12} /> : null}
    </button>
  )
}

/**
 * 破坏性确认走 `window.confirm` —— 仓库里所有这类确认都是这个路子（见 lib/plugin-actions.ts）。
 * 多选时不逐个点名：超过 5 个只报个数，免得确认框里铺一屏名字。
 */
function confirmDelete(targets: Playlist[]): boolean {
  const NAMES_LIMIT = 5
  const names = targets
    .slice(0, NAMES_LIMIT)
    .map((p) => `「${p.name}」`)
    .join('、')
  const label = targets.length > NAMES_LIMIT ? `${names} 等 ${targets.length} 个歌单` : names
  return window.confirm(`删除 ${label}？只删歌单，不动歌曲文件。`)
}

/**
 * 换封面走一个隐藏的 file input。
 * 之所以不常驻在 DOM 里：歌单可能有几十个，一人一个 input 纯属浪费；
 * 需要时才建、用完即弃。
 */
function pickCover(playlist: Playlist): void {
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
    void usePlaylists.getState().uploadCover(playlist.id, file)
  })
  input.click()
}
