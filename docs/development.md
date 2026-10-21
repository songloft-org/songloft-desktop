# 开发指南

面向**人**的开发说明。

同一份事实的另一种版本是 [`../AGENTS.md`](../AGENTS.md) —— 面向 AI 编码代理，侧重「改哪里、
别踩哪个坑」；那些雷区的**因果推导**（为什么桌面身份不能以 `.desktop` 结尾、图标渲染为什么
会静默丢渐变、歌词为什么会丢行…）只在 AGENTS.md 里，本文只给结论与出处，不重复论证。

功能清单与「与上游 Flutter 版的差异」见 [`../README.md`](../README.md)。

---

## 1. 环境要求

| 项 | 要求 | 说明 |
|---|---|---|
| Node.js | **>= 22.12.0** | 主进程与渲染层都用 ES2023+；端到端巡检依赖全局 `WebSocket` |
| pnpm | 12.x | `package.json` 的 `packageManager` 已锁 `pnpm@12.4.1` |
| Songloft 后端 | 默认 `http://localhost:58091` | 本仓库**不含后端**。默认管理员 `admin` / `admin` |

没会话时应用不会崩：默认进免登录模式（落点是「本地文件」那一页），要连服务器点侧栏那颗
「连接服务器」；后端没起来时登录页会以「服务器连接失败」给出可操作的提示。

> 构建环境若导出 `ELECTRON_RUN_AS_NODE=1`（部分 agent / CI 的 shell 会这么干），Electron 会
> 退化成纯 Node，主进程一启动就崩。本地跑脚本或调试时记得 `env -u ELECTRON_RUN_AS_NODE`。

---

## 2. 快速开始

```bash
pnpm install              # postinstall 会拉 Electron 二进制
pnpm dev                  # 开发（渲染层 HMR）

pnpm run check            # ★ 提交前必跑：typecheck + lint + format:check + test
pnpm run build            # 产出 out/（main + preload + renderer）
pnpm run e2e              # 端到端 UI 巡检（起 mock 后端 + 截图 + 断言）
pnpm run shots            # 把巡检截图整理成文档用图（docs/screenshots + 汇总图）
pnpm run pack:linux       # 打 deb / AppImage / tar.gz 到 release/
pnpm run pack:win         # 打 NSIS 安装包（要在 Windows 上跑）
pnpm run pack:mac         # 打 dmg / zip（要在 macOS 上跑）
pnpm run verify:package   # 校验打包产物的桌面集成项（只覆盖 Linux 产物）
pnpm run icons            # 由 build/icon.svg 生成全套图标 + 托盘图
pnpm run audit            # 依赖安全公告（刻意不进 check 的必过路径）
```

### 脚本一览

| 脚本 | 作用 |
|---|---|
| `dev` | electron-vite 开发服务器，渲染层 HMR |
| `build` | 先 `typecheck` 再 `electron-vite build`，产物在 `out/` |
| `typecheck` | 分别检查主进程侧（`tsconfig.node.json`）与渲染层侧（`tsconfig.web.json`） |
| `test` | vitest，覆盖 `src/shared` 与 `src/renderer/src/lib` 里的纯函数 |
| `lint` / `format` | ESLint flat config / Prettier |
| `audit` | `pnpm audit --audit-level=high`（安全公告会随时新增，不挡构建） |
| `icons` | 从 `build/icon.svg` 渲染全套尺寸 + 托盘图，并断言渐变没丢 |
| `pack:*` | electron-builder 打包，输出到 `release/`（`pack:linux` / `pack:deb` / `pack:appimage`；`pack:win` / `pack:mac` 要在对应平台上跑） |
| `verify:package` | 校验 `.desktop` 文件名、`StartupWMClass`、AppArmor profile、托盘资源等 |
| `desktop:install` / `desktop:uninstall` | 把本应用（或某个 AppImage）注册 / 注销到当前用户桌面目录 —— 为什么需要它见 `README.md` 的「任务栏图标」一节 |
| `release` | `bumpp`：升版本 → 提交 → 打 `v*` 标签 → 推送，之后由 CI 三平台发布 |
| `e2e` | 端到端巡检，见第 7 节 |
| `shots` | 把 `.e2e/shots` 里的巡检截图整理成 `docs/screenshots/` 与覆盖图（详见第 7 节） |

---

## 3. 目录结构

