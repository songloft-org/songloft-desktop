/**
 * 列表里的「把某一项滚到看得见 / 滚到中间」。
 *
 * ★ 为什么自己找容器、自己算偏移，而**不用** `el.scrollIntoView()`：那个 API 会把
 *   「它所有的祖先滚动容器」依次滚一遍，视口也在内。两处都吃过这个坑：
 *     * 迷你窗（400×480）：队列项在文档坐标里远在窗口下方，那一下会连着视口一起滚，
 *       整条迷你播放器被顶出窗外（见 components/Panel.tsx）；
 *     * 歌曲表：`.page-slot` 外面还套着 `.main-scroll`，多滚一层就把别人的位置也带走。
 *   所以这里只认「第一个真的能滚的祖先」，也只滚它一个。
 *
 * ★ 纯计算（centerTarget）与 DOM 分开写：前者能直接单测，不用任何环境垫片
 *   （vitest 跑的是 node 环境，见 vitest.config.ts）。
 */

/** 往上找第一个真的能滚的祖先（`overflow-y: auto | scroll`） */
export function findScrollParent(el: HTMLElement | null): HTMLElement | null {
  for (let node = el?.parentElement ?? null; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node)
    if (overflowY === 'auto' || overflowY === 'scroll') return node
  }
  return null
}

/**
 * 量出来的几何（一律是**视口坐标**，跟滚动位置无关的那几项单独标了）。
 * 这样写是为了让「算 target」这一步不必碰 DOM：调用方量一次、这里算一次。
 */
export interface CenterGeometry {
  /** 容器当前 scrollTop（滚动坐标） */
  scrollTop: number
  /** 容器顶部（视口坐标） */
  containerTop: number
  /** 容器可视高度 */
  containerHeight: number
  /** 容器可滚动的总高度（滚动坐标） */
  scrollHeight: number
  /** 目标项顶部（视口坐标） */
  rowTop: number
  /** 目标项高度 */
  rowHeight: number
}

/**
 * 让目标项**居中**所需的 scrollTop。
 *
 * ★ 天然夹在 [0, max] 里，于是「当前曲靠近首尾」时不会滚出可滚范围 —— 浏览器
 *   本身也会夹，但这里显式夹是为了让调用方能拿这个值判断「要不要动」。
 *   这正是「不留空白占位」的全部实现：滚到 0 或 max 就停，不会为了居中而越界。
 *
 * ★ 项比容器还高时（窄窗口 + 一行很长）平均分的那半格是负数，会让行的顶部跑到
 *   容器顶上面去 —— 取 0 就是「行顶贴容器顶」，读起来才不别扭。
 */
export function centerTarget(g: CenterGeometry): number {
  const offset = g.scrollTop + (g.rowTop - g.containerTop)
  const slack = Math.max(0, (g.containerHeight - g.rowHeight) / 2)
  const max = Math.max(0, g.scrollHeight - g.containerHeight)
  return Math.min(Math.max(offset - slack, 0), max)
}

/**
 * 把 el 滚到它所在滚动容器的中间。
 *
 * 返回「有没有真的动」：调用方据此决定要不要接着做别的事（目前没人需要，
 * 但失败与「本来就在中间」是两件不同的事，别混成一个 void）。
 */
export function scrollToCenter(
  el: HTMLElement | null,
  behavior: ScrollBehavior = 'smooth'
): boolean {
  const container = findScrollParent(el)
  if (!el || !container) return false
  // 容器还没有布局高度（页面槽刚挂上、或整块被藏起来）时没法谈「中间」，等下一次
  if (container.clientHeight <= 0) return false

  const cRect = container.getBoundingClientRect()
  const iRect = el.getBoundingClientRect()
  const top = centerTarget({
    scrollTop: container.scrollTop,
    containerTop: cRect.top,
    containerHeight: container.clientHeight,
    scrollHeight: container.scrollHeight,
    rowTop: iRect.top,
    rowHeight: iRect.height
  })

  if (Math.abs(top - container.scrollTop) < 1) return false
  container.scrollTo({ top, behavior })
  return true
}
