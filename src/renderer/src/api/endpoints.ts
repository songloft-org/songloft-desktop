/**
 * 后端 `/api/v1` 的全部调用点。
 *
 * 端点清单来自 songloft-player 的 Flutter 实现（lib/features 下各模块的 data/xxx_api.dart），
 * 只保留桌面端真正用得到的部分，逐个核对过路径与请求体字段名。
 */

import type {
  AudioTrackInfo,
  AutoScanSetting,
  BackendVersion,
  CacheConfig,
  CacheConfigInput,
  CacheDirCheck,
  CacheStats,
  CleanResult,
  DirectoryListResponse,
  DuplicatesResult,
  FailedFingerprint,
  FingerprintProgress,
  FingerprintStatus,
  FolderListResponse,
  LibraryStats,
  LyricPayload,
  LyricSource,
  MetadataRefreshProgress,
  MusicPathSetting,
  Playlist,
  PlaylistImportResult,
  PlaylistListResponse,
  PlaylistMode,
  PlaylistType,
  ScanProgress,
  ScanTitleSource,
  Song,
  SongFacetResponse,
  SongListResponse,
  SongQuery,
  ServerUpgradeCheck,
  ServerUpgradeProgress,
  ServerUpdateTarget,
  SongType,
  TokenListResponse,
  UploadedServerBinary,
  VolumeNormalizeSetting
} from '@shared/types'
import { normalizePlaylist, type FacetField } from '@shared/types'
import type { ApiClient } from './client'

/* ───────────────────────────── 认证 ───────────────────────────── */

export interface LoginResult {
  access_token: string
  refresh_token: string
  expires_in: number
  token_type: string
}

export function login(client: ApiClient, username: string, password: string): Promise<LoginResult> {
  return client.request<LoginResult>('/auth/login', {
    method: 'POST',
    body: { username, password },
    anonymous: true
  })
}

export function logout(client: ApiClient): Promise<void> {
  return client.request<void>('/auth/logout', { method: 'POST' })
}

export function getTokens(client: ApiClient, limit = 20, offset = 0): Promise<TokenListResponse> {
  return client.request<TokenListResponse>('/auth/tokens', { query: { limit, offset } })
}

export function revokeToken(client: ApiClient, tokenId: string): Promise<void> {
  return client.request<void>(`/auth/tokens/${encodeURIComponent(tokenId)}`, { method: 'DELETE' })
}

export function getVersion(client: ApiClient): Promise<BackendVersion> {
  return client.request<BackendVersion>('/version', { anonymous: true })
}

export function getHealth(client: ApiClient): Promise<unknown> {
  return client.request<unknown>('/health', { anonymous: true })
}

/* ───────────────────────────── 歌曲 ───────────────────────────── */

function songQuery(query: SongQuery): Record<string, string | number | undefined> {
  const out: Record<string, string | number | undefined> = {}
  if (query.type && query.type !== 'all') out.type = query.type
  if (query.keyword) out.keyword = query.keyword
  if (query.path_prefix) out.path_prefix = query.path_prefix
  if (query.genre) out.genre = query.genre
  if (query.artist) out.artist = query.artist
  if (query.album) out.album = query.album
  if (query.language) out.language = query.language
  if (query.style) out.style = query.style
  if (query.year) out.year = query.year
  if (query.decade) out.decade = query.decade
  // 'none' 有语义（显示全部），不能被 truthy 判断吞掉，所以单独处理
  if (query.exclude_playlist_labels) out.exclude_playlist_labels = query.exclude_playlist_labels
  if (query.tag_id) out.tag_id = query.tag_id
  if (query.sort) out.sort = query.sort
  if (query.order) out.order = query.order
  if (query.limit != null) out.limit = query.limit
  if (query.offset != null) out.offset = query.offset
  return out
}

export function getSongs(client: ApiClient, query: SongQuery): Promise<SongListResponse> {
  return client.request<SongListResponse>('/songs', { query: songQuery(query) })
}

export function getSongIds(client: ApiClient, query: SongQuery): Promise<number[]> {
  return client
    .request<{ ids: number[]; total: number }>('/songs/ids', { query: songQuery(query) })
    .then((res) => res.ids ?? [])
}

/**
 * 取一首歌的最新数据。
 *
 * `timeoutMs` 开放出来是给**后台补齐**用的（见 state/song-metadata.ts）：那边宁可早点放弃、
 * 由服务端那条路兜底，也不想让一个悬着的请求一直占着「正在获取歌曲信息」这个提示。
 */
export function getSong(
  client: ApiClient,
  id: number,
  options: { timeoutMs?: number } = {}
): Promise<Song> {
  return client.request<Song>(`/songs/${id}`, { timeoutMs: options.timeoutMs })
}

