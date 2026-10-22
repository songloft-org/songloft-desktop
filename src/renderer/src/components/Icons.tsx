/**
 * 内联 SVG 图标集。
 *
 * 不引图标库：这个应用要用的图形不到四十个，内联能少一个运行时依赖，
 * 也让「描边粗细 / 尺寸」全局一致（统一 1.7 描边、24 网格）。
 */

import type { SVGProps } from 'react'

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'children'> {
  size?: number
}

function Svg({
  size = 18,
  children,
  ...rest
}: IconProps & { children: React.ReactNode }): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  )
}

/** 实心变体：播放/暂停这类需要视觉重量的按钮 */
function SvgFill({
  size = 18,
  children,
  ...rest
}: IconProps & { children: React.ReactNode }): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  )
}

export const IconHome = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 10.5 12 3l9 7.5" />
    <path d="M5 9.5V20a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9.5" />
  </Svg>
)

export const IconLibrary = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9 18V6l10-1.6v11" />
    <circle cx="6.4" cy="18" r="2.6" />
    <circle cx="16.4" cy="15.4" r="2.6" />
  </Svg>
)

export const IconHeart = ({ filled, ...p }: IconProps & { filled?: boolean }) => (
  <Svg {...p} fill={filled ? 'currentColor' : 'none'}>
    <path d="M12 20.2 4.9 13.4A4.6 4.6 0 0 1 12 7.3a4.6 4.6 0 0 1 7.1 6.1Z" />
  </Svg>
)

export const IconClock = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.6" />
    <path d="M12 7.6V12l3 1.8" />
  </Svg>
)

export const IconListMusic = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 6h10M4 11h10M4 16h6" />
    <circle cx="17.5" cy="17.5" r="2.5" />
    <path d="M20 17.5V9l-2 .7" />
  </Svg>
)

export const IconFolder = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.5 7.2A1.7 1.7 0 0 1 5.2 5.5h3.4l1.7 2h8.5a1.7 1.7 0 0 1 1.7 1.7v7.6a1.7 1.7 0 0 1-1.7 1.7H5.2a1.7 1.7 0 0 1-1.7-1.7Z" />
  </Svg>
)

export const IconSettings = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1Z" />
  </Svg>
)

export const IconSearch = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="11" cy="11" r="6.6" />
    <path d="m16 16 4.2 4.2" />
  </Svg>
)

/*
 * 播放三角形：**墨迹框在 24 网格里正中**（横 7..17、纵 5.7..18.3，两条中线都落在 12 上）。
 *
 * ★ 从前的坐标是横 8.4..18.4、纵 4.7..17.3 —— 墨迹框的中线落在 (13.4, 11.0)，相对格子中心
 *   偏右下各约 1 个单位。落进圆钮就是「三角形看着往右上蹭了一点」，而且尺寸越大越显眼
 *   （14px 上是 (0.8, 0.6)px，满窗播放那 24px 上是 (1.4, 1.0)px）。圆钮只有一颗图形，
 *   没有旁边的文字给它当参照，这种偏心在圆形里最扎眼。
 * ★★ 修完之后横 7..17 与 pause 那两根竖条的墨迹框**完全重合**（也是 7..17）：两颗共享同一条
 *   中线，播放 / 暂停来回切时图形不会跳一下。
 * ★ 居中的是**墨迹框**，不是三角形的重心：重心天然偏左（底边在左），按重心摆的话右侧尖端会
 *   顶到格子边缘、与相邻图标挤成一片。主流图标集（Feather / Lucide 的 play 是 5..19）同一口径。
 * ★ 所有坐标都在 viewBox 单位里，所以「居中」在 12px / 14px / 24px 上是同一个事实 ——
 *   不必在任何一处写 px 偏移量去凑（那种偏移换个尺寸、换个 DPI 就得重新调）。
 */
export const IconPlay = (p: IconProps) => (
  <SvgFill {...p}>
    <path d="M7 6.6a.9.9 0 0 1 1.36-.77l8.2 5.4a.9.9 0 0 1 0 1.54l-8.2 5.4A.9.9 0 0 1 7 17.4Z" />
  </SvgFill>
)

