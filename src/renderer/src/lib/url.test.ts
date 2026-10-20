/**
 * 资源 URL 拼装的单测。
 *
 * 为什么这几个纯函数值得单独测：它们决定的不是「显示成什么样」，而是**请求打到哪个地址**。
 * 出错时的表现全都是间接的 —— 封面不显示、播不出声、外链音频 404 —— 排查成本远高于写用例。
 * 这里锁的四件事：
 *   1. access_token 有没有带上、有没有被正确编码（token 里可能有 + / 空格）；
 *   2. 追加参数用的是 `?` 还是 `&`（拼错就是给服务器发一个畸形路径）；
 *   3. 外链 CDN 的地址**不能**被我们改 query（可能带签名，改了直接失效）；
 *   4. `track` 与 `format` 不能同时出现（后端两个一起给会互相冲突）；
 *   5. 重试标记 `retry` 只在重试时出现（播放失败后重新要地址时绕开浏览器缓存复用）；
 *   6. 预热路径（`prefetchSongPath`）的参数与真实播放**逐项一致**，且不该预热的歌返回 null。
 *
 * 第 2 条就是写这批用例时暴露出来的：`buildCoverUrl` 在「同源绝对地址且原本没有 query」时
 * 会拼出 `http://host/c.jpg&w=96` —— 缺一个 `?`，`&w=96` 被当成路径的一部分。
 */

import { describe, expect, it } from 'vitest'

import { localFileUrl, pathFromLocalFileUrl } from '@shared/local-file'
import type { Song } from '@shared/types'
import {
  buildCoverUrl,
  buildLyricUrl,
  buildResourceUrl,
  buildSongQuery,
  buildSongUrl,
  prefetchSongPath,
  transcodeFormatFor
} from './url'

/** token 特意带上空格与 + / ，用来验证 encodeURIComponent 有没有真的生效 */
const ctx = { baseUrl: 'http://localhost:58091', accessToken: 'tok 1/a+b' }
const TOKEN_QS = 'access_token=tok%201%2Fa%2Bb'

/**
 * 造一个「够用就好」的 Song。
 *
 * buildSongUrl 只读 url / source_url / format，其余二十来个字段与本文件无关 ——
 * 与其抄一遍（然后随模型漂移），不如断言跳过。改测试要在这里补字段，是刻意的摩擦。
 */
function song(overrides: Partial<Song> = {}): Song {
  return {
    id: 1,
    type: 'local',
    url: '/api/v1/songs/1/audio',
    source_url: null,
    format: 'flac',
    ...overrides
  } as Song
}

describe('transcodeFormatFor', () => {
  it('老格式要交给后端转码', () => {
    expect(transcodeFormatFor('wma')).toBe('mp3')
    expect(transcodeFormatFor('ape')).toBe('mp3')
    expect(transcodeFormatFor('dsf')).toBe('mp3')
  })

  it('大小写不敏感', () => {
    expect(transcodeFormatFor('WMA')).toBe('mp3')
  })

  it('常规格式与空值不转码', () => {
    expect(transcodeFormatFor('flac')).toBeNull()
    expect(transcodeFormatFor('MP3')).toBeNull()
    expect(transcodeFormatFor(null)).toBeNull()
    expect(transcodeFormatFor(undefined)).toBeNull()
    expect(transcodeFormatFor('')).toBeNull()
  })
})

describe('buildResourceUrl', () => {
  it('相对路径拼上服务器地址与 access_token', () => {
    expect(buildResourceUrl('/api/v1/songs/1/cover', ctx)).toBe(
      `http://localhost:58091/api/v1/songs/1/cover?${TOKEN_QS}`
    )
  })

  it('token 会被 URL 编码', () => {
    expect(buildResourceUrl('/x', ctx)).toContain('access_token=tok%201%2Fa%2Bb')
  })

  it('原本已有 query 时用 & 追加', () => {
    expect(buildResourceUrl('/x?w=96', ctx)).toBe(`http://localhost:58091/x?w=96&${TOKEN_QS}`)
  })

  it('baseUrl 结尾的斜杠不会拼出双斜杠', () => {
    const trailing = { baseUrl: 'http://h:1/', accessToken: 't' }
    expect(buildResourceUrl('/api/v1/x', trailing)).toBe('http://h:1/api/v1/x?access_token=t')
  })

  it('绝对地址原样返回，不追加 token', () => {
    // 外链可能带签名，加参数会让签名失效
    expect(buildResourceUrl('https://cdn.example/x.mp3', ctx)).toBe('https://cdn.example/x.mp3')
  })

  it('空值返回空串', () => {
    expect(buildResourceUrl(null, ctx)).toBe('')
    expect(buildResourceUrl(undefined, ctx)).toBe('')
    expect(buildResourceUrl('', ctx)).toBe('')
  })
})

