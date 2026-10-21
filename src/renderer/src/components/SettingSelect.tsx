/**
 * 设置项里的下拉选框。
 *
 * 为什么不用原生 `<select>`：这里几个选项的差别**不在名字上** —— 三档「歌单创建方式」
 * 都带「文件夹」二字，真正不同的是「一首歌会进哪几个歌单」；原生 `<option>` 塞不下
 * 第二行说明，选中态也只能靠文字本身。而这两件事（说明 + 打勾）正是选择成本最高、
 * 最该交代清楚的地方。
 *
 * 面板复用 `ContextMenuHost`（与标题栏的折叠菜单同一条路）：它已经把贴边翻转、点别处
 * 关闭、Esc、窗口缩放/失焦收起都处理过了，再造一个下拉就是两份要同步维护的行为。
 * 代价是必须把触发器元素一起传进去 —— 否则「再点一次收起」做不出来（见 ContextMenu 的 anchor）。
 */

import { useRef } from 'react'

import { useContextMenu, type MenuItem } from './ContextMenu'
import { IconChevronDown } from './Icons'

export interface SelectOption<T extends string | number> {
  value: T
  label: string
  /** 面板里的第二行说明（可选）。整份选项要么都别给、要么都给出，否则条目高低不齐 */
  desc?: string
}

export interface SettingSelectProps<T extends string | number> {
  value: T
  options: readonly SelectOption<T>[]
  onChange: (value: T) => void
  /** 触发器上的按钮没有文字标签，无障碍名只能从这里来 */
  ariaLabel: string
  disabled?: boolean
  /** 触发器宽度（px）；不传则按内容自适应 */
  width?: number
  /** 触发器自身的样式（例如在 flex 行里要 `flex: none`，别被同行的输入框挤窄） */
  style?: React.CSSProperties
}

export function SettingSelect<T extends string | number>({
  value,
  options,
  onChange,
  ariaLabel,
  disabled,
  width,
  style
}: SettingSelectProps<T>): React.JSX.Element {
  const ref = useRef<HTMLButtonElement>(null)
  // 只为把 aria-expanded 说准：读宿主的真实状态，不另存一份「我开着」的本地状态
  const expanded = useContextMenu((s) => s.open && s.anchor === ref.current)
  const current = options.find((option) => option.value === value)

  const toggle = (event: React.MouseEvent<HTMLButtonElement>): void => {
    const menu = useContextMenu.getState()
    // 宿主对「点触发器」刻意不关（anchor 放行），所以这里读到的仍是开着 → 收起。
    // 点的是**别的**触发器时轮不到我们：那一下会先被宿主的捕获监听关掉，这里读到 false。
    if (menu.open) {
      menu.hide()
      return
    }
    const items: MenuItem[] = options.map((option) => ({
      key: String(option.value),
      label: option.label,
      desc: option.desc,
      // 每一项都要给 checked（含 false），勾位列才会整层对齐
      checked: option.value === value,
      onClick: () => onChange(option.value)
    }))
    const rect = event.currentTarget.getBoundingClientRect()
    // 右对齐：触发器长在设置行的右端，左对齐会让面板往卡片外探出一截
    menu.show(rect.left, rect.bottom + 6, items, {
      anchor: event.currentTarget,
      align: 'right',
      anchorRect: rect
    })
  }

  return (
    <button
      ref={ref}
      type="button"
      className="select-trigger"
      style={width || style ? { ...(width ? { width } : null), ...style } : undefined}
      disabled={disabled}
      aria-label={ariaLabel}
      aria-haspopup="menu"
      aria-expanded={expanded}
      onClick={toggle}
    >
      <span className="truncate">{current?.label ?? ''}</span>
      <IconChevronDown size={14} />
    </button>
  )
}
