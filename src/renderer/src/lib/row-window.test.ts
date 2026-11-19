import { describe, expect, it } from 'vitest'

import { ROW_WINDOW_OVERSCAN, visibleRowRange } from './row-window'

/** 常用参数：46px 一行（舒适密度）、800px 可视高、列表顶在滚动原点 */
const base = { rowHeight: 46, containerHeight: 800, listTop: 0, overscan: 10, activateAbove: 240 }

describe('visibleRowRange', () => {
  it('短列表全挂（不开窗口）', () => {
    expect(visibleRowRange({ ...base, total: 43, scrollTop: 0 })).toEqual({ start: 0, end: 43 })
    // 阈值本身就是「全挂」那一档
    expect(visibleRowRange({ ...base, total: 240, scrollTop: 0 })).toEqual({ start: 0, end: 240 })
    // 刚过阈值才开窗口（窗口也得覆盖从头看到的情形）
    const justOver = visibleRowRange({ ...base, total: 241, scrollTop: 0 })
    expect(justOver.start).toBe(0)
    expect(justOver.end).toBeGreaterThan(0)
    expect(justOver.end).toBeLessThan(241)
  })

  it('空列表与量不到行高时都不给乱序区间', () => {
    expect(visibleRowRange({ ...base, total: 0, scrollTop: 0 })).toEqual({ start: 0, end: 0 })
    expect(visibleRowRange({ ...base, total: 5000, scrollTop: 0, rowHeight: 0 })).toEqual({
      start: 0,
      end: 5000
    })
  })

  it('停在顶部：从第 0 行起算', () => {
    // 可视 800/46 ≈ 17.4 行 → 18 + 1 行余量，再加下沿 overscan
    expect(visibleRowRange({ ...base, total: 2000, scrollTop: 0 })).toEqual({
      start: 0,
      end: 29
    })
  })

  it('滚到中间：窗口跟着走，视口那一屏整段都在里面', () => {
    const scrollTop = 46 * 500 // 第 500 行顶到视口顶端
    const range = visibleRowRange({ ...base, total: 2000, scrollTop })
    expect(range).toEqual({ start: 490, end: 529 })
    // 判据：视口里的第一行（500）与最后一行（500+17）都必须被挂出来
    expect(range.start).toBeLessThanOrEqual(500)
    expect(range.end).toBeGreaterThan(500 + 17)
  })

  it('列表上方还有别的东西（页头 / 表头）时，按第 0 行的位置折算', () => {
    // listTop = 200：滚到顶时视口顶端在列表上方 200px，仍从第 0 行起
    const range = visibleRowRange({ ...base, total: 2000, scrollTop: 0, listTop: 200 })
    expect(range.start).toBe(0)
    expect(range.end).toBe(29)
  })

  it('滚到底：窗口贴住列表尾部，不会给出越界的 start', () => {
    const scrollTop = 46 * 2000 - 800
    const range = visibleRowRange({ ...base, total: 2000, scrollTop })
    expect(range.end).toBe(2000)
    expect(range.start).toBe(1972)
  })

  it('scrollTop 超过可滚范围（数据刚变短）时也不越界', () => {
    const range = visibleRowRange({ ...base, total: 2000, scrollTop: 999999 })
    expect(range.start).toBeLessThan(range.end)
    expect(range.end).toBe(2000)
    expect(range.start).toBeGreaterThanOrEqual(0)
  })

  it('容器还没高度（页面槽刚挂上）时至少挂一行', () => {
    const range = visibleRowRange({ ...base, total: 2000, scrollTop: 46 * 100, containerHeight: 0 })
    expect(range.end).toBeGreaterThan(range.start)
    expect(range.start).toBe(100 - ROW_WINDOW_OVERSCAN)
  })
})