export function getFolders(
  client: ApiClient,
  path = '',
  keyword = ''
): Promise<FolderListResponse> {
  return client.request<FolderListResponse>('/songs/folders', {
    query: { path: path || undefined, keyword: keyword || undefined }
  })
}

export function getLibraryStats(client: ApiClient): Promise<LibraryStats> {
  return client.request<LibraryStats>('/songs/stats')
}

export function getFacets(
  client: ApiClient,
  field: FacetField,
  options: {
    keyword?: string
    limit?: number
    offset?: number
    sort?: 'count' | 'name'
    order?: 'asc' | 'desc'
  } = {}
): Promise<SongFacetResponse> {
  return client.request<SongFacetResponse>('/songs/facets', {
    query: {
      field,
      keyword: options.keyword || undefined,
      limit: options.limit,
      offset: options.offset,
      sort: options.sort,
      order: options.order
    }
  })
}

export function getAudioTracks(client: ApiClient, id: number): Promise<AudioTrackInfo[]> {
  return client
    .request<{ tracks: AudioTrackInfo[] }>(`/songs/${id}/audio-tracks`)
    .then((res) => res.tracks ?? [])
}

export function getLyric(client: ApiClient, songId: number): Promise<LyricPayload> {
  return client.request<LyricPayload>(`/songs/${songId}/lyric`)
}

/**
 * 预热一首歌的后端缓存：解析直链 + 下载 + 转码，**立即返回 202**，活在后端继续干。
 *
 * ★ 路径由 `lib/url` 的 `prefetchSongPath` 拼（含 `prefetch=1`）：它的 query 必须与真实播放
 *   逐项一致（format / quality / normalize），否则后端按缓存键算出来的是另一份，等于白下一份。
 * ★ 返回值没有意义，失败也没人关心（只是这一次没预热上，下次照常解析），所以调用方一律吞掉异常。
 */
export function prefetchSong(client: ApiClient, path: string): Promise<void> {
  return client.request<void>(path)
}

export function updateSong(
  client: ApiClient,
  id: number,
  patch: Partial<
    Pick<
      Song,
      'title' | 'artist' | 'album' | 'url' | 'cover_url' | 'duration' | 'is_live' | 'is_video'
    >
  >
): Promise<Song> {
  return client.request<Song>(`/songs/${id}`, { method: 'PUT', body: patch })
}

export function updateSongLyrics(
  client: ApiClient,
  id: number,
  payload: {
    lyric_source: LyricSource
    lyric?: string
    tlyric?: string
    rlyric?: string
    lxlyric?: string
    lyric_remote_url?: string
  }
): Promise<{ file_write_status: string }> {
  return client.request<{ file_write_status: string }>(`/songs/${id}/lyrics`, {
    method: 'PUT',
    body: payload
  })
}

export function writeSongTags(
  client: ApiClient,
  id: number,
  tags: {
    title?: string
    artist?: string
    album?: string
    year?: number
    genre?: string
    language?: string
    style?: string
    rename_file?: boolean
  }
): Promise<{ file_write: string }> {
  return client.request<{ file_write: string }>(`/songs/${id}/tags`, { method: 'PUT', body: tags })
}

export function deleteSong(client: ApiClient, id: number, deleteFiles = false): Promise<void> {
  return client.request<void>(`/songs/${id}`, {
    method: 'DELETE',
    query: deleteFiles ? { delete_files: 'true' } : undefined
  })
}

export function batchDeleteSongs(
  client: ApiClient,
  ids: number[],
  deleteFiles = false
): Promise<void> {
  return client.request<void>('/songs/batch-delete', {
    method: 'POST',
    body: { ids, delete_files: deleteFiles }
  })
}

/**
 * 上报一次播放（触发后端播放历史与 JS 插件事件广播）。
 * `type` 取 play / finish / skip；只有 `play` 会带 context 写进播放历史。
 */
export function reportPlayed(
  client: ApiClient,
  id: number,
  options: {
    type?: 'play' | 'finish' | 'skip'
    context?: { type: string; key: string } | null
  } = {}
): Promise<void> {
  return client.request<void>(`/songs/${id}/played`, {
    method: 'POST',
    query: {
      source: 'songloft-desktop',
      type: options.type ?? 'play',
      context_type: options.context?.type,
      context_key: options.context?.key
    }
  })
}

export function createRemoteSongs(
  client: ApiClient,
  items: {
    title: string
    artist?: string
    album?: string
    url: string
    cover_url?: string
    duration?: number
  }[]
): Promise<{ songs: Song[]; count: number }> {
  return client.request<{ songs: Song[]; count: number }>('/songs/remote', {
    method: 'POST',
    body: items
  })
}

/* ───────────────────────────── 歌单 ───────────────────────────── */

