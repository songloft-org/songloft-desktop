# Songloft 桌面端改用 Electron 重写：技术方案评估

> 评估对象：`songloft-org/songloft-player`（Flutter 客户端）→ Electron 桌面客户端
> 评估范围：**仅桌面端**（Windows / macOS / Linux），移动端与 Web 端不在迁移范围内
> 评估日期：2026-10-12
> 数据来源：① `ref-player` 仓库静态分析；② 本仓库已完成的 Electron 实现（PoC，可运行）实测；③ 公开发布的框架现状核查

---

## 0. 结论摘要

**一句话结论：就"桌面端"这一个目标而言，迁移到 Electron 在技术上是成立且明显占优的；但它真正的代价不在技术，而在"客户端从 1 套变 2 套"这个组织级决策上。**

| 判断项 | 结论 |
|---|---|
| 技术可行性 | ✅ 已用本项目代码验证：61 个文件、14,256 行即达到桌面端可用状态，`typecheck`/`lint`/`build` 全绿，并在虚拟显示中端到端跑通 |
| 迁移的最大收益 | **音频栈塌缩**——Flutter 版跨 8 个包 + libmpv 原生库 + 2 处 vendor/override 的音频链路，在 Electron 里退化为 `new Audio()` + Media Session |
| 迁移的最大代价 | **客户端一分为二**：移动端/Web 仍留在 Flutter，桌面端的每次改动要修两遍；这不是技术能消解的 |
| 体积/内存代价 | **实测：Electron deb 95.4 MiB（安装后 284 MB）、AppImage 112 MiB；Flutter 版 deb 自报安装体积 100 MB。即约 2.8 倍** —— 是必须正视的真实差距，但远小于"5–10 倍"的流行说法。内存仍是 Electron 明显劣势 |
| 若坚持要迁移 | 推荐 Electron，但必须接受 3 条约束：① 明确桌面端为独立产品线并配独立维护预算；② 补 `jsplugin`（6,123 行）/ `dlna`（989 行）/ `desktop_lyric`（690 行）三个缺失模块；③ 建立 Chromium 大版本升级节律 |
| 若不迁移 | 也完全站得住：Flutter 桌面端 2026 年已出 Beta、Impeller 在桌面端成为默认渲染器，且 Canonical 于 2026 年 Google I/O 正式接管桌面端维护。**"Flutter 桌面端不成熟"这个论据在 2026 年已经过期** |
| 横向选型 | 本项目加权得分：Electron 4.57 > Flutter 3.72 > Qt 3.42 > Avalonia 3.25 > Wails 3.15 > Compose MP 3.07 > **Tauri 3.00** > 全原生 2.55。Tauri 在通用场景下很强，但在**本项目**的权重下垫底（见 §5.4 敏感性分析） |
| 国内方案（uni-app x / Lynx） | **两者都不能交付 Linux 桌面，因此不是"评分高低"问题，而是被平台门禁直接排除**（§4.5）。uni-app x 官方编译目标只有 Android/iOS/鸿蒙/web/小程序，2026 路线图也无桌面；Lynx 官方支持 Android/iOS/Web/OpenHarmony，桌面走 **Lynxtron**（Node 宿主 + Lynx 轻渲染器替换 Chromium），官方测试平台仅 macOS 与 Windows，且仍是 Alpha |

---

## 1. 评估背景

### 1.1 现状规模（实测）

| 项目 | Flutter 版（`ref-player`） | Electron 版（本仓库） |
|---|---|---|
| 源文件 | 347 个 `.dart` | 61 个 `.ts/.tsx/.css` |
| 代码行数 | 102,545 行（均为手写，无生成物） | 14,256 行 |
| 目标平台 | 6（android / ios / linux / macos / web / windows） | 3（win / mac / linux） → 本次仅取 Linux 验证 |
| 平台目录文件数 | android 55 / ios 57 / web 738 / macos 34 / windows 22 | — |

Flutter 版代码分布（行数）：

| 模块 | 行数 | 说明 |
|---|---|---|
| `features/settings` | 16,649 | 设置中心（本项目最重的模块） |
| `features/player` | 15,068 | 播放器、队列、EQ、视频面、桌面/移动两套 UI |
| `features/library` | 7,390 | 曲库 |
| `features/jsplugin` | 6,123 | **JS 插件系统**（从 GitHub 发现/安装/管理插件） |
| `features/playlist` | 6,045 | 歌单 |
| `features/home` | 3,740 | 首页 |
| `features/auth` | 1,372 | 登录鉴权 |
| `features/dlna` | 989 | **DLNA 投送** |
| `features/desktop_lyric` | 690 | **桌面歌词悬浮窗** |
| `features/startup` | 404 | 启动引导 |
| `l10n` | 22,941 | 3 个语种（zh/en/es）的本地化 |
| `core` + `shared` + `config` | 20,543 | 基础设施 |

> ⚠️ **口径提醒**：14,256 行 ≠ 完整对齐 102,545 行。差额来自三个方向：① **主动砍掉 4 个平台**（这是本次迁移的既定前提）；② **尚未实现的功能**（§4.4 列出）；③ Flutter 版每个界面都有桌面/移动两套实现（`desktop_player.dart` vs `mobile_player.dart`）。本报告不把行数差当作"效率提升"来宣称，只把它作为"桌面端这件事本身没那么大"的量级证据。

### 1.2 参考仓库的桌面端现状（这部分决定"迁移值不值"）

评估迁移价值，必须先看 incumbent 在桌面端**实际痛在哪**。以下全部是从 `ref-player` 里读出来的硬事实，不是推测：

**痛点 A — 音频栈是 8 个包的连体结构**

`pubspec.yaml` 中的音频相关依赖：

```
just_audio / just_audio_platform_interface(自实现 SongloftMediaKitPlayer)
just_audio_media_kit          # Windows/Linux 后端（libmpv）
media_kit (+ vendor 到 third_party/)   # 直接操作 NativePlayer 设 mpv 音频滤镜（EQ）
media_kit_video
media_kit_libs_{windows,macos,ios,android}_video   # 4 个平台的预编译原生库
audio_service / audio_service_mpris  # Linux MPRIS 媒体键
audio_service / smtc_windows         # Windows 系统媒体传输控件
audio_session
synchronized                          # songloft_web_audio_player 的依赖补丁
```

外加 `songloft_web_audio_player`（自 `just_audio_web` vendor）。**这套链路的本质是：Flutter 没有可用的跨平台音频后端，所以要么走 libmpv（原生库），要么每个平台各写一套系统媒体桥（MPRIS / SMTC），还得自己实现 `AudioPlayerPlatform` 接口。**