export const IconPause = (p: IconProps) => (
  <SvgFill {...p}>
    <rect x="7" y="5.5" width="3.4" height="13" rx="1.2" />
    <rect x="13.6" y="5.5" width="3.4" height="13" rx="1.2" />
  </SvgFill>
)

export const IconSkipBack = (p: IconProps) => (
  <SvgFill {...p}>
    <path d="M18.4 6.2a.8.8 0 0 1 1.24.67v10.26a.8.8 0 0 1-1.24.67l-7.3-5.13a.8.8 0 0 1 0-1.34Z" />
    <rect x="5" y="5.6" width="2.4" height="12.8" rx="1.2" />
  </SvgFill>
)

export const IconSkipForward = (p: IconProps) => (
  <SvgFill {...p}>
    <path d="M5.6 6.2a.8.8 0 0 0-1.24.67v10.26a.8.8 0 0 0 1.24.67l7.3-5.13a.8.8 0 0 0 0-1.34Z" />
    <rect x="16.6" y="5.6" width="2.4" height="12.8" rx="1.2" />
  </SvgFill>
)

export const IconShuffle = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2.34 7.05h1.1c1.71 0 2.56 0 3.32.33c.76.32 1.35.94 2.51 2.19L14.4 15c1.16 1.24 1.75 1.86 2.5 2.2c.77.32 1.62.32 3.32.32h1" />
    <path d="M2.34 17.52h1.07c1.72 0 2.58 0 3.35-.33c.77-.34 1.35-.97 2.52-2.23l4.95-5.35c1.17-1.26 1.76-1.9 2.52-2.23c.77-.33 1.63-.33 3.35-.33h1.12" />
    <path d="m19.3 3.86l.36.36c1.34 1.33 2 2 2 2.82c0 .83-.66 1.5-2 2.83l-.35.36m-.01 4.11l.36.35c1.34 1.33 2 2 2 2.83s-.66 1.5-2 2.83l-.35.35" />
  </Svg>
)

export const IconRepeat = (p: IconProps) => (
  <Svg {...p}>
    <path d="M17 3.5 20.5 7 17 10.5" />
    <path d="M3.5 12V9.6A2.6 2.6 0 0 1 6.1 7h14" />
    <path d="M7 20.5 3.5 17 7 13.5" />
    <path d="M20.5 12v2.4A2.6 2.6 0 0 1 17.9 17h-14" />
  </Svg>
)

export const IconRepeatOne = (p: IconProps) => (
  <Svg {...p}>
    <path d="M17 3.5 20.5 7 17 10.5" />
    <path d="M3.5 12V9.6A2.6 2.6 0 0 1 6.1 7h14" />
    <path d="M7 20.5 3.5 17 7 13.5" />
    <path d="M20.5 12v2.4A2.6 2.6 0 0 1 17.9 17h-14" />
    <path d="M11.6 10.6 13 9.7v4.6" strokeWidth={1.9} />
  </Svg>
)

export const IconVolume = ({ level = 2, ...p }: IconProps & { level?: 0 | 1 | 2 }) => (
  <Svg {...p}>
    <path d="M4 9.5h3L11 6v12l-4-3.5H4Z" />
    {level > 0 && <path d="M14.4 9.6a3.6 3.6 0 0 1 0 4.8" />}
    {level > 1 && <path d="M17 7.2a7 7 0 0 1 0 9.6" />}
  </Svg>
)

export const IconVolumeX = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 9.5h3L11 6v12l-4-3.5H4Z" />
    <path d="m15.5 10 4.5 4M20 10l-4.5 4" />
  </Svg>
)

export const IconQueue = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 6.5h11M4 12h11M4 17.5h7" />
    <path d="M19 10v8" />
    <path d="M19 18a2 2 0 1 1-2-2" />
  </Svg>
)

export const IconLyrics = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 6h16M4 11h11M4 16h7" />
    <path d="M17.5 20.2V13l3.5-1v7.2" />
    <circle cx="16" cy="20.2" r="1.6" />
  </Svg>
)

