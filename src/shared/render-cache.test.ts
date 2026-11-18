import { describe, expect, it } from 'vitest'

import {
  EMPTY_PLUGIN_SIGNATURE,
  EMPTY_RENDER_CACHE_STATE,
  backendCacheKey,
  planRenderCacheReconcile,
  pluginCacheSignature,
  type RenderCacheState
} from './render-cache'
import type { JSPlugin } from './plugin'

/**
 * 这批用例锁的是「哪一类更新清哪几个会话」—— 它决定的是**要不要重下几十兆资源**，
 * 写错的症状两头都不好看：清漏了，旧远端代码永久驻留（Lynx 插件白屏就是这么来的）；
 * 清多了，每次启停插件都在白下一遍运行时。
 */

function plugin(entryPath: string, extra: Partial<JSPlugin> = {}): JSPlugin {
  return {
    id: 1,
    name: entryPath,
    version: '1.0.0',
    description: '',
    author: '',
    homepage: '',
    license: '',
    entryPath,
    main: 'main.js',
    minHostVersion: '',
    permissions: [],
    icon: '',
    updateUrl: '',
    downloadUrl: '',
    renderEngine: '',
    status: 'active',
    filePath: '',
    createdAt: '',
    updatedAt: '2026-01-01T00:00:00Z',
    ...extra
  }
}

const SERVER = 'http://192.168.1.2:58091'

function state(patch: Partial<RenderCacheState> = {}): RenderCacheState {
  return { ...EMPTY_RENDER_CACHE_STATE, ...patch }
}

describe('backendCacheKey', () => {
  it('三项都要，缺的跳过；全缺时是空串（调用方据此跳过比较）', () => {
    expect(
      backendCacheKey({ version: 'v2.13.12', git_commit: '8c014b3', build_type: 'full' })
    ).toBe('v2.13.12|8c014b3|full')
    expect(backendCacheKey({ version: 'v2.13.12' })).toBe('v2.13.12')
    expect(backendCacheKey({})).toBe('')
    expect(backendCacheKey(null)).toBe('')
  })

  it('lite 与 full 算两次不同的构建', () => {
    const full = backendCacheKey({ version: 'v2.13.12', build_type: 'full' })
    const lite = backendCacheKey({ version: 'v2.13.12', build_type: 'lite' })
    expect(full).not.toBe(lite)
  })
})

describe('pluginCacheSignature', () => {
  it('启停不改变签名：开关插件不该清缓存', () => {
    const before = pluginCacheSignature([plugin('miot')])
    const after = pluginCacheSignature([plugin('miot', { status: 'inactive' })])
    expect(after).toBe(before)
  })

  it('版本 / updatedAt / 图标任一变化都改变签名', () => {
    const base = pluginCacheSignature([plugin('miot')])
    expect(pluginCacheSignature([plugin('miot', { version: '1.0.1' })])).not.toBe(base)
    expect(pluginCacheSignature([plugin('miot', { updatedAt: '2026-02-02T00:00:00Z' })])).not.toBe(
      base
    )
    expect(pluginCacheSignature([plugin('miot', { icon: 'icon.abc123.png' })])).not.toBe(base)
  })

  it('与列表顺序无关（排序只影响后端返回顺序）', () => {
    const a = plugin('a')
    const b = plugin('b', { id: 2 })
    expect(pluginCacheSignature([a, b])).toBe(pluginCacheSignature([b, a]))
  })

  it('一个都不剩时也有确定的签名（卸载全部同样要清一次）', () => {
    expect(pluginCacheSignature([])).toBe(EMPTY_PLUGIN_SIGNATURE)
    expect(pluginCacheSignature([])).not.toBe(pluginCacheSignature([plugin('a')]))
  })
})

