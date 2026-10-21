/**
 * 通过 Chrome DevTools Protocol 驱动已启动的 Electron 渲染层，逐个界面截图并**断言**。
 *
 * 走的是**真实 DOM 交互**（点侧栏、双击歌曲行、派发 Ctrl+K），不是去戳内部 store：
 * 这样顺带验证了事件绑定、路由跳转、无障碍标记是否真的接对，
 * 而不是"我调了函数所以应该渲染了"。
 *
 * ★ 三条设计约束（都是踩过坑之后的结论）：
 *
 *   1. **一个 STEP 只做一次点击**，靠该步自己的 wait 等渲染落定。
 *      不要写"点 A 再点 B"的 helper —— 曾有一个 clickWait(A, …, B) 只点第一个参数，
 *      调用处却当成"点了两个"，于是 B 根本没被点、断言却因为不区分内容而全绿，
 *      白跑了两轮 70 秒的巡检才发现。
 *
 *   2. **断言必须能区分内容，不能只数个数**。
 *      「歌手分面」和「流派分面」都是 5 张卡，只断言 `cards === 5` 的话，
 *      点没点中「流派」这个 chip 是看不出来的。所以下面用 cardTitles 按文字断言。
 *
 *   3. **改了这份脚本，必须在本地跑一次 `pnpm run e2e` 才能提交。**
 *      断言不是代码：选择器或文案对不上时不会编译报错，只会「静默地永远为假」——
 *      界面改动把脚本落在后面，整条 CI 就一直红、且没人知道红在哪一步。
 *      两类最常见的漂移，改动时都得盯住：
 *        · **界面的前提变了**（例如「双击歌曲行会自动打开面板」，实际并不会），
 *          照旧写法会把断言压在根本不成立的前提上；
 *        · **选择器撞名**：`document.querySelector('[aria-label=…]')` 会命中 DOM 里
 *          第一个同名元素 —— 控制栏和面板自己的页签都叫「播放队列」，所以一律限定
 *          作用域（`.playerbar button[aria-label="播放队列"]`）。
 *
 * ★ 为什么必须有断言：mock 的 lyric 有 10 行、lxlyric 只覆盖其中 4 行 —— 这是
 *   「逐字源覆盖不全时主歌词被整行丢掉」的精确复现条件。没有断言时，这类**静默**
 *   缺陷只能靠人肉看截图（本项目的歌词丢行缺陷正是这样被发现的）。
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

const CDP = process.env.CDP_PORT ?? '9222'
/** 默认落在仓库根的 .e2e/shots（已 gitignore）；run.sh 会显式传 SHOT_DIR */
const OUT = process.env.SHOT_DIR ?? join(HERE, '..', '..', '.e2e', 'shots')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 期望值构造器。
 * 失败时 `label` 会原样打进日志 —— 断言失败信息里出现 "undefined" 等于没写断言。
 */
const exactly = (n) => Object.assign((v) => v === n, { label: `=${n}` })
const atLeast = (n) => Object.assign((v) => v >= n, { label: `>=${n}` })
/** 上限：几何偏差这类量只需要"不超过"，用 = 会把亚像素舍入变成假失败 */
const atMost = (n) => Object.assign((v) => v <= n, { label: `<=${n}` })
/**
 * 值要匹配这个正则。
 *
 * 用于「形状固定、内容会变」的东西 —— 迷你条上那行 `03:12/04:15` 就是：秒数随播放走，
 * 但「两个时间拼在一起、中间一个斜杠」这个形状是固定的（钉死的那个值只会在截图里过期）。
 */
const matches = (re) =>
  Object.assign((v) => typeof v === 'string' && re.test(v), { label: `~${re}` })
/** 断言数组与给定序列**逐项相等**（元素与顺序都要对，用于钉住菜单项的顺序） */
const equals = (...want) =>
  Object.assign(
    (v) => Array.isArray(v) && v.length === want.length && want.every((x, i) => v[i] === x),
    { label: `=[${want.join(' > ')}]` }
  )
/**
 * 数组口径的「正好 n 项」。
 *
 * ★ 别拿 exactly 去比数组：那是 `v === 2`，而 miniInfo 这类探针返回的是**数组** ——
 *   那样写出来的断言**恒假**，而红的原因长得像「界面上的行数不对」（本文件开头警告的那类
 *   漂移，与 containsAll 上面那段是同一类事故：断言不是代码，写错了不会编译报错）。
 */
const countIs = (n) =>
  Object.assign((v) => Array.isArray(v) && v.length === n, { label: `有${n}项` })
/**
 * 控制栏已显示真实曲目（而不是「未在播放」这句占位文案）。
 *
 * 双击歌曲行那一步的判据只能看这儿：播放**不会**顺带打开面板，所以那时数不到队列条目、
 * 也数不到歌词，只有控制栏一定会换成当前曲目。占位文案是文案层的东西，改文案就要改这里 ——
 * 但这正是想要的效果：占位文案一改，这条断言立刻红，不会静默失效。
 */
const hasSong = Object.assign(
  (v) => typeof v === 'string' && v.trim() !== '' && v.trim() !== '未在播放',
  { label: '有当前曲目' }
)
/**
 * 「每一项都在里面」：每一项都必须作为**子串**出现在值里。
 *
 * ★ 两种值都要接住：数组（分面卡片文字、菜单项…）与**整段字符串**
 *   （`.setting-card` / `.modal-body` 那种「把一整块文字拼起来」的口径）。
 *   早先这里只处理数组、字符串一律返回假 —— 于是 8 条 `settingText` / `modalText`
 *   断言**永远是红的**，而红的原因又长得像「界面上了错的内容」。
 *   这正是本文件开头警告的那类漂移：断言不是代码，写错了不会编译报错。
 */
const containsAll = (...names) =>
  Object.assign(
    (v) => {
      const haystack = Array.isArray(v) ? v.map(String) : [String(v ?? '')]
      return names.every((n) => haystack.some((x) => x.includes(n)))
    },
    {
      label: `含[${names.join('+')}]`
    }
  )

/**
 * 注入到渲染层的助手。
 *
 * ⚠️ 这段是**模板字符串**：注释里出现反引号会把它提前闭合，症状是 Node 抛
 *    "SyntaxError: Unexpected identifier"。所以里面的注释一律用普通引号。
 */
