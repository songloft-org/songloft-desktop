/**
 * 多选操作条。曲库 / 收藏 / 歌单详情 / 搜索结果共用。
 *
 * 选中集有两种形态，播放与入队对它们的处理**必须分开**：
 *
 *   * **行选中**（`songs.length === ids.length`）→ 手上就是完整对象，点下去立刻执行。
 *   * **全选**（`ids` 比 `songs` 多：整份筛选已经全选，但只加载了一部分）→ 先拿**手上这批**
 *     起播 / 入队，余下的交给调用方的 `loadSongs` 在**后台**补齐，补齐后接在队列尾巴上
 *     （`addToQueue`，不重建队列、不打断正在放的那一首）。用户按的是「播放」，不该等
 *     几千首分页全拉完 —— 那样要十几秒，期间按钮还一直转圈。
 *     补齐期间条上挂一枚「正在后台补齐剩余歌曲…」的转圈；列表本身的进度由表尾那句
 *     「正在加载更多歌曲…」与副标题的「已加载 N」交代。
 *   * 只有 id、**连一首都没到手**（列表还没出第一页）→ 只能等一轮：按 ids 补齐后再执行，
 *     期间按钮显示「正在加载…」，且不许重复触发；失败弹出原因让用户重试。
 */

import { useRef, useState } from 'react'

