/**
 * 插件商店 —— 扩展主框架右侧的一栏（框架与左栏见 components/ExtensionFrame.tsx）。
 *
 * **两份来源共用这一页**，由搜索框旁边那个下拉切换：
 *   * 订阅源（后端聚合，`POST /jsplugins/registry/refresh`）—— 默认的那一份；
 *   * **GitHub 发现**（`GITHUB_DISCOVERY`）—— 按 topic 搜 GitHub 上的社区插件，
 *     由主进程逐个核对清单与 release 资产（见 hooks/useGithubDiscovery）。
 *     它在「管理订阅源」里是一张**固定卡片**（不可删除：没有注册表地址，也就没有「换一个」
 *     或「加回来」这回事），能改的只有开关与 Token —— 开关落在本地设置
 *     （`AppSettings.githubDiscovery`），停用后它不参与「全部订阅源」的聚合。
 *     下拉里它固定占一格（停用时标注「已停用」），单独选中仍然能看。
 *   搜索框与来源下拉是「搜什么 + 搜哪儿」的两半，所以切到发现之后**同一个搜索框**就变成了
 *   GitHub 搜索（关键词还会顺带搜 owner/repo）。
 *
 * ★ 「全部订阅源」= 服务端聚合 + GitHub 发现（开关打开时），**浏览与搜索都算**：
 *   选「全部」却只看到 URL 源那一半，等于这个下拉没兑现它写的字。两半分页各自独立，
 *   同一个网格里先翻订阅源、翻完再翻 GitHub（见 loadMoreTail）。
 *
 * 订阅源那一份里，三件事一律交给后端判断、前端绝不自己算：**装没装**（installed）、
 * **能不能更新**（has_update）、**是不是撞了别人的 entryPath**（conflict / conflict_with）。
 * 版本比较的规则在后端，前端再实现一遍必然漂移 —— 到时候界面说「可更新」、点了却装不进去。
 * 发现那一份没有后端可比，判断全在 shared/github-discovery.ts（同样只有一份实现）。
 *
 * `force` 只在点「刷新」时传：后端对订阅源有 5 分钟缓存，翻页与搜索都带上它等于每次都去
 * 重拉一遍远端，又慢又容易撞上源的限流。
 *
 * ★ 列表是**无限滚动**（滚到底自动续下一页），不再给「加载更多」按钮：这是「逛」的场景，
 *   让人盯着一颗按钮点，不如让列表跟着滚动自己长出来。
 *
 * ★ 卡片网格的形态参考社区插件市场（https://songloft-store.lllh.de）：一张卡 = 一个扩展，
 *   窄了自动一列、宽了自动多列；卡内自上而下是「图标 + 名称 + 动作」→ 描述 → 标签 →
 *   作者 / 版本 / 链接。原先是一行拉满整宽的列表行 —— 这一栏在宽窗口下能有上千像素，
 *   名称与按钮隔着半个屏幕，扫视时对不上。
 *   配色**不照搬**那个站（它是单主题的玻璃拟态）：这里一律走本仓的主题令牌，
 *   跟着封面主色与深浅色一起变。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  discoveryInstallState,
  discoveryRowKey,
  type GithubDiscoveryPlugin,
  type GithubInstallSource
} from '@shared/github-discovery'
import { GITHUB_DISCOVERY_NAME } from '@shared/ipc'
import { ApiError } from '@/api/client'
import { getGithubProxy, getVersion } from '@/api/endpoints'
import {
  getPluginRegistries,
  installFromRegistry,
  refreshRegistry,
  registryRowKey,
  type RegistryEntry,
  type RegistrySource
} from '@/api/plugins'
import { GithubDiscoveryCard } from '@/components/GithubDiscoveryCard'
import { GithubTokenDialog } from '@/components/GithubTokenDialog'
import {
  IconAlert,
  IconCloud,
  IconDownload,
  IconLoader,
  IconRefresh,
  IconSliders,
  IconStore
} from '@/components/Icons'
import { PluginIconFallback } from '@/components/PluginIcon'
import { EmptyState, InfiniteSentinel } from '@/components/primitives'
import { RegistrySourcesDialog } from '@/components/RegistrySourcesDialog'
import { SettingSelect, type SelectOption } from '@/components/SettingSelect'
import { useGithubDiscovery } from '@/hooks/useGithubDiscovery'
import { buildResourceUrl } from '@/lib/url'
import { resourceContext, useAuth } from '@/state/useAuth'
import { usePlugins } from '@/state/usePlugins'
import { useSettings } from '@/state/useSettings'
import { toast } from '@/state/useToasts'

/** 一页拉多少。太小翻页频繁，太大一次请求拿回一堆用不上的 manifest */
const PAGE_SIZE = 20

/**
 * 来源下拉里「GitHub 发现」那一格的值。
 *
 * ★ 它在**订阅源管理**里与 URL 源并排（同一个开关、同一行结构），但取值不走后端：
 *   它不是订阅源地址，`refreshRegistry` 也绝不能收到它。本页看到这个值时就走
 *   `useGithubDiscovery`，而不是去问后端「这个源有哪些插件」。
 */
const GITHUB_DISCOVERY = '__discovery__'

/**
 * 源地址的主机名 —— 下拉里那行说明用。
 *
 * 整串 URL 有六七十个字符，塞进菜单会把面板撑到半个窗口宽；而「这是哪个源」看主机名
 * 基本就够了（完整地址在「管理订阅源」里，那里才是改它的地方）。解析不了就原样退回：
 * 地址合不合法由后端判，这里不替它下结论。
 */
function sourceHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** 一次安装要交给服务端的那几样东西（两个来源共用同一条路，只有取法不同） */
interface InstallTarget {
  /** 正在装的那一行（按来源各自的行 key，只用来点亮按钮） */
  key: string
  name: string
  downloadUrl: string
  /**
   * 条目来自哪个订阅源；发现那边留空（GitHub release 是公开的，后端匿名下载即可）。
   * 后端据此解析该源的 token —— 单源筛选时条目不带这个字段，调用方传当前选中的源。
   */
  sourceUrl: string
  /** 成功回执的动词（安装 / 更新 / 重新安装 / 覆盖安装） */
  done: string
  /** 409 时告诉用户「被谁占着」；空串 = 本机已有的同入口插件 */
  conflictWith: string
}

