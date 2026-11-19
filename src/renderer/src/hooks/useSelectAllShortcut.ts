/**
 * 歌曲列表的 `Ctrl/⌘ + A` 全选。
 *
 * 两种情形，**必须分开处理**（这也是这个 hook 存在的全部理由）：
 *
 *   1. 整份列表已经在手 → 一下全选那些行。选出来的是完整对象，播放 / 入队立刻可用。
 *   2. 后端还有没拉完的分页 → 手上只有一部分。
 *      **第一下立刻把手上这批选上**（高亮 + 多选控制栏随实际数量出现）——「按了 Ctrl+A」
 *      本来就该当场有结果，先弹一句问询、等第二下才动手的写法，第一下看着完全没反应。
 *      但那还不是「全选」：整份筛选里还有没加载的部分。所以第一下顺带弹一条 3 秒的提示
 *      「再按一次 Ctrl + A 选中全部 N 首」，第二下（3 秒内）才把范围扩到整份筛选
 *      （去后端取全部 id）—— 一个键盘版的确认框：不用把指针移过去点按钮，
 *      超时不管它就是「就要手上这些了」。第二下会把问询那条**顶掉**，换成
 *      「已选中全部 N 首」，不让人对着一条已经过期的问询再按一次。
 *
 * ★ 快捷键监听挂在 window 上、但只在 `active` 为真时生效：原生页各占一个常驻页面槽
 *   （见 App 的 PageSlot），藏起来的那几页同样会收到 keydown —— 不挡的话，在设置页按
 *   Ctrl+A 会把曲库页的列表也选中。
 * ★ 事件处理器每次渲染都刷新（存在 ref 里），而监听本身只随 active 装卸：列表一页页加载时
 *   `songs` / `total` 一直变，若把它们放进依赖，监听会被反复拆装，而这期间正好按下的那一下
 *   就可能落在空档里。
 * ★ 一律 `preventDefault()`：不拦的话 Chromium 会去「选中页面上的文字」，把整页文字刷蓝。
 * ★ 焦点在输入框 / 文本域 / 下拉框里时让开 —— 那里 Ctrl+A 是「全选这段文字」，是本行本业的
 *   常规操作，抢过来会很讨厌（判断与全局快捷键共用 lib/keyboard 的那一份）。
 */

import { useEffect, useRef } from 'react'

import type { Song } from '@shared/types'

import { FLASH_TIMEOUT, flashTip } from '@/components/Tooltip'
import { isTypingTarget } from '@/lib/keyboard'

/** 「再按一次」的有效期 = 那条提示自己消失的时间（同一个数只写在一处，见 Tooltip 的 FLASH_TIMEOUT） */
const CONFIRM_TIMEOUT = FLASH_TIMEOUT

export interface SelectAllShortcutOptions {
  /** 这一页现在看不看得见（页面槽常驻，藏起来的那些不该抢快捷键） */
  active: boolean
  /** 手上已经有的歌（全选「已加载的那些」用它） */
  songs: Song[]
  /** 这一份筛选的总首数（可能比手上多） */
  total: number
  /**
   * 后端还有没有下一页（列表 hook 算好的那一位）。
   *
   * ★ 不在这里自己按 `songs.length < total` 再算一遍：`total` 与分页游标的口径都由
   *   列表 hook 统一负责，两边各算一份迟早会漂开。
   */
  hasMore: boolean
  /** 全选**已经在手**的那些行（行选中：能直接播放 / 入队） */
  onSelectAllRows: () => void
  /** 全选**整份筛选结果**（只有 id，得让后端再过一遍） */
  onSelectAllIds: () => void | Promise<void>
}

export function useSelectAllShortcut(options: SelectAllShortcutOptions): void {
  const { active } = options
  /** 最新一次的入参与回调：处理器从这里读，监听器因此不必随每次渲染重绑 */
  const latest = useRef(options)
  useEffect(() => {
    latest.current = options
  })

  /** 已经问过一次、正等第二下确认 */
  const armed = useRef(false)
  /** 那 3 秒的计时器（见 CONFIRM_TIMEOUT） */
  const timer = useRef<number | null>(null)

  const disarm = (): void => {
    armed.current = false
    if (timer.current !== null) {
      window.clearTimeout(timer.current)
      timer.current = null
    }
  }

  useEffect(() => {
    if (!active) {
      // 切走了：上一次的「再按一次」作废，免得回来时对着一条看不见的提示按下去
      disarm()
      return
    }

    const onKeyDown = (event: KeyboardEvent): void => {
      const mod = event.ctrlKey || event.metaKey
      if (!mod || event.altKey) return
      /*
       * 认键看两样：
       *   · `key` 转小写 —— CapsLock、Shift 都可能给出大写 `A`，那仍是「按了 A」；
       *   · `code` 兜底 —— 非拉丁键盘布局下 Ctrl+A 报出来的 `key` 是别的字母
       *     （俄文 `ф`、希腊文 `α`…），而物理位置 `KeyA` 不变。
       * `shiftKey` 刻意**不**拦：Ctrl+Shift+A 也是「全选」的常见按法。
       */
      if (event.key.toLowerCase() !== 'a' && event.code !== 'KeyA') return
      if (isTypingTarget(event.target)) return

      const { songs, total, hasMore, onSelectAllRows, onSelectAllIds } = latest.current
      // 列表还没到 / 空了：没有可选的，连默认行为也不用拦
      if (total === 0) return

      event.preventDefault()

      /*
       * ★ 第一下就**立刻**把手上已经加载的那些全选上（高亮 + 多选控制栏）。
       *   这是「按了 Ctrl+A」的直接结果，不该等第二次才见效 —— 先前的写法是先弹一句问询、
       *   第二下才动手，于是第一下看上去毫无反应。
       *   至于「整份筛选（含还没加载的）」那一层，才是需要第二下确认的部分（见下面）。
       */
      onSelectAllRows()

      // 整份都在手：这一下就已经全选完了
      if (!hasMore && songs.length >= total) {
        disarm()
        return
      }

      // 还有没拉完的。已经问过一次 → 这一下是「是」：把范围扩到整份筛选
      if (armed.current) {
        disarm()
        void onSelectAllIds()
        /*
         * 顶掉「再按一次」那条：问询已经得到回答，屏幕上继续挂着它就像还没生效。
         * flashTip 会清掉上一条的超时并重排 3 秒，所以这里天然是替换而不是叠两条。
         */
        flashTip(`已选中全部 ${total} 首`, CONFIRM_TIMEOUT)
        return
      }

      // 还没问过：问一句。几秒内没有第二下就当作「就这样吧」（手上这些已经选上了）
      armed.current = true
      if (timer.current !== null) window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => {
        timer.current = null
        armed.current = false
      }, CONFIRM_TIMEOUT)
      // 只说「再按一次会选中全部 N 首」：还差多少首是内部账，用户关心的是「全选到哪」
      flashTip(`再按一次 Ctrl + A 选中全部 ${total} 首`, CONFIRM_TIMEOUT)
    }

    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      disarm()
    }
  }, [active])
}
