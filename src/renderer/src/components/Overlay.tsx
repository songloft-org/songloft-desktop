/**
 * 弹层骨架：portal 到 body 的「定位层 + 遮罩」，面板由调用方作为 children 挂进同一层。
 *
 * ★ 三者的关系是**兄弟**，不是父子：定位层 → 遮罩 → 面板。面板的 `backdrop-filter` 与
 *   `box-shadow` 都画在它自己的框**之外**，一旦有祖先带 `backdrop-filter` / `opacity` /
 *   `transform` / `overflow`，玻璃就糊不到底下的页面、投影也会被裁掉或盖上。拆成兄弟之后，
 *   面板的背后直接是真实页面（详见 components.css 的 `.overlay` 那一段）。
 * ★ 挂到 body 而不是留在原地：`.shell` 这一类祖先现在没有上面那些属性，但只要哪天有，
 *   弹层就会莫名其妙地被裁一刀 —— 挂到 body 等于把这件事从「靠祖先自觉」变成「不可能发生」。
 *   顺带一个副作用是要的：遮罩照着 `--win-inset` 让开窗口边缘的那圈阴影（见 base.css）。
 */

import { createPortal } from 'react-dom'

export interface OverlayProps {
  /** 面板落在可见面的哪儿：居中（对话框）/ 靠上（命令面板那种「从顶上掉下来」的观感） */
  align?: 'center' | 'top'
  /** 点遮罩时调用。不给就是「点遮罩不关」（表单类对话框，避免误触丢输入） */
  onDismiss?: () => void
  children: React.ReactNode
}

export function Overlay({
  align = 'center',
  onDismiss,
  children
}: OverlayProps): React.JSX.Element {
  return createPortal(
    <div className="overlay" data-align={align}>
      {/*
        ★ 关闭判定挂在遮罩**自己**身上：它铺满整层，面板压在它上面 —— 点在面板里的事件
          根本到不了这里，于是不必再比较 event.target（早先遮罩就是父级时非比不可）。
        ★ aria-hidden：它是纯装饰，读屏不该念到它。
      */}
      <div className="overlay-mask" aria-hidden="true" onPointerDown={onDismiss} />
      {children}
    </div>,
    document.body
  )
}
