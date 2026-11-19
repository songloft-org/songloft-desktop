/**
 * 长列表的**渲染窗口**：只挂视口附近的那几十行，上下用两块空白把高度撑住。
 *
 * 为什么需要它：曲库分页 200 一页、能一直往下加载，而把几千行全挂进 DOM，会让每次
 * （换曲 / 收藏 / 选中）的整表重渲染都变得肉眼可见，滚动也发涩。原先的办法是「最多渲染
 * 前 1200 行」，可那到了 1200 之后就**再也看不到后面的歌** —— 滚到底只看见一句
 * 「已渲染前 1200 首」，用户以为加载停了（数据其实还在往后拉，只是永远不挂出来）。
 * 窗口化两头都要：DOM 有界，而每一行都到得了。
 *
 * ★ 行高是统一的（`.song-row` 的 `height: var(--row-h)`），所以窗口按行高折算即可，不必
 *   逐行去量。行高会随**界面密度**变（紧凑 38 / 舒适 46），所以每次更新都顺手量一行
 *   （量到就以它为准），而不是从 CSS 常量猜。
 * ★ 滚动容器是**页面槽**（`.page-slot`），不是 window —— 用 lib/scroll.ts 的
 *   `findScrollParent` 往上找，与「当前曲居中」用的是同一个定义。
 * ★ 窗口**跟着滚动走**：上下那两块占位的高度 = 窗口外的行数 × 行高，所以滚动条长度与
 *   内容高度与「全部挂出来」时完全一致，滚到哪儿都不会跳。
 * ★ 行数不超过 lib/row-window.ts 那个阈值时**整个列表照旧全挂**（等于这套机制不存在）：
 *   短列表本来就没有性能问题，也就不该为它引入任何折算误差。窗口怎么算是那边的纯函数
 *   （有单测），这里只管「量几何 + 跟着滚动重算 + 滚到某一行」。
 */

import { useCallback, useLayoutEffect, useRef, useState } from 'react'

import { visibleRowRange } from '@/lib/row-window'
import { centerIfHiddenTarget, findScrollParent, type RowGeometry } from '@/lib/scroll'

/** 开窗口时首帧先挂这么多行 —— 总得有东西可量（行高与锚点） */
const INITIAL = 40
/** 量不到行高时的兜底（与 --row-h 舒适档一致；下一帧就会量到真值） */
const FALLBACK_ROW_HEIGHT = 46

export interface RowWindow {
  /** 挂到列表根节点上（`<div className="song-table" ref={...}>`） */
  tableRef: React.RefObject<HTMLDivElement | null>
  /** 这一帧该挂的行区间 `[start, end)` */
  start: number
  end: number
  /** 行高（px）：上下两块占位按它折算 */
  rowHeight: number
  /** 把某一行滚到视口中间（**窗口之外的行也能滚过去** —— 那时它还没挂上） */
  centerRow: (index: number) => void
}

export function useRowWindow(total: number): RowWindow {
  const tableRef = useRef<HTMLDivElement>(null)
  /** 滚动容器（页面槽）：挂载时找一次 */
  const scrollerRef = useRef<HTMLElement | null>(null)
  /** 已经排上的那一帧（0 = 没有）：scroll 事件很密，合到每帧算一次 */
  const queued = useRef(0)
  const [rowHeight, setRowHeight] = useState(FALLBACK_ROW_HEIGHT)
  const [range, setRange] = useState(() => ({ start: 0, end: Math.min(total, INITIAL) }))

  /**
   * 量一次几何并重算窗口。
   *
   * 锚点是**窗口里现有的第一行**（`[data-song-index]`）：由它的下标与位置反推「第 0 行的
   * 顶端在滚动坐标里的位置」，于是不管窗口现在停在哪一段都算得准。锚点缺失时（首帧、或
   * 表格还没挂上）退回表格顶端，下一帧再纠正。
   */
  const update = useCallback(() => {
    queued.current = 0
    const table = tableRef.current
    const scroller = scrollerRef.current
    if (!table || !scroller) return

    const anchor = table.querySelector<HTMLElement>('[data-song-index]')
    const height = anchor?.offsetHeight || rowHeight
    if (!(height > 0)) return
    // 密度切换会改行高：量到新的就记下来（它是下面所有折算的依据）
    if (anchor && height !== rowHeight) setRowHeight(height)

    const cRect = scroller.getBoundingClientRect()
    const anchorIndex = anchor ? Number(anchor.dataset.songIndex) : 0
    const anchorTop = anchor
      ? anchor.getBoundingClientRect().top
      : table.getBoundingClientRect().top
    // 第 0 行顶端（滚动坐标）：视口坐标 → 相对容器 → 加回 scrollTop
    const listTop = anchorTop - cRect.top + scroller.scrollTop - anchorIndex * height

    // 窗口怎么算是纯函数（lib/row-window.ts）：短列表 / 行高没量到时它直接给「全挂」
    const next = visibleRowRange({
      total,
      scrollTop: scroller.scrollTop,
      containerHeight: scroller.clientHeight,
      listTop,
      rowHeight: height
    })
    setRange((prev) => (prev.start === next.start && prev.end === next.end ? prev : next))
  }, [rowHeight, total])

  useLayoutEffect(() => {
    const table = tableRef.current
    if (!table) return
    scrollerRef.current = findScrollParent(table)
    const scroller = scrollerRef.current

    const schedule = (): void => {
      if (queued.current === 0) queued.current = window.requestAnimationFrame(update)
    }

    // 先算一次（页面槽可能还带着上次的 scrollTop —— 切回本页时窗口要直接落在那一屏）
    update()
    scroller?.addEventListener('scroll', schedule, { passive: true })
    // 视口变高变矮、窗口被拖动改尺寸：可见行数变了，窗口跟着重算
    const observer = new ResizeObserver(schedule)
    observer.observe(scroller ?? table)

    return () => {
      scroller?.removeEventListener('scroll', schedule)
      observer.disconnect()
      if (queued.current !== 0) {
        window.cancelAnimationFrame(queued.current)
        queued.current = 0
      }
    }
  }, [update])

  /**
   * 把第 `index` 行摆到中间。
   *
   * ★ 窗口之外的行**根本没挂上**，`querySelector` 找不到它 —— 所以按几何算，而不是靠元素。
   * ★ 「已经看得见就别动」仍然交给 lib/scroll.ts 的纯函数：拿同一份几何，语义与那个
   *   `scrollRowToCenterIfHidden` 完全一致（只是这边不需要元素在 DOM 里）。
   */
  const centerRow = useCallback(
    (index: number) => {
      const table = tableRef.current
      const scroller = scrollerRef.current
      if (!table || !scroller) return
      const anchor = table.querySelector<HTMLElement>('[data-song-index]')
      const height = anchor?.offsetHeight || rowHeight
      if (!(height > 0)) return
      const cRect = scroller.getBoundingClientRect()
      const anchorIndex = anchor ? Number(anchor.dataset.songIndex) : 0
      const anchorTop = anchor
        ? anchor.getBoundingClientRect().top
        : table.getBoundingClientRect().top
      const geometry: RowGeometry = {
        scrollTop: scroller.scrollTop,
        containerTop: cRect.top,
        containerHeight: scroller.clientHeight,
        scrollHeight: scroller.scrollHeight,
        rowTop: anchorTop - anchorIndex * height + index * height,
        rowHeight: height
      }
      const top = centerIfHiddenTarget(geometry)
      if (top === null) return
      scroller.scrollTo({ top, behavior: 'smooth' })
    },
    [rowHeight]
  )

  return { tableRef, start: range.start, end: range.end, rowHeight, centerRow }
}