export function PluginStore(): React.JSX.Element {
  const client = useAuth((state) => state.client)

  const [input, setInput] = useState('')
  const [keyword, setKeyword] = useState('')
  const [page, setPage] = useState(1)
  const [entries, setEntries] = useState<RegistryEntry[]>([])
  const [total, setTotal] = useState(0)
  /** 已经翻到底了（某页空着回来）。它比 `entries.length < total` 更硬，见下面那处 setExhausted */
  const [exhausted, setExhausted] = useState(false)
  const [warnings, setWarnings] = useState<string[]>([])
  /**
   * ★ 初值跟着 client 走，不是写死 false：这一页的**第一帧**就该是骨架屏。
   *   写死 false 的话，effect 里那句 setLoading(true) 跑在首次绘制之后 ——
   *   会先闪一下「商店里还没有扩展」的空态、再变成骨架，正是这一屏要消掉的那种跳动。
   *   没有会话（client 为 null）时压根不会发请求，也就不该摆骨架，照旧走空态的引导。
   */
  const [loading, setLoading] = useState(client !== null)
  const [error, setError] = useState<string | null>(null)
  /** 正在安装的那一行（按 registryRowKey）。同一时刻只允许一个，避免重复点出两次安装 */
  const [pending, setPending] = useState<string | null>(null)
  const [reloadToken, setReloadToken] = useState(0)

  /* 订阅源：一份给筛选下拉，一份留给「管理订阅源」对话框去改 */
  const [sources, setSources] = useState<RegistrySource[]>([])
  /** 空串 = 聚合所有启用的源（后端的默认行为） */
  const [sourceUrl, setSourceUrl] = useState('')
  const [sourcesOpen, setSourcesOpen] = useState(false)
  const [sourcesToken, setSourcesToken] = useState(0)

  /* GitHub 发现：Token 对话框、服务器版本、本次会话装上的那些 */
  const [tokenOpen, setTokenOpen] = useState(false)
  const [hostVersion, setHostVersion] = useState('')
  /** 选中的是「GitHub 发现」而不是某个订阅源 */
  const discoveryMode = sourceUrl === GITHUB_DISCOVERY
  const installedPlugins = usePlugins((state) => state.plugins)
  /**
   * 「这个入口是哪个仓库装进来的」——记在**设置**里（`AppSettings.githubInstalls`），
   * 不是本页的 state：离开商店页、重启应用之后它还得在。只放本页的话，再进来时同一张卡片
   * 就会被判成「入口冲突」（要替换掉的其实是它自己，见 shared/github-discovery 的
   * `discoveryInstallState`）。
   */
  const githubInstalls = useSettings((state) => state.settings.githubInstalls)
  /**
   * 「GitHub 发现」这一档的状态（见「管理订阅源」里那张固定卡片）。
   *
   * ★ 它固定存在、不可删除，只有「开 / 关」：关掉 = 不参与「全部订阅源」的聚合搜索，
   *   与 URL 源的 `enabled: false` 同义；单独选中它时仍然照查（那是用户明确指定的来源）。
   */
  const discoverySource = useSettings((state) => state.settings.githubDiscovery)
  /**
   * 这一页现在有没有 GitHub 卡片要画。
   *
   * ★ **搜索范围跟着下拉走**，这条是「选源」这件事的全部含义：
   *   · 选中「全部订阅源」（`sourceUrl === ''`）—— 聚合，GitHub 那一半也进来（没被停用时）。
   *     它和别的源一样是「全部」的一部分：不带关键词也照样列出来（浏览时也有它的卡片），
   *     否则「全部」就名不副实；
   *   · 选中某条 URL 源 —— **只搜那一个源**。这时候再把 GitHub 的结果混进来，
   *     用户会以为下拉没生效（他明明选了「官方源」，却看见 GitHub 的卡片）；
   *   · 选中「GitHub 发现」—— 只有它（`discoveryMode`）。
   */
  const githubCards = discoveryMode || (sourceUrl === '' && discoverySource.enabled)
  /**
   * ★ 没有 GitHub 卡片要画时 `active` 为 false：那个 hook 连一个请求都不发。
   *   关键词用父组件那份**已防抖**的 —— 搜索框是两半来源共用的同一颗。
   */
  const discovery = useGithubDiscovery({
    active: githubCards && client !== null,
    keyword
  })

  /**
   * 两处一次性标志，刻意用 ref 而不是 state：它们只是「这一次要不要强制」与
   * 「这次拉回来是追加还是替换」，写进 state 会让它们自己成为依赖，进而触发下一轮请求。
   */
  const forceRef = useRef(false)
  const proxyRef = useRef('')
  /** 上一次真正拿去请求的关键词（判断「是不是换了词」，刷新/换源不算） */
  const keywordRef = useRef(keyword)

  // 输入防抖：每敲一个字都去戳一次远端（还要穿过 GitHub 代理）既慢又扰民
  useEffect(() => {
    const timer = setTimeout(() => {
      setKeyword(input.trim())
      setPage(1)
    }, 350)
    return () => clearTimeout(timer)
  }, [input])

  /**
   * 读订阅源列表。
   *
   * 失败**不弹错**：商店在聚合模式下照样能用（后端自己有默认源），少一个筛选下拉而已。
   * 真想看为什么，打开「管理订阅源」——那边会把错误明说。
   */
  const reloadSources = useCallback((): void => {
    if (!client) return
    getPluginRegistries(client)
      .then((list) => {
        setSources(list)
        /*
         * 选中的那个源可能刚被删掉或改了地址。留着它的话下一次请求会 400
         * （单源模式的 `registry_url` 指向一个不存在的源），所以退回「全部订阅源」。
         *
         * ★ 「GitHub 发现」不在服务端那份名单里（它没有注册表地址），所以先单独放行。
         *   它也不会消失（固定卡片、不可删除），停用后也不退回 —— 停用只是「不参与聚合」，
         *   单独选中仍然能看。
         */
        setSourceUrl((current) =>
          current === GITHUB_DISCOVERY || !current || list.some((source) => source.url === current)
            ? current
            : ''
        )
      })
      .catch(() => undefined)
  }, [client])

  useEffect(() => {
    reloadSources()
  }, [reloadSources, sourcesToken])

  /** 当前筛选的那个源（没筛选时、或在发现页时为 undefined） */
  const selectedSource = sources.find((source) => source.url === sourceUrl)

  /**
   * 来源下拉的选项。
   *
   * ★ 每一项都给 desc（分隔项除外）：菜单按「任一档带说明就整层两行高」排，
   *   只给一部分的话条目高低不齐，看着像排版出了错。
   * ★ desc 放**主机名**而不是整串地址：六七十个字符的 URL 会把面板撑到半个窗口宽，
   *   而「这是哪个源」看主机名基本就够（完整地址在「管理订阅源」里能改）。
   * ★ 停用的源仍然列出来、也仍然可选：停用是「不参与聚合」，不是「不许看」——
   *   从下拉里悄悄消失的话，看起来就像「源没了」。
   */
  const sourceOptions = useMemo<SelectOption<string>[]>(
    () => [
      {
        value: '',
        label: '全部订阅源',
        desc: discoverySource.enabled ? '聚合所有已启用的源 · 含 GitHub 发现' : '聚合所有已启用的源'
      },
      // ★ 不做分隔线、也不分组：「GitHub 发现」与各条 URL 源是**同一层级的来源**，
      //   把它单独隔出来（或塞进 optgroup）会被读成「它是另一类东西」。
      {
        value: GITHUB_DISCOVERY,
        label: GITHUB_DISCOVERY_NAME,
        desc: discoverySource.enabled ? '按 topic 搜 GitHub 上的社区插件' : '已停用 · 不参与聚合'
      },
      ...sources.map((source) => ({
        value: source.url,
        label: source.name || source.url,
        desc: `${sourceHost(source.url)}${source.enabled ? '' : ' · 已停用'}`
      }))
    ],
    [sources, discoverySource.enabled]
  )
  /** 它的 token（没有筛选、或它是公开源时为空串） */
  const sourceToken = selectedSource?.token ?? ''

  /**
   * 服务器版本：发现页要拿它判 `minHostVersion`（装不上就别让人一路点到失败）。
   *
   * 拿不到就留空串 —— `hostCompatibility` 对空串返回 unknown，界面照旧放行（与上游一致：
   * 一个读不出版本的服务器不该让整个商店不可用）。
   */
  useEffect(() => {
    // 订阅源那边搜索时也会画出 GitHub 卡片，所以判据是「有没有卡片」而不是「是不是发现页」
    if (!githubCards || !client) return
    let cancelled = false
    getVersion(client)
      .then((info) => {
        if (!cancelled) setHostVersion(info.version ?? '')
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [githubCards, client])

  useEffect(() => {
    // 发现页不归后端那份聚合结果管：切过去时不能再发一次 registry/refresh
    if (!client || discoveryMode) return
    let cancelled = false
    /*
     * 换了关键词就把上一份结果收走。
     *
     * ★ 留着的话，请求在路上时屏幕上是「上一个词的卡片 + 尾部骨架」，而这两样合起来在用户
     *   眼里就是「这次搜到的，还在加载」—— 正是「搜 A 却出来 B」那种误读。
     * ★ 刷新与换源不清：那两种操作的列表本来就是同一份，清空只会白闪一下（连滚动位置都丢）。
     */
    if (keywordRef.current !== keyword) {
      keywordRef.current = keyword
      setEntries([])
      setTotal(0)
      setExhausted(false)
    }
    setLoading(true)

    void (async () => {
      try {
        // 后端不会自己去读它存的那份代理配置，必须显式带上；拉一次就记住
        if (!proxyRef.current) proxyRef.current = await getGithubProxy(client)
        const result = await refreshRegistry(client, {
          page,
          pageSize: PAGE_SIZE,
          search: keyword,
          force: forceRef.current,
          githubProxy: proxyRef.current,
          // 单源筛选：后端在这个模式下不会去读已保存的配置，私有源的 token 得自己带上
          sourceUrl,
          sourceToken
        })
        if (cancelled) return
        // 第 1 页是替换，其余是追加 —— 用 page 判断而不是清空重来，
        // 这样「滚到底续下一页」不会让已经看到的那些闪一下
        setEntries((previous) => (page === 1 ? result.plugins : [...previous, ...result.plugins]))
        setTotal(result.total)
        // 空着回来却还有 total 没走完：说明服务端那份名单在翻页途中变了（订阅源缓存过期）。
        // 就此打住 —— 否则滚到底会一页页地要空页，把服务端刷爆
        setExhausted(result.plugins.length === 0)
        setWarnings(result.warnings)
        setError(null)
      } catch (reason) {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : '插件商店打不开')
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
          forceRef.current = false
        }
      }
    })()

    return () => {
      cancelled = true
    }
    // 依赖里放的是 sourceToken 这个**字符串**而不是整份 sources：后者每次读源列表都会换
    // 引用，跟着它重跑等于挂载时白拉一次（用户什么都没改）
  }, [client, keyword, page, reloadToken, sourceUrl, sourceToken, discoveryMode])

  const refresh = (): void => {
    forceRef.current = true
    // page 本来就是 1 时 setPage 是空操作，靠 reloadToken 把 effect 捅醒
    setPage(1)
    setReloadToken((token) => token + 1)
    /*
     * 「全部订阅源」的一半是 GitHub：只刷订阅源那半的话，同一屏里另一半还是旧卡片 ——
     * 而这个按钮上写的是「刷新商店」，用户不会按来源把它理解成「只刷新一半」。
     * 单源模式（githubCards 为 false）没有那一半，也就不多打一次 GitHub。
     */
    if (githubCards && !discoveryMode) discovery.refresh()
  }

  const hasMore = !exhausted && entries.length < total

  /**
   * 续下一页。
   *
   * `loading` 这道闸不能省：IntersectionObserver 在「内容还填不满一屏」时会连着触发，
   * 没有它就会同时发好几页（后面的响应会把前面的替换掉，列表里于是出现空洞）。
   */
  const loadMore = useCallback((): void => {
    if (loading || !hasMore) return
    setPage((current) => current + 1)
  }, [loading, hasMore])

  /**
   * 尾部哨兵该翻哪一半。
   *
   * 「全部订阅源」把两套互相独立的分页（订阅源一页 / GitHub 一页）摆在同一个网格里，
   * 却只有一个哨兵：先翻订阅源那半，它到底了再翻 GitHub 那半。两半同时翻的话，一次滚动
   * 会窜出两批卡片，而且两半的「还有没有下一页」互不相干，屏幕上没法判断到底哪一半先没了。
   *
   * ★ 先把那个函数取出来再用：`discovery` 本身每渲染都是新对象，写进依赖等于每帧换一个
   *   回调，IntersectionObserver 也就每帧重挂一次（见 InfiniteSentinel 的 effect 依赖）。
   */
  const loadDiscoveryMore = discovery.loadMore
  const loadMoreTail = useCallback((): void => {
    if (hasMore) loadMore()
    else loadDiscoveryMore()
  }, [hasMore, loadDiscoveryMore, loadMore])

  /**
   * 安装 / 更新 / 重新安装的**唯一**那条路。
   *
   * 两个来源（订阅源与 GitHub 发现）在这里收口，差别的只有「这一行怎么标已装」——
   * 那一步留给调用方（各自知道自己的列表长什么样）。
   *
   * @returns 装成了没有。false 时调用方什么都不用改（失败提示与 409 询问都在这里做过了）
   */
  const runInstall = async (target: InstallTarget, overwrite = false): Promise<boolean> => {
    if (!client) return false
    setPending(target.key)
    try {
      if (!proxyRef.current) proxyRef.current = await getGithubProxy(client)
      const result = await installFromRegistry(client, {
        downloadUrl: target.downloadUrl,
        sourceUrl: target.sourceUrl,
        githubProxy: proxyRef.current,
        overwrite
      })
      // 后端把「安装失败」也放在 200 的 body 里（success: 0），所以要看结果而不是看有没有抛
      if (result.success === 0) {
        throw new Error(result.results[0]?.error || result.message || '安装失败')
      }
      // 同一颗按钮现在有四种含义（安装 / 更新 / 重新安装 / 覆盖安装），回执也跟着说清楚，
      // 否则点了「⟳ v1.2.3」却被告知「已安装」会让人怀疑是不是没生效
      toast(`${target.done}「${target.name}」`, 'success')
      // 插件列表变了 → 扩展侧栏里要跟着多出一项
      await usePlugins.getState().load()
      return true
    } catch (reason) {
      // ★ 409 = 同一个 entryPath 被**另一个作者**的插件占着，后端什么都没写。
      //   必须先问清楚，用户点头了才带 overwrite 重发。
      if (reason instanceof ApiError && reason.status === 409) {
        const occupant = target.conflictWith || '本机已有的同入口插件'
        const ok = window.confirm(
          `${occupant} 占用了同一个入口，继续安装会替换掉它（它的数据也会被清掉）。继续？`
        )
        setPending(null)
        // 这里用 await 而不是直接返回那个 Promise：让外层 finally 等它跑完再松手，
        // 否则按钮在真正装完之前就恢复成「安装」了
        if (ok) return await runInstall(target, true)
        return false
      }
      toast('安装失败', 'error', reason instanceof Error ? reason.message : undefined)
      return false
    } finally {
      setPending(null)
    }
  }

  const install = async (entry: RegistryEntry): Promise<void> => {
    const key = registryRowKey(entry)
    // 回执按这一行当前的状态挑动词（四档见 StoreCard 的 describeAction）
    const done = entry.conflict
      ? '已覆盖安装'
      : entry.hasUpdate
        ? '已更新'
        : entry.installed
          ? '已重新安装'
          : '已安装'
    const installed = await runInstall({
      key,
      name: entry.name || entry.entryPath,
      downloadUrl: entry.downloadUrl,
      // 聚合模式条目的 sourceUrl 就是它的来源；单源筛选模式下条目不带这个字段，
      // 那时「来源」就是当前选中的那个源 —— 两种都只是把 URL 交给后端，token 由它自己查
      sourceUrl: entry.sourceUrl || sourceUrl,
      done,
      conflictWith: entry.conflictWith
    })
    if (!installed) return
    /**
     * 只把这一行就地改成「已安装」，**不重拉列表**。
     *
     * 重拉会把第 1 页追加到现有列表后面（effect 按 `page > 1` 判追加），在翻过几页之后
     * 等于把已看过的那些再来一遍；退回第 1 页倒是不会重复，但用户的滚动位置就丢了 ——
     * 装完一个还想接着往下逛，结果被弹回顶上。
     */
    setEntries((previous) =>
      previous.map((item) =>
        registryRowKey(item) === key
          ? {
              ...item,
              installed: true,
              installedVersion: item.version,
              hasUpdate: false,
              conflict: false,
              conflictWith: ''
            }
          : item
      )
    )
  }

  /**
   * 从 GitHub 发现里装。
   *
   * 与订阅源那一条的**唯一**实质差别：这是未经审核的社区插件，必须先让人看见「来源 +
   * 申请的权限」再点头。撞名（入口被本机另一个插件占着）也一并说在同一段里 ——
   * 分两次问等于让人在两个弹窗之间来回确认同一件事。
   */
  const installDiscovery = async (plugin: GithubDiscoveryPlugin): Promise<void> => {
    if (!client) return
    const manifest = plugin.manifest
    const state = discoveryInstallState({
      plugin,
      installed: installedPlugins,
      hostVersion,
      installs: githubInstalls
    })
    if (state.action === 'blocked') return

    const permissions = manifest.permissions.length ? manifest.permissions.join('、') : '无'
    const replace =
      state.action === 'overwrite' && state.occupant
        ? `\n\n入口 ${manifest.entryPath} 已被「${
            state.occupant.name || state.occupant.entryPath
          } v${state.occupant.version}」占用，安装会替换它（它的数据也会被清掉）。`
        : ''
    const ok = window.confirm(
      `将 ${plugin.repository.fullName} 的「${manifest.name}」v${manifest.version} 安装到当前服务器？\n\n` +
        `此插件未经 Songloft 审核，请先确认来源与申请的权限。\n申请的权限：${permissions}${replace}`
    )
    if (!ok) return

    const done =
      state.action === 'overwrite'
        ? '已覆盖安装'
        : state.action === 'update'
          ? '已更新'
          : state.action === 'reinstall'
            ? '已重新安装'
            : '已安装'
    const installed = await runInstall(
      {
        key: discoveryRowKey(plugin),
        name: manifest.name,
        downloadUrl: plugin.downloadUrl,
        sourceUrl: '',
        done,
        conflictWith: state.occupant
          ? `${state.occupant.name || state.occupant.entryPath} v${state.occupant.version}`
          : ''
      },
      // 上面已经说过「会替换它」了，不再让 409 弹第二遍
      state.action === 'overwrite'
    )
    if (!installed) return
    /*
     * 记一笔「这个入口是这个仓库装进来的」：插件包装上之后服务端那份清单里多半没有下载地址，
     * 认不出「它是这个仓库的」——不记，卡片当场翻成「覆盖安装」，下次进商店也一样。
     * ★ 写进**设置**（落盘），不是本页 state：离开商店 / 重启应用之后这一笔仍然作数。
     * ★ 顺手把「本机已经没有那份插件」的旧记录清掉：同一个入口可能换过主人，
     *   留着只会把别人家的插件认成自己人（见 `pointsAtAnotherRepository` 那一段）。
     */
    const alive = new Set(usePlugins.getState().plugins.map((item) => item.entryPath))
    const installs: Record<string, GithubInstallSource> = {}
    for (const [key, value] of Object.entries(useSettings.getState().settings.githubInstalls)) {
      if (alive.has(key)) installs[key] = value
    }
    installs[manifest.entryPath] = {
      repositoryId: plugin.repository.id,
      version: manifest.version
    }
    void useSettings.getState().patch({ githubInstalls: installs })
  }

  /** 源改过之后：商店那份列表与筛选选项都得重新来过（后端也会顺手作废它的缓存） */
  const onSourcesSaved = (): void => {
    setSourcesToken((token) => token + 1)
    setPage(1)
    setReloadToken((token) => token + 1)
    // 订阅源管理里也能改 GitHub 的 Token（与「修改 Token」对话框编辑的是同一份服务端凭据），
    // 这里重读一次，手头这份 Token 才不会停在旧结论上
    void discovery.reloadToken()
  }

  /* 发现页底部那一行统计：被过滤掉的（发布格式不合规）与暂时没核对成的要分开说 */
  const discoveryExcluded =
    (discovery.failures.invalidManifest ?? 0) +
    (discovery.failures.invalidRelease ?? 0) +
    (discovery.failures.unpublished ?? 0)
  const discoveryUnverified =
    (discovery.failures.unavailable ?? 0) + (discovery.failures.rateLimited ?? 0)
  /** 限流会告诉我们什么时候能再试；有就带上，没有就不提 */
  const retryHint = discovery.retryAt
    ? ` ${new Date(discovery.retryAt).toLocaleTimeString()} 后可重试。`
    : ''

  const discoveryErrorTitle =
    discovery.error?.reason === 'invalidToken'
      ? 'GitHub Token 无效'
      : discovery.error?.reason === 'rateLimited'
        ? '已达到 GitHub 请求限额'
        : '加载 GitHub 发现失败'

  /**
   * GitHub 卡片的**唯一**画法：发现页与「订阅源那边搜出来的那一节」共用。
   *
   * 两处各写一遍的话，`discoveryInstallState` 的参数迟早只在一处记得更新 ——
   * 而「已装 / 可更新 / 入口冲突 / 不兼容」四档是从那一份状态里来的，两处一旦分叉，
   * 同一个插件在两张卡上会给出两种说法。
   */
  const renderDiscoveryCard = (plugin: GithubDiscoveryPlugin): React.JSX.Element => {
    const key = discoveryRowKey(plugin)
    return (
      <GithubDiscoveryCard
        key={key}
        plugin={plugin}
        state={discoveryInstallState({
          plugin,
          installed: installedPlugins,
          hostVersion,
          installs: githubInstalls
        })}
        pending={pending === key}
        disabled={pending !== null && pending !== key}
        onInstall={() => void installDiscovery(plugin)}
      />
    )
  }

  /**
   * 订阅源那一侧要一并画出来的 GitHub 卡片（发现页里它们自己就是主列表，这里为空）。
   *
   * ★ 判据是 **`githubCards`**，不是「有没有关键词」：选中「全部订阅源」时，GitHub 发现
   *   就是「全部」的一半 —— 浏览时也该出现它的卡片（只用关键词当条件的话，不搜东西就一张
   *   GitHub 卡片都看不到，「全部」名不副实）。搜索时同样成立，而且那正是跨来源搜索要的。
   * ★ 选中某条 URL 源时 `githubCards` 为 false，结果里绝不能混进 GitHub 的卡片 ——
   *   用户明明选了「官方源」，看见社区卡片会以为下拉没生效。
   */
  const githubMatches = githubCards && !discoveryMode ? discovery.plugins : []
  /** 「全部订阅源」下 GitHub 这一半还有下一页：它与订阅源那半各翻各的（见尾部那个哨兵） */
  const moreDiscovery = githubMatches.length > 0 && discovery.hasMore && !discovery.error

  /**
   * 这一屏还有哪一半在路上。
   *
   * 两半来源同时出发（订阅源一次请求、GitHub 一次搜索），先到的那半先落位，后到的那半
   * 由网格**尾部**的骨架卡占住位置 —— 这里就是「要不要摆那几张」的判据。续页也算：
   * `loading` 覆盖首屏 / 搜索 / 刷新，`discovery.loadingMore` 是发现那半的续页。
   */
  const pendingMore = loading || (githubCards && (discovery.loading || discovery.loadingMore))
  /** 已经有卡片可画：这时骨架只在尾部补几张，而不是整块重摆 */
  const hasCards = githubMatches.length > 0 || (!error && entries.length > 0)

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title row" style={{ gap: 10 }}>
            <IconStore size={24} />
            插件商店
          </h1>
          <p className="page-subtitle">
            {/*
              副标题把**当前搜索范围**说出来：切了源之后列表会变短或变长，
              不写清楚的话那看起来只是「结果变了」而不是「范围变了」。

              ★ 各分支的文案要**差不多长**（一句，收尾都是「安装…在服务端完成」）：
              副标题没有固定行高，哪个分支多出一行，页头就跟着变高，
              每切一次源，下面的搜索框与卡片网格都要跳一次。所以 GitHub 这一档
              只说「范围 + 未经审核」，核对规则与免责细节交给卡片、安装确认与统计行。
            */}
            {discoveryMode
              ? '只显示 GitHub 社区发现的扩展（未经审核）；安装与更新都在服务端完成。'
              : selectedSource
                ? `只显示「${selectedSource.name || selectedSource.url}」里的扩展，安装与更新都在服务端完成。`
                : discoverySource.enabled
                  ? '列表来自服务端的扩展订阅源与 GitHub 社区（「GitHub 发现」）；安装与更新都在服务端完成。'
                  : '列表来自服务端的扩展订阅源（「GitHub 发现」已停用，不参与聚合）；安装与更新都在服务端完成。'}
            {discoveryMode
              ? discovery.plugins.length > 0
                ? ` 已载入 ${discovery.plugins.length} 个。`
                : ''
              : total > 0
                ? ` 已载入 ${entries.length} / ${total} 个。`
                : ''}
          </p>
        </div>

        <div className="row">
          {/*
            右上角**不随来源换一套按钮**：选中「GitHub 发现」只是把范围收窄，不是进另一个页面，
            为了它多长出一颗「GitHub Token」、或者把「刷新商店」改叫「刷新」，都会让每切一次源
            按钮就跟着挪一次。所以两颗按钮的字面与顺序在所有来源下都是同一套，
            只有「刷新实际上重取哪一半」按来源走。
            Token 配置在「管理订阅源」那张固定卡片里；Token 失效时，下面出错的那块另有
            「修改 Token」直接到对话框。
          */}
          <button type="button" className="btn" data-size="sm" onClick={() => setSourcesOpen(true)}>
            <IconSliders size={14} />
            管理订阅源
          </button>
          <button
            type="button"
            className="btn"
            data-size="sm"
            onClick={discoveryMode ? discovery.refresh : refresh}
          >
            <IconRefresh size={14} />
            刷新商店
          </button>
        </div>
      </div>

      {/* 搜索 + 筛选是这一页的工具栏，**铺满整行**：右边界与下面的卡片网格对齐。
          原先把它收在 420 宽，落成「左端挤着两个框、右边空掉一大块」，跟卡片网格两端
          都对不上，看着像没排完。搜索框用 flex 吃掉剩下的宽度（`minWidth: 0` 是让它在
          窄窗口里能被压下去，否则 input 的固有宽度会把这一行顶出容器），
          筛选下拉固定 240 紧挨着它 ——「搜什么 + 搜哪儿」是同一件事的两半。 */}
      <div className="row">
        <input
          className="input"
          type="search"
          value={input}
          // 发现页那一份搜的是 GitHub：关键词还会顺带搜 owner/repo，所以提示得跟着换
          placeholder={discoveryMode ? '搜索扩展或 owner/repo…' : '搜索扩展…'}
          aria-label="搜索扩展"
          style={{ flex: '1 1 auto', minWidth: 0 }}
          onChange={(event) => setInput(event.target.value)}
        />
        {/*
          下拉换成 SettingSelect（与设置页同一个组件）：原生 <select> 的弹层由浏览器画，
          改不了圆角、悬浮底色、也塞不下第二行说明 —— 而「这个源是什么、开没开」恰恰要看
          说明那一行。面板挂在 ContextMenuHost 上，贴边翻转 / 点别处关闭 / Esc 都是现成的。
        */}
        <SettingSelect
          ariaLabel="筛选订阅源"
          width={240}
          style={{ flex: 'none' }}
          value={sourceUrl}
          options={sourceOptions}
          onChange={(next) => {
            setSourceUrl(next)
            setPage(1)
            setReloadToken((token) => token + 1)
          }}
        />
      </div>

      {discoveryMode ? (
        <>
          {/*
            ★ 「GitHub 发现」不再有自己的排序下拉，也不再单独占一行免责提示：
              它和别的源一样是「全部订阅源」的一份子，选中它只是**收窄范围**，
              不该顺手把这一页的排版也换一套（换一套 = 每切一次源，视线上面的东西都挪一次）。
              「未经审核」只留在副标题的一个短语里，细节在卡片与安装确认里（见 installFromGithub）。
          */}
          {discovery.error && discovery.plugins.length > 0 ? (
            <div className="probe-result" data-state="error" style={{ marginTop: 10 }}>
              <IconAlert size={15} />
              <span>
                {discovery.error.message}
                {retryHint}
              </span>
            </div>
          ) : null}

          {discovery.error && discovery.plugins.length === 0 ? (
            <EmptyState
              icon={<IconCloud size={26} />}
              title={discoveryErrorTitle}
              description={`${discovery.error.message}${retryHint}`}
              action={
                <div className="row">
                  {discovery.error.reason === 'invalidToken' ? (
                    <button
                      type="button"
                      className="btn"
                      data-size="sm"
                      onClick={() => setTokenOpen(true)}
                    >
                      修改 Token
                    </button>
                  ) : null}
                  <button type="button" className="btn" data-size="sm" onClick={discovery.refresh}>
                    重试
                  </button>
                </div>
              }
            />
          ) : null}

          {!discovery.error && !discovery.loading && discovery.plugins.length === 0 ? (
            <EmptyState
              icon={<IconCloud size={26} />}
              // 没有会话时这一页**什么都没查**，说「没发现」会让人以为 GitHub 上真的没有
              title={
                !client ? '需要连接服务器' : keyword ? '没有匹配的扩展' : '没有发现可用的社区扩展'
              }
              description={
                !client
                  ? '「GitHub 发现」的 Token 与安装都由服务器完成；先连接一台服务器再来。'
                  : keyword
                    ? '换个关键词试试（也可以直接搜 owner/repo）。'
                    : discoveryUnverified
                      ? '有仓库暂时没能核对（GitHub 限流或网络），稍后重试；配置 Token 后配额高得多。'
                      : 'GitHub 上没有找到同时满足「topic + 清单格式 + Release 资产」的仓库 —— 这不代表社区里没有插件，也可能只是还没按发现规则发布。'
              }
            />
          ) : null}

          {/*
            有卡片就画卡片，还在等就在**同一个网格的尾部**补一排骨架（首屏、搜索、续页
            三种等待共用这一条路）；一张都没有时才摆整块骨架。转圈那一档在这里没有位置：
            它与骨架说的是同一件事，却既没说清楚「长在哪儿」，也没说清楚「长多大」。
          */}
          {discovery.plugins.length > 0 ? (
            <ul className="store-grid">
              {discovery.plugins.map(renderDiscoveryCard)}
              {discovery.loading || discovery.loadingMore
                ? Array.from({ length: SKELETON_TAIL }, (_, index) => (
                    <StoreCardSkeleton key={`pending-${index}`} />
                  ))
                : null}
            </ul>
          ) : !discovery.error && (discovery.loading || discovery.loadingMore) ? (
            <StoreGridSkeleton />
          ) : null}

          {/*
            统计行兼两用：它同时是「到底了」的提示 —— 无限滚动列表滚到底时
            「不再长出新行」与「卡住了」在屏幕上长得一模一样。
          */}
          {!discovery.loading && (discovery.checked > 0 || discovery.plugins.length > 0) ? (
            <p className="list-end">
              已检查 {discovery.checked} 个仓库 · 发现 {discovery.plugins.length} 个插件
              {discoveryExcluded ? ` · 过滤 ${discoveryExcluded} 个` : ''}
              {discoveryUnverified ? ` · 暂未验证 ${discoveryUnverified} 个` : ''}
              {discovery.incomplete ? ' · 当前为部分结果' : ''}
            </p>
          ) : null}

          {/* key 跟着已载入的条数走：内容不够高时哨兵仍在视口里，观察器不会再来一次 ——
              换一个元素重挂观察器，它会立刻以「当前可见」回调一次，列表就能一路续到填满 */}
          {discovery.hasMore && !discovery.error ? (
            <InfiniteSentinel
              key={`discovery-${discovery.plugins.length}`}
              onVisible={discovery.loadMore}
              disabled={discovery.loadingMore}
            />
          ) : null}
        </>
      ) : (
        <>
          {warnings.length ? (
            <p className="field-hint" style={{ marginTop: 10 }}>
              {warnings.join(' · ')}
            </p>
          ) : null}

          {error ? (
            <EmptyState
              icon={<IconStore size={26} />}
              title="插件商店打不开"
              description={error}
              action={
                <button type="button" className="btn" data-size="sm" onClick={refresh}>
                  重试
                </button>
              }
            />
          ) : null}

          {/*
            空态要等**两半来源都没结果**才摆：搜索是跨来源的（订阅源 + GitHub 社区），
            只因为订阅源这一半空着就说「没有匹配的扩展」，而 GitHub 那半还在查/刚查到，
            等于给了一个假的结论。同理，那一半**失败了**也不摆空态 —— 由下面那条错误提示
            交代原因，不然「没有可装的扩展」会把一次失败说成「本来就没有」。
          */}
          {!error &&
          !loading &&
          entries.length === 0 &&
          githubMatches.length === 0 &&
          !(githubCards && discovery.loading) &&
          !(githubCards && discovery.error) ? (
            <EmptyState
              icon={<IconStore size={26} />}
              title={keyword ? '没有匹配的扩展' : '商店里还没有扩展'}
              description={
                keyword
                  ? '订阅源与 GitHub 社区里都没有匹配的扩展，换个关键词试试（也可以搜 owner/repo）。'
                  : selectedSource
                    ? `「${selectedSource.name || selectedSource.url}」里没有可装的扩展。`
                    : sources.length === 0
                      ? '还没有配置订阅源 —— 点右上角「管理订阅源」加一个。'
                      : githubCards
                        ? '已配置的订阅源与 GitHub 社区里都没有可装的扩展。'
                        : '已配置的订阅源里没有可装的扩展。'
              }
            />
          ) : null}

          {/*
            GitHub 那一半出错：这一屏没有发现页那一块（错误态只在单独选中「GitHub 发现」
            时才画整块），但「卡片少了一半」必须说出来，否则看起来就是这个社区里没有插件。
          */}
          {githubCards && !discoveryMode && discovery.error ? (
            <div className="probe-result" data-state="error" style={{ marginTop: 10 }}>
              <IconAlert size={15} />
              <span>
                {`GitHub 社区那一半没拉到：${discovery.error.message}`}
                {retryHint}
              </span>
            </div>
          ) : null}

          {/*
            GitHub 那一半：「全部订阅源」里它和订阅源同级 —— 浏览（不带关键词）时也列出来，
            搜索时列的是跨来源的命中（同一张卡片、同一条安装路径）。不列的话，「全部订阅源」
            只覆盖了 URL 源那一半，而 GitHub 是否出现取决于有没有关键词，看着像时好时坏。

            ★ 两半**排进同一个 .store-grid**，不各摆一个：两个网格各自换行的话，第一行末尾
              剩下的空位就白扔了 —— GitHub 命中几个之后，订阅源的卡片会从新的一整行开始
              排，看上去像两份互不相干的结果。混排之后卡片一路铺满，来源的差别只体现在
              卡片自己的底行（仓库名 / 订阅源）与下面那句提示里。

            ★ 同一个道理，**等待也排在这个网格里**：先回来的那半先落位，还没回来的那半由
              尾部几张骨架卡占着位置（见 SKELETON_TAIL）。另起一块骨架屏、或者摆一枚转圈
              图标，都会让人以为「上面这些已经齐了，下面另开一节」。
          */}
          {githubMatches.length > 0 ? (
            <p className="field-hint" style={{ marginTop: 14 }}>
              {`其中 ${githubMatches.length} 个来自 GitHub 社区（通过「GitHub 发现」找到，未经审核）。`}
            </p>
          ) : null}

          {hasCards ? (
            <ul className="store-grid">
              {/*
                浏览时**订阅源在前、GitHub 在后**：这个下拉叫「全部订阅源」，服务端那份是
                主体，让社区卡片把官方的挤到首屏以下就本末倒置了。搜索时反过来 —— 有关键词
                时两边都是「命中」，谁在前只影响扫视顺序，而 GitHub 那一半是照相关性排的。
              */}
              {keyword ? githubMatches.map(renderDiscoveryCard) : null}
              {error
                ? null
                : entries.map((entry) => (
                    <StoreCard
                      key={registryRowKey(entry)}
                      entry={entry}
                      pending={pending === registryRowKey(entry)}
                      disabled={pending !== null && pending !== registryRowKey(entry)}
                      onInstall={() => void install(entry)}
                    />
                  ))}
              {keyword ? null : githubMatches.map(renderDiscoveryCard)}
              {/* 还有一半在路上：尾部补一排骨架。不另起一节、也不摆转圈 —— 三者说的是
                  同一件事（「这儿还要长出卡片」），而只有骨架同时说清了长在哪儿、长多大 */}
              {pendingMore
                ? Array.from({ length: SKELETON_TAIL }, (_, index) => (
                    <StoreCardSkeleton key={`pending-${index}`} />
                  ))
                : null}
            </ul>
          ) : pendingMore ? (
            /* 一张都还没有：整块骨架（见 StoreGridSkeleton） */
            <StoreGridSkeleton />
          ) : null}

          {/*
            到底的提示。★ 不能省：无限滚动的列表滚到底时「不再长出新行」与「卡住了」
            在屏幕上长得一模一样，用户只能靠反复上下来回滚来确认。给一句话，滚到底这件事
            就有了明确的下文。
            列表为空时走上面那条空态，所以这里要求有卡片；而「到底」要**两半都没了**才算，
            只看订阅源那半的话，GitHub 那半还有下一页时也会说「已经到底了」。
          */}
          {!error &&
          !loading &&
          (entries.length > 0 || githubMatches.length > 0) &&
          !hasMore &&
          !moreDiscovery ? (
            <p className="list-end">已经到底了</p>
          ) : null}

          {/* key 跟着页码（以及 GitHub 那半的条数）走：内容不够高时哨兵仍在视口里，
              观察器不会再来一次 —— 换一个元素重新挂观察器，它会立刻以「当前可见」回调一次，
              列表就能一路续到填满视口为止。disabled 只按「正在翻的到底是哪一半」判 */}
          {!error && (hasMore || moreDiscovery) ? (
            <InfiniteSentinel
              key={`${page}-${githubMatches.length}`}
              onVisible={loadMoreTail}
              disabled={!hasMore && discovery.loadingMore}
            />
          ) : null}
        </>
      )}

      {sourcesOpen ? (
        <RegistrySourcesDialog onClose={() => setSourcesOpen(false)} onSaved={onSourcesSaved} />
      ) : null}

      {tokenOpen ? (
        <GithubTokenDialog
          token={discovery.token}
          loading={discovery.credentialLoading}
          loadError={discovery.credentialError}
          onSave={discovery.saveToken}
          onClose={() => setTokenOpen(false)}
        />
      ) : null}
    </div>
  )
}

