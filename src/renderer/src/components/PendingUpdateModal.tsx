/**
 * 「新版本已下载」的启动提示。
 *
 * 它只做一件事：把用户**上一次自己下载**的那份安装包，在下次启动时再摆到他面前，
 * 由他点「立即安装」交给系统安装程序并退出应用。**不是静默自更新** —— 应用不替换自身
 * 二进制，用户在安装器里取消，当前版本照常运行（见 main/pending-update.ts）。
 *
 * ★ 挂在 App 根部而不是设置页里：这份记录与登录态无关，免登录（只听本地文件）那一趟
 *   也要提示。记录本身在主进程（ConfigStore），这里只是它的一个观察窗。
 */

import { formatBytes, formatVersion } from '@/lib/format'
import { useClientUpdate } from '@/state/useClientUpdate'

import { IconDownload } from './Icons'
import { Modal } from './Modal'

export function PendingUpdateModal(): React.JSX.Element | null {
  const pending = useClientUpdate((s) => s.pending)
  const installing = useClientUpdate((s) => s.installing)
  const install = useClientUpdate((s) => s.installPending)
  const dismiss = useClientUpdate((s) => s.dismissPending)

  if (!pending) return null

  return (
    <Modal
      title="新版本已下载"
      onClose={dismiss}
      footer={
        <>
          <button type="button" className="btn" onClick={dismiss} disabled={installing}>
            稍后再说
          </button>
          <button
            type="button"
            className="btn"
            data-variant="primary"
            onClick={() => void install()}
            disabled={installing}
          >
            <IconDownload size={15} />
            {installing ? '正在启动安装程序…' : '立即安装'}
          </button>
        </>
      }
    >
      <div className="stat-list">
        <div className="stat-row">
          <span>新版本</span>
          <span className="stat-row-value">{formatVersion(pending.version)}</span>
        </div>
        <div className="stat-row">
          <span>安装包</span>
          <span className="stat-row-value">
            {pending.name}
            {pending.size > 0 ? ` · ${formatBytes(pending.size)}` : ''}
          </span>
        </div>
      </div>

      <p className="field-hint" style={{ marginTop: 10 }}>
        这个安装包在上次下载时已经保存到「下载」目录。点「立即安装」会启动系统安装程序，
        随后应用会关闭；由安装程序引导你完成安装 —— 应用不会自己替换自身的二进制。
      </p>
      <p className="field-hint">
        在安装器里取消不会影响当前版本，下次启动照常使用旧版本；装完再打开应用即可。
      </p>
    </Modal>
  )
}
