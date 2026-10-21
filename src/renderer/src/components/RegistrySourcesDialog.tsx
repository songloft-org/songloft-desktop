/**
 * 「管理订阅源」对话框 —— 扩展商店里的列表从哪些源来。
 *
 * 界面分两块，因为这两块**可以做的操作不一样**：
 *   * 上方**固定卡片**：`GitHub 发现`。它没有注册表地址（按 GitHub 上的 topic 搜仓库，
 *     再逐个核对清单与 release，见 hooks/useGithubDiscovery），所以既不能改地址、
 *     也不能删掉 —— 只能开关，以及配一个 Token。**固定显示、不可删除**是刻意的：
 *     它不是某个可以换掉的第三方源，而是商店内置的另一半来源。
 *   * 下方**源列表**：URL 源（`GET|PUT /settings/plugin-registries`）。地址就是身份，
 *     可以增删、停用、改名、配私有源 Token。
 *
 * 后端只有「整表读 / 整表写」两个口子，没有单条增删改，所以 URL 源这一半是**草稿表**：
 * 所有编辑都先在本地改，点保存才整份 PUT 回去。于是「删一个源」= 保存时不带它、
 * 「停用」= `enabled: false`、「改地址」= 换掉那一行的 url。
 *
 * 三条必须让用户看见的语义（都写进了界面文案，不然很容易踩）：
 *   1. **地址就是身份**（后端没有 id，按 URL 匹配来源、按 URL 查它自己的 token），
 *      所以改地址在效果上等于「删掉旧源、新增一个源」，重复地址也必须拦住；
 *   2. **Token 非空 = 私有源**：该源的条目下载时走 `Authorization: Bearer`；
 *   3. **GitHub 的 Token 不回填**：它与其他源的 Token 存在不同的地方、读取失败也不该
 *      拖垮整张表，所以输入框永远是空的，只在占位符里露出「已配置（末尾 abcd）」。
 */
import { useCallback, useEffect, useState } from 'react'

import { getGithubDiscoveryToken, setGithubDiscoveryToken } from '@/api/endpoints'
import { getPluginRegistries, updatePluginRegistries, type RegistrySource } from '@/api/plugins'
import { GITHUB_DISCOVERY_NAME } from '@shared/ipc'
import { IconAlert, IconLoader, IconPlus, IconStore, IconTrash } from './Icons'
import { Modal } from './Modal'
import { Switch } from './primitives'
import { useAuth } from '@/state/useAuth'
import { useSettings } from '@/state/useSettings'
import { toast } from '@/state/useToasts'

export interface RegistrySourcesDialogProps {
  onClose: () => void
  /**
   * 保存成功。
   *
   * 商店那份列表此刻已经过期了：源的增删改都会让聚合结果变（后端也会顺手作废它的缓存），
   * 所以调用方要重拉一次，而不是把旧的留在屏幕上。
   */
  onSaved: () => void
}

/** 草稿表里的一行（只有 URL 源 —— GitHub 那一档是上方那张固定卡片，不进这张表） */
type DraftRow = { url: string; name: string; enabled: boolean; token: string }

/** 地址必须是 http(s)：后端要拿它去 fetch，别的写法只会得到一条「拉取注册表失败」 */
function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim())
}

/** 一行在界面上怎么称呼（无名时退回地址） */
function rowLabel(row: DraftRow): string {
  return row.name.trim() || row.url.trim() || '未命名'
}

/** 保存前的整表检查。返回第一处问题（没有则 null）——一次只说一条，说了就改，不必看清单 */
function findProblem(rows: DraftRow[]): string | null {
  const seen = new Set<string>()
  for (const row of rows) {
    const url = row.url.trim()
    if (!isHttpUrl(url)) {
      return `「${rowLabel(row)}」的地址要以 http:// 或 https:// 开头`
    }
    if (seen.has(url)) return `地址重复：${url}`
    seen.add(url)
  }
  return null
}

/**
 * 一眼就不像 GitHub Token 的写法，拦在保存之前。
 *
 * ★ 只拦**明显不对**的那几种（带空白、太短、混了别的字符）。合法的判定只有 GitHub 自己能做，
 *   而校验写太严会把 fine-grained Token（`github_pat_…`，比老式的长得多）一起拦掉 ——
 *   那正是最需要人配 Token 的那类用户。留空表示「不改动」，不是错误。
 */
function checkGithubToken(value: string): string | null {
  const token = value.trim()
  if (!token) return null
  if (/\s/.test(token)) return 'Token 里不能有空格或换行（粘贴时容易带上）'
  if (!/^[A-Za-z0-9_]{20,}$/.test(token)) {
    return '这不像 GitHub Token：应以 ghp_ 或 github_pat_ 开头，且只含字母、数字与下划线'
  }
  return null
}