export const IconChevronLeft = (p: IconProps) => (
  <Svg {...p}>
    <path d="M14.5 6 8.5 12l6 6" />
  </Svg>
)

export const IconChevronRight = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9.5 6l6 6-6 6" />
  </Svg>
)

export const IconChevronDown = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 9.5l6 6 6-6" />
  </Svg>
)

export const IconPlus = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
)

export const IconTrash = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4.5 7h15M9.5 7V4.8h5V7" />
    <path d="M6.5 7l.9 12.1a1.6 1.6 0 0 0 1.6 1.4h6a1.6 1.6 0 0 0 1.6-1.4L17.5 7" />
    <path d="M10.4 11v6M13.6 11v6" />
  </Svg>
)

/** 折叠菜单的触发器（标题栏 LOGO 右侧）：三条横线比任何图标都更少歧义地表示「这里有菜单」 */
export const IconMenu = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 6.5h16M4 12h16M4 17.5h16" />
  </Svg>
)

export const IconMore = (p: IconProps) => (
  <SvgFill {...p}>
    <circle cx="5.5" cy="12" r="1.6" />
    <circle cx="12" cy="12" r="1.6" />
    <circle cx="18.5" cy="12" r="1.6" />
  </SvgFill>
)

export const IconEdit = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4.5 19.5h4l10-10a2.1 2.1 0 0 0-3-3l-10 10Z" />
    <path d="M14.5 6.5l3 3" />
  </Svg>
)

export const IconCheck = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </Svg>
)

export const IconClose = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Svg>
)

export const IconMinimize = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5.5 12h13" />
  </Svg>
)

export const IconMaximize = (p: IconProps) => (
  <Svg {...p}>
    <rect x="5.5" y="5.5" width="13" height="13" rx="2" />
  </Svg>
)

export const IconRestore = (p: IconProps) => (
  <Svg {...p}>
    <rect x="4.5" y="7.5" width="11" height="11" rx="2" />
    <path d="M8.5 7.5V6a1.5 1.5 0 0 1 1.5-1.5h8A1.5 1.5 0 0 1 19.5 6v8a1.5 1.5 0 0 1-1.5 1.5h-1.5" />
  </Svg>
)

/** 迷你模式：大框里嵌一只小框（画中画那个意思）。与旁边的窗口控制图标刻意不同形 */
export const IconMini = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3.5" y="5" width="17" height="14" rx="2.4" />
    <rect x="11" y="11.2" width="7.5" height="5.6" rx="1.5" fill="currentColor" stroke="none" />
  </Svg>
)

export const IconAlert = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.6" />
    <path d="M12 7.8v5M12 16h.01" />
  </Svg>
)

export const IconInfo = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.6" />
    <path d="M12 11v5.2M12 8h.01" />
  </Svg>
)

export const IconRefresh = (p: IconProps) => (
  <Svg {...p}>
    <path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3" />
    <path d="M19.8 4.5v4.2h-4.2" />
  </Svg>
)

export const IconLoader = (p: IconProps) => (
  <Svg {...p} className={`spin ${p.className ?? ''}`}>
    <path d="M12 3.6v3.2M12 17.2v3.2M20.4 12h-3.2M6.8 12H3.6M18.1 5.9l-2.3 2.3M8.2 15.8l-2.3 2.3M18.1 18.1l-2.3-2.3M8.2 8.2 5.9 5.9" />
  </Svg>
)

export const IconSun = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 3v2.2M12 18.8V21M3 12h2.2M18.8 12H21M5.6 5.6l1.6 1.6M16.8 16.8l1.6 1.6M18.4 5.6l-1.6 1.6M7.2 16.8l-1.6 1.6" />
  </Svg>
)

export const IconMoon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M20 14.2A8.4 8.4 0 0 1 9.8 4a8.5 8.5 0 1 0 10.2 10.2Z" />
  </Svg>
)

export const IconMonitor = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3.5" y="4.5" width="17" height="12" rx="2" />
    <path d="M9 20h6M12 16.5V20" />
  </Svg>
)