**痛点 B — 两处 `dependency_overrides`（技术债已显形）**

```yaml
dependency_overrides:
  media_kit:
    path: third_party/media_kit     # 本地补丁：mpv 创建/初始化失败时安全报错（issue #49）
  flutter_rust_bridge: 2.11.1       # smtc_windows 的 Rust codegen 与 runtime 版本必须对齐
```

`media_kit` 被 vendor 进仓库，意味着**每次上游发版都要重新 rebase 补丁**；`flutter_rust_bridge` 被硬钉版本，意味着**一个 Windows 专用包的构建链会锁死整个项目的依赖解析**。这是典型的原生插件生态债。

**痛点 C — GTK runner 里为 libmpv 打了 C++ 补丁**

`linux/runner/my_application.cc:112-117` 与 `mpv_locale.h`：

```cpp
// GTK sets LC_ALL from the user's environment during startup. libmpv rejects
// non-C numeric locales in mpv_create(). Reset only numeric formatting before
// any Flutter/libmpv worker is created.
inline bool EnsureMpvNumericLocale() {
  return std::setlocale(LC_NUMERIC, "C") != nullptr;
}
```

**为绕过一个原生库的 locale 行为，必须侵入平台 runner 的 C++ 启动流程。** 这类问题在 Electron 里不存在——音频解码在 Chromium 内部，与宿主进程的 locale 无关。

**痛点 D — 图标要 5 套流程**：`flutter_launcher_icons`（android/ios/macos）+ `scripts/generate-icons.sh`（Windows ICO 多分辨率 + Web PWA，因为前者会把多尺寸压成单尺寸、丢 maskable）。Electron 侧 electron-builder 从单张 1024px PNG 派生全部。

**痛点 E — 发布矩阵 9 个 target**：`distribute_options.yaml`（fastforge）里 deb / rpm / appimage / dmg / pkg / exe / msix / apk / aab 共 9 个 job。桌面端迁移后可用 electron-builder 收敛到 3 个。

**痛点 F — 本地化产物 22,941 行**：3 个 `.arb` 源文件生成 22,941 行 Dart。不是问题，但在"换栈"时可以低成本转成前端可直接消费的 JSON（见 §7 的缓解措施）。

### 1.3 ⚠️ 反方证据：incumbent 在 2026 年已经变好了

做迁移评估最容易被忽略的是**"现状也在演进"**。核查到的事实：

- **Google I/O 2026 宣布 Canonical 成为 Flutter 桌面端（Win/mac/Linux）的首席维护者与战略托管方**。此前 Canonical 自 2021 年起把 Flutter 定为 Ubuntu 新应用首选，已用其交付 App Center、Firmware Updater、Security Center。维护权从"众多贡献者之一"变为"正式接管"，是结构性信号而非版本级打磨。
- Flutter 桌面端**已脱离 Beta、成为一等公民**；`Impeller` 自 3.47（2026-08）在 macOS/Windows/Linux 上成为默认渲染器（消除着色器编译卡顿）；多窗口 API 落地——而多窗口正是"桌面歌词悬浮窗"这类需求的前提。
- 插件生态：Flutter Gems 收录 >7,250 个包，`window_manager` / `tray_manager` / `system_tray` / `file_selector` 等桌面专用包已成熟。

**结论：如果迁移的论据是"Flutter 桌面端不成熟"，那这个论据在 2026 年 10 月已经站不住了。** 迁移只能建立在另外三条论据上：音频栈可维护性、团队技术栈匹配、桌面产品线的独立战略。本报告的选型建议完全按这三条来推。

---

## 2. 迁移收益（优势）

### 2.1 音频与媒体链路从"跨 8 个包 + 原生库"塌缩为"平台原生能力"

| 能力 | Flutter 版实现 | Electron 版实现 |
|---|---|---|
| 音频解码播放 | just_audio → just_audio_media_kit → libmpv（系统/预编译原生库） | `HTMLAudioElement`（Chromium 内置 ffmpeg） |
| 编解码器覆盖面 | 取决于 libmpv / 系统 GStreamer 组件 | **Electron 官方构建默认带 AAC / H.264 专有编解码器**，另有 `downloadAlternateFFmpeg` 可切换为专利干净版 |
| Linux 媒体键 | `audio_service_mpris`（D-Bus MPRIS 手写桥） | **Media Session API → Chromium 自动映射到 MPRIS** |
| Windows 媒体键 | `smtc_windows`（Rust + flutter_rust_bridge） | Media Session API（自动） |
| 均衡器 | 直接访问 `NativePlayer` 设 mpv 音频滤镜 | Web Audio API `BiquadFilterNode` 链（**待实现**，见 §4.4） |
| 视频播放 | media_kit_video + 4 个平台预编译库 | `HTMLVideoElement`（内置） |
| 播放列表无缝/淡入淡出 | mpv 能力 | 需自行在 Web Audio 图里实现（**能力缺口**） |

**这是本次迁移最强的技术论据**：它一次性消灭 2 个 `dependency_overrides`、1 个 vendor 目录、4 个平台预编译库包、1 个自实现的 platform interface，以及 1 处 GTK runner 的 C++ 补丁。

### 2.2 渲染与 UI 的跨平台一致性达到上限

Electron 自带 Chromium，**三平台同一渲染引擎**。对此应用尤其重要，因为它的 UI 形态是：

- 大表格（曲库 43 列级别的行渲染、无限滚动、虚拟化）
- 封面网格 + 主色提取驱动的全局强调色
- 逐字歌词的卡拉OK 高亮滚动
- 毛玻璃/半透明表层与进度条动画

这类"web 形状"的界面在 Chromium 上是主场。而系统 WebView 方案（Tauri/Wails）在 Linux 走 WebKitGTK，在这几个形态上都要额外 QA。

### 2.3 与现有产品的架构契合度被低估了

**关键发现：这个客户端本身就已经把 JavaScript 当作扩展语言。** `features/jsplugin`（6,123 行）实现的是"从 GitHub 发现并安装 JS 插件"的完整体系（plugin registry / icon / order / manager / github discovery）。

- 在 Flutter 里，宿主是 Dart，插件是 JS → 需要一个 JS 运行时和跨语言桥。
- 在 Electron 里，宿主本身就是 JS → 插件可以直接跑在同一个运行时里（沙箱化 iframe 或 worker），插件 API、插件本身**有机会在移动端与桌面端之间复用**。