export function getPlaylists(
  client: ApiClient,
  options: {
    type?: PlaylistType
    songSource?: 'local' | 'remote'
    /** 排除带这些 label 的歌单；'none' 表示全部（含隐藏） */
    excludeLabels?: string
    keyword?: string
    limit?: number
    offset?: number
  } = {}
): Promise<PlaylistListResponse> {
  return (
    client
      .request<PlaylistListResponse>('/playlists', {
        query: {
          type: options.type,
          song_source: options.songSource,
          exclude_labels: options.excludeLabels,
          keyword: options.keyword || undefined,
          limit: options.limit ?? 100,
          offset: options.offset ?? 0
        }
      })
      // 列表本身也兜一层：nil slice 序列化成 null 是同一个后端、同一种行为，
      // 少了它 usePlaylists 里的 `[...res.playlists]` 会抛「null is not iterable」
      .then((res) => ({ ...res, playlists: (res.playlists ?? []).map(normalizePlaylist) }))
  )
}

export function getPlaylist(client: ApiClient, id: number): Promise<Playlist> {
  return client.request<Playlist>(`/playlists/${id}`).then(normalizePlaylist)
}

export function createPlaylist(
  client: ApiClient,
  payload: { type: PlaylistType; name: string; description?: string }
): Promise<Playlist> {
  return client
    .request<Playlist>('/playlists', { method: 'POST', body: payload })
    .then(normalizePlaylist)
}

export function updatePlaylist(
  client: ApiClient,
  id: number,
  payload: { name?: string; description?: string; cover_song_id?: number; cover_url?: string }
): Promise<Playlist> {
  return client
    .request<Playlist>(`/playlists/${id}`, { method: 'PUT', body: payload })
    .then(normalizePlaylist)
}

export function uploadPlaylistCover(client: ApiClient, id: number, file: File): Promise<Playlist> {
  const formData = new FormData()
  formData.append('file', file, file.name)
  return client
    .request<Playlist>(`/playlists/${id}/cover`, { method: 'POST', formData })
    .then(normalizePlaylist)
}

export function deletePlaylist(client: ApiClient, id: number, deleteSongs = false): Promise<void> {
  return client.request<void>(`/playlists/${id}`, {
    method: 'DELETE',
    query: deleteSongs ? { delete_songs: 'true' } : undefined
  })
}

export function getPlaylistSongs(
  client: ApiClient,
  id: number,
  options: {
    limit?: number
    offset?: number
    sort?: string
    order?: 'asc' | 'desc'
    keyword?: string
  } = {}
): Promise<SongListResponse> {
  return client.request<SongListResponse>(`/playlists/${id}/songs`, {
    query: {
      limit: options.limit ?? 200,
      offset: options.offset ?? 0,
      sort: options.sort,
      order: options.order,
      keyword: options.keyword || undefined
    }
  })
}

export function getPlaylistSongIds(
  client: ApiClient,
  id: number,
  options: { sort?: string; order?: 'asc' | 'desc' } = {}
): Promise<number[]> {
  return client
    .request<{ ids: number[] }>(`/playlists/${id}/song-ids`, {
      query: { sort: options.sort, order: options.order }
    })
    .then((res) => res.ids ?? [])
}

export function addSongsToPlaylist(
  client: ApiClient,
  id: number,
  songIds: number[]
): Promise<{ added: number; skipped: number }> {
  return client.request<{ added: number; skipped: number }>(`/playlists/${id}/songs`, {
    method: 'POST',
    body: { song_ids: songIds }
  })
}

export function removeSongFromPlaylist(
  client: ApiClient,
  playlistId: number,
  songId: number
): Promise<void> {
  return client.request<void>(`/playlists/${playlistId}/songs/${songId}`, { method: 'DELETE' })
}

export function reorderPlaylistSongs(
  client: ApiClient,
  id: number,
  songIds: number[]
): Promise<void> {
  return client.request<void>(`/playlists/${id}/songs/reorder`, {
    method: 'PUT',
    body: { song_ids: songIds }
  })
}

export function sortPlaylistSongs(client: ApiClient, id: number, action: string): Promise<void> {
  return client.request<void>(`/playlists/${id}/songs/sort`, { method: 'POST', body: { action } })
}

export function setPlaylistPinned(
  client: ApiClient,
  id: number,
  pinned: boolean
): Promise<Playlist> {
  return client
    .request<Playlist>(`/playlists/${id}/pin`, { method: 'PUT', body: { pinned } })
    .then(normalizePlaylist)
}

export function setPlaylistVisibility(
  client: ApiClient,
  id: number,
  hidden: boolean
): Promise<Playlist> {
  return client
    .request<Playlist>(`/playlists/${id}/visibility`, { method: 'PUT', body: { hidden } })
    .then(normalizePlaylist)
}

/** 拖动重排歌单顺序（侧栏/歌单页共用） */
export function reorderPlaylists(client: ApiClient, playlistIds: number[]): Promise<void> {
  return client.request<void>('/playlists/reorder', {
    method: 'PUT',
    body: { playlist_ids: playlistIds }
  })
}

