/**
 * 只测不碰 DOM 的那两个判断。真正的播放（hls.js 挂到 audio 上）在这里测不了 —— 它需要
 * MSE 与真实网络，属于 e2e / 手工验证的事（见 AGENTS.md §7）。
 */

import { describe, expect, it } from 'vitest'

import { isHlsUrl, supportsHls } from './hls-source'

describe('isHlsUrl', () => {
  it('认后端给 HLS 电台的那条地址（带 access_token）', () => {
    expect(isHlsUrl('http://localhost:58091/api/v1/songs/7/play.m3u8?access_token=t')).toBe(true)
  })

  it('裸 m3u 播放列表也算', () => {
    expect(isHlsUrl('http://satellitepull.cnr.cn/live/wxyyzs/playlist.m3u')).toBe(true)
  })

  it('大小写不敏感', () => {
    expect(isHlsUrl('http://host/live/PLAYLIST.M3U8')).toBe(true)
  })

  it('query 与 hash 不参与判断', () => {
    expect(isHlsUrl('http://host/a.m3u8?x=1#frag')).toBe(true)
    expect(isHlsUrl('http://host/a.m3u8.txt')).toBe(false)
  })

  it('普通歌曲与本地文件不是 HLS', () => {
    expect(isHlsUrl('http://localhost:58091/api/v1/songs/7/play?access_token=t')).toBe(false)
    expect(isHlsUrl('songloft-media://local/music/a.flac')).toBe(false)
    expect(isHlsUrl('')).toBe(false)
  })
})

describe('supportsHls', () => {
  it('没有 DOM 的环境（单测）一律报不支持，让调用方走服务端转码', () => {
    expect(supportsHls()).toBe(false)
  })
})
