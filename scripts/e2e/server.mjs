/**
 * Songloft 后端的**最小 mock**，只用于本地跑通桌面端的已登录界面。
 *
 * 目的单一：让 Songloft Desktop 能真的走完
 *   登录 → 首页 → 曲库 / 艺人筛选 → 播放 → 歌词 → 歌单 / 收藏
 * 而不是只停在登录页（那样 969 kB 的渲染层等于零验证）。
 *
 * 注意：这不是后端的替代品，不落库、不校验密码（任何非空账号密码都放行）。
 * 数据形状严格按 src/shared/types.ts 抄，字段名保持 snake_case。
 */

import { createServer } from 'node:http'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
/** 封面是固定 fixture：用真实 JPEG 而不是内联 SVG —— 取主色的链路要走
 *  createImageBitmap(blob)，SVG blob 在 Chromium 里需要显式尺寸，容易踩坑。 */
const COVER_DIR = join(HERE, 'fixtures', 'covers')
const PORT = Number(process.env.MOCK_PORT ?? 58091)

const ALBUMS = [
  {
    album: '夜航西飞',
    artist: '陈屿',
    genre: '独立',
    language: '国语',
    style: '民谣',
    year: 2023,
    cover: 'cover-01.jpg'
  },
  {
    album: 'Blue Hour',
    artist: 'Marla Quinn',
    genre: '爵士',
    language: '英语',
    style: 'Vocal Jazz',
    year: 2021,
    cover: 'cover-02.jpg'
  },
  {
    album: '山海之间',
    artist: '野岸乐队',
    genre: '摇滚',
    language: '国语',
    style: '后摇',
    year: 2019,
    cover: 'cover-03.jpg'
  },
  {
    album: 'Late Night Drive',
    artist: 'Kaito Mori',
    genre: '电子',
    language: '日语',
    style: 'City Pop',
    year: 2024,
    cover: 'cover-04.jpg'
  },
  {
    album: '旧唱片店',
    artist: '陈屿',
    genre: '独立',
    language: '国语',
    style: '民谣',
    year: 2020,
    cover: 'cover-05.jpg'
  },
  {
    album: 'Northern Lights',
    artist: 'Sofia Lind',
    genre: '古典',
    language: '纯音乐',
    style: 'Neo-Classical',
    year: 2018,
    cover: 'cover-06.jpg'
  },
  {
    album: '热带低气压',
    artist: '野岸乐队',
    genre: '摇滚',
    language: '国语',
    style: '车库',
    year: 2022,
    cover: 'cover-07.jpg'
  },
  {
    album: 'Echoes',
    artist: 'Marla Quinn',
    genre: '爵士',
    language: '英语',
    style: 'Bossa Nova',
    year: 2025,
    cover: 'cover-08.jpg'
  }
]

const TITLE_WORDS = [
  '午夜电台',
  '公路尽头',
  '无人认领的信',
  '旧站台',
  '风穿过走廊',
  '蓝色时刻',
  '第七个梦',
  '灯塔以北',
  '沉默的告解',
  '十二月手记',
  '南回归线',
  '潮汐表',
  '未寄出的明信片',
  '雾中列车',
  '夏季限定',
  '阁楼上的雨'
]

/** 用确定性伪随机造数据，保证每次启动的曲库一致（便于截图比对） */
let seed = 20261012
function rand() {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff
  return seed / 0x7fffffff
}

const SONGS = []
let id = 1
for (let a = 0; a < ALBUMS.length; a += 1) {
  const meta = ALBUMS[a]
  const tracks = 4 + Math.floor(rand() * 3)
  for (let t = 1; t <= tracks; t += 1) {
    const isRemote = a === 3 && t % 3 === 0
    SONGS.push({
      id,
      type: isRemote ? 'remote' : 'local',
      title: isRemote
        ? `${TITLE_WORDS[id % TITLE_WORDS.length]}（网络源）`
        : TITLE_WORDS[id % TITLE_WORDS.length],
      artist: meta.artist,
      album: meta.album,
      year: meta.year,
      genre: meta.genre,
      language: meta.language,
      style: meta.style,
      duration: 168 + Math.floor(rand() * 190),
      file_path: isRemote
        ? null
        : `/music/${meta.artist}/${meta.album}/${String(t).padStart(2, '0')} - track.flac`,
      url: `http://localhost:${PORT}/media/${id}.flac`,
      cover_url: `/covers/${meta.cover}`,
      lyric_url: null,
      lyric_remote_url: null,
      file_size: isRemote ? 0 : 18_000_000 + Math.floor(rand() * 26_000_000),
      format: isRemote ? null : 'flac',
      bit_rate: isRemote ? 0 : 1000 + Math.floor(rand() * 400),
      sample_rate: isRemote ? 0 : 44100,
      source_url: isRemote ? 'https://music.163.com/#/song?id=mock' : null,
      source_cover_url: null,
      is_live: false,
      is_video: false,
      added_at: new Date(Date.UTC(2026, 8, 1 + (id % 40), 10, 12, 0)).toISOString(),
      updated_at: new Date(Date.UTC(2026, 9, 1, 8, 0, 0)).toISOString()
    })
    id += 1
  }
}

const PLAYLISTS = [
  {
    id: 1,
    type: 'normal',
    name: '我喜欢的音乐',
    description: null,
    cover_url: null,
    labels: [],
    sort_by: 'added_at',
    sort_order: 'desc',
    song_count: 6,
    remote_count: 0,
    pinned_at: null,
    created_at: '2026-01-04T02:00:00Z',
    updated_at: '2026-09-30T09:00:00Z'
  },
  {
    id: 2,
    type: 'radio',
    name: '电台收藏',
    description: null,
    cover_url: null,
    labels: [],
    sort_by: 'added_at',
    sort_order: 'desc',
    song_count: 0,
    remote_count: 0,
    pinned_at: null,
    created_at: '2026-01-04T02:00:00Z',
    updated_at: '2026-06-01T09:00:00Z'
  },
  {
    id: 3,
    type: 'normal',
    name: '深夜写码',
    description: '不吵、不打断思路',
    cover_url: '/covers/cover-04.jpg',
    labels: [],
    sort_by: 'position',
    sort_order: 'asc',
    song_count: 5,
    remote_count: 0,
    pinned_at: '2026-09-01T00:00:00Z',
    created_at: '2026-03-11T02:00:00Z',
    updated_at: '2026-09-20T09:00:00Z'
  },
  {
    id: 4,
    type: 'normal',
    name: '通勤路上',
    description: null,
    cover_url: '/covers/cover-07.jpg',
    labels: [],
    sort_by: 'position',
    sort_order: 'asc',
    song_count: 4,
    remote_count: 0,
    pinned_at: null,
    created_at: '2026-05-02T02:00:00Z',
    updated_at: '2026-08-14T09:00:00Z'
  }
]