/** 记住该歌单的排序偏好（后端持久化，下次进来自动沿用） */
export function updatePlaylistSort(
  client: ApiClient,
  id: number,
  sortBy: string,
  sortOrder: 'asc' | 'desc'
): Promise<void> {
  return client.request<void>(`/playlists/${id}/sort`, {
    method: 'PUT',
    body: { sort_by: sortBy, sort_order: sortOrder }
  })
}

export function batchDeletePlaylists(
  client: ApiClient,
  ids: number[],
  deleteSongs = false
): Promise<{ deleted?: number }> {
  return client.request<{ deleted?: number }>('/playlists/batch-delete', {
    method: 'POST',
    body: { ids, delete_songs: deleteSongs }
  })
}

export function touchPlaylist(client: ApiClient, id: number): Promise<void> {
  return client.request<void>(`/playlists/${id}/touch`, { method: 'POST' })
}

/* ───────────────────────────── 扫描 / 目录 ───────────────────────────── */

/**
 * 开始扫描。
 * `paths` 非空时只扫给定目录（须在音乐根目录下）；为空则扫整个根目录。
 */
export function startScan(client: ApiClient, reimport = false, paths?: string[]): Promise<void> {
  return client.request<void>('/scan', {
    method: 'POST',
    body: paths && paths.length > 0 ? { reimport, paths } : { reimport }
  })
}

export function getScanProgress(client: ApiClient): Promise<ScanProgress> {
  return client.request<ScanProgress>('/scan/progress')
}

export function cancelScan(client: ApiClient): Promise<void> {
  return client.request<void>('/scan/cancel', { method: 'POST' })
}

/** 懒加载音乐目录树的一层（目录选择器用） */
export function getDirectories(client: ApiClient, path = ''): Promise<DirectoryListResponse> {
  return client
    .request<DirectoryListResponse>('/scan/directories', {
      query: { path: path || undefined }
    })
    .then((res) => ({ directories: res.directories ?? [], root: res.root ?? '' }))
}

/** 全部目录名（输入自动补全） */
export function getDirNames(client: ApiClient): Promise<string[]> {
  return client.request<{ names?: string[] }>('/scan/dir-names').then((res) => res.names ?? [])
}

/* ───────────────────────────── 音乐库维护 ───────────────────────────── */

/** 清理数据库里文件已不存在的歌曲。返回清理统计。 */
export function cleanMissingSongs(client: ApiClient): Promise<CleanResult> {
  return client.request<Partial<CleanResult>>('/songs/clean', { method: 'POST' }).then((res) => ({
    total: res.total ?? 0,
    file_not_found: res.file_not_found ?? 0,
    in_excluded_dir: res.in_excluded_dir ?? 0
  }))
}

/** 基于音频指纹找重复歌曲（后端可能跑几十秒，客户端要放宽超时） */
export function findDuplicates(client: ApiClient): Promise<DuplicatesResult> {
  return client
    .request<Partial<DuplicatesResult>>('/songs/duplicates', { timeoutMs: 120_000 })
    .then((res) => ({
      groups: res.groups ?? [],
      total_groups: res.total_groups ?? 0,
      total_duplicates: res.total_duplicates ?? 0
    }))
}

export function getFingerprintStatus(client: ApiClient): Promise<FingerprintStatus> {
  return client.request<FingerprintStatus>('/scan/fingerprints/status')
}

export function getFingerprintProgress(client: ApiClient): Promise<FingerprintProgress> {
  return client
    .request<Partial<FingerprintProgress>>('/scan/fingerprints/progress')
    .then((res) => ({
      status: res.status ?? 'idle',
      computed: res.computed ?? 0,
      total: res.total ?? 0,
      failed: res.failed ?? 0
    }))
}

/**
 * 触发批量指纹计算（异步，进度走 `getFingerprintProgress`）。
 *
 * 两个开关的含义（后端注释原文的口径）：
 *   * `recomputeAll`：**清空已有指纹**全部重算；
 *   * `retryFailed`：只重置失败项的「已尝试」标记后重试，已算好的保留。
 * 两个都传时 `recomputeAll` 优先；都不传 = 只算缺的那部分。
 */
export function computeFingerprints(
  client: ApiClient,
  options: { recomputeAll?: boolean; retryFailed?: boolean } = {}
): Promise<void> {
  return client.request<void>('/scan/fingerprints', {
    method: 'POST',
    body: {
      recompute_all: options.recomputeAll ?? false,
      retry_failed: options.retryFailed ?? false
    }
  })
}

/** 中断正在跑的指纹计算；已算出的指纹会保留，任务不在跑时后端返回 cancelled=false */
export function cancelFingerprintCompute(client: ApiClient): Promise<void> {
  return client.request<void>('/scan/fingerprints/cancel', { method: 'POST' })
}

