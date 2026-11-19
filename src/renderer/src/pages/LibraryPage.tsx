/**
 * 曲库页 = 四种内容（服务器的曲库 / 服务器的文件夹 / 电台 / 本机磁盘上的文件）共用一个外壳。
 *
 * ★ 侧栏只有一个「曲库」入口：后端的曲库与**本机磁盘上的音频文件**是两份来源不同的东西
 *   （后者读磁盘、不需要登录，见 §8.16），所以页头那颗切换按**来源**分 ——
 *   「服务器」= 后端曲库（按标签 / 按文件夹两种看法），「电台」= 后端曲库里那批电台，
 *   「本地」= 本机那批文件。合并的是入口，不是把几份数据混在一起：换到「本地」时一个
 *   后端请求也不发。
 *
 * ★ 电台本来是「服务器」里那颗类型筛选（全部 / 本地 / 网络 / 电台）的一档，现在提到
 *   第一层单列一格。理由有两条：它自成一份内容（只有这一档才有「添加电台」这件事），
 *   而类型筛选是同一页的第二层 —— 把一份内容藏在另一份内容的筛选里，用户得先想到
 *   「电台是曲库的一种类型」才找得到。提上来之后类型筛选里就**不再有它**（见 TYPE_OPTIONS）。
 *
 * ★ 底下仍然是**四条路由**（library / folders / radio / local），而不是一个组件内的 state：
 *   文件夹要能带着当前目录深链、面包屑要能一段段跳回去，局部 state 表达不了这些
 *   （刷新窗口或后退就丢）；主进程菜单、命令面板也都是按路由打的。
 *
 * ★ 页头（标题 + 副标题 + 来源切换 + 看法切换）由四种内容**各摆一次**
 *   （components/LibraryHeader）：副标题里的数字只有各自的视图知道。这一页因此只剩
 *   「挑哪一块内容摆上去」这一件事。
 *
 * ★ 工具条右侧那几颗钮的分工：**分类浏览**与**显示隐藏歌单曲目**是这一页的两颗开关
 *   （图标钮，打开 = 泛强调色，含义靠悬浮提示交代），紧接着是**看法切换**
 *   （曲库 / 文件夹，components/LibraryViewSwitch），最右端收在**排序**这个下拉框上 ——
 *   它是这一行里唯一带文字的选择器，靠边站最好找。看法切换与排序同处一条控制带，
 *   而不是与「本地 / 电台 / 服务器」那种「换一份内容」并列。
 *
 * 曲库模式（LibraryView）做了三件原 Flutter 端没做好的事：
 *   1. **分面浏览就在同一页**：歌手/专辑/流派/语种/风格 五个维度用 chip 切换，
 *      点卡片直接落成筛选条件（真·服务端过滤），而不是跳去另一个页面再用关键词搜。
 *   2. **筛选条件可视化**：生效的筛选条件以 chip 形式挂在表头上，一眼看到"现在在看什么"，
 *      点 × 就地解除。
 *   3. **批量操作区分「行选中」与「全选当前筛选」**：前者能播能排队，后者只做 id 级动作。
 */

import { useCallback, useMemo, useRef, useState } from 'react'

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
import { LibraryViewSwitch } from '@/components/LibraryViewSwitch'
import { CardGridSkeleton, Cover, EmptyState } from '@/components/primitives'
import { SelectionBar, shouldShowSelectionBar } from '@/components/SelectionBar'
import { LIBRARY_COLUMNS, SongTable, type SongSort } from '@/components/SongTable'
import { getFacets, SONG_TYPE_LABELS } from '@/api/endpoints'
import { useAsync } from '@/hooks/useAsync'
import { usePageActive } from '@/hooks/usePageActive'
import { useSelectAllShortcut } from '@/hooks/useSelectAllShortcut'
import { useSongList } from '@/hooks/useSongList'
import { requireClient } from '@/state/useAuth'
import { usePlayer } from '@/state/usePlayer'
import { useUi, type NativeRoute } from '@/state/useUi'
import { FoldersView } from './FoldersView'
import { LocalFilesView } from './LocalFilesView'

