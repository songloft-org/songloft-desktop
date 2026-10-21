# AGENTS.md

面向 AI 编码代理（以及第一次接手的人）的项目说明。目标是让你**不必先读完全部源码**就能
改对地方、跑对命令、避开已经踩过的坑。

> 人类读者请看 [`README.md`](README.md)；换栈的技术选型论证见
> [`docs/electron-migration-evaluation.md`](docs/electron-migration-evaluation.md)。

---

## 1. 这是什么

Songloft 音乐播放器的 **Electron 桌面客户端**。

* 上游原项目 [`songloft-org/songloft-player`](https://github.com/songloft-org/songloft-player)
  是 Flutter 客户端 + 自建 Go 后端。**本仓库只重写客户端，且只做 Windows / macOS / Linux 桌面**，
  不含移动端、Web 端，也**不含后端**。
* 后端协议、接口语义、曲库模型**完全沿用上游**，不做私有扩展。
* 本仓库地址：<https://github.com/songloft-org/songloft-desktop>

本地联调需要另外跑一个 Songloft 后端（默认 `http://localhost:58091`，默认管理员 `admin` / `admin`）。
没有会话时应用照常打开、不会崩：默认落在**免登录**的「本地文件」那一页（只听本机磁盘上的文件），
要连服务器就点侧栏那颗「连接服务器」—— 登录页是按需进去的一个目的地，左上角那颗返回能退出来。

---

## 2. 技术栈

| 层 | 选型 | 版本 |
|---|---|---|
| 运行时 | Node.js | `>= 22.12.0` |
| 包管理 | pnpm | `12.4.1`（`packageManager` 已锁） |
| 容器 | Electron | `44.7.0` |
| 构建 | electron-vite / vite | `5.0.0` / `7.3.7` |
| 界面 | React + TypeScript | `19.3.0` / `6.0.3` |
| 状态 | zustand | `5.0.15` |
| 测试 | vitest | `5.0.4` |
| 打包 | electron-builder | `26.15.3` |
| 规范 | ESLint（flat config）/ Prettier | `10.12.0` / `3.9.10` |

**运行期依赖只有 `zustand` 一个** —— 其余全在 `devDependencies`。加新依赖前先问自己能不能不加。

---

## 3. 命令

```bash
pnpm install              # postinstall 会拉 Electron 二进制
pnpm dev                  # 开发（渲染层 HMR）

pnpm run check            # ★ 提交前必跑：typecheck + lint + format:check + test
pnpm run build            # 产出 out/（main + preload + renderer）
pnpm run e2e              # 端到端 UI 巡检（起 mock 后端 + 截图 + 断言）
pnpm run shots            # 把巡检截图整理成文档用图（docs/screenshots + docs/e2e-walkthrough.png）
pnpm run pack:linux       # 打 deb / AppImage / tar.gz 到 release/
pnpm run pack:win         # 打 NSIS 安装包与免安装 zip（要在 Windows 上跑；Linux/macOS 上跑不动）
pnpm run pack:mac         # 打 dmg / zip（要在 macOS 上跑）
pnpm run verify:package   # 校验打包产物的桌面集成项（只覆盖 Linux 产物）
pnpm run icons            # 由 build/icon.svg 生成全套图标 + 托盘图
pnpm run desktop:install  # 把本应用注册到当前用户桌面目录（GNOME 任务栏图标要它，见 §8.11）
pnpm run desktop:uninstall

pnpm run release          # ★ 发版：升版本 + 提交 + 打 v* 标签 + 推送，之后由 CI 三平台发布
```

| 想改的东西 | 至少跑这些 |
|---|---|
| `src/shared/` 的纯函数 | `pnpm run check` |
| 渲染层组件 / 页面 | `pnpm run check` + `pnpm run e2e` |
| 主进程、preload、IPC | `pnpm run check` + `pnpm run e2e` |
| `package.json` / `electron-builder.yml` / `build/` | 上面全部 + `pnpm run pack:linux` + `pnpm run verify:package` |
| `.github/workflows/` | 上面全部；`release.yml` 只能在真实 runner 上验证（见下） |

### 3.1 发版

`pnpm run release`（[bumpp](https://github.com/antfu-collective/bumpp)，配置见 `bump.config.ts`）
一步做四件事：**升 `package.json` 版本 → 提交 → 打 `v<版本>` 标签 → 推送**。
推送标签即触发 `.github/workflows/release.yml`：

| job | 做什么 |
|---|---|
| `preflight` | 先校验「标签 ↔ `package.json` 版本」一致（不一致就失败，不进入构建），再跑一遍 `pnpm run check` |
| `build` | **三平台并行**构建：`pack:linux` / `pack:win` / `pack:mac`，各自 `--publish never`，只把产物放进 `release/` 再作为 artifact 上传 |
| `release` | 三份都成功后汇总：`get-tags.sh` 查出前一个版本标签 → `generate-changelog.sh` 从提交历史按 `feat` / `fix` / … 分类生成发布说明 → 断言 deb / AppImage / tar.gz / exe / dmg / Windows 免安装 zip 一样不缺，且**文件名都合统一命名式** → 创建 Release 并上传（含 `SHA256SUMS.txt`）→ 最后再断言发布说明与资产都在 |

为什么要「先全部构建成功、再统一上传」：任何一个平台失败时都不该留下半份已发布的 Release
（已发布的 Release 收不回，用户可能已经下载）。

⚠️ **Windows / macOS 的构建只有 CI 能真正验证**，本地 Linux 只能跑通 `pack:linux` 那一条。
所以改了 `electron-builder.yml` 的 `win` / `mac` / `nsis` 段之后，别只跑 `pnpm run check`
就算完事 —— 要么推一个 tag，要么在 Actions 里手动触发 release 工作流（`workflow_dispatch`）。

⚠️ macOS 产物目前**未签名**（CI 里没有证书，`CSC_IDENTITY_AUTO_DISCOVERY=false`）。
用户首次打开会被 Gatekeeper 拦下；要正式分发得补签名与公证，见 `electron-builder.yml` 的 `mac` 段。


---

## 4. 目录职责

```
src/
├─ main/          Electron 主进程（Node 环境，唯一持有系统权限的地方）
│  ├─ index.ts        生命周期、窗口创建、安全策略与 CSP、setDesktopName、userData 覆盖
│  ├─ windows.ts      BrowserWindow 构造（contextIsolation / sandbox / nodeIntegration）
│  ├─ mini-window.ts  迷你播放器窗口：几何 / 两种身份（跟随者 | 宿主，见 §8.17）
│  ├─ app-icon.ts     窗口图标定位（只对 X11 / Windows / macOS 生效；Wayland 见 §8.11）
│  ├─ media-keys.ts   媒体键（globalShortcut 兜底；优先走 Media Session 自动映射）
│  ├─ store.ts        本地持久化：设置 / 凭据 / 服务器列表（JSON，落在 userData）
│  ├─ cache.ts        本机磁盘缓存（Chromium 会话缓存）的占用 / 清理 / 启动上限
│  ├─ files.ts        导出 / 导入的文本文件对话框（读入限 32MB）
│  ├─ probe.ts        后端探测（本地 Blob 解码，避免为它关掉 webSecurity）
│  ├─ local-files.ts  本地文件的收件口：启动参数 / macOS open-file / 文件对话框（排队 + 摇铃）
│  ├─ media-protocol.ts 本地文件的媒体协议 songloft-media://（按 Range 读字节；见 §8.16）
│  ├─ github-discovery.ts 「GitHub 发现」的请求与逐仓库核对（缓存 / 限流 / Token；见 §8.12）
│  ├─ tray.ts         托盘图标与菜单
│  └─ app-menu.ts     应用菜单（窗口无边框、看不到菜单栏，但它提供全局加速键）
├─ preload/        contextBridge 白名单 —— 渲染层唯一的对外通道（window.songloft）
├─ shared/         两侧共用的**纯代码**，无副作用、可直接单测
│  ├─ types.ts        后端数据模型（Song / Playlist / Facet…）
│  ├─ ipc.ts          IPC 频道常量 + 跨进程传输的类型 + 默认设置
│  ├─ bridge.ts       window.songloft 的接口定义（白名单的唯一事实源）
│  ├─ bridge-types.ts 桥接层的小类型
│  ├─ lyric.ts        歌词四路合并 + 解析 + 当前行/逐字定位
│  ├─ plugin.ts       JS 插件模型 / 排序纯函数 / 扩展页 URL 拼接 / PLUGIN_PARTITION
│  ├─ local-file.ts   本地文件播放：路径 ↔ 可播放地址 ↔ Song 的换算 + Range 解析（§8.16）
│  ├─ data.ts         两份数据快照是否等价（页面切回时的**静默刷新**靠它判断「要不要动界面」）
│  ├─ metadata.ts     元数据缺口判定 / 「只补缺失」的合并 / 封面与标题的降级口径
│  ├─ github-discovery.ts 「GitHub 发现」的纯逻辑：清单 / Release 校验、搜索语句、卡片状态（§8.12）
│  ├─ window-role.ts  「这个渲染进程是哪种窗口」的契约（主进程写 hash、渲染层读；见 §8.17）
│  ├─ version.ts      版本号比较（认不出来的写法一律判「不比它新」，宁可少提示一次更新）
│  └─ links.ts        对外 URL 常量（本仓库 / 上游）
└─ renderer/       React 19 + zustand
   ├─ api/           client.ts（fetch 封装）/ endpoints.ts（端点清单，来自上游 Flutter 实现）/
   │                 plugins.ts（JS 插件：列表 / 启停 / 卸载 / 顺序 / 商店）
   ├─ state/         useAuth / usePlayer / usePlaylists / useSettings / useUi / useToasts /
   │                 player-core（**播放核心**：音频 / 队列 / 歌词 / 音轨 —— 与窗口形态无关）/
   │                 remotePlayer（宿主的镜像）/ usePlayer（按窗口角色分流，见 §8.17）/
   │                 mini-host（宿主推快照 + 接遥控命令）/
   │                 local-session（**本地文件会话**的启动编排：迷你宿主窗靠它起播，见 §8.17）/
   │                 media-commands（托盘 / 媒体键的命令 —— 两个宿主窗口共用这一份）/
   │                 useLocalFiles（本地文件的收件箱：路径 → 队列，免登录也能用，见 §8.16）/
   │                 usePlugins（已装扩展 + 顺序 + 运行时音频状态，唯一事实源）/
   │                 useLibrary（曲库数据的版本号 + 后台任务守望，见 §5.7）/
   │                 song-metadata（起播时按缺口补齐元数据：只补缺失 / 超时 / 缓存 / 请服务端补齐）
   ├─ pages/         10 个页面：Home / Library / Playlists / PlaylistDetail / Favorites /
   │                 Recent / Search / Settings / Login / Extensions
   │                 （+ 同目录的 PluginStore，以及两个**页内视图**：FoldersView / LocalFilesView）
   │                 （「文件夹」与「本地文件」都不是独立页面 —— 侧栏只有一个「曲库」入口，
   │                  LibraryPage 一页三份内容：服务器的曲库（按标签）/ 服务器的文件夹
   │                  （按目录）/ 本机磁盘上的音频文件（唯一不需要登录的那一份，见 §8.16）。
   │                  看哪一份由页头那颗「本地 / 服务器」切换决定（「服务器」那一格里还嵌着
   │                  「曲库 / 文件夹」两颗子选项）—— 页头由三种内容共用同一份实现
   │                  （components/LibraryHeader）：副标题与动作钮（刷新 / 播放全部…）都只有
   │                  各自的视图才知道，所以由它们各自把这份页头摆上 —— 标题 + 副标题在第一行，
   │                  动作钮在第二行右端、与来源切换同一行）
   ├─ components/    Sidebar / TitleBar / SongTable / PlayerBar / LyricsView / CommandPalette /
   │                 Panel / ContextMenu / Modal / Toasts / SelectionBar /
   │                 FullPlayer（满窗播放：盖在原生面上的浮层）/
   │                 MiniPlayer（迷你窗那一条，跑在**另一个窗口**里，见 §4）/
   │                 （同目录的 ../MiniApp.tsx 是那个窗口的根，与 App.tsx 并列）
   │                 ExtensionFrame（扩展主框架：左侧栏 + 右内容面）/
   │                 PluginSurface（扩展 webview 栈）/ PluginIcon /
   │                 RegistrySourcesDialog（管理订阅源）/
   │                 GithubDiscoveryCard（发现页的卡片）/ GithubTokenDialog（发现页的凭据）
   ├─ hooks/         useSongList / usePlaylistSongs / useAsync / useResponsiveSidebar /
   │                 usePageActive（页面槽的「我看得见吗」，见 §4 的页面槽那段）/
   │                 useGithubDiscovery（商店里「GitHub 发现」那一份，见 §8.12）/
   │                 useHorizontalScroll（溢出时才出的横向滚动条）
   ├─ lib/           url（资源 URL 拼接）/ color / accent / format / concurrency /
   │                 responsive（断点判定，纯函数）/
   │                 window-role（「我在哪个窗口里」+「我是不是宿主」，见 §8.17）/
   │                 plugin-actions（插件的停用 / 卸载 —— 确认与提示只有这一份，
   │                 将来再加入口别另写；lib/ 里唯一一个不是纯函数的）
   └─ styles/        tokens.css / base.css / components.css / index.css
```

★ **标题栏以下是「一个可替换的内容面」**，两种形态由 `useUi.surface` 切换
（见 `App.tsx` 的 Shell）：

| surface | 内容 | 谁在这儿 |
|---|---|---|
| `native` | 侧栏 + 工具条 + 主区 + 抽屉 + 播放条 | `NativeRoute`：home / library / playlists / settings… |
| `extensions` | 扩展主框架：左扩展侧栏 + 右内容面 | `ExtensionRoute`：`{name:'extensions',pane}`（商店/管理）与 `{name:'plugin',entryPath}`（某个扩展），见 §8.12 |

**两面都挂在 DOM 里，只把不走的那一面藏起来**（`.surface[data-hidden]`）。两条容易做错：

* **藏法必须是 `visibility: hidden`，不是 `display: none`**：后者让那一面失去布局，滚动
  位置与 guest 的渲染都不再有保证。而「切过去再切回来还是离开时的样子」要保的正是这些：
  原生面的滚动与已加载的列表、扩展面在商店的第几页、正在出声的那个扩展。
* **两面各有各的路由**（`nativeRoute` / `extensionRoute`），不是共用一份 —— 共用必然二选一，
  切过去就把另一份覆盖掉，「记住状态」从根上做不到。标题栏那两个入口的主点击走的是
  `showSurface`（只换面、不动任何路由），**不是** `navigate`；`navigate` 按目标的类型决定
  写哪一份，并把面切过去。

扩展那两条路由**不在 `renderRoute` 的 switch 里**（它的入参是 `NativeRoute`）—— 别顺手加
回去，加回去会被渲染到侧栏里那一小块去。它们刻意是两条路由而不是一条带 `view` 字段的：
侧栏高亮与 `pane` 语义本来就不一样。

**原生面内部同样是「挂着，只藏不走」**：`nativeRoute` 的每条对应一个页面槽
（`App.tsx` 的 `NativePages` / `PageSlot`，`.page-slot[data-hidden]`；首次访问才挂、之后不卸）。
于是切页只换「显示哪一槽」，页面里的筛选条件 / 排序方式 / 视图模式 / 滚动位置都还是离开时的
样子（`.main-scroll` 因此不再自己滚动 —— 滚动交给每个槽，共用一个滚动容器会把上一页的
`scrollTop` 带过去）。两条容易做错：

* **页面组件不许自己读「当前路由」**（`useUi(s => s.nativeRoute)`）：常驻之后，不活跃的那份
  实例读到的已经属于别人了，会当场变脸。参数一律由页面槽经 props 传进去（`LibraryPage`
  为此收 `route`）。
* **`library` / `folders` / `local` 是三个槽**，不是一个：共用一个槽的话，换个来源或换只看法
  会把「服务器」那一半的筛选条件一并卸掉（三条路由落在同一页的三种内容上，见 LibraryPage）。

代价是数据的新鲜度不再由「重新挂载」自动保证，改由那三个数据 hook 自己盯（见 §5.8）。

⚠️ **E2E 的选择器要限定在 `.surface-native` 里**：两面都在 DOM 里，而扩展面里也有一个用
同一套 class 的侧栏。`scripts/e2e/drive.mjs` 的 `offCenter()` 已经这么写了 —— 不限定的话
它会拿原生面那个侧栏的中心去量扩展面的图标，得到一个恒定的几十 px（断言"红了"，其实
什么都没测到）。

⚠️ **同一个理由，页面槽常驻之后 `drive.mjs` 的选择器一律走 `vis()`**（助手区那个包装）：
它把范围收回「不在 `[data-hidden]` 子树里」的那一份。直接用 `document.querySelectorAll`
会把藏在别的页里的 `.song-row` / `.card` / `.chip` 一起数进来 —— 计数翻倍，而断言看着还
"挺像那么回事"。

扩展面里**没有播放条**（宿主播放不会因此中断：音频是模块级对象、不挂在 DOM 上，见
`state/usePlayer` 的 `audio`），此时控制播放只能靠媒体键 / 托盘 / MPRIS。

**看播放器还有另外两个姿势**，都不属于 `surface`，也别往路由里塞（路由是"去哪一页"，
它们只是换个姿势看同一个播放器 —— 混进历史会让 Alt+← 退回到"收起满窗播放"这种中间态）：

* **满窗播放**（`useUi.fullPlayer`，`components/FullPlayer.tsx`）：底栏那颗封面点一下，
  标题栏以下整块换成大封面 + 歌曲信息 + 歌词 + 控制条，收起钮 / Esc 出去。
  它是**原生面里的一个浮层**（`z-index: 35` —— 压在播放条之上、标题栏之下，标题栏是无边框
  窗口唯一常驻的拖拽区与关闭入口，不能被它吃掉），但上边界要**伸到标题栏底下**
  （`top: -titlebar-h`，内容靠 `padding-top` 让开），标题栏再由 `.shell[data-fullplayer]`
  换成透明底 —— 满窗播放时这两块要的是**同一张**底色，各画一份「看着差不多」的糊封面
  在接缝处一定对不上。切去扩展面时它跟着一起被藏，切回来原样还在；
  底下的页面一直挂着没被卸载，收起后仍是离开时那一页。
* **迷你播放器**（底栏那颗按钮，`components/MiniPlayer.tsx` + `MiniApp.tsx`）：它是**另一个
  BrowserWindow**（`main/mini-window.ts`），主窗口一点都不动 —— 这也是它没有走 `surface`
  也没有走满窗播放那套「藏起来」的原因：它压根不在这个窗口里。
  ★ 这个窗口有两种**身份**（由 URL 的 hash 定，见 §8.17 与 `shared/window-role.ts`）：
  · **跟随者**（普通会话）：主窗口推**播放状态快照**过来（轻的一半跟进度走、重的一半带队列与
    歌词和封面的 token），它把动作变成**遥控命令**发回去（`state/mini-host.ts` ↔
    `state/remotePlayer.ts`）；
  · **宿主**（**本地文件会话**：双击音频文件起的那一趟，那里没有主窗口）：它**自己就是播放器**。
  播放的核心（`state/player-core.ts`：音频 / 队列 / 歌词 / 音轨 / 音量）因此**不知道自己在哪个
  窗口里**，`state/usePlayer.ts` 是一个**分流器** —— 谁当宿主谁拿到核心，另一侧拿到镜像。
  于是 `Queue` / `LyricsView` 这些组件两边共用同一份实现，一个分支都不必分。

新加播放相关的界面时照着这条走：读同一个 `usePlayer`、复用 `PlayerProgress`（"拖动期间只动
本地 scrub、松手才 seek"只有那一份）与 `LyricsView`，别复制一份状态出去 —— 也**别在组件里读
「当前是哪个窗口」**：那是 `usePlayer` 与 `lib/window-role` 的事。

---

## 5. 架构与数据流

1. **渲染层是「不可信的」**，所有系统能力经 `preload` 白名单（`window.songloft`）转出，
   注册在 `src/shared/bridge.ts`，实现在 `src/preload/index.ts`，由 `ipcRenderer.invoke` 落到主进程。
2. **IPC 频道名一律用 `IPC` 常量**（`@shared/ipc`），不要写字符串字面量 —— 先加常量再接线。
3. **播放**走 `HTMLAudioElement` + **Media Session API**。Chromium 会把它自动映射成 Linux 的
   MPRIS / Windows 的 SMTC / macOS 的 Now Playing，**不需要**为每个平台写原生桥。
   键盘媒体键另走 `globalShortcut` 兜底。
4. **媒体地址带 `access_token` 查询参数**（`lib/url.ts`）：封面/音频是交给 `img` / `audio` 直接请求的，
   走不了带 `Authorization` 头的 fetch 封装。
5. **封面取主色由主进程代取字节**（`cover:extract`）：渲染层直接读跨域 `canvas` 会污染画布。
6. **持久化只在主进程**（`store.ts`）：设置（本地偏好）/ 凭据（token）/ 服务器列表。
   渲染层启动时拉一次，之后靠 IPC 读写。
7. **曲库数据的各处副本靠一个「版本号」收敛**（`state/useLibrary`）：歌单与收藏在
   `usePlaylists` 里，曲库 / 搜索 / 歌单详情 / 文件夹 / 首页的列表则在各自 hook 的本地 state 里。
   而「扫描曲库」（含强制扫描）与「刷新元数据」是**服务端的后台任务**，客户端没有推送通道 ——
   任务一结束就把 `useLibrary.revision` +1：页面级的列表在 hook **内部**订阅它
   （`useAsync` / `useSongList` / `usePlaylistSongs`，所以调用方不必各自记得挂），
   store 级的副本由 `invalidate()` 重载。守望（`watchTasks()`）进应用查一次、在跑就轮询到停，
   **不依赖设置页是否挂在界面上**（刷新元数据动辄几分钟，用户多半已经走了）。
8. **切换页面时自动刷新，但只在数据真的变了才动界面**：页面槽是常驻的（见 §4 那段），
   所以「切回来」不再有重新挂载这一次机会，重取数据的责任落到那三个数据 hook 上 ——
   它们从 `usePageActive()` 读「我这一槽是不是看得见的那一页」，切回来时静默重取一次，
   再用 `shared/data.ts` 的 `sameData` 与手头这份比：**一样就一个字都不改**（不显示加载态、
   不重设列表、不动滚动位置），不一样才更新（退回第一页 —— 与手动点「刷新」同一条路径）。
   不活跃的页面连请求都不发；手动刷新、筛选条件变化、`revision` 变化照旧走「明着加载」。

---

## 6. 硬性约定

* **渲染层不得** `import electron` / `node:fs` / `node:child_process` —— ESLint
  `no-restricted-imports` 会拦。需要新能力就「加 IPC 常量 → preload 白名单 → 渲染层调 `window.songloft`」。
* **`shared/` 只放纯代码**：无副作用、不读全局、不 import electron。这样它既能被两侧复用，又能直接单测。
* **代码风格**：Prettier 说了算（`printWidth: 100`、无分号、单引号）。`pnpm run format` 一键修。
  源码文件**不允许**超出 `printWidth` —— `format:check` 挂在 `check` 里，超了会红。
* **注释与文档用中文**，且解释「**为什么**」而不是复述代码。
* 优先用约束把错误变成不可能（类型、常量、断言脚本），而不是靠注释提醒。
* 遵循 DRY：同一个值出现第二处时，提取到 `shared/`（例如 `shared/links.ts` 的两个 URL）。
* **不要为了通过 lint 而写 `eslint-disable`**：先判断规则是不是在指出真问题。

---

## 7. 验证方式（各自能抓到什么）

| 手段 | 能抓到 |
|---|---|
| `pnpm run check` | 类型错误、lint、格式、`shared/` 纯函数的行为（单测） |
| `pnpm run e2e` | **界面真的渲染成了什么**：真实点击 + DOM 断言 + 截图 |
| `pnpm run verify:package` | **打包产物里的桌面集成**是否正确（解包 deb / AppImage / tar.gz 后断言） |

**为什么必须有 E2E 而不只是截图**：截图看着正常、实际少几行的缺陷是真实发生过的
（见下节「歌词丢行」）。E2E 的断言用**内容**而不只是计数 —— 例如流派分面的卡片数与歌手分面
同为 5，只数个数区分不出「有没有点中 chip」，所以断言的是卡片的**文字**变成流派名。

`scripts/e2e/` 的结构：`server.mjs`（mock 后端）、`drive.mjs`（CDP 驱动器 + 步骤与断言）、
`run.sh`（编排）、`shots.sh`（把截图整理成文档用图）、`fixtures/`（自动登录配置与封面）。
产物落在 `.e2e/`（已 gitignore）。

一次巡检 **83 步**，覆盖：首页 / 曲库（类型与分面筛选、文件夹逐级进入、服务器与本地两半来回切）/
歌单 / 最近 / 收藏 /
搜索（含空态）/ 多选与右键菜单 / 设置九个分区 / 扩展面（商店、订阅源、插件管理、扩展页 webview）/
播放（面板与满窗的歌词、队列、迷你窗）/ 当前曲在列表里的居中定位 / 命令面板 / 退出登录与登录。
每步一张截图。

⚠️ **迷你播放器在另一个窗口里**（独立 BrowserWindow，见 §4），所以那几步要切到**它的 CDP
target** 上跑 —— STEPS 里用第 5 项 `'mini'` 标出来（`drive.mjs` 的 `sessionFor`）。不标就会在
主窗口里找 `.mini-bar`，断言表现成 `NOT_FOUND`。

`pnpm run shots` 从这些截图生成**文档引用**的两份东西，`README.md` 与 `docs/development.md`
引的就是它们（都是生成物，改界面后重跑，别手工截图替换）：

| 产物 | 用途 |
|---|---|
| `docs/screenshots/*.png` | 主要界面单张图（1440 宽折到 1080），嵌进 README |
| `docs/e2e-walkthrough.png` | 全部 83 个状态的覆盖图，一格一步带步骤名 —— 用于一屏扫出「哪一格是空的」 |

截图一律是**浅色主题**：`fixtures/config.json` 里把 `theme` 写成了 `light`（`system` 在无桌面
偏好的 Xvfb 里本来也解析成浅色，写死只是为了避免随环境漂）。断言与主题无关，想换深色改这一项。

⚠️ 在 `drive.mjs` 里加断言时注意**口径的形状**：`settingText` / `modalText` 取的是**整段字符串**，
而 `containsAll` 早先只处理数组 —— 于是 8 条断言**恒假**，红的原因却像「界面上了错的内容」。
断言不是代码，写错了不会编译报错；每种口径都在这两个文件里写清了它是什么形状。

---

## 8. 雷区（都已踩过，改之前先读）

### 8.1 桌面身份：`.desktop` 文件名 = 身份 + `.desktop`，且身份**别以 `.desktop` 结尾**

Electron 的权威口径：`app.setDesktopName(name)` 的 `name` 去掉结尾那层 `.desktop` 才是
**应用身份**（Wayland 的 `app_id` / X11 的 `WM_CLASS`）。GNOME / Dock 就是拿这个身份去找同名
`.desktop` 条目，并据此把窗口与已固定的启动器图标合并。

本项目身份 = `io.github.edwinhuish.songloft-desktop`，四处取值：

| 位置 | 值 |
|---|---|
| `package.json` → `desktopName` | `io.github.edwinhuish.songloft-desktop` |
| `src/main/index.ts` → `app.setDesktopName()` | `io.github.edwinhuish.songloft-desktop` |
| `electron-builder.yml` → `appId` / `StartupWMClass` | `io.github.edwinhuish.songloft-desktop` |
| 安装后的 `.desktop` 文件名 | `io.github.edwinhuish.songloft-desktop.desktop` |

⚠️ **身份刻意不以 `.desktop` 结尾。** electron-builder 的算术是固定的
（`getDesktopFileName()` 削掉一层 `.desktop`、`FpmTarget` 拼装时再补一层）。若身份**自己也以
`.desktop` 结尾**（本仓库历史取值 `com.songloft.desktop` 正好踩中），「文件名 → 身份」会多削
一层，只能靠「多写一层后缀」抵消 —— 而 `com.songloft.desktop` 与
`com.songloft.desktop.desktop` **视觉上"都以 `.desktop` 结尾"**、`StartupWMClass` 也都对、
构建更不报错。改用反域名形态后这类歧义不复存在，**别再改回去**。

**症状是静默的，而且不只是外观**：GNOME 50 起 `xdg-desktop-portal` 会拿这个身份换门户授权，
对不上时 `globalShortcut` 被直接拒绝（`org.freedesktop.portal.Error.NotAllowed`）
**且错误不冒到应用层**（Electron #52218）—— 本项目的媒体键兜底正走这条路。

**改上面四处中的任何一处，必须同时改其余几处，并重跑 `pnpm run verify:package`。**

### 8.2 `ELECTRON_RUN_AS_NODE=1` 会让 Electron 退化成纯 Node

部分 agent / CI 的 shell 会导出它，症状是主进程一启动就崩（或 `electron.app === undefined`）。
跑脚本或调试时：`env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS`。

### 8.3 AppImage 的 AppArmor profile 要单独带

deb 那份由 electron-builder 内建生成并自动安装；**AppImage 没有安装步骤**，必须靠
`extraResources` 带上，否则 Ubuntu 24.04+ 上双击没反应（终端里却能跑）。

### 8.4 `build/` 不进包

`buildResources` 不参与打包。运行期要读的文件（如托盘图）必须写进 `extraResources`。

### 8.5 图标渲染会静默丢渐变

ImageMagick 渲 SVG 可能整体渲成黑白**且退出码为 0**。`scripts/make-icons.sh` 因此改成
用 Chrome 渲染，并在渲染后用**色相直方图**断言至少 3 个色相族（另有灰度图反向验证，确保断言本身有效）。

### 8.6 歌词「四路合并」的静默丢行

后端可能同时给 `lyric` / `tlyric` / `rlyric` / `lxlyric`。**主歌词（`lyric`）定义行集**，
逐字歌词（`lxlyric`）只**挂靠**到对应行上。历史缺陷是 `base = wordSource ?? main` ——
一旦有逐字歌词就整份换掉主歌词，于是逐字源没覆盖的行被**整行丢弃**，
表现为「歌词莫名其妙少几句」且无任何报错。回归用例在 `src/shared/lyric.test.ts`。

### 8.7 时间戳对齐要用容差最近邻，不要分桶

上游/后端对同一句的时间戳可能有 ±ms 级写法差异。按固定宽度分桶（`Math.round(t * 50)`）
会让 `12.000` 与 `12.010` 落进相邻两桶而漏配。现在用单调游标 + 容差内最近邻
（`ALIGN_TOLERANCE = 0.04`）。

### 8.8 CSP 只在打包态注入

开发态要连 HMR 的 websocket 与 react-refresh 的内联脚本，套上 CSP 会直接打断热更新。

### 8.9 `sandbox: true` 决定了 preload 必须是 CJS

沙箱环境不支持 ESM preload，`electron.vite.config.ts` 里因此把 preload 的产物固定成 `.cjs`。

### 8.10 写校验脚本时的三类「假结果」

`scripts/verify-package.sh` 的注释里记了三条（都对它自己踩过）：

1. **别用 `X="$(函数)"` 从「会打印报告的函数」里取值** —— 报告函数既 `echo` ✓/✗ 又要回传值，
   命令替换会把**整份报告**当成返回值，断言于是永远失败。多返回值走全局变量。
2. **`set -o pipefail` + `grep -q` 会 SIGPIPE 假阴性** —— `tar -tzf x | grep -q y` 明明命中却判失败。
   先把输出落成变量，再单独 grep。
3. **路径含空格就别按空白切列** —— productName 是 `Songloft Desktop`，落地成 `/opt/Songloft Desktop/…`，
   `awk '{print $1}'` 会截断。

### 8.11 任务栏图标：Wayland 下只能靠**宿主上**的 `.desktop`，窗口 icon 传不出去

GNOME / Wayland 画任务栏（Dock / Alt-Tab）图标**不看窗口**：`xdg_toplevel` 协议里没有图标字段，
合成器至今也没提供 `xdg-toplevel-icon-v1`（本机 `WAYLAND_DEBUG=1` 抓到的全局列表里就没有它），
所以 `BrowserWindow({ icon })`（落到 X11 的 `_NET_WM_ICON`）只在 X11 / Windows / macOS 生效。
GNOME 认图标只有一条链，**任何一环断掉都只是画一个占位齿轮，没有任何报错**：

```
窗口上报的 app_id（= app.setDesktopName() 的入参 = package.json 的 desktopName）
  → 宿主上 $XDG_DATA_DIRS/applications/<app_id>.desktop（以及 ~/.local/share 那份）
  → 条目里的 Icon=（图标名）交给图标主题解析
```

关键是「宿主上」：gnome-shell 进程的 `XDG_DATA_DIRS` 是登录时就定下的（flatpak 导出目录 +
`/usr/local/share` + `/usr/share` + snapd），**不含任何 AppImage 挂载点**，而挂载点
（`/tmp/.mount_*`）在应用退出后还会消失。所以「双击即用」的 AppImage / tar.gz / 开发态在
GNOME 上必然只剩齿轮 —— 这是 GNOME 的已知限制（KDE 宽容是因为 KWin 会回退到窗口自己报的
图标，GNOME 不会）。`.deb` 例外：electron-builder 会装系统级条目 + hicolor 图标。

于是本仓库的策略是「**产物自身合规 + 显式集成**」，刻意**不在运行时偷偷往 `$HOME` 写文件**：

* `linux.icon` 指 `build/icons`（**目录**，16…512）而不是单张母版。electron-builder 会把目录里
  每个文件按它自声明的尺寸投进 `usr/share/icons/hicolor/<size>/apps/`；给单张 1024×1024 时
  产物里只会出现 `hicolor/1024x1024/` 这一个目录，而 hicolor 的 `index.theme` **没有声明**
  1024x1024 —— 「`Icon=` → 图标文件」这一步就会静默查不到（桌面集成工具照搬这套目录结构，
  一样查不到；1.0.0 的 AppImage 正是这个毛病）。`scripts/verify-package.sh` 的
  `check_icon_link` 同时断言「`Icon=` 有同名文件」和「落在被声明过的尺寸目录里」。
* 想让**开发态**或某个 AppImage 真的显示图标，跑显式命令 `pnpm run desktop:install`
  （`install [启动目标]` / `uninstall`，见 `scripts/desktop-integration.sh`）。它只写
  `$XDG_DATA_HOME/{applications,icons/hicolor/512x512/apps}` 两份文件、把路径打出来，
  不碰 `/usr`、不要 sudo，也不覆盖用户手工维护的条目（认 `X-Songloft-Managed=true` 标记）。

⚠️ 别把 `BrowserWindow` 的 `icon` 当成任务栏图标的解决方案（见 §9）：它解决的是另外三个平台；
Wayland 下缺的永远是宿主上那份 `.desktop`。

### 8.12 扩展（JS 插件）：装在后端，宿主只是遥控器

插件本体（manifest + `static/` + QuickJS 沙箱里的 JS）全在**服务端**，客户端不存任何插件
二进制。本地只存两样轻量配置：**谁出现在扩展侧栏里**（启用与否）与**谁在前**（`plugin-order`，
键是 `entryPath` 而不是 id）。排序纯函数在 `shared/plugin.ts` 的 `applyPluginOrder` ——
四条语义（孤儿条目跳过、重复取首个、未列入的按原顺序落尾、不改入参）来自上游
`plugin_order.dart`，回归用例在 `shared/plugin.test.ts`。

**承载用 `<webview>` 而不是 `<iframe>`**：`<iframe>` 是跨源的，宿主没有任何 API 能单独
静音它、也不知道它在不在出声（`webContents.setAudioMuted` 是整窗口级的，会连播放器一起
静音）。而「右键 → 静音」与「扩展图标上的播放中蒙版」正是要这两件事。给得太少会静默
失效，所以要记住四条配套约束：

1. **独立 session**（`shared/plugin.ts` 的 `PLUGIN_PARTITION`）。`applyCsp()` 是
   `defaultSession.webRequest.onHeadersReceived`，改写的是**整个会话**的响应头 ——
   插件页也在同一个来源上，不隔离就会被套上宿主的 CSP，症状是插件莫名其妙地坏掉、
   **且没有任何报错**。代价是权限拒绝与证书校验要给那份 session 单独配一遍（见
   `main/index.ts` 的 `hardenPluginSession`）。
2. **webviewTag 必须配套加固**：`will-attach-webview` 里把 guest 的 `preload` 删掉、
   `nodeIntegration` 关掉、沙箱与上下文隔离打开。开着 `webviewTag` 而不管它，等于把
   「要不要 Node」交给页面自己声明。
3. **「活着的 = 当前显示的那个 ∪ 正在播放的那些」**（见 `PluginSurface`）。视觉上永远只有
   一个槽位，实现上是一层栈：切走就销毁。不这样，「某个扩展在后台出声」根本无从存在，
   播放蒙版也就没意义了。
4. **webview 必须显式给 display 与尺寸**，否则默认 `inline` 把高度塌成 0，表现为「加载了
   却看不见」。

**扩展是一个「去处」，不是一排页签**：标题栏上只有左上角那一个「扩展」入口（拼图图标 +
文字，右侧还带一颗下拉三角），点主操作把标题栏以下整块换成扩展主框架（`showSurface`：
只换面，所以**上次停在哪一页就还是哪一页**，见 §4 那张表）—— 左是扩展侧栏，右是内容面
（插件商店 / 插件管理 / 某个扩展的 `webview`），三者在右侧那一栏里换，框架本身不动。
那颗下拉三角是「不必先进框架再点一次」的那条近路，内容是**两条固定入口（插件商店 /
插件管理）→ 分割线 → 当前已开启的扩展**：扩展项**没有二级菜单**，点一下直接进去。
它刻意只做**跳转**，管理动作一律留在「插件管理」那一栏（那儿有整行位置摆开关和按钮），
「静音」也仍在扩展侧栏的右键菜单里。

侧栏段落固定：**顶部两条固定入口**（插件商店 / 插件管理）、**中间一列已安装扩展**（可滚动）、
**右下角那颗「收起 / 展开」**。三条容易做错的地方：

* **侧栏复用主导航那一套 class**（`.sidebar` / `.nav-item` / `.sidebar-playlists` /
  `.sidebar-toggle`）：折叠时的图标居中、文字淡出、左侧强调条、滚动区让位都是现成的，另写一套
  必然与那边慢慢漂开 —— 两个侧栏宽度相同、折叠动效相同，本来就是一回事。列宽也共用
  `--sidebar-current` / `--sidebar-w` 那套令牌（`.ext-frame` 与 `.shell-body` 是同一套算术）。
* **收起/展开那颗按钮是贴在右下角右边缘上的一条窄条**（`.sidebar-toggle`：绝对定位、
  `right: 0`、13×26、**无底色**、颜色走 `--accent`）。它原来是一条占满整宽、带文字的底行，
  两条侧栏各吃掉 39px 高，而那里只剩这一个动作。两条随之而来的约束：**列表容器要留 34px
  底部空档**（无底色就压不住文字，只能让最后一行整个让开，否则歌单条数会与图标叠在一起）；
  **hover 不能靠底色**（.icon-btn 那条 hover 底色要在这儿压掉），改成与 `--text-1` 混一档
  提高对比度 —— 暗色主题下变亮、浅色主题下变暗，两边都是「更清楚」。
  没有可见文字 → 提示与 `aria-label` 任何时候都要挂。
* **中间那一列只列 `isDisplayable` 的**（启用且有 `entryPath`）：停用与「运行异常」的没有可
  打开的页面，列出来也点不动。它们在插件管理页里照样看得到、处理得了。
* **侧栏形态是设置项**（`settings.extensionSidebarState`：`expanded` / `collapsed` / `hidden`，
  与主侧栏那份分开存 —— 两者宽度、用途都不同），不进 `useUi`：这个框架没有「窗口太窄就自动
  收起」那一套。★ **一个设置既是「默认」也是「当前」**：右下角那颗按钮只在前两档之间切，
  三档的显式选择器在插件管理页顶部 —— 别再加一份「默认值」与「临时值」，那两份迟早对不上。
  `hidden` 时 `<nav>` **整个不渲染**（不是宽度给 0：那样 border-right 会留一道没用的竖线），
  于是那颗收起按钮也随它一起没了 —— 插件管理页那个选择器是唯一能改回来的地方
  （所以界面上把这句话写了出来）。

★ **`PluginSurface` 在框架里常驻**（哪怕当前显示的是插件商店，只是 `display: none` 藏起来）。
它是「活着的 = 当前显示的那个 ∪ 正在播放的那些」的实现，框架把它整块卸掉等于：用户点一下
「插件管理」，正在放的歌就断了。所以它必须容忍 `entryPath` 为空 = 不显示、只保活
（`display: none` 不会停掉 guest 的播放 —— 音频不挂在布局上）。

**标题栏上是两颗「拆分按钮」**（`.titlebar-split`：左半执行主操作、右半那颗小三角开下拉，
两块共用一颗胶囊，悬停/聚焦/菜单开着时整颗亮起、分隔线才出现）：Songloft（回播放页 /
导航菜单）与扩展（进扩展主框架 / 插件商店 + 插件管理 + 已开启的扩展）。所以**标题栏里不再
有独立的「折叠菜单」按钮**，原来那一份导航项一分为二，各自贴在自己的入口上。容易做错的：

* **两个 `aria-expanded` 要各自判断** `anchor === 自己的 ref`：只看 `open` 的话，打开一颗
  会让两颗都报「已展开」（`anchor` 的语义见 `ContextMenu.tsx`）。
* **菜单开着时，标题栏的拖拽区与扩展页的 webview 要暂时让开**（`html[data-menu='open']`
  那两条规则）：这两处的「点一下」都冒不到宿主的 window（前者被浏览器拿去拖窗口，后者
  在独立进程里），不让开就会「点标题栏 / 点扩展页都关不掉菜单」。标记由 `ContextMenuHost`
  打在 `documentElement` 上 —— 别改成让 Shell 渲染一个属性，那会让每次开关菜单都整页
  重渲染一次。
* **扩展下拉里只放跳转，不塞管理动作**（它和扩展侧栏是「怎么进去」，管理在「插件管理」
  那一栏）。真要再加一处「停用 / 卸载」入口，走 `lib/plugin-actions` 而不是另写一份 ——
  卸载确认里那句「数据会一并删除」漏一次就是真的丢数据。

`.titlebar-brand` 是 `flex: 0 1 auto`（名字先被省略号吃掉，不许把窗口按钮顶出去），
`.titlebar-actions` 是 `flex: none` + `margin-left: auto`（右端永远贴右缘），外加
`.titlebar { overflow: hidden }` 兜底：标题栏里任何一项都不许把布局撑出去。

**两种插件图标的 URL 规则完全不同，别互相套用**：

| 用在哪 | `icon` 字段的形态 | 拼法 |
|---|---|---|
| 已装插件（侧栏 / 下拉 / 管理页） | `static/` 下的**裸文件名** | `/api/v1/jsplugin/{entryPath}/static/{icon}`（该路由**无需认证**，别拼 token） |
| 商店条目（`PluginStore` 的 `StoreIcon`） | **`/api/v1/proxy?url=<encoded>`**（服务端替我们从源站取回来，顺手套了 GitHub 代理） | 走 `lib/url.ts` 的 `buildResourceUrl`：拼 `baseUrl` + `access_token` |

商店那条**不是** http(s) 开头的，`/api/v1/proxy` 也需要 token（见 middleware/auth.go 的
query 回退分支）—— 按「像不像外链」判断会让整店退成首字母兜底图。上游 Flutter 端在同一处
栽过（他们用 `endsWith('.svg')` 判断，而 `/api/v1/proxy` 结尾没有 `.svg`）。

**订阅源**（`api/plugins.ts` 的 `getPluginRegistries` / `updatePluginRegistries`）：后端只有
「整表读 / 整表写」两个口子（`GET|PUT /settings/plugin-registries`），没有单条增删改，也不是
`/jsplugins/*` 那一家 —— 界面上那个对话框因此是一张**草稿表**，点保存才整份 PUT 回去。
两条语义别弄错：**URL 就是身份**（后端按 URL 匹配条目来源、按 URL 查它自己的 token），所以
改地址等于换一个源、重复地址必须在客户端先拦住；**单源筛选**（`all_sources: false` +
`registry_url`）时后端**不会**去读它存的那份配置，私有源的 token 必须由调用方一起带上 ——
漏了只会得到一句「拉取注册表失败」，完全看不出是缺 token。

**「GitHub 发现」是来源下拉里的第三类东西**（`PluginStore` 的 `GITHUB_DISCOVERY`）：它**不是**
订阅源 —— 不进 `sources`、不发给 `/jsplugins/registry/*`。选中它之后这一页改由
`hooks/useGithubDiscovery` 供数，搜索框那一份关键词同时变成 GitHub 搜索词（还会顺带搜
`owner/repo`）。四条容易做错的：

* **每个仓库都要核对，不能把搜索结果的标题直接列出来**。发现 = 一次搜索 + 每仓库两份读取
  （默认分支的 `plugin.json` + 它声明的 release 资产）。列出来的每一条都必须是「点安装就能装
  上」的 —— 否则用户点下去才失败，而失败的原因（作者还没发布）离这个界面很远。判定全在
  `shared/github-discovery.ts`（清单 / Release 校验、版本比较、卡片状态），主进程与界面共用
  同一份，别在组件里另写一套。
* **网络在主进程**（`main/github-discovery.ts`，IPC `github:discover`）：与 `release.ts` 同一条
  理由（渲染层不直连第三方），而且一页就是几十个请求，清单缓存与「Token 过期 / 限流 / 网络」
  的分类只该有一处。失败以 `{ ok: false, reason }` 回来，**不抛异常** —— 跨 IPC 只剩一句
  message，界面没法按原因分派「改 Token / 等一会儿 / 查代理」。
* **Token 存服务端**（`GET|PUT /settings/github-discovery-token`，与私有源 token 同一套语义），
  匿名每小时只有 60 次，一页 20 个仓库就可能用光；配了 Token 的请求**刻意绕过**加速代理并禁
  重定向（前缀式代理会丢掉 `Authorization`，凭据也不该跟着 302 跑）。代理仍是给匿名请求套的
  前缀，两者互斥（见 `api/endpoints.ts` 那两个函数）。
* **安装走同一条 `runInstall`**，只有 `source_url` 为空（GitHub release 是公开的，后端匿名下载）
  与「先确认来源 + 权限」那一步不同。插件包装上之后服务端那份清单多半没有 `download_url`，
  于是 `discoveryInstallState` 会认不出「它就是刚才这个仓库的」—— 所以本页记一份
  `DiscoverySession`（`entryPath → repoId + version`），否则卡片会当场翻成「覆盖安装」。

### 8.13 整窗透明度 = 透明窗口 + 整棵树 opacity，缺一半都只是「变暗」

设置里「窗口透明度」那两张**整窗**滑块（`AppSettings.windowOpacity` / `miniWindowOpacity`：主窗与
迷你窗各自的整窗浓度；同一张卡片下面还有那两块面板的浓度，那两条与这里讲的不是一回事）要真的
透出桌面，必须**两件事同时成立**：

| 一半 | 在哪 | 少了它会怎样 |
|---|---|---|
| 窗口是**透明窗口** | `main/windows.ts` 的 `transparent: true`（恒开） | 界面再淡也只是与窗口那块底色混在一起，看着像「变暗」，桌面透不进来 |
| 整棵界面树带 opacity | `styles/base.css` 里 `body { opacity: var(--window-opacity) }` | 窗口虽有 alpha 通道，可每一层画上去的都是实心的，全被遮住 |

配套的三条：`html` / `body` **不许铺底色**（主窗口里底色一律由 `.shell` 画，迷你窗里由
`.mini-bar` / `.mini-panel` 画）；这条 opacity 挂在 `body` 而不是 `#root` 上 —— `Modal` 是
portal 到 `body` 的（见 `components/Modal.tsx`），挂在 `#root` 里的话对话框不跟着透，一开一关
是两个浓度；迷你那一份（`--mini-window-opacity`）由 `html[data-mini='true'] body` 顶掉 ——
两个窗口各是一棵独立的界面树，但**共用同一份样式表与同一套变量名**，不靠 <html> 上那个标记
（`main.tsx` 在第一帧之前就打上）就分不开。

★ 它和 `glassIntensity` / `lyricPanelOpacity` / `miniLyricsPanelOpacity` / `miniQueuePanelOpacity`
**不是一类**：那几项调的是「某个面**自己那层底色**」有多厚，而窗口始终是实心的 —— 怎么调都只透出
同一窗口里它下面的一层，桌面永远进不来。播放条 / 迷你条自己的底色浓度因此写死在 `tokens.css` 的
`--bar-tint-opacity`（57%），不再是设置项：让「整窗」与「底色」两层都能拧，只会让人说不清是哪一层在变。
迷你窗那两块面板的浓度是这里面唯一两个**相对值**（100% = 与播放条一致，见 `tokens.css` 那段）：
深浅两个主题下「跟着条走」对应的绝对值不一样，而用户手里只有一根滑块。
⚠ 歌词与队列**各存一份**（浓度 `miniLyricsPanelOpacity` / `miniQueuePanelOpacity`，高度
`miniLyricsPanelHeight` / `miniQueuePanelHeight`）：两块要能分别调。**挑哪一份不在 `tokens.css` 里定**
（那一层只有 `:root` 那几条）：得按 `.mini-player` 上的 `data-panel` 挑，而自定义属性是「声明在哪就在
哪解析」—— 写在 `:root` 上的派生值拿的是 `:root` 那一刻的源值，子孙再改那个变量也影响不到它。
所以「挑」与「由它派生」一起落在 `components.css` 的 `.mini-player` 上：`.mini-player` 自己声明
`--mini-panel-opacity: 100%`（收起那一档）与它派生的底色 / 两条阴影权重，两条
`.mini-player[data-panel='…']` 只覆盖那个源值。老配置里那两个单份的值由 `main/store.ts` 接给两块
（逐项只在新键还没落盘时接，见那里的说明）。

★ 面板浓度还会**顺带换掉窗口那圈阴影**：面板淡下去之后，围着「条 + 面板」那一圈就成了
「围着一块透明区域描边」，而挂件真正的下边缘已经移到了**条的下边** —— 所以那一圈按面板浓度淡出，
同时按互补比例淡入**播放条自己那一圈**。两份权重是 `components.css` 的 `--mini-shadow-keep` /
`--mini-shadow-bar`（加起来恒等于 100%），两个落点是 `.mini-surface` 与 `.mini-player::before`。
⚠ 后者**必须画在不裁剪的那一层上**：条在 `.mini-surface` 里，而那一层 `overflow: hidden` ——
元素自己的阴影不受牵连，子孙的会，挂在条上的话阴影的左 / 右 / 上三条边当场被剪掉。为此
`--win-shadow` 拆成了「颜色 + 模糊半径」几个零件（4 处整条重写 → 1 处 + 各主题覆盖零件），
主窗口读的还是合起来的那一条。`--mini-shadow-keep` / `--mini-shadow-bar` 的值域是**百分比**
（color-mix 的占比吃百分比）。

⚠ 透明窗口是**创建时**属性，运行中改不了 —— 所以它恒开、不跟设置开关（否则拧一次滑块就得
重启应用）。代价是窗口一直带 alpha 通道；两个浓度默认都是 100，观感与改动前一致。
⚠ Linux 下要有合成器（GNOME / KDE 默认都有，裸 WM 下退化成实心，不崩）。另外 Chromium 的
`backdrop-filter` **只模糊同一窗口里它下面的内容**，别指望透明窗口能「毛玻璃看穿到桌面」
（那是 macOS vibrancy / Windows backgroundMaterial 那种系统级能力）。扩展页是 `<webview>`，
guest 自己的背景不透明，那块也永远透不出来。

### 8.14 玻璃的 `--glass` 是无单位数字，两条 `calc` 得自己补单位

`settings.glassIntensity`（0–100）由 `state/useSettings.ts` 写到 `<html>` 的 `--glass` 上，
`tokens.css` 拿它算两样东西：模糊半径（`calc(8px + var(--glass) * 0.28px)`）与那层底色
（color-mix 里的 `* 0.7%`）。这两处**必须自己给单位** —— `--glass` 本身是裸数字，
写成 `8px + 62 * 0.28` 是「长度 + 数字」、`100% - 62 * 0.7` 是「百分比 - 数字」，两条都非法。

自定义属性**不校验**，非法值要到「使用处」才退化：`--glass-blur` / `--glass-tint` 双双失效，
`backdrop-filter` 与 `background` 各自退回初始值 —— 玻璃面整层变透明、模糊消失，
**控制台一声不响**。（历史形态：tokens.css 声明 `62%`、useSettings 写裸数字 `62`，两边互相打架。）

所以：`--glass` 只放裸数字，单位在样式表使用处补。改完跑 `pnpm run e2e` ——
`titlebarGlass` 那两条断言（满窗播放时标题栏换透明底、Esc 收起后回到玻璃底）就是为这件事设的。

### 8.15 播放失败：报在播放条那一行，重试是**重新向后端要一次地址**

两件都踩过：

* **报在哪里**。曾经每次失败都 `useToasts.push`，一首歌三条（第 2 次重试 / 第 3 次重试 / 已跳到
  下一首）。音源成片失效时 toast 会一屏一屏地堆，把用户真正要看的那句话挤没 —— 而且它本来
  就一直在眼前：**底栏（`PlayerBar`）与满窗播放（`FullPlayer`）的歌手那一行**兼作状态行，
  优先级在 `hooks/useNowPlayingStatus.ts`（错误 → 补齐元数据 → 歌手名）。播放路径里不再有 toast。
* **换什么**。客户端**换不了音源**：它只能决定「怎么读同一份音频」（换码率、关音量归一化都是
  这一路），而坏的是那个源。找别的源是后端的活（`SourceOrchestrator`：主源 → 插件内自搜 →
  跨插件 fan-out；解析失败还会起后台 `AsyncReassign` 联网换源并回写 `source_data`）。
  所以失败后的动作是**等一小会儿（`RETRY_DELAYS_MS`）重新要一次播放地址**（带 `retry=` 参数，
  绕开浏览器对同一 URL 的缓存复用），让后端重新解析 / 重新找源；试满 `MAX_PLAY_ATTEMPTS` 次
  才跳下一首（本地文件没有别的源可找，只重试一次）。全过程见 `localPlayer.handlePlaybackFailure`。
* 附带一条防呆：整个队列轮一遍都是 0 成功时**停下自动跳过**（`consecutiveFailures`）——
  否则「后端不可达」会表现为界面自己跳个不停，把错误也一起刷掉。

### 8.16 本地文件即播：必须走自定义协议，且「免登录」是与 `status` 正交的一位

「双击一个音频文件就能放」在桌面端有三个来源，而它们到达的时刻都很随意：启动参数（Windows /
Linux 的文件关联把路径追加在 argv 里）、macOS 的 `open-file` 事件、用户自己从菜单（Ctrl+O）或
「曲库 → 本地」那一半挑的。链路：`main/local-files.ts`（收件口：排队 + 摇铃）→
`IPC.localFilesTakePending`（取走）→
`renderer/state/useLocalFiles`（收件箱 → 队列）→ `main/media-protocol.ts`（把地址读成字节）。

* **播放地址必须是自定义协议 `songloft-media://`，不能是 `file://`。** Chromium 不允许 http(s)
  页面加载 `file://` 子资源，而开发态的页面正是 `http://localhost:5173` —— 写成 `file://`
  的结果是**开发态一首也放不出来、打包态却一切正常**（最坏的一种不一致）。登记要在
  `app ready` **之前**，且必须带 `stream: true`：不加它 Chromium 会把整份响应缓冲完才交给
  `<audio>`（几十 MB 的 FLAC 要等读完才出声）。打包态的 CSP 还要在 `media-src` 里放行这个
  scheme —— 漏掉只在控制台报一句，界面上就是「点了没反应」。
* **`Range` 是主路，不是支线。** Chromium 的媒体栈**第一个请求就带** `Range: bytes=0-`（实测），
  所以协议处理器的 206 分支每次本地播放都会走：`Content-Range` / `Content-Length` 写错，症状是
  「放不出来」或「时长显示不出来」，而**不是**「只有拖进度条才有问题」。区间解析是纯函数
  `shared/local-file.parseByteRange`（有单测）。
* **交付路径是「排队 + 来取」，不能只靠推。** 前两个来源可能早于渲染层就绪（双击文件启动时
  Chromium 还在加载页面），此刻推过去的消息直接消失 —— 用户双击了文件却什么都没发生、也没有
  任何报错。所以主进程排队（`queuePaths`），渲染层开机取一次（`installLocalFileIntake` 里那次
  `takePending`）、之后每次收到摇铃再取；取走即清空，于是「早到晚到都只处理一次」。与
  `miniIsOpen` 同一条理由。
  ★ **摇铃必须送给「正在播放的那个窗口」**（`sendToHost()`）：双击文件起的那一趟里没有主窗口，
  播放器在迷你窗手里（见 §8.17），写死主窗口的话第二个文件就掉了。
* **「免登录」是独立的一位 `useAuth.guest`，不要往 `AuthStatus` 里再加一档。** status 答的是
  「与服务器现在是什么关系」，「不连服务器、只听本机文件」与它正交 —— 免登录之后照样可以再登录。
  ★ **它是默认形态**（初值 true）：没会话就直接进主界面，登录页**只是一个目的地** ——
  侧栏那颗「连接服务器」、设置里的「切换账号」、退出登录，以及「存着的凭据已失效」
  （`bootstrap` 里那两条，唯一一处会主动把人推到登录页的启动路径）。出口是登录页左上角那颗
  返回（`closeLogin`）。于是「这一帧显示什么」只有一处判断（`App.tsx` 的 `screen`）：
  `booting → 占位 / authenticated → 主界面 / guest → 主界面 / 否则 → 登录页`。
  `booting` 必须单独一档且排最前，否则有会话的人会先闪半秒免登录的主界面。
  ★ 没会话时**默认落点是「本地文件」那一页**（`App` 的启动编排里 `setNativeRoute({name:'local'})`，
  不走 `navigate`：那不是用户走的一步，进历史会让 Alt+← 退回一页读不了数据的首页）。
  **主界面要等编排走完才挂**（`App` 的 `booted`）：落点与会话分属两份 store、各走各的调度，
  落了点才挂的活必须与它同一步 —— 否则中间会实打实挂出一帧默认路由（首页）的主界面，
  而首页 / 歌单 / 收藏 / 搜索在没有会话时读不了任何数据（`requireClient()` 同步抛，
  抛在 effect 里会掀掉整棵组件树，表现是整个窗口一片空白）。这一条是踩过的。
  ★ 登录页的「已保存的登录」判据是**本机还有没有那台服务器的凭据**，不是 `servers` 里有没有它：
  退出登录只抹凭据、**服务器条目留着**（地址与备注名有用，表单就预填着它）—— 只认 `servers` 的话，
  刚退出的那台会继续挂在那块「点一条就用本机凭据直接进入」下面，点下去却进不去。判据取自
  `servers.accounts()` 的**键集**（见 main/store.ts 的 listAccounts），别改回「只收有账号名的」。
  **播放本身从不问登录状态**：本地文件读磁盘，只有曲库那几页要会话；免登录时侧栏与标题栏下拉
  只留「曲库 + 设置」，而且曲库那颗钮的落点是**本地**那一半（页头那颗「本地 / 服务器」切换在
  免登录时不摆出来，见 components/LibraryHeader）—— 其余每一项点进去都是一页「尚未登录」，
  摆着不如不摆。命令面板与工具栏搜索也一并收起来。
* **本地文件的 id 是路径散列取负**（`localSongId`）：服务端 id 全是正整数，负数永远撞不上
  （撞上的后果是收藏 / 播放上报落到曲库里另一首歌头上）。所有要走服务端的动作都得让开：
  播放上报与「最近播放」、歌词、多音轨探测、元数据补齐（`song-metadata` 会请服务端跑一次
  **全库**刷新）、收藏（`usePlaylists.setFavorite`）、歌曲右键菜单（`songMenu`）。
  **队列持久化也要按留下的那一份重算游标** —— 直接写 `queue` 里的下标，一旦前面有本地文件
  被筛掉，恢复出来的位置就整体前移（表现是「开机后停在了别的歌上」）。
* 打包侧在 `electron-builder.yml` 的 `fileAssociations`（三平台各一份落地），只列 Chromium
  **真能解码**的格式：认领了却放不出来（wma / ape / dsf 这类）比不认领更糟 —— 用户双击之后只
  得到一句「无法解码」，而系统里那份关联已经被我们抢走了。Linux 那份的 MIME 由 electron-builder
  拼进 `.desktop` 的 `MimeType`，所以 `desktop.entry.MimeType` **不能再显式写**（会被整个覆盖），
  原有的 URL 协议那条挪去了 `linux.mimeTypes`；改完照旧要 `pnpm run pack:linux` +
  `pnpm run verify:package`（后者已断言条目里带 `audio/mpeg`）。
* 这条链**不在 `pnpm run e2e` 里**（e2e 里没有可双击的文件）。要端到端验一遍，最省事的做法是
  把它当启动参数递进去：`SONGLOFT_USER_DATA=$(mktemp -d) electron . --no-sandbox <某个音频文件>`
  —— 应当**只有一条迷你播放器露面、没有主窗口**，并且直接出声（见 §8.17）；不带文件的普通启动
  照旧是完整主界面。再从菜单 / 「曲库 → 本地」那一半挑文件时走的仍是**主界面**那条路
  （免登录 + 曲库页的「本地」那一半）。

---

### 8.17 本地文件会话：那一趟里迷你窗**自己就是播放器**，而且没有主窗口

「双击一个音频文件就开始放，而且**只**起一个迷你播放器、主播放器保持关闭且不可打开」——
这一节的四件事就是它的落地。改任何一件之前先读这里：

| 位置 | 事实 |
|---|---|
| `main/index.ts` 的 `localSession` | 判据 = argv 里有音频文件（Windows / Linux 的文件关联），或 macOS 那份 `open-file` 赶在 ready **之前**到了。命中就**不创建主窗口**，只 `openMiniWindow('mini-host')` |
| `shared/window-role.ts` | 迷你窗的两种身份由 **URL hash** 定：`#mini`（跟随者）、`#mini-host`（宿主）。渲染层按它分流 |
| `renderer/state/usePlayer.ts` | 分流器：宿主（主窗口 / 迷你宿主窗）拿到 `player-core`，跟随者拿到 `remotePlayer` |
| `renderer/state/local-session.ts` | 宿主那一窗的启动编排：`primeAudio` + 系统媒体控件 + 托盘与媒体键的命令 + **取件即播** |

* **这一趟刻意不抢单实例锁**（`const gotTheLock = launchFiles.length > 0 || app.requestSingleInstanceLock()`）：
  双击第二个文件要的是**另起一个迷你播放器**，而不是把文件塞给在跑的那个主界面 —— 于是
  「多实例」是**需求**，不是 bug，别顺手把锁加回来。反过来，普通启动照旧抢锁，「再点一次图标」
  仍然只是把主窗口顶到前面；没抢到锁的进程要继续把 argv 交给在跑的那个实例（`second-instance`）。
  macOS 上不成立：系统不会为一次双击另起进程，而是往已在跑的实例发 `open-file` —— 那一趟走的是
  普通会话（文件加进当前界面），**不是**本地文件会话。
* **「谁在播」只有一种判据：窗口角色，而且是加载那一刻定死的。** 别在渲染层问「主进程有没有
  主窗口」（问不到，而且它答的是**此刻**），也别按「是不是迷你窗」来分 —— 迷你宿主窗的存在正是
  为了打破那个二分。核心（`state/player-core.ts`）因此**不读任何窗口相关的东西**：
  它要用到会话时只经 `resourceContext()` 问一句「现在拿得到地址和 token 吗」，拿不到就按没有
  会话处理。
* **主进程要送给「正在播放的那个窗口」的东西一律走 `sendToHost()`**：本地文件的摇铃
  （`IPC.onLocalFilesPending`）与托盘 / 媒体键的命令（`IPC.onMediaCommand`）都算。写死
  `sendToRenderer`（= 主窗口）的话，本地会话里「再双击一个文件」「托盘上按一下暂停」会静默地
  掉进一个不存在的窗口 —— 点了没反应，也没有报错。
* **关掉迷你条就退出应用**（`installMiniWindow` 的 `onOpenChanged(false)` 那一段）：那一趟里
  它是唯一的界面，留着只剩一个看不见的进程（音频照放，除托盘外没有任何入口）。托盘里也**没有**
  「显示 / 隐藏主窗口」那一项（`TrayDeps.windowItem` 返回 null）—— 摆一项只会把人引向一个永远
  不会出现的窗口；点托盘图标是「把迷你条唤回来」。
* **本地会话不许改写在线播放队列。** `player-core` 的持久化订阅有两道闸门：会话不是
  `authenticated`、或**整队都是本机文件**（非空、却一首曲库的歌都没有）时，直接不写。
  否则「听了两首本地文件」会把 `lastQueue` 抹成空，用户下次登录时上次的队列就没了 ——
  这正是「本地播放列表的内容不该影响在线播放列表」那条需求的落点（另一半更彻底：
  本地会话与主界面**根本不在一个进程里**，`useLocalFiles` 那份列表只活在宿主窗的内存里）。
* 这一趟里**没有会话**：不 bootstrap、不碰凭据、不发业务请求（与跟随者同一条理由，见
  `useAuth` 的 `mirroredMedia`）。所以条上的**收藏钮整个不出现**（收藏要走后端，摆一颗点了没
  反应的钮比不摆更糟），「显示 / 收起歌词」那条媒体命令落在下方那块歌词面板上（那一窗没有抽屉）。
* **多实例 ⇒ 落盘必须现读现改**（`store.ts` 的 `mutate`）：两个实例共享同一个 userData 目录，
  若各持一份启动时的快照、每次整份写回，就会互相抹除 —— 症状是「我刚拖高的面板过一会儿自己
  变回去了」「这边刚存下的队列被那边一次毫不相干的写入打回去」，而两次写入之间看不出任何关系。
  于是每次写入都先从磁盘重读一份、只改自己那一个键。改 `store.ts` 时别把这条当成性能优化删掉。
* 迷你窗还有一条与身份无关的兜底：渲染层**迟迟不报 ready**（页面压根没加载起来）时，
  `LOAD_FALLBACK_MS` 一到就先把窗口亮出来。跟随者那一边这只是「条出来了」；本地会话里那一窗
  是唯一的界面，藏起来就成了「双击了文件，什么都没有」。

### 8.18 Windows 免安装（绿色）版靠**一个标记文件**认自己，而安装包必须把这个标记删掉

免安装 zip 版承诺的是「整个文件夹拷走就带走全部配置」—— 那要求用户数据落在 exe 旁边的
`data\` 里，而不是 `%APPDATA%`。判据**不能**是「目录写不写得进去」：NSIS 的默认安装目录
（`%LOCALAPPDATA%\Programs\…`）同样可写。能区分两者的只有 **exe 旁边有没有那个标记文件**
（`portable.txt`；名字与判据在 `src/shared/user-data.ts`）。

于是 `win.extraFiles` 把它放进 appOutDir（`build/portable.txt`，落点就是 exe 旁边，**不是**
`resources/`），而这份配置是**平台级**的：zip 要留着它，NSIS 装完必须删掉它 ——
`electron-builder.yml` 的 `nsis.include: build/installer.nsh` 干的就是这件事（`customInstall`
的插入点在文件拷完之后）。两半是同一件事，缺一个都**静默**走错方向：

| 只动了一半 | 症状 |
|---|---|
| 删掉 `installer.nsh` 里那句 `Delete` | 安装版把配置写进安装目录，卸载 / 换安装目录就把用户数据一起弄丢 |
| 拿掉 `win.extraFiles` | 绿色版退化成「免安装、但配置还在 `%APPDATA%`」，拷到别的机器上配置全没了 |

三档优先级（`SONGLOFT_USER_DATA` > 免安装的 `data\` > 系统默认位置）与「只读介质上要退回系统
默认位置、不能因为目录建不出来就起不来」这条兜底都在 `src/shared/user-data.ts`，单测钉着
（`user-data.test.ts`）。`pnpm run pack:win` 会同时产出 `.exe` 与 `.zip`，两份靠扩展名区分。

---

## 9. 不要做

* 不要只改 `.desktop` 相关的三处之一（见 8.1）。
* 不要把 `build/installer.nsh` 里那句 `Delete` 当成多余代码删掉 —— 它是免安装版与安装版的分界
  （见 8.18），删了会让安装版把用户数据写进安装目录。
* 不要把「窗口 icon」当成任务栏图标的解决方案：Wayland 下它传不出去，缺的永远是宿主上
  那份 `.desktop`（见 8.11）。
* 不要让应用在启动时自行往 `~/.local/share` 之类的用户目录写桌面条目 / 图标：桌面集成走
  `pnpm run desktop:install`（显式命令，§8.11）。
* 不要给渲染层开 Node 能力，也不要为了省事把 `contextIsolation` / `sandbox` 关掉。
* 不要让 `html` / `body` 铺底色，也别以为「给界面加一层 opacity」就够 —— 整窗透明度要
  透明窗口与整棵树 opacity 一起成立（§8.13）。
* 不要在渲染层把 token 拼进请求头去取封面/音频 —— 那两处只能走查询参数。
* 不要给「播放失败」弹 toast：错误要说在播放条那一行（见 8.15），成片失效时 toast 会堆满一屏。
* 不要靠换码率 / 关音量归一化来「换源」：那是换读取方式，换不了源；重新向后端要地址才是（见 8.15）。
* 不要在 DOM 元素上写 `title=` 当提示：那是浏览器自带的黑框，配色不跟主题、出现时机也不受控。
  一律写 `data-tip="…"`，由 `components/Tooltip.tsx` 的全局浮层统一显示（图标按钮仍要留
  `aria-label`，浮层是 `aria-hidden` 的，不承担可访问名）。浮层跟着指针走（起在指针右下方，
  放不下就翻到另一侧，四边再夹进视口），所以没有「按元素挑方位」这一档，也就不存在
  `data-tip-place` 之类的方位属性。
* 不要把 `build/` 当运行期资源目录。
* 不要在 `shared/` 里引入副作用或 electron 依赖。
* 不要为了让 `format:check` 通过而给文件加 `prettier-ignore` —— 直接跑 `pnpm run format`。
* 不要提交 `out/` / `release/` / `.e2e/` 与根目录的 `electron.vite.config.*.mjs`
  （后者是 electron-vite 的转译副本，正常会被自动删除，异常残留时已在 `.gitignore` 里）。
* 不要把扩展页装进 `<iframe>`：跨源 iframe 既静音不了、也探不到在不在出声（§8.12）。
* 不要把扩展页的 webview 放进 `defaultSession`：宿主注入的 CSP 会把插件页一起改写（§8.12）。
* 不要在切到插件商店 / 插件管理时卸载 `PluginSurface`：那会把正在出声的扩展一起关掉，
  也就是「点一下插件管理，音乐就断了」（§8.12）。
* 不要在标题栏的扩展下拉里塞管理动作（停用 / 卸载）：那一份菜单只做跳转，管理在「插件管理」
  那一栏；真要再加入口就复用 `lib/plugin-actions`（§8.12）。
* 不要把本地文件的播放地址写成 `file://`：开发态上网页面在 http:// 上，Chromium 会直接拒掉，
  且**一声不响**（见 8.16）。一律走 `localFileUrl()`。
* 不要让「未登录」挡住播放：曲库那几页需要会话，播放与本地文件不需要（见 8.16）。也不要给
  免登录再往 `AuthStatus` 里加一档 —— 它是与 status 正交的一位。
* 不要把没会话的人丢进「首页」那类页面：它们全都读后端，`requireClient()` 是同步抛的，
  抛在 `useAsync` 的 effect 里会掀掉整棵组件树（见 8.16）。没会话的落点是「本地文件」。
* 不要只靠 `onPending` 推来接手本地文件：那条通知可能早于渲染层就绪，文件会静默丢掉
  （见 8.16 的「排队 + 来取」）。
* 不要把「送给播放器的那点东西」写死成主窗口：本地文件的摇铃与托盘 / 媒体键的命令一律走
  `sendToHost()`（见 8.17）。
* 不要在渲染层猜「我在哪个窗口」：角色由 URL hash 定（`shared/window-role.ts` +
  `lib/window-role.ts`），而且**播放核心不许依赖它**（见 8.17）。
* 不要让「本地播放」那两趟（免登录、本地文件会话）改写「上次队列」：那等于用本地播放列表的
  内容覆盖在线播放列表，用户下次登录就发现队列没了（见 8.17）。
* 不要给本地文件会话抢单实例锁，也别替它创建主窗口 —— 「主播放器不可打开」就是这么成立的
  （见 8.17）。

---

## 10. 与上游的能力差异

已对齐：曲库浏览（类型 / 分面 / 排序 / 无限滚动）、歌单增删改与拖拽重排、收藏、最近播放、
文件夹浏览、逐字歌词与点击跳转、播放队列、命令面板、扫描与重复检测、设置项。

**本地文件即播（桌面端独有）**：双击本机的音频文件（或菜单 / 曲库页的「本地」那一半里挑）就开始放，
**不需要登录、也不进曲库** —— 上游只有「后端扫描入库的本地文件」这一条路。装了包之后系统里
「用 Songloft Desktop 打开」也归它（`fileAssociations`，见 §8.16）。
★ 双击文件起的那一趟是**本地文件会话**：**只**起一个迷你播放器（它自己就是播放器），主界面
压根不创建，本地文件那份播放列表也**不碰**在线播放列表（见 §8.17）。

**JS 插件（扩展）**：已实现「列表 / 启用停用 / 卸载 / 上传 zip / 从商店安装 / 调整顺序 /
批量更新 / 单插件更新（检查 + 下载）/ 常驻运行 / 清理残留数据」与「扩展主框架（插件商店 +
插件管理 + 扩展侧栏）」，商店那一栏还能管理订阅源（增删启停 + 私有源 token）并按源筛选。

插件管理页每一行尾部是「⋯」菜单（与上游 Flutter 端的行内 PopupMenuButton 对齐）：
**常驻运行**（`GET|PUT /settings/plugin-keep-alive` 的白名单，形态是 `{plugins:[entryPath…]}` ——
整表覆盖写，所以切换时**必须现读现改**，拿旧列表覆盖会抹掉别处刚加的项；白名单里的插件
跳过空闲卸载，见 jsplugin/health.go 的 checkIdle）、**更新**（先 `GET /{id}/check-update`
再 `POST /{id}/update`，后端装完会顺手重载）、一条分割线、**删除**（`DELETE /{id}`）。与上游的形态差异是**入口位置**：上游把插件
挂在底部导航栏的 Tab 上，本仓库没有底部导航栏，改成标题栏左上角一个入口，点下去把标题栏以下
整块换成扩展主框架（布局与坑见 §8.12）。仍缺一件：商店里标着「有新版本」的条目只能逐个装 ——
「全部更新」调的是后端的批量更新，它只覆盖**声明了远程更新源**（manifest 的 `updateUrl`）的
插件，其余的按 skipped 计。插件的**页面本身**仍由服务端提供（渲染在 webview 里），所以上游那些
插件自带的 UI 一行都不用重写。

未实现（换栈后需重做）：均衡器、无缝播放 / 淡入淡出、DLNA 投送、桌面歌词、
「缓存到本机」（把单曲下载到设备本地离线播放 —— 设置页里那份「本地缓存」是**另一回事**，
它清的是 Chromium 会话缓存）。详见 README 的「与上游 Flutter 版的差异」一节。