describe('buildCoverUrl', () => {
  it('相对路径上加一档宽度', () => {
    expect(buildCoverUrl('/api/v1/songs/1/cover', ctx, 96)).toBe(
      `http://localhost:58091/api/v1/songs/1/cover?${TOKEN_QS}&w=96`
    )
  })

  it('不给宽度时不加 w 参数', () => {
    expect(buildCoverUrl('/c', ctx)).toBe(`http://localhost:58091/c?${TOKEN_QS}`)
    expect(buildCoverUrl('/c', ctx, 0)).toBe(`http://localhost:58091/c?${TOKEN_QS}`)
  })

  it('宽度取整', () => {
    expect(buildCoverUrl('/c', ctx, 96.6)).toContain('&w=97')
  })

  it('外链 CDN 地址不加 w 参数', () => {
    expect(buildCoverUrl('https://cdn.example/c.jpg', ctx, 96)).toBe('https://cdn.example/c.jpg')
  })

  it('同源绝对地址要加 w —— 且必须补上 `?`（回归：曾经拼成 c.jpg&w=96）', () => {
    expect(buildCoverUrl('http://localhost:58091/c.jpg', ctx, 96)).toBe(
      'http://localhost:58091/c.jpg?w=96'
    )
  })

  it('已有 w 参数时不重复添加', () => {
    expect(buildCoverUrl('/c?w=128', ctx, 96)).toBe(`http://localhost:58091/c?w=128&${TOKEN_QS}`)
  })
})

describe('buildLyricUrl', () => {
  it('与 buildResourceUrl 同义', () => {
    expect(buildLyricUrl('/api/v1/songs/1/lyric', ctx)).toBe(
      `http://localhost:58091/api/v1/songs/1/lyric?${TOKEN_QS}`
    )
  })
})

describe('buildSongUrl', () => {
  it('常规歌曲只带 token', () => {
    expect(buildSongUrl(song(), ctx)).toBe(
      `http://localhost:58091/api/v1/songs/1/audio?${TOKEN_QS}`
    )
  })

  it('需要转码的格式带上 format', () => {
    expect(buildSongUrl(song({ format: 'wma' }), ctx)).toContain('format=mp3')
  })

  it('指定音轨时不再带 format（两个一起给会互相冲突）', () => {
    const url = buildSongUrl(song({ format: 'wma' }), ctx, { track: 1 })
    expect(url).toContain('track=1')
    expect(url).not.toContain('format=')
  })

  it('track = 0 是合法音轨，不能被当成「没指定」', () => {
    expect(buildSongUrl(song(), ctx, { track: 0 })).toContain('track=0')
  })

  it('track 为负数时退回按 format 处理', () => {
    const url = buildSongUrl(song({ format: 'wma' }), ctx, { track: -1 })
    expect(url).toContain('format=mp3')
    expect(url).not.toContain('track=')
  })

  it('quality 为 original 时不带该参数', () => {
    expect(buildSongUrl(song(), ctx, { quality: 'original' })).not.toContain('quality=')
    expect(buildSongUrl(song(), ctx, { quality: '320' })).toContain('quality=320')
  })

  it('音量归一化带 normalize=1', () => {
    expect(buildSongUrl(song(), ctx, { normalize: true })).toContain('normalize=1')
    expect(buildSongUrl(song(), ctx, { normalize: false })).not.toContain('normalize=')
  })

  it('url 为空时退回 source_url', () => {
    const url = buildSongUrl(song({ url: null, source_url: '/api/v1/stream/1' }), ctx)
    expect(url).toBe(`http://localhost:58091/api/v1/stream/1?${TOKEN_QS}`)
  })

  it('source_url 是外链时原样使用，不会把我们的 token 塞给第三方', () => {
    const url = buildSongUrl(song({ url: null, source_url: 'https://cdn.example/x.flac' }), ctx)
    expect(url).toBe('https://cdn.example/x.flac')
  })

  it('两个地址都没有时返回空串', () => {
    expect(buildSongUrl(song({ url: null, source_url: null }), ctx)).toBe('')
  })
})