/**
 * 歌曲类型（后端 `type` 参数）—— 「服务器」那一半里的筛选。
 *
 * ★ 第一档的**值**是 `local`（后端口径：存在**服务器那台机器**磁盘上的歌），名字就叫
 *   「本地」（与 `SONG_TYPE_LABELS` 同一口径）。
 * ★ 它跟页头第一层那颗「本地」**不是一回事**：那颗指**这台机器**磁盘上的文件
 *   （pages/LocalFilesView，读磁盘、不需要会话）。两个「本地」不会同时出现在同一层级上 ——
 *   类型筛选只在「服务器」那一半里出现，而那一半说的本来就是服务器上的东西。
 * ★ **没有 `radio`**：电台已经提到页头第一层（见 LibraryPage 的说明），这里再留一份就是
 *   同一件事的两个入口。而「全部」照旧包含电台 —— 那一档只是给它一个更近的门口。
 */
const TYPE_OPTIONS: { value: SongType | 'all'; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'local', label: SONG_TYPE_LABELS.local },
  { value: 'remote', label: SONG_TYPE_LABELS.remote }
]

const BROWSE_FIELDS: FacetField[] = ['artist', 'album', 'genre', 'language', 'style']

/** 本页的四条路由（四个页面槽，各留一份实例：见 App 的 PAGE_SLOTS） */
type LibraryRoute = Extract<NativeRoute, { name: 'library' | 'folders' | 'local' | 'radio' }>

/**
 * @param route 由页面槽传进来，**不是**自己从 useUi 里读「当前路由」：这一页在槽里常驻
 *   （library / folders / radio / local 各一份实例），不活跃的那一份读到的「当前路由」已经
 *   属于别人了 —— 拿它渲染会让留在 DOM 里的这一页跟着变脸（曲库槽里画出文件夹、反之亦然），
 *   而它本该停在用户离开时的样子；更要紧的是「曲库」那一半的筛选条件会跟着一起丢。
 */
export function LibraryPage({ route }: { route: LibraryRoute }): React.JSX.Element {
  return (
    <div className="page">
      {/* 四种内容各自成块，并且**各自把同一份页头摆在头上**（components/LibraryHeader）——
          副标题是「这里现在有多少东西」，那个数字只有各自的视图知道，见那里的说明 */}
      {route.name === 'local' ? (
        <LocalFilesView />
      ) : route.name === 'folders' ? (
        <FoldersView path={route.path} />
      ) : route.name === 'radio' ? (
        // 电台 = 同一个曲库视图，只是类型被钉死（没有那颗类型筛选，见 TYPE_OPTIONS）
        <LibraryView fixedType="radio" />
      ) : (
        <LibraryView />
      )}
    </div>
  )
}

/**
 * 曲库模式：类型筛选 + 分面浏览 + 歌曲表。
 *
 * @param fixedType 类型被钉死在某一档（电台那一份内容用它）。此时那颗类型筛选不摆出来 ——
 *   它只有一种可选，摆出来只是一个永远按着的钮；而「当前筛选」那一行也不挂类型 chip。
 *   其余（刷新 / 播放全部 / 分面浏览 / 排序 / 多选）与普通曲库完全一样。
 */