export const IconServer = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3.5" y="4" width="17" height="7" rx="2" />
    <rect x="3.5" y="13" width="17" height="7" rx="2" />
    <path d="M7 7.5h.01M7 16.5h.01" />
  </Svg>
)

export const IconGrip = (p: IconProps) => (
  <SvgFill {...p}>
    <circle cx="9" cy="6" r="1.4" />
    <circle cx="15" cy="6" r="1.4" />
    <circle cx="9" cy="12" r="1.4" />
    <circle cx="15" cy="12" r="1.4" />
    <circle cx="9" cy="18" r="1.4" />
    <circle cx="15" cy="18" r="1.4" />
  </SvgFill>
)

export const IconMusic = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9 18V5.5l10-1.8V16" />
    <circle cx="6.2" cy="18" r="2.8" />
    <circle cx="16.2" cy="16" r="2.8" />
  </Svg>
)

export const IconRadio = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="2.2" />
    <path d="M7.8 7.8a6 6 0 0 0 0 8.4M16.2 16.2a6 6 0 0 0 0-8.4" />
    <path d="M5 5a10 10 0 0 0 0 14M19 19a10 10 0 0 0 0-14" />
  </Svg>
)

export const IconCloud = (p: IconProps) => (
  <Svg {...p}>
    <path d="M7 18.5h10a4 4 0 0 0 .4-8 5.4 5.4 0 0 0-10.5-.9A3.6 3.6 0 0 0 7 18.5Z" />
  </Svg>
)

export const IconDisc = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.6" />
    <circle cx="12" cy="12" r="2.2" />
  </Svg>
)

export const IconLogout = (p: IconProps) => (
  <Svg {...p}>
    <path d="M14.5 4.5H6.5A1.5 1.5 0 0 0 5 6v12a1.5 1.5 0 0 0 1.5 1.5h8" />
    <path d="M17 8.5 20.5 12 17 15.5M20.5 12h-9" />
  </Svg>
)

export const IconUpload = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 16V4.8M8.4 8.4 12 4.8l3.6 3.6" />
    <path d="M4.5 15.5V18a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-2.5" />
  </Svg>
)

/** 图钉 = 「常驻运行」（钉住不放：空闲检查不卸载它）。与上游 Flutter 端的 push_pin 同义 */
/** 网格呈现（歌单页的网格 / 列表切换） */
export const IconGrid = (p: IconProps) => (
  <Svg {...p}>
    <rect x="4.5" y="4.5" width="6.2" height="6.2" rx="1.7" />
    <rect x="13.3" y="4.5" width="6.2" height="6.2" rx="1.7" />
    <rect x="4.5" y="13.3" width="6.2" height="6.2" rx="1.7" />
    <rect x="13.3" y="13.3" width="6.2" height="6.2" rx="1.7" />
  </Svg>
)

/** 列表呈现。行首那三颗点刻意留着 —— 光三条横线就是「菜单」（IconMenu），两者不该长得一样 */
export const IconRows = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9 6.5h10M9 12h10M9 17.5h10" />
    <circle cx="5" cy="6.5" r="1.3" fill="currentColor" stroke="none" />
    <circle cx="5" cy="12" r="1.3" fill="currentColor" stroke="none" />
    <circle cx="5" cy="17.5" r="1.3" fill="currentColor" stroke="none" />
  </Svg>
)

export const IconPin = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9 4.5h6l-.8 4.4 3.3 3.3H6.5l3.3-3.3Z" />
    <path d="M12 12.2V20" />
  </Svg>
)

export const IconEyeOff = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 4l16 16" />
    <path d="M9.9 5.3A9.6 9.6 0 0 1 12 5c5 0 8.5 4.6 9 7-.2 1-1 2.5-2.3 3.8" />
    <path d="M6.4 7.7C4.7 9.1 3.6 11 3 12c.6 1.5 4 7 9 7 1.4 0 2.6-.4 3.7-.9" />
    <path d="M10.2 10.4a2.4 2.4 0 0 0 3.3 3.3" />
  </Svg>
)

export const IconSparkle = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3.5l1.8 5.2 5.2 1.8-5.2 1.8L12 17.5l-1.8-5.2L5 10.5l5.2-1.8Z" />
    <path d="M18.5 16.5l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7Z" />
  </Svg>
)