再叠加两点契合：
- **后端已经承担重活**（扫描、元数据、转码都在 Go 服务端），客户端是薄 HTTP 客户端 → **桌面客户端的性能天花板不是瓶颈**，选型的决定性因素让位给"打包一致性 / 生态 / 迭代效率"。这正是 Electron 的强项区。
- **已有 Web target**（`web/` 738 个文件）→ 存在"复用 Web 前端 + 原生外壳"的快速路径（§6.4）。

### 2.4 工程效率与团队技能匹配

- TypeScript / React / Vite 的技能供给与招聘面远宽于 Dart。
- 迭代反馈：Vite HMR + Chromium DevTools（含网络与性能面板），与本项目 PoC 的实际体验一致——14,256 行规模的项目在一个工作时段内从零到达"类型检查 + lint + 构建 + 端到端跑通"。
- 复用了两边都成熟的基础设施：pnpm / ESLint flat config / Vitest / GitHub Actions matrix。
- 后端是 Go、客户端是 TS，**没有引入第三种语言**（对比 Tauri 引入 Rust、Qt 引入 C++）。

### 2.5 桌面集成与发布链路

| 需求 | Electron 现状 |
|---|---|
| 无边框窗口 + 自绘标题栏 | 已验证（PoC 落地，并修掉了登录页缺 TitleBar 导致"既不能拖也不能关"的缺陷） |
| 托盘 + StatusNotifierItem | 已验证（D-Bus 中成功注册） |
| 全局媒体键 | `globalShortcut`（Media PlayPause / Next / Previous / Stop） |
| 桌面歌词悬浮窗 | 透明置顶 BrowserWindow，实现成本极低 |
| 封面主色提取 | 主进程取字节 + `createImageBitmap`，绕开 canvas 跨域污染 |
| 打包 / 自动更新 / 崩溃上报 | electron-builder + electron-updater + crashReporter，一条成熟链路 |

---

## 3. 迁移代价（劣势）

### 3.1 体积与内存（**已实测，不是估算**）

Linux x64 实测结果：

| 指标 | Flutter 版 | Electron 版 | 倍率 |
|---|---|---|---|
| 安装后占盘 | **100 MB**（deb `installed_size: 102400` KB） | **284 MB**（deb `Installed-Size: 290532` KB） | **2.8×** |
| 分发文件（deb） | 未实测（按 installed_size 推算 ~40 MB） | **100,003,084 B = 95.4 MiB** | ~2.4× |
| 分发文件（AppImage） | 未实测 | **117,249,950 B = 111.8 MiB** | — |
| 分发文件（tar.gz） | 未实测 | **119,238,719 B = 113.7 MiB** | — |
| 应用自身代码 | libapp.so | `out/` = **1.1 MB**（js 969 KB + css 46 KB） | 可忽略 |
| 运行时主体 | libmpv + GTK + ICU + libflutter_linux_gtk.so | 单文件 219 MB + ICU 11 MB + resources.pak 13 MB + locales 8.7 MB | Electron 更大 |

Electron 产物的体积构成（`release/linux-unpacked`，共 284 MB）：

```
219 MB   songloft-desktop        ← Chromium + Node 合并后的单一可执行文件
 20 MB   LICENSES.chromium.html
 13 MB   resources.pak
 11 MB   icudtl.dat
8.7 MB   locales/
4.5 MB   libvk_swiftshader.so
2.7 MB   libffmpeg.so            ← 编解码器就在这里（AAC/H.264 默认包含）
2.4 MB   libvulkan.so.1
```

**三条必须纠正的常见说法**：

1. ❌ "Electron 大 5–10 倍" —— 实测在 Linux 上是 **2.8 倍**（因为 Flutter 版本身要带 GTK + ICU + libmpv，并不轻）。
2. ✅ "Electron 体积可观" —— 成立。95–114 MiB 的分发体积对下载转化率与 CI 产物是有影响的。
3. 🔄 **反向发现：Electron 的依赖闭包更干净。** deb 声明的依赖只有 9 个标准库：

   ```
   libgtk-3-0, libnotify4, libnss3, libxss1, libxtst6,
   xdg-utils, libatspi2.0-0, libuuid1, libsecret-1-0
   ```

   **其中不含 libmpv** —— 音频解码器（`libffmpeg.so`，2.7 MB）已打包在内。而 Flutter 版在 Linux 走**系统 libmpv**（`pubspec.yaml`：*"Linux 走系统 libmpv（完整版，已支持视频输出）"*），却在 `linux/packaging/deb/make_config.yaml` 与 `appimage/make_config.yaml` 里**都看不到 `depends` 声明 libmpv2**。如果 fastforge 不做二进制依赖自动扫描，就存在"装上 deb 但播不出声"的失败模式。⚠️ **这一条建议单独核实**——它是本次评估中唯一发现的、可能已经影响现有用户的疑点。

**关于内存（必须诚实）**：一个常驻托盘、全天候运行的播放器，内存是真实体验。Electron 空载 RSS 通常在 150–400 MB，这是它相对系统 WebView 方案与原生方案唯一无法用工程手段消解的差距。**但同样要诚实的是：音乐客户端这个品类已经集体选过边**——Spotify 用 CEF/Chromium、Tidal 与 Deezer 用 Electron、Plexamp 与 Sonos 桌面端用 Electron。这说明"常驻 + Chromium"在本品类是被验证可接受的取舍。

### 3.2 ⚠️ 最大代价：客户端从 1 套变 2 套

这是**本次迁移唯一无法用技术手段消解的成本**，也是最容易被"技术对比表"掩盖的成本：

1. **Bug 要修两遍**：任何后端契约变更、任何 UI 缺陷、任何平台兼容问题，只要它在桌面端和移动端都成立，就要写两遍、测两遍。
2. **视觉与交互双轨**：Flutter 版有 `desktop_player.dart` / `mobile_player.dart` 的既有拆分，但那是在**同一个渲染栈和同一套 widget 体系**内的拆分；换成 Electron 后，是两套完全不同的渲染栈，任何设计语言调整都变成跨团队协作。
3. **i18n 双份**：22,941 行本地化产物需要两条生成链路（可通过 §7 的缓解措施收敛为单一事实来源）。
4. **测试矩阵翻倍**：Flutter 桌面端 + Electron 三平台 = 4 条桌面/近桌面回归路径。

**因此，迁移的正当性必须先回答一个非技术问题：桌面端是否要成为独立产品线？** 如果答案是否，"迁移"就是把 1 份维护成本变成 1.6 份（桌面端独立维护成本 + 移动端不变，但共享知识被割裂）。

### 3.3 Chromium 升级节律与安全面

