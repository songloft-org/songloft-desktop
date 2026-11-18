/**
 * 渲染缓存失效的**落地**：把 shared/render-cache.ts 算出来的「清哪几个会话」执行掉。
 *
 * 三个触发点（客户端升级 / 后端升级 / 插件更新）从两条路进来：
 *   * 客户端版本只有主进程知道 —— 启动时自己比对一次（reconcileClientCache）；
 *   * 后端版本与插件列表在渲染层手里（那是它唯一能拿到这两样的地方）—— 它经 IPC 报上来
 *     （`cache:reconcile`），主进程比对 + 清理 + 记账。
 *
 * ★ 为什么判定逻辑不在这儿：那段是纯函数，能直接单测（见 shared/render-cache.test.ts）。
 *   三条规则（各清哪些、什么时候只记录不清、哪些键按服务器分开存）错一条都很难在界面上
 *   看出来 —— 症状只有「怎么还是旧的」或者「怎么又在下东西」。
 */

import { app } from 'electron'

import {
  planRenderCacheReconcile,
  type RenderCacheFacts,
  type RenderCacheRequest,
  type RenderCacheTarget
} from '@shared/render-cache'
import { clearRenderCache } from './cache'
import { walletKeyFor, type ConfigStore } from './store'

export interface RenderCacheReconcileResult {
  /** 这一轮实际清掉（或正在清）的会话 */
  cleared: RenderCacheTarget[]
}

/**
 * 记一笔新状态并按需清缓存。
 *
 * ★ **先写盘再清**：清缓存可能要几秒，这段时间里应用完全可能被关掉 —— 反过来（先清后写）
 *   的话，下一次启动会拿旧记录再判成「又变了」，再清一遍。
 * ★ 失败不影响调用方：缓存清不掉最多是「这次还用旧的」，绝不能因此让插件页打不开。
 */
async function reconcile(
  store: ConfigStore,
  facts: RenderCacheFacts
): Promise<RenderCacheReconcileResult> {
  const plan = planRenderCacheReconcile(store.getRenderCacheState(), facts)
  if (plan.changed) {
    try {
      store.setRenderCacheState(plan.state)
    } catch (error) {
      console.error('[render-cache] 版本记录写入失败', error)
    }
  }

  if (plan.clear.length === 0) return { cleared: [] }

  console.info('[render-cache] 检测到更新，清理渲染缓存', {
    targets: plan.clear,
    clientVersion: facts.clientVersion,
    server: facts.serverKey,
    backendVersion: facts.backendVersion,
    pluginSignature: facts.pluginSignature
  })

  for (const target of plan.clear) {
    try {
      await clearRenderCache(target)
    } catch (error) {
      // 一个会话清失败不该连累另一个
      console.error(`[render-cache] 清理 ${target} 失败`, error)
    }
  }
  return { cleared: plan.clear }
}

/** 启动时比对客户端版本（唯一一处只有主进程知道的更新信号） */
export function reconcileClientCache(store: ConfigStore): Promise<RenderCacheReconcileResult> {
  return reconcile(store, { clientVersion: app.getVersion() })
}

/**
 * 渲染层报上来的那一份（后端版本 / 插件列表签名）。
 *
 * 服务器身份在这里归一成 `walletKey`（`protocol//host`），与凭据、服务器列表用的是同一个键 ——
 * 否则同一台服务器写成 `http://1.2.3.4:58091` 与 `http://1.2.3.4:58091/` 会被当成两台。
 */
export function reconcileFromRenderer(
  store: ConfigStore,
  request: RenderCacheRequest | null | undefined
): Promise<RenderCacheReconcileResult> {
  const serverKey = typeof request?.serverKey === 'string' ? walletKeyFor(request.serverKey) : ''
  return reconcile(store, {
    clientVersion: app.getVersion(),
    serverKey,
    backendVersion: typeof request?.backendVersion === 'string' ? request.backendVersion : '',
    pluginSignature: typeof request?.pluginSignature === 'string' ? request.pluginSignature : ''
  })
}