```
src/
├─ main/          Electron 主进程（Node 环境，唯一持有系统权限的地方）
│  ├─ index.ts        生命周期、窗口创建、安全策略与 CSP、setDesktopName、userData 覆盖
│  ├─ windows.ts      BrowserWindow 构造（contextIsolation / sandbox / nodeIntegration）
│  ├─ mini-window.ts  迷你播放器窗口：几何 / 两种身份（跟随者 | 宿主 → 本地文件会话）
│  ├─ local-files.ts  本地文件的收件口（启动参数 / macOS open-file / 对话框；排队 + 摇铃）
│  ├─ media-protocol.ts 本地文件的媒体协议 songloft-media://（按 Range 读字节）
│  ├─ app-icon.ts     窗口图标定位（只对 X11 / Windows / macOS 有效；Wayland 那份传不出去）
│  ├─ media-keys.ts   媒体键（globalShortcut 兜底；优先走 Media Session 自动映射）
│  ├─ store.ts        本地持久化：设置 / 凭据 / 服务器列表（JSON，落在 userData）
│  ├─ cache.ts        本机磁盘缓存（Chromium 会话缓存）的占用 / 清理 / 启动上限
│  ├─ files.ts        导出 / 导入的文本文件对话框（读入限 32MB）
│  ├─ probe.ts        后端探测与封面取字节（本地解码，避免为它关掉 webSecurity）
│  ├─ tray.ts         托盘图标与菜单
│  └─ app-menu.ts     应用菜单（窗口无边框、看不到菜单栏，但它提供全局加速键）
├─ preload/        contextBridge 白名单 —— 渲染层唯一的对外通道（window.songloft）
├─ shared/         两侧共用的**纯代码**，无副作用、可直接单测（多数带同名 .test.ts）
│  ├─ types.ts        后端数据模型（Song / Playlist / Facet…）
│  ├─ ipc.ts          IPC 频道常量 + 跨进程传输的类型 + 默认设置
│  ├─ bridge.ts       window.songloft 的接口定义（白名单的唯一事实源）
│  ├─ bridge-types.ts 桥接层的小类型（放这里避免 shared/bridge 反向依赖主进程代码）
│  ├─ lyric.ts        歌词四路合并 + 解析 + 当前行/逐字定位
│  ├─ plugin.ts       JS 插件模型 / 排序纯函数 / 扩展页 URL 拼接 / PLUGIN_PARTITION
│  ├─ data.ts         两份数据快照是否等价（页面切回时的静默刷新靠它）
│  ├─ window-role.ts  「这个渲染进程是哪种窗口」的契约（主进程写 hash、渲染层读）
│  ├─ version.ts      版本号比较（认不出来的写法一律判「不比它新」）
│  └─ links.ts        对外 URL 常量（本仓库 / 上游）
└─ renderer/       React 19 + zustand
   ├─ api/           client.ts（fetch 封装）/ endpoints.ts（端点清单，来自上游 Flutter 实现）/
   │                 plugins.ts（JS 插件：列表 / 启停 / 卸载 / 顺序 / 商店）
   ├─ state/         useAuth / usePlayer（按窗口角色分流）/ usePlaylists / useSettings / useUi /
   │                 useToasts / player-core（**播放核心**：音频 / 队列 / 歌词，与窗口形态无关）/
   │                 remotePlayer（宿主的镜像）/ local-session（本地文件会话的启动编排）/
   │                 media-commands（托盘 / 媒体键的命令，两个宿主窗口共用）/
   │                 usePlugins（已装扩展 + 顺序 + 运行时音频状态，唯一事实源）/
   │                 useLibrary（曲库数据的版本号 + 后台任务守望）
   ├─ pages/         10 个页面：Home / Library / Playlists / PlaylistDetail / Favorites /
   │                 Recent / Search / Settings / Login / Extensions
   │                 （同目录还有 PluginStore —— 扩展面的「插件商店」那一栏；
   │                  以及两个页内视图 FoldersView / LocalFilesView —— 「文件夹」与「本地文件」
   │                  都不是独立页面，是 LibraryPage 一页三份内容里的两份，见 AGENTS.md 第 4 节）
   ├─ components/    Sidebar / TitleBar / SongTable / PlayerBar / LyricsView / CommandPalette /
   │                 Panel / ContextMenu / Modal / Toasts / SelectionBar / FullPlayer /
   │                 MiniPlayer / ExtensionFrame / PluginSurface / RegistrySourcesDialog / …
   ├─ hooks/         useSongList / usePlaylistSongs / useAsync / usePageActive /
   │                 useResponsiveSidebar / useHorizontalScroll
   ├─ lib/           url / color / accent / format / concurrency / responsive / plugin-actions /
   │                 window-role（「我在哪个窗口里」+「我是不是宿主」）
   └─ styles/        tokens.css / base.css / components.css / index.css
```