- Electron 主版本与 Chromium 同步，**约 8 周一个主版本**。长期不升级 = 堆叠未修补 CVE。必须把"跟随 Electron 大版本"写进常规排期，而不是等出事。
- 安全攻击面比原生客户端大：渲染层 + Node 能力。**可缓解**（PoC 已落地的基线）：`contextIsolation` + `sandbox` + `nodeIntegration:false`、渲染层禁止 import `electron/node:fs/node:child_process`（ESLint 硬约束）、能力全部经 preload 白名单桥暴露、打包态注入 CSP、导航围栏（外部 URL 一律 `shell.openExternal`）、TLS 策略限定在 session 级。
- 必须在 CI 里加 `npm audit` / Dependabot —— npm 依赖腐烂速度高于 pub.dev。

### 3.4 功能缺口（必须在排期里体现，不能假装不存在）

| 缺失模块 | Flutter 版行数 | Electron 侧实现路径 | 风险 |
|---|---|---|---|
| `jsplugin` 插件系统 | 6,123 | 直接复用 JS 运行时；插件 API 与沙箱边界需重新设计 | 中（设计问题，非能力问题） |
| 均衡器 | 含在 `player/` 内 | Web Audio `BiquadFilterNode` 链；音频必须接入 AudioContext 图 | 中（需重构播放路径，并验证与 Media Session 共存） |
| `dlna` 投送 | 989 | SSDP + HTTP 服务发现需在 Node 侧手写，无现成可靠库 | **高**（生态空白） |
| `desktop_lyric` 悬浮歌词 | 690 | 透明置顶窗口 + 跨窗口状态同步 | 低 |
| `settings` 全量 | 16,649 | 已实现六个分区的主体，细节项需逐条对齐 | 中（长尾） |
| 无缝播放 / 淡入淡出 | mpv 能力 | Web Audio 手动实现 | **高**（体验敏感） |
| 本地缓存 / 离线 | — | 需自建缓存层 | 中 |

### 3.5 重写固有的回归风险

从 102,545 行的成熟实现迁到新栈，等于把 347 个文件里积累的边界处理（扫描中断、远端重定向、批量删除、编码历史、歌单排序、脏数据容错）重新走一遍。PoC 在真实数据上跑通 ≠ 覆盖了这些边界。**建议把"以现有 Flutter 版行为为准的差分测试"作为迁移的前置条件，而不是等用户报 bug。**

---

## 4. 横向比较：10 条技术路线（含 2 条国内方案）

### 4.1 技术路线与架构本质

| 方案 | 渲染引擎 | 应用逻辑语言 | 安装体积（Linux 量级） | 本质取舍 |
|---|---|---|---|---|
| **Electron** | 自带 Chromium | Node.js / TS | 100–200 MB | 用体积换一致性 |
| **Tauri 2** | 系统 WebView（Linux: WebKitGTK） | Rust | 10–40 MB | 用一致性换体积 |
| **Wails v2/v3** | 系统 WebView（同上） | Go | 10–30 MB | 同 Tauri，后端换成 Go |
| **Neutralino** | 系统 WebView | 无独立后端 | 2–5 MB | 极轻，原生能力面窄 |
| **Flutter Desktop** | 自带 Skia/Impeller | Dart | 30–100 MB | 用生态换一套 codebase |
| **Qt 6（C++/QML）** | 自带原生控件 | C++ / QML | 30–80 MB（QtWebEngine 则 150 MB+） | 用开发效率换性能与控件的成熟度 |
| **Compose Multiplatform** | 自带 Skia | Kotlin | 60–100 MB | 与 Android 共享 codebase |
| **Avalonia / .NET** | 自带 Skia | C# | 10–90 MB | .NET 团队的最优解 |
| **全原生**（AppKit/WinUI/GTK） | 系统原生 | Swift/C#/C | 5–30 MB | 用 3 倍工作量换上限 |
| **uni-app x** | 自研原生渲染（蒸汽模式） | Vue + JS/TS（或 UTS） | **无桌面端，不可交付** | 用"App + 小程序"的覆盖面换桌面缺席 |
| **Lynx / Lynxtron** | Lynx 自渲染（Clay） | TS / JSX（ReactLynx） | 22–29 MB（压缩，含 Node/V8） | Electron 的架构，换掉 Chromium |

> 注：QtWebEngine 本身就是 Chromium。**"避开 Electron 的体积"和"继续用 Chromium"通常二选一。**
> 注 2：末两行是本次补充的国内方案，它们**不被纳入 §4.2 的评分排序**——原因见 §4.5（平台门禁）。

### 4.2 十维对比（第一维是门禁）

评分口径：1–5，**5 = 最好**。"维护成本"一项已归一化为"分越高越省"。

| 维度 | Electron | Tauri 2 | Wails | Flutter | Qt 6 | Compose MP | Avalonia | 全原生 | uni-app x | Lynx / Lynxtron |
|---|---|---|---|---|---|---|---|---|---|---|
| **能否交付 Linux 桌面（门禁）** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | **❌ 无桌面端** | **❌ 无 Linux** |
| 运行性能（UI/启动） | 3 | 5 | 5 | 4 | 5 | 3 | 4 | 5 | 5 † | 5 † |
| 安装体积 + 驻留内存 | 2 | 5 | 5 | 3 | 4 | 2 | 4 | 5 | 5 † | **5 †** |
| 跨平台渲染一致性 | **5** | 2 | 2 | **5** | 3 | 4 | 4 | 1 | 3 † | 4 † |
| 音频/媒体能力（本项目关键） | **5** | 2 | 2 | 4 | **5** | 3 | 3 | 4 | 1 † | 2 † |
| 开发效率与迭代速度 | **5** | 3 | 4 | 4 | 2 | 3 | 3 | 1 | **5 †** | 3 † |
| 生态成熟度（打包/更新/签名） | **5** | 4 | 3 | 3 | 4 | 3 | 3 | 1 | 3 † | 1 † |
| 桌面系统集成深度 | **5** | 4 | 4 | 4 | **5** | 4 | 4 | **5** | 1 † | 2 † |
| 长期维护成本（越高越省） | 4 | 3 | 3 | 3 | 2 | 3 | 3 | 2 | 3 † | 2 † |
| 团队技能匹配（TS 为主） | **5** | 2 | 4 | 2 | 1 | 1 | 1 | 1 | 4 † | 4 † |

> † 标记的列**仅供参考，不参与排序**：这两条路线无法交付 Linux 桌面（门禁行为 ❌），分数再高也不构成候选。把它们排进加权总分表会让"不可用"看起来像"分数低"，是一种误导——详见 §4.5。

### 4.3 各方案适用场景（选型速查）

