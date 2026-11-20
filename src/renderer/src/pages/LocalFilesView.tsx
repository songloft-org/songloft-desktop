/**
 * 曲库页的「本地」那一半（页头的来源切换切到「本地」，见 LibraryPage）。
 *
 * 这一块是「双击音频文件就能播」在界面上的那一半：文件已经进来之后，用户要能看见它、
 * 换一首放、或者再挑几个进来。
 *
 * ★ 它是全应用唯一**不需要登录**的内容：曲库、歌单、收藏、搜索都读后端，这里读的是本机
 *   磁盘。所以免登录模式进来就落在这儿，页面上那条提示也只在这一块出现 —— 既说清
 *   「为什么那几个入口都不在」，也给出回登录页的那条路。
 *
 * ★ 与另外两半（LibraryView / FoldersView）同一个版式：页头是同一个组件（LibraryHeader，
 *   副标题就是下面那句「共 N 个文件」），这里只画自己那一行动作和列表。
 *
 * ★ 刻意不复用 SongTable：那张表是为**曲库里的歌**做的（收藏、加入歌单、从曲库删除、
 *   查看歌手专辑、拖到侧栏歌单…全都要经后端），而这里每一首都不在曲库里。与其传一堆
 *   「关掉这个关掉那个」的开关进去，不如照它的样子写一张只有本地文件才有的表
 *   （共用 .song-table / .song-row 那套样式，观感仍然是一张表）。
 */

import { useCallback, useMemo, useRef, useState } from 'react'

import { IconFolderOpen, IconPause, IconPlay, IconServer, IconTrash } from '@/components/Icons'
import { LibraryHeader } from '@/components/LibraryHeader'
import { LocateCurrentButton } from '@/components/LocateCurrentButton'
import { EmptyState } from '@/components/primitives'
import { scrollRowToCenterIfHidden } from '@/lib/scroll'
import { useAuth } from '@/state/useAuth'
import { useLocalFiles, playLocalFileAt, pickLocalFiles } from '@/state/useLocalFiles'
import { usePlayer } from '@/state/usePlayer'
import { toast } from '@/state/useToasts'

/** 列宽（与 SongTable 同一个写法：grid 轨道直接写进 style） */
const GRID = '38px minmax(220px, 3fr) 84px 112px'

