/**
 * 歌词视图。
 *
 * 相对 Flutter 端的改进是三处细节：
 *   1. **逐字高亮**：后端 lxlyric 带的 `<mm:ss.xx>` 逐字时间轴直接用上，
 *      当前字比整行高亮精细得多（原实现只在「卡拉OK」页做）；
 *   2. **点行跳转**：点任意一行歌词直接 seek 过去，找段落不用拖进度条；
 *   3. **手动滚动优先**：用户滚歌词时暂停自动归位（否则想看后面几段会被拽回去），
 *      停手 3 秒后恢复跟随。
 *
 * 「当前行始终在视野里」这件事由三处共同保证，缺一处就会看到高亮行跑到框外：
 *   * 位置用**两个矩形相减**算（见 centerActive），不用 offsetTop；
 *   * 程序性滚动要能认出来（见下面 onScroll 的说明），否则跟随会把自己暂停掉；
 *   * 换歌、以及容器尺寸变化（缩放窗口 / 面板展开 / 迷你模式的歌词展开）后各归位一次。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { findCurrentLine, findCurrentWord, type LyricLine } from '@shared/lyric'
import { usePlayer } from '@/state/usePlayer'
import { useSettings } from '@/state/useSettings'
import { IconLoader } from './Icons'

export function LyricsView({ compact = false }: { compact?: boolean }): React.JSX.Element {
  const lyrics = usePlayer((s) => s.lyrics)
  const loading = usePlayer((s) => s.lyricsLoading)
  const failed = usePlayer((s) => s.lyricFailed)
  const currentTime = usePlayer((s) => s.currentTime)
  const seek = usePlayer((s) => s.seek)
  const reloadLyrics = usePlayer((s) => s.reloadLyrics)
  const settings = useSettings((s) => s.settings)
  /**
   * 这一处歌词的眼下的字号（px）。
   * ★ 迷你窗那一块用**它自己**那个量（miniLyricFontSize）：那颗滑块只管这一块 —— 整窗尺度上的
   *   抽屉/满窗与挂在屏幕角上、只有 380px 宽的挂件，合适字号本来就差着一档，共用一个值只会
   *   「调好一边、另一边难看」（见 shared/ipc.ts 那两项上的说明）。
   * ★ compact 就是「迷你窗那块面板」：只有 MiniPlayer 传它（见那边 <LyricsView compact />）。
   * ★ 抽成一个变量而不是在两处各写一遍三元：下面 effect 的依赖数组里必须是**一个可静态检查的
   *   表达式**（写条件式 eslint 会警告），而且行内样式与依赖一旦各写一份，迟早只改一处。
   */
  const fontSize = compact ? settings.miniLyricFontSize : settings.lyricFontSize

  /*
   * 滚动容器用**回调 ref**（state）而不是 useRef 对象。
   * 理由：歌词是异步来的 —— 首帧渲染的是「正在加载歌词…」，那时容器还不存在；
   * 用 useRef + 空依赖的 effect 去挂监听，就会在容器出现之前跑完并 bail，监听永远挂不上
   * （原先的「用户滚动」就是这么失效的）。state 一变化，下面几个 effect 都会重跑。
   */
  const [container, setContainer] = useState<HTMLDivElement | null>(null)
  const activeRef = useRef<HTMLDivElement>(null)

  /** 用户正在自己滚 → 自动跟随暂停。用 ref：它不影响渲染，放进 deps 只会让 effect 反复重跑 */
  const userScrolling = useRef(false)
  const resumeTimer = useRef<number | null>(null)
  /** 我们自己发起的那次滚动还没结束（见 onScroll 里的说明） */
  const selfScrolling = useRef(false)
  const selfTimer = useRef<number | null>(null)
  /** 上一次跟随时的歌词对象：换了歌就整份换新，用身份比较就能认出来 */
  const lastLyrics = useRef<typeof lyrics | null>(null)

  const activeIndex = useMemo(
    () => (lyrics.synced ? findCurrentLine(lyrics.lines, currentTime) : -1),
    [lyrics, currentTime]
  )

  /** 把当前高亮行摆到容器**中部**（跟随、换歌、容器尺寸变化都走这一条） */
  const centerActive = useCallback(
    (smooth: boolean): void => {
      const line = activeRef.current
      if (!container || !line) return
      /*
       * ★ 用两个矩形相减，而不是 line.offsetTop - container.clientHeight / 2。
       *   offsetTop 的原点是「最近的**定位**祖先」，而这个滚动容器自己并没有 position：
       *   面板里它上面还压着大封面与歌名，那一段高度会被白算进去 —— 目标一偏就是几百 px，
       *   于是每次滚动都过头，高亮行反而被顶到视野之外（原先就是这个病）。
       *   矩形相减得到的是「行相对容器可视区」的真实偏移，与祖先是谁无关；
       *   顺带还免疫祖先上的 transform —— 这层保护对任何祖先动效都成立（面板展开那层动画
       *   2026-10-15 起改用 clip-path，不再产生 transform，但别因此退回 offsetTop）。
       */
      const rect = container.getBoundingClientRect()
      const lineRect = line.getBoundingClientRect()
      const delta = lineRect.top - rect.top - container.clientHeight / 2 + lineRect.height / 2

      selfScrolling.current = true
      // 'instant' 而不是 'auto'：CSS 里 .lyrics 写着 scroll-behavior: smooth，
      // 而 'auto' 的含义正是「听 CSS 的」—— 换歌时想要一步落位，只能显式要 instant
      container.scrollTo({
        top: Math.max(0, container.scrollTop + delta),
        behavior: smooth ? 'smooth' : 'instant'
      })
      // scrollend 不来的兜底（滚动被中途打断 / 引擎没实现）：标记不能卡住 ——
      // 卡住的后果是用户手动滚动不再能暂停跟随，那比多滚一次糟糕得多
      if (selfTimer.current !== null) window.clearTimeout(selfTimer.current)
      selfTimer.current = window.setTimeout(() => {
        selfScrolling.current = false
      }, 1000)
    },
    [container]
  )

  // 用户开始滚 → 暂停跟随；停手 3 秒 → 恢复，并当场归位一次
  useEffect(() => {
    if (!container) return

    const resume = (): void => {
      userScrolling.current = false
      resumeTimer.current = null
      centerActive(true)
    }
    const pause = (): void => {
      userScrolling.current = true
      if (resumeTimer.current !== null) window.clearTimeout(resumeTimer.current)
      resumeTimer.current = window.setTimeout(resume, 3000)
    }
    /*
     * ★ scroll 事件分不出是谁滚的：自动跟随每滚一次都会把它叫醒，若一律当成「用户在滚」，
     *   跟随就会把自己暂停 3 秒 —— 高亮行于是长期停在视野外（这正是原先的病）。
     *   所以自己滚的那一段时间直接忽略，结束由 scrollend 通知。
     * wheel 则一定是人滚的，走 pause 不带这层判断。
     */
    const onScroll = (): void => {
      if (selfScrolling.current) return
      pause()
    }
    const onScrollEnd = (): void => {
      selfScrolling.current = false
    }

    container.addEventListener('scroll', onScroll, { passive: true })
    container.addEventListener('scrollend', onScrollEnd)
    container.addEventListener('wheel', pause, { passive: true })
    return () => {
      container.removeEventListener('scroll', onScroll)
      container.removeEventListener('scrollend', onScrollEnd)
      container.removeEventListener('wheel', pause)
      if (resumeTimer.current !== null) window.clearTimeout(resumeTimer.current)
      resumeTimer.current = null
      userScrolling.current = false
    }
  }, [container, centerActive])

  // 当前行变化时跟随（换歌则一步落位，不要从上一首停下的位置滑过去）
  useEffect(() => {
    if (!lyrics.synced || activeIndex < 0) return
    const songChanged = lastLyrics.current !== lyrics
    lastLyrics.current = lyrics
    /*
     * ★ 这里必须把 userScrolling 当 ref 读、并且不放进依赖：
     *   「换了首歌」与「上一首滚到哪」无关，新歌的第一行无论如何都该在视野里 ——
     *   而歌手切歌时用户上一首的滚动状态会把它拦住（activeIndex 常常还是 0，
     *   effect 本来也不会重跑，滚动位置就留在上一首那里）。
     */
    if (!songChanged && userScrolling.current) return
    centerActive(!songChanged)
    /*
     * 三个显示选项也进依赖：改歌词字号、开关翻译/音译都会改行高，当前行的高度一变，
     * 「中部」就不再是它了 —— 而这类改动不触发上面的 activeIndex 变化。
     * ★ 字号走上面那个 fontSize（两块面板各取各的）：写成其中一个量的话，另一处改完字号就不会
     *   重新归位（当前行歪在可视区外）。
     */
  }, [
    activeIndex,
    lyrics,
    centerActive,
    fontSize,
    settings.lyricShowTranslation,
    settings.lyricShowRoman
  ])

  /*
   * 容器尺寸变了也要重新归位：窗口缩放、面板展开收起、迷你模式展开歌词都会改可视区高度，
   * 而高度一变，原先那个「中部」就不再是中部了。ResizeObserver 在开始观察时会先回调一次，
   * 正好把「歌词刚加载出来」那一刻的首帧定位一并办了。
   */
  useEffect(() => {
    if (!container) return
    const observer = new ResizeObserver(() => {
      if (userScrolling.current) return
      centerActive(false)
    })
    observer.observe(container)
    return () => observer.disconnect()
  }, [container, centerActive])

  if (loading) {
    return (
      <div className="lyrics-empty">
        <IconLoader size={20} />
        <div style={{ marginTop: 10 }}>正在加载歌词…</div>
      </div>
    )
  }

  if (lyrics.lines.length === 0) {
    return (
      /*
       * 空态与失败态的文案必须只说本应用真的能做到的事。
       * 这里曾经写着「可以在歌曲菜单里手动指定歌词 / 安装『歌词搜索』插件后会自动补全」——
       * 但本端既没有手动指定歌词的入口，也还没有插件系统，用户按提示找一圈只会更困惑。
       */
      <div className="lyrics-empty">
        {failed ? (
          <>
            歌词加载失败
            <br />
            多半是后端没连上，可以检查服务器设置后重试
            <div style={{ marginTop: 14 }}>
              <button
                type="button"
                className="btn"
                data-size="sm"
                onClick={() => void reloadLyrics()}
              >
                重试
              </button>
            </div>
          </>
        ) : (
          <>
            这首歌还没有歌词
            <br />
            后端曲库里这首歌还没有关联到歌词
          </>
        )}
      </div>
    )
  }

  const activeLine = activeIndex >= 0 ? lyrics.lines[activeIndex] : null
  const activeWordIndex = activeLine?.words.length
    ? findCurrentWord(activeLine.words, currentTime)
    : -1

  return (
    <div
      ref={setContainer}
      className="lyrics"
      /*
        字号写在这一层（.lyrics 的行内），行们继承它（见上面那个 fontSize）。
        ★ 别再乘系数：那个 0.85（「迷你窗总比主窗口小一档」的临时办法）随这一块有了自己的
          绝对字号而撤掉 —— 留着的话，滑块上的数就不是最终的字号了。
        ★ 迷你窗那边还有一条 html[data-mini] 规则把 .lyric-line 上写死的 px 放开，
          否则这份行内字号会被元素自己的声明挡回去（见 components.css 那两处）。
      */
      style={{ fontSize }}
    >
      {lyrics.lines.map((line, index) => (
        <LyricLineView
          key={`${line.time}-${index}`}
          line={line}
          active={index === activeIndex}
          activeWordIndex={index === activeIndex ? activeWordIndex : -1}
          showTranslation={settings.lyricShowTranslation}
          showRoman={settings.lyricShowRoman}
          synced={lyrics.synced}
          onClick={() => {
            if (lyrics.synced) seek(line.time)
          }}
          ref={index === activeIndex ? activeRef : undefined}
        />
      ))}
    </div>
  )
}

