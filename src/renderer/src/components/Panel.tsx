/**
 * 右侧抽屉：正在播放（大封面 + 歌词）/ 播放队列。
 *
 * 做成常驻抽屉而不是独立路由页（Flutter 端「播放器」是一个整页路由）：
 * 桌面宽屏下用户往往想边看曲库边看歌词，切换整页会丢掉列表滚动位置。
 */

import { useEffect, useRef, useState } from 'react'

import { IconChevronRight, IconListMusic, IconMusic, IconQueue, IconTrash } from './Icons'
import { Cover, EmptyState } from './primitives'
import { LyricsView } from './LyricsView'
import { openMenuFromEvent } from './ContextMenu'
import { buildSongMenuItems } from './songMenu'
import { fallbackTitle, songCoverUrl } from '@shared/metadata'
import { displayArtist, formatDuration } from '@/lib/format'
import { findScrollParent } from '@/lib/scroll'
import { usePlayer } from '@/state/usePlayer'
import { useUi } from '@/state/useUi'

export function Panel(): React.JSX.Element | null {
  const { panelOpen, panelTab, setPanelTab, setPanelOpen } = useUi()
  if (!panelOpen) return null

  return (
    <aside className="panel" aria-label={panelTab === 'queue' ? '播放队列' : '正在播放'}>
      <div className="panel-head">
        {/* 「收起」在左、页签在右：收起是把这块整个移走，跟「在面板内部换页」不是
            一类操作，分开摆就不容易点错。箭头朝右 —— 抽屉在窗口右边，收起就是往右走
            （侧栏在左边，它的收起箭头朝左，两边一致） */}
        <button
          type="button"
          className="icon-btn"
          data-tip="收起面板"
          aria-label="收起面板"
          onClick={() => setPanelOpen(false)}
        >
          <IconChevronRight size={16} />
        </button>
        <div className="row grow" style={{ gap: 4 }}>
          <button
            type="button"
            className="icon-btn"
            data-active={panelTab === 'now-playing'}
            data-tip="正在播放"
            aria-label="正在播放"
            onClick={() => setPanelTab('now-playing')}
          >
            <IconMusic size={16} />
          </button>
          <button
            type="button"
            className="icon-btn"
            data-active={panelTab === 'queue'}
            data-tip="播放队列"
            aria-label="播放队列"
            onClick={() => setPanelTab('queue')}
          >
            <IconQueue size={16} />
          </button>
        </div>
      </div>

      <div
        className="panel-body"
        style={panelTab === 'now-playing' ? { overflow: 'hidden' } : undefined}
      >
        {panelTab === 'now-playing' ? <NowPlaying /> : <Queue />}
      </div>
    </aside>
  )
}

function NowPlaying(): React.JSX.Element {
  const song = usePlayer((s) =>
    s.cursor >= 0 && s.cursor < s.order.length ? s.queue[s.order[s.cursor]] : null
  )
  const context = usePlayer((s) => s.context)

  if (!song) {
    return (
      <EmptyState
        icon={<IconMusic size={26} />}
        title="还没有在播放"
        description="从曲库挑一首，或按 Ctrl+K 搜索"
      />
    )
  }

  return (
    <div className="now-playing">
      <div className="now-playing-art-wrap">
        <div className="now-playing-art">
          <Cover coverUrl={songCoverUrl(song)} width={640} size="100%" radius={0} kind="song" />
        </div>
      </div>
      <div className="now-playing-meta">
        <div className="now-playing-title">{fallbackTitle(song)}</div>
        <div className="now-playing-sub">
          {displayArtist(song.artist)}
          {song.album ? ` · ${song.album}` : ''}
        </div>
        <div className="row" style={{ marginTop: 7, gap: 6, flexWrap: 'wrap' }}>
          {context ? (
            <span className="badge">来自{context.type === 'playlist' ? '歌单' : context.type}</span>
          ) : null}
          {song.format ? <span className="badge">{song.format.toUpperCase()}</span> : null}
          {song.bit_rate ? (
            <span className="badge">{Math.round(song.bit_rate / 1000)}k</span>
          ) : null}
          {song.year ? <span className="badge">{song.year}</span> : null}
        </div>
      </div>
      <LyricsView />
    </div>
  )
}

