/**
 * 「添加电台」对话框（曲库 → 类型＝电台 时页头那颗按钮打开的就是它）。
 *
 * ★ 为什么只有三个字段：后端 `POST /songs/radio` 只认「地址 / 标题 / 是否视频」，
 *   封面与歌手那些留给播放时的元数据补齐 —— 用户添加电台时手里通常只有一条链接，
 *   现在就要他填封面，等于逼他先去趟别的软件。
 *
 * ★ 「视频内容」桌面端自己用不上（只出声音，没有视频面），它是写进曲库给**有画面能力
 *   的客户端**（网页端 / 移动端）用的。文案因此是「开启后播放页渲染画面」，别改成
 *   「在桌面端播放画面」—— 那是这个字段做不到的事。
 */

import { useRef, useState } from 'react'

import { IconPlus } from './Icons'
import { Modal } from './Modal'
import { Switch } from './primitives'
import { addRadios } from '@/api/endpoints'
import { requireClient } from '@/state/useAuth'
import { toast } from '@/state/useToasts'

export interface AddRadioDialogProps {
  onClose: () => void
  /** 确实新增了记录时调用（父组件据此刷新电台列表） */
  onAdded: () => void
}

/**
 * 把用户粘进来的地址补成能请求的形态；没法用就返回 null。
 *
 * 电台链接常常是「从别处复制来的裸域名」，少了协议整条地址就没法请求，这里补一个
 * `http://` 而不是直接报错。但**只接受 http / https**：后端是拿 HTTP 客户端去拉流的，
 * `mms://`、`rtsp://` 这类给了它也放不出来，不如当场说清楚。
 */
function normalizeRadioUrl(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
  try {
    const parsed = new URL(candidate)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    if (!parsed.hostname) return null
    return candidate
  } catch {
    return null
  }
}

export function AddRadioDialog({ onClose, onAdded }: AddRadioDialogProps): React.JSX.Element {
  const [url, setUrl] = useState('')
  const [title, setTitle] = useState('')
  const [isVideo, setIsVideo] = useState(false)
  const [saving, setSaving] = useState(false)
  const titleRef = useRef<HTMLInputElement>(null)

  const ready = url.trim().length > 0 && title.trim().length > 0 && !saving

  const submit = async (): Promise<void> => {
    if (!ready) return
    const normalized = normalizeRadioUrl(url)
    if (!normalized) {
      toast('地址填得不对', 'error', '需要 http:// 或 https:// 开头的电台链接')
      return
    }
    const name = title.trim()
    setSaving(true)
    try {
      const result = await addRadios(requireClient(), [
        { url: normalized, title: name, is_video: isVideo }
      ])
      if (result.count === 0) {
        // 后端不报错但也没新增：多半是这条地址已经在曲库里了
        toast('没有新增任何电台', 'error', '这条地址可能已经添加过了')
        return
      }
      toast(`已添加电台：${name}`, 'success')
      onAdded()
    } catch (error) {
      toast('添加电台失败', 'error', error instanceof Error ? error.message : undefined)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      title="添加电台"
      onClose={onClose}
      closeOnBackdrop={false}
      footer={
        <>
          <button type="button" className="btn" disabled={saving} onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="btn"
            data-variant="primary"
            disabled={!ready}
            onClick={() => void submit()}
          >
            <IconPlus size={15} />
            {saving ? '正在添加…' : '添加'}
          </button>
        </>
      }
    >
      <div className="field">
        <label className="field-label" htmlFor="radio-url">
          URL 地址
        </label>
        <input
          id="radio-url"
          className="input"
          autoFocus
          value={url}
          placeholder="http://…/playlist.m3u8"
          spellCheck={false}
          onChange={(event) => setUrl(event.target.value)}
          onKeyDown={(event) => {
            // 地址填完按回车就跳到标题，别逼着用户去够鼠标
            if (event.key === 'Enter') {
              event.preventDefault()
              titleRef.current?.focus()
            }
          }}
        />
        <div className="field-hint">电台的播放地址，HLS（.m3u8）与普通音频流都行</div>
      </div>

      <div className="field">
        <label className="field-label" htmlFor="radio-title">
          标题
        </label>
        <input
          id="radio-title"
          ref={titleRef}
          className="input"
          value={title}
          placeholder="例如：中国音乐之声"
          onChange={(event) => setTitle(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void submit()
          }}
        />
      </div>

      <div className="field">
        <div className="row-between" style={{ gap: 14 }}>
          <div style={{ minWidth: 0 }}>
            <div className="field-label">视频内容</div>
            <div className="field-hint">此链接含视频画面（如电视直播），开启后播放页渲染画面</div>
          </div>
          <Switch checked={isVideo} onChange={setIsVideo} ariaLabel="视频内容" />
        </div>
      </div>
    </Modal>
  )
}
