/**
 * 「把当前曲滚到列表中间」的边界规则单测。
 *
 * 为什么值得单独测：这条逻辑在真实窗口里只表现为「跳了一下」或「没跳」，肉眼几乎
 * 分辨不出「跳对了」与「跳偏了一行」；而它的本质只是几处夹取 —— 首尾不能越界
 * （越界就是一片空白）、行比容器还高时不能把行顶推到容器外面。这些用用例钉住最省事。
 */

import { describe, expect, it } from 'vitest'

import { centerTarget, type CenterGeometry } from './scroll'

/** 一个 800 高、内容 4000 长、每行 44 的容器（贴近主窗口里一张歌曲表） */
function geometry(overrides: Partial<CenterGeometry> = {}): CenterGeometry {
  return {
    scrollTop: 0,
    containerTop: 0,
    containerHeight: 800,
    scrollHeight: 4000,
    rowTop: 0,
    rowHeight: 44,
    ...overrides
  }
}

describe('centerTarget', () => {
  it('中段的一行 → 行中心对准容器中心', () => {
    const target = centerTarget(geometry({ rowTop: 1000 }))
    // 行中心 1022 滚走 target 之后，落在容器 800 的正中（400）
    expect(1022 - target).toBe(400)
  })

  it('已经滚过一段时结果一样：偏移按容器滚动原点算，与当前 scrollTop 无关', () => {
    const target = centerTarget(geometry({ scrollTop: 600, rowTop: 400 }))
    expect(target).toBe(622)
  })

  it('靠近开头 → 夹到 0，不在上面留一片空白', () => {
    expect(centerTarget(geometry({ rowTop: 10 }))).toBe(0)
    expect(centerTarget(geometry({ rowTop: 0 }))).toBe(0)
  })

  it('靠近结尾 → 夹到「可滚到底」，不在下面留一片空白', () => {
    // 最后一行顶在 3956，内容长 4000：滚到 max 时它正好贴容器底
    expect(centerTarget(geometry({ rowTop: 3956 }))).toBe(3200)
  })

  it('行比容器还高 → 行顶贴容器顶，而不是把行往上推', () => {
    expect(centerTarget(geometry({ rowTop: 2000, rowHeight: 1000 }))).toBe(2000)
  })

  it('内容装得下（压根不能滚）→ 0', () => {
    expect(centerTarget(geometry({ scrollHeight: 500, rowTop: 120 }))).toBe(0)
  })
})