/** 算不出指纹的歌曲 + 失败原因，给「查看失败详情」用 */
export function getFailedFingerprints(client: ApiClient): Promise<FailedFingerprint[]> {
  return client
    .request<{ items?: FailedFingerprint[] }>('/scan/fingerprints/failed')
    .then((res) => res.items ?? [])
}

/* ───────────────────────── 服务端设置（/settings/*）───────────────────────── */

export function getMusicPath(client: ApiClient): Promise<MusicPathSetting> {
  return client.request<Partial<MusicPathSetting>>('/settings/music-path').then((res) => ({
    path: res.path ?? 'music',
    exclude_dirs: res.exclude_dirs ?? [],
    exclude_paths: res.exclude_paths ?? [],
    auto_create_exclude_dirs: res.auto_create_exclude_dirs ?? []
  }))
}

export function updateMusicPath(client: ApiClient, setting: MusicPathSetting): Promise<void> {
  return client.request<void>('/settings/music-path', { method: 'PUT', body: setting })
}

export function getVolumeNormalize(client: ApiClient): Promise<VolumeNormalizeSetting> {
  return client
    .request<Partial<VolumeNormalizeSetting>>('/settings/volume-normalize')
    .then((res) => ({ enabled: res.enabled ?? false, loudness: res.loudness ?? -16 }))
}

export function setVolumeNormalize(
  client: ApiClient,
  setting: VolumeNormalizeSetting
): Promise<void> {
  return client.request<void>('/settings/volume-normalize', { method: 'PUT', body: setting })
}

/* ───────────────────────── 缓存管理（/cache-manage/*）───────────────────────── */

export function getCacheStats(client: ApiClient): Promise<CacheStats> {
  return client.request<Partial<CacheStats>>('/cache-manage/stats').then((res) => ({
    total_size: res.total_size ?? 0,
    file_count: res.file_count ?? 0,
    max_size: res.max_size ?? 0
  }))
}

export function getCacheConfig(client: ApiClient): Promise<CacheConfig> {
  return client.request<Partial<CacheConfig>>('/cache-manage/config').then((res) => ({
    max_size: res.max_size ?? 0,
    cache_dir: res.cache_dir ?? '',
    default_cache_dir: res.default_cache_dir ?? '',
    transcode_format: res.transcode_format ?? '',
    transcode_quality: res.transcode_quality ?? ''
  }))
}

/** PUT 收的是完整配置：字段都是「空 = 用默认」的语义，少传一个就等于把它清空 */
export function updateCacheConfig(client: ApiClient, config: CacheConfigInput): Promise<void> {
  return client.request<void>('/cache-manage/config', { method: 'PUT', body: config })
}

/** 清空已落盘的音乐缓存（同步接口，缓存大时会等几秒） */
export function cleanCache(client: ApiClient): Promise<void> {
  return client.request<void>('/cache-manage/clean', { method: 'POST', timeoutMs: 60_000 })
}

export function validateCacheDir(client: ApiClient, path: string): Promise<CacheDirCheck> {
  return client
    .request<Partial<CacheDirCheck>>('/cache-manage/validate-dir', {
      method: 'POST',
      body: { path }
    })
    .then((res) => ({
      valid: res.valid ?? false,
      created: res.created ?? false,
      total_size: res.total_size ?? 0,
      free_size: res.free_size ?? 0,
      error: res.error
    }))
}

/* ───────────────────────── 网络设置（代理）───────────────────────── */

export function getHttpProxy(client: ApiClient): Promise<string> {
  return client.request<{ proxy?: string }>('/settings/http-proxy').then((res) => res.proxy ?? '')
}

export function setHttpProxy(client: ApiClient, proxy: string): Promise<void> {
  return client.request<void>('/settings/http-proxy', { method: 'PUT', body: { proxy } })
}

export function getGithubProxy(client: ApiClient): Promise<string> {
  return client.request<{ proxy?: string }>('/settings/github-proxy').then((res) => res.proxy ?? '')
}

export function setGithubProxy(client: ApiClient, proxy: string): Promise<void> {
  return client.request<void>('/settings/github-proxy', { method: 'PUT', body: { proxy } })
}

/**
 * 服务器上保存的 GitHub Token（插件商店「GitHub 发现」用）。
 *
 * ★ 与上面那个「GitHub 加速代理」是**两样东西，且互斥**：代理是给匿名请求套的前缀，
 *   这个 token 是凭据 —— 带它的请求刻意绕过代理（前缀式代理会把 Authorization 丢掉）。
 * ★ 存在服务端而不是本机：同一台服务器上的客户端共用一份，与私有源 token 同一套语义。
 *   未配置时为空串；PUT 空串即清除。响应禁止缓存，所以每次进发现页都要重新读。
 */
