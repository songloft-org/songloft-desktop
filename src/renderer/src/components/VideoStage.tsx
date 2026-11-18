/**
 * 视频画面：把播放核心那颗媒体元素搬进界面。
 *
 * ★ **只搬不建**：画面必须是正在出声的那**一个**元素。另起一个 `<video>` 再对齐
 *   `currentTime` 会漂（原版 Web 端「静音 video 出画 + just_audio 出声」那种双元素方案
 *   正是踩过这个，后来改回单元素同时出音出画，见 songloft-player 的 web_video_view_web
 *   与 audio_service 的 hlsVideoPrimaryMode）。所以这里做的是 appendChild / remove。
 * ★ 媒体元素离开 DOM **不会暂停**：收起满窗只是不再画，声音照旧 —— 与「音频是模块级
 *   对象、不挂在 DOM 上」那条既有约定是同一件事。
 * ★ 黑底 + `object-fit: contain`（letterbox）与原版 `BoxFit.contain` 一致。`is_video`
 *   为真但流里没有视频轨时（后端 ffprobe 没探到 / 回落成音频 / 源就是纯音频），这里就是
 *   一块黑底 —— 原版全屏视频界面的 fallback 也是纯黑，刻意的，不另加提示。
 */

import { useEffect, useState } from 'react'

import { findCurrentLine, findCurrentWord } from '@shared/lyric'
import { LyricLineView } from './LyricsView'
import { mediaElement, parkMediaElement } from '@/state/player-core'
import { usePlayer } from '@/state/usePlayer'
import { useSettings } from '@/state/useSettings'

export interface VideoStageProps {
  /** 是否把当前歌词行叠在画面底部（原版视频界面的「字幕」开关） */
  subtitle?: boolean
}

export function VideoStage({ subtitle = false }: VideoStageProps): React.JSX.Element {
  const [host, setHost] = useState<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!host) return
    const media = mediaElement()
    // appendChild 对已有父节点的元素是「移过来」：换歌、重挂都不需要先 remove
    host.appendChild(media)
    return () => {
      /*
       * ★ 收起时**挪回离屏容器**，绝不能 remove：`<video>` 离开文档会被 Chromium 暂停，
       *   而这里只该停画面（实测过 remove 之后 paused=true、时间轴不动）。
       */
      parkMediaElement()
    }
  }, [host])

  return (
    <div className="video-stage" ref={setHost}>
      {subtitle ? <VideoSubtitle /> : null}
    </div>
  )
}

/**
 * 叠加字幕 = **当前歌词行**。
 *
 * ★ 为什么复用 LyricLineView 而不是自己拼一行文字：逐字高亮与「翻译/音译」两档显示偏好
 *   必须与歌词页表现一致，另写一份迟早只改一边（原版也是复用同一个 currentLine 再套
 *   KaraokeLine 渲染）。
 * ★ 视频时整块歌词列表被画面替换，字幕是歌词**唯一**的出口 —— 所以满窗那边的字幕开关
 *   默认打开（关掉就真的无处可看了）。
 */
function VideoSubtitle(): React.JSX.Element | null {
  const lyrics = usePlayer((s) => s.lyrics)
  const currentTime = usePlayer((s) => s.currentTime)
  const settings = useSettings((s) => s.settings)

  // 未同步的歌词没有「当前行」可言（与歌词页同一个判断）
  const activeIndex = lyrics.synced ? findCurrentLine(lyrics.lines, currentTime) : -1
  if (activeIndex < 0) return null
  const line = lyrics.lines[activeIndex]
  const activeWordIndex = line.words.length ? findCurrentWord(line.words, currentTime) : -1

  return (
    <div className="video-subtitle" aria-hidden="true">
      <LyricLineView
        line={line}
        active
        activeWordIndex={activeWordIndex}
        showTranslation={settings.lyricShowTranslation}
        showRoman={settings.lyricShowRoman}
        // 字幕不给点：它盖在画面上，误触一次就 seek 很难受（歌词页那一下才是找段落）
        synced={false}
        onClick={() => undefined}
      />
    </div>
  )
}
