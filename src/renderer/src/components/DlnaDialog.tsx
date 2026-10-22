/**
 * 「投送到音箱」对话框（底栏那颗投送钮点出来）。
 *
 * 只做两件事：选一台设备开投、以及投送中时把当前设备与「取消」摆出来。
 *
 * ★ 设备列表由**本机**发现（主进程发 SSDP 组播，见 main/dlna.ts），所以这里显示的是
 *   「这台机器能看到哪些音箱」。空列表最常见的原因是「音箱和电脑不在一个网段」
 *   （或者被防火墙拦了组播），空态文案直接把这两句说出来 —— 比只写「没有找到设备」有用。
 */

import { IconCast } from './Icons'
import { Modal } from './Modal'
import { EmptyState } from './primitives'
import { useDlna } from '@/state/dlna'

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

  if (!open) return null

  return (
    <Modal
      title="投送到音箱 (DLNA)"
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
          {casting ? (
            <button
              type="button"
              className="btn"
              data-variant="primary"
              onClick={() => void disconnect()}
            >
              取消投送
            </button>
          ) : null}
        </>
      }
    >
      {/*
        ★ 这一块**定高**（见 components.css 的 .dlna-body）：搜索前是空态、搜索后是设备列表，
          两种状态的高度必须一样 —— 否则「正在搜索局域网…」跳成几台设备时对话框会突然缩一截，
          底下的「重新搜索」跟着往上跳，指针底下当场换了个东西。
          设备多了在列表里自己滚（.dlna-list），上面那几行（错误 / 当前设备）占掉的高度
          就从列表里扣，对话框本身不长个儿。
      */}
      <div className="dlna-body">
        {/*
          有设备列表时才把错误单独摆一行（比如「投送失败」）：列表为空时错误就在空态里说，
          否则会出现「红字：404 接口不存在」+「标题：没有找到可投送的音箱」这种自相矛盾的两条。
        */}
        {error && devices.length > 0 ? (
          <div className="field-hint" style={{ color: 'var(--danger)' }} role="alert">
            {error}
          </div>
        ) : null}

        {casting && activeDevice ? (
          <div style={{ padding: '4px 0 8px' }}>
            <div className="row" style={{ gap: 10, alignItems: 'center' }}>
              <span style={{ color: 'var(--accent)', display: 'flex' }}>
                <IconCast size={20} />
              </span>
              <div style={{ minWidth: 0 }}>
                <div className="truncate" style={{ fontSize: 13.5 }}>
                  {activeDevice.name}
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--text-4)' }}>
                  {started
                    ? '正在由音箱播放（本机已静音）'
                    : /*
                       * 选中设备**不会**自动播放（这类设备收到地址就自己响，按不住），
                       * 所以这里必须把「还得按一下播放」说出来，不然用户会以为投送失败了。
                       */
                      '已选为输出，按播放键才开始投放'}
                </div>
              </div>
            </div>
          </div>
        ) : null}

        <div className="dlna-list">
          {devices.length === 0 ? (
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
            devices.map((device) => {
              const current = casting && activeDevice?.id === device.id
              return (
                <button
                  key={device.id}
                  type="button"
                  className="palette-item"
                  disabled={busy}
                  data-active={current}
                  style={{ height: 52, padding: '0 6px' }}
                  onClick={() => void castTo(device)}
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
                    <div style={{ fontSize: 11.5, color: 'var(--text-4)' }}>
                      {/* 型号 + IP：两台同名音箱（「客厅音箱」）靠 IP 才分得清 */}
                      {[device.model, device.host].filter(Boolean).join(' · ') || 'DLNA 渲染器'}
                    </div>
                  </div>
                  {current ? (
                    <span style={{ fontSize: 11.5, color: 'var(--accent)' }}>正在播放</span>
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