export function RegistrySourcesDialog({
  onClose,
  onSaved
}: RegistrySourcesDialogProps): React.JSX.Element {
  const client = useAuth((state) => state.client)
  const patchSettings = useSettings((state) => state.patch)

  /** null = 还在读；读到之后即便是空数组也代表「一个 URL 源都没有」 */
  const [rows, setRows] = useState<DraftRow[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  /** 校验 / 保存失败的原因，显示在列表上方 */
  const [problem, setProblem] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  /* ── GitHub 那张固定卡片 ── */
  /** 草稿：开关与 Token 都和 URL 源一起在「保存」时才落地 */
  const [discoveryEnabled, setDiscoveryEnabled] = useState(true)
  /** 服务端上的 Token（null = 还没读到 / 读失败；空串 = 没配置） */
  const [serverToken, setServerToken] = useState<string | null>(null)
  const [tokenError, setTokenError] = useState<string | null>(null)
  /**
   * 用户新填的 Token。**不回填**，见文件头第 3 条。
   *
   * ★ 只有「填一个新的」这一条路：卡片上没有清除按钮 —— 留空就是不改动，要换就覆盖。
   *   清空凭据是个不常做且容易误触的动作，摆在这里反而让「保存」变成一件有风险的事。
   */
  const [tokenDraft, setTokenDraft] = useState('')
  /** Token 的格式问题：显示在输入框下面，不混进整表那条错误里 */
  const [tokenProblem, setTokenProblem] = useState<string | null>(null)

  /* 添加区（只加 URL 源：GitHub 那一档固定存在，加不出第二个） */
  const [draftName, setDraftName] = useState('')
  const [draftUrl, setDraftUrl] = useState('')

  const load = useCallback((): void => {
    if (!client) return
    setRows(null)
    setLoadError(null)
    setTokenError(null)
    setTokenProblem(null)
    setServerToken(null)
    setTokenDraft('')
    /*
     * 两张表一起读：URL 源在服务端，GitHub 那一档的开关在本地设置。
     * Token 单独一路读，**失败不阻断**：Token 读不到只影响占位符里那句话，
     * 而整张表读不到就什么都改不了 —— 两件事的重量差得远。
     */
    void Promise.all([
      getPluginRegistries(client),
      getGithubDiscoveryToken(client).then(
        (token) => token,
        (reason: unknown) => {
          setTokenError(reason instanceof Error ? reason.message : '读取 GitHub Token 失败')
          return null
        }
      )
    ])
      .then(([list, token]) => {
        setServerToken(token)
        setDiscoveryEnabled(useSettings.getState().settings.githubDiscovery.enabled)
        setRows(
          list.map((source: RegistrySource) => ({
            url: source.url,
            name: source.name,
            enabled: source.enabled,
            token: source.token
          }))
        )
      })
      .catch((reason: unknown) => {
        setLoadError(reason instanceof Error ? reason.message : '订阅源读取失败')
      })
  }, [client])

  useEffect(() => {
    load()
  }, [load])

  const updateRow = (index: number, next: Partial<DraftRow>): void => {
    setProblem(null)
    setRows((list) =>
      list ? list.map((row, i) => (i === index ? { ...row, ...next } : row)) : list
    )
  }

  const removeAt = (index: number): void => {
    setProblem(null)
    setRows((list) => (list ? list.filter((_, i) => i !== index) : list))
  }

  /**
   * 新增一行。
   *
   * 不做「先加一行空白行再填」：空白行既是校验的麻烦，也会在列表里留下半截状态。
   * 地址先在这里校验一次，不合格就地拦下 —— 用户这时还看得见自己刚敲进去的东西。
   */
  const addDraft = (): void => {
    if (!rows) return
    const url = draftUrl.trim()
    if (!isHttpUrl(url)) {
      setProblem('订阅源地址要以 http:// 或 https:// 开头')
      return
    }
    if (rows.some((row) => row.url.trim() === url)) {
      setProblem('这个地址已经在列表里了：地址是订阅源的身份，不能重复')
      return
    }
    setRows([...rows, { url, name: draftName.trim(), enabled: true, token: '' }])
    setDraftName('')
    setDraftUrl('')
    setProblem(null)
  }

  /**
   * 保存。
   *
   * 三件事各有一个落点（服务端订阅源 / 服务端 Token / 本地偏好），**逐个做、逐个记账**：
   * 任何一步失败都不回退已经成功的那几步（那两个服务端接口没有事务），但必须把「哪一步没成」
   * 说清楚 —— 笼统一句「保存失败」会让人再点一次，而对已经生效的那部分又是一次无谓的覆盖。
   */
  const save = (): void => {
    if (!client || !rows) return

    const found = findProblem(rows)
    if (found) {
      setProblem(found)
      return
    }
    const tokenIssue = checkGithubToken(tokenDraft)
    if (tokenIssue) {
      setTokenProblem(tokenIssue)
      return
    }

    const nextToken = tokenDraft.trim()
    setSaving(true)
    setProblem(null)
    setTokenProblem(null)
    void (async () => {
      const failures: string[] = []

      try {
        // 整表 PUT 之前统一 trim：地址前后带空格是最常见的粘贴事故，而后端会拿它当身份比对
        await updatePluginRegistries(
          client,
          rows.map((row) => ({
            url: row.url.trim(),
            name: row.name.trim(),
            enabled: row.enabled,
            token: row.token.trim()
          }))
        )
      } catch (reason) {
        failures.push(`订阅源没有保存：${reason instanceof Error ? reason.message : '未知错误'}`)
      }

      /*
       * 只有**填了**才写：留空 = 不动服务端那份（不是「清除」）。卡片上也没有清除入口 ——
       * 凭据能不能删，是服务端那一侧的事，不该由「点保存」顺带决定。
       */
      if (nextToken) {
        try {
          const stored = await setGithubDiscoveryToken(client, nextToken)
          /*
           * 回了 2xx 却把 Token 吞掉（反代把 PUT 改写成 GET 之类）必须当场说清楚：
           * 用户那边的表现是「保存了，再打开又是空的」，反复试也试不出来。
           */
          if (!stored) failures.push('服务器没有保存 GitHub Token（接口回了空值）')
          else setServerToken(stored)
        } catch (reason) {
          failures.push(
            `GitHub Token 没有保存：${reason instanceof Error ? reason.message : '未知错误'}`
          )
        }
      }

      try {
        await patchSettings({ githubDiscovery: { enabled: discoveryEnabled } })
      } catch (reason) {
        failures.push(`本地设置没有保存：${reason instanceof Error ? reason.message : '未知错误'}`)
      }

      setSaving(false)
      if (failures.length > 0) {
        setProblem(`${failures.join('；')}（已经生效的部分不会回退）`)
        return
      }

      onSaved()
      toast(`已保存 ${rows.length} 个订阅源`, 'success')
      onClose()
    })()
  }

  /** Token 那一格输入框的提示：几种状态都写在里面，省得另外摆一行说明 */
  const tokenPlaceholder = (): string => {
    if (tokenDraft.trim()) return '将保存为新的 GitHub Token'
    if (tokenError) return `读取失败（${tokenError}），填一个即可覆盖`
    if (serverToken) return `已配置（末尾 ${serverToken.slice(-4)}），留空表示不修改`
    return '未配置：粘贴一个 GitHub Token，留空 = 匿名访问'
  }

  /** 卡片右上角那枚状态徽标 */
  const tokenBadge = (): { text: string; accent: boolean } => {
    if (tokenDraft.trim()) return { text: 'Token 待保存', accent: true }
    if (tokenError) return { text: 'Token 读取失败', accent: false }
    if (serverToken) return { text: `Token 已配置 · 末尾 ${serverToken.slice(-4)}`, accent: true }
    return { text: '未配置 Token', accent: false }
  }

  const body = (): React.ReactNode => {
    if (loadError) {
      return (
        <>
          <div className="probe-result" data-state="error">
            <IconAlert size={15} />
            <span>{loadError}</span>
          </div>
          <button
            type="button"
            className="btn"
            data-size="sm"
            onClick={load}
            style={{ alignSelf: 'flex-start' }}
          >
            重试
          </button>
        </>
      )
    }

    if (!rows) {
      return (
        <div className="empty">
          <IconLoader size={22} />
        </div>
      )
    }

    const badge = tokenBadge()

    return (
      <>
        {problem ? (
          <div className="probe-result" data-state="error">
            <IconAlert size={15} />
            <span>{problem}</span>
          </div>
        ) : null}

        {/*
          ★ 固定卡片：只开关、不增删。
            它与下面那些源**并列**（同一栏里的另一种来源），但操作少一档是刻意的 ——
            没有注册表地址就没有「换一个地址」这回事，删掉它也没有「再加回来」的语义
            （它不属于任何第三方源）。把它做成可删的行，用户会以为删了就能腾掉什么。
        */}
        <div className="source-pinned" data-enabled={discoveryEnabled}>
          <Switch
            checked={discoveryEnabled}
            ariaLabel={`启用 ${GITHUB_DISCOVERY_NAME}`}
            onChange={(next) => {
              setProblem(null)
              setDiscoveryEnabled(next)
            }}
          />

          <div className="source-fields">
            <div className="source-pinned-head">
              <span className="source-pinned-title">{GITHUB_DISCOVERY_NAME}</span>
              <span className="badge">{discoveryEnabled ? '参与聚合搜索' : '已停用'}</span>
              <span className="badge" data-tone={badge.accent ? 'accent' : undefined}>
                {badge.text}
              </span>
            </div>

            <input
              className="input"
              value={tokenDraft}
              placeholder={tokenPlaceholder()}
              spellCheck={false}
              autoComplete="off"
              aria-label="GitHub Token"
              onChange={(event) => {
                setTokenProblem(null)
                setTokenDraft(event.target.value)
              }}
            />

            {tokenProblem ? (
              <p className="source-pinned-error" role="alert">
                {tokenProblem}
              </p>
            ) : null}

            <p className="field-hint" style={{ margin: 0 }}>
              {
                '这一档没有订阅源地址：按 GitHub 上的 songloft-plugin topic 搜仓库，再逐个核对清单与 release。'
              }
              {'匿名访问每小时只有 60 次（一页发现就可能用光），配上 Token 提到 5000 次；'}
              {
                'Token 保存在当前连接的服务器上，连接它的客户端共用一份，出于安全不回填、只显示末尾四位。'
              }
            </p>
          </div>
        </div>

        {rows.length === 0 ? (
          <div className="probe-result">
            <IconStore size={15} />
            <span>
              一个 URL 源都没有 —— 商店只会显示「{GITHUB_DISCOVERY_NAME}」那一半。在下面加一个。
            </span>
          </div>
        ) : null}

        {rows.map((row, index) => (
          /**
           * key 用**下标**而不是 url：这里每一行都是「位置上的那一行」（顺序即聚合优先级、
           * url 是随打随变的草稿）。用 url 当 key 的话，地址输入框里每敲一个字符都会换一次
           * key，React 于是卸载重建整个输入框 —— 焦点和光标位置全丢，一个字都打不进去。
           */
          <div className="source-row" key={index}>
            <Switch
              checked={row.enabled}
              ariaLabel={`启用 ${rowLabel(row)}`}
              onChange={(next) => updateRow(index, { enabled: next })}
            />

            <div className="source-fields">
              <input
                className="input"
                value={row.name}
                placeholder="名称（可留空）"
                spellCheck={false}
                aria-label="订阅源名称"
                onChange={(event) => updateRow(index, { name: event.target.value })}
              />
              <input
                className="input"
                value={row.url}
                placeholder="订阅源地址，如 https://example.com/registry.json"
                spellCheck={false}
                aria-label="订阅源地址"
                onChange={(event) => updateRow(index, { url: event.target.value })}
              />
              <input
                className="input"
                value={row.token}
                placeholder="私有源 Token（公开源留空）"
                spellCheck={false}
                autoComplete="off"
                aria-label="订阅源 Token"
                onChange={(event) => updateRow(index, { token: event.target.value })}
              />
            </div>

            <button
              type="button"
              className="icon-btn"
              data-tip="移除这个源"
              aria-label={`移除 ${rowLabel(row)}`}
              onClick={() => removeAt(index)}
            >
              <IconTrash size={16} />
            </button>
          </div>
        ))}

        <div className="source-add">
          <input
            className="input"
            value={draftName}
            placeholder="新源的名称（可留空）"
            spellCheck={false}
            aria-label="新订阅源名称"
            onChange={(event) => setDraftName(event.target.value)}
          />
          <input
            className="input"
            value={draftUrl}
            placeholder="新源的地址，如 https://example.com/registry.json"
            spellCheck={false}
            aria-label="新订阅源地址"
            onChange={(event) => setDraftUrl(event.target.value)}
            onKeyDown={(event) => {
              // 回车=添加：这一行本来就是「填完就走」，再挪去点按钮是多余的一步
              if (event.key === 'Enter') addDraft()
            }}
          />
          <button type="button" className="btn" data-size="sm" onClick={addDraft}>
            <IconPlus size={14} />
            添加
          </button>
        </div>

        <p className="field-hint">
          地址就是这个源的身份（后端靠它匹配条目、查它自己的 Token），改地址等于换一个源。 Token
          非空的源按私有源处理：它的条目下载时会带上 Bearer 认证。
          停用的源不参与「全部订阅源」的聚合搜索， 但单独选中它仍然能看。
        </p>
      </>
    )
  }

  return (
    <Modal
      title="管理订阅源"
      size="wide"
      onClose={onClose}
      // 这是一张没保存就白填的表单，点遮罩关掉太容易误伤
      closeOnBackdrop={false}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="btn"
            data-variant="primary"
            disabled={saving || !rows}
            onClick={save}
          >
            {saving ? <IconLoader size={15} /> : null}
            保存
          </button>
        </>
      }
    >
      {body()}
    </Modal>
  )
}
