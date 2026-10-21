/**
 * 列表里的「把某一项摆到该在的位置上」：居中 / 看得见 / 固定第几格。
 *
 * ★ 为什么自己找容器、自己算偏移，而**不用** `el.scrollIntoView()`：那个 API 会把
 *   「它所有的祖先滚动容器」依次滚一遍，视口也在内。两处都吃过这个坑：
 *     * 迷你窗（400×480）：队列项在文档坐标里远在窗口下方，那一下会连着视口一起滚，
 *       整条迷你播放器被顶出窗外（见 components/Panel.tsx）；
 *     * 歌曲表：`.page-slot` 外面还套着 `.main-scroll`，多滚一层就把别人的位置也带走。
 *   所以这里只认「第一个真的能滚的祖先」，也只滚它一个。
 *
 * ★ 三个 target 函数都只吃一份几何（**视口坐标**量出来的），滚动坐标由它们自己换算。
 *   这条分工是硬要求：混用两种坐标就会把 `scrollTop` 多算一遍 —— 队列抽屉踩过，
 *   表现为「当前曲明明高亮了，却在视口上方四千像素的地方」。
 *
 * ★ 纯计算与 DOM 分开写：前者能直接单测，不用任何环境垫片
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
 * 量出来的几何。`containerTop` / `rowTop` 是**视口坐标**，其余是滚动坐标或尺寸 ——
 * 换算只在下面那几个纯函数里做一次，调用方不要自己加加减减。
 */
export interface RowGeometry {
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

/** 目标项相对容器**滚动原点**的位置（与此刻滚到哪儿无关） */
function offsetOf(g: RowGeometry): number {
  return g.scrollTop + (g.rowTop - g.containerTop)
}

function maxScroll(g: RowGeometry): number {
  return Math.max(0, g.scrollHeight - g.containerHeight)
}

/** 夹进可滚范围：滚到 0 或 max 就停，不会为了对齐而拉出一片空白 */
function clampTop(top: number, g: RowGeometry): number {
  return Math.min(Math.max(top, 0), maxScroll(g))
}

/**
 * 让目标项**居中**所需的 scrollTop。
 *
 * ★ 项比容器还高时（窄窗口 + 一行很长）平均分的那半格是负数，会让行的顶部跑到
 *   容器顶上面去 —— 取 0 就是「行顶贴容器顶」，读起来才不别扭。
 */
export function centerTarget(g: RowGeometry): number {
  const slack = Math.max(0, (g.containerHeight - g.rowHeight) / 2)
  return clampTop(offsetOf(g) - slack, g)
}

/** 整行是否已经落在可视范围内（两条边都要在里面） */
export function rowVisible(g: RowGeometry): boolean {
  const viewTop = g.containerTop
  return g.rowTop >= viewTop && g.rowTop + g.rowHeight <= viewTop + g.containerHeight
}

/**
 * 「该不该动」的唯一判据：**已经整行在视野里 → null（一动不动）**，否则居中所需的 scrollTop。
 *
 * ★ 这就是「别每次打开都重新滚一遍」的全部实现：位置是容器自己记住的（页面槽与抽屉都
 *   还原上次的 scrollTop），这里只负责回答「按现在这个位置，那一项还需要被找回来吗」。
 * ★ 反过来，一旦要动就**居中**而不是「推回边缘」：贴着上/下边缘的那一下同样像「跳」，
 *   而且刚滚到边缘时再看到的那一行，上下文只剩一半。
 */
export function centerIfHiddenTarget(g: RowGeometry): number | null {
  return rowVisible(g) ? null : centerTarget(g)
}

/**
 * 固定落在**从上往下第 slot+1 格**所需的 scrollTop（上面留出 slot 行）。
 *
 * ★ 迷你面板用它：面板只有 416px 高，只保证「看得见」的话当前曲会贴着下边缘、
 *   甚至掉到视野之外。
 * ★ 只按行高算，**不牵扯可视高度** —— 迷你面板刚展开时那个高度还是 0，但列表是照
 *   自身高度铺开的，这个距离量得照样准；等容器长起来，它正好停在第 slot+1 格。
 */
export function slotTarget(g: RowGeometry, slot: number): number {
  return clampTop(offsetOf(g) - Math.max(0, slot) * g.rowHeight, g)
}

/** 量一次：目标项 + 它的滚动容器 + 一份几何 */
function measure(el: HTMLElement): { container: HTMLElement; geometry: RowGeometry } | null {
  const container = findScrollParent(el)
  if (!container) return null
  const cRect = container.getBoundingClientRect()
  const iRect = el.getBoundingClientRect()
  return {
    container,
    geometry: {
      scrollTop: container.scrollTop,
      containerTop: cRect.top,
      containerHeight: container.clientHeight,
      scrollHeight: container.scrollHeight,
      rowTop: iRect.top,
      rowHeight: iRect.height
    }
  }
}

/**
 * **只在看不见时**把 el 摆到容器中间；已经看得见就一动不动（位置留给上次留下的那份）。
 * 返回「有没有真的动」。
 */
export function scrollRowToCenterIfHidden(
  el: HTMLElement | null,
  behavior: ScrollBehavior = 'smooth'
): boolean {
  const m = el ? measure(el) : null
  // 容器还没有布局高度（页面槽刚挂上、或整块被藏起来）时没法谈「中间」，等下一次
  if (!m || m.geometry.containerHeight <= 0) return false
  const top = centerIfHiddenTarget(m.geometry)
  if (top === null || Math.abs(top - m.container.scrollTop) < 1) return false
  m.container.scrollTo({ top, behavior })
  return true
}

/** 把 el 摆到从上往下第 slot+1 格（见 slotTarget） */
export function scrollRowToSlot(
  el: HTMLElement | null,
  slot: number,
  behavior?: ScrollBehavior
): boolean {
  const m = el ? measure(el) : null
  if (!m) return false
  /* 容器还没有高度时（迷你面板刚展开那一下）用即时跳转：那时做平滑动画没有意义，
     而且动画可能被随后的尺寸变化打断，停在半路上。 */
  const effective = behavior ?? (m.geometry.containerHeight > 0 ? 'smooth' : 'instant')
  m.container.scrollTo({ top: slotTarget(m.geometry, slot), behavior: effective })
  return true
}
