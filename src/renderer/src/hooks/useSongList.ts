/**
 * 分页歌曲列表。
 *
 * 四个必须处理的点：
 *   1. 请求竞态：筛选条件一变，在途的旧请求必须作废（否则慢的旧响应会盖掉新结果）
 *   2. 累加去重：同一首歌不该因为 offset 漂移出现两次
 *   3. 卸载安全：切页面时不再 setState
 *   4. 切回本页时的**静默刷新**：重取一次，数据没变就一个字都不改（见下面那段说明）
 *
 * 「加载全部 ID」单独给一个方法：批量操作（全选加歌单）不该把几千首歌拉进内存，
 * 后端有 `/songs/ids` 只返回 id。而「播放全部」要的是**歌本身**（队列里得有对象），
 * 那一条走 `loadAll`：分页一页页拉完，每页到达就回调一次，调用方边到达边接进队列。
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import { sameData } from '@shared/data'
import type { Song, SongQuery } from '@shared/types'
import { getSongIds, getSongs } from '@/api/endpoints'
import { requireClient } from '@/state/useAuth'
import { useLibrary } from '@/state/useLibrary'
import { usePageActive } from './usePageActive'

export interface SongListController {
  songs: Song[]
  total: number
  loading: boolean
  loadingMore: boolean
  error: string | null
  hasMore: boolean
  loadMore: () => void
  refresh: () => void
  /** 就地替换某首歌（编辑元数据后避免整表刷新） */
  patchSong: (song: Song) => void
  removeSongs: (ids: number[]) => void
  /** 取当前筛选条件下的全部 id（用于批量操作） */
  fetchAllIds: () => Promise<number[]>
  /**
   * 后台把**余下的分页一次拉完**，每拉到一页就把新增的那些回调一次。
   *
   * 「播放全部」用它：起播只等已经在手的那一页，剩下的边拉边接进播放队列
   * （见 pages/LibraryPage）—— 用户不必等整份列表就位才开始听。
   *
   * @returns 是否**一路拉到了底**（取消 / 出错 / 后端不再给数据都是 false）。
   */
  loadAll: (onPage?: (songs: Song[]) => void) => Promise<boolean>
  /**
   * 取**整份**列表（已在手的 + 余下分页），给「全选之后要播放 / 加入队列」那种动作：
   * 那两条要的是 Song 对象，而「全选当前筛选」手上只有 id。
   *
   * ★ 与 loadAll 同一套推进逻辑（含「已经有一轮在跑就等它」），区别只在于把结果集返回，
   *   而不是一页页回调 —— 两种消费方式（边到边接队列 / 一次性拿全）不该各写一份。
   * ★ **没拉全就抛错**（取消 / 出错 / 后端没有更多却没到底）：调用方据此提示重试，
   *   而不是拿一份残缺的列表去播放或入队。
   */
  fetchAll: () => Promise<Song[]>
  /** 已加载的页码（从 0 开始），调试用 */
  pages: number
}

