/**
 * 侧栏导航。
 *
 * 相对 Flutter 端的改进：
 *   * 歌单列表直接嵌在侧栏（原实现歌单在「曲库」二级页面里，切歌单要来回跳）
 *   * 支持把歌曲行**拖到**侧栏歌单上直接加入（拖拽时目标歌单高亮）
 *   * 歌单本身可以拖动调整顺序（落点画一条插入线）
 *   * 可折叠成图标条，给宽表腾出空间
 *
 * ★ 这一栏上同时活着两种拖动：歌曲行**拖进来**（加歌）与歌单**拖出去**（重排）。两者落在
 *   同一批 `.nav-item` 上，只能靠 dataTransfer 的类型分流（见 lib/dnd）。
 */

import { useEffect, useState } from 'react'

import type { Playlist } from '@shared/types'

import {
  IconChevronLeft,
  IconChevronRight,
  IconClock,
  IconHeart,
  IconHome,
  IconLibrary,
  IconListMusic,
  IconPlus,
  IconServer
} from './Icons'
import { openMenuFromEvent } from './ContextMenu'
import { PLAYLIST_DRAG_TYPE, SONGS_DRAG_TYPE } from '@/lib/dnd'
import { moveItem } from '@/lib/reorder'
import { useAuth } from '@/state/useAuth'
import { regularPlaylists, usePlaylists } from '@/state/usePlaylists'
import { useSettings } from '@/state/useSettings'
import { useUi } from '@/state/useUi'
import { useToasts } from '@/state/useToasts'
import { Cover } from './primitives'
import { TIP_ATTR } from './Tooltip'

