/**
 * 全局小提示（tooltip）。
 *
 * 两个设计决定：
 *
 * 1. **浮层渲染到滚动容器之外。** 歌单列表是滚动容器，而滚动容器的 overflow **一定**
 *    会剪掉伸出它之外的伪元素 —— 并且两个轴不能只放开一个：当一个轴是 visible、
 *    另一个是 auto 时，visible 会被算成 auto，照样剪。所以它是挂在 App 根部的单例
 *    （与 ContextMenuHost 同一个路子），配合 fixed 定位就与被提示元素所处的滚动结构无关。
 *
 * 2. **触发靠 `data-tip` 属性 + 一份全局指针监听，而不是逐处挂 onMouseEnter。**
 *    全应用有几十处提示，逐处挂两个 handler 既啰嗦又必然漏；属性化之后写提示和写
 *    `title` 一样顺手，延时、定位、收场全由这里一处负责 —— 只有一份行为，也就不会
 *    出现「这一处能弹、那一处不弹」。（顺带把浏览器自带黑框换掉了：它的出现时机、
 *    停留时长、配色都不受应用控制，在浅色主题下尤其突兀。）
 *
 * 3. **跟着指针走，不贴在被提示元素上。**
 *    贴元素那套要按可用空间挑方位（原先有上下左右四个候选、一套 fitsAt/placeAt）—— 而
 *    「往哪边弹」这件事，指针位置本身就知道：默认右下方，放不下翻到另一侧，四边夹进视口。
 *    唯一保留的方位覆盖是 `data-tip-place="top-left"`：曲库右下角那颗定位钮贴着窗口底边，
 *    默认会落到播放条上，所以强制翻到指针左上方（见 placeTip）。
 *    更实际的理由是**不遮住要看的东西**：提示多数挂在某一行上，而那一行正是用户在看的内容，
 *    一块三百多像素宽的浮层贴在它旁边（尤其是插件管理那种五行信息的提示）会正好盖住它。
 *
 *    ★ 例外是 `flashTip` 那条**一次性提示**（键盘动作的回执，见那里的说明）：它没有锚点、
 *      触发时指针可能根本不在窗口里，所以固定落在**窗口正中**，不跟指针。
 *
 * 外观见 styles/components.css 的 `.tip`：颜色全走主题 token，浅色/深色各自成立；
 * 位置与显形由这里的 placeTip 直接写 DOM（见那里的说明）。
 */

import { useEffect, useLayoutEffect } from 'react'
import { create } from 'zustand'

/** 提示文案写在这个属性上：`<button data-tip="收起面板">` */
export const TIP_ATTR = 'data-tip'
/**
 * 强制把提示摆到指针的左上方（`data-tip-place="top-left"`）。
 *
 * 默认那套「右下，放不下再翻」对绝大多数元素都够用，但右下角那颗定位钮例外：
 * 它贴着窗口底边，提示照默认会落在播放条上。只给这一颗钮开口子，不动全局规则。
 */
export const TIP_PLACE_ATTR = 'data-tip-place'
/** 提示框与指针之间的间隙 */
const POINTER_GAP = 16
/** 与视口边缘至少留出来的空隙 */
const MARGIN = 8

/**
 * 悬停多久才弹。
 *
 * 侧栏紧贴着主内容区，鼠标横穿它（去点主区的东西、去够滚动条）是常事。条件反射式地
 * 立刻弹，结果是每次路过都闪出一片浮层；而「鼠标早走开了、浮层还留在屏幕上」也多半
 * 是这么来的 —— 人在等待期里就已经离开了。等一小会儿再弹，等待期内离开就整个不弹，
 * 连「要收掉的东西」都不存在。
 */
const SHOW_DELAY = 400

interface TipState {
  text: string
  /** 被提示的元素。宿主靠它判断指针是不是还停在上面 */
  anchor: HTMLElement | null
  /**
   * 键盘动作后的一次性提示（见 flashTip）。
   *
   * ★ 与 `text` 分开存：`text` 那条是「指针停在某元素上」的产物，指针一动就会被收掉；
   *   而键盘触发的那一条没有锚点、也不该被指针的移动清掉 —— 它只有一个收场方式：超时。
   */
  flash: string
  show: (text: string, anchor: HTMLElement) => void
  hide: () => void
}