const HELPERS = `
/**
 * 「当前这一页里」的元素。
 *
 * ⚠️ 原生面的各个页面是**常驻**的（切页只是把离开的那一页藏起来，见 App 的 NativePages）——
 *    于是全局选择器会同时命中好几页：.song-row / .card / .chip 的计数会把藏在别的页里的
 *    也一起数进来。这里一律把范围收回「不在 [data-hidden] 子树里」的那一份。
 *    与 offCenter 限定 .surface-native 是同一个道理（那边防的是两个内容面）。
 *    —— 新写选择器请走 vis / 这里的助手，别直接 document.querySelector。
 */
const vis = (sel) => [...document.querySelectorAll(sel)].filter((e) => !e.closest('[data-hidden="true"]'));

window.__t = {
  vis: vis,
  q: (sel) => vis(sel)[0] || null,
  qa: (sel) => vis(sel),
  byText: (sel, text) => vis(sel).find((e) => (e.textContent || '').includes(text)) || null,
  click: (sel, text) => {
    const el = text ? window.__t.byText(sel, text) : window.__t.q(sel);
    if (!el) return 'NOT_FOUND:' + sel + (text ? '/' + text : '');
    el.click();
    return 'OK';
  },
  /**
   * 按文字点第 n 个匹配。
   * 用在"同一张卡片里有两个同名按钮"的地方（服务端更新与客户端更新的按钮都叫「检查更新」），
   * byText 只认第一个，点不着后面那个。
   */
  clickNth: (sel, text, index) => {
    const list = vis(sel).filter((e) => (e.textContent || '').includes(text));
    const el = list[index];
    if (!el) return 'NOT_FOUND:' + sel + '/' + text + '#' + index;
    el.click();
    return 'OK';
  },
  /** 按 aria-label 点：标题栏那排是纯图标按钮，byText 够不着它们 */
  clickLabel: (label) => {
    const el = vis('[aria-label="' + label + '"]')[0];
    if (!el) return 'NOT_FOUND:' + label;
    el.click();
    return 'OK';
  },
  /**
   * 悬浮（不点击）某个元素，用于展开「悬浮即展开」的二级菜单。
   *
   * ⚠️ 派发的必须是**会冒泡的 pointerover**：React 的 onPointerEnter 是拿 pointerover
   *    合成出来的，而原生 pointerenter 不冒泡、根本到不了 React 挂根节点上的监听器 ——
   *    直接派发 pointerenter 会「什么也没发生」，断言则表现为「二级菜单没打开」。
   */
  hover: (sel, text) => {
    const el = text ? window.__t.byText(sel, text) : window.__t.q(sel);
    if (!el) return 'NOT_FOUND:' + sel + (text ? '/' + text : '');
    el.dispatchEvent(
      new PointerEvent('pointerover', {
        bubbles: true,
        cancelable: true,
        view: window,
        pointerType: 'mouse'
      })
    );
    return 'OK';
  },
  dbl: (sel) => {
    const el = window.__t.q(sel);
    if (!el) return 'NOT_FOUND';
    el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window }));
    return 'OK';
  },
  /**
   * 双击第 n 个匹配（dbl 只能点第一个）。
   *
   * 为什么需要它：验证「当前曲自动滚到列表中间」时必须点**列表靠后**的一行 ——
   * 点第一行的话「居中」与「贴顶」是同一个位置（都被夹到 0），断言恒真。
   */
  dblNth: (sel, index) => {
    const el = vis(sel)[index];
    if (!el) return 'NOT_FOUND:' + sel + '#' + index;
    el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window }));
    return 'OK';
  },
  /**
   * 把「看得见的那一页」滚回顶部（即时，不带动画）。
   *
   * 用来制造一个「当前曲不在中间」的前提 —— 不然「切走再切回来会重新定位」那一步
   * 无论有没有重新定位都绿：滚回去时它本来就还在中间。
   */
  scrollPageTop: () => {
    const slot = vis('.page-slot')[0];
    if (!slot) return 'NOT_FOUND:.page-slot';
    slot.scrollTo({ top: 0, behavior: 'instant' });
    return 'OK';
  },
  key: (key, mods) => {
    window.dispatchEvent(new KeyboardEvent('keydown', Object.assign({ key, bubbles: true }, mods || {})));
    return 'OK';
  },
  /**
   * 往输入框里打字。
   *
   * ⚠️ 必须走**原型上的 setter**，不能直接给 el.value 赋值：React 把上一次的值记在
   *    元素自己的 tracker 上，直接赋值会让它认为「值没变」，于是这次 input 事件被丢掉 ——
   *    表现为「字打进去了，界面毫无反应」（搜索/登录这些受控输入都会这样）。
   */
  type: (sel, value) => {
    const el = vis(sel)[0];
    if (!el) return 'NOT_FOUND:' + sel;
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return 'OK';
  },
  /** 提交表单。requestSubmit 会真的派发 submit 事件，React 的 onSubmit 才收得到 */
  submit: (sel) => {
    const form = vis(sel)[0];
    if (!form) return 'NOT_FOUND:' + sel;
    form.requestSubmit();
    return 'OK';
  },
  /**
   * 带修饰键点第 n 个匹配 —— 曲库的多选就是「Ctrl / Cmd 加选」，没有行首复选框。
   * 单靠 click 派发（无修饰键）在那边是「单选」，多选那几条断言根本走不到。
   */
  modClick: (sel, index, mods) => {
    const el = vis(sel)[index];
    if (!el) return 'NOT_FOUND:' + sel + '#' + index;
    el.dispatchEvent(
      new MouseEvent('click', Object.assign({ bubbles: true, cancelable: true, view: window }, mods || {}))
    );
    return 'OK';
  },
  /**
   * 在元素上派发 contextmenu（歌曲行的右键菜单）。
   *
   * 坐标取该元素的中心：菜单是按 clientX / clientY 摆的，用默认的 0,0 会贴在左上角，
   * 截图里看不出「这个菜单是这一行弹出来的」。
   */
  ctx: (sel, index) => {
    const el = vis(sel)[index ?? 0];
    if (!el) return 'NOT_FOUND:' + sel;
    const r = el.getBoundingClientRect();
    el.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: r.left + Math.min(160, r.width / 2),
        clientY: r.top + r.height / 2
      })
    );
    return 'OK';
  },
  /**
   * 在指定元素上派发按键。
   *
   * 命令面板的 Esc 绑在它**自己那个输入框**的 onKeyDown 上（不是 window），
   * 从 window 派发根本到不了 —— 那条断言会「看着点了、其实没关」。
   */
  keyOn: (sel, key) => {
    const el = vis(sel)[0];
    if (!el) return 'NOT_FOUND:' + sel;
    el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    return 'OK';
  },
  /** 点空白处（菜单/浮层「点别处就关」走的是 window 捕获阶段的 pointerdown） */
  clickAway: () => {
    document.body.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, cancelable: true, view: window, pointerType: 'mouse' })
    );
    return 'OK';
  },
  /**
   * 把 window.confirm 换成「一律答应 + 记一笔」。
   *
   * ★ Electron 里的 confirm 是**原生阻塞对话框**：不接管的话，CDP 驱动器会卡在那儿等一个
   *   永远不会有人点的按钮（而窗口在 Xvfb 里，用户也点不到）。
   * ★ 记下来的那一段本身是断言对象：它能证明「这个动作真的先问了一句」，
   *   比「点了就过了」多一层。
   */
  stubConfirm: () => {
    window.__confirmCalls = [];
    window.confirm = (message) => {
      window.__confirmCalls.push(String(message || ''));
      return true;
    };
    return 'OK';
  },
  confirmCalls: () => window.__confirmCalls || [],
  /**
   * 折叠侧栏里图标/封面中心相对「侧栏内容区中心」的最大偏移（px），越小越居中。
   *
   * 为什么要专门量它：折叠态下 .nav-count 仍带着 margin-left:auto，而 auto 外边距
   * 会**先于** justify-content 分配自由空间 —— 哪怕它的宽度已经缩到 0，也能把整行
   * 余量吃光，让 justify-content:center 形同虚设，歌单封面于是贴到左边缘。
   * 这种偏差在截图里几乎看不出来（所见即"它就在那儿"），只有量出来才知道。
   *
   * ⚠️ 选择器一律限定在 .surface-native 里：标题栏以下的那一块有两种形态
   *    （原生面 / 扩展面），两面**都在 DOM 里**（只有一面可见），而扩展面里也有一个
   *    用同一套 class 的侧栏。不限定的话这里会拿原生面那个侧栏的中心去量扩展面的图标，
   *    得到一个恒定的几十 px —— 断言看着"红了"，其实什么都没测到。
   */
  offCenter: () => {
    const side = document.querySelector('.surface-native .sidebar');
    if (!side) return -1;
    const sr = side.getBoundingClientRect();
    const cs = getComputedStyle(side);
    const left = sr.left + parseFloat(cs.paddingLeft);
    const right = sr.right - parseFloat(cs.paddingRight);
    const mid = (left + right) / 2;
    const covers = [...document.querySelectorAll('.surface-native .nav-cover')];
    const icons = [...document.querySelectorAll('.surface-native .nav-item svg')];
    return covers.concat(icons).reduce((max, el) => {
      const r = el.getBoundingClientRect();
      return Math.max(max, Math.abs((r.left + r.right) / 2 - mid));
    }, 0);
  },
  /** 分面卡上显示的标题，用来断言"当前是哪一维分面" */
  cardTitles: () => vis('.card .card-title').map((e) => (e.textContent || '').trim()),
  /**
   * chip 上的文字，用来断言"当前挂了哪些筛选"。
   * 不能改用个数断言："当前筛选"那一行里还有一个同为 .chip 的「清空全部」按钮。
   */
  chipTitles: () => vis('.chip').map((e) => (e.textContent || '').trim()),
  /** 折叠菜单里各项的文字。**顺序也是断言的一部分**（见 equals），所以不能用集合比 */
  menuTitles: () => vis('.context-menu button').map((e) => (e.textContent || '').trim()),
  /** 最靠后那一层菜单的条目 —— 二级菜单（如「我的歌单」）要单独看这一层 */
  lastMenuTitles: () => {
    const panels = vis('.context-menu');
    const last = panels[panels.length - 1];
    return last ? [...last.querySelectorAll('button')].map((e) => (e.textContent || '').trim()) : [];
  },
  /*
   * ★ 下面一律走 vis()：页面是常驻的，全局计数会把藏在其它页里的元素也数进来
   *   （.song-row / .card / .chip 尤其明显）。不在页面槽里的东西（播放条、命令面板、
   *   菜单、弹窗）走 vis 也不受影响 —— 它们本来就在 [data-hidden] 之外。
   */
  counts: () => ({
    rows: vis('.song-row').length,
    /**
     * 当前正播的那一行在这份列表里的下标；-1 = 这一页没有当前曲（没在播 / 歌不在列表里）。
     * 用来钉住「点的是第几行」——只断言偏移的话，定位到邻行也能绿。
     */
    currentRowIndex: vis('.song-row').findIndex((e) => e.dataset.current === 'true'),
    /**
     * 当前曲那一行的**中心**离「看得见的那一页」中心多少 px（取绝对值）。
     * -1 = 没有当前行。
     *
     * ★ 为什么量中心而不是「在不在视野里」：这一条要挡的是「滚到了中间」这件事本身。
     *   「看得见」是个太松的口径 —— 只保证看得见的实现（贴顶/贴底）也照样满足它。
     */
    currentRowOffset: (() => {
      const row = vis('.song-row').find((e) => e.dataset.current === 'true');
      const slot = row?.closest('.page-slot');
      if (!row || !slot) return -1;
      const r = row.getBoundingClientRect();
      const s = slot.getBoundingClientRect();
      return Math.round(Math.abs((r.top + r.bottom) / 2 - (s.top + s.bottom) / 2));
    })(),
    cards: vis('.card').length,
    navs: vis('.nav-item').length,
    chips: vis('.chip').length,
    switches: vis('[role="switch"]').length,
    // 当前页标题：用来确认「曲库 / 文件夹」是两个标签、同一页（切完标题还得是「曲库」）
    pageTitle: (window.__t.q('.page-title') || {}).textContent || '',
    // 文件夹模式的目录行（与歌曲行是两个不同的容器）
    folderRows: vis('.folder-row').length,
    // 歌词面板：行数用于回归"逐字源只覆盖部分行时不能丢主歌词的行"
    lyricLines: vis('.lyric-line').length,
    lyricWords: vis('.lyric-word').length,
    // 命令面板：条目数，用于确认 Ctrl+K 真的渲染出了可选项
    paletteItems: vis('.palette-item').length,
    // 播放队列条目数
    queueItems: vis('.queue-item').length,
    /**
     * 队列抽屉里当前那一项是否**整行**落在滚动区的可视范围内（拿 rect 量）。
     *
     * ★ 只数 queueItems 抓不到这一类 bug：那一项照样渲染着、高亮着，只是位置被算错了。
     *   实测踩过 —— 目标算到可滚底部之外，被引擎夹到最底，当前项落在视口上方 4014px。
     */
    queueCurrentInView: (() => {
      const body = document.querySelector('.panel-body');
      const item = document.querySelector('.queue-item[data-current="true"]');
      if (!body || !item) return null;
      const b = body.getBoundingClientRect();
      const r = item.getBoundingClientRect();
      return r.top >= b.top - 1 && r.bottom <= b.bottom + 1;
    })(),
    // 面板关闭时整个不渲染，所以数个数就是「开没开」
    panel: vis('.panel').length,
    // 折叠菜单里「双面」项（悬浮出二级菜单）的个数。菜单只断言文字的话，
    // 「歌单」从双面项退化成普通跳转项也看不出来 —— 二级菜单就那样静默消失。
    submenuTriggers: vis('.context-menu button[aria-haspopup="menu"]').length,
    // 控制栏上的当前曲目。面板关着时，这是「双击真的开始播放了」的唯一可断言口径。
    playerTitle: (window.__t.q('.playerbar-title') || {}).textContent || '',
    /*
     * 满窗播放（点底栏那颗封面进去的那一层）。与「面板」同一个口径：
     * 关着时整块不渲染，所以数个数就是「开没开」。
     */
    fullPlayer: vis('.fullplayer').length,
    /*
     * 满窗里显示的曲目 vs 底栏显示的曲目：**必须是同一首**。
     * 这一层是「同一个播放器的另一种画法」，所以这条挡的是「点进去换了一首歌 /
     * 读的是另一份状态」—— 只数 .fullplayer 有几个是完全看不出来的。
     * 两边都不在时返回 false：不然「满窗根本没开」也会算通过。
     */
    fullPlayerSameTrack: (() => {
      const full = window.__t.q('.fullplayer-title');
      const bar = window.__t.q('.playerbar-title');
      return !!full && !!bar && full.textContent === bar.textContent;
    })(),
    /*
     * 满窗真的「满」吗：它得盖住整个原生面（含底下那条播放条）。
     * 只断言 .fullplayer 存在的话，一层只占上半截的小浮层也能绿 —— 而那正是
     * 这个功能的名字所承诺的东西。
     */
    fullPlayerCoversBar: (() => {
      const full = window.__t.q('.fullplayer');
      const bar = window.__t.q('.playerbar');
      if (!full || !bar) return false;
      const f = full.getBoundingClientRect();
      const b = bar.getBoundingClientRect();
      return f.width > 0 && f.top <= b.top + 1 && f.bottom >= b.bottom - 1;
    })(),
    /*
     * 满窗播放时标题栏有没有**跟着换底色**：它得变成透明、关掉自己的毛玻璃、收掉分隔线
     * （那层底色由播放器铺到它底下，见 components.css 的 .shell[data-fullplayer]）。
     * 纯 CSS 的行为，不断言就会静默回退成那条颜色对不上的横带。
     */
    titlebarFollowsPlayer: (() => {
      const bar = window.__t.q('.titlebar');
      if (!bar || !window.__t.q('.fullplayer')) return false;
      const cs = getComputedStyle(bar);
      return (
        cs.backgroundColor === 'rgba(0, 0, 0, 0)' &&
        cs.backdropFilter === 'none' &&
        cs.borderBottomColor === 'rgba(0, 0, 0, 0)'
      );
    })(),
    /* 收起之后标题栏要回到原来那一份（玻璃底 + 毛玻璃）。只断言「满窗时是透明的」的话，
       把标题栏写死成永远透明也照样绿 —— 这一条挡的就是那种改法。 */
    titlebarGlass: (() => {
      const bar = window.__t.q('.titlebar');
      if (!bar) return false;
      const cs = getComputedStyle(bar);
      return cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.backdropFilter !== 'none';
    })(),
    // 折叠侧栏的居中偏差（px），回归"封面被 auto 外边距顶到左边"
    offCenter: window.__t.offCenter(),
    cardTitles: window.__t.cardTitles(),
    chipTitles: window.__t.chipTitles(),
    menuItems: window.__t.menuTitles(),
    subMenuItems: window.__t.lastMenuTitles(),
    // 菜单里的分割线（渲染成 hr，不是 button，光断言条目文字看不见它）
    menuDividers: vis('.context-menu hr').length,
    // 设置页左侧的分区名（含顺序）。分区是"对标原播放器"定下来的需求，
    // 只算个数的话，少一个分区或换了次序都看不出来。
    settingsNav: vis('.settings-nav button').map((e) => (e.textContent || '').trim()),
    /*
     * 设置页当前分区的卡片文字。
     * 新分区显示的全是"从服务端读回来的值"，数卡片数/开关数区分不出"读到了"与
     * "接口不存在、画成空壳"——两者渲染出来的结构一模一样。所以按内容断言。
     */
    settingText: vis('.setting-card').map((e) => e.textContent || '').join(' '),
    /*
     * 设置行右侧的小字（.setting-row-meta，版本号渲染在这里）。
     * 必须整串比：断言里写 contains('v2.13.1') 是抓不到 vv2.13.1 的——它本身就包含
     * v2.13.1。这里取出整串，多一个 v 立刻红。
     */
    metaTags: vis('.setting-row-meta').map((e) => (e.textContent || '').trim()),
    /*
     * 占用进度条。放在缓存管理那一步断言 = 2 条：服务端缓存与本机缓存各一条。
     * 只数个数就够 —— 这里要挡的是"某一侧压根忘了画"，宽度值随实际字节数变，没法钉死。
     * （控制栏的播放进度是另一个类名 .playerbar-progress-fill，不会混进来。）
     */
    usageBars: vis('.progress-fill').length,
    // 开着的开关数。断言开关"真的翻了"要用它 —— 只断言开关存在，onChange 没接上也照样绿
    switchesOn: vis('[role="switch"][aria-checked="true"]').length,
    /*
     * 页头标题下面那句副标题。搜索页（「「摇滚」命中 12 首歌曲」）与插件管理
     * （「3 个已安装 · 1 个启用中 · …」）都靠它交代**数据读回来了没有** ——
     * 只断言标题在的话，「接口没通、标题照画」是看不出来的。
     */
    pageSubtitle: vis('.page-subtitle').map((e) => (e.textContent || '').trim()).join(''),
    /** 首页的三个分区块标题（最近加入 / 我的歌单 / 常听歌手） */
    sectionTitles: vis('.section-title').map((e) => (e.textContent || '').trim()),
    /** 首页统计条上那六项的名目 —— 数量随数据走，名目是固定的 */
    statLabels: vis('.stat-label').map((e) => (e.textContent || '').trim()),
    /** 文件夹模式的目录行文字（清单上写着几首，点进去就该是几首） */
    folderNames: vis('.folder-row').map((e) => (e.textContent || '').trim()),
    /** 面包屑（文件夹模式逐级进入 / 跳回），取按钮文字 */
    crumbs: vis('.crumbs button').map((e) => (e.textContent || '').trim()),
    /*
     * 「服务器」那一格里嵌着的两颗子选项（曲库 / 文件夹），见 components/LibraryHeader。
     * ★ 只在来源是「服务器」时存在：切到「本地」时连它们所在的那一页都整块被藏起来，
     *   所以这里数出来是 0。★ 两种看法下都得在（切过去了还得能切回来）。
     */
    viewSwitches: vis('.segmented-sub button').length,
    /*
     * 多选操作条。**没有行首复选框** —— 多选靠 Ctrl / Shift 点行，选完这一条才出现，
     * 所以「它在不在」与「上面写着已选几首」就是多选这条链路的全部判据。
     */
    selectionBars: vis('.selection-bar').length,
    selectionText: vis('.selection-bar').map((e) => (e.textContent || '').trim()).join(' '),
    /** 命令面板的分组标题（歌曲 / 歌单 / 命令）—— 只数条目个数看不出分组有没有接上 */
    paletteGroups: vis('.palette-group').map((e) => (e.textContent || '').trim()),
    /** 空态文案（搜索无结果、「没有匹配的扩展」…） */
    emptyText: vis('.empty').map((e) => (e.textContent || '').trim()).join(' '),
    /**
     * 菜单里的小字（.menu-sub）。歌曲菜单对本地曲会多写一句
     * 「本地歌曲受保护，不会被曲库删除」—— 那是菜单自己的**说明**，不是条目，
     * 只断言条目文字的话看不见它。
     */
    menuNotes: vis('.context-menu .menu-sub').map((e) => (e.textContent || '').trim()),
    /** 当前在哪一面（native / extensions）。标题栏两颗拆分按钮的走位全靠它 */
    surface: (document.querySelector('.shell') || {}).dataset?.surface ?? '',
    /** 扩展侧栏的入口（前两条固定是插件商店 / 插件管理，之后是已开启的扩展） */
    extNavs: vis('.ext-sidebar .nav-item').map((e) => (e.textContent || '').trim()),
    /** 插件管理列表：只取名字那一段（版本号是紧跟其后的 .badge，不属于名字） */
    extNames: vis('.extension-row .extension-name .truncate').map((e) =>
      (e.textContent || '').trim()
    ),
    /** 名字右侧的角标：「v1.2.0」/「运行异常」 */
    extBadges: vis('.extension-row .extension-name .badge').map((e) => (e.textContent || '').trim()),
    /** 行尾那颗「常驻运行」处于按下态的数量 */
    extPinned: vis('.extension-actions [data-active="true"]').length,
    /** 商店卡片：名字 / 动作按钮文字 / entryPath */
    storeNames: vis('.store-card .store-card-name').map((e) => (e.textContent || '').trim()),
    storeActions: vis('.store-card-action').map((e) => (e.textContent || '').trim()),
    storeCodes: vis('.store-card .store-card-code').map((e) => (e.textContent || '').trim()),
    /*
     * 来源下拉里的每一格。
     * ★ 「GitHub 发现」不是订阅源（它不进 mock 的源列表），只在这一格里出现 ——
     *   所以只能这样断言它确实接上了，不能拿 sourceNames 去查。
     */
    storeSources: vis('select[aria-label="筛选订阅源"] option').map((e) =>
      (e.textContent || '').trim()
    ),
    /** 订阅源对话框里的源行数（每行一颗开关 + 两个输入框） */
    sourceRows: vis('.source-row').length,
    /*
     * 订阅源的名字。
     * ★ 必须取 input 的 value，不能读 textContent：那一列是**输入框**，
     *   而 textContent 里没有输入框的值 —— 于是断言会看着「源是空的」而失败，
     *   实际界面上写得好好的。
     */
    sourceNames: vis('.source-row input[aria-label="订阅源名称"]').map((e) => e.value),
    /** 侧栏是不是折叠成图标条了（折叠态才会露出的那颗按钮决定它） */
    sidebarCollapsed:
      vis('.surface-native .sidebar')[0]?.dataset.collapsed ?? '',
    /**
     * 插件页的装载结果。
     * webview 是**独立进程的 guest**：宿主这边数的是「挂上了几个」，
     * 蒙层还留着就说明它没加载出来（.plugin-view-overlay[data-state=…]）。
     */
    pluginWebviews: vis('webview').length,
    pluginOverlays: vis('.plugin-view-overlay').map((e) => e.dataset.state ?? ''),
    /*
     * 迷你播放器。
     * ★ 它的界面**在另一个窗口里**（独立 BrowserWindow → 另一个渲染进程 → 另一个 CDP
     *   target，见 main/mini-window.ts），所以这一份探针在哪个页面里跑就量到哪一边：
     *   · 主窗口这边这三个数永远是 0 —— 那正是「主界面没有被换成迷你条」的证据；
     *   · 迷你窗那边 .mini-player 恒为 1，面板/队列按开合变化。
     *   ★ 迷你那几个 DOM 不在任何 .surface 里，所以不走 vis()（那一页里也没有 data-hidden）。
     */
    miniPlayer: document.querySelectorAll('.mini-player').length,
    miniPanel: document.querySelectorAll('.mini-panel').length,
    miniQueue: document.querySelectorAll('.mini-queue').length,
    /*
     * 底栏那颗迷你按钮的按下态。窗口是**主进程**开的，渲染层没有别的渠道知道它开着没有
     * （状态由主进程推回来，见 useUi.miniOpen）—— 所以这一条同时验了两件事：
     * 按钮跟着状态走，以及主进程那条推送真的到了。
     * 三种取值：'true' 开着 / '' 关着 / 'missing' 按钮不在（那就是界面坏了，不是状态）。
     */
    miniOpen:
      vis('.playerbar [aria-label="关闭迷你播放器"]').length > 0
        ? 'true'
        : vis('.playerbar [aria-label="迷你播放器"]').length > 0
          ? ''
          : 'missing',
    /*
     * 迷你条中栏那两行（歌名 / 歌手）与右上角那一组窗口钮。
     * ★ 中栏的行数必须**去重后再数**：一行放不下时那一行会挂两份文本（循环滚动的第二份），
     *   直接数 .mini-line-copy 会随歌名长短在 2 与 4 之间飘。
     * ★ 窗口钮按 aria-label 逐个点名（equals 连顺序一起钉）：这一条同时挡住「少了一颗」
     *   与「那第三颗『退出迷你模式』又回来了」—— 独立窗口之后它已经没有意义。
     */
    miniInfo: [
      ...new Set(
        [...document.querySelectorAll('.mini-info-text .mini-line-copy')].map((e) =>
          (e.textContent || '').trim()
        )
      )
    ],
    miniTime: (document.querySelector('.mini-time') || {}).textContent ?? '',
    /*
     * 中栏第一行（歌名）的**文本**。只数行数（miniInfo）挡不住「快照根本没送到」——
     * 那种情况下那两行会显示占位文案（「未在播放」/ 空歌手），行数照样是 2，形状断言全绿。
     * 所以这一条按**内容**断言（hasSong）。迷你窗的状态全靠主窗口推（见 state/mini-host.ts），
     * 「推不过去」是本项目踩过的真缺陷（严格模式把接线拆掉之后没装回来）。
     */
    miniTitle: (
      document.querySelector('.mini-info-text .mini-line-copy') || {}
    ).textContent?.trim() ?? '',
    /*
     * 那颗主播放键此刻的文案（暂停 / 播放）。它与主窗口底栏那颗读的是**同一份播放状态**，
     * 所以这一条就是「两个播放器在播放 / 暂停上一致」的直接断言 —— 迷你窗显示「暂停」而底下的
     * 音频真的在放，两件事只有同一个事实源时才同时成立。
     */
    miniPlayLabel:
      (document.querySelector('.mini-controls .play-btn') || {}).getAttribute?.('aria-label') ??
      '',
    miniControls: document.querySelectorAll('.mini-controls button').length,
    miniWinButtons: [...document.querySelectorAll('.mini-window-actions button')].map(
      (e) => e.getAttribute('aria-label') || ''
    ),
    // 登录页：形状 + 出错时那条提示（探不通服务器与账号密码错是两句不同的话）
    login: document.querySelectorAll('.login').length,
    probeText: [...document.querySelectorAll('.probe-result')]
      .map((e) => (e.textContent || '').trim())
      .join(' '),
    probeErrors: document.querySelectorAll('.probe-result[data-state="error"]').length,
    /** 走 window.confirm 的风险动作点了哪些（stubConfirm 记的，见那个助手） */
    confirmCalls: (window.__confirmCalls || []).slice(),
    // 播放队列面板上的「清空」——队列条目的数量会因为之前几步而变化，这条动作键是固定的
    queueClears: vis('.panel .btn').filter((e) => (e.textContent || '').includes('清空')).length,
    // 弹窗（.modal 才是那个面板；.overlay 是一直挂在 DOM 里的遮罩容器，数它没有意义）
    modals: vis('.modal').length,
    /** 弹窗标题。它在 .modal-head 里，body / foot 两段都取不到 —— 所以单独取一份 */
    modalTitle: vis('.modal .modal-title').map((e) => (e.textContent || '').trim()).join(''),
    /*
     * 弹窗的文字（正文 + 底部按钮）。与服务端来的值逐一对照（版本号、发布说明、通道名），
     * 底部那排也一起取：这一版弹窗给的**动作**（上传升级 / 立即升级 / 关闭）本身就是断言对象 ——
     * 比如检查失败时上传入口该留着、非 Docker 时该消失。
     */
    modalText: vis('.modal-body, .modal-foot')
      .map((e) => e.textContent || '')
      .join(' ')
  })
};
'ready'
`