export function getGithubDiscoveryToken(client: ApiClient): Promise<string> {
  return client
    .request<{ token?: string }>('/settings/github-discovery-token')
    .then((res) => res.token ?? '')
}

export function setGithubDiscoveryToken(client: ApiClient, token: string): Promise<string> {
  return client
    .request<{ token?: string }>('/settings/github-discovery-token', {
      method: 'PUT',
      body: { token: token.trim() }
    })
    .then((res) => res.token ?? '')
}

export function getProxyAllowlist(client: ApiClient): Promise<string[]> {
  return client
    .request<{ allowlist?: string[] }>('/settings/proxy-private-allowlist')
    .then((res) => res.allowlist ?? [])
}

export function setProxyAllowlist(client: ApiClient, allowlist: string[]): Promise<void> {
  return client.request<void>('/settings/proxy-private-allowlist', {
    method: 'PUT',
    body: { allowlist }
  })
}

/* ───────────────────────── 数据管理（歌单备份）───────────────────────── */

/**
 * 导出歌单备份。
 *
 * 返回的是**序列化好的 JSON 文本**而不是对象：调用方要把它整份写盘，重新 stringify 一遍
 * 只会多一次大对象的内存搬运。（能用 Authorization 头，不必像封面那样退到查询参数。）
 */
export function exportPlaylists(client: ApiClient): Promise<unknown> {
  return client.request<unknown>('/playlists/export')
}

export function importPlaylists(
  client: ApiClient,
  name: string,
  contents: string
): Promise<PlaylistImportResult> {
  const form = new FormData()
  // 字段名必须是 file：后端按 multipart 的 file 字段取文件
  form.append('file', new Blob([contents], { type: 'application/json' }), name)
  return client
    .request<Partial<PlaylistImportResult>>('/playlists/import', {
      method: 'POST',
      formData: form
    })
    .then((res) => ({
      playlists_created: res.playlists_created ?? 0,
      playlists_merged: res.playlists_merged ?? 0,
      songs_created: res.songs_created ?? 0,
      songs_matched: res.songs_matched ?? 0,
      songs_skipped: res.songs_skipped ?? 0
    }))
}

/* ───────────────────────── 服务端升级 ───────────────────────── */

/**
 * 问服务端有没有新版本。
 *
 * `githubProxy` 必须由调用方显式带上：后端**不会**去读它自己存的那份「GitHub 代理」配置 ——
 * 检查与升级都只看这个查询参数，漏了就只能在墙内干等到超时（这正是设置页有那一项的原因）。
 */
export function checkServerUpgrade(
  client: ApiClient,
  githubProxy?: string
): Promise<ServerUpgradeCheck> {
  type RawCheck = Partial<ServerUpgradeCheck> & {
    updates?: Record<string, Partial<ServerUpdateTarget> | undefined>
  }
  return client
    .request<RawCheck>('/upgrade/check', { query: { github_proxy: githubProxy } })
    .then((res) => ({
      has_update: res.has_update ?? false,
      current_version: res.current_version ?? '',
      current_channel: res.current_channel ?? '',
      current_build_type: res.current_build_type ?? '',
      latest_version: res.latest_version ?? '',
      release_notes: res.release_notes ?? '',
      is_docker: res.is_docker ?? false,
      // 后端的 updates 是 {stable: {...}, dev: {...}}；按固定顺序读出来，
      // 免得界面上的排列随 JSON 的键序漂移
      updates: ['stable', 'dev']
        .map((type): ServerUpdateTarget | null => {
          const item = res.updates?.[type]
          if (!item?.version) return null
          return {
            type,
            version: item.version,
            build_time: item.build_time,
            release_notes: item.release_notes
          }
        })
        .filter((item): item is ServerUpdateTarget => item !== null)
    }))
}

/**
 * 让服务端自己去 GitHub 拉新版本装上（阶段一：下载 + 校验）。
 *
 * 只有 Docker 部署能这么升 —— 裸机换二进制得在服务器那边动手。进度去 /upgrade/progress 看。
 */
export function startServerUpgrade(
  client: ApiClient,
  versionType: string,
  githubProxy?: string
): Promise<void> {
  return client.request<void>('/upgrade/start', {
    method: 'POST',
    body: { version_type: versionType, github_proxy: githubProxy ?? '' }
  })
}

/**
 * 上传本地二进制到服务端（阶段一：上传 + 校验，只暂存不替换）。
 *
 * 分两段是刻意的：先让服务端把文件读一遍、把版本号与通道报回来，由人确认「这确实是我想装的那份」
 * （尤其是跨通道），再去 /upgrade/upload/confirm 落地。上传走 XHR 带进度，见 ApiClient.upload。
 */
