/**
 * 客户端更新的**纯逻辑**：从一份 release 的资产清单里挑出「本机该下的那一份」。
 *
 * 为什么挑资产这件事单独拿出来：它只是字符串匹配，放 shared/ 就能直接单测；而真正的下载
 * （网络、代理、写盘、进度）留在主进程。挑错这一份的后果不小 —— 装了别的架构的包，
 * 用户会得到「装完打不开」，而界面上一路都写着成功。
 *
 * 判据全部来自 electron-builder.yml 里那条统一命名式
 * `Songloft-Desktop-<version>-<os>-<cpu>.<ext>`（三平台一个式样，release.yml 会断言它）。
 */

import { isNewerVersion } from './version'

/** release 里的一个资产文件 */
export interface ClientUpdateAsset {
  /** 文件名（GitHub 上的原样，例如 Songloft-Desktop-1.3.3-windows-x64.exe） */
  name: string
  /** 字节数；GitHub 没给时为 0（下载完成后仍以实际写入的字节数为准） */
  size: number
  /** 下载地址（release 资产的 browser_download_url） */
  url: string
}

/** 本机是哪一种：平台 / 架构 / 是否正跑在 AppImage 里 */
export interface UpdateHost {
  /** `process.platform` 的原值 */
  platform: string
  /** `process.arch` 的原值（x64 / arm64 …） */
  arch: string
  /** 是否以 AppImage 运行（Linux 才有意义，见 AppInfo.appImage） */
  appImage: boolean
}

/**
 * 本机能吃哪几种扩展名，按优先级排。
 *
 * ★ 每个平台都**刻意只留一种**：release 里同一份安装包会以多种形态出现（Windows 有 NSIS
 *   安装包与免安装 zip、macOS 有 dmg 与 zip），而它们是给不同用途的 —— zip 是给自动更新 /
 *   脚本化分发用的，用户点了没有安装语义。列进来只会把「下错了」变成一个常见结果。
 * ★ Linux 的 tar.gz 同理：解压即用，没有安装器可交接。
 *
 * ★ 挑包与「下次启动时那份已下载的包还能不能装」共用这一份口径（见
 *   isPendingUpdateUsable）：两边各写一套的话，改名或加形态时只会改到一处。
 */
export function installableExtensions(host: UpdateHost): string[] {
  if (host.platform === 'win32') return ['.exe']
  if (host.platform === 'darwin') return ['.dmg']
  if (host.platform === 'linux') return host.appImage ? ['.appimage'] : ['.deb']
  return []
}

/** 架构段的别名归一：同一个架构在产物名里可能写成 amd64 / x86_64 */
const ARCH_ALIASES: Record<string, string> = {
  x64: 'x64',
  amd64: 'x64',
  x86_64: 'x64',
  arm64: 'arm64',
  aarch64: 'arm64',
  ia32: 'ia32',
  x86: 'ia32',
  universal: 'universal'
}

/**
 * 文件名里的架构段；认不出来（名字里根本没有这一段）时返回 null。
 *
 * 按 `-` `.` `_` 切段再查表，而不是 `includes('x64')`：版本号或仓库名里出现这些字符
 * 的可能是存在的，而切段之后每一段要么是架构、要么不是。
 */
function archOf(name: string): string | null {
  for (const part of name.toLowerCase().split(/[.\-_]/)) {
    const normalized = ARCH_ALIASES[part]
    if (normalized) return normalized
  }
  return null
}

/**
 * 在某个扩展名里挑出本机架构的那一份。
 *
 * 两条判据缺一不可：
 *   · **写着别的架构就绝不选**（arm64 的包装到 x64 上，比「这次装不了」更糟）；
 *   · **没写架构的照样收**（命名式哪天微调了，别让整条更新链路跟着失效）。
 */
function pickByExtension(
  assets: readonly ClientUpdateAsset[],
  extension: string,
  arch: string
): ClientUpdateAsset | null {
  const candidates = assets.filter((asset) => asset.name.toLowerCase().endsWith(extension))
  if (candidates.length === 0) return null

  const want = ARCH_ALIASES[arch.toLowerCase()] ?? arch.toLowerCase()
  const usable = candidates.filter((asset) => {
    const found = archOf(asset.name)
    return found === null || found === want
  })

  if (usable.length === 1) return usable[0] ?? null
  // 多份都「没写架构」时无从判断（不该发生）：宁可不挑，也别猜
  return usable.find((asset) => archOf(asset.name) === want) ?? null
}

/**
 * 挑本机该下的那一份；没有合适的就返回 null（界面据此说「这次的发布里没有本机可用的安装包」）。
 *
 * 多个扩展名候选（原则上不会发生，见 wantedExtensions）按优先级依次尝试，但**不做跨架构兜底**：
 * 拿 arm64 的包装到 x64 上，比「这次装不了」更糟。
 */
export function pickUpdateAsset(
  assets: readonly ClientUpdateAsset[],
  host: UpdateHost
): ClientUpdateAsset | null {
  for (const extension of installableExtensions(host)) {
    const picked = pickByExtension(assets, extension, host.arch)
    if (picked) return picked
  }
  return null
}

/**
 * 已经下载好、等着在下次启动时提示安装的那一份安装包。
 *
 * ★ 必须落盘（见 main/store.ts 的 ConfigStore）：从下载完到下次启动之间进程会重启，
 *   只放内存等于没记 —— 而这份记录正是「下次启动还找得到它」的全部依据。
 * ★ 只在主进程读写。渲染层拿到它只为「显示提示 + 提交用户的选择」，路径不回传给主进程。
 */
export interface PendingClientUpdate {
  /** 安装包的绝对路径（主进程写下的，不是渲染层传来的） */
  path: string
  /** 目标版本 tag（例如 v1.3.3）；启动时再跟当前版本比一次 */
  version: string
  /** 发布资产的原文件名（提示里给人看） */
  name: string
  /** 下载完成时实际写入的字节数 —— 启动时用来确认文件还是完整的那一份 */
  size: number
  /** 下载完成时间（epoch ms） */
  downloadedAt: number
}

/**
 * 这份「待安装记录」还能不能用。
 *
 * 三个条件缺一不可：
 *   · 目标版本仍**比当前版本新**（用户可能已经通过别的途径装上了，再提示就是骚扰）；
 *   · 文件名仍是本机能装的那种形态（记录万一被改，也不能让它指向别的东西）；
 *   · 文件大小与下载时一致（防被删、被截断、被换成了另一份）。
 *
 * ★ 「路径在不在下载目录、是不是普通文件」是主进程那一半（要碰文件系统与平台路径），
 *   这里只做纯判定，于是可以直接单测。
 */
export function isPendingUpdateUsable(
  pending: PendingClientUpdate,
  host: UpdateHost,
  currentVersion: string,
  actualSize: number
): boolean {
  if (!isNewerVersion(pending.version, currentVersion)) return false
  const name = pending.name.toLowerCase()
  if (!installableExtensions(host).some((extension) => name.endsWith(extension))) return false
  return actualSize === pending.size
}