| 方案 | 适合 | 不适合 | 代表产品 |
|---|---|---|---|
| **Electron** | 复杂 web 形状的界面；需要三平台像素级一致；需要成熟打包/自动更新/签名链路；团队是前端栈；需要 Chromium 级媒体能力 | 安装体积或空载内存是硬约束；团队拒绝跟随 Chromium 升级 | VS Code、Slack、Discord、Notion、Obsidian、1Password、Tidal、Deezer |
| **Tauri 2** | 体积/内存是产品要求；小工具、local-first、安全敏感；团队有或愿学 Rust；想同时覆盖移动 | 需要三平台像素级一致；UI 形态复杂；强依赖 WebView 的媒体能力（Linux 尤甚）；团队无 Rust | 大量新项目与个人工具；Zed（自研 Rust + WebView 路线） |
| **Wails** | Go 团队想复用后端原生代码；体积敏感 | 同上（WebView 一致性）；**且本项目后端已在独立 Go 服务里，复用价值有限** | Go 生态桌面工具 |
| **Neutralino** | 极小工具、启动器、Kiosk 外壳 | 任何需要深层桌面集成或成熟更新链路的项目 | 轻量包装类工具 |
| **Flutter Desktop** | 已有 Flutter 移动端、想扩到桌面（**最高代码复用**）；需要一套 UI 覆盖手机+桌面 | 桌面端是唯一目标且要求原生质感；团队无 Dart 储备 | Ubuntu App Center、Firmware Updater、**本项目现状** |
| **Qt 6** | 原生质感 + 高性能图形 + 原生音频/DSP；嵌入式与设备类 | 快速迭代的 web 形状 UI；C++ 招人难；LGPL/商业许可决策 | 专业音视频、工业软件、汽车座舱 |
| **Compose MP** | Kotlin/Android 团队；与移动端共享 UI | 已在 Flutter 生态；需要最轻体积 | JetBrains 系工具 |
| **Avalonia / .NET** | .NET 团队；企业内网分发 | 非 .NET 团队；Linux 一等公民要求 | .NET 生态桌面应用 |
| **全原生** | 单平台、要求极限性能与系统集成；音频引擎需要完全掌控 | 需要跨平台；小团队 | Apple Music、Roon |
| **uni-app x** | 一套 Vue 代码要同时交付 **App + 微信/支付宝小程序 + 鸿蒙**，且以国内市场为主 | **任何需要 Windows/macOS/Linux 桌面的项目**（官方编译目标里没有桌面）；需要桌面级媒体栈或原生菜单/托盘的产品 | 国内 App + 小程序一体产品（鸿蒙政企项目） |
| **Lynx / Lynxtron** | 已有移动端 Lynx / ReactLynx 代码、想顺带覆盖 **macOS/Windows** 桌面；想要"Electron 的模型 + 小一个数量级的运行时"；能承担 Alpha 风险 | **Linux 桌面**（官方不支持）；需要成熟媒体栈、托盘/MPRIS、自动更新的产品；需要稳定 API 与现成生态的团队 | TikTok 系应用；Lynxtron Go（官方 playground） |

### 4.4 针对本项目的加权得分与敏感性

权重按**本项目实际情况**设定（不是通用权重）：

| 维度 | 权重 | 理由 |
|---|---|---|
| 音频/媒体能力 | 0.20 | 音乐播放器，且 incumbent 的音频栈是最大技术债 |
| 跨平台渲染一致性 | 0.15 | 大表格 + 封面网格 + 逐字歌词，三平台一致是产品底线 |
| 长期维护成本 | 0.15 | 6 平台已在维护中，不能再加重 |
| 开发效率 | 0.15 | 前端栈是现有团队主技能 |
| 生态成熟度 | 0.10 | 打包/更新/签名/崩溃上报不能自研 |
| 桌面系统集成 | 0.10 | 托盘、媒体键、悬浮歌词 |
| 体积 + 内存 | 0.08 | 实际用户未提出体积诉求；Flutter 版 deb 也是 100 MB |
| 团队技能匹配 | 0.05 | TS/Go 为主 |
| 运行性能 | 0.02 | 后端承担重活，客户端不是瓶颈 |

**加权总分**

| 方案 | 加权总分 |
|---|---|
| **Electron** | **4.57** |
| Flutter Desktop（不迁移） | 3.72 |
| Qt 6 | 3.42 |
| Avalonia / .NET | 3.25 |
| Wails | 3.15 |
| Compose Multiplatform | 3.07 |
| Tauri 2 | 3.00 |
| 全原生 | 2.55 |

**敏感性分析（重要——避免把结论当普遍真理）**

| 场景变化 | 结果 |
|---|---|
| 体积/内存权重提到 0.30（变成硬约束） | Electron 3.91 vs Tauri 3.41 —— **Electron 仍领先** |
| 再假设"音频交给独立原生播放器，UI 只是控制面"（音频权重降到 0.05） | Electron 3.91 vs Tauri 3.46 —— **仍领先** |
| 把 Tauri 的开发效率提到 4.5、维护成本提到 4（即团队有 Rust 储备） | Tauri 3.38 —— **仍落后于 4.57，因为音频（0.40 vs 1.00）与渲染一致性（0.30 vs 0.75）两项权重合计 0.35，恰好是 Tauri 的弱轴** |
| 假设 Lynxtron 在 2027 年前补齐 Linux 桌面并脱离 Alpha | 它会在"安装体积+内存"（5 vs 2）与"运行性能"（5 vs 3）上压过 Electron，但在本项目权重最高的三轴——**音频/媒体能力（2 vs 5）、生态成熟度（1 vs 5）、维护成本（2 vs 4）——合计 0.45 权重上处于劣势**。它要把 Chromium 换掉，也就同时把 §4.5 里"白拿的媒体栈"一起换掉，需要重新验证一条桌面音频链路。**结论：列为观察项，不是候选** |

**结论：Tauri 在通用"新桌面项目"场景里是很好的默认答案，但对"重音频 + 重渲染一致性 + 已有成熟 Flutter 6 平台产品"这个具体组合，它不占优。** 把 Tauri 换成本项目的代价不是"省下 100 MB"，而是把音频栈问题从 libmpv 换成"WebKitGTK/GStreamer 在 5 个发行版上的编解码器可用性"——**问题被平移了，而不是被解决了**。

**关于 uni-app x 与 Lynx / Lynxtron：它们不进上面这张加权表。** 加权评分的前提是"该方案能交付目标平台"。这两条路线在 **Linux 桌面**上都不可用（§4.5），所以给它们打 0 分或 3 分都是一种误导——**"平台不存在"和"分数低"是两种性质完全不同的结论**，前者是排除，后者是取舍。详细证据见 §4.5。

