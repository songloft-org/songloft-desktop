/**
 * 曲库页的页头（见 pages/LibraryPage）：「曲库」大标题 + 副标题，下面一行是来源切换与动作钮。
 *
 * ★ 由**四种内容各摆一次**（曲库视图 / 文件夹视图 / 电台视图 / 本地视图），而不是由 LibraryPage
 *   摆一次：副标题与动作钮都是「这一份内容自己才知道的东西」（多少首、能刷什么），让视图报给父级
 *   （state + effect / 一堆回调）等于为此多两次渲染；各自把这份页头摆在自己头上则什么都不用管。
 *   版式只有这一份实现，几处摆出来的是同一个东西。
 *
 * ★ 两行：第一行标题 + 副标题（副标题从「标题下面的一句话」搬到了标题右边，那一块就不能再是
 *   左右两栏的 .page-header，见 base.css 里 [data-stacked] 那一条）；第二行左端是来源切换
 *   「本地 / 电台 / 服务器」，右端是 `children` —— 这一页能做什么（刷新 / 播放全部 / 打开文件…）。
 *   两样都归「页头那一行」管之后，视图不再自己摆一行动作，表格也就往上提了一行。
 *
 * ★ 「本地 / 电台 / 服务器」是**同一页的三种来源**（本机磁盘上的文件 | 后端的电台 | 后端的曲库），
 *   而「服务器」自己又分「曲库（按标签）/ 文件夹（按目录）」两种看法 —— 后者**嵌在服务器那一格
 *   里**（.segmented-sub，见 base.css）：先选来源、再选看法本来就是同一层选择的两步，
 *   摆到页头另一头就成了两颗看不出从属关系的钮。
 * ★ 电台原先只是「服务器」里那颗类型筛选的一档（全部 / 服务器 / 网络 / 电台）。它被提上来之后
 *   类型筛选里就**不再有它**（见 pages/LibraryPage 的 TYPE_OPTIONS）—— 同一件事在两处各留一个
 *   入口，用户不知道该信哪一个；而「全部」照旧包含电台，那一档只是给它一个更近的门口。
 *
 * ★ `pane` 由调用方写死，**不是**从 useUi 读「当前路由」：页面槽是常驻的，不活跃的那一份
 *   读到的已经属于别人了（见 pages/LibraryPage 的说明）。
 */

import type { ReactNode } from 'react'

import { useAuth } from '@/state/useAuth'
import { useUi } from '@/state/useUi'

/** 这一页现在摆的是哪一份内容（四条路由一一对应，见 pages/LibraryPage） */
export type LibraryPane = 'library' | 'folders' | 'local' | 'radio'

export function LibraryHeader({
  pane,
  subtitle,
  children
}: {
  pane: LibraryPane
  /** 这一份内容现在有多少东西（数字只有各自的视图知道） */
  subtitle: string
  /** 这一页的动作钮（刷新 / 播放全部 / 打开文件…）：摆在来源切换同一行的右端 */
  children: ReactNode
}): React.JSX.Element {
  const navigate = useUi((s) => s.navigate)
  const guest = useAuth((s) => s.guest)
  const local = pane === 'local'
  const radio = pane === 'radio'
  /** 「服务器」那一半 = 曲库（按标签）与文件夹（按目录）两种看法，二者都算同一个来源 */
  const server = pane === 'library' || pane === 'folders'

  return (
    <div className="page-header" data-stacked="true">
      <div className="page-headline">
        <h1 className="page-title">曲库</h1>
        {/* 副标题（「43 首」「5 个子文件夹 · 43 首歌」…）：跟标题同一行，放不下就省略 */}
        <div className="page-subtitle truncate">{subtitle}</div>
      </div>

      {/* 窗口窄到放不下时让动作钮整组换行，而不是被挤扁 */}
      <div
        className="row-between"
        style={{ gap: 14, flexWrap: 'wrap', justifyContent: guest ? 'flex-end' : 'space-between' }}
      >
        {/* ★ 免登录模式下不摆出来：服务器那一半的每一项都要会话（与侧栏同一口径 —— 不是灰掉，
            是不摆出来），此时能看的本来就只有「本地」那一半，这颗切换也就没什么可切 */}
        {guest ? null : (
          <div className="segmented" role="group" aria-label="曲库来源">
            <button type="button" aria-pressed={local} onClick={() => navigate({ name: 'local' })}>
              本地
            </button>
            <button type="button" aria-pressed={radio} onClick={() => navigate({ name: 'radio' })}>
              电台
            </button>
            <button
              type="button"
              aria-pressed={server}
              /* 已经在「服务器」那一半时**什么都不做**：按着的是这一档，换看法是它自己那两颗
                 子选项的事，别在这里替人做决定（点一下把人从「文件夹」拽回「曲库」很奇怪） */
              onClick={() => {
                if (!server) navigate({ name: 'library' })
              }}
            >
              服务器
            </button>

            {/* 「服务器」的两种看法，嵌在它自己那一格后面。
                ★ 药丸是画「现在在哪一项」的那一层，状态仍在按钮的 aria-pressed 上（见 base.css）。
                ★ 落点一律 path: ''：换看法是「换一只眼睛看曲库」，不是「回到上次逛到的目录」——
                  回目录靠文件夹那一页自己的面包屑。
                ★ 「本地」与「电台」都没有这一层选择，所以整块跟着来源一起出现 / 消失。 */}
            {server ? (
              <div
                className="segmented-sub"
                role="group"
                aria-label="曲库的浏览方式"
                data-mode={pane}
              >
                <span className="segmented-sub-pill" aria-hidden="true" />
                <button
                  type="button"
                  aria-pressed={pane === 'library'}
                  onClick={() => navigate({ name: 'library' })}
                >
                  曲库
                </button>
                <button
                  type="button"
                  aria-pressed={pane === 'folders'}
                  onClick={() => navigate({ name: 'folders', path: '' })}
                >
                  文件夹
                </button>
              </div>
            ) : null}
          </div>
        )}

        <div className="row" style={{ gap: 8, flex: 'none' }}>
          {children}
        </div>
      </div>
    </div>
  )
}
