/**
 * 把客户端的安装包下到本机，然后交给人去装。
 *
 * **不做自替换**：桌面端的二进制归安装包与包管理器管。应用替自己换二进制一旦半路失败
 * （下载中断、目录不可写、替换到一半），用户手上就剩一个跑不起来的东西，而且没有回滚 ——
 * AppImage 那套自更新正是「先删掉旧文件，再移入新文件」。所以这里只负责把安装包落进
 * 「下载」目录，再用系统默认程序把它打开（NSIS 安装向导 / 软件中心 / 挂载 dmg）。
 *
 * 两条通路（配置的那条代理 → 直连）的取舍在 net-path.ts 里，这里只管落盘、进度与校验。
 */

import { createWriteStream } from 'node:fs'
import { chmod, mkdir, rename, rm, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'

import { app, shell } from 'electron'

import type {
  ClientUpdateDownloadRequest,
  ClientUpdateDownloadResult,
  ClientUpdateProgress
} from '@shared/ipc'

import { abortError, getStream, routeLabel, routesFor, type NetRoute } from './net-path'
import { planProxies } from './proxy'

/** 从发起到收到响应头的上限；真正的大头在响应体里，另有停滞看门狗 */
const CONNECT_TIMEOUT_MS = 15_000

/** 多久没有新数据算卡死。宿舍网 / 移动网络下偶尔会停十几秒，别掐太急 */
const STALL_TIMEOUT_MS = 30_000

/** 进度推送的最小间隔：每收到一块就推会让渲染层每秒重绘几十次 */
const PROGRESS_INTERVAL_MS = 200

/** 同时在跑的下载。安装包动辄上百 MB，不做队列 —— 第二个请求直接拒绝 */
let current: AbortController | null = null

/**
 * 上一次下好、还没被用掉的那个文件。
 *
 * 「打开安装包」「打开所在文件夹」都不接受渲染层传路径：那等于给它一个任意文件打开的口子
 * （`shell.openPath` 能拉起任何东西）。只认这里记下的那一个。
 */
let lastFile: string | null = null

/** Windows 上不许出现在文件名里的字符（别的平台也一并换掉，产物名本来就是三平台统一的） */
const ILLEGAL_NAME_CHARS = '\\/:*?"<>|'

/** 资产名只用来拼本地文件名，别让发布里一个奇怪的名字把路径带偏 */
function safeName(raw: string): string {
  // 逐字符过滤而不是写正则字符类：控制字符（U+0000–U+001F）放进正则字面量既不好读，
  // 也会被 lint 的 no-control-regex 判为问题
  const name = Array.from(basename(raw))
    .map((char) => (char.charCodeAt(0) < 0x20 || ILLEGAL_NAME_CHARS.includes(char) ? '_' : char))
    .join('')
    .trim()
  if (!name || name === '.' || name === '..') throw new Error('发布里的资产名不可用')
  return name
}

/**
 * 只允许 https 的 GitHub 资产地址。
 *
 * 地址来自主进程自己查到的 release（不经渲染层把关），这道校验是纵深防御：即便哪天
 * 调用方换了，也不会让应用去下载任意主机上的任意文件再打开它。
 */
function validateAssetUrl(raw: string): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('安装包地址无效')
  }
  if (url.protocol !== 'https:') throw new Error('安装包地址必须是 https')

  const host = url.hostname.toLowerCase()
  if (host !== 'github.com' && !host.endsWith('.githubusercontent.com')) {
    throw new Error(`安装包地址指向了意料之外的主机：${host}`)
  }
  return url.toString()
}

