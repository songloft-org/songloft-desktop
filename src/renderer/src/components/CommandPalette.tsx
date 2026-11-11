/**
 * 命令面板（Ctrl / Cmd + K）。
 *
 * 与「搜索页」的分工：搜索页是「我要在曲库里找一个东西」，命令面板是
 * 「我现在想干一件事」—— 所以它同时收命令和结果，一段键盘就能完成
 * 「切到收藏 → 播放第一首」这类动作链。
 *
 * 键盘导航是自己实现的：面板里的条目是异构的（命令/歌曲/歌单），
 * 用 roving tabindex 反而更难维护，用一个 activeIndex 就够了。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { Song } from '@shared/types'
import {
  IconCommand,
  IconHeart,
  IconLibrary,
  IconListMusic,
  IconLyrics,
  IconMoon,
  IconPause,
  IconPlay,
  IconQueue,
  IconSearch,
  IconSettings,
  IconShuffle,
  IconSkipBack,
  IconSkipForward,
  IconSparkle,
  IconSun,
  IconVolume,
  IconVolumeX
} from './Icons'
import { Overlay } from './Overlay'
import { Cover } from './primitives'
import { fallbackTitle, songCoverUrl } from '@shared/metadata'
import { getSongs } from '@/api/endpoints'
import { displayArtist } from '@/lib/format'
import { requireClient } from '@/state/useAuth'
import { usePlayer } from '@/state/usePlayer'
import { usePlaylists } from '@/state/usePlaylists'
import { useSettings } from '@/state/useSettings'
import { useUi } from '@/state/useUi'
import { toast } from '@/state/useToasts'

interface Entry {
  key: string
  group: string
  label: string
  hint?: string
  icon: React.ReactNode
  /** 歌曲条目带的封面（走缩略图，避免面板里拉大图） */
  coverUrl?: string | null
  run: () => void
}