/* ─────────────────────────────── 单张卡片 ─────────────────────────────── */

interface StoreCardProps {
  entry: RegistryEntry
  pending: boolean
  disabled: boolean
  onInstall: () => void
}

/**
 * 按钮那一档长什么样。
 *
 * 四档与上游 Flutter 端 `plugin_registry.dart` 的 `_buildAction` 逐条对应：
 *   未装        → 「安装」（主色实心）
 *   入口撞名    → 「覆盖安装」（危险色）
 *   装了且可更新 → 「更新至 v<商店版本>」
 *   装了且最新  → 「⟳ v<本机版本>」= 把这一版**重新装一遍**（上游是带「重新安装」tooltip 的
 *                ActionChip），所以它**可点**，不是一块状态牌
 *
 * 顺序不能反：conflict 优先于 installed —— 撞名的那一条 `installed` 是 false
 * （本地装的根本不是它），只看 installed 会把它显示成「安装」，点下去才发现要覆盖。
 */
interface StoreAction {
  label: string
  /** 无障碍名。只有「⟳ v1.2.3」这一档看不出动词，才需要另给一句 */
  ariaLabel?: string
  variant?: 'primary' | 'danger'
  /** 名字后面那个角标 */
  tone?: 'accent' | 'danger'
  tip?: string
  /** 用「⟳」而不是「⤓」：它说的是「重新装一遍」，不是「从商店下载」 */
  refresh?: boolean
}