export function Sidebar(): React.JSX.Element {
  // 读原生面的路由（不是「当前显示的那一面」）：这一栏只服务原生面，
  // 切到扩展面时它停在哪一页不该影响这里的高亮
  const { nativeRoute: route, navigate, sidebarCollapsed, toggleSidebar } = useUi()
  /**
   * 折叠态只剩图标，名字改由全局浮层交代（见 Tooltip.tsx：浮层必须渲染到滚动容器之外，
   * 否则会被歌单列表的 overflow 剪掉）；展开态文字就摆在那儿，**什么都不挂**。
   *
   * 浮层与全应用其余提示是同一套（`data-tip`），行为与配色只有一份。
   */
  const tip = (label: string): { [TIP_ATTR]?: string } =>
    sidebarCollapsed ? { [TIP_ATTR]: label } : {}
  const { playlists, load, create } = usePlaylists()
  const { patch } = useSettings()
  const push = useToasts((s) => s.push)
  /** 歌曲行拖进来的落点歌单（它高亮） */
  const [dropTarget, setDropTarget] = useState<number | null>(null)
  /** 歌单重排的落点：`overId` 是悬停到的那一项，`overAfter` 说明落点在它的**下半** */
  const [overId, setOverId] = useState<number | null>(null)
  const [overAfter, setOverAfter] = useState(false)
  /** 正在被拖动的歌单（只为把源项淡下去） */
  const [draggingId, setDraggingId] = useState<number | null>(null)
  /**
   * 免登录形态（见 useAuth，**这是没会话时的默认形态**）：这一栏只留「曲库」一个入口，
   * 而且它落在**本地**那一半。
   *
   * ★ 不是「把不能点的灰掉」，而是不摆出来：首页/歌单/我喜欢/最近播放**读了才知道**
   *   要会话，点进去只会得到一页「尚未登录」。曲库那一页里有一半（本机磁盘上的文件）这时
   *   真有内容，所以留给它 —— 落点见下面那颗钮的 onClick。
   */
  const guest = useAuth((s) => s.guest)
  const openLogin = useAuth((s) => s.openLogin)

  useEffect(() => {
    // 免登录模式下没有会话，歌单列表拉不回来 —— 不发这个注定失败的请求
    if (guest) return
    void load()
  }, [guest, load])

  const regular = regularPlaylists(playlists)
  const count = playlists.length

  const isActive = (name: string, extra?: (r: typeof route) => boolean): boolean => {
    if (route.name === name) return true
    return extra ? extra(route) : false
  }

  const handleCreate = async (): Promise<void> => {
    const playlist = await create({ type: 'normal', name: '新建歌单' })
    if (playlist) navigate({ name: 'playlist', id: playlist.id })
  }

  /* ── 歌单的拖拽：两种拖动共存，靠 dataTransfer 的类型分流 ─────────────── */

  const startReorder = (id: number, event: React.DragEvent): void => {
    // 载荷只能是 id：dragover 期间 dataTransfer 读不出内容（保护模式），所以「拖的是哪一个」
    // 在悬停时问不出来，只能等 drop 那一下再解析
    event.dataTransfer.setData(PLAYLIST_DRAG_TYPE, String(id))
    event.dataTransfer.effectAllowed = 'move'
    setDraggingId(id)
  }

  /** 拖拽收尾。不管有没有落到目标上都会走到这里，瞬时状态一律在这儿收掉 */
  const endReorder = (): void => {
    setDraggingId(null)
    setOverId(null)
    setOverAfter(false)
    setDropTarget(null)
  }

  const dragOverPlaylist = (id: number, event: React.DragEvent<HTMLButtonElement>): void => {
    const types = event.dataTransfer.types
    if (types.includes(SONGS_DRAG_TYPE)) {
      event.preventDefault()
      event.dataTransfer.dropEffect = 'copy'
      setDropTarget(id)
      return
    }
    if (!types.includes(PLAYLIST_DRAG_TYPE) || draggingId === id) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    // 落在上半 → 插到这一项前面；下半 → 插到它后面。界面画的插入线用的就是这两个值
    const rect = event.currentTarget.getBoundingClientRect()
    setOverId(id)
    setOverAfter(event.clientY > rect.top + rect.height / 2)
  }

  /**
   * 指针离开一项。
   *
   * ★ 不能见到 dragleave 就清提示：行里的封面与文字各自会派发一次（指针从封面挪到名字上
   *   就是一次 leave 加一次 enter），一律清掉的话插入线会一路闪。
   */
  const leavePlaylist = (id: number, event: React.DragEvent<HTMLButtonElement>): void => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
    setDropTarget((current) => (current === id ? null : current))
    setOverId((current) => (current === id ? null : current))
  }

  /** 把拖来的歌单插到这一项的前 / 后 */
  const applyReorder = (target: Playlist, event: React.DragEvent): void => {
    event.preventDefault()
    const after = overAfter
    const sourceId = Number(event.dataTransfer.getData(PLAYLIST_DRAG_TYPE))
    endReorder()
    const from = regular.findIndex((playlist) => playlist.id === sourceId)
    const over = regular.findIndex((playlist) => playlist.id === target.id)
    // sourceId 解不出东西时是 NaN，同样落进这里
    if (from < 0 || over < 0) return
    const next = moveItem(regular, from, over, after)
    // 拖回原位（包括拖到相邻项的内侧边界）就别白跑一趟请求：顺序没变
    if (next.every((playlist, index) => playlist.id === regular[index].id)) return
    void usePlaylists.getState().reorder(next.map((playlist) => playlist.id))
  }

  /** 歌曲行拖进来 → 加歌 */
  const applySongDrop = (playlist: Playlist, event: React.DragEvent): void => {
    const raw = event.dataTransfer.getData(SONGS_DRAG_TYPE)
    setDropTarget(null)
    if (!raw) return
    event.preventDefault()
    try {
      const ids = JSON.parse(raw) as number[]
      void usePlaylists
        .getState()
        .addSongs(playlist.id, ids)
        .then((result) => {
          push(
            result.skipped > 0
              ? `已加入「${playlist.name}」${result.added} 首，跳过 ${result.skipped} 首`
              : `已加入「${playlist.name}」${result.added} 首`,
            'success'
          )
        })
        .catch(() => push('加入歌单失败', 'error'))
    } catch {
      push('无法解析拖拽内容', 'error')
    }
  }

  return (
    <nav className="sidebar" data-collapsed={sidebarCollapsed} aria-label="主导航">
      {/* 顺序与左上角折叠菜单一致（浏览在前、收藏与历史居中）。
          ★ 侧栏刻意**没有**设置项：设置只在折叠菜单里，两处各留一份入口只会漂移 */}
      <div className="nav-group">
        {guest ? null : (
          <button
            type="button"
            className="nav-item"
            aria-current={isActive('home')}
            onClick={() => navigate({ name: 'home' })}
            {...tip('首页')}
          >
            <IconHome size={18} />
            <span className="nav-text">首页</span>
          </button>
        )}

        {/*
          曲库：**一个入口管三份内容** —— 后端的曲库、后端曲库里的电台、本机磁盘上的音频
          文件，由页头那颗「本地 / 电台 / 服务器」切换决定看哪一份（见 components/LibraryHeader）。
          原先它们是两颗钮，但那是同一页的几种来源，摆成几条只会让人以为「本地文件」是另一个地方。
          ★ 「文件夹」是「服务器」那一半的另一种看法（工具条右端那颗图标钮，见
            components/LibraryViewSwitch），所以进文件夹时这里照样高亮；「电台」与「本地」
            同理 —— 四条路由（library / folders / radio / local）都是同一页。
          ★ 落点：不在「服务器」那一半就带过去 —— 从「本地」或「电台」点回来 = 回曲库，
            与合并前那颗「曲库」钮是同一条肌肉记忆；已经在服务器那一半（曲库 / 文件夹）就
            **什么都不做**，免得点一下把「文件夹」看法里的人拽回「曲库」看法。
          ★ 免登录模式的落点是**本地**那一半：它读本机磁盘、不需要会话，是这时唯一真有
            内容的去处（服务器与电台那两份的请求一个都不会发）。
        */}
        <button
          type="button"
          className="nav-item"
          aria-current={isActive(
            'library',
            (r) => r.name === 'folders' || r.name === 'local' || r.name === 'radio'
          )}
          onClick={() => {
            if (route.name === 'library' || route.name === 'folders') return
            navigate(guest ? { name: 'local' } : { name: 'library' })
          }}
          {...tip('曲库')}
        >
          <IconLibrary size={18} />
          <span className="nav-text">曲库</span>
        </button>

        {guest ? null : (
          <>
            <button
              type="button"
              className="nav-item"
              aria-current={isActive('playlists', (r) => r.name === 'playlist')}
              onClick={() => navigate({ name: 'playlists' })}
              {...tip('歌单')}
            >
              <IconListMusic size={18} />
              <span className="nav-text">歌单</span>
              <span className="nav-count">{count || ''}</span>
            </button>

            <button
              type="button"
              className="nav-item"
              aria-current={isActive('favorites')}
              onClick={() => navigate({ name: 'favorites' })}
              {...tip('我喜欢')}
            >
              <IconHeart size={18} filled={route.name === 'favorites'} />
              <span className="nav-text">我喜欢</span>
            </button>

            <button
              type="button"
              className="nav-item"
              aria-current={isActive('recent')}
              onClick={() => navigate({ name: 'recent' })}
              {...tip('最近播放')}
            >
              <IconClock size={18} />
              <span className="nav-text">最近播放</span>
            </button>
          </>
        )}
      </div>

      <div className="nav-group">
        {guest ? (
          <>
            {/* 免登录模式下这一区没有歌单可列，改成「怎么回到服务器」那一句 ——
                它与上面的歌单区占同一块会伸缩的空间，所以在两种模式下侧栏的版式一致。
                ★ 这颗钮是登录页**唯一**的入口（其余两条在设置里与退出登录那一下），
                  所以它必须一直在、且说得出点下去会发生什么 */}
            <div className="nav-empty">
              免登录模式
              <br />
              曲库、歌单与收藏需要连接服务器
            </div>
            <button type="button" className="nav-item" onClick={openLogin} {...tip('连接服务器')}>
              <IconServer size={18} />
              <span className="nav-text">连接服务器</span>
            </button>
          </>
        ) : (
          <>
            {/* 标题与「+」始终渲染，由 CSS 在折叠态淡出：条件渲染的话它们会在列宽
                还没收完时先一步消失，「弹一下」的观感正是这么来的 */}
            <div className="nav-section-head">
              <span className="nav-label">我的歌单</span>
              <button
                type="button"
                className="icon-btn nav-section-add"
                {...tip('新建歌单')}
                aria-label="新建歌单"
                onClick={() => void handleCreate()}
              >
                <IconPlus size={15} />
              </button>
            </div>

            <div className="sidebar-playlists">
              {regular.length === 0 ? (
                <div className="nav-empty">
                  还没有歌单
                  <br />
                  点右上角 + 新建
                </div>
              ) : null}

              {/* 每一项整体可拖（`draggable`）：行太窄，再塞一颗抓手图标就会把名字挤没，
                  而只让某一小块能拖的话用户十有八九会去拽整行、然后怀疑这个功能坏了 ——
                  与扩展管理页那条名单同一个取舍。拖出去 = 调顺序，拖进来的歌曲另走
                  dataTransfer 类型（见 lib/dnd），两者互不打扰 */}
              {regular.map((playlist) => (
                <button
                  key={playlist.id}
                  type="button"
                  className="nav-item"
                  aria-current={route.name === 'playlist' && route.id === playlist.id}
                  data-drop={dropTarget === playlist.id}
                  data-dragging={draggingId === playlist.id ? 'true' : undefined}
                  data-reorder={
                    overId === playlist.id ? (overAfter ? 'after' : 'before') : undefined
                  }
                  {...tip(playlist.name)}
                  onClick={() => navigate({ name: 'playlist', id: playlist.id })}
                  onContextMenu={(event) =>
                    openMenuFromEvent(event, [
                      {
                        key: 'open',
                        label: '打开歌单',
                        onClick: () => navigate({ name: 'playlist', id: playlist.id })
                      },
                      {
                        key: 'pin',
                        label: playlist.pinned_at ? '取消置顶' : '置顶',
                        onClick: () =>
                          void usePlaylists.getState().setPinned(playlist.id, !playlist.pinned_at)
                      }
                    ])
                  }
                  draggable
                  onDragStart={(event) => startReorder(playlist.id, event)}
                  onDragOver={(event) => dragOverPlaylist(playlist.id, event)}
                  onDragLeave={(event) => leavePlaylist(playlist.id, event)}
                  onDrop={(event) => {
                    if (event.dataTransfer.types.includes(PLAYLIST_DRAG_TYPE)) {
                      applyReorder(playlist, event)
                      return
                    }
                    applySongDrop(playlist, event)
                  }}
                  onDragEnd={endReorder}
                >
                  <Cover
                    coverUrl={playlist.cover_url}
                    width={48}
                    size={26}
                    radius={6}
                    kind="playlist"
                    className="nav-cover"
                  />
                  <span className="nav-text truncate grow">{playlist.name}</span>
                  <span className="nav-count">{playlist.song_count || ''}</span>
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      {/* 收起 / 展开。
          压在侧栏右下角（见 base.css 的 .sidebar-toggle），**不占一行**：原先它是一条
          占满整宽、带文字的底行，两条侧栏各被它吃掉 39px 高，而那里只剩这一个动作可点。
          文字随之消失，所以提示（data-tip）必须**任何时候都挂**，不再像导航项那样
          「只在折叠态挂」——那时还有可见文字兜底。 */}
      <button
        type="button"
        className="icon-btn sidebar-toggle"
        aria-label={sidebarCollapsed ? '展开侧栏' : '收起侧栏'}
        data-tip={sidebarCollapsed ? '展开侧栏' : '收起侧栏'}
        onClick={() => {
          const next = !sidebarCollapsed
          toggleSidebar()
          void patch({ sidebarCollapsed: next })
        }}
      >
        {/* 12px：那颗钮只有 13px 宽（见 .sidebar-toggle），图标再大就顶出去了 */}
        {sidebarCollapsed ? <IconChevronRight size={12} /> : <IconChevronLeft size={12} />}
      </button>
    </nav>
  )
}