export const useTooltip = create<TipState>((set) => ({
  text: '',
  anchor: null,
  flash: '',
  show: (text, anchor) => set({ text, anchor }),
  // 已经收起来时返回原状态对象：滚动等高频事件会反复喊 hide，不该每次都惊动订阅者
  hide: () => set((state) => (state.text === '' ? state : { text: '', anchor: null }))
}))

/**
 * 「一次性提示」默认多久收场（与「再按一次 Ctrl+A」那个确认窗口是同一个数，
 * 见 hooks/useSelectAllShortcut）。
 *
 * ★ 3 秒：那句话本身就是「快点再按一下」的指令，等太久反而让人以为已经确认过了。
 */
export const FLASH_TIMEOUT = 3000

let flashTimer: ReturnType<typeof setTimeout> | null = null

/**
 * 弹一条**一次性**提示：不走悬停那条路，也不需要锚点 —— 键盘动作之后用来交代
 * 「刚才那一下为什么没有立刻生效、接下来该按什么」。
 *
 * ★ 只有超时会收它（见上面 flash 的说明），所以它是可以带操作指令的一句话；
 *   新的提示顶掉旧的（不会叠两条）。
 * ★ 位置照旧用最后一次的指针坐标（见 placeTip）：键盘操作时指针往往还停在用户刚看的
 *   那一块上，提示弹在它旁边最容易被看到。
 */
export function flashTip(text: string, durationMs = FLASH_TIMEOUT): void {
  if (flashTimer !== null) clearTimeout(flashTimer)
  useTooltip.setState({ flash: text })
  flashTimer = setTimeout(() => {
    flashTimer = null
    useTooltip.setState({ flash: '' })
  }, durationMs)
}

/** 待弹的那一次。同一时刻最多只有一个（鼠标只可能停在一个地方） */
let showTimer: ReturnType<typeof setTimeout> | null = null
/** 已排期或正在显示的那个元素 */
let armedAnchor: HTMLElement | null = null

function cancelPendingShow(): void {
  if (showTimer !== null) {
    clearTimeout(showTimer)
    showTimer = null
  }
  armedAnchor = null
}

function hideTip(): void {
  cancelPendingShow()
  useTooltip.getState().hide()
}

/**
 * 指针当前在哪（视口坐标）。
 *
 * 全局一份、由 pointermove 一直刷新 —— 浮层要跟着它走，而「等 400ms 再弹」这段时间里
 * 指针可能已经挪开了，所以不能等到弹的那一刻才临时去问。
 */
let pointer = { x: 0, y: 0 }

/**
 * 浮层那个 div。放在模块级而不是 ref 里，是因为要动它的是**全局**监听（见 bindGlobalListeners），
 * 那里够不着组件内部的 ref。
 */
let tipElement: HTMLElement | null = null

/**
 * 浮层要摆到哪儿。
 *
 * 默认是**指针的右下方**，右边或下边装不下就翻到另一侧；四边都按「与视口至少留 MARGIN」
 * 夹一下 —— 指针贴着窗口边缘时，宁可压着指针也别把浮层推出屏幕。锚点显式写了
 * `data-tip-place="top-left"` 时（曲库右下角那颗定位钮）强制翻到左上方，免得压在播放条上。
 *
 * ★ 位置与显形都是**直接写 DOM**，不走 React state：指针每秒动上百次，走 state 就是每帧
 *   重渲染一次这个浮层。React 那边只管文本，位置由这里独家负责（初始不可见写在 .tip 里）。
 */
