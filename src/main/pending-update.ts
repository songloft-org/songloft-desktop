/**
 * 「已下载安装包」跨重启的那一半：校验它还在、还能装，然后交给系统安装程序。
 *
 * 与 update-download.ts 的分工：那边负责「下」，这里负责「下次启动时它还作不作数」。
 *
 * ★ 这里**不做安装**：只 `shell.openPath` 拉起系统安装程序（NSIS 向导 / 软件中心 /
 *   挂载 dmg）。用户确认的是「现在打开安装程序吗」，不是「让应用换掉自己」——
 *   安装器里点了取消，当前版本照常运行（整个过程没有退出应用、没有替换任何文件）。
 */

import { lstat } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'

import { app, shell } from 'electron'

import { isPendingUpdateUsable, type PendingClientUpdate } from '@shared/update'

import type { ConfigStore } from './store'

/** 本机形态（与 main/release.ts 挑包时的口径一致） */
function hostNow(): { platform: string; arch: string; appImage: boolean } {
  return {
    platform: process.platform,
    arch: process.arch,
    appImage: Boolean(process.env.APPIMAGE)
  }
}

/**
 * 记录指向的文件是否仍在「下载」目录里。
 *
 * ★ 不能让这份可改的 JSON 把 `shell.openPath` 引到任意路径上 —— 那等于给了一个
 *   「打开 / 执行任意文件」的口子。记录只该指向我们当初下载的那一处。
 */
function insideDownloads(target: string): boolean {
  const downloads = resolve(app.getPath('downloads'))
  const rel = relative(downloads, resolve(target))
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/**
 * 读一次待安装记录；不可用的**当场清掉**。
 *
 * 不可用的情形：文件被删 / 被移走 / 被截断或换掉、目标版本已经不比当前版本新
 * （用户可能自己升级过了）、路径跑出了下载目录。这些情况下继续提示只会让人以为
 * 出了问题 —— 清除后返回 null，界面就当没有这回事。
 */
export async function readPendingUpdate(store: ConfigStore): Promise<PendingClientUpdate | null> {
  const pending = store.getPendingUpdate()
  if (!pending) return null

  let size = -1
  try {
    const info = await lstat(pending.path)
    // lstat 不跟随符号链接：isFile() 为假时连链接本身都会被挡掉
    if (info.isFile()) size = info.size
  } catch {
    size = -1
  }

  const usable =
    size >= 0 &&
    insideDownloads(pending.path) &&
    isPendingUpdateUsable(pending, hostNow(), app.getVersion(), size)

  if (!usable) {
    store.setPendingUpdate(null)
    return null
  }
  return pending
}

/**
 * 打开安装程序。
 *
 * 成功后**立刻清掉记录**：装与不装由安装器决定，应用不再追问。用户在安装器里点了取消，
 * 这个应用仍然完整地跑在旧版本上 —— 我们既没退出，也没替换任何文件。
 */
export async function acceptPendingUpdate(store: ConfigStore): Promise<void> {
  const pending = await readPendingUpdate(store)
  if (!pending) throw new Error('没有待安装的更新包')

  const failure = await shell.openPath(pending.path)
  // openPath 失败时返回一句错误描述（成功是空串），不会抛
  if (failure) throw new Error(`打不开安装包：${failure}`)
  store.setPendingUpdate(null)
}