/** 下载目录里挑一个还不存在的名字（同名文件可能是上一次下的同一个版本） */
async function uniquePath(dir: string, name: string): Promise<string> {
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const extension = dot > 0 ? name.slice(dot) : ''

  for (let index = 1; index <= 20; index += 1) {
    const candidate = join(dir, index === 1 ? name : `${stem}-${index}${extension}`)
    try {
      await stat(candidate)
    } catch {
      return candidate
    }
  }
  throw new Error('下载目录里同名的文件太多了，先清一清')
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

/**
 * 走一条通路把文件收到 `temp`，返回实际写入的字节数。
 *
 * ⚠️ `net.request` 的响应是个纯 EventEmitter（没有 pause），所以背压只能靠文件流的缓冲兜住；
 *    磁盘比网络快一个量级，实际积不起来。停在那儿不动的情况由停滞看门狗收拾。
 */
function transfer(
  url: string,
  route: NetRoute,
  temp: string,
  expectedSize: number,
  onProgress: (progress: ClientUpdateProgress) => void,
  signal: AbortSignal
): Promise<number> {
  return getStream(url, route, {
    timeoutMs: CONNECT_TIMEOUT_MS,
    headers: {
      Accept: 'application/octet-stream',
      'User-Agent': `songloft-desktop/${app.getVersion()}`
    },
    signal
  }).then(
    ({ response, request }) =>
      new Promise<number>((resolve, reject) => {
        if (response.statusCode !== 200 && response.statusCode !== 206) {
          request.abort()
          reject(new Error(`下载失败：GitHub 返回了 HTTP ${response.statusCode}`))
          return
        }

        const header = response.headers['content-length']
        const headered = Number(Array.isArray(header) ? header[0] : header) || 0
        const total = headered || expectedSize

        const out = createWriteStream(temp)
        let received = 0
        let lastReport = 0
        /** promise 已经落定（成功或失败）：之后的回调只做清理，别二次 settle */
        let done = false

        const stall = setTimeout(() => {
          request.abort()
          settleError(new Error(`下载停滞：超过 ${STALL_TIMEOUT_MS / 1000} 秒没有收到数据`))
        }, STALL_TIMEOUT_MS)

        function cleanup(): void {
          clearTimeout(stall)
          response.removeListener('data', onData)
          response.removeListener('end', onEnd)
          response.removeListener('error', onError)
          response.removeListener('aborted', onAborted)
          out.removeListener('error', onWriteError)
        }

        function settleResolve(bytes: number): void {
          if (done) return
          done = true
          cleanup()
          onProgress({ received, total })
          resolve(bytes)
        }

        function settleError(error: Error): void {
          if (done) return
          done = true
          cleanup()
          // destroy 不带 error：这里已经在 reject 了，再抛一次会变成未捕获的 'error'
          out.destroy()
          reject(signal.aborted ? abortError() : error)
        }

        function report(): void {
          const now = Date.now()
          if (now - lastReport < PROGRESS_INTERVAL_MS && received < total) return
          lastReport = now
          onProgress({ received, total })
        }

        function onData(chunk: Buffer): void {
          stall.refresh()
          received += chunk.length
          out.write(chunk)
          report()
        }

        function onEnd(): void {
          if (done) return
          // 数据收完了，停滞看门狗该撤了（剩下的只是把缓冲刷到盘上）
          clearTimeout(stall)
          out.end(() => {
            // 长度对不上就是没下全：截断的连接有时也会正常 end
            if (expectedSize > 0 && received !== expectedSize) {
              settleError(new Error(`下载不完整：收到 ${received} 字节，应为 ${expectedSize} 字节`))
              return
            }
            settleResolve(received)
          })
        }

        function onError(error: Error): void {
          settleError(error)
        }

        function onAborted(): void {
          settleError(abortError())
        }

        function onWriteError(error: Error): void {
          request.abort()
          settleError(error)
        }

        response.on('data', onData)
        response.once('end', onEnd)
        response.once('error', onError)
        response.once('aborted', onAborted)
        out.once('error', onWriteError)
      })
  )
}

/**
 * 下载安装包：先按配置的通路试，失败再直连一次。
 *
 * 失败的那条通路留下的 `.part` 一律删掉 —— 半份安装包留在下载目录里比没有更糟：
 * 用户会以为它就是完整的。
 */
export async function downloadClientUpdate(
  request: ClientUpdateDownloadRequest,
  onProgress: (progress: ClientUpdateProgress) => void
): Promise<ClientUpdateDownloadResult> {
  if (current) throw new Error('已经有一个安装包在下载了，等它结束或先取消')

  const url = validateAssetUrl(request.asset.url)
  const plan = await planProxies(request)
  const routes = routesFor(plan)

  const controller = new AbortController()
  current = controller

  try {
    const dir = app.getPath('downloads')
    await mkdir(dir, { recursive: true })

    const file = await uniquePath(dir, safeName(request.asset.name))
    const temp = `${file}.part`

    let lastError: unknown = null
    for (const [index, route] of routes.entries()) {
      try {
        onProgress({ received: 0, total: request.asset.size })
        const bytes = await transfer(
          url,
          route,
          temp,
          request.asset.size,
          onProgress,
          controller.signal
        )
        await rename(temp, file)
        // AppImage 下载下来默认没有执行位，双击会被当成普通文件
        if (file.toLowerCase().endsWith('.appimage')) await chmod(file, 0o755)
        lastFile = file
        return {
          path: file,
          bytes,
          route: routeLabel(index, routes),
          httpProxyUnreachable: plan.httpProxyUnreachable
        }
      } catch (error) {
        await rm(temp, { force: true }).catch(() => undefined)
        // 取消不是「通路失败」：换个通路再来一遍只会让用户觉得点了没反应
        if (isAbort(error)) throw new Error('已取消下载', { cause: error })
        lastError = error
      }
    }

    const reason = lastError instanceof Error ? lastError.message : '未知原因'
    throw new Error(routes.length > 1 ? `${reason}（代理与直连都没成功）` : reason)
  } finally {
    current = null
  }
}

/** 取消正在跑的下载（没有在跑时什么也不做） */
export function cancelClientUpdate(): void {
  current?.abort()
}

/** 用系统默认程序打开刚下好的安装包（结果由系统决定：安装向导 / 软件中心 / 挂载 dmg） */
export async function openDownloadedUpdate(): Promise<void> {
  if (!lastFile) throw new Error('还没有下载好的安装包')
  const failure = await shell.openPath(lastFile)
  // openPath 失败时返回一句错误描述（成功是空串），不会抛
  if (failure) throw new Error(`打不开安装包：${failure}`)
}

/** 在文件管理器里定位刚下好的安装包 */
export function revealDownloadedUpdate(): void {
  if (!lastFile) throw new Error('还没有下载好的安装包')
  shell.showItemInFolder(lastFile)
}