const FAVORITE_IDS = [1, 5, 9, 14, 22, 31]
const PLAYLIST_SONGS = {
  3: [4, 8, 15, 21, 29],
  4: [2, 11, 18, 26]
}

const LYRICS = {
  lyric: [
    '[00:00.00]午夜电台',
    '[00:04.20]词曲 / Mock',
    '[00:12.00]把车窗摇下来一点',
    '[00:17.50]让城市的风灌进来',
    '[00:23.10]信号灯在雨里散开',
    '[00:28.60]像谁没说完的对白',
    '[00:36.00]我在午夜的电波里',
    '[00:41.40]听见了另一个自己',
    '[00:47.00]他说别停下别回头',
    '[00:52.50]前面就是你要的出口'
  ].join('\n'),
  tlyric: '',
  rlyric: '',
  // lxlyric 带逐字时间戳，用来验证卡拉OK高亮
  lxlyric: [
    '[00:12.00]<00:12.00>把<00:12.42>车<00:12.80>窗<00:13.18>摇<00:13.56>下<00:13.94>来<00:14.32>一<00:14.70>点',
    '[00:17.50]<00:17.50>让<00:17.90>城<00:18.28>市<00:18.66>的<00:19.04>风<00:19.42>灌<00:19.80>进<00:20.18>来',
    '[00:23.10]<00:23.10>信<00:23.48>号<00:23.86>灯<00:24.24>在<00:24.62>雨<00:25.00>里<00:25.38>散<00:25.76>开',
    '[00:28.60]<00:28.60>像<00:28.98>谁<00:29.36>没<00:29.74>说<00:30.12>完<00:30.50>的<00:30.88>对<00:31.26>白'
  ].join('\n')
}

/**
 * 音乐根目录下的一层文件夹。
 *
 * `song_count` **由 SONGS 现算**，不手写：手写的那一版（8 / 7 / 7 / 5 / 4，合计 31）
 * 与 `/songs/folders?path=x` 实际返回的行数（10 / 10 / 12 / 6 / 5，合计 43）对不上 ——
 * 于是「列表上写着 8 首，点进去 10 首」这种自相矛盾的 fixture 会一直躺在巡检里，
 * 而 e2e 只数目录行数，看不见它。
 */
const FOLDER_NAMES = ['陈屿', 'Marla Quinn', '野岸乐队', 'Kaito Mori', 'Sofia Lind']
const FOLDERS = FOLDER_NAMES.map((name) => ({
  name,
  path: name,
  song_count: SONGS.filter((s) => (s.file_path ?? '').includes(name)).length
}))

/* ─────────────────────── JS 插件（扩展）─────────────────────── */

/**
 * 已安装的三个插件，刻意覆盖 `status` 的三种取值：
 *
 *   active   —— 出现在扩展入口位（标题栏下拉 / 扩展侧栏各一份）
 *   inactive —— 停用，只在「插件管理」里看得见
 *   error    —— 后端正在指数退避自愈。**不是坏了**，但入口位上不出现，
 *               管理页里挂一枚「运行异常」角标（这条角标是纯前端推出来的，值得断言）
 *
 * 列表接口给的顺序（歌词补全 → 豆瓣标签 → 电台时光机）与下面的 `PLUGIN_ORDER`
 * **故意不同**：这样「侧栏顺序按 entryPath 的持久化顺序走」才是一条有内容的断言 ——
 * 两边一样的话，照抄列表顺序也能绿。
 */
const PLUGIN_WIRE = [
  {
    id: 1,
    name: '歌词补全',
    version: '1.2.0',
    entry_path: 'lyric-plus',
    status: 'active',
    author: 'Mock Labs',
    description: '从公开源补全缺失的歌词与翻译',
    homepage: 'https://example.com/lyric-plus',
    license: 'MIT',
    main: 'index.js',
    min_host_version: '1.0.0',
    permissions: ['network'],
    icon: '',
    update_url: '',
    download_url: '',
    render_engine: '',
    file_path: '/var/lib/songloft/plugins/lyric-plus',
    created_at: '2026-08-01T02:00:00Z',
    updated_at: '2026-09-20T02:00:00Z'
  },
  {
    id: 2,
    name: '豆瓣标签',
    version: '0.9.3',
    entry_path: 'douban-tags',
    status: 'inactive',
    author: 'Mock Labs',
    description: '按专辑名回填豆瓣的流派与年份',
    homepage: '',
    license: 'MIT',
    main: 'index.js',
    min_host_version: '',
    permissions: [],
    icon: '',
    update_url: '',
    download_url: '',
    render_engine: '',
    file_path: '/var/lib/songloft/plugins/douban-tags',
    created_at: '2026-07-11T02:00:00Z',
    updated_at: '2026-07-11T02:00:00Z'
  },
  {
    id: 3,
    name: '电台时光机',
    version: '2.0.1',
    entry_path: 'radio-time',
    status: 'error',
    author: 'Mock Labs',
    description: '把电台按年代做成一条时间线',
    homepage: 'https://example.com/radio-time',
    license: 'Apache-2.0',
    main: 'index.js',
    min_host_version: '1.2.0',
    permissions: ['network', 'storage'],
    icon: '',
    update_url: 'https://example.com/radio-time/update.json',
    download_url: '',
    render_engine: '',
    file_path: '/var/lib/songloft/plugins/radio-time',
    created_at: '2026-06-02T02:00:00Z',
    updated_at: '2026-09-01T02:00:00Z'
  }
]

/** 侧栏顺序（键是 entryPath）：故意与列表接口的顺序不同，见 PLUGIN_WIRE 的说明 */
const pluginOrder = { order: ['radio-time', 'lyric-plus', 'douban-tags'] }
/** 常驻白名单：只给其中一个，界面上那颗「常驻运行」要处于按下态 */
const pluginKeepAlive = { plugins: ['lyric-plus'] }
/**
 * 「GitHub 发现」的共享凭据。
 *
 * 与订阅源那份**分开**存：它存在服务端的另一个设置项里（`/settings/github-discovery-token`），
 * 而且界面刻意**不回填**它 —— 订阅源管理里那一行的输入框永远是空的，只在占位符里露出末尾四位。
 * 给一份初始值，那一行才看得见「已配置（末尾 wxyz）」这个状态。
 */