export function uploadServerBinary(
  client: ApiClient,
  file: File,
  onProgress?: (sent: number, total: number) => void
): Promise<UploadedServerBinary> {
  const form = new FormData()
  // 字段名必须是 file：后端按 multipart 的 file 字段取文件
  form.append('file', file, file.name)
  return client
    .upload<Partial<UploadedServerBinary>>('/upgrade/upload', form, onProgress)
    .then((res) => ({
      version: res.version ?? '',
      channel: res.channel ?? '',
      build_time: res.build_time ?? '',
      build_type: res.build_type ?? '',
      current_version: res.current_version ?? '',
      current_channel: res.current_channel ?? '',
      channel_mismatch: res.channel_mismatch ?? false
    }))
}

/** 确认执行上传的那份升级（阶段二：替换二进制 + 重启）。之后服务端会断开一会儿 */
export function confirmServerUploadUpgrade(client: ApiClient): Promise<void> {
  return client.request<void>('/upgrade/upload/confirm', { method: 'POST' })
}

/**
 * 读升级进度。
 *
 * 服务端换完二进制就 exit，重启期间这条会连不上 —— 那是正常现象，不是失败。
 * 完成判据是 status = 'restarting'（协议里没有 completed）。
 */
export function getServerUpgradeProgress(client: ApiClient): Promise<ServerUpgradeProgress> {
  return client.request<Partial<ServerUpgradeProgress>>('/upgrade/progress').then((res) => ({
    status: res.status ?? 'idle',
    progress: res.progress ?? 0,
    current_step: res.current_step ?? ''
  }))
}

/* ───────────────────────────── 日志 ───────────────────────────── */

/** 后端 slog 的等级。后端只认这四个（别的写法 PUT 会被 400 挡回） */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LOG_LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error']

/** 认不出的值退回 info —— 这也正是后端自己的兜底行为，两边不会打架 */
function normalizeLogLevel(value: string | undefined): LogLevel {
  return LOG_LEVELS.find((level) => level === value) ?? 'info'
}

export function getLogLevel(client: ApiClient): Promise<LogLevel> {
  return client
    .request<{ level?: string }>('/settings/log-level')
    .then((res) => normalizeLogLevel(res.level))
}

export function setLogLevel(client: ApiClient, level: LogLevel): Promise<LogLevel> {
  return client
    .request<{ level?: string }>('/settings/log-level', { method: 'PUT', body: { level } })
    .then((res) => normalizeLogLevel(res.level ?? level))
}

/**
 * 导出后端日志。
 *
 * ★ 后端返回的是 **text/plain** 附件正文（最近 10 MiB 的落盘日志按时间拼接、逐行脱敏），
 *   不是 JSON，也没有 zip 包。所以这里不能用解 JSON 那套读法 —— ApiClient 对非 JSON 的
 *   响应体会原样返回字符串（见 client.ts 的 parseBody）。
 */
export function exportServerLogs(client: ApiClient): Promise<string> {
  // 最多 10 MiB 正文，走默认那 15s 在慢链路上会假超时
  return client.request<string>('/logs/export', { timeoutMs: 60_000 })
}

export function getHlsProxyEnabled(client: ApiClient): Promise<boolean> {
  return client
    .request<{ enabled?: boolean }>('/settings/hls-proxy')
    .then((res) => res.enabled ?? false)
}

export function setHlsProxyEnabled(client: ApiClient, enabled: boolean): Promise<void> {
  return client.request<void>('/settings/hls-proxy', { method: 'PUT', body: { enabled } })
}

export function getScanAutoCreatePlaylists(client: ApiClient): Promise<boolean> {
  return client
    .request<{ enabled?: boolean }>('/settings/scan-auto-create-playlists')
    .then((res) => res.enabled ?? false)
}

export function setScanAutoCreatePlaylists(client: ApiClient, enabled: boolean): Promise<void> {
  return client.request<void>('/settings/scan-auto-create-playlists', {
    method: 'PUT',
    body: { enabled }
  })
}

export function getTagSyncToFile(client: ApiClient): Promise<boolean> {
  return client
    .request<{ enabled?: boolean }>('/settings/tag-sync-to-file')
    .then((res) => res.enabled ?? false)
}

export function setTagSyncToFile(client: ApiClient, enabled: boolean): Promise<void> {
  return client.request<void>('/settings/tag-sync-to-file', { method: 'PUT', body: { enabled } })
}

/** 扫描时标题取文件名还是内嵌标签 */
export function getScanTitleSource(client: ApiClient): Promise<ScanTitleSource> {
  return client
    .request<{ title_source?: string }>('/settings/scan-title-source')
    .then((res) => (res.title_source === 'filename' ? 'filename' : 'tag'))
}

export function setScanTitleSource(client: ApiClient, titleSource: ScanTitleSource): Promise<void> {
  return client.request<void>('/settings/scan-title-source', {
    method: 'PUT',
    body: { title_source: titleSource }
  })
}

