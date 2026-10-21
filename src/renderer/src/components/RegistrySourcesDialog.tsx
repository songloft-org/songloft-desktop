/**
 * 「管理订阅源」对话框 —— 扩展商店里的列表从哪些源来。
 *
 * 两种源在**同一张表**里管理（开关 / 改名 / 移除 / Token 都一样），只是取值的地方不同：
 *   * URL 源：服务端 `GET|PUT /settings/plugin-registries`，地址就是身份；
 *   * **GitHub 发现**：没有注册表地址 —— 由主进程按 `topic:songloft-plugin` 搜 GitHub，
 *     再逐个核对清单与 release（见 hooks/useGithubDiscovery）。它**不进**服务端那份
 *     registries（后端会拿 `url` 去 fetch），所以「在不在列表里 / 开没开 / 叫什么」
 *     落在本地设置（`AppSettings.githubDiscovery`），Token 仍在服务端
 *     （`/settings/github-discovery-token`，同一台服务器上的客户端共用一份）。
 *
 * 后端只有「整表读 / 整表写」两个口子，没有单条增删改，所以这里是一张**草稿表**：
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
import { GITHUB_DISCOVERY_NAME, type GithubDiscoverySource } from '@shared/ipc'
import {
  IconAlert,
  IconClose,
  IconLoader,
  IconPlus,
  IconRefresh,
  IconStore,
  IconTrash
} from './Icons'
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

/**
 * 草稿表里的一行。
 *
 * 两种源在这一层是**同一种东西**（有名字、有开关、能移除），差别只有「地址与 Token 从哪儿来」——
 * 差别收在 `kind` 里，界面就能按同一套结构画，用户也就不必在两处学两套操作。
 */
type DraftRow =
  | { kind: 'url'; url: string; name: string; enabled: boolean; token: string }
  | { kind: 'github'; name: string; enabled: boolean }

/** 地址必须是 http(s)：后端要拿它去 fetch，别的写法只会得到一条「拉取注册表失败」 */
function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim())
}

/** 一行在界面上怎么称呼（无名时退回地址，GitHub 那行退回默认名） */
function rowLabel(row: DraftRow): string {
  if (row.name.trim()) return row.name.trim()
  return row.kind === 'github' ? GITHUB_DISCOVERY_NAME : row.url.trim() || '未命名'
}

/** 保存前的整表检查。返回第一处问题（没有则 null）——一次只说一条，说了就改，不必看清单 */
function findProblem(rows: DraftRow[]): string | null {
  const seen = new Set<string>()
  for (const row of rows) {
    if (row.kind !== 'url') continue
    const url = row.url.trim()
    if (!isHttpUrl(url)) {
      return `「${rowLabel(row)}」的地址要以 http:// 或 https:// 开头`
    }
    if (seen.has(url)) return `地址重复：${url}`
    seen.add(url)
  }
  return null
}

