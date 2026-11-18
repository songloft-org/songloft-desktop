/**
 * 中继地址的编解码与 m3u8 改写。
 *
 * ★ 改写规则值得单测的理由：漏改一条 URI 不会当场报错，只会在播到一半时「没有数据」——
 *   而那时能看见的只是一个已经失败的网络请求，看不出是改写的问题。
 */

import { describe, expect, it } from 'vitest'

import {
  HLS_RELAY_SCHEME,
  isPlaylistText,
  relayUrlFor,
  rewritePlaylist,
  upstreamFromRelay
} from './hls-relay'

const BASE = 'https://cdn.example.com/live/index.m3u8'

describe('relayUrlFor / upstreamFromRelay', () => {
  it('往返一致（含 query 与 token）', () => {
    const upstream = 'http://192.168.1.9:8080/api/v1/songs/7/play?media=video&access_token=a/b+c='
    expect(upstreamFromRelay(relayUrlFor(upstream))).toBe(upstream)
  })

  it('中继地址是 URL 安全的：只落在一个 path 段里，没有 query / hash', () => {
    const relay = relayUrlFor('https://cdn.example.com/a/b.m3u8?x=1#y')
    expect(relay.startsWith(`${HLS_RELAY_SCHEME}://r/`)).toBe(true)
    const parsed = new URL(relay)
    expect(parsed.pathname.split('/').filter(Boolean)).toHaveLength(1)
    expect(parsed.search).toBe('')
    expect(parsed.hash).toBe('')
  })

  it('不是中继地址的一律 null（含本地文件协议与裸地址）', () => {
    expect(upstreamFromRelay('https://cdn.example.com/a.m3u8')).toBeNull()
    expect(upstreamFromRelay('songloft-media://local/music/a.flac')).toBeNull()
    expect(upstreamFromRelay('')).toBeNull()
  })

  it('解出来不是 http(s) 的也拒绝 —— 中继只当代取 http(s) 的那一段', () => {
    expect(upstreamFromRelay(relayUrlFor('skd://key/1'))).toBeNull()
    expect(upstreamFromRelay(relayUrlFor('data:text/plain,a'))).toBeNull()
  })

  it('垃圾 base64 不抛异常，返回 null', () => {
    expect(upstreamFromRelay(`${HLS_RELAY_SCHEME}://r/%E4%B8%AD%E6%96%87`)).toBeNull()
  })
})

describe('isPlaylistText', () => {
  const bytes = (text: string): Uint8Array => new TextEncoder().encode(text)

  it('认出播放列表（含 BOM 与前导空白）', () => {
    expect(isPlaylistText(bytes('#EXTM3U\n#EXT-X-VERSION:3\n'))).toBe(true)
    expect(isPlaylistText(bytes('\uFEFF#EXTM3U\r\n'))).toBe(true)
    expect(isPlaylistText(bytes('  \n#EXTM3U\n'))).toBe(true)
  })

  it('切片 / 错误页 / 空响应都不是播放列表', () => {
    expect(isPlaylistText(new Uint8Array([0x47, 0x40, 0x11, 0x10]))).toBe(false)
    expect(isPlaylistText(bytes('404 page not found'))).toBe(false)
    expect(isPlaylistText(new Uint8Array(0))).toBe(false)
  })
})

describe('rewritePlaylist', () => {
  it('相对与协议相对的 URI 都按 base 解析后改写', () => {
    const text = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      'seg1.ts',
      '../other/seg2.ts',
      '//keys.example.com/k1',
      ''
    ].join('\n')
    const lines = rewritePlaylist(text, BASE).split('\n')
    expect(lines[0]).toBe('#EXTM3U')
    expect(lines[1]).toBe('#EXT-X-VERSION:3')
    expect(upstreamFromRelay(lines[2])).toBe('https://cdn.example.com/live/seg1.ts')
    expect(upstreamFromRelay(lines[3])).toBe('https://cdn.example.com/other/seg2.ts')
    expect(upstreamFromRelay(lines[4])).toBe('https://keys.example.com/k1')
  })

  it('绝对 URI 原样保留（不被 base 改写）', () => {
    const out = rewritePlaylist('https://other.example.net/a/seg9.ts', BASE)
    expect(upstreamFromRelay(out)).toBe('https://other.example.net/a/seg9.ts')
  })

  it('EXT-X-KEY / EXT-X-MAP 的 URI 属性也要改写', () => {
    const text = [
      '#EXT-X-KEY:METHOD=AES-128,URI="keys/k1.bin",IV=0x00',
      '#EXT-X-MAP:URI="init.mp4"',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="原唱",URI="audio/zh.m3u8"'
    ].join('\n')
    const out = rewritePlaylist(text, BASE)
    const key = /URI="([^"]+)"/.exec(out.split('\n')[0] ?? '')?.[1]
    const init = /URI="([^"]+)"/.exec(out.split('\n')[1] ?? '')?.[1]
    const media = /URI="([^"]+)"/.exec(out.split('\n')[2] ?? '')?.[1]
    expect(upstreamFromRelay(key ?? '')).toBe('https://cdn.example.com/live/keys/k1.bin')
    expect(upstreamFromRelay(init ?? '')).toBe('https://cdn.example.com/live/init.mp4')
    expect(upstreamFromRelay(media ?? '')).toBe('https://cdn.example.com/live/audio/zh.m3u8')
    // 标签里的其它属性一个字都不能动
    expect(out.split('\n')[0]).toContain('METHOD=AES-128')
    expect(out.split('\n')[0]).toContain('IV=0x00')
    expect(out.split('\n')[2]).toContain('NAME="原唱"')
  })

  it('data: / skd: 这类 URI 保持原样（主进程取不了，交给 hls.js 自己）', () => {
    const text = ['#EXT-X-KEY:METHOD=AES-128,URI="data:text/plain;base64,AAAA"'].join('\n')
    expect(rewritePlaylist(text, BASE)).toBe(text)
  })

  it('空行与不带 URI 属性的标签原样保留（少一行 EXT-X-ENDLIST 直播就变成点播了）', () => {
    const text = ['', '#EXT-X-TARGETDURATION:6', '#EXT-X-ENDLIST', ''].join('\n')
    expect(rewritePlaylist(text, BASE)).toBe(text)
  })
})