---

### 4.5 为什么"平台支持"要先于一切评分：uni-app x 与 Lynx / Lynxtron

选型讨论里最常见的失误，是拿一个**根本不覆盖目标平台**的方案去和候选方案比性能、比体积。本节把两条国内路线单独拎出来，因为它们的结论不是"分数低"，而是"**目标平台不存在**"。

**平台支持矩阵**（依据各自官方文档/官方公告，非二手资料）

| 方案 | Android | iOS | Web | **Linux 桌面** | macOS 桌面 | Windows 桌面 | 鸿蒙 |
|---|---|---|---|---|---|---|---|
| Flutter Desktop | ✅ | ✅ | ✅ | **✅ 官方** | ✅ 官方 | ✅ 官方 | △ 社区适配（非官方） |
| Electron | ✕ | ✕ | ✕ | **✅ 官方** | ✅ 官方 | ✅ 官方 | ✕ |
| Tauri 2 | ✅ | ✅ | ✕ | **✅ 官方** | ✅ 官方 | ✅ 官方 | ✕ |
| uni-app x | ✅ | ✅ | ✅ | **✕ 无** | **✕ 无** | **✕ 无** | ✅ 官方 |
| Lynx / Lynxtron | ✅ | ✅ | ✅ | **✕ 无** | △ Lynxtron Alpha | △ Lynxtron Alpha | ✅ 官方 |

#### uni-app x：官方没有桌面端，而且厂商自己把 PC 让给了 Electron

- **官方编译目标**（文档《uni-app x 是什么》）明列为"Android、iOS、鸿蒙、web、微信小程序、支付宝小程序等"——**不含任何桌面端**。
- **2026 路线图**四项（App 热更新、支付宝小程序、web 平台蒸汽模式、抖音小程序）**同样没有桌面**。
- **最有力的反向证据来自官方 FAQ 自己**：在讨论 PC 平台时它写道"大家还是用 electron、tauri 这些 webview 渲染的跨平台框架"。**厂商自己在 PC 端让位给 Electron/Tauri**——这比任何第三方评测都说明问题。
- 老 uni-app 的桌面端官方标注"**桌面端放弃维护**"；uni-app x 从未有过桌面端，所以不是"退步"，是"从未在路线上"。
- **技术本身并不弱**：蒸汽模式（Vapor）在移动端用自研渲染引擎做到报告中"比原生快 2–3 倍"，用 Vue + JS/TS + CSS 子集开发，生态面向国内 App/小程序/鸿蒙。这些优点在一个 **App + 小程序**产品里是实打实的；只是与本项目（桌面端音乐播放器）不构成交集。

> ⚠️ **一个必须提醒的检索陷阱**：搜索"uni-app x 桌面端"会大量命中声称"五端同源编译 Windows 10/11 + macOS 13+"、"macOS 走 Electron 桥接 / Windows 走 Windows App SDK"的答案，且**这批答案彼此矛盾**（同一批里另有说"实验性仅限 macOS Apple Silicon"、还有说"Windows 完全不支持"的）。它们与官方文档直接冲突，是 AI 生成的农场内容。**凡涉及"某框架支持哪些平台"，只能查官方文档/官方公告的原始清单。**

#### Lynx / Lynxtron：架构上就是"另一个 Electron"，但官方只做 macOS 与 Windows

- **Lynx 本身**（字节跳动，2025-03 开源）官方支持：**Android、iOS、Web、OpenHarmony**。
- **桌面路径是 Lynxtron**，官方定义原话是"an Electron-like app framework powered by Lynx"：宿主进程保留 Node.js 能力，用 `LynxWindow` + Lynx 轻量渲染器（渲染引擎 Clay）**替代浏览器页面**。
- **官方公告明确列出已验证平台**："the desktop examples support **macOS on Apple silicon and Intel, and Windows on x64**"——**没有 Linux**。官方与第三方集成文档都把 macOS/Windows 列为推荐开发环境。
- **成熟度是 Alpha**：runtime `0.0.28`、npm 包约 3 个月前创建、周下载约 700–950、官方自述"仍处于 Alpha 阶段"；**无 OTA 更新机制**（对照 Electron 有 electron-updater、Tauri 有内置 updater）。
- **体积对比（官方数据：单架构 Release、去掉符号、压缩分发体积）**

  | 运行时 | macOS ARM64 | Windows x64 |
  |---|---|---|
  | Electron | 123.8 MiB | 150.8 MiB |
  | **Lynxtron（含 Node.js / V8）** | **22.1 MiB** | **28.6 MiB** |
  | Lynx UI Runtime（仅渲染器） | 7.8 MiB | 8.5 MiB |
  | Flutter Engine（仅引擎） | 5.9 MiB | 8.8 MiB |

  > 口径注意：**上两行是"完整应用运行时"，下两行只是"引擎/渲染器"**，不能直接互相减去当净收益。Flutter 的完整桌面应用还要加上 Dart AOT 产物与资源。本项目在 Linux 上的 Electron 实测为 **deb 95.4 MiB / AppImage 111.8 MiB**（§8.1）。
- **对本项目的额外风险：媒体栈未验证。** Electron 在音乐播放器这个品类里"白拿"的最大好处是 Chromium 的完整媒体栈（自带 AAC/H.264 解码 + Media Session 自动映射到 Linux **MPRIS**）。Lynxtron 把 Chromium 换成 Lynx 渲染器，**这份好处同时被换掉**：第三方集成文档明确把桌面端的 HTTP Service 描述为"undocumented / stub"，流式能力"not verified"。**音乐播放器最核心的能力恰好落在这个未验证区。**

#### 两条结论

1. **uni-app x 对本项目不适用**——桌面端不存在，且不在其路线图上。即使把本项目限定为"只做国内 App"，它的目标场景也不是音乐播放器的桌面客户端。
2. **Lynx / Lynxtron 对本项目同样不适用**（需要 Linux），**但它是本节信息量最大的一个方案**：它等于由第三方（字节）用另一套技术栈把 **Electron 的架构重新走了一遍**——Node 宿主 + 用 Web 技能写 UI + 原生扩展（Node-API / C++ 纹理扩展）+ 用更轻的渲染器替掉 Chromium。**这独立思考地印证了 §2.1 的判断：Electron 的架构方向是对的，它的代价集中在 Chromium 那一层。**

#### 一个值得记录的观察项