export function CommandPalette(): React.JSX.Element | null {
  const open = useUi((s) => s.paletteOpen)
  const setOpen = useUi((s) => s.setPaletteOpen)
  const navigate = useUi((s) => s.navigate)
  const playSongs = usePlayer((s) => s.playSongs)
  const player = usePlayer()
  const playlists = usePlaylists((s) => s.playlists)
  const settings = useSettings((s) => s.settings)
  const patchSettings = useSettings((s) => s.patch)

  const [query, setQuery] = useState('')
  const [songs, setSongs] = useState<Song[]>([])
  const [active, setActive] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // 每次打开都从干净状态开始：上次搜的词留着只会让人困惑
  useEffect(() => {
    if (!open) return
    setQuery('')
    setSongs([])
    setActive(0)
    const timer = window.setTimeout(() => inputRef.current?.focus(), 30)
    return () => window.clearTimeout(timer)
  }, [open])

  // 歌曲用防抖搜索；命令与歌单是本地过滤，不需要请求
  useEffect(() => {
    const keyword = query.trim()
    if (!open || keyword.length < 1) {
      setSongs([])
      return
    }
    const timer = window.setTimeout(() => {
      void getSongs(requireClient(), { keyword, limit: 8, sort: 'added_at', order: 'desc' })
        .then((res) => setSongs(res.songs))
        .catch(() => setSongs([]))
    }, 220)
    return () => window.clearTimeout(timer)
  }, [query, open])

  const entries = useMemo<Entry[]>(() => {
    const term = query.trim().toLowerCase()
    const matches = (text: string): boolean => (term ? text.toLowerCase().includes(term) : true)

    const commands: Entry[] = [
      {
        key: 'cmd-play',
        group: '播放',
        label: player.playing ? '暂停' : player.cursor < 0 ? '播放（队列为空）' : '继续播放',
        hint: '空格',
        icon: player.playing ? <IconPause size={15} /> : <IconPlay size={15} />,
        run: () => void player.toggle()
      },
      {
        key: 'cmd-next',
        group: '播放',
        label: '下一首',
        hint: 'Ctrl + →',
        icon: <IconSkipForward size={15} />,
        run: () => void player.next(false)
      },
      {
        key: 'cmd-prev',
        group: '播放',
        label: '上一首',
        hint: 'Ctrl + ←',
        icon: <IconSkipBack size={15} />,
        run: () => void player.previous()
      },
      {
        key: 'cmd-shuffle-library',
        group: '播放',
        label: '随机播放曲库（最近 300 首里抽）',
        icon: <IconShuffle size={15} />,
        run: () => {
          void getSongs(requireClient(), { limit: 300, sort: 'added_at', order: 'desc' })
            .then((res) => {
              const shuffled = [...res.songs]
              for (let i = shuffled.length - 1; i > 0; i -= 1) {
                const j = Math.floor(Math.random() * (i + 1))
                ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
              }
              return playSongs(shuffled.slice(0, 120), 0, { type: 'home', key: 'random' })
            })
            .catch((error: unknown) =>
              toast('随机播放失败', 'error', error instanceof Error ? error.message : undefined)
            )
        }
      },
      {
        key: 'cmd-mute',
        group: '播放',
        label: player.muted ? '取消静音' : '静音',
        icon: player.muted ? <IconVolumeX size={15} /> : <IconVolume size={15} />,
        run: () => player.toggleMute()
      },
      {
        key: 'cmd-queue',
        group: '播放',
        label: '打开播放队列',
        icon: <IconQueue size={15} />,
        run: () => useUi.getState().setPanelTab('queue')
      },
      {
        key: 'cmd-lyrics',
        group: '播放',
        label: '打开歌词面板',
        icon: <IconLyrics size={15} />,
        run: () => useUi.getState().setPanelTab('now-playing')
      },
      {
        key: 'nav-home',
        group: '导航',
        label: '首页',
        icon: <IconSparkle size={15} />,
        run: () => navigate({ name: 'home' })
      },
      {
        key: 'nav-library',
        group: '导航',
        label: '曲库',
        icon: <IconLibrary size={15} />,
        run: () => navigate({ name: 'library' })
      },
      {
        key: 'nav-favorites',
        group: '导航',
        label: '我喜欢的音乐',
        icon: <IconHeart size={15} />,
        run: () => navigate({ name: 'favorites' })
      },
      {
        key: 'nav-recent',
        group: '导航',
        label: '最近播放',
        icon: <IconSearch size={15} />,
        run: () => navigate({ name: 'recent' })
      },
      {
        key: 'nav-playlists',
        group: '导航',
        label: '歌单',
        icon: <IconListMusic size={15} />,
        run: () => navigate({ name: 'playlists' })
      },
      {
        key: 'nav-folders',
        group: '导航',
        label: '按文件夹浏览',
        icon: <IconLibrary size={15} />,
        run: () => navigate({ name: 'folders', path: '' })
      },
      {
        key: 'nav-settings',
        group: '导航',
        label: '设置',
        icon: <IconSettings size={15} />,
        run: () => navigate({ name: 'settings', section: 'appearance' })
      },
      {
        key: 'theme-toggle',
        group: '外观',
        label: settings.theme === 'light' ? '切到深色主题' : '切到浅色主题',
        icon: settings.theme === 'light' ? <IconMoon size={15} /> : <IconSun size={15} />,
        run: () => void patchSettings({ theme: settings.theme === 'light' ? 'dark' : 'light' })
      },
      {
        key: 'accent-toggle',
        group: '外观',
        label: settings.accentFromCover ? '关掉封面取色（用固定强调色）' : '开启封面取色',
        icon: <IconSparkle size={15} />,
        run: () => void patchSettings({ accentFromCover: !settings.accentFromCover })
      }
    ]

    const commandEntries = commands.filter((entry) => matches(entry.label))

    const playlistEntries: Entry[] = playlists
      .filter((playlist) => matches(playlist.name))
      .slice(0, 6)
      .map((playlist) => ({
        key: `playlist-${playlist.id}`,
        group: '歌单',
        label: playlist.name,
        hint: `${playlist.song_count} 首`,
        icon: <IconListMusic size={15} />,
        coverUrl: playlist.cover_url,
        run: () => navigate({ name: 'playlist', id: playlist.id })
      }))

    const songEntries: Entry[] = songs.map((song) => ({
      key: `song-${song.id}`,
      group: '歌曲',
      // 标题与封面都走降级口径（缺元数据时用文件名 / 原始音源封面，见 shared/metadata）
      label: fallbackTitle(song),
      hint: displayArtist(song.artist),
      icon: <IconPlay size={15} />,
      coverUrl: songCoverUrl(song),
      run: () => void playSongs([song], 0, { type: 'search', key: query.trim() })
    }))

    return [...songEntries, ...playlistEntries, ...commandEntries]
  }, [
    query,
    songs,
    playlists,
    player,
    settings.theme,
    settings.accentFromCover,
    patchSettings,
    navigate,
    playSongs
  ])

  // 结果集变了就把高亮拉回第一项（否则会停在一个已不存在的下标上）
  useEffect(() => setActive(0), [entries.length, query])

  // 高亮项滚进视野
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const close = useCallback(() => setOpen(false), [setOpen])

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setActive((current) => (entries.length === 0 ? 0 : (current + 1) % entries.length))
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setActive((current) =>
          entries.length === 0 ? 0 : (current - 1 + entries.length) % entries.length
        )
        return
      }
      if (event.key === 'Enter') {
        event.preventDefault()
        const entry = entries[active]
        if (entry) {
          close()
          entry.run()
        } else if (query.trim()) {
          // 没有命中任何条目时，回车直接去搜索页，不让人卡在这里
          close()
          navigate({ name: 'search', keyword: query.trim() })
        }
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        close()
      }
    },
    [entries, active, close, navigate, query]
  )

  if (!open) return null

  // 分组渲染（entries 已经是分组顺序，这里只是插小标题）
  let lastGroup = ''

  return (
    <Overlay align="top" onDismiss={close}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="命令面板">
        <div className="row" style={{ paddingRight: 12 }}>
          <IconCommand size={17} style={{ marginLeft: 16, color: 'var(--text-4)', flex: 'none' }} />
          <input
            ref={inputRef}
            className="palette-input"
            style={{ paddingLeft: 12 }}
            value={query}
            placeholder="搜索歌曲、歌单，或执行命令…"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleKeyDown}
          />
        </div>

        <div className="palette-list" ref={listRef}>
          {entries.length === 0 ? (
            <div className="palette-group" style={{ padding: '18px 12px' }}>
              没有匹配项{query.trim() ? '，回车可直接搜索整库' : ''}
            </div>
          ) : (
            entries.map((entry, index) => {
              const showHeader = entry.group !== lastGroup
              lastGroup = entry.group
              return (
                <div key={entry.key}>
                  {showHeader ? <div className="palette-group">{entry.group}</div> : null}
                  <button
                    type="button"
                    className="palette-item"
                    data-index={index}
                    data-active={index === active}
                    onPointerMove={() => setActive(index)}
                    onClick={() => {
                      close()
                      entry.run()
                    }}
                  >
                    {entry.coverUrl !== undefined ? (
                      <Cover
                        coverUrl={entry.coverUrl}
                        width={48}
                        size={26}
                        radius={6}
                        kind="song"
                      />
                    ) : (
                      entry.icon
                    )}
                    <span className="truncate">{entry.label}</span>
                    {entry.hint ? <span className="hint truncate">{entry.hint}</span> : null}
                  </button>
                </div>
              )
            })
          )}
        </div>

        <div
          className="row-between"
          style={{
            padding: '8px 14px',
            borderTop: '1px solid var(--line-1)',
            fontSize: 11.5,
            color: 'var(--text-4)'
          }}
        >
          <span>↑↓ 选择 · Enter 执行 · Esc 关闭</span>
          <span>{entries.length} 项</span>
        </div>
      </div>
    </Overlay>
  )
}