> 两条容易看错的地方：**侧栏只有一个「曲库」入口** —— `LibraryPage` 一页三份内容
> （服务器的曲库 / 服务器的文件夹 / 本机磁盘上的文件），由页头那颗「本地 / 服务器」切换
> 决定看哪一份（「服务器」那一格里还嵌着「曲库 / 文件夹」两颗子选项）；
> 而**「扩展」那一整面不在 `renderRoute` 的 switch 里** —— 它有自己的路由与侧栏，
> 详见 [`../AGENTS.md`](../AGENTS.md) 第 4 节。

技术栈版本表见 [`../AGENTS.md`](../AGENTS.md) 第 2 节。

---

## 4. 架构与数据流

1. **渲染层是「不可信的」**，所有系统能力经 `preload` 白名单（`window.songloft`）转出，
   注册在 `src/shared/bridge.ts`，实现在 `src/preload/index.ts`，由 `ipcRenderer.invoke` 落到主进程。
2. **IPC 频道名一律用 `IPC` 常量**（`@shared/ipc`），不要写字符串字面量 —— 先加常量再接线。
3. **播放**走 `HTMLAudioElement` + **Media Session API**。Chromium 会把它自动映射成 Linux 的
   MPRIS / Windows 的 SMTC / macOS 的 Now Playing，**不需要**为每个平台写原生桥。
   键盘媒体键另走 `globalShortcut` 兜底。
   ★ **谁在播**由**窗口角色**决定（`shared/window-role.ts`）：**宿主**（主窗口，或本地文件会话
   里那个迷你窗）持有播放核心 `state/player-core.ts`，另一侧是它的镜像；`usePlayer.ts` 是那个
   分流点。双击音频文件起的那一趟**没有主窗口**，详见 [`../AGENTS.md`](../AGENTS.md) 的 §8.17。
4. **媒体地址带 `access_token` 查询参数**（`lib/url.ts`）：封面/音频是交给 `img` / `audio`
   直接请求的，走不了带 `Authorization` 头的 fetch 封装。
5. **封面取主色由主进程代取字节**（`cover:extract`）：渲染层直接读跨域 `canvas` 会污染画布。
6. **持久化只在主进程**（`store.ts`）：设置（本地偏好）/ 凭据（token）/ 服务器列表。
   渲染层启动时拉一次，之后靠 IPC 读写。

- **为什么 `store.ts` 用「临时文件 + rename」落盘**：避免掉电/崩溃留下半截 JSON 把配置读挂。
- **为什么 CSP 只在打包态注入**：开发态要连 HMR 的 websocket 与 react-refresh 的内联脚本，
  套上 CSP 会直接打断热更新 —— 这里是刻意的取舍。

---

## 5. 安全模型

| 措施 | 设置 | 为什么 |
|---|---|---|
| 上下文隔离 | `contextIsolation: true` | 渲染层拿不到 preload 的作用域 |
| 沙箱 | `sandbox: true` | preload 也跑在沙箱里（因此 preload 产物必须是 CJS） |
| Node 集成 | `nodeIntegration: false` | 渲染层没有 `require` / `process` |
| 渲染层禁 import | ESLint 规则拦 `electron` / `node:fs` / `node:child_process` | 防止依赖被随手引进渲染层 |
| CSP | **仅打包态**注入 | 开发态要连 HMR 的 websocket 与 react-refresh 内联脚本，套 CSP 会打断热更新 |
| 导航围栏 | 所有外部链接交给 `shell.openExternal` | 窗口本身不允许被导航到外部页面 |
| 权限请求 | 一律拒绝 | 播放器不需要麦克风/摄像头/通知/地理位置 |
| 自签证书 | 只对当前 session 放开校验 | 自建后端常用自签证书，但不能全局降低校验 |
| 封面取色 | 主进程代取字节 | 直接在渲染层 canvas 读跨域封面会污染画布 |

---

## 6. 打包与桌面集成

### 6.1 三平台的产物

三端都出安装包，由 [`.github/workflows/release.yml`](../.github/workflows/release.yml) 在各自平台的
runner 上**并行构建**，三份全绿才创建 Release（任何一个平台失败都不留半份已发布的 Release）：