/** GitHub 那一行的「地址」格：它没有注册表文件，写清楚它在搜什么 */
const GITHUB_ADDRESS = 'github.com · topic:songloft-plugin'

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

  /** 服务端上的 GitHub Token（null = 还没读到 / 读失败；空串 = 没配置） */
  const [serverToken, setServerToken] = useState<string | null>(null)
  const [tokenError, setTokenError] = useState<string | null>(null)
  /** 用户新填的 Token。**不回填**，见文件头第 3 条 */
  const [tokenDraft, setTokenDraft] = useState('')
  /** 明确要清掉服务端那份（与「留空 = 不改」区分开） */
  const [tokenCleared, setTokenCleared] = useState(false)

  /* 添加区：先选类型，再填该类型用得上的那几格 */
  const [addKind, setAddKind] = useState<'url' | 'github'>('url')
  const [draftName, setDraftName] = useState('')
  const [draftUrl, setDraftUrl] = useState('')

  const load = useCallback((): void => {
    if (!client) return
    setRows(null)
    setLoadError(null)
    setTokenError(null)
    setServerToken(null)
    setTokenDraft('')
    setTokenCleared(false)
    /*
     * 两张表一起读：订阅源在服务端，GitHub 那条「在不在 / 开没开」在本地设置。
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
        const next: DraftRow[] = list.map((source: RegistrySource) => ({
          kind: 'url',
          url: source.url,
          name: source.name,
          enabled: source.enabled,
          token: source.token
        }))
        /*
         * GitHub 那一行排在最后：它不参与聚合顺序（后端那份表才有先后），
         * 放在末尾既不会打乱用户已有的源，也符合「另一类来源」的直觉。
         */
        const discovery = useSettings.getState().settings.githubDiscovery
        if (discovery.present) {
          next.push({ kind: 'github', name: discovery.name, enabled: discovery.enabled })
        }
        setRows(next)
      })
      .catch((reason: unknown) => {
        setLoadError(reason instanceof Error ? reason.message : '订阅源读取失败')
      })
  }, [client])

  useEffect(() => {
    load()
  }, [load])

  const updateRow = (index: number, change: (row: DraftRow) => DraftRow): void => {
    setProblem(null)
    setRows((list) => (list ? list.map((row, i) => (i === index ? change(row) : row)) : list))
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
    if (addKind === 'github') {
      if (rows.some((row) => row.kind === 'github')) {
        setProblem(`「${GITHUB_DISCOVERY_NAME}」已经在列表里了`)
        return
      }
      setRows([...rows, { kind: 'github', name: draftName.trim(), enabled: true }])
      setDraftName('')
      setProblem(null)
      return
    }

    const url = draftUrl.trim()
    if (!isHttpUrl(url)) {
      setProblem('订阅源地址要以 http:// 或 https:// 开头')
      return
    }
    if (rows.some((row) => row.kind === 'url' && row.url.trim() === url)) {
      setProblem('这个地址已经在列表里了：地址是订阅源的身份，不能重复')
      return
    }
    setRows([...rows, { kind: 'url', url, name: draftName.trim(), enabled: true, token: '' }])
    setDraftName('')
    setDraftUrl('')
    setProblem(null)
  }

  /**
   * 保存。
   *
   * 三件事各有一个落点（服务端订阅源 / 服务端 Token / 本地偏好），**逐个做、逐个记账**：
   * 任何一步失败都不回退已经成功的那几步（后端那两个接口没有事务），但必须把「哪一步没成」
   * 说清楚 —— 笼统一句「保存失败」会让人再点一次，而对已经生效的那部分又是一次无谓的覆盖。
   */
  const save = (): void => {
    if (!client || !rows) return
    const found = findProblem(rows)
    if (found) {
      setProblem(found)
      return
    }

    const urlRows = rows.filter((row) => row.kind === 'url')
    const githubRow = rows.find(
      (row): row is Extract<DraftRow, { kind: 'github' }> => row.kind === 'github'
    )
    /* 删掉之后也要把开关与名字记下来：下次加回来时还是用户上次的意思 */
    const previous = useSettings.getState().settings.githubDiscovery
    const nextDiscovery: GithubDiscoverySource = {
      present: githubRow != null,
      enabled: githubRow ? githubRow.enabled : previous.enabled,
      name: githubRow ? githubRow.name.trim() : previous.name
    }
    const nextToken = tokenCleared ? '' : tokenDraft.trim()

    setSaving(true)
    setProblem(null)
    void (async () => {
      const failures: string[] = []

      try {
        // 整表 PUT 之前统一 trim：地址前后带空格是最常见的粘贴事故，而后端会拿它当身份比对
        await updatePluginRegistries(
          client,
          urlRows.map((row) => ({
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
       * ★ 条件必须带上 `tokenCleared`：清除 Token 就是**保存空串**，只看 `nextToken` 的话
       *   这条分支会被跳过 —— 界面显示「保存后清除」，实际什么都没发生。
       */
      if (tokenCleared || nextToken) {
        try {
          const stored = await setGithubDiscoveryToken(client, nextToken)
          if (tokenCleared) {
            // 清除：服务器回空串才算成功（回了一个值说明它没照做）
            if (stored) failures.push('GitHub Token 没有清除（服务器仍然返回了一个值）')
            else setServerToken('')
          } else if (!stored) {
            /*
             * 回了 2xx 却把 Token 吞掉（反代把 PUT 改写成 GET 之类）必须当场说清楚：
             * 用户那边的表现是「保存了，再打开又是空的」，反复试也试不出来。
             */
            failures.push('服务器没有保存 GitHub Token（接口回了空值）')
          } else {
            setServerToken(stored)
          }
        } catch (reason) {
          failures.push(
            `GitHub Token 没有保存：${reason instanceof Error ? reason.message : '未知错误'}`
          )
        }
      }

      try {
        await patchSettings({ githubDiscovery: nextDiscovery })
      } catch (reason) {
        failures.push(`本地设置没有保存：${reason instanceof Error ? reason.message : '未知错误'}`)
      }

      setSaving(false)
      if (failures.length > 0) {
        setProblem(`${failures.join('；')}（已经生效的部分不会回退）`)
        return
      }

      onSaved()
      toast(
        githubRow
          ? `已保存 ${urlRows.length} 个订阅源 +「${rowLabel(githubRow)}」`
          : `已保存 ${urlRows.length} 个订阅源`,
        'success'
      )
      onClose()
    })()
  }

  /** GitHub 那一格输入框的提示：三种状态都写在里面，省得另外摆一行说明 */
  const tokenPlaceholder = (): string => {
    if (tokenCleared) return '保存后会清除 Token（想改成新的就直接填）'
    if (tokenDraft.trim()) return '将保存为新的 GitHub Token'
    if (tokenError) return `读取失败（${tokenError}），填一个即可覆盖`
    if (serverToken) return `已配置（末尾 ${serverToken.slice(-4)}），留空表示不修改`
    return 'GitHub Token（留空 = 匿名，每小时只有 60 次）'
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

    const hasGithub = rows.some((row) => row.kind === 'github')

    return (
      <>
        {problem ? (
          <div className="probe-result" data-state="error">
            <IconAlert size={15} />
            <span>{problem}</span>
          </div>
        ) : null}

        {rows.length === 0 ? (
          <div className="probe-result">
            <IconStore size={15} />
            <span>
              一个订阅源都没有 —— 插件商店会是空的。在下面加一个（也可以加「GitHub 发现」）。
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
              onChange={(next) => updateRow(index, (current) => ({ ...current, enabled: next }))}
            />

            <div className="source-fields">
              <input
                className="input"
                value={row.name}
                /*
                 * 留空的含义两种源不一样，所以提示语也得跟着变：URL 源会退回显示地址本身
                 * （「这到底是哪个源」全靠那串地址认），而 GitHub 那一档没有地址可退回。
                 */
                placeholder={
                  row.kind === 'github'
                    ? `名称（可留空，默认「${GITHUB_DISCOVERY_NAME}」）`
                    : '名称（可留空）'
                }
                spellCheck={false}
                aria-label="订阅源名称"
                onChange={(event) =>
                  updateRow(index, (current) => ({ ...current, name: event.target.value }))
                }
              />

              {row.kind === 'url' ? (
                <input
                  className="input"
                  value={row.url}
                  placeholder="订阅源地址，如 https://example.com/registry.json"
                  spellCheck={false}
                  aria-label="订阅源地址"
                  onChange={(event) =>
                    updateRow(index, (current) =>
                      current.kind === 'url' ? { ...current, url: event.target.value } : current
                    )
                  }
                />
              ) : (
                /*
                 * GitHub 那一行没有地址可填，但**这一格不能少**：少了之后它的 Token 会顶到
                 * 地址的位置上，两种源的行看起来就不是一套东西了。只读框写清它在搜什么。
                 */
                <input
                  className="input"
                  value={GITHUB_ADDRESS}
                  readOnly
                  aria-label="订阅源地址"
                  title="「GitHub 发现」没有注册表文件：按 topic 搜 GitHub，再逐个核对清单与 release"
                  style={{ color: 'var(--text-3)' }}
                />
              )}

              {row.kind === 'url' ? (
                <input
                  className="input"
                  value={row.token}
                  placeholder="私有源 Token（公开源留空）"
                  spellCheck={false}
                  autoComplete="off"
                  aria-label="订阅源 Token"
                  onChange={(event) =>
                    updateRow(index, (current) =>
                      current.kind === 'url' ? { ...current, token: event.target.value } : current
                    )
                  }
                />
              ) : (
                <input
                  className="input"
                  value={tokenDraft}
                  placeholder={tokenPlaceholder()}
                  spellCheck={false}
                  autoComplete="off"
                  aria-label="GitHub Token"
                  onChange={(event) => {
                    // 一动手填就把「清除」撤掉：填了新值当然不再是要删的那份
                    setTokenCleared(false)
                    setTokenDraft(event.target.value)
                  }}
                />
              )}
            </div>

            <div className="row" style={{ gap: 6 }}>
              {/* 只有 GitHub 那行有「清除」：别的源的 Token 是回填明文的，清空输入框就是清除 */}
              {row.kind === 'github' && (serverToken || tokenCleared) ? (
                <button
                  type="button"
                  className="icon-btn"
                  data-tip={tokenCleared ? '撤销清除' : '清除 Token'}
                  aria-label={tokenCleared ? '撤销清除 GitHub Token' : '清除 GitHub Token'}
                  onClick={() => {
                    setTokenCleared((current) => !current)
                    setTokenDraft('')
                  }}
                >
                  {tokenCleared ? <IconRefresh size={16} /> : <IconClose size={16} />}
                </button>
              ) : null}

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
          </div>
        ))}

        <div className="source-add">
          <select
            className="input"
            value={addKind}
            aria-label="新订阅源类型"
            onChange={(event) => {
              setAddKind(event.target.value === 'github' ? 'github' : 'url')
              setProblem(null)
            }}
          >
            <option value="url">订阅源</option>
            <option value="github">{GITHUB_DISCOVERY_NAME}</option>
          </select>
          <input
            className="input"
            value={draftName}
            placeholder={
              addKind === 'github'
                ? `名称（可留空，默认「${GITHUB_DISCOVERY_NAME}」）`
                : '新源的名称（可留空）'
            }
            spellCheck={false}
            aria-label="新订阅源名称"
            onChange={(event) => setDraftName(event.target.value)}
          />
          <input
            className="input"
            value={draftUrl}
            placeholder={
              addKind === 'github'
                ? '这一档没有注册表地址'
                : '新源的地址，如 https://example.com/registry.json'
            }
            spellCheck={false}
            aria-label="新订阅源地址"
            // 选了 GitHub 发现之后地址就不该能填：它没有注册表文件，填了也不会被用上
            disabled={addKind === 'github'}
            onChange={(event) => setDraftUrl(event.target.value)}
            onKeyDown={(event) => {
              // 回车=添加：这一行本来就是「填完就走」，再挪去点按钮是多余的一步
              if (event.key === 'Enter') addDraft()
            }}
          />
          <button
            type="button"
            className="btn"
            data-size="sm"
            // 已经在列表里了就没什么可加的 —— 按住它比让用户点完再告诉他要清楚
            disabled={addKind === 'github' && hasGithub}
            data-tip={addKind === 'github' && hasGithub ? '已经在列表里了' : undefined}
            onClick={addDraft}
          >
            <IconPlus size={14} />
            添加
          </button>
        </div>

        <p className="field-hint">
          地址就是这个源的身份（后端靠它匹配条目、查它自己的 Token），改地址等于换一个源。 Token
          非空的源按私有源处理：它的条目下载时会带上 Bearer 认证。 「{GITHUB_DISCOVERY_NAME}
          」没有注册表地址 —— 它按 GitHub 上的 topic 搜仓库再逐个核对，Token
          存在服务器上、连接它的客户端共用一份（出于安全不回填，只露末尾四位）。
          停用的源不参与「全部订阅源」的聚合搜索，但单独选中它仍然能看。
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
