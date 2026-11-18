/**
 * 曲库页 = 三种内容（服务器的曲库 / 服务器的文件夹 / 本机磁盘上的文件）共用一个外壳。
 *
 * ★ 侧栏只有一个「曲库」入口：后端的曲库与**本机磁盘上的音频文件**是两份来源不同的东西
 *   （后者读磁盘、不需要登录，见 §8.16），所以页头那颗切换按**来源**分 ——
 *   「服务器」= 后端曲库（按标签 / 按文件夹两种看法），「本地」= 本机那批文件。
 *   合并的是入口，不是把两份数据混在一起：换到「本地」时一个后端请求也不发。
 *
 * ★ 底下仍然是**三条路由**（library / folders / local），而不是一个组件内的 state：
 *   文件夹要能带着当前目录深链、面包屑要能一段段跳回去，局部 state 表达不了这些
 *   （刷新窗口或后退就丢）；主进程菜单、命令面板也都是按路由打的。
 *
 * ★ 页头（标题 + 副标题 + 来源切换 + 看法切换）由三种内容**各摆一次**
 *   （components/LibraryHeader）：副标题里的数字只有各自的视图知道。这一页因此只剩
 *   「挑哪一块内容摆上去」这一件事。
 *
 * ★ 工具条右侧那几颗钮的分工：**分类浏览**与**显示隐藏歌单曲目**是这一页的两颗开关
 *   （图标钮，打开 = 泛强调色，含义靠悬浮提示交代），**排序**是选择器。看法本身的切换
 *   （曲库 / 文件夹）不在这里 —— 它嵌在页头「服务器」那一格里（components/LibraryHeader）。
 *
 * 曲库模式（LibraryView）做了三件原 Flutter 端没做好的事：
 *   1. **分面浏览就在同一页**：歌手/专辑/流派/语种/风格 五个维度用 chip 切换，
 *      点卡片直接落成筛选条件（真·服务端过滤），而不是跳去另一个页面再用关键词搜。
 *   2. **筛选条件可视化**：生效的筛选条件以 chip 形式挂在表头上，一眼看到"现在在看什么"，
 *      点 × 就地解除。
 *   3. **批量操作区分「行选中」与「全选当前筛选」**：前者能播能排队，后者只做 id 级动作。
 */

import { useCallback, useMemo, useState } from 'react'

import type { FacetField, Song, SongType } from '@shared/types'
import { FACET_LABELS } from '@shared/types'
import {
  IconClose,
  IconEyeOff,
  IconPlay,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconSparkle,
  IconUpload
} from '@/components/Icons'
import { AddRadioDialog } from '@/components/AddRadioDialog'
import { LibraryHeader } from '@/components/LibraryHeader'
import { CardGridSkeleton, Cover, EmptyState } from '@/components/primitives'
import { SelectionBar } from '@/components/SelectionBar'
import { LIBRARY_COLUMNS, SongTable, type SongSort } from '@/components/SongTable'
import { getFacets } from '@/api/endpoints'
import { useAsync } from '@/hooks/useAsync'
import { useSongList } from '@/hooks/useSongList'
import { requireClient } from '@/state/useAuth'
import { usePlayer } from '@/state/usePlayer'
import { useUi, type NativeRoute } from '@/state/useUi'
import { FoldersView } from './FoldersView'
import { LocalFilesView } from './LocalFilesView'

/**
 * 歌曲类型（后端 `type` 参数）。
 *
 * ★ 第一档的**值**仍是 `local`（后端口径：存在服务器本机磁盘上的歌），但**名字**改叫
 *   「服务器」—— 页头那颗来源切换把「本地」这个词拿走了（它现在指本机磁盘上的文件），
 *   两处都叫「本地」的话，这一行看上去像在筛下面那三种来源里的第二种。
 */
const TYPE_OPTIONS: { value: SongType | 'all'; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'local', label: '服务器' },
  { value: 'remote', label: '网络' },
  { value: 'radio', label: '电台' }
]

const BROWSE_FIELDS: FacetField[] = ['artist', 'album', 'genre', 'language', 'style']

/** 本页的三条路由（三个页面槽，各留一份实例：见 App 的 PAGE_SLOTS） */
type LibraryRoute = Extract<NativeRoute, { name: 'library' | 'folders' | 'local' }>