describe('planRenderCacheReconcile', () => {
  it('第一次记录：只清插件会话（新装时它是空的，老版本升上来时可能压着旧远端代码）', () => {
    const plan = planRenderCacheReconcile(state(), {
      clientVersion: '1.3.6',
      serverKey: SERVER,
      backendVersion: 'v2.13.12|8c014b3|full',
      pluginSignature: 'miot:1:1.0.0:x:'
    })
    expect(plan.clear).toEqual(['plugin'])
    expect(plan.changed).toBe(true)
    expect(plan.state.client).toBe('1.3.6')
    expect(plan.state.backend[SERVER]).toBe('v2.13.12|8c014b3|full')
    expect(plan.state.plugins[SERVER]).toBe('miot:1:1.0.0:x:')
  })

  it('客户端升级：两个会话都清', () => {
    const plan = planRenderCacheReconcile(
      state({ client: '1.3.5', backend: { [SERVER]: 'a' }, plugins: { [SERVER]: 'p' } }),
      { clientVersion: '1.3.6' }
    )
    expect(plan.clear.sort()).toEqual(['app', 'plugin'])
    expect(plan.state.client).toBe('1.3.6')
  })

  it('什么都没变：不清、也不写盘', () => {
    const plan = planRenderCacheReconcile(
      state({ client: '1.3.6', backend: { [SERVER]: 'a' }, plugins: { [SERVER]: 'p' } }),
      { clientVersion: '1.3.6', serverKey: SERVER, backendVersion: 'a', pluginSignature: 'p' }
    )
    expect(plan.clear).toEqual([])
    expect(plan.changed).toBe(false)
  })

  it('后端升级：只清插件会话，不碰默认会话', () => {
    const plan = planRenderCacheReconcile(
      state({ client: '1.3.6', backend: { [SERVER]: 'old' }, plugins: { [SERVER]: 'p' } }),
      { clientVersion: '1.3.6', serverKey: SERVER, backendVersion: 'new' }
    )
    expect(plan.clear).toEqual(['plugin'])
    expect(plan.state.backend[SERVER]).toBe('new')
    // 插件那一项没报上来，不该被顺手抹掉
    expect(plan.state.plugins[SERVER]).toBe('p')
  })

  it('插件升级：只清插件会话', () => {
    const plan = planRenderCacheReconcile(
      state({ client: '1.3.6', backend: { [SERVER]: 'a' }, plugins: { [SERVER]: 'old' } }),
      { clientVersion: '1.3.6', serverKey: SERVER, pluginSignature: 'new' }
    )
    expect(plan.clear).toEqual(['plugin'])
    expect(plan.state.plugins[SERVER]).toBe('new')
  })

  it('启停插件（签名相同）：不清', () => {
    const plan = planRenderCacheReconcile(
      state({ client: '1.3.6', plugins: { [SERVER]: 'same' } }),
      { clientVersion: '1.3.6', serverKey: SERVER, pluginSignature: 'same' }
    )
    expect(plan.clear).toEqual([])
    expect(plan.changed).toBe(false)
  })

  it('后端探不到版本（空串）：不清，也不把旧记录抹成空', () => {
    const plan = planRenderCacheReconcile(
      state({ client: '1.3.6', backend: { [SERVER]: 'known' } }),
      { clientVersion: '1.3.6', serverKey: SERVER, backendVersion: '' }
    )
    expect(plan.clear).toEqual([])
    expect(plan.state.backend[SERVER]).toBe('known')
  })

  it('两台服务器各记各的，切换不算更新', () => {
    const other = 'http://10.0.0.9:58091'
    const plan = planRenderCacheReconcile(
      state({ client: '1.3.6', backend: { [SERVER]: 'a' }, plugins: { [SERVER]: 'p' } }),
      { clientVersion: '1.3.6', serverKey: other, backendVersion: 'a', pluginSignature: 'p' }
    )
    // 那台服务器第一次见：只记录
    expect(plan.clear).toEqual([])
    expect(plan.state.backend[other]).toBe('a')
    expect(plan.state.backend[SERVER]).toBe('a')
  })

  it('同一轮里客户端与后端都变了：两个会话清一次就够（去重）', () => {
    const plan = planRenderCacheReconcile(
      state({ client: '1.3.5', backend: { [SERVER]: 'old' } }),
      { clientVersion: '1.3.6', serverKey: SERVER, backendVersion: 'new' }
    )
    expect(plan.clear.sort()).toEqual(['app', 'plugin'])
  })
})