function placeTip(element: HTMLElement): void {
  const forcedTopLeft = useTooltip.getState().anchor?.getAttribute(TIP_PLACE_ATTR) === 'top-left'
  const flipX =
    forcedTopLeft || pointer.x + POINTER_GAP + element.offsetWidth > window.innerWidth - MARGIN
  const flipY =
    forcedTopLeft || pointer.y + POINTER_GAP + element.offsetHeight > window.innerHeight - MARGIN
  const left = flipX ? pointer.x - POINTER_GAP - element.offsetWidth : pointer.x + POINTER_GAP
  const top = flipY ? pointer.y - POINTER_GAP - element.offsetHeight : pointer.y + POINTER_GAP

  element.style.left = `${Math.max(MARGIN, left)}px`
  element.style.top = `${Math.max(MARGIN, top)}px`
  element.style.visibility = 'visible'
}

/**
 * 一次性提示（flashTip）摆到哪儿：**窗口正中**，不跟指针。
 *
 * ★ 为什么不跟指针：它是键盘动作的回执（「再按一次…」），触发时指针多半停在别处、
 *   甚至根本不在窗口里 —— 跟着指针走的话，那句话会弹在离视线很远的地方。正中是视线
 *   的自然落点，也不用去猜「内容区在哪」：侧栏展开/折叠、右侧抽屉宽度都在变，
 *   按主列的 rect 算居中反而会随这些无关的东西漂。
 * ★ 居中按浮层自己的宽高算（offsetWidth/offsetHeight）：所以 CSS 里不必再加一层
 *   `translate(-50%, -50%)`，也就不会和「left/top 由这里独家写」的约定打架。
 * ★ 它是 `pointer-events: none` 的，压在内容正中间也不吃点击、不妨碍标题栏拖拽。
 */
function placeFlash(element: HTMLElement): void {
  const left = (window.innerWidth - element.offsetWidth) / 2
  const top = (window.innerHeight - element.offsetHeight) / 2

  element.style.left = `${Math.round(left)}px`
  element.style.top = `${Math.round(top)}px`
  element.style.visibility = 'visible'
}

/**
 * 指针底下那个带提示的元素。
 *
 * 先看事件目标（绝大多数情况，也最便宜），它不行时再用坐标反查：
 * **disabled 的按钮/输入框在 Chromium 里不派发指针事件**（事件目标落到父节点上），
 * 而「这个按钮为什么点不了」恰恰是最需要提示的地方 —— `elementFromPoint` 走的是命中测试，
 * 不受事件派发规则影响。
 */
function tipTargetAt(event: PointerEvent): HTMLElement | null {
  const fromEvent =
    event.target instanceof Element ? event.target.closest<HTMLElement>(`[${TIP_ATTR}]`) : null
  if (fromEvent) return fromEvent
  return (
    document
      .elementFromPoint(event.clientX, event.clientY)
      ?.closest<HTMLElement>(`[${TIP_ATTR}]`) ?? null
  )
}

/** 排一次「等一小会儿再弹」；等待期内离开就整个不弹 */
function scheduleShow(anchor: HTMLElement): void {
  const text = anchor.getAttribute(TIP_ATTR) ?? ''
  if (!text) return
  // 指针还在同一个元素里挪（划到它的子节点上）：保持现状，不要重排计时器
  if (anchor === armedAnchor || anchor === useTooltip.getState().anchor) return
  // 换到别的元素：先把上一个收掉，别让旧提示挂在新位置旁边
  cancelPendingShow()
  useTooltip.getState().hide()
  armedAnchor = anchor
  showTimer = setTimeout(() => {
    showTimer = null
    // ★ 元素若已不在文档里（列表被重渲染）就什么也不弹 —— 它随时可能已经消失
    if (!anchor.isConnected) return
    useTooltip.getState().show(text, anchor)
  }, SHOW_DELAY)
}

let listenersBound = false

/**
 * 全局监听挂在模块级而不是某个组件的 effect 里：语义上它就只有一份，
 * 顺带也躲开 StrictMode 下 effect 的重复挂载与卸载。
 */