/**
 * @param route 由页面槽传进来，**不是**自己从 useUi 里读「当前路由」：这一页在槽里常驻
 *   （library / folders / local 各一份实例），不活跃的那一份读到的「当前路由」已经属于别人了
 *   —— 拿它渲染会让留在 DOM 里的这一页跟着变脸（曲库槽里画出文件夹、反之亦然），
 *   而它本该停在用户离开时的样子；更要紧的是「曲库」那一半的筛选条件会跟着一起丢。
 */
export function LibraryPage({ route }: { route: LibraryRoute }): React.JSX.Element {
  return (
    <div className="page">
      {/* 三种内容各自成块，并且**各自把同一份页头摆在头上**（components/LibraryHeader）——
          副标题是「这里现在有多少东西」，那个数字只有各自的视图知道，见那里的说明 */}
      {route.name === 'local' ? (
        <LocalFilesView />
      ) : route.name === 'folders' ? (
        <FoldersView path={route.path} />
      ) : (
        <LibraryView />
      )}
    </div>
  )
}

/** 「曲库」模式：类型筛选 + 分面浏览 + 歌曲表 */
function LibraryView(): React.JSX.Element {
  const navigate = useUi((s) => s.navigate)
  const playSongs = usePlayer((s) => s.playSongs)

  const [type, setType] = useState<SongType | 'all'>('all')
  const [showHidden, setShowHidden] = useState(false)
  const [filters, setFilters] = useState<Partial<Record<FacetField, string>>>({})
  const [browseField, setBrowseField] = useState<FacetField>('artist')
  const [browsing, setBrowsing] = useState(false)
  const [sort, setSort] = useState<SongSort | null>({ field: 'added_at', order: 'desc' })
  const [selection, setSelection] = useState<number[]>([])
  const [selectAllIds, setSelectAllIds] = useState<number[] | null>(null)
  /** 「添加电台」对话框：只有「电台」这一档用得上，其它档位连按钮都不出现 */
  const [addingRadio, setAddingRadio] = useState(false)

  const query = useMemo(
    () => ({
      type,
      exclude_playlist_labels: showHidden ? 'none' : undefined,
      artist: filters.artist,
      album: filters.album,
      genre: filters.genre,
      language: filters.language,
      style: filters.style,
      sort: sort?.field,
      order: sort?.order
    }),
    [type, showHidden, filters, sort]
  )

  const list = useSongList(query, 200)
  const facets = useAsync(
    () => getFacets(requireClient(), browseField, { limit: 60, sort: 'count', order: 'desc' }),
    [browseField]
  )

  const activeFilters = Object.entries(filters).filter(([, v]) => Boolean(v)) as [
    FacetField,
    string
  ][]
  const selectedSongs = useMemo(
    () => selection.map((i) => list.songs[i]).filter((s): s is Song => Boolean(s)),
    [selection, list.songs]
  )

  const clearSelection = useCallback(() => {
    setSelection([])
    setSelectAllIds(null)
  }, [])

  const applyFilter = useCallback((field: FacetField, value: string) => {
    setFilters((prev) => ({ ...prev, [field]: value }))
    setBrowsing(false)
    setSelection([])
    setSelectAllIds(null)
  }, [])

  const handleSelectAll = useCallback(async () => {
    try {
      const ids = await list.fetchAllIds()
      setSelectAllIds(ids)
      setSelection([])
    } catch {
      /* fetchAllIds 内部已经把错误暴露在 list.error 上，这里不需要额外提示 */
    }
  }, [list])

  const totalForBar = selectAllIds
    ? selectAllIds
    : selection.map((i) => list.songs[i]?.id).filter((x): x is number => x != null)

  /** 报给页头那行副标题（跟着标题走，见 components/LibraryHeader） */
  const subtitle =
    list.loading && list.songs.length === 0
      ? '正在读取…'
      : `${list.total} 首${list.total > list.songs.length ? `（已加载 ${list.songs.length}）` : ''}`

  return (
    <>
      {/* 这一页的动作钮作为页头的 children：与来源切换同一行（见 LibraryHeader） */}
      <LibraryHeader pane="library" subtitle={subtitle}>
        {/* 只有「电台」这一档才有「添加」这件事：它是曲库里唯一靠链接录进来的类型 */}
        {type === 'radio' ? (
          <button type="button" className="btn" onClick={() => setAddingRadio(true)}>
            <IconPlus size={15} />
            添加电台
          </button>
        ) : null}
        <button type="button" className="btn" onClick={() => list.refresh()}>
          <IconRefresh size={15} />
          刷新
        </button>
        <button
          type="button"
          className="btn"
          data-variant="primary"
          disabled={list.songs.length === 0}
          onClick={() => void playSongs(list.songs, 0, { type: 'library', key: 'all' })}
        >
          <IconPlay size={15} />
          播放全部
        </button>
      </LibraryHeader>

      {/* ── 筛选区 ── */}
      <div className="row-between" style={{ gap: 14, flexWrap: 'wrap', marginBottom: 14 }}>
        <div className="segmented" role="group" aria-label="歌曲类型">
          {TYPE_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={type === option.value}
              onClick={() => {
                setType(option.value)
                clearSelection()
              }}
            >
              {option.label}
            </button>
          ))}
        </div>

        <div className="row" style={{ gap: 8 }}>
          {/* 分类浏览：一颗开关钮（打开后表头上面多一块分面网格） */}
          <button
            type="button"
            className="icon-btn"
            data-active={browsing}
            aria-pressed={browsing}
            aria-label="分类浏览"
            data-tip="按歌手 / 专辑 / 流派 / 语种 / 风格分类浏览"
            onClick={() => setBrowsing((v) => !v)}
          >
            <IconSparkle size={16} />
          </button>
          {/* 「显示隐藏歌单曲目」：开着时把隐藏歌单里的歌也一起列出来。
              ★ 图标是「带斜线的眼睛」（与「隐藏歌单」那几个入口同一个图形），这颗钮管的正是
                「隐藏」这件事，按下泛强调色 = 现在把隐藏的也算进来。没有可见文字，含义全靠
                悬浮提示 + 按下态交代，所以两样都不能省。 */}
          <button
            type="button"
            className="icon-btn"
            data-active={showHidden}
            aria-pressed={showHidden}
            aria-label="显示隐藏歌单曲目"
            data-tip={showHidden ? '不再显示隐藏歌单里的曲目' : '把隐藏歌单里的曲目也一起显示'}
            onClick={() => {
              setShowHidden((v) => !v)
              clearSelection()
            }}
          >
            <IconEyeOff size={16} />
          </button>
          <select
            className="input"
            style={{ width: 132, height: 29, fontSize: 12.5 }}
            value={sort ? `${sort.field}:${sort.order}` : 'added_at:desc'}
            onChange={(event) => {
              const [field, order] = event.target.value.split(':')
              setSort({ field: field as SongSort['field'], order: order as 'asc' | 'desc' })
            }}
            data-tip="排序方式"
          >
            <option value="added_at:desc">最近加入</option>
            <option value="added_at:asc">最早加入</option>
            <option value="title:asc">标题 A→Z</option>
            <option value="artist:asc">歌手 A→Z</option>
            <option value="album:asc">专辑 A→Z</option>
            <option value="duration:desc">时长 长→短</option>
            <option value="year:desc">年份 新→旧</option>
          </select>
        </div>
      </div>

      {activeFilters.length > 0 || showHidden || type !== 'all' ? (
        <div className="chip-row" style={{ marginBottom: 14 }}>
          <span style={{ fontSize: 11.5, color: 'var(--text-4)' }}>当前筛选</span>
          {type !== 'all' ? (
            <button
              type="button"
              className="chip"
              data-active="true"
              onClick={() => setType('all')}
            >
              {TYPE_OPTIONS.find((o) => o.value === type)?.label}
              <IconClose size={12} />
            </button>
          ) : null}
          {activeFilters.map(([field, value]) => (
            <button
              key={field}
              type="button"
              className="chip"
              data-active="true"
              onClick={() => setFilters((prev) => ({ ...prev, [field]: undefined }))}
            >
              {FACET_LABELS[field]}：{value}
              <IconClose size={12} />
            </button>
          ))}
          {showHidden ? (
            <button
              type="button"
              className="chip"
              data-active="true"
              onClick={() => setShowHidden(false)}
            >
              含隐藏歌单
              <IconClose size={12} />
            </button>
          ) : null}
          <button
            type="button"
            className="chip"
            onClick={() => {
              setFilters({})
              setShowHidden(false)
              setType('all')
            }}
          >
            清空全部
          </button>
        </div>
      ) : null}

      {/* ── 分面网格 ── */}
      {browsing ? (
        <>
          <div className="chip-row" style={{ marginBottom: 16 }}>
            {BROWSE_FIELDS.map((field) => (
              <button
                key={field}
                type="button"
                className="chip"
                data-active={browseField === field}
                onClick={() => setBrowseField(field)}
              >
                {FACET_LABELS[field]}
              </button>
            ))}
          </div>

          {facets.loading ? (
            <CardGridSkeleton cards={12} />
          ) : (facets.data?.facets.length ?? 0) === 0 ? (
            <EmptyState
              icon={<IconSearch size={26} />}
              title={`还没有${FACET_LABELS[browseField]}数据`}
              description="扫描曲库时把标签一并导入，这里才会有内容"
            />
          ) : (
            <div className="card-grid" style={{ marginBottom: 20 }}>
              {facets.data?.facets.map((facet) => (
                <button
                  key={facet.value}
                  type="button"
                  className="card"
                  data-tip={`只看${FACET_LABELS[browseField]}：${facet.value}`}
                  onClick={() => applyFilter(browseField, facet.value)}
                >
                  <div className="card-art">
                    <Cover
                      coverUrl={facet.cover_url}
                      size="100%"
                      radius={0}
                      round={browseField === 'artist'}
                      // 分面就是「一类东西」：歌手走人像，其余（专辑/流派/语种/风格）走歌单那套
                      kind={browseField === 'artist' ? 'artist' : 'playlist'}
                    />
                  </div>
                  <div className="card-title truncate" style={{ textAlign: 'left' }}>
                    {facet.value}
                  </div>
                  <div className="card-meta" style={{ textAlign: 'left' }}>
                    {facet.count} 首
                  </div>
                </button>
              ))}
            </div>
          )}
        </>
      ) : null}

      {/* ── 歌曲表 ── */}
      {list.error ? (
        <div className="probe-result" data-state="error" style={{ marginBottom: 14 }}>
          <span>{list.error}</span>
          <button type="button" className="btn" data-size="sm" onClick={() => list.refresh()}>
            重试
          </button>
        </div>
      ) : null}

      <SongTable
        songs={list.songs}
        columns={LIBRARY_COLUMNS}
        loading={list.loading}
        sort={sort}
        onSortChange={setSort}
        onPlayAt={(index) =>
          void playSongs(list.songs, index, { type: 'library', key: JSON.stringify(filters) })
        }
        hasMore={list.hasMore}
        onLoadMore={list.loadMore}
        selection={selection}
        onSelectionChange={(indexes) => {
          setSelection(indexes)
          setSelectAllIds(null)
        }}
        menuOptions={{ onDeleted: (ids) => list.removeSongs(ids) }}
        emptyTitle="没有匹配的歌曲"
        emptyDescription="换个筛选条件，或去「设置 → 曲库」扫描音乐目录"
        emptyAction={
          <button
            type="button"
            className="btn"
            data-variant="primary"
            onClick={() => navigate({ name: 'settings', section: 'library' })}
          >
            <IconUpload size={15} />
            去扫描曲库
          </button>
        }
      />

      {list.songs.length > 0 && selection.length === 0 && !selectAllIds ? (
        <div className="load-more">
          <button
            type="button"
            className="btn"
            data-size="sm"
            data-variant="ghost"
            onClick={() => void handleSelectAll()}
          >
            全选当前筛选（{list.total} 首）
          </button>
        </div>
      ) : null}

      {selectAllIds || selection.length > 0 ? (
        <SelectionBar
          ids={totalForBar}
          songs={selectAllIds ? undefined : selectedSongs}
          selectAll={Boolean(selectAllIds)}
          selectAllTotal={selectAllIds?.length}
          onClear={clearSelection}
          onRemoved={(ids) => {
            list.removeSongs(ids)
            clearSelection()
          }}
        />
      ) : null}

      {addingRadio ? (
        <AddRadioDialog
          onClose={() => setAddingRadio(false)}
          onAdded={() => {
            setAddingRadio(false)
            // 明着刷新一次：新加的那条要立刻出现在列表里（与手动点「刷新」同一条路径）
            list.refresh()
          }}
        />
      ) : null}
    </>
  )
}