export function LocalFilesView(): React.JSX.Element {
  const songs = useLocalFiles((s) => s.songs)
  const remove = useLocalFiles((s) => s.remove)
  const clear = useLocalFiles((s) => s.clear)
  const guest = useAuth((s) => s.guest)
  const openLogin = useAuth((s) => s.openLogin)
  const currentId = usePlayer((s) =>
    s.cursor >= 0 && s.cursor < s.order.length ? (s.queue[s.order[s.cursor]]?.id ?? null) : null
  )
  const playing = usePlayer((s) => s.playing)
  const toggle = usePlayer((s) => s.toggle)
  /** 当前曲在这一份本地文件列表里的下标；-1 = 没在播或播的不是这里的文件 */
  const currentIndex = useMemo(
    () => (currentId == null ? -1 : songs.findIndex((s) => s.id === currentId)),
    [songs, currentId]
  )
  const tableRef = useRef<HTMLDivElement>(null)
  /** 这一份表没有窗口化，当前行一定挂在 DOM 里（见上面的 currentIndex） */
  const locateCurrent = useCallback(() => {
    const row = tableRef.current?.querySelector<HTMLElement>('[data-current="true"]') ?? null
    scrollRowToCenterIfHidden(row)
  }, [])
  /** 文件框开着的时候把按钮按下去 —— 挑大文件/多选时对话框可能停一会儿 */
  const [picking, setPicking] = useState(false)

  const openPicker = async (): Promise<void> => {
    setPicking(true)
    try {
      await pickLocalFiles()
    } catch (error) {
      toast('打开文件失败', 'error', error instanceof Error ? error.message : undefined)
    } finally {
      setPicking(false)
    }
  }

  /** 报给页头那行副标题（本机有几个文件 —— 只有这一块知道，见 components/LibraryHeader） */
  const subtitle =
    songs.length === 0
      ? '本机磁盘上的音频文件：打开就能放，不需要连接服务器'
      : `共 ${songs.length} 个文件 · 双击任意一行开始播放`

  return (
    <>
      {/* 这一块的动作钮作为页头的 children：与来源切换同一行（见 LibraryHeader） */}
      <LibraryHeader pane="local" subtitle={subtitle}>
        <button
          type="button"
          className="btn"
          data-variant="primary"
          disabled={picking}
          onClick={() => void openPicker()}
        >
          <IconFolderOpen size={15} />
          打开文件…
        </button>
        <button
          type="button"
          className="btn"
          disabled={songs.length === 0}
          onClick={() => playLocalFileAt(0)}
        >
          <IconPlay size={15} />
          播放全部
        </button>
        <button
          type="button"
          className="btn"
          data-variant="danger"
          disabled={songs.length === 0}
          onClick={() => {
            clear()
            toast('已清空本地文件列表', 'success')
          }}
        >
          <IconTrash size={15} />
          清空列表
        </button>
      </LibraryHeader>

      {guest ? (
        <div className="probe-result" style={{ marginBottom: 14 }}>
          <span>
            当前是免登录模式：曲库、歌单、收藏与搜索都需要连接服务器，本地文件的播放不受影响。
          </span>
          <button type="button" className="btn" data-size="sm" onClick={openLogin}>
            <IconServer size={15} />
            连接服务器
          </button>
        </div>
      ) : null}

      {songs.length === 0 ? (
        <EmptyState
          title="还没有打开过本地文件"
          description="也可以直接把音频文件拖到应用图标上、或用系统里「用 Songloft Desktop 打开」—— 双击即播，不必登录"
          action={
            <button
              type="button"
              className="btn"
              data-variant="primary"
              disabled={picking}
              onClick={() => void openPicker()}
            >
              <IconFolderOpen size={15} />
              打开文件…
            </button>
          }
        />
      ) : (
        <div className="song-table" ref={tableRef}>
          <div className="song-head" style={{ gridTemplateColumns: GRID }}>
            <div>#</div>
            <div>文件</div>
            <div>格式</div>
            <div style={{ textAlign: 'right' }}>操作</div>
          </div>

          {songs.map((song, index) => {
            const current = song.id === currentId
            return (
              <div
                key={`${song.id}-${index}`}
                className="song-row"
                style={{ gridTemplateColumns: GRID }}
                data-current={current}
                onDoubleClick={() => playLocalFileAt(index)}
              >
                <div className="song-index">
                  <span className="song-index-num">{index + 1}</span>
                  <button
                    type="button"
                    className="song-index-play"
                    aria-label={current && playing ? '暂停' : '播放'}
                    onClick={(event) => {
                      event.stopPropagation()
                      if (current) void toggle()
                      else playLocalFileAt(index)
                    }}
                  >
                    {current && playing ? <IconPause size={13} /> : <IconPlay size={13} />}
                  </button>
                </div>

                <div style={{ minWidth: 0 }}>
                  <div className="song-title truncate">{song.title}</div>
                  {/* 同名文件（不同目录）只能靠路径区分 —— 标题那一行放不下，缀在下面 */}
                  <div className="song-cell truncate" style={{ fontSize: 12 }}>
                    {song.file_path}
                  </div>
                </div>

                <div className="song-cell">
                  {song.format ? <span className="badge">{song.format.toUpperCase()}</span> : null}
                </div>

                <div className="song-actions" style={{ justifyContent: 'flex-end' }}>
                  <button
                    type="button"
                    className="icon-btn"
                    data-tip="从列表移除（不影响正在播放的队列）"
                    aria-label={`移除 ${song.title}`}
                    onClick={(event) => {
                      event.stopPropagation()
                      if (song.file_path) remove([song.file_path])
                    }}
                  >
                    <IconTrash size={15} />
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {currentIndex >= 0 ? <LocateCurrentButton onClick={locateCurrent} /> : null}
    </>
  )
}