若 Lynxtron 未来补齐 Linux 桌面并脱离 Alpha，它会成为"**Electron 的瘦身版**"直接竞争者——届时本项目应重新评估它。当前状态下的判断是：**它可以进观察清单，但不能进候选清单**。理由是它要拿走的正是本项目最需要的两样东西：Chromium 现成的媒体栈，和十年积累的打包/更新/签名链路。

---

## 5. 选型建议

### 5.1 决策树

```
桌面端是否将作为独立产品线长期投入（独立排期 / 独立维护预算 / 可能独立发版）？
├─ 否  → 【不迁移】留在 Flutter 桌面端
│        理由：2026 年 Flutter 桌面端已出 Beta + Impeller 默认 + Canonical 接管；
│        迁移换来的是 1 套变 2 套，而这是技术无法消解的账。
│        可选低成本改进：只针对 §1.2 的痛点 A/B/C 做局部收敛。
│
└─ 是  → 团队的长期主语言是？
        ├─ TypeScript / 前端  → 【迁移到 Electron】✅ 本报告推荐路径
        │     附 3 条硬约束：
        │       ① 接受 100–200 MB 体积与较高常驻内存
        │       ② 建立 Chromium 大版本升级节律（约 8 周/版）
        │       ③ 补齐 jsplugin / 均衡器 / 无缝播放 / DLNA 的能力缺口
        │
        ├─ Go  → 【Wails】只在"必须避免 Chromium 体积"且能接受 Linux WebKitGTK QA 时成立
        │       注意：本项目后端已在独立 Go 服务里，Wails 的"复用后端"卖点不成立
        │
        ├─ Rust → 【Tauri 2】但需先验证 WebKitGTK 的音频编解码器覆盖（gst-libav / plugins-bad 在目标发行版上是否可用）
        │
        └─ C++ / 音视频专业背景 → 【Qt 6】把音频引擎掌控在自己手里，代价是迭代速度
```

### 5.2 如果决定迁移：建议的路径

**阶段一 — 收敛既有 PoC，补齐"最小可发布集"**
1. 对齐 `settings` 长尾项（16,649 行模块的逐条核对）。
2. 实现均衡器（Web Audio `BiquadFilterNode`），并验证与 Media Session / MPRIS 共存。
3. 实现 `desktop_lyric` 悬浮歌词窗（透明置顶窗口）。
4. 用真实后端跑差分测试：以 Flutter 版行为为基准，覆盖扫描中断、302 重定向、批量删除、歌单排序、脏数据容错。

**阶段二 — 桌面端差异化能力（迁移的正当代价所在）**
5. `jsplugin`：设计宿主在 JS 运行时的沙箱插件 API，并**评估能否让同一批插件同时服务移动端**（这是迁移最可能产生溢出收益的地方）。
6. 无缝播放 / 淡入淡出。
7. 客户端更新：应用内下载安装包 + 交给系统安装（**不用 electron-updater 自替换二进制**，
   见 AGENTS.md §8.21）；崩溃上报仍未做。

**阶段三 — 平台与发布**
8. Windows / macOS 打包与签名（macOS 需 notarization）。
9. 发布链路：deb / AppImage / dmg / NSIS。
10. `DLNA` 单独立项评估（生态空白，建议先做 spike 再决定是否砍掉）。

### 5.3 如果不迁移：建议的替代动作

即使留在 Flutter，§1.2 的痛点 A/B/C 也值得处理：
- ⚠️ **优先核实（与是否迁移无关）**：Linux 走系统 libmpv，但 deb / AppImage 的 `make_config.yaml` 中未见 `libmpv2` 依赖声明。请在干净容器里 `dpkg -i` 后直接试播，确认是否会缺库失败；若确实缺失，这是一个**已经影响现有用户的独立缺陷**。
- **痛点 A/B**：评估是否能收敛为单一 `media_kit` 路径（去掉 `just_audio_media_kit` 与自实现的 platform interface），把 8 个包降到 3–4 个；同时推动上游接受 `media_kit` 的补丁，消除 `dependency_overrides`。
- **痛点 C**：把 `mpv_locale.h` 的必要性向上游（Flutter engine 或 media_kit）反馈，长期消除 runner 级补丁。
- **痛点 E**：`distribute_options.yaml` 的 9 个 target 可按平台拆分到独立 CI job 并行，降低单次发布的耦合。

---

## 6. 可选的第三条路（值得单独评估，成本最低）

### 6.1 复用 Flutter Web 产物 + 原生外壳

`ref-player` **已经有 `web/` target（738 个文件）**。理论上可以：

```
现有 Flutter Web 产物  →  Electron / Tauri 外壳（负责托盘、媒体键、标题栏、自动更新）
```

**优点**：桌面端不用重写任何 Dart 代码，且天然获得与 Web 端一致的表现；外壳层可以很小。

**必须指出的缺点**：
- Flutter Web 用 CanvasKit 渲染到 canvas，**没有 DOM 语义** → 可访问性、文本选择、浏览器级缩放全部受损，与"桌面原生体验"目标相悖。
- 首屏需要下载 WASM 运行时与字体，体积与启动时间未必优于 Electron 直接跑 React。
- Flutter Web 的交互模型与 Flutter 桌面端不同（滚动、拖拽、右键、输入法），迁移后**交互回归风险高于代码复用收益**。

**结论：作为"快速拿到一个桌面外壳"的过渡方案可行，作为终态不建议。** 但如果目标是"先给桌面用户一个可用的壳"，这是 1–2 周量级的路，而重写是数月量级。

### 6.2 混合形态（推荐给"桌面为独立产品线但不想放弃移动端"）

- **移动/Web 继续用 Flutter**，桌面用 Electron。
- **共享层必须显式建立**，否则双轨会各自漂移：
  - **i18n**：以现有 3 个 `.arb` 为单一事实来源，构建时生成前端 JSON，两端同源。
  - **API 契约**：从 Go 后端的 OpenAPI 生成 TS 类型，替换手写的 `types.ts`，消除契约漂移。
  - **设计令牌**：颜色/间距/圆角/毛玻璃参数以 JSON 或 CSS 变量形式双端共享。
  - **图标**：单一 SVG 源 + 各平台派生的单一流水线。

---

## 7. 风险清单与缓解（针对"迁移到 Electron"）

以下每一条都是本项目 PoC 实际撞到过的，不是清单式风险枚举：