/**
 * 播放队列。
 *
 * ★ 导出是为了给**迷你窗那块面板**复用（见 MiniPlayer.tsx）：同一个队列在两处出现，
 *   两套实现迟早分叉（拖拽排序、跟随当前曲滚动…都得各写一遍）。
 *   它自己不带滚动容器 —— 谁挂它谁负责给（抽屉那边是 .panel-body，迷你那边是 .mini-queue）。
 * ★ currentSlot：定位当前曲时，要它落在容器**从上往下第 currentSlot+1 格**（0 = 只保证看得见）。
 *   迷你面板给 2（第 3 格），抽屉给默认的 0 —— 理由见下面那段 effect 的说明。
 * ★ menu：右键菜单开不开。**迷你窗里要关掉**——那份菜单的动作（加入歌单 / 从曲库删除 /
 *   查看歌手…）全都要主窗口的曲库与会话，而迷你窗是另一棵界面树、同一份组件：
 *   菜单画得出来（它读的也是 usePlayer 的镜像），点下去却落在没有那些 store 的一侧，
 *   表现是「点了没反应」—— 那比没有这个菜单更糟。跳转/移除/拖动排序这些小窗里做得成的事
 *   照旧可用（它们都只是播放器上的动作，能过桥）。
 */
export function Queue({
  currentSlot = 0,
  menu = true
}: {
  currentSlot?: number
  menu?: boolean
}): React.JSX.Element {
  const queue = usePlayer((s) => s.queue)
  const order = usePlayer((s) => s.order)
  const cursor = usePlayer((s) => s.cursor)
  const moveInQueue = usePlayer((s) => s.moveInQueue)
  const removeFromQueue = usePlayer((s) => s.removeFromQueue)
  const clearQueue = usePlayer((s) => s.clearQueue)
  const jumpTo = usePlayer((s) => s.jumpTo)

  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const currentIndex = cursor >= 0 && cursor < order.length ? order[cursor] : -1

  // 挂载（面板打开）与换曲时，把当前项摆到它该在的位置上
  useEffect(() => {
    if (currentIndex < 0) return
    const list = listRef.current
    const item = list?.querySelector<HTMLElement>(`[data-queue-index="${currentIndex}"]`)
    const container = findScrollParent(list ?? null)
    if (!item || !container) return

    /*
     * ★ 自己算偏移，**不用 item.scrollIntoView()**（「能滚的祖先」怎么找见 lib/scroll.ts）：
     *   那个 API 会把「它所有的祖先滚动容器」依次滚一遍，视口也在内。迷你窗只有 400×480，
     *   而列表项在文档坐标里可能远在窗口下方（被 .mini-queue 剪掉的那些仍然占着文档坐标），
     *   于是那一下会连着视口一起滚 —— 整条迷你播放器被顶出窗外，右上角那三颗窗口钮跟着不见。
     *
     * ★ 两种落法，用途不同：
     *   · currentSlot = 0（抽屉）：只保证看得见 —— 在上方露不出来就贴顶、下方露不出来就贴底，
     *     已经在视野里就一动不动（等价于 block: 'nearest'）。
     *   · currentSlot > 0（迷你面板）：**固定**落在从上往下第 currentSlot+1 格，上面留出
     *     currentSlot 行。面板只有 416px 高，只保证「看得见」的话当前曲会贴着下边缘、
     *     甚至掉到视野之外。
     *
     * ★ 目标只用「项相对容器顶部的距离」算，**不牵扯可视高度**，也就不用自己夹上限
     *   （给过大的值由引擎夹到 max）。这一点在迷你面板刚展开时是决定性的：那会儿窗口还没被
     *   主进程加高，容器的 clientHeight 是 0，但列表是照自身高度铺开的，那个距离量得照样准；
     *   等容器长起来，它正好停在第 currentSlot+1 格。反过来，若按可视高度去算（或先入为主地
     *   认为「没高度就没法算」），算出来的就是 0 高度下的 0 —— 窗口一长高全错位，表现正是
     *   「打开播放列表，当前曲却跑到下面看不见的地方」。
     */
    const cRect = container.getBoundingClientRect()
    const iRect = item.getBoundingClientRect()
    /** 当前项相对容器**滚动原点**的位置（与容器此刻有多高无关） */
    const offset = container.scrollTop + (iRect.top - cRect.top)

    let target: number
    if (currentSlot > 0) {
      target = offset - currentSlot * item.offsetHeight
    } else {
      const delta =
        iRect.top < cRect.top
          ? iRect.top - cRect.top
          : iRect.bottom > cRect.bottom
            ? iRect.bottom - cRect.bottom
            : 0
      if (delta === 0) return
      target = offset + delta
    }

    /* 容器还没有高度时（迷你面板刚展开那一下）用即时跳转：那时做平滑动画没有意义，
       而且动画可能被随后的尺寸变化打断，停在半路上。 */
    container.scrollTo({
      top: Math.max(0, target),
      behavior: container.clientHeight > 0 ? 'smooth' : 'instant'
    })
  }, [currentIndex, currentSlot])

  if (queue.length === 0) {
    return (
      <EmptyState
        icon={<IconListMusic size={26} />}
        title="播放队列是空的"
        description="双击歌曲或右键「加入播放队列」"
      />
    )
  }

  const totalDuration = queue.reduce((sum, s) => sum + (s.duration || 0), 0)

  return (
    <div ref={listRef}>
      <div
        className="row-between"
        style={{ padding: '12px 16px 6px', fontSize: 12, color: 'var(--text-4)' }}
      >
        <span>
          共 {queue.length} 首 · {formatDuration(totalDuration)}
        </span>
        <button
          type="button"
          className="btn"
          data-size="sm"
          data-variant="ghost"
          onClick={() => clearQueue()}
        >
          <IconTrash size={14} />
          清空
        </button>
      </div>

      {queue.map((song, index) => (
        <div
          key={`${song.id}-${index}`}
          className="queue-item"
          data-queue-index={index}
          data-current={index === currentIndex}
          data-dragging={dragIndex === index}
          onDoubleClick={() => void jumpTo(index)}
          onContextMenu={
            menu ? (event) => openMenuFromEvent(event, buildSongMenuItems([song])) : undefined
          }
          draggable
          onDragStart={() => setDragIndex(index)}
          onDragOver={(event) => {
            if (dragIndex === null) return
            event.preventDefault()
          }}
          onDrop={() => {
            if (dragIndex !== null && dragIndex !== index) moveInQueue(dragIndex, index)
            setDragIndex(null)
          }}
          onDragEnd={() => setDragIndex(null)}
        >
          <span className="queue-drag" data-tip="拖动调整顺序">
            <IconMusic size={14} />
          </span>
          <Cover coverUrl={songCoverUrl(song)} width={72} size={38} radius={8} kind="song" />
          <div style={{ minWidth: 0 }}>
            <div className="queue-title truncate">{fallbackTitle(song)}</div>
            <div className="queue-artist truncate">{displayArtist(song.artist)}</div>
          </div>
          <div className="row" style={{ gap: 2 }}>
            <span className="song-duration">{formatDuration(song.duration)}</span>
            <button
              type="button"
              className="icon-btn"
              style={{ width: 26, height: 26 }}
              data-tip="从队列移除"
              aria-label="从队列移除"
              onClick={() => removeFromQueue([index])}
            >
              <IconTrash size={14} />
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}