| 平台 | 产物 | 在哪构建 |
|---|---|---|
| Windows x64 | NSIS `.exe` + 免安装 `.zip` | `windows-latest` —— `makensis` 与 .exe 的图标/版本资源只在 Windows 上可用 |
| macOS arm64 / x64 | `.dmg` / `.zip` | `macos-latest` —— dmg 走系统的 `hdiutil` |
| Linux x64 | `.deb` / `AppImage` / `.tar.gz` | `ubuntu-24.04` |

Windows 那份 `.zip` 是**免安装（绿色）版**：解压即用、不写注册表，用户数据落在解压目录的
`data\` 下（整个文件夹拷走即带走全部配置）。它靠 exe 旁边一个标记文件认自己，而安装包装完之后
会把那个标记删掉 —— 所以 `win.extraFiles` 与 `build/installer.nsh` 是一件事的两半，缺一个都会
静默让安装版把数据写进安装目录（详见 [AGENTS.md](../AGENTS.md) §8.18）。

**跨平台打包不可行**：`pack:win` / `pack:mac` 只能在对应系统上跑，Linux 上只有 `pack:linux` 那一条
能验证。所以改了 `electron-builder.yml` 的 `win:` / `mac:` / `nsis:` 段之后，别只跑 `pnpm run check`
就算完事 —— 要么推一个 tag，要么在 Actions 里手动触发 release 工作流（`workflow_dispatch`）。

三平台**共用同一张位图母版** `build/icon-source.png`：`win.icon` 与 `mac.icon` 都直接指它，由
electron-builder 自己转 `.ico` / `.icns`。`scripts/make-icons.sh` 因此只需产 PNG（Linux 那套
hicolor 尺寸目录）与托盘图，**不必**额外产出 `.ico` / `.icns`。

仍未落地的两件事：

* **macOS 产物未签名、未公证**：CI 里没有证书，`release.yml` 用 `CSC_IDENTITY_AUTO_DISCOVERY=false`
  关掉身份探测，用户首次打开会被 Gatekeeper 拦下（放行办法见 [`../README.md`](../README.md)）。
* **macOS 的窗口形态**：窗口控制钮是渲染层自绘的，仍停在右上角，与系统惯例（左上角）不符。

### 6.2 Linux 侧会静默失败的点

Linux 侧有几个会**静默失败**（不报错，但产物在用户机器上是坏的）的点。完整因果推导见
[`../AGENTS.md`](../AGENTS.md) 第 8 节，这里只列结论：

1. **`.desktop` 文件名 / `StartupWMClass` / `setDesktopName()` 是同一个身份的三处写法。**
   本项目身份 = `io.github.edwinhuish.songloft-desktop`，四处取值必须一致：

   | 位置 | 值 |
   |---|---|
   | `package.json` → `desktopName` | `io.github.edwinhuish.songloft-desktop` |
   | `src/main/index.ts` → `app.setDesktopName()` | `io.github.edwinhuish.songloft-desktop` |
   | `electron-builder.yml` → `appId` / `StartupWMClass` | `io.github.edwinhuish.songloft-desktop` |
   | 安装后的 `.desktop` 文件名 | `io.github.edwinhuish.songloft-desktop.desktop` |

   ⚠️ **身份刻意不以 `.desktop` 结尾**。若身份自己也以 `.desktop` 结尾（历史上的
   `com.songloft.desktop` 正好踩中），「文件名 → 身份」会多削一层，只能靠「多写一层后缀」抵消
   —— 而这三种写法**看起来都对、构建也不报错**。改回旧形态前先读 AGENTS.md 8.1。

   对不上的症状不只是图标：GNOME 50 起这个身份还会被拿去 `xdg-desktop-portal` 换
   `globalShortcut` 授权，对不上时门户直接拒绝、**错误不会冒到应用层**。

   **改上面四处中的任何一处，必须同时改其余几处，并重跑 `pnpm run verify:package`。**

2. **AppImage 的 AppArmor profile 要单独提供。** deb 那份由 electron-builder 内建生成并自动安装，
   AppImage 没有安装步骤，必须靠 `extraResources` 带上（`build/apparmor-profile`）。
3. **托盘图标不能指望 `build/` 进包。** `buildResources` 不参与打包，运行期要读的真实文件
   必须写进 `extraResources`（`build/icon-source.png` → `resources/tray.png`）；开发态读
   `build/tray-256.png`。
4. **图标渲染会静默丢渐变。** ImageMagick 渲 SVG 时渐变可能整体变黑白且退出码为 0。
   `scripts/make-icons.sh` 因此改走 Chrome 渲染、并在渲染后用**色相直方图**断言至少 3 个色相族
   （另有灰度图反向验证，确保断言本身有效）。
5. **AppImage 的 FUSE2 依赖。** Ubuntu 24.04+ 起 `libfuse2` 改名 `libfuse2t64`，用
   `toolsets.appimage: '1.0.3'` 换成静态 runtime，彻底去掉这个依赖。

---

## 7. 测试

### 单元测试

```bash
pnpm test
```

覆盖 `src/shared` 与 `src/renderer/src/lib` 里的纯函数（vitest，7 个文件）：目前最要紧的一批
用例锁的是 `lyric.ts` 的一个**静默丢行**缺陷：后端返回的四路歌词里，`lxlyric`（逐字）常常只
覆盖副歌，而早先的实现是 `base = wordSource ?? main` —— 一旦有逐字歌词就整份换掉主歌词，于是
主歌词里其余的行被**整行丢弃**，界面上表现为「歌词莫名其妙少几句」，且没有任何报错。

同一批用例还覆盖了时间戳对齐：原先用「按 20ms 分桶」匹配，`12.000` 与 `12.010` 会分别落进
相邻两桶、恰好跨桶边界就漏配。现在改成单调游标 + 容差内最近邻。

`url.test.ts` 锁的是「请求到底打到哪个地址」：token 有没有带上并正确编码、追加参数该用
`?` 还是 `&`、外链 CDN 的地址不能被我们改 query（可能带签名）、`track` 与 `format` 不能同时出现。

### 端到端巡检

```bash
pnpm run e2e
```

`scripts/e2e/` 下是一个最小 mock 后端 + 基于 CDP 的驱动器：起一个**隔离的**虚拟显示
（不会抢你的焦点、也不会动你的真实配置），启动构建产物，用**真实 DOM 交互**逐个界面点击、
截图并**断言**。产物在 `.e2e/`（已 gitignore）。

⚠️ 它跑的是 `out/` 里的**构建产物**，不是 dev server：改完源码要先 `pnpm run build`。
少了这一步，巡检的是上一次的构建 —— 界面看着「没变化」、断言照常绿，测的却是旧代码。

为什么断言而不是只截图：上面那个歌词丢行缺陷就是「截图看着正常、实际少了几行」的典型。
巡检因此断言歌词面板必须出现 10 行（mock 的主歌词 10 行、逐字源只覆盖 4 行），
并断言曲库的类型筛选真的收敛了行数（43 → 41 → 0）、流派分面的**卡片文字**确实换成了流派名
（卡片数同为 5，只数个数区分不出「有没有点中 chip」）。

一次完整巡检 **90 步**，按链路大致这么分布（每步都会截一张图）：

| 链路 | 覆盖到的关键判据 |
|---|---|
| 首页 / 曲库 | 统计条名目、类型筛选的行数收敛（43 → 41 → 0）、分面卡片**文字**换成维度名、筛选 chip |
| 文件夹 | 目录行上「N 首」与点进去的实际行数一致、面包屑逐级跳回 |
| 曲库的两半 | 「本地 / 服务器」切换真的换了内容（本地那一半是空态），切回来时上半场的筛选**还在**（2 首，不是 43 首）；「服务器」那格嵌的两颗子选项在「本地」时不出现 |
| 歌单 / 最近 / 收藏 | 列表条目、歌单内有序列表、本机记录条数 |
| 搜索 | 命中数（只可能来自后端）、相关歌单/歌手/专辑三块、空态文案 |
| 多选与右键菜单 | Ctrl 加选的行数递增、操作条文案、菜单条目/分割线/本地曲那句说明 |
| 设置九个分区 | 分区名与**顺序**、开关状态、版本号、缓存与数据管理卡片 |
| 扩展面 | 商店四档动作（安装 / 可更新 / 已装 / 入口撞名）、订阅源弹窗、插件管理顺序与「运行异常」角标、扩展页 webview 装载、切回原生面 |
| 播放 | 面板与满窗三处歌词都是 10 行、队列、满窗时标题栏换底色、迷你窗开 / 关（那几步在**另一个 CDP target** 上跑，见下） |
| 当前曲定位 | **看不见才居中、看得见就别动**：滚出视野后切走切回来必须居中回来（量行中心与容器中心的距离）；只翻偏 90px 时切回来则一个像素都不许动（`pageScrollKept`） |
| 队列抽屉定位 | 打开抽屉时当前项必须**居中且整行可见** —— 只数「队列里有几项」抓不到位置算错（高亮仍在，人却看不见） |
| 侧栏 / 命令面板 | 折叠态图标居中、命令面板四组分组 |
| 退出登录 → 登录 | 退出前的确认、退出后侧栏消失、连不上与登录成功是两种结果 |

两条**踩过的坑**记在这里，因为它们的症状都不像缺陷：

* 断言里 `containsAll` 一度只认数组，而 `settingText` / `modalText` 这两个口径取的是
  **整段字符串** —— 于是 8 条断言永远是红的，红的原因却长得像「界面上了错的内容」。
  断言不是代码，写错了不会编译报错；`drive.mjs` 里因此对每种口径都写清「它会是什么形状」。
* 巡检等待的起点曾是「`.shell` 在不在」。它在登录页时就已经成立，于是第一步会偶发地
  撞在还没渲染出侧栏的那一帧上 —— 现在等的是 `.nav-item`。
* **迷你播放器是另一个窗口**（另一个渲染进程 → 另一个 CDP target），而 `window.__t` 那些
  助手是**按页面**注入的。STEPS 里因此多了第 5 项：写 `'mini'` 的那几步在那一页里跑
  （`drive.mjs` 的 `sessionFor`，按需连、连上先注一份助手）。不标的话那几步会在主窗口里
  找 `.mini-bar` —— 报 `NOT_FOUND`，看着像「界面没画出来」。

### 文档用的截图

```bash
pnpm run e2e && pnpm run shots
```

`scripts/e2e/shots.sh` 从巡检产物里生成两样东西，`README.md` 与本文引用的就是它们：

| 产物 | 用途 |
|---|---|
| `docs/screenshots/*.png` | 主要界面的单张图（1440 宽折到 1080），嵌进 README |
| `docs/e2e-walkthrough.png` | **全部 90 个状态**的覆盖图：一格一步、带步骤名；用于一屏扫出「哪一格是空的 / 弹窗没关掉」 |

它们都是**生成物**：改了界面就重跑这两条命令，不要手工截图替换 —— 手工图会安静地过期，
而且下一次没人愿意重做。脚本按**步骤名**（不是序号）挑图，序号会随步骤增删而漂。

截图都是**浅色主题**：`scripts/e2e/fixtures/config.json` 里把 `theme` 写成了 `light`。
（`system` 在没有桌面偏好的 Xvfb 里本来也解析成浅色，写死只是为了不受环境影响。
想拍一套深色的，改那一项即可 —— 巡检的断言与主题无关。）

---

## 8. 开发约定

* 提交前至少跑 `pnpm run check`（类型 + lint + 格式 + 单测）；动了界面再加 `pnpm run e2e`，
  动了打包配置再加 `pnpm run pack:linux` + `pnpm run verify:package`（两者都只覆盖 Linux 产物；
  `win:` / `mac:` 段的改法只能在对应平台或 CI 上验证，见 §6.1）。
* 渲染层**不得**直接 `import electron` / `node:fs` / `node:child_process`，能力一律经 `preload`
  白名单（`window.songloft`）转出 —— ESLint 会拦，理由见上面「安全模型」。
* 纯逻辑（歌词解析、URL 拼接等）放 `src/shared/`，两侧共用且可直接单测。
* **代码风格**：Prettier 说了算（`printWidth: 100`、无分号、单引号）。`pnpm run format` 一键修，
  不要为了让 `format:check` 通过而加 `prettier-ignore`。
* **注释与文档用中文**，且解释「**为什么**」而不是复述代码。
* **不要为了通过 lint 而写 `eslint-disable`**：先判断规则是不是在指出真问题。

---

## 9. 相关文档

| 文档 | 内容 |
|---|---|
| [`../README.md`](../README.md) | 这是什么、有哪些功能、与上游 Flutter 版的差异 |
| [`../AGENTS.md`](../AGENTS.md) | 面向 AI 编码代理的项目说明：架构地图、命令、约定、雷区 |
| [`electron-migration-evaluation.md`](electron-migration-evaluation.md) | 换栈评估报告：10 条技术路线横向对比与结论 |
| [`screenshots/`](screenshots/) | 主要界面截图（`pnpm run shots` 生成） |
| [`e2e-walkthrough.png`](e2e-walkthrough.png) | 巡检覆盖的全部界面状态一览 |
| [`../NOTICE`](../NOTICE) | 第三方组件署名与编解码器许可说明 |
