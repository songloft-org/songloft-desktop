/**
 * 「GitHub Token」对话框 —— 插件商店里「GitHub 发现」的凭据。
 *
 * 为什么需要它：GitHub 匿名访问每小时只有 60 次，而一页发现就要几十次（每个仓库两次核对），
 * 配了 Token 才够逛。Token 存在**服务端**（`/settings/github-discovery-token`），同一台服务器
 * 上的客户端共用一份；发现请求仍由本机发出。
 *
 * 两条语义写进界面，不然很容易踩：
 *   1. 有 Token 时直连 `api.github.com`，**不走** GitHub 加速代理（前缀式代理会把
 *      Authorization 丢掉，更糟的是转给第三方）；
 *   2. 「清除」= 保存空串，不是删掉这一项配置。
 */

import { useEffect, useRef, useState } from 'react'

import { IconExternal, IconLoader } from './Icons'
import { Modal } from './Modal'

export interface GithubTokenDialogProps {
  /** 服务器上当前的 Token（空串 = 未配置） */
  token: string
  /** 正在读服务器上那份配置 */
  loading: boolean
  /** 读配置失败的原因（不影响保存） */
  loadError: string | null
  onSave: (token: string) => Promise<void>
  onClose: () => void
}

export function GithubTokenDialog({
  token,
  loading,
  loadError,
  onSave,
  onClose
}: GithubTokenDialogProps): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const [visible, setVisible] = useState(false)
  const [saving, setSaving] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  /**
   * 保存期间用户点了取消：别再去动已经卸载的表单。
   *
   * ★ 必须在 effect **每次挂上时重新置 true**。`main.tsx` 挂着 StrictMode，开发模式下它会
   *   把 effect 跑成「挂上 → 卸下 → 再挂上」：只写卸载那一半的话，第二轮之后 `alive` 永远是
   *   false —— 于是保存成功不关窗、失败不报错、`saving` 也不复位，按钮就一直转圈圈。
   *   生产构建里 StrictMode 不会重复跑 effect，所以这个坑只在 `pnpm dev` 下露出来。
   */
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const save = (value: string): void => {
    if (saving) return
    setSaving(true)
    setProblem(null)
    void onSave(value)
      .then(() => {
        if (alive.current) onClose()
      })
      .catch((reason: unknown) => {
        if (alive.current) {
          setProblem(reason instanceof Error ? reason.message : '保存 GitHub Token 失败')
        }
      })
      .finally(() => {
        if (alive.current) setSaving(false)
      })
  }

  return (
    <Modal
      title="GitHub Token"
      // 这是一张填了一半的表单，点遮罩关掉太容易误伤
      closeOnBackdrop={false}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="btn"
            data-variant="primary"
            disabled={saving || loading || !draft.trim()}
            onClick={() => save(draft.trim())}
          >
            {saving ? <IconLoader size={15} /> : null}
            保存
          </button>
        </>
      }
    >
      {/*
        ★ 已配置时露出末尾四位：输入框里永远是空的（不回填凭据是刻意的），只写「已配置」
          时用户没法确认存进去的就是那一串 —— 会以为「保存没生效、打开又是空的」。
      */}
      <p className="field-hint" style={{ marginTop: 0 }}>
        {loading
          ? '正在读取服务器上的 Token…'
          : token
            ? `当前服务器已配置 Token（末尾 ${token.slice(-4)}）。`
            : '当前服务器未配置 Token（匿名访问每小时只有 60 次，一页发现就可能用光）。'}
      </p>

      {loadError ? (
        <div className="probe-result" data-state="error">
          <span>读取失败：{loadError}</span>
        </div>
      ) : null}

      <div className="row">
        <input
          className="input"
          type={visible ? 'text' : 'password'}
          value={draft}
          placeholder="输入新的个人访问 Token（只需 public_repo 读权限）"
          spellCheck={false}
          autoComplete="off"
          aria-label="GitHub Token"
          disabled={loading || saving}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && draft.trim()) save(draft.trim())
          }}
        />
        <button
          type="button"
          className="btn"
          data-size="sm"
          aria-label={visible ? '隐藏输入内容' : '显示输入内容'}
          onClick={() => setVisible((value) => !value)}
        >
          {visible ? '隐藏' : '显示'}
        </button>
      </div>

      {problem ? (
        <div className="probe-result" data-state="error">
          <span>{problem}</span>
        </div>
      ) : null}

      <div className="row" style={{ gap: 14 }}>
        <button
          type="button"
          className="link"
          onClick={() =>
            void window.songloft.shell.openExternal('https://github.com/settings/tokens')
          }
        >
          <IconExternal size={12} /> 创建 GitHub Token
        </button>
        {token ? (
          <button type="button" className="link" onClick={() => save('')}>
            清除 Token
          </button>
        ) : null}
      </div>

      <p className="field-hint">
        {
          'Token 保存在当前连接的服务器上，连接它的客户端共用一份。配置后 GitHub API 直连（不经加速代理）；清除即保存空串。'
        }
      </p>
    </Modal>
  )
}