function LibraryView({ fixedType }: { fixedType?: SongType }): React.JSX.Element {
  const navigate = useUi((s) => s.navigate)
  const playSongs = usePlayer((s) => s.playSongs)
  const addToQueue = usePlayer((s) => s.addToQueue)

  const [type, setType] = useState<SongType | 'all'>(fixedType ?? 'all')
  const [showHidden, setShowHidden] = useState(false)
  const [filters, setFilters] = useState<Partial<Record<FacetField, string>>>({})
  const [browseField, setBrowseField] = useState<FacetField>('artist')
  const [browsing, setBrowsing] = useState(false)
  const [sort, setSort] = useState<SongSort | null>({ field: 'added_at', order: 'desc' })
  const [selection, setSelection] = useState<number[]>([])
  const [selectAllIds, setSelectAllIds] = useState<number[] | null>(null)
  /** 「添加电台」对话框：只有「电台」这一档用得上，其它档位连按钮都不出现 */
  const [addingRadio, setAddingRadio] = useState(false)
  /** 这一页现在看不看得见：Ctrl+A 只在看得见的那一页生效（见 useSelectAllShortcut） */
  const pageActive = usePageActive()

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
  /*
   * 分面浏览只给「服务器」那一半：`/songs/facets` 没有按类型过滤的口径（它算的是整份曲库），
   * 在电台那一页点一个歌手卡只会筛出 0 首。所以那一页连请求都不发，那颗钮也不摆。
   */
  const facets = useAsync(
    () =>
      fixedType
        ? Promise.resolve({ facets: [], total: 0 })
        : getFacets(requireClient(), browseField, { limit: 60, sort: 'count', order: 'desc' }),
    [browseField, fixedType]
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
      /*
       * 已经在手的那些行也标成选中：`selectAllIds` 只是「还有多少首没到手上」的账本，
       * 它本身不画任何东西 —— 只设它的话，按完 Ctrl+A 屏幕上一条高亮都没有，看着就像没生效。
       */
      setSelection(list.songs.map((_, index) => index))
    } catch {
      /* fetchAllIds 内部已经把错误暴露在 list.error 上，这里不需要额外提示 */
    }
  }, [list])

  /*
   * Ctrl/⌘+A 全选（见 hooks/useSelectAllShortcut）。
   *
   * ★ 两个分支的口径不同，别合并：
   *   · 整份列表都在手 → 全选**行**（拿到的是完整对象，播放 / 入队按钮立刻可用）；
   *   · 还有没拉完的 → 先弹一句「再按一次」的问询，确认后才走 `handleSelectAll` 去后端
   *     取全部 id（那是 id 级选中，播放 / 入队会先补齐歌曲，见 components/SelectionBar）。
   */
  useSelectAllShortcut({
    active: pageActive,
    songs: list.songs,
    total: list.total,
    hasMore: list.hasMore,
    onSelectAllRows: () => {
      setSelection(list.songs.map((_, index) => index))
      setSelectAllIds(null)
    },
    onSelectAllIds: handleSelectAll
  })

  const totalForBar = selectAllIds
    ? selectAllIds
    : selection.map((i) => list.songs[i]?.id).filter((x): x is number => x != null)

  /**
   * 播放来源：行内双击与「播放全部」报的是同一份。
   * 电台是一整份内容，键就写 `radio`；曲库按筛选条件区分（同一份筛选下播起来的算一趟）。
   */
  const playContext = useMemo(
    () => ({ type: 'library', key: fixedType ?? JSON.stringify(filters) }),
    [fixedType, filters]
  )

  /**
   * 「播放全部」这一次后台补队列的世代号（见下面 playAll）。
   *
   * 用户再点一次「播放全部」时，上一轮还在飞的分页就不许再往队列里塞 —— 那会让队列里
   * 混进上一轮的歌。（换了筛选条件则由 loadAll 自己的 generation 收手，列表与分页一起作废。）
   */
  const playAllSession = useRef(0)

  /**
   * 播放全部：**先用手上的这一页起播**，余下的分页由 loadAll 在后台继续拉，
   * 每拉到一页就接到队列尾巴上（见 hooks/useSongList 的 loadAll）。
   *
   * ★ 不 await 那一趟：等整份列表就位再起播，几千首的曲库要等十几秒 —— 而用户按的是
   *   「播放」，不是「加载完再播放」。列表本身也会跟着一页页补全（表尾那条加载提示说的
   *   就是这件事，见 components/SongTable）。
   * ★ 追加走 addToQueue 而不是再调一次 playSongs：后者会重建队列与游标，正在放的那一首
   *   会被打断。追加只往后接，播到队尾自然接上新到的那些。
   */
  const playAll = useCallback(() => {
    if (list.songs.length === 0) return
    const session = ++playAllSession.current
    void playSongs(list.songs, 0, playContext)
    void list.loadAll((added) => {
      if (session !== playAllSession.current) return
      addToQueue(added)
    })
  }, [list, playSongs, addToQueue, playContext])

  /** 报给页头那行副标题（跟着标题走，见 components/LibraryHeader） */
  const subtitle =
    list.loading && list.songs.length === 0
      ? '正在读取…'
      : `${list.total} 首${list.total > list.songs.length ? `（已加载 ${list.songs.length}）` : ''}`

  return (
    <>
      {/* 这一页的动作钮作为页头的 children：与来源切换同一行（见 LibraryHeader） */}
      <LibraryHeader pane={fixedType === 'radio' ? 'radio' : 'library'} subtitle={subtitle}>
        {/* 只有「电台」那一份内容才有「添加」这件事：它是曲库里唯一靠链接录进来的类型 */}
        {fixedType === 'radio' ? (
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
          onClick={playAll}
        >
          <IconPlay size={15} />
          播放全部
        </button>
      </LibraryHeader>

      {/* ── 筛选区 ── */}
      <div
        className="row-between"
        style={{
          gap: 14,
          flexWrap: 'wrap',
          marginBottom: 14,
          // 电台那一半没有类型筛选，这一行只剩右端那几颗开关与排序 —— 让它们靠右（与曲库同一处收尾）
          justifyContent: fixedType ? 'flex-end' : undefined
        }}
      >
        {/* 类型筛选只属于「服务器」那一半：电台那一份内容只有一种类型（见 fixedType） */}
        {fixedType ? null : (
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
        )}

        <div className="row" style={{ gap: 8 }}>
          {/* 分类浏览：一颗开关钮（打开后表头上面多一块分面网格）。电台那一页没有它（见 facets） */}
          {fixedType ? null : (
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
          )}
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
          {/* 同一份内容的两种看法（曲库 / 文件夹）：挨着排序、在它左边 ——
              最右端留给排序（这一行里唯一带文字的下拉框，靠边收尾更好找）。
              电台那一份没有这一层（见 fixedType） */}
          {fixedType ? null : <LibraryViewSwitch pane="library" />}
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

      {activeFilters.length > 0 || showHidden || (type !== 'all' && !fixedType) ? (
        <div className="chip-row" style={{ marginBottom: 14 }}>
          <span style={{ fontSize: 11.5, color: 'var(--text-4)' }}>当前筛选</span>
          {/* 类型 chip 只属于「服务器」那一半：电台的类型是**这一页本身**定的，不是一个可解除的筛选 */}
          {type !== 'all' && !fixedType ? (
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
              // 电台那一半的类型是这一页本身定的，不是一条能清掉的筛选
              setType(fixedType ?? 'all')
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
        onPlayAt={(index) => void playSongs(list.songs, index, playContext)}
        hasMore={list.hasMore}
        loadingMore={list.loadingMore}
        onLoadMore={list.loadMore}
        selection={selection}
        onSelectionChange={(indexes) => {
          setSelection(indexes)
          setSelectAllIds(null)
        }}
        menuOptions={{ onDeleted: (ids) => list.removeSongs(ids) }}
        emptyTitle={fixedType === 'radio' ? '还没有电台' : '没有匹配的歌曲'}
        emptyDescription={
          fixedType === 'radio'
            ? '点页头的「添加电台」，把直播或视频电台的地址加进来'
            : '换个筛选条件，或去「设置 → 曲库」扫描音乐目录'
        }
        emptyAction={
          fixedType === 'radio' ? (
            <button
              type="button"
              className="btn"
              data-variant="primary"
              onClick={() => setAddingRadio(true)}
            >
              <IconPlus size={15} />
              添加电台
            </button>
          ) : (
            <button
              type="button"
              className="btn"
              data-variant="primary"
              onClick={() => navigate({ name: 'settings', section: 'library' })}
            >
              <IconUpload size={15} />
              去扫描曲库
            </button>
          )
        }
      />

      {/* 操作条不出现时（选中 0~1 首）「全选筛选」一直在这儿，别让这一档成了死角 */}
      {list.songs.length > 0 && selection.length < 2 && !selectAllIds ? (
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

      {shouldShowSelectionBar(selectAllIds?.length ?? selection.length) ? (
        <SelectionBar
          ids={totalForBar}
          songs={selectedSongs}
          /* 「全选当前筛选」手上只有 id：播放 / 入队前先把整份列表补齐（见 SelectionBar） */
          loadSongs={list.fetchAll}
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
