/**
 * 渲染层入口。
 *
 * 只做三件事：挂样式、起 React、把启动编排交给 App / MiniApp。
 * 启动顺序（设置 → 会话 → 预载）刻意放在那两个组件的 effect 里，而不是这里 ——
 * 那边能拿到 StrictMode 之外的一次性 ref，也方便在卸载时统一回收订阅。
 *
 * ★ **两个窗口共用这一个入口**（主窗口与迷你窗，见 main/mini-window.ts）：只有 URL 的 hash
 *   不同，`#mini` 那个挂的是 MiniApp（整窗一条播放条 + 面板），其余挂 App。
 *   不另做一份 html 入口，是因为两者的样式与组件有大量共用，多一个入口就是多一处要跟着改。
 */

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { App } from './App'
import { MiniApp } from './MiniApp'
import { installScrollbarHoverTracking } from './lib/scrollbar-hover'
import { isMiniWindow } from './lib/window-role'
import './styles/index.css'

const container = document.getElementById('root')
if (!container) throw new Error('#root 不存在：index.html 被改坏了')

const mini = isMiniWindow()

/*
 * 迷你窗的标记在这里就打上（不是等 React 挂载后）：
 *   · 它决定整窗浓度用哪一份（base.css 那条 html[data-mini] body 的 opacity）；
 *   · 还决定 .mini-player 那一块的高度基准。
 * 两者都是**第一帧就该对**的东西，放进 effect 会先闪一帧「主窗口那份的观感」。
 */
if (mini) document.documentElement.dataset.mini = 'true'

/* 阻止把文件拖进窗口时整个页面被替换成文件预览 —— 桌面应用里这是纯粹的破坏，
   而我们的「拖到歌单」是组件级 dragover 处理的，不需要浏览器兜底行为。 */
window.addEventListener('dragover', (event) => event.preventDefault())
window.addEventListener('drop', (event) => event.preventDefault())

/* 右键菜单统一由自绘的 ContextMenuHost 接管；这里的 preventDefault 只是掐掉
   Chromium 自带的那个（含「重新加载 / 检查元素」），组件里需要时再自行 openMenuFromEvent。 */
window.addEventListener('contextmenu', (event) => {
  const target = event.target
  if (target instanceof HTMLElement && target.closest('input, textarea')) return
  event.preventDefault()
})

/*
 * 「指针压在滚动条槽上」的全局检测（见 lib/scrollbar-hover.ts）：它只给那个容器打一个
 * data-scrollbar-hover，样式据此把滑块变实、变宽（见 base.css 的滚动条那一段）。
 * 装在窗口入口而不是某个组件里：主窗口与迷你窗的每一块可滚区域都要它，而它不依赖任何
 * 会话 / 路由 / 设置 —— 早一帧装上，用户第一次去拖滚动条时就已经是宽的那一档了。
 */
installScrollbarHoverTracking()

createRoot(container).render(<StrictMode>{mini ? <MiniApp /> : <App />}</StrictMode>)
