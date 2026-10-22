/**
 * 「投送到音箱」对话框（底栏那颗投送钮点出来）。
 *
 * 三件事：把当前这一首交给某一台音箱、切回**本机播放**、以及让「声音现在从哪儿出」一眼可见。
 *
 * ★ **底栏那颗钮永远是「打开这个框」**，不随激活状态改行为。早先是「没在投送 = 选设备 /
 *   正在投送 = 直接取消」，那让「换一台音箱」变成两步（先取消、再打开），而且「取消」这种
 *   有副作用的动作藏在一颗状态会变的钮上。现在切换出口一律在这个框里点 ——
 *   用户在按下去之前就能看到自己会切到哪儿。
 *
 * ★ **当前出口只有一个表达方式：设备列表里被置顶且高亮的那一行**（没在投送时则是「本机播放」
 *   那一行）。别再加「已选为输出」之类的横幅 / 副标题去说同一件事 —— 两处一起说，用户反而
 *   要花时间判断它们是不是在讲两件事。
 *
 * ★ 设备列表由**本机**发现（主进程发 SSDP 组播，见 main/dlna.ts），所以这里显示的是
 *   「这台机器能看到哪些音箱」。空列表最常见的原因是「音箱和电脑不在一个网段」
 *   （或者被防火墙拦了组播），空态文案直接把这两句说出来 —— 比只写「没有找到设备」有用。
 */

import { useMemo } from 'react'

import { IconCast, IconMonitor } from './Icons'
import { Modal } from './Modal'
import { EmptyState } from './primitives'
import { useDlna } from '@/state/dlna'

/** 列表里每一行（本机 / 每台设备）共用的排版：两行字 + 右侧的当前出口标记 */
const ROW_STYLE: React.CSSProperties = { height: 52, padding: '0 6px' }