let githubDiscoveryToken = 'ghp_e2eDiscoveryTokenWXYZ'

/**
 * 订阅源。两个刻意一开一停：停用的那个在商店筛选下拉里要带「（已停用）」后缀，
 * 而商店的**聚合**列表里不该有它的条目 —— 这两个行为靠这一份数据才看得出差别。
 */
const pluginRegistries = {
  registries: [
    { url: 'https://registry.example/index.json', name: '官方源', enabled: true, token: '' },
    { url: 'https://private.example/music.json', name: '私有源', enabled: false, token: 'secret' }
  ]
}

/**
 * 商店条目。四条刻意覆盖 `describeAction` 的四档按钮：
 *   未装「安装」/ 已装且有新版本「更新至 v1.3.0」/ 已装且最新「v0.9.3」/ 撞名「覆盖安装」
 *
 * 另有一条 `warnings` —— 私有源连不上时后端就是这么报的，界面得把它显示出来
 * （否则用户只会看到「少了几条」）。聚合模式下这条警告必然出现。
 */
const REGISTRY_ENTRIES = [
  {
    name: '封面墙',
    entry_path: 'cover-wall',
    version: '3.1.0',
    description: '把当前专辑的封面铺成一面墙',
    author: 'Mock Labs',
    homepage: 'https://example.com/cover-wall',
    icon: '',
    download_url: 'https://registry.example/cover-wall-3.1.0.zip',
    installed: false,
    installed_version: '',
    has_update: false,
    source_url: 'https://registry.example/index.json',
    source_name: '官方源',
    identity: 'mock-labs',
    conflict: false,
    conflict_with: ''
  },
  {
    name: '歌词补全',
    entry_path: 'lyric-plus',
    version: '1.3.0',
    description: '从公开源补全缺失的歌词与翻译',
    author: 'Mock Labs',
    homepage: 'https://example.com/lyric-plus',
    icon: '',
    download_url: 'https://registry.example/lyric-plus-1.3.0.zip',
    installed: true,
    installed_version: '1.2.0',
    has_update: true,
    source_url: 'https://registry.example/index.json',
    source_name: '官方源',
    identity: 'mock-labs',
    conflict: false,
    conflict_with: ''
  },
  {
    name: '豆瓣标签',
    entry_path: 'douban-tags',
    version: '0.9.3',
    description: '按专辑名回填豆瓣的流派与年份',
    author: 'Mock Labs',
    homepage: '',
    icon: '',
    download_url: 'https://registry.example/douban-tags-0.9.3.zip',
    installed: true,
    installed_version: '0.9.3',
    has_update: false,
    source_url: 'https://registry.example/index.json',
    source_name: '官方源',
    identity: 'mock-labs',
    conflict: false,
    conflict_with: ''
  },
  {
    name: '专辑墙（另一作者）',
    entry_path: 'radio-time',
    version: '2.0.1',
    description: '同名不同作者：装它会覆盖本机那个',
    author: 'Other Guy',
    homepage: '',
    icon: '',
    download_url: 'https://private.example/radio-time-2.0.1.zip',
    installed: false,
    installed_version: '',
    has_update: false,
    source_url: 'https://private.example/music.json',
    source_name: '私有源',
    identity: 'other-guy',
    conflict: true,
    conflict_with: '电台时光机 · 2.0.1'
  }
]

/**
 * 插件页（`<webview>` 的 src 就指向这里）。
 *
 * 后端真的会返回一整个 HTML 页面（插件前端由服务端提供），所以这里也给一份**真页面**：
 * 巡检要验的是「宿主把 guest 装载起来了」——返回 404 会让那个 webview 停在
 * 「扩展页没能加载出来」的失败态，看起来像宿主坏了。
 */
