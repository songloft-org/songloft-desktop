/**
 * 客户端更新（桌面端自己）的界面状态：查 → 下 → 交给系统安装。
 *
 * **为什么不放在弹窗的 useState 里**：下载动辄几分钟，而弹窗随时会被关掉（Esc、点遮罩、
 * 切去别的页）。状态跟着组件走的话，重新打开就只剩一个「检查更新」按钮 —— 既看不到进度，
 * 也放不下那个已经下好的安装包。放在 store 里，弹窗只是它的一个观察窗。
 *
 * ★ 这里仍然**不做安装**：应用不替换自身的二进制，只把安装包下到「下载」目录并打开它
 *   （理由见 src/main/update-download.ts）。所以状态机的终点是「已下载」，不是「已安装」。
 */

import { create } from 'zustand'

import type {
  ClientUpdateCheck,
  ClientUpdateDownloadResult,
  ClientUpdateProgress,
  ClientUpdateProxies
} from '@shared/ipc'

import { getGithubProxy, getHttpProxy } from '@/api/endpoints'

import { requireClient } from './useAuth'
import { toast } from './useToasts'

/** 用户主动取消时主进程给的文案；它不是失败，别在界面上摆成红字 */
const CANCELLED = '已取消下载'

interface ClientUpdateState {
  /** 最近一次检查的结果；null = 还没查过 */
  check: ClientUpdateCheck | null
  checking: boolean
  /** 检查失败的原因（连不上 GitHub / 频率限制…） */
  error: string | null
  downloading: boolean
  /** 下载进度；没在下就是 null */
  progress: ClientUpdateProgress | null
  /** 已经下好的安装包 */
  file: ClientUpdateDownloadResult | null
  /** 下载失败的原因 */
  downloadError: string | null

  checkNow(): Promise<void>
  download(): Promise<void>
  cancel(): void
  openFile(): Promise<void>
  revealFile(): Promise<void>
}

/**
 * 把两项服务端代理读出来交给主进程。
 *
 * 读不到就都给空串（= 直连）：客户端更新不该被后端可达性牵连 —— 没登录时 `requireClient()`
 * 是**同步抛**的，所以要先包进 Promise，让它退化成「读不到」而不是掀掉整棵组件树。
 */
async function readProxies(): Promise<ClientUpdateProxies> {
  return Promise.resolve()
    .then(() => requireClient())
    .then((client) =>
      Promise.all([getGithubProxy(client).catch(() => ''), getHttpProxy(client).catch(() => '')])
    )
    .then(([githubProxy, httpProxy]) => ({ githubProxy, httpProxy }))
    .catch(() => ({ githubProxy: '', httpProxy: '' }))
}

export const useClientUpdate = create<ClientUpdateState>((set, get) => ({
  check: null,
  checking: false,
  error: null,
  downloading: false,
  progress: null,
  file: null,
  downloadError: null,

  async checkNow() {
    set({ checking: true, error: null })
    try {
      const check = await window.songloft.app.checkClientUpdate(await readProxies())
      // 已下好的安装包只对「当时那个版本」有意义：查到了别的版本就别再把它摆出来
      // （文件仍在下载目录里，用户自己去拿就是了）
      set((state) => ({
        check,
        file: state.check && state.check.latestTag === check.latestTag ? state.file : null
      }))
    } catch (err) {
      set({ error: err instanceof Error ? err.message : '检查更新失败' })
    } finally {
      set({ checking: false })
    }
  },

  async download() {
    if (get().downloading) return

    const asset = get().check?.asset
    if (!asset) {
      set({ downloadError: '这次的发布里没有本机可用的安装包，到发布页看' })
      return
    }

    set({
      downloading: true,
      downloadError: null,
      file: null,
      progress: { received: 0, total: asset.size }
    })

    try {
      const proxies = await readProxies()
      const file = await window.songloft.app.downloadClientUpdate({ ...proxies, asset })
      set({ file })
      toast('安装包已下载', 'success', file.path)
    } catch (err) {
      const message = err instanceof Error ? err.message : '下载失败'
      // 取消是用户自己按的，不该在界面上留一条红字
      set({ downloadError: message === CANCELLED ? null : message })
    } finally {
      set({ downloading: false, progress: null })
    }
  },

  cancel() {
    void window.songloft.app.cancelClientUpdate().catch(() => undefined)
  },

  async openFile() {
    try {
      await window.songloft.app.openClientUpdate()
    } catch (err) {
      toast('打不开安装包', 'error', err instanceof Error ? err.message : undefined)
    }
  },

  async revealFile() {
    try {
      await window.songloft.app.revealClientUpdate()
    } catch (err) {
      toast('打不开所在文件夹', 'error', err instanceof Error ? err.message : undefined)
    }
  }
}))

/**
 * 接上下载进度的推送，返回取消订阅函数。
 *
 * 装备在 App.tsx 那个**不带一次性守卫**的 effect 里（与投送状态同一处）：下载可能比一次
 * HMR 重新挂载活得更久，装上就断的话进度会停在那一帧上。
 */
export function installClientUpdateProgress(): () => void {
  return window.songloft.app.onClientUpdateProgress((progress) => {
    useClientUpdate.setState({ progress })
  })
}