export function DlnaDialog(): React.JSX.Element | null {
  const open = useDlna((s) => s.dialogOpen)
  const devices = useDlna((s) => s.devices)
  const discovering = useDlna((s) => s.discovering)
  const busy = useDlna((s) => s.busy)
  const error = useDlna((s) => s.error)
  const casting = useDlna((s) => s.casting)
  const activeDevice = useDlna((s) => s.activeDevice)
  /** 真正投放出去过没有（false = 只选了设备，用户还没按播放） */
  const started = useDlna((s) => s.status?.active === true)
  const close = useDlna((s) => s.closeDialog)
  const refresh = useDlna((s) => s.loadDevices)
  const castTo = useDlna((s) => s.castTo)
  const disconnect = useDlna((s) => s.disconnect)

  /**
   * 当前出口**置顶**：投送中那台设备排到设备列表的最前面。
   *
   * ★ 「声音现在从哪儿出」只由这一行的位置 + 高亮表达，别处不再挂一条提示 ——
   *   重新打开这个框时，扫一眼第一行就知道声音在谁那儿。
   */
  const ordered = useMemo(() => {
    if (!casting || !activeDevice) return devices
    const index = devices.findIndex((item) => item.id === activeDevice.id)
    if (index === 0) return devices
    // 列表里没有它（刚重新搜索过 / 这台刚从网上掉了）：把手头这个对象补到最前面，
    // 免得「正在投送」的那一台在列表里凭空消失
    if (index < 0) return [activeDevice, ...devices]
    return [devices[index], ...devices.slice(0, index), ...devices.slice(index + 1)]
  }, [casting, activeDevice, devices])

  if (!open) return null

  /**
   * 切回本机播放。
   *
   * 先关框再交接：`disconnect` 会把底栏、音量、进度一次性复位（见 state/dlna 的 endCasting），
   * 而对话框里那些「正在由音箱播放」的字此刻已经全部作废，留在屏幕上看它一路变过去没有意义。
   */
  const playOnLocal = (): void => {
    close()
    if (casting) void disconnect()
  }

  return (
    <Modal
      title="投送到音箱"
      onClose={close}
      footer={
        <>
          <button
            type="button"
            className="btn"
            disabled={discovering || busy}
            onClick={() => void refresh(true)}
          >
            {discovering ? '正在搜索…' : '重新搜索'}
          </button>
          {/*
            关闭这颗钮与标题栏那颗 ✕ 是同一个动作 —— 留着是因为框里可能只剩「重新搜索」
            这一颗按钮，而「选完了、什么都不改」这件事不该只能靠找 ✕ 或按 Esc 才能表达。
          */}
          <button type="button" className="btn" onClick={close}>
            关闭
          </button>
        </>
      }
    >
      {/*
        ★ 这一块**定高**（见 components.css 的 .dlna-body）：搜索前是空态、搜索后是设备列表，
          两种状态的高度必须一样 —— 否则「正在搜索局域网…」跳成几台设备时对话框会突然缩一截，
          底下的「重新搜索」跟着往上跳，指针底下当场换了个东西。
          设备多了在列表里自己滚（.dlna-list），上面那几行（错误 / 本机播放）
          占掉的高度就从列表里扣，对话框本身不长个儿。
      */}
      <div className="dlna-body">
        {/*
          有设备列表时才把错误单独摆一行（比如「投送失败」）：列表为空时错误就在空态里说，
          否则会出现「红字：404 接口不存在」+「标题：没有找到可投送的音箱」这种自相矛盾的两条。
        */}
        {error && ordered.length > 0 ? (
          <div className="field-hint" style={{ color: 'var(--danger)' }} role="alert">
            {error}
          </div>
        ) : null}

        {/*
          ★ 投送中**不再单独摆一块「当前设备」**：那块东西说的就是「已选为输出 / 正在由音箱播放」，
            而同一句话现在落在那台设备自己的行上（它还被置顶了），两块并排只是重复。
            于是打开这个框只有一件事要看 —— 列表最上面那一行就是当前出口。
        */}
        {/*
          ★ 本机播放**不进可滚动的设备列表**，原因有两个：
            1. 它是那个「什么音箱都没搜到」时唯一还能选的一项，跟着列表一起被滚走没有道理；
            2. 空态（.dlna-list .empty）按「撑满整个列表」排版，前面多一行会顶出一条多余滚动条。
          ★ 它的文案**不随投送状态变**：投送中它既不亮也不加「点一下切回本机」之类的提示 ——
            「现在声音在谁那儿」由设备列表第一行表达，这里再说一遍只会让两处抢同一件事。
        */}
        <button
          type="button"
          className="palette-item"
          data-active={!casting}
          style={ROW_STYLE}
          onClick={playOnLocal}
        >
          <span
            style={{
              display: 'flex',
              color: casting ? 'var(--text-3)' : 'var(--accent)',
              marginRight: 10
            }}
          >
            <IconMonitor size={20} />
          </span>
          <div style={{ minWidth: 0, flex: 1, textAlign: 'left' }}>
            <div className="truncate" style={{ fontSize: 13.5 }}>
              本机播放
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--text-4)' }}>这台电脑的声音输出</div>
          </div>
          {casting ? null : (
            <span style={{ fontSize: 11.5, color: 'var(--accent)' }}>当前输出</span>
          )}
        </button>

        {/* 上面是本机、下面是局域网里找到的音箱：一条细线，两半各是各的 */}
        <div className="divider" style={{ margin: 0 }} />

        <div className="dlna-list">
          {ordered.length === 0 ? (
            <EmptyState
              icon={<IconCast size={24} />}
              title={
                error ? '拿不到设备列表' : discovering ? '正在搜索局域网…' : '没有找到可投送的音箱'
              }
              description={
                error ??
                (discovering
                  ? '一轮 SSDP 大约 3 秒'
                  : '确认音箱已开机、与这台电脑在同一网段（发现是在本机做的，不是服务器）')
              }
            />
          ) : (
            ordered.map((device) => {
              const current = casting && activeDevice?.id === device.id
              /*
               * 当前出口那一行的副标题换成**状态**（它已经置顶且高亮，型号与 IP 此刻没人要看）：
               * 选中设备**不会**自动播放（这类设备收到地址就自己响、客户端按不住），
               * 所以「还得按一下播放」必须说出来，否则用户会以为投送失败了。
               * 其余行仍是「型号 · IP」—— 两台同名音箱（「客厅音箱」）靠 IP 才分得清。
               */
              const subtitle = current
                ? started
                  ? '正在由音箱播放（本机已静音）'
                  : '已选为输出，按播放键才开始投放'
                : [device.model, device.host].filter(Boolean).join(' · ') || 'DLNA 渲染器'
              return (
                <button
                  key={device.id}
                  type="button"
                  className="palette-item"
                  /*
                   * 已经是当前出口的那台：点它没有意义（会重新把这一首推过去，位置不变但在放
                   * 的那一首会被打断重开一次），所以只关框。换设备走另一行。
                   */
                  disabled={busy}
                  data-active={current}
                  style={ROW_STYLE}
                  onClick={() => {
                    if (current) {
                      close()
                      return
                    }
                    void castTo(device)
                  }}
                >
                  <span
                    style={{
                      display: 'flex',
                      color: current ? 'var(--accent)' : 'var(--text-3)',
                      marginRight: 10
                    }}
                  >
                    <IconCast size={20} />
                  </span>
                  <div style={{ minWidth: 0, flex: 1, textAlign: 'left' }}>
                    <div className="truncate" style={{ fontSize: 13.5 }}>
                      {device.name}
                    </div>
                    <div style={{ fontSize: 11.5, color: 'var(--text-4)' }}>{subtitle}</div>
                  </div>
                  {current ? (
                    <span style={{ fontSize: 11.5, color: 'var(--accent)' }}>当前输出</span>
                  ) : null}
                </button>
              )
            })
          )}
        </div>
      </div>
    </Modal>
  )
}
