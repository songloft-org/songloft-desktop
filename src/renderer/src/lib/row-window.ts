/**
 * 长列表的**渲染窗口**（纯计算）—— 只算「这一帧该挂哪一段行」，DOM 那部分在
 * hooks/useRowWindow.ts 里。
 *
 * ★ 为什么要窗口化：曲库分页能一直往下加载，把几千行全挂进 DOM 会让每次（换曲 / 收藏 /
 *   选中）的整表重渲染都肉眼可见。原先的办法是「最多渲染前 1200 行」，可那到了 1200 之后
 *   **再也看不到后面的歌** —— 滚动、加载都在继续，行却永远不挂出来，看着就像加载停了。
 *   DOM 要有界，同时每一行都得够得着。
 *
 * ★ 行高是统一的（`.song-row` 的 `height: var(--row-h)`），所以窗口按行高折算即可，
 *   不必逐行去量 —— 这也是它能写成纯函数、能直接单测的原因。
 *
 * ★ 两个常量与界面观感绑着：
 *   · OVERSCAN：视口上下各多挂几行。用 rAF 跟着 scroll 重算，一帧的窗口位移不会超过它；
 *   · ACTIVATE_ABOVE：行数不超过它时**整个列表全挂**（等于这套机制不存在）—— 短列表本来
 *     就没有性能问题，不该为它引入任何折算误差，也让「刚过阈值」时的行为连续。
 */

/** 视口上下各多挂几行（快速滚动时那一帧不至于看见空白） */
export const ROW_WINDOW_OVERSCAN = 10

/** 超过这么多行才开窗口（以下全挂，行为与从前逐字一致） */
export const ROW_WINDOW_ACTIVATE_ABOVE = 240

export interface RowWindowInput {
  /** 列表总行数 */
  total: number
  /** 滚动容器当前的 scrollTop */
  scrollTop: number
  /** 滚动容器的可视高度 */
  containerHeight: number
  /** **第 0 行顶端**在滚动坐标里的位置（表格上面可能还有标题等，不能当成 0） */
  listTop: number
  /** 行高（px） */
  rowHeight: number
  overscan?: number
  activateAbove?: number
}

export interface RowWindowRange {
  /** 要挂的第一行（含） */
  start: number
  /** 要挂的最后一行（不含） */
  end: number
}

/**
 * 算出这一帧该挂 `[start, end)`。
 *
 * 不含的状态一律「全挂」（start 0 / end total）：短列表、行高还没量到、首帧 ——
 * 宁可多挂几行，也别因为一个 0 把列表算成空的。
 */
export function visibleRowRange(input: RowWindowInput): RowWindowRange {
  const { total, scrollTop, containerHeight, listTop, rowHeight } = input
  const overscan = input.overscan ?? ROW_WINDOW_OVERSCAN
  const activateAbove = input.activateAbove ?? ROW_WINDOW_ACTIVATE_ABOVE
  const all = { start: 0, end: Math.max(0, total) }

  if (total <= 0) return all
  if (!(rowHeight > 0) || total <= activateAbove) return all

  /*
   * `scrollTop - listTop` = 视口顶端落在列表里的位置。列表上面还有东西（页头、表头）时它
   * 是负数 —— 夹到 0 就是「第 0 行起」。
   */
  const first = Math.floor(Math.max(0, scrollTop - listTop) / rowHeight)
  // +1 是给「视口正好切在两行之间」留的余量
  const visible = Math.ceil(Math.max(0, containerHeight) / rowHeight) + 1
  const start = Math.max(0, Math.min(first, total - 1) - overscan)
  const end = Math.min(total, first + visible + overscan)
  // 极端参数（负 overscan 之类）下也别给出乱序区间
  return { start, end: Math.max(start, end) }
}