export function useSongList(query: SongQuery, pageSize = 200): SongListController {
  const [songs, setSongs] = useState<Song[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pages, setPages] = useState(0)

  const generation = useRef(0)
  const queryKey = JSON.stringify(query)
  /*
   * 曲库数据的版本号（扫描 / 刷新元数据结束后 +1，见 state/useLibrary）。
   * 放进下面那个 effect 的依赖里 → 与手动点「刷新」同一条路径
   * （已加载的分页会退回第一页，这是「数据变了」该有的代价）。
   */
  const revision = useLibrary((s) => s.revision)
  /** 所在的页面槽是不是看得见的那一页（见 usePageActive）：切回来要重取一次 */
  const active = usePageActive()

  /** 手头这份列表的镜像：静默刷新与去重都要拿它比对（state 在闭包里是过期的那一份） */
  const songsRef = useRef<Song[]>([])
  const totalRef = useRef(0)
  /**
   * 后台「一次拉完」那一轮（见 loadAll）：null = 现在没有在拉。
   *
   * ★ 与 loadMore 互斥：两边同时以一页为步长推进时，后发的那一次会拿到同一个 offset，
   *   去重之后那一页就白丢了（列表与总数从此对不上，而且没有任何报错）。
   * ★ 存的是 promise（连同它属于哪一代）而不只是一个布尔量：第二次「播放全部」要能
   *   **等这一轮拉完**，再把从那之后新到的歌补给它（见 loadAll 开头）；而那一代已经被
   *   作废（换筛选 / 刷新）时，等它没有意义 —— 得按新的那一份重新起一轮。
   */
  const restRun = useRef<{ token: number; done: Promise<boolean> } | null>(null)
  /** 上一次请求的条件指纹；与这次相同 → 只因切回本页而重跑，走静默路径 */
  const lastKey = useRef<string | null>(null)

  const commit = useCallback((next: Song[], nextTotal: number, loadedPages: number) => {
    songsRef.current = next
    totalRef.current = nextTotal
    setSongs(next)
    setTotal(nextTotal)
    setPages(loadedPages)
  }, [])

  /**
   * 取一页并并进列表里。
   *
   * @param silent 切回本页时的静默刷新：只重取第一页与手头这份比，
   *   一样就**什么都不做**（已加载的后续页、滚动位置、选中态全留着）；
   *   不一样才换掉（退回第一页 —— 与手动点「刷新」同一条路径）。
   *   只比第一页是刻意的取舍：要覆盖已加载的 N 页就得再拉 N 页（用户点过十几次
   *   「加载更多」时这个代价不小），而「第一页与总数都没变、后面却变了」极罕见。
   * @returns 这一页**真正新增**的歌（去重之后）；`null` = 这一次没取成（错误已写进 `error`）。
   *   loadAll 靠它知道自己推到了哪儿，也靠它判断「一页一首新的都没有 = 别再原地打转」。
   */
  const load = useCallback(
    async (offset: number, generationToken: number, silent = false): Promise<Song[] | null> => {
      try {
        const result = await getSongs(requireClient(), { ...query, limit: pageSize, offset })
        if (generationToken !== generation.current) return null
        // 取回来了就先清掉可能残留的错误提示：数据是好的，那条红字不该继续挂着
        setError(null)

        if (silent) {
          const unchanged =
            totalRef.current === result.total &&
            sameData(songsRef.current.slice(0, pageSize), result.songs)
          if (unchanged) return []
          commit(result.songs, result.total, 1)
          return []
        }

        const previous = songsRef.current
        if (offset === 0) {
          commit(result.songs, result.total, 1)
          return result.songs
        }
        const seen = new Set(previous.map((s) => s.id))
        const added = result.songs.filter((s) => !seen.has(s.id))
        commit([...previous, ...added], result.total, Math.floor(offset / pageSize) + 1)
        return added
      } catch (err) {
        if (generationToken !== generation.current) return null
        // 静默刷新失败不冒泡：手头这份还能用，别为一次后台动作在页面上弹红字
        if (silent) return null
        setError(err instanceof Error ? err.message : '加载失败')
        return null
      }
    },
    // query 通过 queryKey 参与依赖；直接放 query 对象会因每次渲染新引用而无限重跑
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [queryKey, pageSize, commit]
  )

  useEffect(() => {
    // 被藏起来的页面不发请求；切回来时 active 从 false 变 true，这个 effect 重跑
    if (!active) return

    const key = JSON.stringify([queryKey, pageSize, revision])
    const silent = key === lastKey.current
    lastKey.current = key
    const token = ++generation.current
    /*
     * 上一轮的分页请求从这一刻起作废（generation 换了），它回来时不会再走「取完了」那条路，
     * 也就不会自己把 loadingMore 收掉。这里显式收一次 —— 否则表尾会一直挂着「正在加载更多
     * 歌曲…」，而 loadMore 的闸（loadingMore）也跟着永远关着，列表就再也翻不动了。
     */
    setLoadingMore(false)

    if (silent) {
      void load(0, token, true)
      return
    }

    setLoading(true)
    commit([], 0, 0)
    void load(0, token).finally(() => {
      if (token === generation.current) setLoading(false)
    })
    return () => {
      generation.current += 1
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, queryKey, pageSize, revision, load])

  const loadMore = useCallback(() => {
    // 后台正在一次拉完时不另起一页：它本来就会把余下的都接上（见 restRun）
    if (loading || loadingMore || restRun.current) return
    setLoadingMore(true)
    const token = generation.current
    void load(songs.length, token).finally(() => {
      if (token === generation.current) setLoadingMore(false)
    })
  }, [load, loading, loadingMore, songs.length])

  /**
   * 后台把余下的分页一次拉完（见接口上的说明）。
   *
   * ★ 与滚动触发的那条走同一个 `load`：并进列表、去重、错误处理只有一份实现。
   *   区别只是这里由一个 while 循环推着走，而那边每滚到底一次推一页。
   * ★ 收手有三种：筛选条件变了（generation 变了，在途的结果一律作废）、这一页没取成、
   *   或者这一页**一首新的都没有**（后端在翻页期间增删过，再按同一个 offset 要只会原地打转）。
   * ★ 已经有一轮在拉（用户连点了两次「播放全部」）：不另起一轮 —— 等它拉完，再把
   *   **从这一刻起新到的那一段**交给这一轮回调。各自只关心自己没见过的歌，上一轮回调
   *   属于旧队列，不该再往新的里面塞。若那一轮属于已经作废的一代（中途换过筛选 / 刷新过），
   *   等它没有意义：直接按新的一份重新起一轮。
   */
  const loadAll = useCallback(
    async (onPage?: (songs: Song[]) => void): Promise<boolean> => {
      const token = generation.current
      /** 这一趟之后是不是真的到底了（取消 / 出错都不算） */
      const complete = (): boolean =>
        token === generation.current && songsRef.current.length >= totalRef.current

      const running = restRun.current
      if (running && running.token === token) {
        const from = songsRef.current.length
        const done = await running.done
        // 等待期间条件又变了：这一份列表已经不算数，就别再往队列里补
        if (token !== generation.current) return false
        const tail = songsRef.current.slice(from)
        if (tail.length > 0) onPage?.(tail)
        return done
      }

      const run = (async (): Promise<boolean> => {
        while (token === generation.current && songsRef.current.length < totalRef.current) {
          setLoadingMore(true)
          const before = songsRef.current.length
          const added = await load(before, token)
          if (token !== generation.current) return false
          if (!added) return false
          if (added.length > 0) onPage?.(added)
          // 后端没再给任何东西：别再按同一个 offset 反复要
          if (songsRef.current.length <= before) return false
        }
        return complete()
      })()
      const entry = { token, done: run }
      restRun.current = entry
      try {
        return await run
      } finally {
        // 只在「还是我这一轮」时才清：中途被新的一代顶掉时，那一位属于它
        if (restRun.current === entry) restRun.current = null
        if (token === generation.current) setLoadingMore(false)
      }
    },
    [load]
  )

  /**
   * 取整份列表（见接口上的说明）。拉不全就抛错，让调用方给出「重试」而不是拿半份去播放。
   *
   * ★ 返回的数组是 `songsRef.current` —— 就是列表此刻真的握着的那一份，
   *   与屏幕上看到的是同一份。
   */
  const fetchAll = useCallback(async (): Promise<Song[]> => {
    const token = generation.current
    const complete = await loadAll()
    if (!complete || token !== generation.current) throw new Error('列表没有加载完，请重试')
    return songsRef.current
  }, [loadAll])

  const refresh = useCallback(() => {
    const token = ++generation.current
    setLoading(true)
    // 同 effect 里那条：在途的分页作废之后，它那句「正在加载更多」不该留在屏幕上
    setLoadingMore(false)
    commit([], 0, 0)
    void load(0, token).finally(() => {
      if (token === generation.current) setLoading(false)
    })
  }, [load, commit])

  const patchSong = useCallback((song: Song) => {
    const next = songsRef.current.map((s) => (s.id === song.id ? song : s))
    songsRef.current = next
    setSongs(next)
  }, [])

  const removeSongs = useCallback((ids: number[]) => {
    const remove = new Set(ids)
    const next = songsRef.current.filter((s) => !remove.has(s.id))
    songsRef.current = next
    totalRef.current = Math.max(0, totalRef.current - ids.length)
    setSongs(next)
    setTotal(totalRef.current)
  }, [])

  const fetchAllIds = useCallback(async () => getSongIds(requireClient(), query), [query])

  const hasMore = songs.length < total

  return {
    songs,
    total,
    loading,
    loadingMore,
    error,
    hasMore,
    loadMore,
    refresh,
    patchSong,
    removeSongs,
    fetchAllIds,
    loadAll,
    fetchAll,
    pages
  }
}
