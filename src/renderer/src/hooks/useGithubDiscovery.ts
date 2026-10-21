/**
 * 插件商店里「GitHub 发现」那一份来源的数据。
 *
 * 四件事都收在这里，界面只管画：
 *   1. **凭据**：Token 与 GitHub 代理都存在服务端（Token 是凭据、代理是前缀，两者互斥）。
 *      进页面先读一次 —— Token 决定「每小时 60 次」还是「5000 次」，也决定请求是否绕过代理；
 *   2. **翻页**：搜索 / 排序 / 刷新都会回到第 1 页，滚到底续下一页；被限流时不再往下翻；
 *   3. **搜索**：关键词既交给 GitHub（按仓库名 / 描述 / README 搜），也在本地按**插件名 /
 *      入口 / 作者 / owner-repo** 再比一遍核对过的卡片 —— 见下面 `known` 与副查询的说明。
 *      少了本地那一半，照着卡片上的名字搜是搜不到的；
 *   4. **失败**：主进程回的是 `{ ok: false, reason }`，这里原样留着 —— 界面按 reason 分派文案
 *      （Token 过期要人去改，限流等一会儿，网络问题去查代理）。
 *
 * ★ 为什么不在渲染层直接发请求：GitHub API 要 `User-Agent`（浏览器侧改不了的 forbidden
 *   header），而且一页要逐仓库核对清单与 release，几十个请求该由主进程那份缓存兜着。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  discoveryRowKey,
  matchesDiscoveryCardKeyword,
  matchesDiscoveryKeyword,
  rankDiscoveryPlugins,
  type DiscoveryFailure,
  type GithubDiscoveryPlugin,
  type GithubDiscoveryResult
} from '@shared/github-discovery'
import { getGithubDiscoveryToken, getGithubProxy, setGithubDiscoveryToken } from '@/api/endpoints'
import { useAuth } from '@/state/useAuth'

export interface GithubDiscoveryError {
  reason: DiscoveryFailure
  message: string
  retryAt?: number
}

export interface GithubDiscovery {
  plugins: GithubDiscoveryPlugin[]
  /** 这一页看了几个仓库（含被过滤的），供「已检查 N 个仓库」 */
  checked: number
  failures: Partial<Record<DiscoveryFailure, number>>
  /** GitHub 报的匹配总数（最多只到 1000） */
  total: number
  /** 结果不完整（翻到 1000 条上限，或中途被限流） */
  incomplete: boolean
  /** 被限流时可以再试的时间 */
  retryAt?: number

  loading: boolean
  loadingMore: boolean
  error: GithubDiscoveryError | null

  hasMore: boolean
  loadMore: () => void
  /** 重新读 Token / 代理，再从第 1 页强制重拉（服务端那份 5 分钟缓存不是这里的事） */
  refresh: () => void

  /** 服务器上保存的 Token（空串 = 匿名） */
  token: string
  credentialLoading: boolean
  /** Token / 代理读失败的原因（不影响匿名发现，只是少了一份凭据） */
  credentialError: string | null
  saveToken: (token: string) => Promise<void>
  /**
   * 重新从服务器读一次 Token（打开那个对话框时调）。
   *
   * ★ 手头那份是页面挂载时读的，可能早就过期了 —— 别的客户端改过、上一次保存其实没成功、
   *   或者当初就读取失败（那时会退回空串）。对话框里显示的必须是**服务器上此刻**的事实，
   *   否则就会出现「保存了，关掉再打开又是空的」这种无从判断的局面。
   * ★ 它只换 token，不动代理、也不让发现请求重跑（token 没变时连对象引用都不换）。
   */
  reloadToken: () => Promise<void>
}

interface Credential {
  token: string
  proxy: string
}

