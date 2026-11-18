/**
 * 本机磁盘缓存（客户端自己那份）。
 *
 * 桌面端没有另写一套缓存：封面图与接口响应直接交给 Chromium 的会话缓存，字节落在 userData 里。
 * 归本机所有 —— 换服务器、换账号都不会跟着走，换台机器更是从零开始。
 *
 * 与服务端音乐缓存（设置页里那一张卡片）不要混：那份在服务器上、所有设备共用，走 HTTP 接口；
 * 这份的读写只有主进程能做（渲染层连不上会话缓存）。
 */

import { app, session, type Session } from 'electron'

import type { LocalCacheStats } from '@shared/ipc'
import { PLUGIN_PARTITION } from '@shared/plugin'
import type { RenderCacheTarget } from '@shared/render-cache'

/**
 * 启动时交给 Chromium 的上限（0 = 不限）。
 *
 * 留着它不是为了配置，而是给界面一个「现在**真正**生效的是多少」的口径：
 * 用户刚改完设置、还没重启时，设置里的值与生效值不是一回事，两处都摆出来才不误导。
 */
let appliedMaxSize = 0

/**
 * 应用本机缓存上限。
 *
 * ★ 必须在 app ready 之前调用：Chromium 只在解析启动参数时读一次 `--disk-cache-size`，
 *   运行中没有任何 Electron API 能改它（`session.setCacheSize` 并不存在）。所以设置改动
 *   一律「存下来 + 下次启动生效」，界面上也要这么说。
 */
export function applyLocalCacheLimit(maxSize: number): void {
  appliedMaxSize = maxSize > 0 ? maxSize : 0
  if (appliedMaxSize > 0) app.commandLine.appendSwitch('disk-cache-size', String(appliedMaxSize))
}

/** 读本机缓存占用。session 只在 ready 之后可用，所以这条只能由 IPC 触发 */
export async function readLocalCache(): Promise<LocalCacheStats> {
  const ses = session.defaultSession
  return { size: await ses.getCacheSize(), maxSize: appliedMaxSize }
}

/**
 * 清掉某个会话的 HTTP 缓存与 JS 代码缓存。
 *
 * ★ 代码缓存不进 HTTP 缓存（它是 V8 编好的代码），但同样是**远端代码**的产物、同样会跟着
 *   版本一起过期 —— 只清 HTTP 缓存的话，旧 bundle 的编译结果仍然可能被复用。
 * ★ **不动存储类**：Local Storage / Cookies / IndexedDB 一律不碰。插件页把后端注入的 token
 *   写在 Local Storage 里（见 shared/plugin.ts），清它等于每次清缓存都让人重登一次。
 */
export async function clearSessionCaches(ses: Session): Promise<void> {
  await ses.clearCache()
  await ses.clearCodeCaches({})
}

/**
 * 按**目标**清缓存（策略在 shared/render-cache.ts，这里只负责落地）。
 *
 * `plugin` 是扩展页那个独立分区（PLUGIN_PARTITION）—— 所有插件页、插件自带的 static、
 * 以及后端投的公共运行时（theme/components/common.js / shim / web-core）都在它里面。
 */
export async function clearRenderCache(target: RenderCacheTarget): Promise<void> {
  const ses = target === 'app' ? session.defaultSession : session.fromPartition(PLUGIN_PARTITION)
  await clearSessionCaches(ses)
}

/**
 * 清掉本机缓存并回读占用。
 *
 * 就是默认会话那一份（设置页那张卡片）。**不动** Local Storage / IndexedDB（真清那两处等于把
 * 会话里的东西一起端掉）。凭据与设置本来就在 ConfigStore 的 JSON 里，不受影响。
 */
export async function clearLocalCache(): Promise<LocalCacheStats> {
  await clearSessionCaches(session.defaultSession)
  return readLocalCache()
}
