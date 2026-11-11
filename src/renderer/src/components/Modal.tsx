/** 模态框：遮罩 + 面板（portal 到 body，见 Overlay），Esc 关闭 */

import { useEffect } from 'react'

import { IconClose } from './Icons'
import { Overlay } from './Overlay'

export interface ModalProps {
  title: string
  onClose: () => void
  children: React.ReactNode
  footer?: React.ReactNode
  size?: 'normal' | 'wide'
  /** 点遮罩是否关闭（表单类对话框建议关掉，避免误触丢失输入） */
  closeOnBackdrop?: boolean
}

export function Modal({
  title,
  onClose,
  children,
  footer,
  size = 'normal',
  closeOnBackdrop = true
}: ModalProps): React.JSX.Element {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <Overlay onDismiss={closeOnBackdrop ? onClose : undefined}>
      <div className="modal" data-size={size} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <div className="modal-title">{title}</div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭">
            <IconClose size={16} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-foot">{footer}</div> : null}
      </div>
    </Overlay>
  )
}
