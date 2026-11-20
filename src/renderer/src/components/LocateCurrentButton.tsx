/**
 * 曲库右下角的「定位正在播放」悬浮钮。
 *
 * ★ 锚在**不滚动的主内容栏**（.main-column）上：它正是列表所在的那一栏，宽度随右侧
 *   抽屉开合做 grid 过渡（--dur-3），按钮 absolute 在它的可视盒右下角，因此既不会被
 *   列表滚走，又跟着内容区域同步平移 —— 位置与动画速度都和内容一致，不必手工补偿
 *   --panel-w。早先锚到可滚动的 .page-slot 上会跟着内容一起滚，那不是悬浮。
 * ★ 四种曲库视图各摆一份，但只有**当前活跃页面槽**的那一份会 portal 出来；切走的那页
 *   把按钮收掉，不留一颗孤零零的钮停在别页上（见 usePageActive）。
 * ★ 满窗播放盖住整个原生面（z-index 35），那时没有列表可定位，也不渲染。
 * ★ 只有这一颗 36px 的圆钮接事件，底下的列表与播放条照常可点。
 */

import { useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { usePageActive } from '@/hooks/usePageActive'
import { useUi } from '@/state/useUi'
import { IconLocate } from './Icons'

export function LocateCurrentButton({ onClick }: { onClick: () => void }): React.JSX.Element {
  const anchorRef = useRef<HTMLSpanElement>(null)
  const [column, setColumn] = useState<HTMLElement | null>(null)
  const pageActive = usePageActive()
  const fullPlayer = useUi((s) => s.fullPlayer)

  useLayoutEffect(() => {
    setColumn(anchorRef.current?.closest<HTMLElement>('.main-column') ?? null)
  }, [])

  return (
    <>
      {/* 只为找到所在的那一栏主内容；display:none，不参与布局 */}
      <span ref={anchorRef} hidden />
      {column && pageActive && !fullPlayer
        ? createPortal(
            <button
              type="button"
              className="locate-current-btn"
              aria-label="定位正在播放的歌曲"
              data-tip="定位正在播放的歌曲"
              data-tip-place="top-left"
              onClick={onClick}
            >
              <IconLocate size={16} />
            </button>,
            column
          )
        : null}
    </>
  )
}
