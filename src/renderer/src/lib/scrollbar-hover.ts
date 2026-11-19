/**
 * 「指针正压在滚动条的槽上」—— 一件 CSS 自己表达不了的事。
 *
 * 这里只做一件事：给**那个**滚动容器打一个 `data-scrollbar-hover="true"`，样式据此把滑块
 * 变实、变宽（见 base.css 的滚动条那一段）。为什么必须是 JS：
 *
 *   · `::-webkit-scrollbar:hover` Chromium 不认，`::-webkit-scrollbar:hover::-webkit-scrollbar-thumb`
 *     这种组合更会被**整条丢弃**（选择器非法，规则连同声明一起作废 —— 实测见
 *     .sidebar-playlists 那段注释）；
 *   · 容器自己的 `:hover` 倒是成立，但指针落在**内容**上时它也成立 —— 于是「鼠标一进列表
 *     滚动条就变粗」。主内容区几乎整屏都是可滚区域，那等于一直粗着，反而没有提示作用。
 *
 * 所以这里按**几何**判：从指针下的元素往上找，第一个「真的在滚、且指针落在它右侧（或下方）
 * 那条槽里」的容器就是目标。槽宽用 `offsetWidth - clientWidth - 边框` 算，不写死 10px ——
 * 侧栏那条自己改过槽宽（= --sidebar-pad-x），以后别处再改也不用回来动这里。
 *
 * ★ 每帧最多算一次（`pointermove` 会连发），只读几何、不写布局，也不 `preventDefault`：
 *   滚动条的拖动与点击是浏览器自己的事，碰它就会把拖拽吃掉。
 * ★ 指针离开窗口 / 窗口失焦时清掉标记：否则切到别的窗口再回来，滚动条还停在「悬浮」那一档。
 * ★ 两个窗口都装（主窗口与迷你窗共用 main.tsx）：迷你窗的面板也是自己滚的。
 */

/** 打在滚动容器上的标记（属性值固定 'true'，样式用 `[data-scrollbar-hover='true']` 挑） */
const ATTR = 'data-scrollbar-hover'

/** 半像素容差：offset* 是取整过的，高 DPI 缩放下可能与 rect 差不到 1px */
const TOLERANCE = 0.5

/**
 * 指针落在这个元素的滚动条槽上吗（纵向那条在右边缘，横向那条在下边缘）。
 *
 * ★ `overflow: hidden` 的元素也会 scrollHeight > clientHeight（内容被裁掉了），但它**没有**
 *   滚动条、也不占滚动槽 —— 只看尺寸差会把它错认成一整条可拖的槽，所以还要看 overflow。
 */
function onScrollbar(el: HTMLElement, x: number, y: number): boolean {
  const scrollsY = el.scrollHeight > el.clientHeight
  const scrollsX = el.scrollWidth > el.clientWidth
  if (!scrollsY && !scrollsX) return false

  const style = getComputedStyle(el)
  const vertical = scrollsY && /auto|scroll/.test(style.overflowY)
  const horizontal = scrollsX && /auto|scroll/.test(style.overflowX)
  if (!vertical && !horizontal) return false

  const rect = el.getBoundingClientRect()
  const borderLeft = parseFloat(style.borderLeftWidth) || 0
  const borderRight = parseFloat(style.borderRightWidth) || 0
  const borderTop = parseFloat(style.borderTopWidth) || 0
  const borderBottom = parseFloat(style.borderBottomWidth) || 0

  // 槽宽 = 盒子宽 − 内容宽 − 两侧边框（offsetWidth 含边框与槽，clientWidth 两样都不含）
  if (vertical) {
    const gutter = el.offsetWidth - el.clientWidth - borderLeft - borderRight
    const edge = rect.right - borderRight
    if (
      gutter > 0 &&
      x >= edge - gutter - TOLERANCE &&
      x <= edge + TOLERANCE &&
      y >= rect.top &&
      y <= rect.bottom
    )
      return true
  }
  if (horizontal) {
    const gutter = el.offsetHeight - el.clientHeight - borderTop - borderBottom
    const edge = rect.bottom - borderBottom
    if (
      gutter > 0 &&
      y >= edge - gutter - TOLERANCE &&
      y <= edge + TOLERANCE &&
      x >= rect.left &&
      x <= rect.right
    )
      return true
  }
  return false
}

/**
 * 装上这条全局监听，返回解绑函数（HMR / 严格模式下重复装卸都安全）。
 *
 * 同一时刻只会有一个容器带着标记：指针移到别处时先把旧的摘掉。
 */
export function installScrollbarHoverTracking(): () => void {
  /** 此刻带着标记的容器 */
  let marked: HTMLElement | null = null
  /** 已经排上的那一帧（0 = 没有） */
  let queued = 0
  /** 最新一次指针位置与它落在谁身上（rAF 里用，不持有事件对象） */
  let pointer: { x: number; y: number; target: Element | null } | null = null

  const unmark = (): void => {
    if (marked) {
      marked.removeAttribute(ATTR)
      marked = null
    }
  }

  /**
   * 指针下（含其祖先）第一个「指针正压在它槽上」的滚动容器。
   *
   * ★ 起点优先用事件的 target：指针压在那条槽上时，这个点仍然属于滚动容器的盒子（滚动条不是
   *   DOM 节点，事件照常发给容器 —— 容器自己的 :hover 也因此在槽上成立），所以 target 就是它。
   * ★ 没有 target 时（合成事件）退回 `elementsFromPoint` 那一摞：逐个往上找，比只取最上面
   *   那一个稳 —— 槽这种特殊区域上「谁在最上面」不完全可控，而容器往往就在那一摞里。
   */
  const find = (x: number, y: number, target: Element | null): HTMLElement | null => {
    const starts: Element[] = target ? [target] : document.elementsFromPoint(x, y)
    for (const start of starts) {
      let node: Element | null = start
      while (node) {
        if (node instanceof HTMLElement && onScrollbar(node, x, y)) return node
        node = node.parentElement
      }
    }
    return null
  }

  const apply = (): void => {
    queued = 0
    if (!pointer) return
    const next = find(pointer.x, pointer.y, pointer.target)
    if (next === marked) return
    unmark()
    if (next) {
      marked = next
      next.setAttribute(ATTR, 'true')
    }
  }

  const schedule = (event: PointerEvent): void => {
    pointer = {
      x: event.clientX,
      y: event.clientY,
      target: event.target instanceof Element ? event.target : null
    }
    if (queued === 0) queued = window.requestAnimationFrame(apply)
  }

  const reset = (): void => {
    pointer = null
    if (queued !== 0) {
      window.cancelAnimationFrame(queued)
      queued = 0
    }
    unmark()
  }

  window.addEventListener('pointermove', schedule, { passive: true })
  // 按下也校正一次：滚过之后指针停在原地，位置一样而槽里的内容动过 —— 顺手重算不吃亏
  window.addEventListener('pointerdown', schedule, { passive: true })
  document.addEventListener('pointerleave', reset)
  window.addEventListener('blur', reset)

  return () => {
    window.removeEventListener('pointermove', schedule)
    window.removeEventListener('pointerdown', schedule)
    document.removeEventListener('pointerleave', reset)
    window.removeEventListener('blur', reset)
    if (queued !== 0) window.cancelAnimationFrame(queued)
    queued = 0
    pointer = null
    unmark()
  }
}