interface LyricLineViewProps {
  line: LyricLine
  active: boolean
  activeWordIndex: number
  showTranslation: boolean
  showRoman: boolean
  synced: boolean
  onClick: () => void
  ref?: React.Ref<HTMLDivElement>
}

/**
 * 一行歌词。
 *
 * 导出是为了**视频字幕**复用同一份渲染（见 components/VideoStage）：视频时整块歌词列表
 * 被画面替换，只剩这一行叠加在画面上 —— 逐字高亮、译音那几档显示偏好必须与歌词页
 * 一模一样，另写一份迟早只改一边。
 */
export function LyricLineView({
  line,
  active,
  activeWordIndex,
  showTranslation,
  showRoman,
  synced,
  onClick,
  ref
}: LyricLineViewProps): React.JSX.Element {
  return (
    <div
      ref={ref}
      className="lyric-line"
      data-active={active}
      style={{ cursor: synced ? 'pointer' : 'default' }}
      onClick={onClick}
    >
      <div className="lyric-main">
        {line.words.length > 0 ? (
          line.words.map((word, i) => (
            <span
              key={`${word.time}-${i}`}
              className="lyric-word"
              data-sung={i <= activeWordIndex && active}
            >
              {word.text}
            </span>
          ))
        ) : (
          <>{line.text}</>
        )}
      </div>
      {showRoman && line.roman ? <div className="lyric-roman">{line.roman}</div> : null}
      {showTranslation && line.translation ? (
        <div className="lyric-translation">{line.translation}</div>
      ) : null}
    </div>
  )
}
