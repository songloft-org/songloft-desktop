/**
 * 渲染缓存失效的**渲染层一半**：把「后端版本 / 插件列表签名」报给主进程。
 *
 * 分两路而不是一路，是因为它们拿到的时机本来就不同：
 *   * 后端版本要等会话就绪（`/version` 是匿名接口，但 baseUrl 得先定下来）；
 *   * 插件列表要等它自己加载完（`usePlugins` 在连接成功后才会去取）。
 *
 * ★ 刻意**不在这里判定「该不该清」**：那是 shared/render-cache.ts 的纯函数，主进程执行。
 *   渲染层只做一件它独占的事 —— 报数。判定与落地各在一处，才不会出现「两个地方口径不一致」。
 * ★ 也不在这里提示用户：清缓存是维护动作，报一句「已为你清理缓存」只会让人觉得出了故障。
 */

import { useEffect } from 'react'

import { backendCacheKey, pluginCacheSignature } from '@shared/render-cache'
import { getVersion } from '@/api/endpoints'
import { requireClient, useAuth } from './useAuth'
import { usePlugins } from './usePlugins'

/**
 * 装上这两条报数线。只在主窗口调用（迷你窗不连服务器，也没有插件列表）。
 *
 * 两条都**幂等**：主进程按「与上次记录比」决定清不清，重复报同一个版本不会清第二次。
 * 所以这里不必再做「一次运行只跑一次」的守卫 —— 那个守卫反而会让 dev 的 HMR 重新挂载后
 * 少报一次（而重启本来就该重新核对一次）。
 */
export function useRenderCacheReconcile(): void {
  const status = useAuth((state) => state.status)
  const baseUrl = useAuth((state) => state.baseUrl)
  const plugins = usePlugins((state) => state.plugins)
  const pluginsLoaded = usePlugins((state) => state.loaded)

  // 后端版本：每个服务器每次会话查一次（换了服务器会自然重跑）
  useEffect(() => {
    if (status !== 'authenticated' || !baseUrl) return

    let cancelled = false
    void (async () => {
      // 查不到（老后端 404 / 网络抖动）就这一轮不报：宁可少清一次，也不要猜
      const version = await getVersion(requireClient()).catch(() => null)
      const backendVersion = backendCacheKey(version)
      if (cancelled || !backendVersion) return
      await window.songloft.cache
        .reconcile({ serverKey: baseUrl, backendVersion })
        .catch(() => undefined)
    })()

    return () => {
      cancelled = true
    }
  }, [status, baseUrl])

  // 插件列表：加载完报一次，之后列表一变（装 / 卸 / 更新）再报
  useEffect(() => {
    if (status !== 'authenticated' || !baseUrl || !pluginsLoaded) return
    void window.songloft.cache
      .reconcile({ serverKey: baseUrl, pluginSignature: pluginCacheSignature(plugins) })
      .catch(() => undefined)
  }, [status, baseUrl, pluginsLoaded, plugins])
}
