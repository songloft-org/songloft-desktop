import { describe, expect, it } from 'vitest'

import { identityOrder, orderForMode, shuffledOrder } from './play-order'

const isPermutationOf = (order: number[], length: number): boolean =>
  order.length === length && [...order].sort((a, b) => a - b).every((value, i) => value === i)

describe('identityOrder', () => {
  it('是 0..n-1', () => {
    expect(identityOrder(0)).toEqual([])
    expect(identityOrder(1)).toEqual([0])
    expect(identityOrder(4)).toEqual([0, 1, 2, 3])
  })
})

describe('shuffledOrder', () => {
  it('一直是同一个排列（不丢下标、不重复）', () => {
    for (let i = 0; i < 20; i += 1) {
      expect(isPermutationOf(shuffledOrder(6), 6)).toBe(true)
    }
  })

  it('空队列与单曲队列没有别的排法', () => {
    expect(shuffledOrder(0)).toEqual([])
    expect(shuffledOrder(1)).toEqual([0])
    expect(shuffledOrder(1, 0)).toEqual([0])
  })

  it('keepFirst 指定的那一首落在队首，且仍是完整排列', () => {
    for (let i = 0; i < 20; i += 1) {
      const order = shuffledOrder(6, 3)
      expect(order[0]).toBe(3)
      expect(isPermutationOf(order, 6)).toBe(true)
    }
  })

  it('keepFirst 越界时当作不指定，不抛错', () => {
    expect(isPermutationOf(shuffledOrder(4, 9), 4)).toBe(true)
  })
})

describe('orderForMode', () => {
  it('列表循环 / 单曲循环按队列顺序走', () => {
    expect(orderForMode('loop', 4, 2)).toEqual([0, 1, 2, 3])
    expect(orderForMode('single', 4, 2)).toEqual([0, 1, 2, 3])
  })

  it('随机模式下当前曲留在队首（游标因此不用跳）', () => {
    for (let i = 0; i < 20; i += 1) {
      const order = orderForMode('random', 6, 4)
      expect(order[0]).toBe(4)
      expect(isPermutationOf(order, 6)).toBe(true)
    }
  })

  it('随机模式下没有当前曲时仍是一份完整的洗牌序列', () => {
    for (let i = 0; i < 20; i += 1) {
      expect(isPermutationOf(orderForMode('random', 6, -1), 6)).toBe(true)
    }
  })

  /*
   * 这条断言钉的正是那个缺陷本身：随机模式下 order[1]（= 点「下一首」会走到的那一格）
   * 必须有可能不是队列里的下一首。若哪天又有人把随机路径写回 identity，这里会先红。
   */
  it('随机模式下「下一首」不是队列里的下一首', () => {
    let differed = 0
    for (let i = 0; i < 30; i += 1) {
      if (orderForMode('random', 6, 0)[1] !== 1) differed += 1
    }
    expect(differed).toBeGreaterThan(0)
  })
})