/**
 * 找一个渲染层的调试 target。
 *
 * `hash` 给了就只要 URL 以它结尾的那一个（'#mini' = 迷你窗那一页）—— 两个窗口各是一个
 * target，不筛的话拿到的取决于 CDP 列出来的顺序，跑十次红三次那种。
 */
async function findPage(hash = '') {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP}/json`)
      const list = await res.json()
      const page = list.find(
        (t) => t.type === 'page' && t.webSocketDebuggerUrl && (!hash || t.url.endsWith(hash))
      )
      if (page) return page
    } catch {
      /* 还没起来 */
    }
    await sleep(500)
  }
  throw new Error(`等不到渲染层调试 target${hash ? `（${hash}）` : ''}`)
}

/** 连上某个 target 的 WebSocket（连不上就是启动没起来，直接抛） */
async function openSocket(url) {
  const socket = new WebSocket(url)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  return socket
}

class Session {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data)
      const entry = this.pending.get(msg.id)
      if (!entry) return
      this.pending.delete(msg.id)
      if (msg.error) entry.reject(new Error(JSON.stringify(msg.error)))
      else entry.resolve(msg.result)
    })
  }

  send(method, params = {}) {
    this.id += 1
    const id = this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`CDP 超时: ${method}`))
        }
      }, 25000)
    })
  }

  async evaluate(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    })
    if (res.exceptionDetails) {
      const d = res.exceptionDetails
      throw new Error(`渲染层抛错: ${d.exception?.description ?? d.text}`)
    }
    return res.result?.value
  }

  async shot(name, wait = 1000) {
    await sleep(wait)
    const res = await this.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false
    })
    const { writeFileSync } = await import('node:fs')
    writeFileSync(`${OUT}/${name}.png`, Buffer.from(res.data, 'base64'))
    return Buffer.from(res.data, 'base64').length
  }
}

/**
 * [输出名, 表达式（只允许一次点击）, 点完后等多久, 期望的 DOM 统计, 在哪一页跑]
 *
 * ★ 第 5 项 'mini' = 这一步在**迷你窗那一页**里跑（默认在主窗口）。两个窗口各是一个 CDP
 *   target，而 window.__t 这些助手是**按页面注入**的 —— 不指明跑哪一页，点「歌词」那一步
 *   会在主窗口里找 `.mini-bar`（那里没有），断言表现成 NOT_FOUND。
 *
 * mock 数据基线：43 首（41 本地 + 2 网络 + 0 电台）、5 位歌手、8 张专辑、5 种流派、
 * 3 张歌单、10 条最近播放、6 首收藏、5 个文件夹；流派「摇滚」12 首。
 */
const STEPS = [
  ['01-home', "window.__t.click('.nav-item', '首页')", 1500],

  // ── 曲库：类型筛选 → 分面浏览 → 组合筛选 ──────────────────────────────
  ['02-library', "window.__t.click('.nav-item', '曲库')", 2200, { rows: exactly(43) }],
  /*
   * ★ 类型筛选这三步的选择器**必须带上 `[aria-label="歌曲类型"]`**：曲库页头上还有另一颗
   *   `.segmented`（本地 / 服务器 来源切换，「服务器」那格里还嵌着曲库 / 文件夹），而两边的
   *   可见文字里都有「服务器」—— 不限定的话按文字点会先命中页头那一颗，于是「切了类型」其实
   *   什么都没筛，断言却对着 41 行绿。
   */
  [
    '03-library-type-server',
    "window.__t.click('.segmented[aria-label=\"歌曲类型\"] button', '服务器')",
    2000,
    { rows: exactly(41), chipTitles: containsAll('服务器') }
  ],
  [
    '04-library-type-radio',
    "window.__t.click('.segmented[aria-label=\"歌曲类型\"] button', '电台')",
    2000,
    { rows: exactly(0), chipTitles: containsAll('电台') }
  ],
  // 切回「全部」：分面浏览必须在不带类型过滤的基线上看，否则后面 rows 断言会串味
  [
    '05-library-type-all',
    "window.__t.click('.segmented[aria-label=\"歌曲类型\"] button', '全部')",
    2000,
    { rows: exactly(43) }
  ],
  /*
   * 打开分类浏览。默认维是「歌手」，所以卡片内容必须是歌手名。
   * ★ 它现在是一颗**图标钮**（筛选行右端那几颗之一，与「显示隐藏歌单曲目」同一排），
   *   没有可见文字 —— 只能按 aria-label 点（byText 够不着）。
   */
  [
    '06-library-browse-on',
    "window.__t.clickLabel('分类浏览')",
    2600,
    { cards: exactly(5), cardTitles: containsAll('陈屿', '野岸乐队') }
  ],
  // 切到「流派」维：卡片数同为 5，但内容必须变成流派名 —— 这是"有没有点中 chip"的唯一判据
  [
    '07-library-genre-facets',
    "window.__t.click('.chip', '流派')",
    2600,
    { cards: exactly(5), cardTitles: containsAll('摇滚', '爵士') }
  ],
  // 点流派卡：applyFilter 会关掉分类浏览并在表头挂出筛选 chip
  // 断言按 chip 文字而不是个数 —— 「清空全部」也是 .chip
  [
    '08-library-filter-rock',
    "window.__t.click('.card', '摇滚')",
    2400,
    { rows: exactly(12), cards: exactly(0), chipTitles: containsAll('流派：摇滚') }
  ],

  /*
   * 换一种看法（嵌在来源分段里那颗「文件夹」）：内容换成目录，**标题还得是「曲库」** ——
   * 这一条正是「同一页的不同看法」的判据，只看 folderRows 的话，"又开了一个页面"也能过。
   * ★ 选择器限定在「曲库来源」那颗分段里：那一格里同时摆着「本地 / 服务器 / 曲库 / 文件夹」，
   *   byText 取的是第一个命中的元素，不限定就等于让人猜点到了谁。
   * ★ 顺带断言那两颗子选项**还在**（=2）：它们留在原处才谈得上「切回来」。
   */
  [
    '09-library-folders-tab',
    "window.__t.click('.segmented[aria-label=\"曲库来源\"] button', '文件夹')",
    2200,
    { folderRows: exactly(5), pageTitle: exactly('曲库'), viewSwitches: exactly(2) }
  ],
  /*
   * 逐级进入目录。断言的是**行数**而不是「有内容」：目录行上写着「N 首」，
   * 点进去就该是 N 行 —— mock 那两个数字以前对不上（清单 8 首、实际 10 行），
   * 只数「非空」的话这种自相矛盾会一直躺着。
   *
   * ★ 这两步必须紧跟在上一步（文件夹看法刚切过去）之后：先切回「曲库」那颗子选项再点
   *   .folder-row，会拿到一个 NOT_FOUND —— 而 NOT_FOUND 那一步的截图看着还挺正常。
   */
  [
    '10-folder-open',
    "window.__t.click('.folder-row', '陈屿')",
    2200,
    { rows: exactly(10), crumbs: containsAll('音乐根目录', '陈屿'), pageTitle: exactly('曲库') }
  ],
  // 面包屑跳回根：退回后面包屑只剩根那一节，子目录清单重新出现
  [
    '11-folder-back-root',
    "window.__t.click('.crumbs button', '音乐根目录')",
    2000,
    { folderRows: exactly(5), crumbs: equals('音乐根目录') }
  ],
  // 换回「曲库」（服务器那一格里的另一颗子选项）：两种看法要能来回切，
  // 且切回来不能是空页（上一段筛的「流派：摇滚」还在）
  [
    '12-library-tab-back',
    "window.__t.click('.segmented[aria-label=\"曲库来源\"] button', '曲库')",
    2400,
    { rows: exactly(12), folderRows: exactly(0), pageTitle: exactly('曲库') }
  ],

  // ── 歌单 / 最近 / 收藏 ─────────────────────────────────────────────────
  ['13-playlists', "window.__t.click('.nav-item', '歌单')", 1800, { cards: atLeast(3) }],
  ['14-playlist-detail', "window.__t.click('.nav-item', '深夜写码')", 2200, { rows: atLeast(1) }],
  ['15-recent', "window.__t.click('.nav-item', '最近播放')", 2400, { rows: exactly(10) }],
  ['16-favorites', "window.__t.click('.nav-item', '我喜欢')", 2400, { rows: exactly(6) }],

  /*
   * ── 搜索：工具条那个搜索框 → 搜索页 ────────────────────────────────────
   * ★ 选择器必须写 `.toolbar .search-field`：搜索页**自己**也有一个同名的
   *   `form.search-field`（页内再搜一次）。不限定就会点到那一份上，而它的 onChange
   *   只在搜索页里生效 —— 于是「打字」这一步看着成功、其实什么都没发生。
   */
  ['17-search-type', "window.__t.type('.toolbar .search-field input', '摇滚')", 1200],
  [
    '18-search-results',
    "window.__t.submit('.toolbar .search-field')",
    2600,
    {
      pageTitle: exactly('搜索'),
      rows: exactly(12),
      // 「「摇滚」命中 12 首歌曲」：命中数只可能来自后端，写死在前端就会对不上
      pageSubtitle: containsAll('摇滚', '命中', '12'),
      // 相关歌单 / 歌手 / 专辑是搜索页的另一半，只断言歌曲列表的话它们整块丢了也看不见
      sectionTitles: containsAll('相关歌单', '相关歌手', '相关专辑')
    }
  ],
  // 搜不到东西时的空态：不能只把列表清成一片白（那与「还在加载」长得一模一样）
  [
    '19-search-empty',
    "window.__t.type('.toolbar .search-field input', '无此歌名')",
    2200,
    { rows: exactly(0), emptyText: containsAll('没有找到') }
  ],
  // 离开搜索页回曲库：曲库自己那份筛选还在（搜索关键词只活在工具条与搜索页）
  ['20-search-leave', "window.__t.click('.nav-item', '曲库')", 2000, { rows: exactly(12) }],

  /*
   * ── 右键歌曲行 ─────────────────────────────────────────────────────────
   * 断言条目**文字**而不是个数：这些项来自 buildSongMenuItems，少一条
   * （比如「下一首播放」掉了）只数个数是看不出来的。
   * 另外两条分割线（`<hr>`）与那句「本地歌曲受保护…」在条目列表里都没有对应文字，
   * 得单独数 / 单独取 —— 后者也顺带说明这一首确实被识别成了本地曲。
   */
  [
    '21-song-menu',
    "window.__t.ctx('.song-row', 0)",
    1200,
    {
      menuItems: containsAll(
        '播放',
        '下一首播放',
        '加入播放队列',
        '加入歌单…',
        '收藏',
        '查看歌手',
        '查看专辑',
        '打开源地址',
        '从曲库删除'
      ),
      menuDividers: exactly(2),
      menuNotes: containsAll('本地歌曲受保护')
    }
  ],
  // Esc 关掉右键菜单（「Esc 关闭」那条监听挂在 window 的 keydown 上，从 window 派发就够）
  ['22-song-menu-closed', "window.__t.key('Escape')", 900, { menuItems: equals() }],

  /*
   * ── 多选与批量操作 ─────────────────────────────────────────────────────
   * 曲库**没有行首复选框**：多选是 Ctrl / Cmd 点行（Shift 连选）。
   * 断言分两步：先确认点一行后操作条出现，再确认第二行是**加**进去的 ——
   * 只断言操作条存在的话，「点两行只选出 1 行」也照样绿。
   */
  [
    '23-select-one',
    "window.__t.modClick('.song-row', 0, { ctrlKey: true })",
    1200,
    { selectionBars: exactly(1), selectionText: containsAll('已选 1 首') }
  ],
  [
    '24-select-two',
    "window.__t.modClick('.song-row', 1, { ctrlKey: true })",
    1200,
    {
      selectionText: containsAll('已选 2 首', '播放', '加入队列', '加入歌单', '收藏', '从曲库删除')
    }
  ],
  // 「取消选择」把整条操作条收回去（它是这一页唯一的出口，收起后不该留一块空壳）
  [
    '25-selection-clear',
    "window.__t.click('.selection-bar button', '取消选择')",
    1000,
    { selectionBars: exactly(0) }
  ],

  // ── 导航菜单 → 二级菜单 → 设置九个分区 ───────────────────────────────────
  // 标题栏「Songloft」右侧那颗下拉三角（标题栏现在是两颗拆分按钮：Songloft 管导航、
  // 扩展管扩展，原来那颗独立的折叠菜单按钮已经拆掉了）。断言用 equals 而不是
  // containsAll：菜单项的**顺序**也是需求的一部分，集合比会把「顺序错了」放过。
  // 「文件夹」不在菜单里 —— 它是曲库页的标签；「扩展」也不在 —— 它有自己的按钮与下拉。
  [
    '26-nav-menu',
    "window.__t.clickLabel('导航菜单')",
    900,
    {
      menuItems: equals('首页', '曲库', '歌单', '我喜欢', '最近播放', '设置'),
      // 设置与上面那串之间要有分割线（条目文字看不出这条线，得单独数）
      menuDividers: exactly(1),
      // 菜单里**没有**单独的「我的歌单」：它并进了「歌单」这个双面项（悬浮列名单、
      // 单击进歌单页）。只断言条目文字的话，「歌单」退化成普通跳转项也看不出来。
      submenuTriggers: exactly(1)
    }
  ],
  // 「歌单」的二级菜单 = 那份歌单名单。这里同样用 equals：断言的是名单内容与顺序，
  // 只数个数的话「混进电台收藏之类的非普通歌单」也可能碰巧一样多。
  // ★ 二级菜单靠 onPointerEnter 展开，所以这一步是**悬浮**而不是点击
  //   （点它是「进歌单页」，菜单会整份关掉，二级菜单根本没机会出现）。
  [
    '27-nav-my-playlists',
    "window.__t.hover('.context-menu button', '歌单')",
    900,
    // 顺序 = store 的顺序（置顶的「深夜写码」在最前，其余按后端给的次序）
    { subMenuItems: equals('深夜写码', '我喜欢的音乐', '通勤路上') }
  ],
  // 二级菜单开着也不影响接着点上一层的项（设置入口就在那儿）
  [
    '28-settings-appearance',
    "window.__t.click('.context-menu button', '设置')",
    1600,
    /*
     * 分区名与顺序都算需求（对标原播放器定的）：少一个分区、或换次序，这条立刻红。
     * 「服务器」曾是独立一栏，后来并进了「账号」（那两栏讲的都是「连的哪台、谁的凭据」），
     * 所以这里现在是**九**栏 —— 这一条正是那次合并的回归断言。
     */
    {
      settingsNav: equals(
        '外观',
        '播放与歌词',
        '曲库与扫描',
        '缓存管理',
        '网络设置',
        '数据管理',
        '账号',
        '快捷键',
        '关于与更新'
      )
    }
  ],
  [
    '29-settings-playback',
    "window.__t.click('.settings-nav button', '播放')",
    1800,
    { switches: atLeast(1) }
  ],
  [
    '30-settings-library',
    "window.__t.click('.settings-nav button', '曲库')",
    2200,
    { switches: atLeast(2) }
  ],
  /*
   * 缓存管理：服务端那张卡的几个值全来自后端（/cache-manage/stats + /config），接错线就
   * 渲染成默认值或「读取失败」，而此时**结构是一样的**（卡片、开关、进度条都在），
   * 所以断言按内容：「640 MB」「137」只可能来自 mock 的 stats；
   * 「转码码率」那一行只在 transcode_format 非空时才渲染 —— 读成空串它就整行消失。
   *
   * 本机缓存那张卡走的是 IPC（不经过 mock），断言它能渲染出来就顺带验了「桥接 + 主进程
   * 处理器」这一串接线 —— 少任何一环，那张卡都会停在「读取失败」。
   * usageBars=2：两张卡的「占用」都得带进度条，缺一条立刻红。
   */
  [
    '31-settings-cache',
    "window.__t.click('.settings-nav button', '缓存管理')",
    2400,
    {
      settingText: containsAll(
        '137',
        '640 MB',
        '2 GB',
        '转码码率',
        '/var/lib/songloft/music_cache',
        '本地缓存',
        '最大本地缓存大小',
        '清理本地缓存'
      ),
      usageBars: exactly(2)
    }
  ],
  // 网络设置：三条代理各挂一个端点，mock 里取的都**不是**默认值（空串 / 空数组才是默认），
  // 于是「字段读错」会显示成「未设置」，跟读对了区分得开
  [
    '32-settings-network',
    "window.__t.click('.settings-nav button', '网络设置')",
    2400,
    {
      settingText: containsAll('192.168.1.9:7890', 'gh-proxy.example', '192.168.1.0/24'),
      switches: atLeast(2)
    }
  ],
  [
    '33-settings-data',
    "window.__t.click('.settings-nav button', '数据管理')",
    1800,
    { settingText: containsAll('导出歌单', '导入歌单') }
  ],
  // 账号：版本号整串比 —— vv2.13.1 这个缺陷只有这么断言才挡得住（见 metaTags 的注释）
  [
    '34-settings-account',
    "window.__t.click('.settings-nav button', '账号')",
    2400,
    { metaTags: equals('v2.13.1'), settingText: containsAll('测试连接', 'ms ·') }
  ],
  // 快捷键页要能对上 App.tsx 里真实存在的绑定；漏一条（如 Ctrl+L）这条就红
  [
    '35-settings-shortcuts',
    "window.__t.click('.settings-nav button', '快捷键')",
    1400,
    {
      settingText: containsAll(
        'Ctrl / Cmd + K',
        'Ctrl / Cmd + L',
        'Alt + ←',
        '空格',
        'Ctrl / Cmd + ,'
      )
    }
  ],
  /*
   * 关于与更新：三条链路各验一处 ——
   *   Electron/Chromium/Node 来自主进程（app.info）；后端版本来自探测（/version = v2.13.1）；
   *   「Debug」来自 /settings/log-level（默认值是 Info，mock 给的是 debug，于是"没读到端点、
   *   退回了兜底值"与"读到了"在界面上长得不一样 —— 只看「日志等级」四个字是区分不出来的）。
   */
  [
    '36-settings-about',
    "window.__t.click('.settings-nav button', '关于与更新')",
    2200,
    {
      settingText: containsAll(
        'Electron',
        'Chromium',
        'Node',
        '后端版本',
        'v2.13.1',
        '日志等级',
        '导出日志',
        'Debug'
      )
    }
  ],
  /*
   * 服务端升级弹窗：点「检查更新」→ 弹窗自己查一次 → 把两条通道都摆出来。
   * 断言按内容：版本号只可能来自 /upgrade/check，且两条通道取的是**不同**的版本号 ——
   * 若代码把同一个值画了两遍（比如只读了扁平的 latest_version），这里就会红。
   * 「当前版本 v1.4.2」还顺带看着版本号只补一个 v。
   */
  [
    '37-upgrade-modal',
    "window.__t.click('.btn', '检查更新')",
    2600,
    {
      modals: exactly(1),
      modalText: containsAll(
        '当前版本',
        'v1.4.2',
        '正式版 v1.5.0',
        '测试版 v1.6.0-dev.3',
        '缓存目录切换后立即生效',
        '上传升级'
      )
    }
  ],
  // 关掉：升级是服务端的后台任务，弹窗只是观察窗 —— 后面几步要在没有遮罩的界面上做
  [
    '38-upgrade-modal-closed',
    "window.__t.click('.modal-foot .btn', '关闭')",
    800,
    { modals: exactly(0) }
  ],
  /*
   * 客户端更新弹窗。按钮文字与服务端那行同名（都叫「检查更新」），所以按序号点第二个 ——
   * 客户端那行在后。
   * 只断言两端确定的：当前版本来自本机、底部两个键来自弹窗自己。结果那句话不钉死 ——
   * 巡检机可能连不上 GitHub（CI 的共享 IP 还会撞上频率限制），那时弹窗画的是失败提示。
   */
  [
    '39-client-update-modal',
    "window.__t.clickNth('.btn', '检查更新', 1)",
    2200,
    { modals: exactly(1), modalText: containsAll('当前版本', '关闭', '打开发布页') }
  ],
  [
    '40-client-update-modal-closed',
    "window.__t.click('.modal-foot .btn', '关闭')",
    800,
    { modals: exactly(0) }
  ],
  // 自动检查更新开关：关一下再开回来。这两步才叫"验了开关" —— 只断言它存在的话，
  // onChange 根本没接上（点了没反应）也照样绿
  [
    '41-auto-update-switch-off',
    'window.__t.click(\'button[aria-label="启动时自动检查更新"]\')',
    1000,
    { switchesOn: exactly(0) }
  ],
  [
    '42-auto-update-switch-on',
    'window.__t.click(\'button[aria-label="启动时自动检查更新"]\')',
    1000,
    { switchesOn: exactly(1) }
  ],

  /*
   * ── 扩展面（原生面之外的另一整面）──────────────────────────────────────
   * 标题栏那颗「扩展」按钮的主点击是 `showSurface('extensions')`：只换面、不动路由，
   * 所以它落回**上次在的那一栏** —— 初始那一栏是「插件商店」。
   *
   * 三条断言各挡一类静默失败：面有没有真的换过去；商店列表有没有读到
   * （骨架屏 / 错误态的结构跟正常态不同，但只数卡片个数的话「四张空卡」也过得去）；
   * 以及四档动作文字（未装 / 可更新 / 已装最新 / 入口撞名是按条目状态推出来的，
   * 写死成一档就会在这里红）。
   */
  [
    '43-extensions-store',
    "window.__t.clickLabel('扩展')",
    2600,
    {
      surface: exactly('extensions'),
      extNavs: containsAll('插件商店', '插件管理'),
      storeNames: containsAll('封面墙', '歌词补全', '豆瓣标签', '专辑墙'),
      storeActions: containsAll('安装', '更新至 v1.3.0', 'v0.9.3', '覆盖安装'),
      storeSources: containsAll('全部订阅源', '官方源', 'GitHub 发现')
    }
  ],
  /*
   * 订阅源管理弹窗：两个源一开一停。断言的是「行数 + 源名 + 标题」——
   * 读不到配置时这里会是空的，而空列表与「本来就没配」长得一模一样，
   * 所以 mock 里那两个源是刻意配上的。
   */
  [
    '44-extensions-registries',
    "window.__t.click('.btn', '管理订阅源')",
    2000,
    {
      modals: exactly(1),
      modalTitle: exactly('管理订阅源'),
      sourceRows: exactly(2),
      sourceNames: equals('官方源', '私有源')
    }
  ],
  [
    '45-extensions-registries-closed',
    "window.__t.click('.modal-foot .btn', '取消')",
    900,
    { modals: exactly(0) }
  ],
  /*
   * 插件管理：列表顺序 = 持久化的 `plugin-order`，而 mock 里那一份**故意**与列表接口
   * 给的顺序不同 —— 所以这里的 equals 是「顺序真的按 entryPath 排过」的唯一判据。
   * 角标同时验两件事：版本号渲染出来了（不是兜底的「—」），以及 error 状态确实挂上了
   * 「运行异常」（那是前端按 status 推出来的，不是后端给的文案）。
   * extPinned=1 是常驻白名单那一份（行尾那块图钉的按下态）。
   */
  [
    '46-extensions-manage',
    "window.__t.click('.ext-sidebar .nav-item', '插件管理')",
    2200,
    {
      pageTitle: exactly('插件管理'),
      pageSubtitle: containsAll('3 个已安装', '1 个启用中'),
      extNames: equals('电台时光机', '歌词补全', '豆瓣标签'),
      extBadges: containsAll('v2.0.1', 'v1.2.0', 'v0.9.3', '运行异常'),
      extPinned: exactly(1)
    }
  ],
  /*
   * 点开某个扩展：宿主把它装进 `<webview>`（guest 是独立进程，与宿主不共享 DOM）。
   * 断言「挂上了 + 蒙层已经撤掉」表示页面真的加载完成 —— 只断言挂上会漏掉「一直转圈」
   * 那种坏法（蒙层留着、loader 转到底）。
   */
  [
    '47-extensions-plugin-page',
    "window.__t.click('.ext-sidebar .nav-item', '歌词补全')",
    3200,
    { pluginWebviews: exactly(1), pluginOverlays: equals() }
  ],
  // 标题栏左侧那颗 Songloft 的主点击 = 回原生面（不是回首页：离开时在哪一页就回哪一页）
  [
    '48-extensions-back',
    "window.__t.clickLabel('回到上次的页面')",
    1600,
    { surface: exactly('native') }
  ],

  // ── 播放 / 面板 ────────────────────────────────────────────────────────
  ['49-playing', "window.__t.click('.nav-item', '曲库')", 2400],
  // ⚠️ 双击歌曲行**只**开始播放，不会顺带打开右侧面板 —— 面板是显式的视图开关
  //    （控制栏的「歌词面板 / 播放队列」、左侧封面、Ctrl+L）。原先这里把歌词断言压在
  //    「双击」上，前提就不成立（那种写法跑出来 panel 恒为 0、歌词也恒为 0）。
  //    于是拆成两步：先确认真播上了，再显式打开面板看歌词。
  ['50-playing-dblclick', "window.__t.dbl('.song-row')", 1800, { playerTitle: hasSong }],
  // 打开歌词面板：面板关着时 togglePanel 会打开并落在「正在播放」——歌词就在这一页。
  // ★ 选择器必须限定 .playerbar：面板自己的页签按钮也叫「播放队列 / 正在播放」，
  //   不限定就会命中面板里那个（DOM 里 .panel 排在 .playerbar 之前），
  //   于是「再点一次收起面板」这类断言会点错元素而假失败。
  [
    '51-now-playing-panel',
    'window.__t.click(\'.playerbar button[aria-label="歌词面板"]\')',
    2600,
    { panel: exactly(1), lyricLines: exactly(10), lyricWords: atLeast(20) }
  ],
  // 面板开着但页签在「正在播放」→ 点队列按钮是**切页签**（不是收起）
  [
    '52-queue-panel',
    'window.__t.click(\'.playerbar button[aria-label="播放队列"]\')',
    1400,
    { panel: exactly(1), queueItems: atLeast(1) }
  ],
  // 控制栏的页签在「已激活」时再点一次 = 收起面板（不是什么都不做）
  [
    '53-panel-closed',
    'window.__t.click(\'.playerbar button[aria-label="播放队列"]\')',
    1400,
    { panel: exactly(0) }
  ],
  // ── 满窗播放 ───────────────────────────────────────────────────────────
  // 底栏那颗封面点一下 = 进满窗播放（大封面 + 歌曲信息 + 歌词 + 控制条盖住标题栏以下整块）。
  // ★ 四件事都要断言：这一层开了；它显示的曲目与底栏是**同一首**（读的是同一个 usePlayer，
  //   不是复制了一份状态）；它真的盖住了底栏那条（「满窗」这两个字的全部内容）；
  //   标题栏的底色跟着换了（透明 + 关掉毛玻璃 + 收掉分隔线）。
  // 歌词顺带数一遍 —— 上一步刚把面板收起，所以这 10 行只可能来自满窗这一层。
  [
    '54-fullplayer-open',
    'window.__t.click(\'.playerbar button[aria-label="满窗播放"]\')',
    2600,
    {
      fullPlayer: exactly(1),
      fullPlayerSameTrack: exactly(true),
      fullPlayerCoversBar: exactly(true),
      titlebarFollowsPlayer: exactly(true),
      lyricLines: exactly(10)
    }
  ],
  // Esc 收起。左上角还有一颗「收起满窗播放」，这里验的是全局键那一条 ——
  // 它在 App 的 keydown 里，键盘事件得从 window 派发才到得了。
  // 顺带断言标题栏**回到了原来那一份**：只验「满窗时透明」的话，写死成永远透明也能过。
  [
    '55-fullplayer-closed',
    "window.__t.key('Escape')",
    1400,
    { fullPlayer: exactly(0), titlebarGlass: exactly(true) }
  ],
  /*
   * ── 迷你播放器（一个**独立的窗口**，见 main/mini-window.ts）─────────────────
   * 底栏那颗按钮只开 / 关那个窗口；主窗口自始至终不缩、不重排、也不换界面 ——
   * 所以「点完之后主窗口里没有 .mini-player」与「按钮变成按下态」这两条要一起断言：
   * 只看前者的话，「按钮没接上」也能过。
   */
  [
    '56-mini-open',
    "window.__t.clickLabel('迷你播放器')",
    2600,
    { miniOpen: exactly('true'), miniPlayer: exactly(0) }
  ],
  /*
   * 下面这几步在**迷你窗那一页**里跑（另一个 target，见 STEPS 上面那段说明）。
   *
   * 这一步不带动作，只验条本身的形状 —— 点封面（这一条上唯一不点出动作的地方）。
   * 中栏**两行**（歌名 / 歌手 + 时间）、时间在第一行之下、控件五颗、右上角**只有关闭一颗**：
   * 这几条正是这一版重做过的外观，截图看不出「少了一行」或「多了一颗钮」。
   */
  [
    '57-mini-bar',
    "window.__t.click('.mini-cover')",
    600,
    {
      miniPlayer: exactly(1),
      miniPanel: exactly(0),
      miniInfo: countIs(2),
      /*
       * ★ 内容是关键：上一段（第 50 步双击歌曲行）刚把这首歌放起来，所以迷你窗此刻必须显示
       *   这一首的歌名、并显示「暂停」—— 主窗口在播、迷你窗却在「未在播放」/「播放」，
       *   就是本仓库踩过的那个缺陷（接线被严格模式的卸下拆掉、没装回来）。
       *   时间那一行同理：`--:--/--:--` 正是「快照没到」的样子，两个形状它都匹配不上。
       */
      miniTitle: hasSong,
      miniPlayLabel: exactly('暂停'),
      miniTime: matches(/^\d{1,2}:\d{2}\/\d{1,2}:\d{2}$/),
      miniControls: exactly(5),
      /*
       * 右上角两组：下拉（那份显示设置菜单的唯一入口：三根浓度滑块 + 歌词字号）+ 关闭。
       * 这类「少一颗 / 多一颗钮」正是截图看不出来的，而那颗下拉还兼着「封面右键收不到」之后
       * 的全部入口。★ 文案是逐字比对的，菜单内容变了它就该跟着改（下拉那颗叫「显示设置」而不是
       * 「不透明度」—— 菜单里有歌词字号，见 MiniPlayer.tsx 那颗钮上的说明）。
       */
      miniWinButtons: equals('显示设置', '关闭')
    },
    'mini'
  ],
  // 条下面能展开歌词 / 队列。歌词这一份与底栏、满窗播放共用同一个 LyricsView，
  // 所以那 10 行的断言在这里同样成立 —— 丢行的回归只该有一份，但三处都得罩住。
  [
    '58-mini-lyrics',
    'window.__t.clickLabel("歌词")',
    2000,
    { miniPanel: exactly(1), lyricLines: exactly(10) },
    'mini'
  ],
  [
    '59-mini-queue',
    'window.__t.clickLabel("播放队列")',
    1600,
    { miniPanel: exactly(1), miniQueue: exactly(1) },
    'mini'
  ],
  [
    '60-mini-close',
    "window.__t.clickLabel('关闭迷你播放器')",
    2000,
    { miniOpen: exactly(''), miniPlayer: exactly(0) }
  ],

  // 折叠成图标条后，图标与歌单封面必须仍然居中。带计数的项曾因 .nav-count 的
  // auto 外边距吃掉整行自由空间而整体左偏，且**只在折叠态**出现 —— 不断言就会静默复发。
  // 放在命令面板之前：面板的 Escape 绑在它自己的输入框上，从 window 派发关不掉，
  // 先折叠就不会让它盖在侧栏截图上。
  [
    '61-sidebar-collapsed',
    // 收起/展开那颗按钮压在侧栏右下角（`.sidebar-toggle`），没有可见文字 ——
    // 是个纯图标钮，只能按 aria-label 点它
    "window.__t.clickLabel('收起侧栏')",
    1600,
    { offCenter: atMost(1) }
  ],
  [
    '62-command-palette',
    "window.__t.key('k', { ctrlKey: true })",
    1400,
    {
      paletteItems: atLeast(1),
      // 三组都该在：歌曲（曲库里的）、歌单、命令。只数条目个数的话，
      // 「命令那一组整块没接上」与「本来条目就更少」分不开。
      /*
       * 四组都该在：歌单（本机那几份）、播放 / 导航 / 外观（命令按域分的组）。
       * ★ 空关键词下**不存在**「歌曲」那一组 —— 歌曲要打了关键词才会去搜，
       *   所以这里不能想当然地把它写进来（写进来就是一条永远红的断言）。
       */
      paletteGroups: containsAll('歌单', '播放', '导航', '外观')
    }
  ],
  // 关掉面板：Esc 绑在它**自己那个输入框**上（从 window 派发到不了那个处理器）
  [
    '63-palette-closed',
    "window.__t.keyOn('.palette-input', 'Escape')",
    900,
    { paletteItems: exactly(0) }
  ],
  // 把侧栏展开回来（上一步刚折叠）：后面要靠导航菜单走回设置页
  /*
   * 展开侧栏。判据是 .sidebar 上的 data-collapsed，**不是** offCenter：
   * 展开态本来就是「图标在左、文字在右」，图标中心离侧栏中心一百多像素是正常的
   * （折叠态才要求两者对齐）—— 拿 offCenter 断言展开会得到一条永远红的断言。
   */
  [
    '64-sidebar-expanded',
    "window.__t.clickLabel('展开侧栏')",
    1200,
    { sidebarCollapsed: exactly('false') }
  ],
  ['65-nav-menu-again', "window.__t.clickLabel('导航菜单')", 900],
  ['66-open-settings', "window.__t.click('.context-menu button', '设置')", 1600],
  [
    '67-settings-account-again',
    "window.__t.click('.settings-nav button', '账号')",
    2200,
    { settingText: containsAll('退出登录', '测试连接') }
  ],

  /*
   * ── 退出登录 → 登录页 → 重新登录 ───────────────────────────────────────
   * 这一段罩住三件事：
   *   · 退出前会先问一句（`confirmCalls` 记下了那句话，红的时候能直接看出问没问）；
   *   · 退出后整个界面换成登录页 —— 原生面的侧栏/播放条一起消失（所以断言 navs=0，
   *     它们若还留在 DOM 里，说明只是被盖住而不是真的退出了）；
   *   · 登录页对「连不上」与「登录成功」给出的是**两种不同**的结果 ——
   *     只断言「点了登录」的话，一个永远停在原地的失败也过得去。
   *
   * ★ window.confirm 是**原生阻塞对话框**：在 main() 里已经换成会记录的白洞
   *   （见 stubConfirm 的说明），否则 CDP 驱动器会一直等一个没人能点的按钮。
   */
  [
    '68-logout',
    "window.__t.click('.btn', '退出登录')",
    2200,
    {
      login: exactly(1),
      navs: exactly(0),
      confirmCalls: containsAll('退出登录')
    }
  ],
  ['69-login-account', "window.__t.type('#login-user', 'admin')", 900],
  ['70-login-password', "window.__t.type('#login-pass', 'admin')", 900],
  // 先给一个**连不上**的地址：这时该说的话是「连不上」，与「用户名或密码不正确」不是一句
  ['71-login-bad-url', "window.__t.type('#server-url', 'http://127.0.0.1:9')", 900],
  [
    '72-login-failed',
    "window.__t.submit('.login-form')",
    3000,
    { login: exactly(1), probeErrors: atLeast(1), probeText: containsAll('无法连接') }
  ],
  ['73-login-good-url', "window.__t.type('#server-url', 'http://127.0.0.1:58091')", 900],
  [
    '74-login-success',
    "window.__t.submit('.login-form')",
    4000,
    { login: exactly(0), navs: atLeast(5), surface: exactly('native') }
  ],

  /*
   * ── 曲库页的两半：本地 / 服务器 ─────────────────────────────────────────
   * 侧栏只有一个「曲库」入口（原先是「曲库 + 本地文件」两颗钮），看哪一半由页头那颗分段
   * 切换决定（见 components/LibraryHeader）。放在这一段（刚重新登录）：界面刚重挂过，
   * 曲库是未筛选的基线，三档行数都能钉死。
   *
   * ★ 第 76 步与第 78 步是**成对**的：先在「服务器」那一半筛成 2 首 → 切去「本地」→ 再切回来
   *   还得是那 2 首。两半各占一个页面槽（见 App 的 PAGE_SLOTS）；若把它们做成同一个实例里换
   *   渲染分支，这一趟回来会变回 43 首 —— 而那正是「换个来源看看」时最不该丢掉的东西。
   */
  ['75-library-server-half', "window.__t.click('.nav-item', '曲库')", 2200, { rows: exactly(43) }],
  [
    '76-library-type-remote',
    "window.__t.click('.segmented[aria-label=\"歌曲类型\"] button', '网络')",
    2000,
    { rows: exactly(2), viewSwitches: exactly(2) }
  ],
  [
    '77-library-local-half',
    "window.__t.click('.segmented[aria-label=\"曲库来源\"] button', '本地')",
    1800,
    {
      // 同一页（大标题不变），但内容换成了本机那批文件 —— 这一趟巡检一个文件也没挑过，
      // 所以这里必须是空态：不是「43 首曲库的歌」混进来，也不是一片白
      pageTitle: exactly('曲库'),
      rows: exactly(0),
      emptyText: containsAll('还没有打开过本地文件'),
      // 「本地」那一半没有第二种看法可切：那一对钮连同摆着它们的库槽一起消失
      viewSwitches: exactly(0)
    }
  ],
  [
    '78-library-server-back',
    "window.__t.click('.segmented[aria-label=\"曲库来源\"] button', '服务器')",
    2200,
    { rows: exactly(2), folderRows: exactly(0), viewSwitches: exactly(2) }
  ],

  /*
   * ── 当前曲自动定位到列表中间 ─────────────────────────────────────────
   * 这是纯视觉行为，截图里看不出对错（偏了半屏的截图看着也很正常），只能量：
   * 当前那一行的**中心**与滚动容器中心的距离。所以多了两个口径（见 counts 里的
   * currentRowIndex / currentRowOffset）。
   *
   * ★ 必须点**靠后**的一行：点第 0 行的话「居中」被夹到 0，与「贴在顶上」是同一个位置，
   *   断言恒真。这里取第 27 行（共 43 行）—— 它下方还留着十几行，所以也不会被底部夹取
   *   顶掉（那同样是「贴着底」而不是「居中」）。
   * ★ 后三步是**成对**的：先把当前曲滚出中间，再切走、切回来。切回来时这一页不会重新
   *   挂载（页面槽常驻，见 App 的 NativePages），所以要靠「我活跃了」重新算一次才回得到
   *   中间 —— 少了这个口径，「定位只在挂载时跑一次」也照样绿。
   */
  [
    '79-library-all-again',
    "window.__t.click('.segmented[aria-label=\"歌曲类型\"] button', '全部')",
    2200,
    { rows: exactly(43) }
  ],
  [
    '80-locate-deep-row',
    'window.__t.dblNth(".song-row", 26)',
    2200,
    {
      // 点的是第 27 行、当前行也是第 27 行：定位到邻行的话这一条立刻红
      currentRowIndex: exactly(26),
      currentRowOffset: atMost(4),
      playerTitle: hasSong
    }
  ],
  /*
   * 队列抽屉是另一套落点规则（只保证「看得见」，不居中），而且它**没有**被上面那套
   * 「行中心 = 容器中心」覆盖 —— 实测在这里踩过：位置算法把「相对滚动原点的距离」和
   * 「从当前位置还要滚多少」加在一起，`scrollTop` 被多算一遍，目标越过可滚底部后引擎夹到最底，
   * 当前项落在视口上方四千像素处：高亮还在，人看不见。队列此刻 43 项、当前项在第 27 项，
   * 它一定在折线以下，所以这一步真的会走「往下滚」那条分支。
   */
  [
    '81-queue-locate',
    'window.__t.click(\'.playerbar button[aria-label="播放队列"]\')',
    2000,
    { panel: exactly(1), queueItems: exactly(43), queueCurrentInView: exactly(true) }
  ],
  // 收起抽屉，免得后面三步的截图里多挂一块面板
  [
    '82-queue-close',
    'window.__t.click(\'.playerbar button[aria-label="播放队列"]\')',
    1400,
    { panel: exactly(0) }
  ],
  // 滚回顶部：当前行此刻离中间很远，于是下一步「切走再切回来」的断言不可能白拿
  ['83-locate-scrolled-away', 'window.__t.scrollPageTop()', 900, { currentRowOffset: atLeast(50) }],
  [
    '84-locate-leave',
    "window.__t.click('.nav-item', '最近播放')",
    2000,
    { pageTitle: exactly('最近播放') }
  ],
  [
    '85-locate-back',
    "window.__t.click('.nav-item', '曲库')",
    2400,
    { pageTitle: exactly('曲库'), currentRowIndex: exactly(26), currentRowOffset: atMost(4) }
  ]
]

async function main() {
  const { mkdirSync } = await import('node:fs')
  mkdirSync(OUT, { recursive: true })

  const page = await findPage()
  console.log(`[drive] 已连接 ${page.url}`)

  const ws = await openSocket(page.webSocketDebuggerUrl)
  const session = new Session(ws)
  await session.send('Page.enable')
  await session.send('Runtime.enable')

  /*
   * 等启动编排跑完（设置 → 会话校验 → 定落点），最多 20 秒。
   *
   * ★ 判据是**侧栏在不在**，不是 `.shell` 在不在：`.shell` 在启动中就挂着，
   *   那会儿里面还是启动占位（主界面要等编排走完才挂，见 App 的 `booted`）—— 早先只等
   *   `.shell` 的话，第一步「点侧栏首页」会撞在还没渲染出侧栏的那一帧上（断言表现成
   *   `NOT_FOUND:.nav-item/首页`，而紧接着的截图里侧栏明明在）。这是**偶发**的：
   *   跑十次红一次那种。
   */
  for (let i = 0; i < 40; i += 1) {
    if (await session.evaluate("!!document.querySelector('.nav-item')")) break
    await sleep(500)
  }

  await session.evaluate(HELPERS)
  // 退出登录那一步会弹 window.confirm（原生阻塞对话框），先换成会记录的白洞
  await session.evaluate('window.__t.stubConfirm()')
  console.log('[drive] 启动时 DOM:', JSON.stringify(await session.evaluate('window.__t.counts()')))

  /*
   * 迷你窗那一页的会话。★ **按需连**，不在启动时就找它：它是底栏那颗按钮点下去才出现的
   * 第二个窗口（另一个渲染进程），启动那一刻这个 target 根本不存在。
   * 连上之后把同一份 HELPERS 注进那一页 —— 否则那边没有 window.__t，步骤只能靠裸表达式写。
   */
  let miniSession = null
  const sessionFor = async (onPage) => {
    if (onPage !== 'mini') return session
    if (!miniSession) {
      const target = await findPage('#mini')
      const socket = await openSocket(target.webSocketDebuggerUrl)
      miniSession = new Session(socket)
      await miniSession.send('Page.enable')
      await miniSession.send('Runtime.enable')
      await miniSession.evaluate(HELPERS)
      await miniSession.evaluate('window.__t.stubConfirm()')
      console.log(`[drive] 已连接迷你窗 ${target.url}`)
    }
    return miniSession
  }

  let failures = 0
  for (const [name, expr, wait, expect, onPage] of STEPS) {
    const active = await sessionFor(onPage)
    let clicked
    try {
      clicked = await active.evaluate(expr)
    } catch (error) {
      clicked = `ERR ${error.message}`
    }
    const bytes = await active.shot(name, wait ?? 1000)
    const stats = await active.evaluate('window.__t.counts()')

    let verdict = ''
    if (expect) {
      const bad = Object.entries(expect).filter(([key, want]) => !want(stats[key]))
      if (bad.length === 0) {
        verdict = ` expect=✓(${Object.entries(expect)
          .map(([k, w]) => `${k}${w.label ?? ''}`)
          .join(' ')})`
      } else {
        failures += 1
        verdict = ` ⛔ EXPECT_FAIL ${bad
          .map(([k, w]) => `${k} 期望 ${w.label ?? '断言'} 实际 ${JSON.stringify(stats[k])}`)
          .join('; ')}`
      }
    }

    console.log(
      `  ${clicked === 'OK' ? '✓' : '!'} ${name}.png (${bytes}B) click=${clicked} dom=${JSON.stringify(stats)}${verdict}`
    )
  }

  ws.close()
  /* 迷你窗那一页若连过，也得断掉 —— 否则进程会挂在那个 socket 上不退出 */
  miniSession?.ws.close()

  if (failures > 0) {
    console.error(`[drive] ${failures} 个界面的期望值未满足`)
    process.exit(1)
  }
  console.log('[drive] 全部界面巡检通过')
}

main().catch((error) => {
  console.error('[drive] 失败:', error.message)
  process.exit(1)
})
