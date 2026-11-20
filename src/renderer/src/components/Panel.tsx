/**
 * 右侧抽屉：正在播放（大封面 + 歌词）/ 播放队列。
 *
 * 做成常驻抽屉而不是独立路由页（Flutter 端「播放器」是一个整页路由）：
 * 桌面宽屏下用户往往想边看曲库边看歌词，切换整页会丢掉列表滚动位置。
 *
 * ★ 抽屉里**没有标题栏**（收起 / 两个 tab 那一整条拿掉了）：切 tab 与开合统一走
 *   播放条那两颗钮（同一 tab 再点一次即收起），抽屉里再摆一条等于两套入口。
 */

import { useEffect, useRef, useState } from 'react'

import { IconListMusic, IconMusic, IconTrash } from './Icons'
import { Cover, EmptyState } from './primitives'
import { LyricsView } from './LyricsView'
import { openMenuFromEvent } from './ContextMenu'
import { buildSongMenuItems } from './songMenu'
import { fallbackTitle, songCoverUrl } from '@shared/metadata'
import { displayArtist, formatDuration } from '@/lib/format'
import { scrollRowToCenterIfHidden, scrollRowToSlot } from '@/lib/scroll'
import { usePlayer } from '@/state/usePlayer'
import { useUi } from '@/state/useUi'

export function Panel(): React.JSX.Element | null {
  const { panelOpen, panelTab } = useUi()
  if (!panelOpen) return null

  return (
    <aside className="panel" aria-label={panelTab === 'queue' ? '播放队列' : '正在播放'}>
      <div className="panel-body">{panelTab === 'now-playing' ? <NowPlaying /> : <Queue />}</div>
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
 * 抽屉上次的滚动位置（见 Queue 里「先归位」那个 effect）。
 *
 * 抽屉关掉时整块卸载，滚动位置不会自己留着；记在模块级就够 —— 它只属于主窗口那一个抽屉，
 * 迷你窗是另一个渲染进程，模块各有一份。
 */
let savedQueueScroll = 0

/**
 * 播放队列。
 *
 * ★ 导出是为了给**迷你窗那块面板**复用（见 MiniPlayer.tsx）：同一个队列在两处出现，
 *   两套实现迟早分叉（拖拽排序、跟随当前曲滚动…都得各写一遍）。
 * ★★ **摘要在滚动容器外面**，列表自己带一个 .queue-rows：两者是并列的 flex 兄弟，
 *   行不可能滚到摘要底下。早先摘要 sticky 在滚动容器里，透明面板下要靠底色挡住穿透的行，
 *   而铺底色又会与面板自己的底色叠成两倍浓度 —— 怎么调都不对。物理分开才是解法。
 * ★ currentSlot：定位当前曲时，要它落在容器**从上往下第 currentSlot+1 格**。
 *   迷你面板给 2（第 3 格 —— 那块只有 416px 高）；抽屉给默认的 0，意思是「看不见才居中」，
 *   理由见下面那段 effect 的说明。
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

  /*
   * 先归位：抽屉关掉时整块卸载（.panel-body 随之消失），滚动位置不会自己留着 ——
   * 记下来，重开时还原，再交给下面那个 effect 判断「当前曲还需要被找回来吗」。
   * 少了这一段，每次打开都是从 0 开始，于是当前曲永远「看不见」→ 每次都要重滚一遍，
   * 正是「别每次打开都跳一下」要避免的动作。
   * ★ 必须在**定位那个 effect 之前**声明（effect 按声明顺序跑）。
   * ★ 迷你面板（currentSlot > 0）不记：它按固定格位摆，记了也会被覆盖。
   */
  useEffect(() => {
    if (currentSlot > 0) return
    const container = listRef.current
    if (!container) return
    container.scrollTo({ top: savedQueueScroll, behavior: 'instant' })
    /* 位置**跟着滚动实时记**，不要在卸载时读：被动 effect 的清理跑的时候 DOM 已经摘掉，
       那一刻 scrollTop 是 0 —— 记下来的就是「0」，重开必然重新居中（实测踩过）。 */
    const remember = () => {
      savedQueueScroll = container.scrollTop
    }
    container.addEventListener('scroll', remember, { passive: true })
    return () => container.removeEventListener('scroll', remember)
  }, [currentSlot])

  /*
   * 挂载（面板打开）与换曲时，把当前项摆到它该在的位置上。
   *
   * ★ 开抽屉先还原上次的滚动位置（下面那个 effect），**当前曲还在那一屏里就一动不动**，
   *   看不见才滚到中间 —— 每开一次都把位置重置再居中，等于每次都让人重新找自己刚才看到
   *   的地方。具体怎么算全在 lib/scroll.ts（那里有单测钉着坐标口径）。
   * ★ currentSlot > 0（迷你面板）仍然是**固定**落在从上往下第 currentSlot+1 格：面板只有
   *   416px 高，只保证「看得见」的话当前曲会贴着下边缘、甚至掉到视野之外。
   * ★ 不用 scrollIntoView：它会把祖先容器连视口一起滚（迷你窗会被整条顶出窗外）。
   * ★ 抽屉这一下的落点可能差几十像素（视觉上仍是中间）：抽屉的列宽是过渡出来的
   *   （.shell-body 的 grid-template-columns），动画期间队列头会重新折行、横向滚动条也可能
   *   一闪，于是量到的版面与实际到位后的版面差一点。真要贴死中间就得等过渡结束再量一次，
   *   而那一趟「先摆一次再修一次」的抖动比几十像素更显眼 —— 取舍如此，e2e 的容差不是 0。
   */
  useEffect(() => {
    if (currentIndex < 0) return
    const item = listRef.current?.querySelector<HTMLElement>(`[data-queue-index="${currentIndex}"]`)
    if (!item) return
    if (currentSlot > 0) scrollRowToSlot(item, currentSlot)
    else scrollRowToCenterIfHidden(item)
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
    <div className="queue">
      {/* 摘要是滚动容器的兄弟：它常驻，行只在下面那块里滚，透明面板下也不会互相穿透 */}
      <div className="row-between queue-summary">
        <span>
          共 {queue.length} 首 · {formatDuration(totalDuration)}
        </span>
        <button type="button" className="btn queue-clear" onClick={() => clearQueue()}>
          <IconTrash size={13} />
          清空
        </button>
      </div>

      <div className="queue-rows" ref={listRef}>
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
              <span className="queue-index">{index + 1}</span>
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
    </div>
  )
}
