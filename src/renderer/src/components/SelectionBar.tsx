/**
 * 多选操作条。曲库 / 收藏 / 歌单详情 / 搜索结果共用。
 *
 * 两种选中来源要区分开：
 *   * **行选中**（`songs` 非空）→ 全部动作可用，因为手上就有完整 Song 对象
 *   * **全选当前筛选**（只有 `ids`，`songs` 为空）→ 只能做 id 级操作
 *     （加歌单 / 收藏 / 删除）。播放和加队列需要 Song 对象，这时按钮置灰并说明原因，
 *     而不是悄悄什么也不做。
 */

import {
  IconCheck,
  IconClose,
  IconHeart,
  IconListMusic,
  IconPlay,
  IconQueue,
  IconTrash
} from './Icons'
import type { Song } from '@shared/types'
import { deleteSong } from '@/api/endpoints'
import { requireClient } from '@/state/useAuth'
import { usePlayer } from '@/state/usePlayer'
import { usePlaylists } from '@/state/usePlaylists'
import { useUi } from '@/state/useUi'
import { toast } from '@/state/useToasts'

/**
 * 多选操作条该不该出现：**选中项 ≥ 2** 才有意义。
 *
 * 只选中一项时底部那条是纯噪声 —— 播放 / 加入队列 / 收藏都在行上（hover 出来的按钮、
 * 右键菜单）拿得到，而它一出现就盖住列表最后几行，还会让人以为「选中了但只看得到一个」。
 * 于是这条判断只写在组件旁边这一处：各页只负责把口径（行选中还是「全选筛选」）算成个数。
 */
export function shouldShowSelectionBar(count: number): boolean {
  return count > 1
}

export interface SelectionBarProps {
  ids: number[]
  /** 有完整对象时才支持播放 / 加入队列 */
  songs?: Song[]
  onClear: () => void
  /** 歌单上下文：提供后显示「从歌单移除」而不是「从曲库删除」 */
  playlistId?: number
  /** 移除 / 删除成功后通知调用方就地把行去掉 */
  onRemoved?: (ids: number[]) => void
  /** 是否是「全选当前筛选」模式（决定文案） */
  selectAll?: boolean
  /** 全选模式下实际的筛选总数 */
  selectAllTotal?: number
}

export interface SelectionBarShellProps {
  /** 左侧那枚计数器（各页口径不同：曲目按「首」，歌单按「个」） */
  label: React.ReactNode
  onClear: () => void
  /** 右侧的动作按钮 */
  children: React.ReactNode
}

/**
 * 底部吸附操作条的**外观**。
 *
 * 单独抽出来是因为它已经出现在第二处了（歌单页的多选），而两处的动作完全不同：
 * 曲目那边是播放 / 队列 / 收藏，歌单那边只有删除。只共用壳，不共用动作。
 */
export function SelectionBarShell({
  label,
  onClear,
  children
}: SelectionBarShellProps): React.JSX.Element {
  return (
    <div className="selection-bar">
      <div className="row" style={{ gap: 10, minWidth: 0 }}>
        {label}
        <button type="button" className="btn" data-size="sm" data-variant="ghost" onClick={onClear}>
          <IconClose size={13} />
          取消选择
        </button>
      </div>
      <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
        {children}
      </div>
    </div>
  )
}

export function SelectionBar({
  ids,
  songs,
  onClear,
  playlistId,
  onRemoved,
  selectAll,
  selectAllTotal
}: SelectionBarProps): React.JSX.Element {
  const playSongs = usePlayer((s) => s.playSongs)
  const addToQueue = usePlayer((s) => s.addToQueue)
  const openAddToPlaylist = useUi((s) => s.setAddToPlaylistTarget)
  const setFavorite = usePlaylists((s) => s.setFavorite)
  const favoriteIds = usePlaylists((s) => s.favoriteIds)

  const canPlay = Boolean(songs && songs.length > 0)
  const allFavorited = ids.length > 0 && ids.every((id) => favoriteIds.has(id))
  const count = selectAll ? (selectAllTotal ?? ids.length) : ids.length

  return (
    <SelectionBarShell
      label={
        <span className="badge" data-tone="accent">
          <IconCheck size={12} />
          {selectAll ? `已选中全部 ${count} 首` : `已选 ${count} 首`}
        </span>
      }
      onClear={onClear}
    >
      <button
        type="button"
        className="btn"
        data-size="sm"
        disabled={!canPlay}
        data-tip={canPlay ? '播放选中歌曲' : '全选模式下不加载歌曲内容，无法直接播放'}
        onClick={() => songs && void playSongs(songs, 0)}
      >
        <IconPlay size={14} />
        播放
      </button>
      <button
        type="button"
        className="btn"
        data-size="sm"
        disabled={!canPlay}
        data-tip={canPlay ? '加入播放队列' : '全选模式下不加载歌曲内容，无法加入队列'}
        onClick={() => {
          if (!songs) return
          addToQueue(songs)
          toast(`已加入队列 ${songs.length} 首`, 'success')
        }}
      >
        <IconQueue size={14} />
        加入队列
      </button>
      <button type="button" className="btn" data-size="sm" onClick={() => openAddToPlaylist(ids)}>
        <IconListMusic size={14} />
        加入歌单
      </button>
      <button
        type="button"
        className="btn"
        data-size="sm"
        onClick={() => {
          const target = !allFavorited
          for (const id of ids) void setFavorite(id, target)
        }}
      >
        <IconHeart size={14} filled={allFavorited} />
        {allFavorited ? '取消收藏' : '收藏'}
      </button>

      {playlistId != null ? (
        <button
          type="button"
          className="btn"
          data-size="sm"
          onClick={() => {
            void removeFromPlaylist(playlistId, ids).then(() => onRemoved?.(ids))
          }}
        >
          <IconTrash size={14} />
          从歌单移除
        </button>
      ) : (
        <button
          type="button"
          className="btn"
          data-size="sm"
          data-variant="danger"
          onClick={() => {
            void deleteFromLibrary(ids).then((ok) => {
              if (ok) onRemoved?.(ids)
            })
          }}
        >
          <IconTrash size={14} />
          从曲库删除
        </button>
      )}
    </SelectionBarShell>
  )
}

async function removeFromPlaylist(playlistId: number, ids: number[]): Promise<void> {
  const store = usePlaylists.getState()
  try {
    if (playlistId === 1) {
      for (const id of ids) await store.setFavorite(id, false)
    } else {
      for (const id of ids) await store.removeSong(playlistId, id)
    }
    toast(`已移除 ${ids.length} 首`, 'success')
  } catch (error) {
    toast('移除失败', 'error', error instanceof Error ? error.message : undefined)
  }
}

/**
 * 从曲库删除记录（不动本地文件）。
 * 返回是否成功，让调用方决定要不要把行从列表里摘掉。
 */
async function deleteFromLibrary(ids: number[]): Promise<boolean> {
  try {
    await Promise.all(ids.map((id) => deleteSong(requireClient(), id, false)))
    toast(`已从曲库删除 ${ids.length} 首（本地文件保留）`, 'success')
    return true
  } catch (error) {
    toast('删除失败', 'error', error instanceof Error ? error.message : undefined)
    return false
  }
}