function describeAction(entry: RegistryEntry): StoreAction {
  if (entry.conflict) {
    return { label: '覆盖安装', variant: 'danger', tone: 'danger' }
  }
  if (entry.hasUpdate) {
    // 说的是**它会变成哪个版本**（商店里那个），不是本机现在那个
    return { label: `更新至 v${entry.version || '—'}`, tone: 'accent' }
  }
  if (entry.installed) {
    // 显示**本机版本**：这一档要回答的是「我这儿装的是哪一版」
    const version = entry.installedVersion || entry.version || '—'
    return {
      label: `v${version}`,
      ariaLabel: `重新安装 v${version}`,
      tip: '重新安装',
      refresh: true
    }
  }
  return { label: '安装', variant: 'primary' }
}

function StoreCard({ entry, pending, disabled, onInstall }: StoreCardProps): React.JSX.Element {
  const name = entry.name || entry.entryPath
  const action = describeAction(entry)

  /**
   * 卡片底部那一行的几段，先拼成**一个**字符串再渲染。
   *
   * 摆一排 span 的话逐段折行，窄到一列时看着像几段无关的字；拼起来让浏览器整句折。
   */
  const meta = [entry.author || '未知作者', `v${entry.version || '—'}`]
  if (entry.installed && entry.installedVersion && entry.installedVersion !== entry.version) {
    meta.push(`本机 v${entry.installedVersion}`)
  }

  return (
    <li className="store-card">
      <div className="store-card-top">
        <StoreIcon entry={entry} name={name} />

        <span className="store-card-name truncate" title={name}>
          {name}
        </span>

        <button
          type="button"
          className="btn store-card-action"
          data-size="sm"
          data-variant={action.variant}
          aria-label={action.ariaLabel}
          data-tip={action.tip}
          // 四档都可点（「已装且最新」= 重新装一遍）；只有别的卡片正在装时才按住，别让人开第二个
          disabled={pending || disabled}
          onClick={onInstall}
        >
          {pending ? (
            <IconLoader size={14} />
          ) : action.refresh ? (
            <IconRefresh size={14} />
          ) : (
            <IconDownload size={14} />
          )}
          {action.label}
        </button>
      </div>

      <p className="store-card-desc">{entry.description || '暂无描述'}</p>

      <div className="store-card-tags">
        {entry.sourceName ? <span className="badge">{entry.sourceName}</span> : null}
        {action.tone ? (
          <span className="badge" data-tone={action.tone}>
            {entry.conflict ? '入口冲突' : '有新版本'}
          </span>
        ) : null}
        {/* entryPath 是撞名时唯一能分辨两条的字段（后端按 entryPath + identity 去重），
            所以它得在卡片上可见；等宽是为了两条 entryPath 好逐段对照 */}
        {entry.entryPath ? (
          <span className="store-card-code truncate" title={entry.entryPath}>
            {entry.entryPath}
          </span>
        ) : null}
      </div>

      {entry.conflict && entry.conflictWith ? (
        <p className="store-card-note">已被 {entry.conflictWith} 占用</p>
      ) : null}

      <div className="store-card-foot">
        <span className="truncate">{meta.join(' · ')}</span>
        {entry.homepage ? (
          <button
            type="button"
            className="link"
            // 外链交给系统浏览器：渲染层自己开窗会被主进程的导航围栏拦下（见 main/windows.ts）
            onClick={() => void window.songloft.shell.openExternal(entry.homepage)}
          >
            主页
          </button>
        ) : null}
      </div>
    </li>
  )
}

