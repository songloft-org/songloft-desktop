/**
 * 本地文件的媒体协议（`songloft-media://`）。
 *
 * ★ 为什么本地文件不直接用 `file://`：见 shared/local-file.ts 顶部那段（简单说，
 *   Chromium 不允许 http(s) 页面加载 file:// 子资源，于是「双击文件就能播」只在打包态成立、
 *   开发态静默哑掉）。自定义协议两种运行方式下都成立，且响应头由我们自己给。
 *
 * 这里只做三件事：把协议注册成特权协议、把地址还原成路径、按 Range 读文件。
 * **不放行任何写入**，也**不碰地址白名单之外的东西** —— 能读到的就是请求里那一个路径。
 */

import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { Readable } from 'node:stream'

import { protocol } from 'electron'

import { HLS_RELAY_SCHEME } from '@shared/hls-relay'
import {
  LOCAL_FILE_SCHEME,
  audioMimeFor,
  parseByteRange,
  pathFromLocalFileUrl
} from '@shared/local-file'

/**
 * 把本应用的两条自定义协议登记为特权协议。
 *
 * ★ 这一句必须赶在 app ready 之前调用（Chromium 只在启动时读这份声明），而且
 *   `registerSchemesAsPrivileged` **整个进程只能调用一次** —— 所以两条协议在同一份声明里
 *   一起给出，别在别的模块里再调一次（第二次会被忽略，症状是那条协议静默失灵）。
 *
 * 三项特权各自对应一件不做就不成立的事：
 *   * `standard`    —— 按标准 URL 解析（scheme://host/path）。不写它拿到的是一整串不透明
 *                      路径，`new URL()` 也解析不出 host；
 *   * `secure`      —— 视作安全来源，与 http 页面同等的待遇（不写会被当成 http 之外的
 *                      可疑来源，媒体加载会被拦）；
 *   * `stream`      —— ★ 最关键的一项：不加它 Chromium 会**把整份响应缓冲完**才交给
 *                      `<audio>`。一首 60MB 的 FLAC 于是要等它整个读完才出声，拖动进度条
 *                      更是无从谈起。
 *   * `supportFetchAPI` / `corsEnabled` —— hls.js 的中继地址是用 XHR 取的（见
 *                      main/hls-relay.ts），少了这两项它连请求都发不出去。
 */
export function registerMediaSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: LOCAL_FILE_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        corsEnabled: true
      }
    },
    {
      scheme: HLS_RELAY_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        corsEnabled: true
      }
    }
  ])
}

/** 装上协议处理器（app ready 之后调用一次） */
export function installLocalFileProtocol(): void {
  protocol.handle(LOCAL_FILE_SCHEME, async (request) => {
    const path = pathFromLocalFileUrl(request.url)
    if (!path) return new Response('bad request', { status: 400 })

    let size: number
    try {
      const info = await stat(path)
      if (!info.isFile()) return new Response('not a file', { status: 404 })
      size = info.size
    } catch {
      // 文件被删了 / 没有读权限：与「放一首不存在的歌」表现一致（播放器自己会走
      // 「无法解码」那条路并重试一次），这里不必区分原因
      return new Response('not found', { status: 404 })
    }

    const headers = {
      'Content-Type': audioMimeFor(path) ?? 'application/octet-stream',
      // 告诉 Chromium 这个源支持按区间取 —— 媒体栈据此才允许拖动进度条
      'Accept-Ranges': 'bytes'
    }

    // 媒体栈偶尔先来一个 HEAD 探一下长度（不取字节）
    if (request.method === 'HEAD') {
      return new Response(null, {
        status: 200,
        headers: { ...headers, 'Content-Length': String(size) }
      })
    }

    /*
     * ★ Chromium 的媒体栈**第一个请求就带** `Range: bytes=0-`（实测，见下），所以下面这段
     *   206 分支不是「拖动进度条才走」的支线 —— 它是每一次本地播放的主路。写错它，症状是
     *   「一首也放不出来」或「时长显示不出来」，而不是「只有拖动时出问题」。
     */
    const range = parseByteRange(request.headers.get('Range'), size)
    if (range === 'unsatisfiable') {
      return new Response(null, {
        status: 416,
        headers: { ...headers, 'Content-Range': `bytes */${size}` }
      })
    }

    if (!range) {
      return new Response(Readable.toWeb(createReadStream(path)), {
        status: 200,
        headers: { ...headers, 'Content-Length': String(size) }
      })
    }

    return new Response(
      Readable.toWeb(createReadStream(path, { start: range.start, end: range.end })),
      {
        status: 206,
        headers: {
          ...headers,
          'Content-Length': String(range.end - range.start + 1),
          'Content-Range': `bytes ${range.start}-${range.end}/${size}`
        }
      }
    )
  })
}