function bindGlobalListeners(): void {
  if (listenersBound) return
  listenersBound = true

  document.addEventListener('pointerover', (event) => {
    const target = tipTargetAt(event)
    if (target) {
      scheduleShow(target)
      return
    }
    // 走到没有提示的元素上：排期与浮层一起收掉
    hideTip()
  })

  /*
   * 指针位置一直记着（见 pointer），浮层跟着它走。
   *
   * ★ 一条监听同时干三件事，因为它们要的输入是同一个「指针现在在哪」：记位置、判断指针
   *   是否还停在被提示的元素上（要收掉）、把浮层重新摆一次。
   * ★ 每帧都在跑，所以这里只做常数级的事：不重排布局（不读 getBoundingClientRect），
   *   而是直接写 left/top —— 写样式不会触发同步布局。
   */
  document.addEventListener('pointermove', (event) => {
    pointer = { x: event.clientX, y: event.clientY }

    const { anchor } = useTooltip.getState()
    if (!anchor) return

    /*
     * 指针离开锚点就收掉。★ 光有 pointerout 不够，原因是「leave 不一定会来」：
     *   1. 布局一变（窗口变宽触发的侧栏自动展开）元素就从指针底下挪走了，这不派发 out；
     *   2. 指针停在 disabled 控件上时事件目标是它的父节点，拿 target 判包含关系会误判。
     *   所以按坐标算指针在不在锚点里，不在就收。
     */
    const underPointer = document.elementFromPoint(event.clientX, event.clientY)
    const inside =
      (event.target instanceof Node && anchor.contains(event.target)) ||
      (underPointer !== null && anchor.contains(underPointer))
    if (!inside) {
      hideTip()
      return
    }

    if (tipElement) placeTip(tipElement)
  })

  // relatedTarget 为空 = 指针离开了窗口（去点别的应用）。这一下不会派发 pointerover，
  // 没有它的话浮层会一直挂在屏幕上
  document.addEventListener('pointerout', (event) => {
    if (event.relatedTarget === null) hideTip()
  })

  // 按下鼠标意味着接下来大概率是「界面要变了」（点了按钮、开了菜单），
  // 而元素挪走后浮层留在原地就是错的。收掉比跟踪位置省事得多
  document.addEventListener('pointerdown', hideTip, true)

  // 滚动会让被提示元素从浮层底下挪走；窗口尺寸变化、失去焦点同理。都直接收掉最省事，
  // 也不用去跟踪那些位置。
  window.addEventListener('scroll', hideTip, true)
  window.addEventListener('resize', hideTip)
  window.addEventListener('blur', hideTip)
}

export function TooltipHost(): React.JSX.Element | null {
  const text = useTooltip((state) => state.text)
  const flash = useTooltip((state) => state.flash)
  /** 悬停提示优先：它正跟着指针，比一条正在倒计时的一次性提示更「当下」 */
  const content = text || flash

  useEffect(() => bindGlobalListeners(), [])

  /**
   * 先挂载再摆位置：框多大只有渲染出来才知道（要不要翻到指针另一侧就靠它）。
   * 在 layout effect 里量完再摆，发生在浏览器绘制之前，所以不会闪一下。
   *
   * ★ 位置与显形都直接写 DOM（见 placeTip），这里只是「新文本渲染出来之后摆一次」；
   *   在此之前指针每动一下都由全局 pointermove 重摆，不经过 React。
   */
  useLayoutEffect(() => {
    if (!tipElement) return
    /*
     * 两条通道两个落点：
     *   · 悬停提示跟着指针（placeTip）；
     *   · 一次性提示（flashTip）在窗口正中（placeFlash）—— 它是键盘动作的回执，
     *     没有锚点也没有指针位置可言。
     */
    if (!text && flash) placeFlash(tipElement)
    else placeTip(tipElement)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content])

  if (!content) return null
  // aria-hidden：这一层纯粹是补视觉。名字该由元素自己的 aria-label 承担
  // （转换前挂在 title 上的那批，都补了 aria-label）
  // 初始不可见写在 .tip 里：要等 placeTip 量完尺寸才亮，否则会先在左上角闪一下
  return (
    <div
      ref={(element) => {
        tipElement = element
      }}
      className="tip"
      data-flash={!text && flash ? 'true' : undefined}
      aria-hidden="true"
    >
      {content}
    </div>
  )
}
