/**
 * 键盘事件的共用判断。
 *
 * ★ 为什么单独一处：App 的全局快捷键与「列表里的 Ctrl+A」都靠它判断「这一下该不该管」
 *   —— 同一个口径写两遍，迟早一边松一边紧（比如一处忘了 `contenteditable`）。
 */

/** 目标是不是「正在打字」的控件：输入框 / 文本域 / 下拉框 / 可编辑区 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}
