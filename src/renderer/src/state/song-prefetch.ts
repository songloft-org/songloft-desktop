/**
 * 「预热下一首」：当前歌起播后，请后端把队列里的下一首**提前解析 + 下载 + 转码**
 * （`GET /songs/{id}/play?…&prefetch=1` → 202，工作在后端后台继续），下次点播直接命中缓存。
 *
 * ★ 为什么这件事只能由客户端发起：后端不知道「下一首」是哪一首 —— 队列、随机顺序、
 *   用户手动插队都只存在于这个进程里。
 *
 * ★ 为什么要节流：prefetch 在后端注册成 `CatPrefetch`，而 `Activate` **故意不取消**它
 *   （那是 `songloft#300` 为了给「下一首」预热留的设计）。快速连切十几首时，不节流就会堆出
 *   十几个后台下载，把插件的唯一 worker 与转码信号量占满 —— 预热反而变成「播放更慢」。
 *   所以这里有三个闸：**同一时刻只发一个**、**两次之间至少隔 COOLDOWN_MS**、**同一首只发一次**。
 *
 * ★ 只在**宿主的播放核心**里被调用（见 player-core 的 prefetchUpcoming）：镜像那一侧既没有
 *   队列也没有音频元素，不该替宿主做决定。
 */

import type { ApiClient } from '@/api/client'
import { prefetchSong } from '@/api/endpoints'

/** 两次预热之间的最小间隔：连切时最多每 3 秒给后端派一个下载任务 */
const COOLDOWN_MS = 3000

/** 记住多少首「已经预热过」：够覆盖一轮正常收听，又不至于无限增长 */
const REMEMBER_LIMIT = 300

let timer: number | null = null
let lastStartedAt = 0
let inFlight = false
/** 连切时只保留最后一个：中间那些歌已经不会被播到了 */
let pending: { client: ApiClient; path: string } | null = null
const done = new Set<string>()
let doneForClient: ApiClient | null = null

/**
 * 安排一次预热。
 *
 * `path` 由 `lib/url` 的 `prefetchSongPath` 拼好传入（为 null 表示这首歌不值得预热）。
 * 这里只负责「什么时候发、发不发」。
 */
export function schedulePrefetch(client: ApiClient, path: string | null): void {
  if (!path) return
  // 换了服务器/账号就换了一套曲库：上一轮的记忆不能带过来
  if (doneForClient !== client) {
    done.clear()
    doneForClient = client
    lastStartedAt = 0
  }
  if (done.has(path)) return

  pending = { client, path }
  if (timer !== null) return
  const wait = Math.max(0, COOLDOWN_MS - (Date.now() - lastStartedAt))
  timer = window.setTimeout(flush, wait)
}

/** 清空队列 / 退出登录时一并收掉：留着 timer 会在没人要的时候还去派一次下载 */
export function resetPrefetch(): void {
  if (timer !== null) {
    window.clearTimeout(timer)
    timer = null
  }
  pending = null
  inFlight = false
  lastStartedAt = 0
  done.clear()
  doneForClient = null
}

function flush(): void {
  timer = null
  const job = pending
  pending = null
  // 上一个还没回来：这一次直接丢，下一次起播会再安排（后台真正在下载的是上一个）
  if (!job || inFlight || done.has(job.path)) return

  inFlight = true
  lastStartedAt = Date.now()
  void prefetchSong(job.client, job.path)
    .then(() => remember(job.path))
    // 预热失败不值得报给用户：它只是「让下一次更快」，失败了下次照常解析
    .catch(() => undefined)
    .finally(() => {
      inFlight = false
    })
}

function remember(path: string): void {
  done.add(path)
  if (done.size <= REMEMBER_LIMIT) return
  // Set 的插入序就是淘汰序：从最旧的开始丢，只丢到一半，避免每加一条都做一次淘汰
  for (const key of done) {
    done.delete(key)
    if (done.size <= REMEMBER_LIMIT / 2) break
  }
}