/**
 * 一页结果往哪儿放：
 *
 *   · `browse` / `more` —— **不带关键词**的那份列表（发现页上「逛」的那一条）；
 *   · `hits` / `hits-more` —— 当前关键词在 GitHub 那边的命中（顺序即 GitHub 的相关性顺序）；
 *   · `seed` —— 只为「认识这些卡片」拉的一页，不进任何列表（见副查询那段说明）。
 *
 * ★ 统计（已检查 / 总数 / 续页）只跟着**主查询**走：`seed` 是附带的一页，让它改这些量，
 *   「已检查 N 个仓库」会平白翻倍。
 */
type PageRole = 'browse' | 'more' | 'hits' | 'hits-more' | 'seed'

/**
 * 把新核对出来的卡片并进「认识的」那一份。
 *
 * 按行 key 去重：翻页、换关键词、换排序都可能把同一张再给一次，而**位置保持首次见到的顺序**
 * （列表不该因为又搜了一次就整体重排）。同一个 key 再来时用新数据替换 —— 版本、release 地址
 * 可能已经变了。
 */
function mergeDiscoveryCatalog(
  previous: GithubDiscoveryPlugin[],
  incoming: GithubDiscoveryPlugin[]
): GithubDiscoveryPlugin[] {
  if (incoming.length === 0) return previous
  const next = [...previous]
  const index = new Map(next.map((plugin, at) => [discoveryRowKey(plugin), at]))
  for (const plugin of incoming) {
    const key = discoveryRowKey(plugin)
    const at = index.get(key)
    if (at == null) {
      index.set(key, next.length)
      next.push(plugin)
    } else {
      next[at] = plugin
    }
  }
  return next
}