/** 自动创建歌单的「歌单创建方式」。后端对非法值报 400，这里也不猜，落回默认。 */
export function getScanPlaylistMode(client: ApiClient): Promise<PlaylistMode> {
  return client.request<{ mode?: string }>('/settings/scan-playlist-mode').then((res) => {
    const mode = res.mode
    return mode === 'top_level' || mode === 'bubble_up' || mode === 'directory' ? mode : 'directory'
  })
}

export function setScanPlaylistMode(client: ApiClient, mode: PlaylistMode): Promise<void> {
  return client.request<void>('/settings/scan-playlist-mode', { method: 'PUT', body: { mode } })
}

/** 扫描后是否自动算音频指纹（默认关：大曲库会长时间占 CPU） */
export function getScanAutoFingerprint(client: ApiClient): Promise<boolean> {
  return client
    .request<{ enabled?: boolean }>('/settings/scan-auto-fingerprint')
    .then((res) => res.enabled ?? false)
}

export function setScanAutoFingerprint(client: ApiClient, enabled: boolean): Promise<void> {
  return client.request<void>('/settings/scan-auto-fingerprint', {
    method: 'PUT',
    body: { enabled }
  })
}

export function getAutoScan(client: ApiClient): Promise<AutoScanSetting> {
  return client.request<Partial<AutoScanSetting>>('/settings/auto-scan').then((res) => ({
    enabled: res.enabled ?? false,
    // 后端默认 1 小时；越界的值它自己会夹到 [60, 86400]
    interval_seconds: res.interval_seconds ?? 3600
  }))
}

export function setAutoScan(client: ApiClient, setting: AutoScanSetting): Promise<void> {
  return client.request<void>('/settings/auto-scan', { method: 'PUT', body: setting })
}

/* ─────────────────────────── 刷新元数据 ─────────────────────────── */

/**
 * 网络歌曲标题来源：`tag` 时「刷新元数据」会用音频标签里的标题**覆盖**网络歌曲标题。
 *
 * ★ 与 `getScanTitleSource` 是**两个互不相干的后端设置**（配置键
 *   `remote_title_source` vs `scan_title_source`），而且默认值相反 ——
 *   这里默认 `filename`（不覆盖），扫描那里默认 `tag`（优先标签）：
 *   前者管「刷新时要不要盖住已有标题」，后者管「提取出来的标题取哪个」。
 *   两者相乘的后果见 SettingsPage 里「元数据维护」卡片的说明。
 */
export function getRemoteTitleSource(client: ApiClient): Promise<ScanTitleSource> {
  return client
    .request<{ title_source?: string }>('/settings/remote-title-source')
    .then((res) => (res.title_source === 'tag' ? 'tag' : 'filename'))
}

export function setRemoteTitleSource(
  client: ApiClient,
  titleSource: ScanTitleSource
): Promise<void> {
  return client.request<void>('/settings/remote-title-source', {
    method: 'PUT',
    body: { title_source: titleSource }
  })
}

/**
 * 重新探测「元数据缺失」的歌曲（本地文件 + 已缓存的网络歌曲）。
 * 后台异步跑，只补空缺、不改写音频文件里的标签，进度与取消走下面两个端点。
 */
export function startMetadataRefresh(client: ApiClient): Promise<void> {
  return client.request<void>('/songs/refresh-metadata', { method: 'POST' })
}

export function getMetadataRefreshProgress(client: ApiClient): Promise<MetadataRefreshProgress> {
  return client
    .request<Partial<MetadataRefreshProgress>>('/songs/refresh-metadata/progress')
    .then((res) => ({
      status: res.status ?? 'idle',
      total: res.total ?? 0,
      processed: res.processed ?? 0,
      failed: res.failed ?? 0
    }))
}

export function cancelMetadataRefresh(client: ApiClient): Promise<void> {
  return client.request<void>('/songs/refresh-metadata/cancel', { method: 'POST' })
}

/* ───────────────────────────── 通用 KV 配置 ───────────────────────────── */

export interface ConfigEntry {
  key: string
  value: string
}

export function getConfigs(client: ApiClient): Promise<ConfigEntry[]> {
  return client.request<ConfigEntry[]>('/configs')
}

export function getConfig(client: ApiClient, key: string): Promise<ConfigEntry> {
  return client.request<ConfigEntry>(`/configs/${encodeURIComponent(key)}`)
}

export function setConfig(client: ApiClient, key: string, value: string): Promise<void> {
  return client.request<void>(`/configs/${encodeURIComponent(key)}`, {
    method: 'PUT',
    body: { key, value }
  })
}

/* ───────────────────────────── 类型便利 ───────────────────────────── */

export const SONG_TYPE_LABELS: Record<SongType, string> = {
  local: '本地',
  remote: '网络',
  radio: '电台'
}
