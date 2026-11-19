/**
 * 「服务器」那一半的两种看法（曲库 / 文件夹）—— 两颗图标钮。
 *
 * ★ 它原先嵌在页头的来源分段里（`.segmented-sub`），紧跟在「服务器」那一格后面。搬出来是因为
 *   那是**同一份内容的两种看法**，与「本地 / 电台 / 服务器」那种「换一份内容」不是同一层：
 *   嵌在分段里时它读起来像第四格，而它只在服务器那一半里成立。
 * ★ 现在摆在页面工具条的右端：曲库那一半挨着「排序」、在它左边（最右端留给排序那个
 *   下拉框），文件夹那一半是面包屑右边 —— 与「分类浏览 / 显示隐藏歌单曲目 / 排序」同一条
 *   控制带，都是「这份列表怎么摆」。两处摆的是**同一个组件**，位置不同只是因为那个视图
 *   自己有没有工具条。
 * ★ 图标钮没有可见文字，含义全靠 aria-label + 悬浮提示 + 按下态（与那两颗开关同一口径）。
 *   反过来说，两样都不能省：只剩一个「文件」图形的话，没人知道点下去是换看法还是新建目录。
 * ★ 落点一律 `path: ''`：换看法是「换一只眼睛看曲库」，不是「回到上次逛到的目录」——
 *   回目录靠文件夹那一页自己的面包屑。
 */

import { IconFolder, IconLibrary } from './Icons'
import { useUi } from '@/state/useUi'

export function LibraryViewSwitch({ pane }: { pane: 'library' | 'folders' }): React.JSX.Element {
  const navigate = useUi((s) => s.navigate)

  return (
    <div className="library-view-switch" role="group" aria-label="曲库的浏览方式">
      <button
        type="button"
        className="icon-btn"
        data-active={pane === 'library'}
        aria-pressed={pane === 'library'}
        aria-label="按曲库浏览"
        data-tip="曲库：按标签 / 分面看这批歌"
        onClick={() => navigate({ name: 'library' })}
      >
        <IconLibrary size={16} />
      </button>
      <button
        type="button"
        className="icon-btn"
        data-active={pane === 'folders'}
        aria-pressed={pane === 'folders'}
        aria-label="按文件夹浏览"
        data-tip="文件夹：按目录逐层看这批歌"
        onClick={() => navigate({ name: 'folders', path: '' })}
      >
        <IconFolder size={16} />
      </button>
    </div>
  )
}