export function useGithubDiscovery(input: {
  /**
   * 这一屏要不要 GitHub 的卡片（选中了发现页，或「全部订阅源」的聚合里带着它）。
   * 为 false 时一个请求都不发。
   */
  active: boolean
  /** 已经防抖过的关键词（与订阅源那一份共用搜索框） */
  keyword: string
}): GithubDiscovery {
  const { active, keyword } = input
  const client = useAuth((state) => state.client)

  const [credential, setCredential] = useState<Credential | null>(null)
  const [credentialLoading, setCredentialLoading] = useState(false)
  const [credentialError, setCredentialError] = useState<string | null>(null)
  /** 让人为地重读一次凭据（刷新按钮 / 切回发现页） */
  const [credentialNonce, setCredentialNonce] = useState(0)

  /** 不带关键词的那份列表（发现页「逛」的那一条） */
  const [browse, setBrowse] = useState<GithubDiscoveryPlugin[]>([])
  /**
   * **认识的**所有卡片（本次打开商店以来核对过的，按行 key 去重）。
   *
   * ★ 为什么要有它：GitHub 只能按**仓库**搜，而用户看到的是清单里的插件名（仓库常叫
   *   `songloft-plugin-radio`、插件叫「电台时光」）。要按名字搜得到，就得把核对过的卡片
   *   留下来自己再比一遍 —— 见 `matchesDiscoveryKeyword`。
   */
  const [known, setKnown] = useState<GithubDiscoveryPlugin[]>([])
  /** 当前关键词在 GitHub 那边命中的行 key */
  const [hits, setHits] = useState<string[]>([])

  const [checked, setChecked] = useState(0)
  const [failures, setFailures] = useState<Partial<Record<DiscoveryFailure, number>>>({})
  const [total, setTotal] = useState(0)
  const [nextPage, setNextPage] = useState<number | undefined>(undefined)
  const [incomplete, setIncomplete] = useState(false)
  const [retryAt, setRetryAt] = useState<number | undefined>(undefined)
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<GithubDiscoveryError | null>(null)
  const [nonce, setNonce] = useState(0)

  /** 在途请求的序号：只认最新那一次（搜索词改得快时，后面的响应编号更大） */
  const generation = useRef(0)
  /** 只有点「刷新」这一次要越过主进程的清单缓存 */
  const forceRef = useRef(false)
  /**
   * 「不带关键词的那一页」已经拉过了吗（副查询，见下面那段说明）。
   *
   * 记成 ref 而不是 state：它只用来「别再拉第二次」，写进 state 会自己成为依赖、再触发一轮。
   * 排序不再是一个可选项（固定成一条优先级链，见 `rankDiscoveryPlugins`），
   * 所以一份就够 —— 以前按排序各拉一次，是因为不同排序下前 20 个仓库不是同一批。
   */
  const seeded = useRef(false)

  // ── 凭据 ────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!active || !client) return
    let cancelled = false
    setCredentialLoading(true)
    setCredentialError(null)
    // 先清掉旧凭据：否则下面那次发现会先用旧 Token 发一遍，等新 Token 回来再发一遍
    setCredential(null)
    void Promise.all([
      getGithubDiscoveryToken(client),
      // 代理读不到照样能发现（直连）：它不是这一页的前置条件
      getGithubProxy(client).catch(() => '')
    ])
      .then(([token, proxy]) => {
        if (cancelled) return
        setCredential({ token, proxy })
      })
      .catch((reason: unknown) => {
        if (cancelled) return
        setCredentialError(reason instanceof Error ? reason.message : '读取 GitHub Token 失败')
        // 读不到 Token 不必卡住整个发现：匿名也能查，只是配额少得多
        setCredential({ token: '', proxy: '' })
      })
      .finally(() => {
        if (!cancelled) setCredentialLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [active, client, credentialNonce])

  const applyPage = useCallback((result: GithubDiscoveryResult, role: PageRole): void => {
    if (!result.ok) return
    const { plugins: pagePlugins, ...rest } = result.page
    // 核对过的卡片一律记进「认识的」那一份：本地按插件名匹配的材料就是它
    setKnown((previous) => mergeDiscoveryCatalog(previous, pagePlugins))

    if (role === 'browse' || role === 'more') {
      setBrowse((previous) => (role === 'more' ? [...previous, ...pagePlugins] : pagePlugins))
    }
    if (role === 'hits' || role === 'hits-more') {
      setHits((previous) => {
        const keys = pagePlugins.map(discoveryRowKey)
        return role === 'hits-more' ? [...previous, ...keys] : keys
      })
    }
    if (role === 'seed') return

    const append = role === 'more' || role === 'hits-more'
    setChecked((previous) => (append ? previous + rest.checked : rest.checked))
    setFailures((previous) => {
      if (!append) return rest.failures
      const merged = { ...previous }
      for (const [reason, count] of Object.entries(rest.failures)) {
        const key = reason as DiscoveryFailure
        merged[key] = (merged[key] ?? 0) + (count ?? 0)
      }
      return merged
    })
    setTotal(rest.total)
    setNextPage(rest.nextPage)
    setIncomplete(rest.incomplete)
    setRetryAt(rest.retryAt)
    setError(null)
  }, [])

  const report = useCallback((result: GithubDiscoveryResult): void => {
    if (result.ok) return
    // 限流与 Token 失效都要把时间带出来：一句「失败了，稍后再试」等于没说
    setError({ reason: result.reason, message: result.message, retryAt: result.retryAt })
    if (result.retryAt) setRetryAt(result.retryAt)
  }, [])

  // ── 第 1 页（搜索词 / 排序 / 刷新 / 凭据变化都会回到这里）─────────────
  useEffect(() => {
    // 序号先加：凭据被清空 / 切走这一页时也要把在途请求作废（否则它回来会盖住新一轮的空列表）
    const current = ++generation.current
    if (!active || !credential) return
    const force = forceRef.current
    forceRef.current = false
    setLoading(true)
    // 上一轮可能正卡在续页上；它已经被作废，那个「续页中」的闸必须松开，否则再也翻不动
    setLoadingMore(false)
    // 换了一轮搜索：这一轮的「GitHub 命中」先清空（它只属于上一个关键词）
    setHits([])
    setChecked(0)
    setFailures({})
    setTotal(0)
    setNextPage(undefined)
    setIncomplete(false)
    setRetryAt(undefined)
    setError(null)

    const searching = keyword.trim() !== ''

    void window.songloft.github
      .discover({
        page: 1,
        search: keyword,
        proxy: credential.proxy,
        token: credential.token,
        force
      })
      .then((result) => {
        if (current !== generation.current) return
        report(result)
        applyPage(result, searching ? 'hits' : 'browse')
      })
      .catch((reason: unknown) => {
        if (current !== generation.current) return
        setError({
          reason: 'unavailable',
          message: reason instanceof Error ? reason.message : '加载 GitHub 发现失败'
        })
      })
      .finally(() => {
        if (current === generation.current) setLoading(false)
      })

    /*
     * ★ 副查询：**不带关键词的同一页**，整个会话只拉一次。
     *
     *   为什么非要它：GitHub 的仓库搜索只认仓库名 / 描述 / README，而卡片上写的是清单里的
     *   插件名 —— 仓库叫 `songloft-plugin-radio`、插件叫「电台时光」，用户照着卡片上的名字搜，
     *   GitHub 一句都匹配不上，界面于是显示「没有匹配的扩展」，可那一条明明就在列表里。
     *   清单只有核对过才知道，所以「按名字搜」只能发生在本地，而本地得有材料。
     *
     *   代价：这一页恰好就是不带关键词浏览时的那一页，清单在主进程按仓库缓存一小时 ——
     *   翻过一遍之后再搜基本不额外花配额。它也不进任何列表、不改统计（`seed`）。
     */
    if (searching && !seeded.current) {
      seeded.current = true
      void window.songloft.github
        .discover({
          page: 1,
          search: '',
          proxy: credential.proxy,
          token: credential.token,
          force: false
        })
        .then((result) => {
          if (current !== generation.current) return
          applyPage(result, 'seed')
        })
        // 这一页只是「让搜索更准」，失败了不影响主查询，安静收掉
        .catch(() => undefined)
    }
  }, [active, credential, keyword, nonce, report, applyPage])

  // ── 续页 ────────────────────────────────────────────────────────────────
  const loadMore = useCallback((): void => {
    if (!credential || loading || loadingMore || !nextPage) return
    const current = generation.current
    const searching = keyword.trim() !== ''
    setLoadingMore(true)
    void window.songloft.github
      .discover({
        page: nextPage,
        search: keyword,
        proxy: credential.proxy,
        token: credential.token,
        force: false
      })
      .then((result) => {
        if (current !== generation.current) return
        report(result)
        applyPage(result, searching ? 'hits-more' : 'more')
      })
      .catch((reason: unknown) => {
        if (current !== generation.current) return
        setError({
          reason: 'unavailable',
          message: reason instanceof Error ? reason.message : '加载 GitHub 发现失败'
        })
      })
      .finally(() => {
        if (current === generation.current) setLoadingMore(false)
      })
  }, [applyPage, credential, keyword, loading, loadingMore, nextPage, report])

  const refresh = useCallback((): void => {
    forceRef.current = true
    /*
     * 「刷新」= 手头的卡片一概不信（作者刚发过版，清单可能已经变了）：三份列表一起清，
     * 连「副查询已经拉过」这件事也忘掉 —— 下一次搜索要重新核对一遍。
     */
    setBrowse([])
    setKnown([])
    setHits([])
    seeded.current = false
    setCredentialNonce((value) => value + 1)
    setNonce((value) => value + 1)
  }, [])

  const saveToken = useCallback(
    async (next: string): Promise<void> => {
      if (!client) throw new Error('还没有连接服务器，无法保存 GitHub Token')
      const saved = await setGithubDiscoveryToken(client, next)
      /*
       * ★ 回了 2xx 却把 Token 吞掉的情况必须当场说清楚，不能当成功：反代把 PUT 改写成 GET、
       *   中间那层把请求体丢掉，都会得到「200 + 一个空 token」。用户那边的表现是「保存了，
       *   关掉再打开又是空的」—— 与其让他反复试，不如在这里就报错。
       */
      if (next.trim() && !saved) {
        throw new Error('服务器没有保存这个 Token（接口回了空值），请确认后端版本后重试')
      }
      // 只换 Token、不重读代理：代理那一半没变，再读一次只会慢一拍
      setCredential((previous) => ({ token: saved, proxy: previous?.proxy ?? '' }))
    },
    [client]
  )

  const reloadToken = useCallback(async (): Promise<void> => {
    if (!client) return
    try {
      const token = await getGithubDiscoveryToken(client)
      setCredential((previous) => {
        // 还没读完（凭据那段 effect 正在跑）或读到的与手头一致：什么都不用改
        if (!previous || previous.token === token) return previous
        return { ...previous, token }
      })
    } catch {
      /* 读不到就保留手头这份：对话框里那句「读取失败」会说明原因 */
    }
  }, [client])

  /**
   * 这一屏要画的卡片。
   *
   * · 没有关键词：就是「逛」的那一份（GitHub 给的那一页，再按固定优先级排一次）；
   * · 有关键词：**GitHub 命中的**在前，接着是**本地比出来的**那些（插件名 / 入口 / 作者 /
   *   `owner/repo`，见 `matchesDiscoveryKeyword`），整份再排一次。
   *
   * ★ 两半缺一不可：GitHub 那一半按仓库字段搜，能把还没核对过的仓库带进来；本地那一半才认
   *   卡片上写着的插件名。只留任一半都会出现「明明在列表里，搜名字却搜不到」。
   * ★ GitHub 命中那一半还要**再复核一遍**：它也把 README 算进匹配范围，于是「README 里提过
   *   一句」的仓库会混进来（搜「知音」，几个写着「可灌入知音插件」的仓库全被带了出来），
   *   而卡片上根本没有那两个字。卡上没写的词不该成为它出现在结果里的理由 ——
   *   见 `matchesDiscoveryCardKeyword`（那份判据比全目录匹配多认一条清单描述）。
   * ★ 最后统一过一遍 `rankDiscoveryPlugins`：GitHub 给的顺序只有「相关性」这一个维度，
   *   而列表要的是「名字最像的 → 社区最认的 → 最近还在动的」这条固定链条。
   */
  const plugins = useMemo(() => {
    if (keyword.trim() === '') return rankDiscoveryPlugins(browse, '')
    const byKey = new Map(known.map((plugin) => [discoveryRowKey(plugin), plugin]))
    const hitKeys = new Set(hits)
    const fromGithub = [...hitKeys]
      .map((key) => byKey.get(key))
      .filter((plugin): plugin is GithubDiscoveryPlugin => plugin != null)
      .filter((plugin) => matchesDiscoveryCardKeyword(plugin, keyword))
    const fromLocal = known.filter(
      (plugin) => !hitKeys.has(discoveryRowKey(plugin)) && matchesDiscoveryKeyword(plugin, keyword)
    )
    return rankDiscoveryPlugins([...fromGithub, ...fromLocal], keyword)
  }, [browse, known, hits, keyword])

  return {
    plugins,
    checked,
    failures,
    total,
    incomplete,
    retryAt,
    /**
     * ★ 把「读凭据」也算进 loading：切过来的第一帧凭据还没读回来，若这里报 false，
     *   界面会先闪一下「没有发现可用的社区扩展」，再变成骨架屏。
     */
    loading: loading || credentialLoading,
    loadingMore,
    error,
    hasMore: nextPage != null,
    loadMore,
    refresh,
    token: credential?.token ?? '',
    credentialLoading,
    credentialError,
    saveToken,
    reloadToken
  }
}
