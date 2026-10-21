/**
 * 「播放顺序」（`player-core` 里的 `order`）的构造规则 —— 纯函数，不碰 audio / 设置 / DOM，
 * 因此可以直接单测。
 *
 * ★ 为什么值得单独一个模块：`order` + `cursor` 是随机播放的**唯一**事实源 —— `next()` 沿它走
 *   一格、预加载预热 `order[cursor + 1]`、队列面板标「当前项」也都读它。只要有一条路径在
 *   `playMode === 'random'` 时把 `order` 写成 identity（0..n-1），`next()` 就退化成「按队列
 *   顺序一首一首来」，而界面上那颗随机图标**照旧是随机**：不报错、不复现，只是悄悄丢了语义。
 *   所以「按模式重建 order」只有这一份实现，任何重建 order 的地方都必须走它。
 *
 * ★ `keepFirst` 的作用是把**当前正在播的那一首**提到队首，于是洗牌之后 `cursor` 仍然指向
 *   同一首歌（不会因为重建顺序而跳歌），而「下一首」是洗牌序列真正意义上的第一首。
 *
 * ★ 不放 `shared/`：主进程用不到它（那是渲染层的播放状态），见 AGENTS.md 的硬性约定。
 */

import type { PlayMode } from '@shared/types'

/** 顺序播放用的下标序列：0..length-1 */
export function identityOrder(length: number): number[] {
  return Array.from({ length }, (_, i) => i)
}

/**
 * 洗牌后的下标序列（Fisher-Yates）。
 *
 * `keepFirst`：把这个队列下标挪到队首。传 undefined 表示「不关心当前位置」（例如队列还没起播）。
 */
export function shuffledOrder(length: number, keepFirst?: number): number[] {
  const indices = identityOrder(length)
  for (let i = indices.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[indices[i], indices[j]] = [indices[j], indices[i]]
  }
  if (keepFirst != null) {
    const at = indices.indexOf(keepFirst)
    if (at > 0) {
      ;[indices[0], indices[at]] = [indices[at], indices[0]]
    }
  }
  return indices
}

/**
 * 按播放模式重建一份长度为 `length` 的 order。
 *
 * · 列表循环 / 单曲循环 → identity（「下一首」= 队列里的下一首）；
 * · 随机 → 洗牌，并把 `currentIndex` 留在队首（它此刻正在播，不能被摇走）。
 *
 * `currentIndex` 是**队列下标**（不是 cursor），非法值（-1 / 越界）按「没有当前曲」处理。
 */
export function orderForMode(mode: PlayMode, length: number, currentIndex: number): number[] {
  if (mode !== 'random') return identityOrder(length)
  const keep = currentIndex >= 0 && currentIndex < length ? currentIndex : undefined
  return shuffledOrder(length, keep)
}