/* ─────────────────────────── 卡片网格的骨架屏 ─────────────────────────── */

/**
 * 首屏摆几张骨架卡。
 *
 * 不能拿 PAGE_SIZE（20）来摆 —— 那是「一次请求拉多少」，不是「一屏看得见多少」：
 * 12 张已经把首屏铺满还多出一点（3 列时 4 行），20 张会撑到七行；而商店里真的只有
 * 三条时，骨架摆得越长，数据回来那一刻页面缩得越狠。
 *
 * 12 这个数在常见的几档列数下都排得出整行（4×3 / 3×4 / 2×6），末行不会孤零零挂着一张。
 */
const SKELETON_CARDS = 12

/**
 * 已经有卡片、只差一半没回来时，尾部补几张骨架。
 *
 * 比 SKELETON_CARDS 短得多，理由不同：整块骨架要顶住首屏（不能一回来就长出一大截），
 * 而尾部这几张只是说「这边还在长」，**一排**就够。摆满一屏反而会让人觉得结果有那么多，
 * 真回来时页面往回缩得厉害（常见的一列 3 张，宽屏 4 张，一排都能排得下）。
 */
const SKELETON_TAIL = 3

/**
 * 商店卡片的骨架屏。
 *
 * ★ 它**复用 StoreCard 那一套类名**（.store-grid / .store-card / .store-card-top /
 *   .store-card-desc / .store-card-tags / .store-card-foot），而不是自己摆一套尺寸：
 *   占位块的位置因此由**同一份 CSS** 决定 —— 卡片高度、内边距、区块间距、图标尺寸
 *   天然对齐，数据回来时只是灰条换成文字。自己另写一套尺寸的话，将来改卡片样式必然
 *   忘了改这里，两者会慢慢错开；而错开的表现，正是这一屏要消掉的那种跳动。
 *
 * ★ 只有一处刻意不等真：描述那一块不论真实文本是几行，都只摆两行灰条。
 *   真实的 .store-card-desc 本来就有 min-height: 39px 兜底（见 components.css 里那段
 *   「描述固定两行的高度」），所以一条描述与两条描述的卡片一样高，骨架照这个高度摆也对得上。
 */