/** 指纹：重复歌曲检测的主按钮用它交代「靠什么认出来的」 */
export const IconFingerprint = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 10a2 2 0 0 0-2 2c0 1.02-.1 2.51-.26 4" />
    <path d="M14 13.12c0 2.38 0 6.38-1 8.88" />
    <path d="M17.29 21.02c.12-.6.43-2.3.5-3.02" />
    <path d="M2 12a10 10 0 0 1 18-6" />
    <path d="M2 16h.01" />
    <path d="M21.8 16c.2-2 .131-5.354 0-6" />
    <path d="M5 19.5C5.5 18 6 15 6 12a6 6 0 0 1 .34-2" />
    <path d="M8.65 22c.21-.66.45-1.32.57-2" />
    <path d="M9 6.8a6 6 0 0 1 9 5.2v2" />
  </Svg>
)

export const IconSliders = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5 6.5h9M18 6.5h1M5 12h3M12 12h7M5 17.5h9M18 17.5h1" />
    <circle cx="15.6" cy="6.5" r="2.1" />
    <circle cx="9.6" cy="12" r="2.1" />
    <circle cx="15.6" cy="17.5" r="2.1" />
  </Svg>
)

export const IconUser = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="8.4" r="3.4" />
    <path d="M5.5 19.5a6.5 6.5 0 0 1 13 0" />
  </Svg>
)

export const IconExternal = (p: IconProps) => (
  <Svg {...p}>
    <path d="M13.5 5h5.5v5.5" />
    <path d="M19 5l-7.5 7.5" />
    <path d="M17 14.5V18a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 5 18V9a1.5 1.5 0 0 1 1.5-1.5H10" />
  </Svg>
)

export const IconFolderOpen = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.5 8V6.2A1.7 1.7 0 0 1 5.2 4.5h3.4l1.7 2h8.5a1.7 1.7 0 0 1 1.7 1.7V9" />
    <path d="M3.5 9.5h16.8a1 1 0 0 1 1 1.2l-1.6 7.6a1.7 1.7 0 0 1-1.7 1.4H5.2a1.7 1.7 0 0 1-1.7-1.7Z" />
  </Svg>
)

export const IconDownload = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 4v11.2M8.4 11.6 12 15.2l3.6-3.6" />
    <path d="M4.5 16.5V18a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-1.5" />
  </Svg>
)

export const IconCommand = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8.5 4.5a2 2 0 1 1-2 2h11a2 2 0 1 1-2-2v11a2 2 0 1 0 2-2h-11a2 2 0 1 0-2 2Z" />
  </Svg>
)

export const IconHistory = IconClock
export const IconList = IconListMusic

/** 商店：橱窗 + 遮阳篷，用来区分「本机已装的」与「远端能装的」 */
export const IconStore = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 9.2V19a1.6 1.6 0 0 0 1.6 1.6h12.8A1.6 1.6 0 0 0 20 19V9.2" />
    <path d="M3.2 9.2 5 4.4h14l1.8 4.8a2.6 2.6 0 0 1-4.6 1.9 2.6 2.6 0 0 1-4.2.2 2.6 2.6 0 0 1-4.2-.2 2.6 2.6 0 0 1-4.6-1.9Z" />
    <path d="M10 20.6v-4.4h4v4.4" />
  </Svg>
)

/** 扩展/插件。左侧两个凸起是拼图榫头 —— 这是「扩展」这个概念的通用图形 */
export const IconPuzzle = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9.5 4.5a1.9 1.9 0 0 1 3.8 0v.9h2.4a1.5 1.5 0 0 1 1.5 1.5v2.5h.9a1.9 1.9 0 0 1 0 3.8h-.9v4.4a1.5 1.5 0 0 1-1.5 1.5H6.6a1.5 1.5 0 0 1-1.5-1.5v-4.4h-.6a1.9 1.9 0 0 1 0-3.8h.6V6.9a1.5 1.5 0 0 1 1.5-1.5h2.9Z" />
  </Svg>
)
