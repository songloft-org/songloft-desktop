/**
 * 客户端（桌面端自身）的更新检查。
 *
 * **查 + 下载，但不装**，这是刻意的：桌面端由安装包 / 包管理器分发，应用替自己换二进制一旦
 * 半路失败（下载中断、目录不可写、替换到一半），用户手上就剩一个跑不起来的东西，而且没有
 * 回滚 —— AppImage 那套自更新正是「先删掉旧文件，再移入新文件」。所以这里只回答「有没有新
 * 版本」，把安装包下到本机，装交给系统安装程序（见 update-download.ts）。
 *
 * 放在主进程有三个具体理由：
 *   1. 渲染层不该直连第三方（它连后端都要走封装好的 ApiClient）；
 *   2. 主进程没有 CORS 限制 —— 打包态页面源是 file://，Origin 为 null；
 *   3. GitHub 接口要求带 User-Agent，而渲染层改不了这个头（forbidden header）。
 */

import { app } from 'electron'

import type { ClientUpdateCheck, ClientUpdateProxies } from '@shared/ipc'
import { REPO_SLUG } from '@shared/links'
import { pickUpdateAsset, type ClientUpdateAsset } from '@shared/update'

import { getStream, readText, routeLabel, routesFor, type NetRoute } from './net-path'
import { planProxies } from './proxy'

/** 查一次的上限。连不上 GitHub 时默认要等很久，界面会一直停在「正在检查」 */
const TIMEOUT_MS = 8000

/** 把失败讲成一句能看懂的话：403 / 404 的原因与「网络不通」完全不是一回事 */
function describeStatus(status: number): string {
  if (status === 403) return 'GitHub 拒绝了这次请求（共享网络下常见，是频率限制），稍后再试'
  if (status === 404) return 'GitHub 上找不到这个仓库的发布记录'
  return `GitHub 返回了 HTTP ${status}`
}

interface ReleasePayload {
  tag_name?: string
  html_url?: string
  published_at?: string
  assets?: Array<{ name?: string; size?: number; browser_download_url?: string }>
}

/**
 * 这份 release 挂了哪些资产。
 *
 * 只收「有名字 + 有下载地址」的项：GitHub 在资产还没传完时会给出缺字段的记录，
 * 拿它去下载只会得到一个 404。
 */
function releaseAssets(payload: ReleasePayload): ClientUpdateAsset[] {
  const assets: ClientUpdateAsset[] = []
  for (const item of payload.assets ?? []) {
    if (!item.name || !item.browser_download_url) continue
    assets.push({ name: item.name, size: item.size ?? 0, url: item.browser_download_url })
  }
  return assets
}

/**
 * 走某一条通路查一次 latest release。
 *
 * 403（频率限制）与 404（仓库/发布不存在）都不是「通路有问题」：换直连再问一次也一样，
 * 那句话会原样抛出去。真正的通路问题在更下层（连不上、超时），由 getStream 报。
 */
async function fetchLatest(route: NetRoute): Promise<ReleasePayload> {
  const target = `https://api.github.com/repos/${REPO_SLUG}/releases/latest`

  let response: Awaited<ReturnType<typeof getStream>>['response']
  try {
    ;({ response } = await getStream(target, route, {
      timeoutMs: TIMEOUT_MS,
      headers: {
        Accept: 'application/vnd.github+json',
        // GitHub 的 API 要求带 UA（渲染层改不了这个头，见文件头第 3 条）
        'User-Agent': `songloft-desktop/${app.getVersion()}`
      }
    }))
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'TimeoutError'
    // 带上 cause：给界面看的是那句话，排查时原始错误（DNS / 证书 / 代理）不能丢
    throw new Error(
      `检查更新失败：${
        timedOut ? `超过 ${TIMEOUT_MS / 1000} 秒没有响应` : '连不上 GitHub'
      }。可以直接到发布页看`,
      { cause: error }
    )
  }

  if (response.statusCode !== 200) {
    // 顺手把响应体读掉：GitHub 的错误说明在里面，而且不读会让连接一直挂着
    await readText(response).catch(() => '')
    throw new Error(`检查更新失败：${describeStatus(response.statusCode)}`)
  }

  const text = await readText(response)
  try {
    return JSON.parse(text) as ReleasePayload
  } catch {
    throw new Error('检查更新失败：GitHub 返回的内容无法解析')
  }
}

/**
 * 查 GitHub 上的最新 release。
 *
 * `proxies` 是服务端设置里那两项代理（「GitHub 加速代理」与「HTTP 代理」）。先按它们走一条
 * 通路，失败再直连重试一次 —— 代理配在服务器上、客户端未必连得到，而「查不到新版本」不该
 * 是这种配置差异的结果。实际走了哪条由 `route` 如实回报，界面据此说明。
 */
export async function checkClientUpdate(
  proxies: ClientUpdateProxies = { githubProxy: '', httpProxy: '' }
): Promise<ClientUpdateCheck> {
  const plan = await planProxies(proxies)
  const routes = routesFor(plan)

  let lastError: unknown = null
  for (const [index, route] of routes.entries()) {
    try {
      const data = await fetchLatest(route)
      return {
        latestTag: data.tag_name ?? '',
        latestUrl: data.html_url ?? '',
        publishedAt: data.published_at ?? '',
        // 挑「本机该下的那一份」：平台与架构只有主进程知道（APPIMAGE 也是运行期环境变量）
        asset: pickUpdateAsset(releaseAssets(data), {
          platform: process.platform,
          arch: process.arch,
          appImage: Boolean(process.env.APPIMAGE)
        }),
        route: routeLabel(index, routes),
        httpProxyUnreachable: plan.httpProxyUnreachable
      }
    } catch (error) {
      lastError = error
    }
  }

  throw lastError instanceof Error ? lastError : new Error('检查更新失败')
}