describe('本地文件（自定义协议）', () => {
  const localUrl = localFileUrl('/home/edwin/Music/夜曲.flac')

  it('资源地址原样返回：不拼服务器、不带 token', () => {
    expect(buildResourceUrl(localUrl, ctx)).toBe(localUrl)
  })

  it('播放地址原样返回，后端那些参数一个都不加', () => {
    expect(buildSongUrl(song({ url: localUrl, format: 'flac' }), ctx)).toBe(localUrl)
    expect(
      buildSongUrl(song({ url: localUrl, format: 'flac' }), ctx, {
        quality: '320',
        normalize: true,
        track: 1
      })
    ).toBe(localUrl)
  })

  it('重试时地址要变（否则浏览器会复用上一次那份失败的响应）', () => {
    const retried = buildSongUrl(song({ url: localUrl }), ctx, { retry: 1 })
    expect(retried).toBe(`${localUrl}?retry=1`)
    // 参数只是给缓存看的：还原回路径时不该受影响
    expect(pathFromLocalFileUrl(retried)).toBe('/home/edwin/Music/夜曲.flac')
  })

  it('没有服务器（未登录）时照样拿得到地址', () => {
    const anonymous = { baseUrl: '', accessToken: '' }
    expect(buildSongUrl(song({ url: localUrl }), anonymous)).toBe(localUrl)
  })
})

describe('buildSongUrl 的重试标记', () => {
  it('首次不带 retry（地址与以前完全一致）', () => {
    expect(buildSongUrl(song(), ctx, { quality: '320' })).toBe(
      `http://localhost:58091/api/v1/songs/1/audio?${TOKEN_QS}&quality=320`
    )
    expect(buildSongUrl(song(), ctx, { retry: 0 })).not.toContain('retry=')
  })

  it('重试时地址不同（绕开浏览器对同一 URL 的缓存复用）', () => {
    const first = buildSongUrl(song(), ctx)
    const second = buildSongUrl(song(), ctx, { retry: 1 })
    expect(second).not.toBe(first)
    expect(second).toContain('retry=1')
    expect(second).toContain('access_token=tok')
  })
})

describe('buildSongQuery', () => {
  it('参数顺序与 buildSongUrl 拼出来的完全一致', () => {
    const options = { quality: '320' as const, normalize: true }
    expect(buildSongQuery(song({ format: 'wma' }), options)).toBe(
      'format=mp3&quality=320&normalize=1'
    )
    expect(buildSongUrl(song({ format: 'wma' }), ctx, options)).toBe(
      `http://localhost:58091/api/v1/songs/1/audio?${TOKEN_QS}&format=mp3&quality=320&normalize=1`
    )
  })

  it('没有任何参数时是空串（地址不该多出一个 `?`）', () => {
    expect(buildSongQuery(song({ format: 'mp3' }))).toBe('')
    expect(buildSongUrl(song({ format: 'mp3' }), ctx)).toBe(
      `http://localhost:58091/api/v1/songs/1/audio?${TOKEN_QS}`
    )
  })

  it('track 与 format 仍然互斥', () => {
    expect(buildSongQuery(song({ format: 'wma' }), { track: 0 })).toBe('track=0')
  })
})

describe('prefetchSongPath', () => {
  it('曲库里的网络歌曲：带上与播放一致的参数 + prefetch=1', () => {
    const remote = song({ id: 7, type: 'remote', url: '/api/v1/songs/7/play' })
    expect(prefetchSongPath(remote)).toBe('/songs/7/play?prefetch=1')
    expect(prefetchSongPath(remote, { quality: '320', normalize: true })).toBe(
      '/songs/7/play?quality=320&normalize=1&prefetch=1'
    )
  })

  it('本地文件不预热（不经过网络，没什么可预热）', () => {
    expect(prefetchSongPath(song({ type: 'local' }))).toBeNull()
    expect(prefetchSongPath(song({ type: 'local', url: localFileUrl('/m/a.flac') }))).toBeNull()
  })

  it('外链直连不预热（真实播放不走后端，预热只会让后端白下一份）', () => {
    const external = song({ type: 'remote', url: null, source_url: 'https://cdn.example/a.mp3' })
    expect(prefetchSongPath(external)).toBeNull()
  })

  it('id 非正 / 没有地址时不预热', () => {
    expect(prefetchSongPath(song({ type: 'remote', id: -3 }))).toBeNull()
    expect(prefetchSongPath(song({ type: 'remote', url: null, source_url: null }))).toBeNull()
  })
})