import {
  IconCheck,
  IconClose,
  IconHeart,
  IconListMusic,
  IconLoader,
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
  /**
   * 选中的**已在手**的歌曲对象。
   *
   * ★ 全选模式下它只是「已经加载的那一部分」，比 `ids` 少 —— 正是它让播放可以**立刻**
   *   开始（见文件头那段）。一首都没有时（列表还没出第一页）留空即可。
   */
  songs?: Song[]
  /**
   * 全选模式下把**余下**的歌曲补齐的办法（通常就是列表 hook 的 `fetchAll`：
   * 一页页拉到完，返回整份列表；拉不全抛错）。
   *
   * 给了它：手上有歌就先播 / 先入队，这一趟在后台跑，到齐了把**没播过的那部分**
   * 追加进队列。手上连一首都没有时才退化成「等它拉完再执行」。
   */
  loadSongs?: () => Promise<Song[]>
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
  loadSongs,
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

  /** 正在为「播放 / 加入队列」补齐歌曲（null = 没在做）—— 只用于「一首都没有」那条路 */
  const [pending, setPending] = useState<'play' | 'queue' | null>(null)
  /**
   * 上面那个 state 的同步闸：同一次点击里连着触发两下（或键盘按住回车）时，state 还没刷新，
   * 只有 ref 拦得住 —— 拉整份列表很贵，重复触发一次就是多跑一趟全量分页。
   */
  const busy = useRef(false)
  /** 后台正在补齐「已全选、但还没加载」的那一批（与播放**互不阻塞**） */
  const [filling, setFilling] = useState(false)
  /** 同一时刻只跑一趟补齐（连点两次播放不该拉两遍整份列表） */
  const fillingRef = useRef(false)

  /** 手上真有歌（行选中，或全选模式下已经加载出来的那部分） */
  const ready = songs && songs.length > 0 ? songs : null
  /** 一首都没有、但有办法补齐（列表还没出第一页） */
  const canLoad = !ready && Boolean(loadSongs)
  const canPlay = Boolean(ready) || canLoad
  const allFavorited = ids.length > 0 && ids.every((id) => favoriteIds.has(id))
  const count = selectAll ? (selectAllTotal ?? ids.length) : ids.length
  /** 还有多少首没到手（全选模式下 > 0 才谈得上「后台补齐」） */
  const missing = Math.max(0, count - (ready?.length ?? 0))
  /**
   * 要不要去后台补齐。
   *
   * ★ 必须连着 `selectAll` 一起判：行选中时 `ids` 与 `songs` 本该一样长，若恰好有一首
   *   在下标失效（刚被删掉）时两者对不上，不该因此替用户拉一遍整份列表。
   */
  const needsFill = Boolean(selectAll) && missing > 0

  /**
   * 后台补齐余下的那批，到了就 接在队尾。
   *
   * ★ 用 `addToQueue` 而不是再 `playSongs` 一次：后者会重建队列与游标，正在放的那一首
   *   会被打断 —— 而这个函数存在的意义正是「播放不受影响」。
   * ★ 只补**没播过**的那些（按 id 比）：`loadSongs` 回来的是整份筛选结果，手上这批
   *   已经在队列里了，重复塞进去会让同一首歌排两遍。
   * ★ 失败只提示、不回滚：已经播起来的那批是有效的，用户顶多没拿到后面那些。
   */
  const fillRest = async (played: Song[]): Promise<void> => {
    if (fillingRef.current || !loadSongs) return
    fillingRef.current = true
    setFilling(true)
    const playedIds = new Set(played.map((song) => song.id))
    try {
      const all = await loadSongs()
      const wanted = new Set(ids)
      const rest = all.filter((song) => wanted.has(song.id) && !playedIds.has(song.id))
      if (rest.length === 0) return
      addToQueue(rest)
      toast(`其余 ${rest.length} 首已接在播放队列后面`, 'success')
    } catch (error) {
      toast('剩余歌曲没有补齐', 'error', error instanceof Error ? error.message : undefined)
    } finally {
      fillingRef.current = false
      setFilling(false)
    }
  }

  /**
   * 播放 / 加入队列的唯一入口。
   *
   * ★ 手上已经有歌时**同步执行**（`playSongs` / `addToQueue` 都不等网络），余下的交给
   *   `fillRest` 在后台跑 —— 这正是「点了就响，边放边补」。
   * ★ 只有「一首都没到手」才退化成等待：那时没有任何东西可以起播，按钮转圈直到补齐。
   */
  const runWithSongs = async (action: 'play' | 'queue'): Promise<void> => {
    if (ready) {
      if (action === 'play') {
        void playSongs(ready, 0)
      } else {
        addToQueue(ready)
        if (missing === 0) toast(`已加入队列 ${ready.length} 首`, 'success')
      }
      if (needsFill) void fillRest(ready)
      return
    }

    if (busy.current || !loadSongs) return
    busy.current = true
    setPending(action)
    try {
      /*
       * 走「补齐」这条路时按 `ids` 过一遍：列表拉回来的是**整份筛选结果**，而这一条操作
       * 只该对**选中的那些**生效（两者通常一样，但筛选结果在拉开期间可能已经变过）。
       */
      const all = await loadSongs()
      const wanted = new Set(ids)
      const list = all.filter((song) => wanted.has(song.id))
      if (list.length === 0) {
        toast('没有可播放的歌曲', 'error')
        return
      }
      if (action === 'play') {
        await playSongs(list, 0)
        return
      }
      addToQueue(list)
      toast(`已加入队列 ${list.length} 首`, 'success')
    } catch (error) {
      toast('加载歌曲失败，请重试', 'error', error instanceof Error ? error.message : undefined)
    } finally {
      busy.current = false
      setPending(null)
    }
  }

  return (
    <SelectionBarShell
      label={
        <>
          <span className="badge" data-tone="accent">
            <IconCheck size={12} />
            {selectAll ? `已选中全部 ${count} 首` : `已选 ${count} 首`}
          </span>
          {/*
            后台补齐的进度提示：**不挡任何操作**（播放已经起来了、按钮也还能点），
            只是让人知道「队列还会自己变长」。数量由 upper 层的 total 与已加载数得出，
            列表本身的进度则看表尾那句「正在加载更多歌曲…」。
          */}
          {filling ? (
            <span
              className="row"
              role="status"
              aria-live="polite"
              style={{ gap: 6, fontSize: 12, color: 'var(--text-3)' }}
            >
              <IconLoader size={12} className="spin" />
              正在后台补齐剩余 {missing} 首…
            </span>
          ) : null}
        </>
      }
      onClear={onClear}
    >
      <button
        type="button"
        className="btn"
        data-size="sm"
        disabled={!canPlay || pending !== null}
        aria-busy={pending === 'play'}
        data-tip={
          !canPlay
            ? '列表还没加载出内容，暂时无法播放'
            : canLoad
              ? '先把整份列表加载完，再开始播放'
              : needsFill
                ? '立刻播放已加载的那些，其余在后台补齐后接在队尾'
                : '播放选中歌曲'
        }
        onClick={() => void runWithSongs('play')}
      >
        {pending === 'play' ? <IconLoader size={14} className="spin" /> : <IconPlay size={14} />}
        {pending === 'play' ? '正在加载…' : '播放'}
      </button>
      <button
        type="button"
        className="btn"
        data-size="sm"
        disabled={!canPlay || pending !== null}
        aria-busy={pending === 'queue'}
        data-tip={
          !canPlay
            ? '列表还没加载出内容，暂时无法加入队列'
            : canLoad
              ? '先把整份列表加载完，再加进播放队列'
              : needsFill
                ? '先把已加载的那些加入队列，其余在后台补齐后接在队尾'
                : '加入播放队列'
        }
        onClick={() => void runWithSongs('queue')}
      >
        {pending === 'queue' ? <IconLoader size={14} className="spin" /> : <IconQueue size={14} />}
        {pending === 'queue' ? '正在加载…' : '加入队列'}
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