| 风险 | 现象 | 缓解 |
|---|---|---|
| **桌面身份四处不一致** | 任务栏图标变成占位符、无法"固定到 Dash" | `desktopName` 必须在 4 处同步：`package.json`、electron-builder `syncDesktopName`、`StartupWMClass`、`app.setDesktopName()`。已落地校验脚本断言 |
| **AppImage 的 AppArmor** | Ubuntu 上 AppImage 无法启动 | 打包内置 AppArmor profile（覆盖 `/opt/*/` 与 userns），并在 `verify:package` 中断言其存在 |
| **FUSE2 已被移除** | 新系统上 AppImage 直接失败 | 使用 appimage toolset 1.0.3（不依赖 libfuse2），校验脚本检查产物中不含 libfuse |
| **图标渐变静默丢失** | 图标渲染成黑白形状，退出码 0（无报错） | 渲染后统计色相族数量并断言（PoC 实测：ImageMagick 会丢渐变，改用 Chrome 渲染 SVG 后色相族为 4） |
| **托盘图标在开发态读不到** | 开发时托盘静默不出现 | 开发态读 `build/tray-256.png`，打包态读 `resourcesPath/tray.png`，并在图标流水线中一并生成 |
| **无边框窗口在未登录态"既不能拖也不能关"** | 登录页没有 TitleBar | 把 TitleBar 提到 App 最外层常驻，不依赖登录态 |
| **CSP 与 HMR 冲突** | 开发态热更新被打断 | **CSP 只在打包态注入**，开发态放开；打包态仍严格（含 `connect-src` 覆盖用户自填的后端地址） |
| **Electron 被降级为纯 Node** | 应用启动即退出，且报告 Node 版本而非 Electron | 宿主若设了 `ELECTRON_RUN_AS_NODE`，Electron 会退化为 Node。启动脚本需显式清除该变量 |
| **`file://` 源请求 `http://` 后端** | 请求失败且报错信息误导 | 排查时先分清 `ERR_CONNECTION_REFUSED`（后端没起来）与 CORS/CSP 拦截；PoC 中曾因 mock 进程随 shell 结束被回收而误判为应用缺陷 |
| **歌词合并丢行** | 歌词莫名少句 | 逐字歌词（`lxlyric`）常只覆盖部分段落，**不能因为选了逐字源就整行丢弃主歌词独有的行**，必须按时间轴求并集 |
| **Chromium CVE 堆积** | 长期不升级 | CI 加 `npm audit`/Dependabot；把 Electron 大版本升级写进常规排期 |
| **npm 依赖腐烂** | 传递依赖失修 | 锁定 lockfile、限制运行时依赖数量（PoC 的运行时依赖只有 1 个：zustand） |

---

## 8. 附录：实测数据与方法

### 8.1 实测数据

| 项 | 数值 | 获取方式 |
|---|---|---|
| Electron 运行时（node_modules 解包） | **283 MB** | `du -sh node_modules/electron/dist`（Electron 44.7.0） |
| 应用自身产物 | **1.1 MB** | `du -sh out/`：main 23.76 KB / preload 3.68 KB / renderer 1,016 KB |
| 渲染层 bundle | js **970,380 B** + css **46,220 B** | `electron-vite build` 输出 |
| Flutter 版 deb 声明安装体积 | **100 MB**（102,400 KB） | `ref-player/linux/packaging/deb/make_config.yaml` |
| Electron 版代码规模 | 61 文件 / 14,256 行 | `find src -type f` + `wc -l` |
| Flutter 版代码规模 | 347 文件 / 102,545 行 | `find lib -name '*.dart'` + `wc -l` |
| 运行时依赖数（Electron 版） | 1（zustand） | `package.json` |

**打包产物实测（`pnpm run pack:linux`，Linux x64 / Electron 44.7.0 / electron-builder 26.15.3）**

| 产物 | 字节数 | 人类可读 |
|---|---|---|
| `release/linux-unpacked/` | — | **284 MB** |
| `songloft-desktop_0.1.0_amd64.deb` | 100,003,084 | **95.4 MiB** |
| `Songloft Desktop-0.1.0.AppImage` | 117,249,950 | **111.8 MiB** |
| `songloft-desktop-0.1.0.tar.gz` | 119,238,719 | **113.7 MiB** |

deb 元数据：`Installed-Size: 290532`（KB）；依赖 9 项，**不含 libmpv**：`libgtk-3-0, libnotify4, libnss3, libxss1, libxtst6, xdg-utils, libatspi2.0-0, libuuid1, libsecret-1-0`

### 8.2 评估方法

1. **静态分析 incumbent**：`ref-player` 的 `pubspec.yaml`、`dependency_overrides`、`linux/runner/`、`linux/packaging/`、`distribute_options.yaml`、各 feature 模块行数分布。
2. **实测自建实现**：本仓库的 Electron 实现已完成类型检查、`lint`、构建，并在 `xvfb` 虚拟显示 + mock 后端下端到端跑通全部页面（首页/曲库/收藏/最近/歌单/文件夹/设置/歌词面板），截图逐页核对。
3. **框架现状核查**：核对 2026 年各框架的发布状态（Flutter 桌面端 Beta 退出与 Impeller、Canonical 接管；Tauri 2 的 WebView 策略与体积区间；Electron 的编解码器与工具链现状）。
3b. **平台支持矩阵以官方一手资料为准**（§4.5）：uni-app x 取官方文档《uni-app x 是什么》的平台清单与 2026 路线图；Lynx / Lynxtron 取 Lynx 官方 2026 路线图、Lynxtron 发布公告与其 GitHub Issue（体积与 Alpha 状态）。**搜索结果中大量 AI 生成答案与官方文档冲突，已全部弃用**——凡"某框架支持哪些平台"，只采信官方原始清单。
4. **真实打包**：执行 `pnpm run pack:linux`（`typecheck` → `electron-vite build` → `electron-builder --linux`），产出 deb / AppImage / tar.gz，并用 `dpkg-deb -f` 读取 `Installed-Size` 与 `Depends`。**§3.1 与 §8.1 的体积数字全部来自这一次真实打包，不是估算。**
5. **主观评分仅用于横向定位**：§4.2 的 1–5 分为作者判断，非实测；§4.4 通过权重变化做敏感性分析，避免把单一排序当作普适结论。

### 8.3 明确不在本次评估范围内的内容

- 移动端与 Web 端的迁移或存续方案。
- 后端（Go 服务）的任何改动。
- UI 重设计的具体方案（本次只评估"换不换栈"）。
- 商业化许可与专利授权的法律意见（§2.1 提到的编解码器许可属法律问题，需专业意见）。

> 补充（2026-10-12 追加）：**uni-app x 与 Lynx / Lynxtron 已在 §4.5 中评估**，但结论是"不适用（无法交付 Linux 桌面）"，未纳入 §4.4 的加权排序。二者的体积数字来自其官方公布值，**非本机实测**（本机无 macOS / Windows 环境，且两者均无 Linux 运行时可供测量）。