function StoreCardSkeleton(): React.JSX.Element {
  return (
    <li className="store-card" aria-hidden="true" style={{ pointerEvents: 'none' }}>
      <div className="store-card-top">
        {/* 图标：与 StoreIcon 那 40px 同尺寸（.store-card .plugin-icon） */}
        <div
          className="skeleton"
          style={{ flex: 'none', width: 40, height: 40, borderRadius: 8 }}
        />
        {/* 名称这一格是顶行唯一可伸缩的（.store-card-name 的 flex: 1 + min-width: 0），
            所以占位块挂在它**里面**，而不是拿灰条顶掉这一格 */}
        <span className="store-card-name">
          <div className="skeleton" style={{ height: 13, width: '58%' }} />
        </span>
        {/* 动作按钮：.btn[data-size='sm'] 是 29px 高，「安装」两个字量下来约 84 宽 */}
        <div
          className="skeleton"
          style={{ flex: 'none', width: 84, height: 29, borderRadius: 'var(--r-sm)' }}
        />
      </div>

      {/* 描述：两条灰条。行距按 .store-card-desc 的行高摆（12.5px × 1.55 ≈ 19，减掉条高 12） */}
      <div className="store-card-desc" style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
        <div className="skeleton" style={{ height: 12, width: '100%' }} />
        <div className="skeleton" style={{ height: 12, width: '62%' }} />
      </div>

      {/* 标签行：来源徽标 + entryPath 两枚。★ 两者高度**不一样**、要各按各的来：
          徽标是 .badge 的 18px，而 entryPath 那块（.store-card-code）是 11px 的字乘上
          继承来的 1.5 行高、再加它自己的上下 2px 内边距 = 20.5 —— 照着 18 摆，整行会矮
          2.5px，全店的卡片跟着矮一截 */}
      <div className="store-card-tags">
        <div className="skeleton" style={{ width: 70, height: 18, borderRadius: 'var(--r-xs)' }} />
        <div
          className="skeleton"
          style={{ width: 104, height: 20.5, borderRadius: 'var(--r-xs)' }}
        />
      </div>

      {/*
        底行。两处不显然，都是为了让外框与真实底行一样高：
        * 两段用 span 而不是 div：.store-card-foot > span 那条 `flex: 1` 正是真实底行的分栏
          方式（左边「作者 · 版本」占满、右边「主页」贴尾），用 div 就得再抄一遍；
        * minHeight 用 1lh：真实底行的高度是**文字的行盒**撑起来的（11.5px × 继承来的
          行高 1.5 ≈ 17px），灰条只有 12px —— 不把行盒补回来，每张骨架卡会矮 5px，
          数据一回来整片卡片往下长一截。写 1lh 而不是 17：字号变了它跟着变。
      */}
      <div className="store-card-foot" style={{ minHeight: '1lh' }}>
        <span className="skeleton" style={{ height: 12 }} />
        <span className="skeleton" style={{ flex: 'none', width: 26, height: 12 }} />
      </div>
    </li>
  )
}