function pluginPageHtml(entryPath) {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${entryPath}</title></head>
<body style="margin:0;font:14px system-ui;background:#101218;color:#e8e9f0">
  <h1 style="padding:20px">扩展页 ${entryPath}</h1>
  <p style="padding:0 20px">mock 后端提供的插件页面（真实后端也这么给）。</p>
</body></html>`
}

/** 插件相关路由。返回 true 表示这个请求已处理 */
function handlePlugins(req, res, path) {
  const method = req.method ?? 'GET'

  /*
   * 先认领前缀，再在分支里只管「怎么写响应」。
   *
   * 这样每个分支就只剩一件事，用不着在末尾 `return true` 一遍 ——
   * 混写会变成 `return void json(...), true` 那种逗号表达式，读的人得先解析一遍才敢改。
   * 认领的路径各自互不重叠（`jsplugins` 是列表与动作、`jsplugin/<entry>` 是插件页）。
   */
  const owned =
    path.startsWith('/api/v1/jsplugins') ||
    path.startsWith('/api/v1/jsplugin/') ||
    path.startsWith('/api/v1/settings/plugin-') ||
    /*
     * 「GitHub 发现」的凭据也在这一组里：它属于插件商店的那几条设置，只是路径前缀是
     * `settings/github-` 而不是 `settings/plugin-`。漏认领会落到外面那个「写操作一律回 200、
     * 读操作 404」的兜底上 —— 界面于是显示「读取失败」，而看上去像是客户端接错了。
     */
    path === '/api/v1/settings/github-discovery-token'
  if (!owned) return false

  const action = /^\/api\/v1\/jsplugins\/(\d+)\/(enable|disable)$/.exec(path)
  const updateOne = /^\/api\/v1\/jsplugins\/(\d+)\/update$/.exec(path)
  const checkOne = /^\/api\/v1\/jsplugins\/(\d+)\/check-update$/.exec(path)
  const deleteOne = /^\/api\/v1\/jsplugins\/(\d+)$/.exec(path)
  const byId = (id) => PLUGIN_WIRE.find((plugin) => plugin.id === Number(id))

  if (path === '/api/v1/jsplugins' && method === 'GET') {
    json(res, 200, { plugins: PLUGIN_WIRE })
  } else if (action && method === 'POST') {
    const plugin = byId(action[1])
    if (!plugin) json(res, 404, { error: '插件不存在' })
    else {
      plugin.status = action[2] === 'enable' ? 'active' : 'inactive'
      // 真实后端这里回的是 DB 里那份**原始**记录（icon 未解析），见 api/plugins.ts 的说明
      json(res, 200, { plugin })
    }
  } else if (updateOne && method === 'POST') {
    const plugin = byId(updateOne[1])
    if (plugin) json(res, 200, { plugin })
    else json(res, 404, { error: '插件不存在' })
  } else if (checkOne && method === 'GET') {
    // has_update=false 有两种含义（已是最新 / 压根没声明更新源），响应分不出来 ——
    // 所以这里统一给「没有更新」，调用方只能照这个口径显示。
    const plugin = byId(checkOne[1])
    json(res, 200, {
      has_update: false,
      current_version: plugin?.version ?? '',
      remote_version: '',
      download_url: ''
    })
  } else if (deleteOne && method === 'DELETE') {
    const index = PLUGIN_WIRE.findIndex((plugin) => plugin.id === Number(deleteOne[1]))
    if (index >= 0) PLUGIN_WIRE.splice(index, 1)
    json(res, 200, { ok: true })
  } else if (path === '/api/v1/jsplugins/update-all' && method === 'POST') {
    json(res, 200, {
      total: 3,
      updated: 0,
      failed: 0,
      skipped: 3,
      message: '没有可更新的扩展（都没有声明远程更新源）',
      results: []
    })
  } else if (path === '/api/v1/jsplugins/storage/cleanup' && method === 'POST') {
    json(res, 200, { message: '已清理 0 个扩展的残留数据', cleaned: 0 })
  } else if (path === '/api/v1/jsplugins/registry/refresh' && method === 'POST') {
    void readJsonBody(req).then((body) => {
      /*
       * 单源筛选（只给某个源）与聚合模式返回的东西**不一样**：
       *   · 聚合要跳过连不上的源，于是带一条 warnings —— 界面得把它显示出来，
       *     否则用户只会看到「少了几条」；
       *   · 单源模式下那条源是用户点名要看的，不该再混进别源的条目，也不该报别源的错。
       */
      const allSources = body?.all_sources !== false
      const single = String(body?.registry_url ?? '')
      const entries = allSources
        ? REGISTRY_ENTRIES
        : REGISTRY_ENTRIES.filter((entry) => entry.source_url === single)
      json(res, 200, {
        plugins: entries,
        total: entries.length,
        page: Number(body?.page ?? 1),
        page_size: Number(body?.page_size ?? 20),
        warnings: allSources ? ['私有源：连接超时，已跳过'] : []
      })
    })
  } else if (path === '/api/v1/jsplugins/registry/install' && method === 'POST') {
    void readJsonBody(req).then((body) =>
      json(res, 200, {
        total: 1,
        success: 1,
        failed: 0,
        results: [
          {
            file_name:
              String(body?.download_url ?? '')
                .split('/')
                .pop() ?? 'plugin.zip',
            plugin: PLUGIN_WIRE[0],
            error: '',
            success: true
          }
        ],
        message: '安装成功'
      })
    )
  } else if (path === '/api/v1/jsplugins/upload' && method === 'POST') {
    json(res, 200, { total: 1, success: 1, failed: 0, results: [], message: '安装成功' })
  } else if (path === '/api/v1/settings/plugin-order') {
    if (method !== 'PUT') json(res, 200, { ...pluginOrder })
    else
      void readJsonBody(req).then((body) => {
        if (Array.isArray(body?.order)) pluginOrder.order = body.order
        json(res, 200, { ...pluginOrder })
      })
  } else if (path === '/api/v1/settings/plugin-keep-alive') {
    if (method !== 'PUT') json(res, 200, { ...pluginKeepAlive })
    else
      void readJsonBody(req).then((body) => {
        if (Array.isArray(body?.plugins)) pluginKeepAlive.plugins = body.plugins
        json(res, 200, { ...pluginKeepAlive })
      })
  } else if (path === '/api/v1/settings/plugin-registries') {
    if (method !== 'PUT') json(res, 200, { ...pluginRegistries })
    else
      void readJsonBody(req).then((body) => {
        if (Array.isArray(body?.registries)) pluginRegistries.registries = body.registries
        json(res, 200, { ...pluginRegistries })
      })
  } else if (path === '/api/v1/settings/github-discovery-token') {
    // 「GitHub 发现」那一条的凭据：与订阅源分开存，见 githubDiscoveryToken 的说明
    if (method !== 'PUT') json(res, 200, { token: githubDiscoveryToken })
    else
      void readJsonBody(req).then((body) => {
        githubDiscoveryToken = typeof body?.token === 'string' ? body.token : ''
        json(res, 200, { token: githubDiscoveryToken })
      })
  } else if (/^\/api\/v1\/jsplugin\/[^/]+\/static\/.+$/.test(path)) {
    // 插件自己的静态资源（图标那一条免认证）：用 fixture 里那张真 JPEG 顶上
    const buf = readFileSync(join(COVER_DIR, 'cover-01.jpg'))
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': buf.length })
    res.end(buf)
  } else if (/^\/api\/v1\/jsplugin\/[^/]+$/.test(path)) {
    const body = pluginPageHtml(path.split('/').pop() ?? '')
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': Buffer.byteLength(body)
    })
    res.end(body)
  } else {
    console.warn('[mock] 未命中:', method, path)
    json(res, 404, { error: `mock 未实现: ${method} ${path}` })
  }

  return true
}

/* ─────────────────────────── 工具 ─────────────────────────── */

function json(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,PATCH,OPTIONS'
  })
  res.end(body)
}

/** 纯文本响应（导出日志那条是 text/plain 附件正文，不是 JSON） */
function text(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,PATCH,OPTIONS'
  })
  res.end(body)
}

function noContent(res) {
  res.writeHead(204, { 'Access-Control-Allow-Origin': '*' })
  res.end()
}

/**
 * 读取 JSON 请求体：空体当 `{}`，非法 JSON 返回 null。
 *
 * 真实后端对解析不了的 body 也是 400，所以调用方拿到 null 就该回 400 —— 不能当空对象放行。
 */
function readJsonBody(req) {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (chunk) => (raw += chunk))
    req.on('end', () => {
      if (!raw) return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch {
        resolve(null)
      }
    })
  })
}

function facetsOf(field) {
  const counts = new Map()
  for (const song of SONGS) {
    const raw = song[field]
    if (raw == null || raw === '') continue
    const key = String(raw)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count, cover_url: '/covers/cover-01.jpg' }))
    .sort((a, b) => b.count - a.count)
}

function songsResponse(url) {
  const q = url.searchParams
  let list = [...SONGS]
  const type = q.get('type')
  if (type && type !== 'all') list = list.filter((s) => s.type === type)
  const keyword = q.get('keyword')
  if (keyword) {
    const k = keyword.toLowerCase()
    list = list.filter((s) =>
      [s.title, s.artist, s.album, s.genre].some((v) => (v ?? '').toLowerCase().includes(k))
    )
  }
  for (const field of ['artist', 'album', 'genre', 'language', 'style']) {
    const value = q.get(field)
    if (value) list = list.filter((s) => s[field] === value)
  }
  const year = q.get('year')
  if (year) list = list.filter((s) => s.year === Number(year))
  const pathPrefix = q.get('path_prefix')
  if (pathPrefix) list = list.filter((s) => (s.file_path ?? '').includes(pathPrefix))

  const sort = q.get('sort') ?? 'added_at'
  const desc = (q.get('order') ?? 'desc') === 'desc'
  list.sort((a, b) => {
    const av = a[sort] ?? ''
    const bv = b[sort] ?? ''
    const cmp =
      typeof av === 'number' && typeof bv === 'number'
        ? av - bv
        : String(av).localeCompare(String(bv))
    return desc ? -cmp : cmp
  })

  const total = list.length
  const offset = Number(q.get('offset') ?? 0)
  const limit = Number(q.get('limit') ?? 50)
  return { songs: list.slice(offset, offset + limit), total }
}

/**
 * 导出日志的样本内容。
 *
 * 形状对齐真实后端的 `/logs/export`：**纯文本**、一行一条 slog、字段是 `key=value`。
 * 之所以强调这点：客户端若按 JSON 解它，会拿到解析失败的兜底值 —— 那种错只有真跑一次才看得见。
 */
const LOG_EXPORT_SAMPLE = [
  '2026-10-13T02:00:00.000Z INFO  app: Songloft 启动 version=v1.2.3',
  '2026-10-13T02:00:01.000Z INFO  scan: 扫描完成 songs=40',
  '2026-10-13T02:00:02.000Z WARN  cover: 封面缺失 album="野岸乐队"'
].join('\n')

/* ─────────────────────── 可变设置（需要回读的） ─────────────────────── */

/**
 * 音量均衡（EBU R128）：
 *
 * 形状对齐真实后端 `/api/v1/settings/volume-normalize` 的契约 —— `{ enabled: bool,
 * loudness: number }`（LUFS，范围 -40 ~ -5，默认 -16）。历史 mock 返回的 `target_lufs` / `mode`
 * 在后端并不存在，导致客户端的 `res.loudness ?? -16` 永远走兜底、字段名写错也发现不了。
 *
 * 取值刻意取非默认（enabled=true / loudness=-14）：与下面三个布尔开关同样的用意 ——
 * 客户端读错字段或初始状态渲染错时，非默认值才看得出来。
 */
const volumeNormalize = { enabled: true, loudness: -14 }

/**
 * PUT /api/v1/settings/volume-normalize
 *
 * 真实后端语义：`loudness` 可省略（省略=只切开关、不改响度），越界报 400 而不是夹紧；
 * 响应回显更新后的 `{ enabled, loudness }`，与随后的 GET 一致。
 */
function putVolumeNormalize(req, res) {
  void readJsonBody(req).then((body) => {
    if (body === null) return json(res, 400, { error: '请求格式错误' })
    const loudness = body.loudness ?? volumeNormalize.loudness
    if (typeof loudness !== 'number' || loudness < -40 || loudness > -5)
      return json(res, 400, { error: `音量均衡响度 ${loudness} 越界，需在 -40 ~ -5 LUFS` })
    volumeNormalize.enabled = body.enabled ?? volumeNormalize.enabled
    volumeNormalize.loudness = loudness
    return json(res, 200, { ...volumeNormalize })
  })
}

/* ──────────────────── 扫描设置 / 音乐目录（可回读） ──────────────────── */

/**
 * 音乐目录与排除目录。形状照真实后端 `MusicPathSetting` 的四个字段。
 *
 * ⚠️ 历史 mock 返回的是 `{ path, exists, song_count }` —— 与真实后端完全不符。当时看不出问题，
 * 因为客户端「排除目录」是个逗号分隔的输入框、从没读过 `exclude_*`。现在排除目录是
 * 「名称 / 路径 / 歌单」三个列表，读错字段会直接表现为三个空列表，所以必须对齐。
 *
 * 三个列表都刻意非空：空数组时「字段读错了」与「本来就没配」长得一模一样。
 */
const MUSIC_ROOT = '/music'

const musicPath = {
  path: MUSIC_ROOT,
  exclude_dirs: ['@eaDir', 'Covers'],
  exclude_paths: [`${MUSIC_ROOT}/Downloads`],
  auto_create_exclude_dirs: ['Downloads']
}

function putMusicPath(req, res) {
  void readJsonBody(req).then((body) => {
    // 真实后端：path 不能为空，否则 400（PUT 是一次覆盖写，三个排除列表必须一起带上）
    if (body === null || typeof body.path !== 'string' || body.path.trim() === '')
      return json(res, 400, { error: '音乐根目录不能为空' })
    Object.assign(musicPath, body)
    return json(res, 200, { ...musicPath })
  })
}

/**
 * 音乐目录树（`/scan/directories` 懒加载：一次一层）。
 *
 * ⚠️ 这里曾返回 `{ directories: ['/music'], music_path: '/music' }`，真实契约是
 * `{ directories: [{ name, path, has_children }], root }`。同样是「当时没人调用所以看不出来」——
 * 「路径排除」的目录树用上它之后立刻暴露：`entry.path` 全是 undefined，
 * React key 重复、点选也拿不到路径。
 */
const DIR_TREE = {
  [MUSIC_ROOT]: ['Albums', 'Live', 'Downloads'],
  [`${MUSIC_ROOT}/Albums`]: ['Singles', 'Compilations'],
  [`${MUSIC_ROOT}/Albums/Singles`]: [],
  [`${MUSIC_ROOT}/Albums/Compilations`]: [],
  [`${MUSIC_ROOT}/Live`]: [],
  [`${MUSIC_ROOT}/Downloads`]: []
}

const DIR_NAMES = ['Albums', 'Live', 'Downloads', 'Singles', 'Compilations', 'Covers', '@eaDir']

/**
 * 「读回一个开关/枚举」形状的设置。一律做成可回读：PUT 之后再 GET 必须返回刚写进去的值 ——
 * 客户端的写法正是「PUT 之后 reload 回读」，mock 不回读的话，界面会静默退回旧值，
 * 于是「到底写没写进去」在 e2e 里永远看不出来。
 *
 * 取值刻意多数非默认，理由同上：全默认值时「读错字段」与「读对了」渲染结果一样。
 */
const mutableSettings = {
  'scan-auto-create-playlists': { enabled: true },
  'scan-playlist-mode': { mode: 'top_level' },
  // 两个「标题来源」是不同设置、默认值还相反（这条默认 filename，上面那条默认 tag），
  // mock 里刻意都取非默认值，免得「读错端点」看起来跟读对了一样
  'scan-title-source': { title_source: 'filename' },
  'remote-title-source': { title_source: 'tag' },
  'scan-auto-fingerprint': { enabled: false },
  'tag-sync-to-file': { enabled: false },
  'auto-scan': { enabled: true, interval_seconds: 1800 },
  // 三个代理端点：真实后端是「一对 GET/PUT + 单字段」的形状（`{proxy}` / `{allowlist}`）。
  // 一律取非空值 —— 空串/空数组正是它们的默认值，读错字段时看起来跟读对了一样。
  'http-proxy': { proxy: 'http://192.168.1.9:7890' },
  'github-proxy': { proxy: 'https://gh-proxy.example' },
  'proxy-private-allowlist': { allowlist: ['192.168.1.0/24'] },
  'hls-proxy': { enabled: true },
  // 日志等级：默认是 info，这里取 debug —— 界面若没真读到端点会显示兜底的 Info，一眼可辨
  'log-level': { level: 'debug' }
}

/* ───────────────────────── 缓存配置（可回读） ───────────────────────── */

/**
 * 缓存配置。形状照真实后端 `CacheConfigResponse`（含只读的 `default_cache_dir`）。
 *
 * 与上面那批设置同样的规矩：PUT 之后 GET 必须返回刚写进去的值，否则界面静默退回旧值。
 * 取值刻意非默认（转码开着、上限 2GB）：全默认值时「读错字段」与「读对了」渲染结果一样。
 *
 * 注：PUT 收的是 `CacheConfigInput`，不含 `default_cache_dir` —— 所以是 Object.assign
 * 而不是整份替换，否则那个只读字段会被抹掉。
 */
const cacheConfig = {
  max_size: 2 * 1024 ** 3,
  cache_dir: '',
  default_cache_dir: '/var/lib/songloft/music_cache',
  transcode_format: 'mp3',
  transcode_quality: '320'
}

function handleCacheConfig(req, res) {
  if (req.method !== 'PUT') return json(res, 200, { ...cacheConfig })
  return void readJsonBody(req).then((body) => {
    if (body === null) return json(res, 400, { error: '请求参数无效' })
    Object.assign(cacheConfig, body)
    return json(res, 200, { ...cacheConfig })
  })
}

function handleMutableSetting(req, res, key) {
  const current = mutableSettings[key]
  if (req.method !== 'PUT') return json(res, 200, { ...current })
  return void readJsonBody(req).then((body) => {
    if (body === null) return json(res, 400, { error: '请求格式错误' })
    Object.assign(current, body)
    return json(res, 200, { ...current })
  })
}

/* ─────────────────────────── 路由 ─────────────────────────── */

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`)
  const path = url.pathname

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,PATCH,OPTIONS'
    })
    res.end()
    return
  }

  // 封面 / 音频等媒体：走真实文件
  if (path.startsWith('/covers/')) {
    const file = join(COVER_DIR, path.slice('/covers/'.length))
    if (!existsSync(file)) return json(res, 404, { error: 'no cover' })
    const buf = readFileSync(file)
    res.writeHead(200, {
      'Content-Type': 'image/jpeg',
      'Content-Length': buf.length,
      'Access-Control-Allow-Origin': '*'
    })
    res.end(buf)
    return
  }

  // 音频：给一段极短的静音 WAV，让 <audio> 能真的 load/play 起来（只为验证链路）
  if (path.startsWith('/media/')) {
    const rate = 8000
    const secs = 30
    const samples = rate * secs
    const buf = Buffer.alloc(44 + samples)
    buf.write('RIFF', 0)
    buf.writeUInt32LE(36 + samples, 4)
    buf.write('WAVE', 8)
    buf.write('fmt ', 12)
    buf.writeUInt32LE(16, 16)
    buf.writeUInt16LE(1, 20)
    buf.writeUInt16LE(1, 22)
    buf.writeUInt32LE(rate, 24)
    buf.writeUInt32LE(rate, 28)
    buf.writeUInt16LE(1, 32)
    buf.writeUInt16LE(8, 34)
    buf.write('data', 36)
    buf.writeUInt32LE(samples, 40)
    buf.fill(128, 44)
    res.writeHead(200, {
      'Content-Type': 'audio/wav',
      'Content-Length': buf.length,
      'Accept-Ranges': 'bytes',
      'Access-Control-Allow-Origin': '*'
    })
    res.end(buf)
    return
  }

  // 插件（扩展）那一整块自成一路：前缀先认领，内部再分派
  if (handlePlugins(req, res, path)) return

  if (path === '/health') return json(res, 200, { status: 'ok' })
  if (path === '/api/v1/version') {
    // 版本号刻意取「正式发版」的形态：真实后端在发版构建里注入的是 git tag 原值（自带 v）。
    // 客户端若再无条件拼一个 v，界面上就是 vv2.13.1 —— 账号分区的断言正是按这个整串比的，
    // 而 includes('v2.13.1') 抓不到它（vv2.13.1 本身就包含 v2.13.1）。
    return json(res, 200, {
      version: 'v2.13.1',
      git_commit: 'mockcafe',
      build_time: '2026-10-12T10:00:00Z'
    })
  }

  if (path === '/api/v1/auth/login' && req.method === 'POST') {
    return json(res, 200, {
      access_token: 'mock-access-token',
      refresh_token: 'mock-refresh-token',
      expires_in: 86400,
      token_type: 'Bearer'
    })
  }
  if (path === '/api/v1/auth/refresh' && req.method === 'POST') {
    return json(res, 200, {
      access_token: 'mock-access-token-2',
      refresh_token: 'mock-refresh-token-2',
      expires_in: 86400,
      token_type: 'Bearer'
    })
  }
  if (path === '/api/v1/auth/logout') return noContent(res)
  if (path === '/api/v1/auth/tokens') {
    // 真实后端既发 access 也发 refresh（access 短命、一次登录可能刷出好几个）。
    // 登录设备列表只认 refresh，所以这里两种都给，否则那个列表永远是空的。
    return json(res, 200, {
      tokens: [
        {
          id: 1,
          token_id: 'mock-token-1',
          token_type: 'access',
          client_info: 'Songloft Desktop (Linux)',
          expires_at: '2026-10-13T10:00:00Z',
          revoked_at: null,
          created_at: '2026-10-12T10:00:00Z'
        },
        {
          id: 2,
          token_id: 'mock-token-2',
          token_type: 'refresh',
          client_info: 'Songloft Desktop (Linux)',
          expires_at: '2026-11-12T10:00:00Z',
          revoked_at: null,
          created_at: '2026-10-12T10:00:00Z'
        }
      ],
      total: 2
    })
  }

  if (path === '/api/v1/songs') return json(res, 200, songsResponse(url))
  if (path === '/api/v1/songs/ids') {
    const r = songsResponse(url)
    return json(res, 200, { ids: r.songs.map((s) => s.id), total: r.total })
  }
  if (path === '/api/v1/songs/stats') {
    return json(res, 200, {
      total_songs: SONGS.length,
      local_songs: SONGS.filter((s) => s.type === 'local').length,
      remote_songs: SONGS.filter((s) => s.type === 'remote').length,
      radio_songs: 0,
      total_duration: SONGS.reduce((acc, s) => acc + s.duration, 0),
      total_file_size: SONGS.reduce((acc, s) => acc + s.file_size, 0),
      artist_count: new Set(SONGS.map((s) => s.artist)).size,
      album_count: new Set(SONGS.map((s) => s.album)).size,
      genre_count: new Set(SONGS.map((s) => s.genre)).size
    })
  }
  if (path === '/api/v1/songs/facets') {
    const field = url.searchParams.get('field') ?? 'artist'
    const facets = facetsOf(field)
    return json(res, 200, { facets, total: facets.length })
  }
  if (path === '/api/v1/songs/folders') {
    const cur = url.searchParams.get('path') ?? ''
    const songs = cur ? SONGS.filter((s) => (s.file_path ?? '').includes(cur)) : []
    return json(res, 200, {
      path: cur,
      parent_path: cur ? cur.split('/').slice(0, -1).join('/') : '',
      music_path: '/music',
      folders: cur ? [] : FOLDERS,
      total_folders: cur ? 0 : FOLDERS.length,
      songs,
      total_songs: songs.length
    })
  }
  if (path === '/api/v1/songs/clean' && req.method === 'POST') {
    return json(res, 200, { total: 0, file_not_found: 0, removed: 0 })
  }
  if (path === '/api/v1/songs/duplicates') {
    return json(res, 200, {
      groups: [
        {
          fingerprint: 'mockfp1',
          songs: [SONGS[0], SONGS[1]],
          reason: 'duration+title'
        }
      ],
      total: 1
    })
  }
  if (path === '/api/v1/songs/batch-delete' && req.method === 'POST')
    return json(res, 200, { deleted: 0 })

  let m = /^\/api\/v1\/songs\/(\d+)$/.exec(path)
  if (m) {
    const song = SONGS.find((s) => s.id === Number(m[1]))
    return song ? json(res, 200, song) : json(res, 404, { error: '歌曲不存在' })
  }
  m = /^\/api\/v1\/songs\/(\d+)\/lyric$/.exec(path)
  if (m) return json(res, 200, LYRICS)
  m = /^\/api\/v1\/songs\/(\d+)\/played$/.exec(path)
  if (m) return noContent(res)
  m = /^\/api\/v1\/songs\/(\d+)\/audio-tracks$/.exec(path)
  if (m) return json(res, 200, { tracks: [], total: 0 })
  m = /^\/api\/v1\/songs\/(\d+)$/.exec(path)
  if (m) return json(res, 200, SONGS.find((s) => s.id === Number(m[1])) ?? {})

  if (path === '/api/v1/playlists')
    return json(res, 200, { playlists: PLAYLISTS, total: PLAYLISTS.length })
  m = /^\/api\/v1\/playlists\/(\d+)\/song-ids$/.exec(path)
  if (m) {
    const pid = Number(m[1])
    if (pid === 1) return json(res, 200, { ids: FAVORITE_IDS })
    if (pid === 2) return json(res, 200, { ids: [] })
    return json(res, 200, { ids: PLAYLIST_SONGS[pid] ?? [] })
  }
  m = /^\/api\/v1\/playlists\/(\d+)\/songs$/.exec(path)
  if (m) {
    const pid = Number(m[1])
    const ids = pid === 1 ? FAVORITE_IDS : (PLAYLIST_SONGS[pid] ?? [])
    const songs = ids.map((sid) => SONGS.find((s) => s.id === sid)).filter(Boolean)
    return json(res, 200, { songs, total: songs.length })
  }
  m = /^\/api\/v1\/playlists\/(\d+)$/.exec(path)
  if (m) {
    const pl = PLAYLISTS.find((p) => p.id === Number(m[1]))
    return pl ? json(res, 200, pl) : json(res, 404, { error: '歌单不存在' })
  }
  if (/^\/api\/v1\/playlists\/\d+\/(songs|cover|pin|visibility|sort|touch|reorder)/.test(path)) {
    return path.endsWith('/songs') && req.method === 'POST'
      ? json(res, 200, { added: 1 })
      : json(res, 200, { ok: true })
  }
  if (path === '/api/v1/playlists' && req.method === 'POST') {
    return json(res, 201, { ...PLAYLISTS[3], id: 99, name: '新歌单' })
  }
  // 歌单备份（设置页「数据管理」分区的导出）。
  // 形状照真实后端 `models.BackupData`：歌单只带 name/type/description/labels/songs，
  // **不**带 id / 时间戳 —— 导入侧就是按 name 合并的，多带 id 会让人误以为能靠它还原。
  if (path === '/api/v1/playlists/export') {
    return json(res, 200, {
      version: 1,
      exported_at: '2026-10-13T10:00:00Z',
      playlists: PLAYLISTS.filter((p) => p.type === 'normal').map((p) => ({
        name: p.name,
        type: p.type,
        description: p.description ?? '',
        labels: p.labels,
        songs: (p.id === 1 ? FAVORITE_IDS : (PLAYLIST_SONGS[p.id] ?? [])).map((sid) => {
          const song = SONGS.find((s) => s.id === sid)
          return {
            type: song?.type ?? 'local',
            title: song?.title ?? '',
            artist: song?.artist ?? '',
            album: song?.album ?? '',
            duration: song?.duration ?? 0,
            file_path: song?.file_path ?? '',
            url: song?.url ?? '',
            cover_url: song?.cover_url ?? '',
            file_size: song?.file_size ?? 0,
            format: song?.format ?? '',
            bit_rate: song?.bit_rate ?? 0,
            sample_rate: song?.sample_rate ?? 0,
            is_live: false,
            plugin_entry_path: '',
            source_data: '',
            dedup_key: ''
          }
        })
      }))
    })
  }

  if (path === '/api/v1/scan') return noContent(res)
  if (path === '/api/v1/scan/progress') {
    return json(res, 200, {
      status: 'idle',
      current_file: null,
      discovered_files: 0,
      total_files: 0,
      scanned_files: 0,
      imported_files: 0,
      skipped_files: 0,
      failed_files: 0,
      cue_split_sources: 0,
      local_song_count: SONGS.filter((s) => s.type === 'local').length
    })
  }
  if (path === '/api/v1/scan/directories') {
    const dir = url.searchParams.get('path') || MUSIC_ROOT
    return json(res, 200, {
      root: MUSIC_ROOT,
      directories: (DIR_TREE[dir] ?? []).map((name) => ({
        name,
        path: `${dir}/${name}`,
        has_children: (DIR_TREE[`${dir}/${name}`] ?? []).length > 0
      }))
    })
  }
  if (path === '/api/v1/scan/dir-names') return json(res, 200, { names: DIR_NAMES })
  if (path === '/api/v1/scan/fingerprints/status') {
    return json(res, 200, {
      chromaprint_available: true,
      total: SONGS.length,
      computed: Math.floor(SONGS.length * 0.8),
      missing: Math.ceil(SONGS.length * 0.2),
      failed: 0,
      auto_enabled: false
    })
  }
  // 指纹任务没在跑：设置页进页会读一次进度，缺了它只会打一条「未命中」告警
  if (path === '/api/v1/scan/fingerprints/progress')
    return json(res, 200, { status: 'idle', computed: 0, total: 0, failed: 0 })
  if (path === '/api/v1/scan/fingerprints/failed') return json(res, 200, { items: [], total: 0 })
  if (path === '/api/v1/songs/refresh-metadata') return json(res, 202, {})
  if (path === '/api/v1/songs/refresh-metadata/progress')
    return json(res, 200, { status: 'idle', total: 0, processed: 0, failed: 0 })
  if (path === '/api/v1/settings/music-path') {
    if (req.method === 'PUT') return putMusicPath(req, res)
    return json(res, 200, { ...musicPath })
  }
  if (path === '/api/v1/settings/volume-normalize') {
    if (req.method === 'PUT') return putVolumeNormalize(req, res)
    return json(res, 200, { ...volumeNormalize })
  }
  const settingKey = path.startsWith('/api/v1/settings/')
    ? path.slice('/api/v1/settings/'.length)
    : ''
  if (settingKey in mutableSettings) return handleMutableSetting(req, res, settingKey)
  if (path.startsWith('/api/v1/configs/'))
    return json(res, 200, { key: path.split('/').pop(), value: '' })
  // 缓存管理：设置页「缓存管理」分区进页就读 stats + config，缺了会打「未命中」并把界面画成读取失败
  if (path === '/api/v1/cache-manage/config') return handleCacheConfig(req, res)
  if (path === '/api/v1/cache-manage/stats') {
    // max_size 由配置决定（真实后端也是这样算的），所以改了上限这里跟着变
    return json(res, 200, {
      total_size: 640 * 1024 ** 2,
      file_count: 137,
      max_size: cacheConfig.max_size
    })
  }
  if (path === '/api/v1/cache-manage/validate-dir') {
    // 真实后端：非绝对路径也返回 200，但只带 error（`valid` 为 false）
    return void readJsonBody(req).then((body) =>
      json(
        res,
        200,
        typeof body?.path === 'string' && body.path.startsWith('/')
          ? { valid: true, created: false, total_size: 512 * 1024 ** 3, free_size: 128 * 1024 ** 3 }
          : { valid: false, created: false, total_size: 0, free_size: 0, error: '必须为绝对路径' }
      )
    )
  }
  // 升级检查：真实后端**只有 Docker 部署**才有这个端点，这里一律当作 Docker 并汇报「有新版本」——
  // 无更新时「读错字段」与「读对了」渲染出来是同一句话，看不出区别。
  if (path === '/api/v1/upgrade/check') {
    return json(res, 200, {
      is_docker: true,
      has_update: true,
      current_version: '1.4.2',
      current_channel: 'stable',
      current_build_type: 'docker',
      latest_version: '1.5.0',
      release_notes: '- 缓存目录切换后立即生效\n- 新增缓存转码码率选择',
      // 嵌套的 updates 是真实后端的形状（以通道为键）。两条通道取**不同**的版本号，
      // 这样界面上的选择项才看得出是在按通道取，而不是把同一个值画了两遍。
      updates: {
        stable: {
          type: 'stable',
          version: '1.5.0',
          build_time: '2026-10-12T10:00:00Z',
          release_notes: '- 缓存目录切换后立即生效\n- 新增缓存转码码率选择'
        },
        dev: {
          type: 'dev',
          version: '1.6.0-dev.3',
          build_time: '2026-10-13T02:00:00Z',
          release_notes: '- 试试新的分面聚合'
        }
      }
    })
  }
  // 升级进度：没有升级在跑时后端就是 idle（弹窗打开时会先问一句，别看错当成在升级）
  if (path === '/api/v1/upgrade/progress') {
    return json(res, 200, { status: 'idle', progress: 0, current_step: '' })
  }
  // 导出日志：真实后端给的是 text/plain 附件正文（逐行脱敏后的落盘日志），不是 JSON、也不是 zip
  if (path === '/api/v1/logs/export') {
    return text(res, 200, LOG_EXPORT_SAMPLE)
  }

  // 兜底：把未实现的写操作都当成功，避免界面卡在 loading
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method ?? ''))
    return json(res, 200, { ok: true })

  console.warn('[mock] 未命中:', req.method, path)
  return json(res, 404, { error: `mock 未实现: ${req.method} ${path}` })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock] Songloft mock 后端已启动 http://127.0.0.1:${PORT}（曲库 ${SONGS.length} 首）`)
})
