/**
 * 「把某一项摆到该在的位置上」的边界规则单测。
 *
 * 为什么值得单独测：这条逻辑在真实窗口里只表现为「跳了一下」或「没跳」，肉眼几乎
 * 分辨不出「跳对了」与「跳偏了一行」；而它的本质只是几处夹取 —— 首尾不能越界
 * （越界就是一片空白）、行比容器还高时不能把行顶推到容器外面。
 *
 * ★ 「同一位置换 scrollTop 量出来必须是同一件事」那条是**回归**用的：队列抽屉早先把
 *   「相对滚动原点的距离」和「从当前位置还要滚多少」加在了一起，于是 `scrollTop` 被多算
 *   一遍，打开抽屉时当前曲直接被推到视口上方四千像素处（高亮还在，人却看不见）。
 */

import { describe, expect, it } from 'vitest'

import { centerIfHiddenTarget, centerTarget, slotTarget, type RowGeometry } from './scroll'

/** 一个 800 高、内容 4000 长、每行 44 的容器（贴近主窗口里一张歌曲表） */
function geometry(overrides: Partial<RowGeometry> = {}): RowGeometry {
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

describe('centerIfHiddenTarget', () => {
  /* 队列抽屉的实测尺寸：容器 770 高、内容 10472 长、每行 52 */
  const queue = (overrides: Partial<RowGeometry> = {}): RowGeometry =>
    geometry({ containerHeight: 770, scrollHeight: 10472, rowHeight: 52, ...overrides })

  it('看不见 → 居中（不是推回边缘）', () => {
    const target = centerIfHiddenTarget(queue({ rowTop: 5688 })) as number
    expect(target).toBe(5329)
    // 滚过去之后：行中心 5714 落在容器 770 的正中（385）
    expect(5688 + 26 - target).toBe(385)
  })

  it('★ 回归：同一个位置，换个 scrollTop 量出来必须是同一件事（不能把 scrollTop 多算一遍）', () => {
    // 上面那条滚完之后就是这个样子：行中心在容器正中，整行都在视野里
    expect(centerIfHiddenTarget(queue({ scrollTop: 5329, rowTop: 359 }))).toBeNull()
  })

  it('整行已经在视野里（含恰好贴着上下边）→ null，位置原样留着', () => {
    expect(centerIfHiddenTarget(queue({ rowTop: 100 }))).toBeNull()
    expect(centerIfHiddenTarget(queue({ rowTop: 718 }))).toBeNull()
    expect(centerIfHiddenTarget(queue({ scrollTop: 5688, rowTop: 0 }))).toBeNull()
  })

  it('只露出一半（行顶被上边框切掉）→ 还是要居中', () => {
    expect(centerIfHiddenTarget(queue({ scrollTop: 5698, rowTop: -10 }))).toBe(5329)
  })

  it('最后一行 → 夹到「可滚到底」，不多不少', () => {
    expect(centerIfHiddenTarget(queue({ rowTop: 10420 }))).toBe(9702)
  })
})

describe('slotTarget', () => {
  const mini = (overrides: Partial<RowGeometry> = {}): RowGeometry =>
    geometry({ containerHeight: 416, scrollHeight: 4000, rowHeight: 52, ...overrides })

  it('slot=2 → 目标项落在从上往下第 3 格，上面留出两行', () => {
    const target = slotTarget(mini({ rowTop: 1000 }), 2)
    expect(1000 - target).toBe(104)
  })

  it('slot=0 → 等价于行顶贴容器顶', () => {
    expect(slotTarget(mini({ rowTop: 900 }), 0)).toBe(900)
  })

  it('容器还没有高度（刚展开）也照样算得出来：它只用行高', () => {
    expect(slotTarget(mini({ rowTop: 900, containerHeight: 0 }), 2)).toBe(796)
  })
})