function StoreGridSkeleton(): React.JSX.Element {
  return (
    <ul className="store-grid" aria-hidden="true">
      {Array.from({ length: SKELETON_CARDS }, (_, index) => (
        <StoreCardSkeleton key={index} />
      ))}
    </ul>
  )
}

/**
 * 商店条目的图标。
 *
 * ★ 后端的 `icon` 字段是 **`/api/v1/proxy?url=<encoded>`** —— 服务端替我们把图标从源站
 *   取回来（顺手套上配置里的 GitHub 代理），所以它是一条**本机后端上的相对路径**，
 *   必须按资源地址拼 `baseUrl` + `access_token`（与封面同一条路：lib/url.ts 的
 *   buildResourceUrl）。它**不是** http(s) 开头的，别按「像不像外链」判断 ——
 *   那样整店都会退成首字母兜底图。
 *   （上游 Flutter 端踩过同一处：他们的判据是 `endsWith('.svg')`，而 /api/v1/proxy
 *   结尾没有 .svg，于是全部 SVG 图标被当成位图、解码失败回退首字母。）
 *
 * 取不到就退到首字母兜底（与已装插件共用 PluginIconFallback）：图标是插件作者自己打包的，
 * 404 / 坏文件是常态，留一个破图比没有图更难看出「这个插件没图标」。
 */
function StoreIcon({ entry, name }: { entry: RegistryEntry; name: string }): React.JSX.Element {
  const [broken, setBroken] = useState(false)
  // token 变化（重新登录）后 URL 要跟着变，否则会 401。
  // 解构出两个字符串当依赖：resourceContext() 每次返回新对象，直接依赖它会每帧重算
  const { baseUrl, accessToken } = resourceContext()
  const src = useMemo(
    () => buildResourceUrl(entry.icon, { baseUrl, accessToken }),
    [entry.icon, baseUrl, accessToken]
  )

  useEffect(() => setBroken(false), [src])

  if (src && !broken) {
    return (
      <img
        className="plugin-icon"
        src={src}
        alt=""
        width={40}
        height={40}
        onError={() => setBroken(true)}
      />
    )
  }

  return <PluginIconFallback name={name} size={40} />
}
