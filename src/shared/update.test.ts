/**
 * 「本机该下哪一份安装包」的单测。
 *
 * 三种错法都得在这里被挡住，因为它们在界面上一律表现为「下载并安装成功」：
 *   * 拿免安装 zip / macOS 的 zip 当安装包（那不是给人点的）；
 *   * 拿别的架构的包（装完打不开，甚至装不上）；
 *   * 一份都挑不出来却硬塞一个（宁可说「这次的发布里没有」，也别装错）。
 */

import { describe, expect, it } from 'vitest'

import { pickUpdateAsset, isPendingUpdateUsable, type ClientUpdateAsset } from './update'

function asset(name: string): ClientUpdateAsset {
  return { name, size: 1024, url: `https://github.com/o/r/releases/download/v1.3.3/${name}` }
}

const RELEASE = [
  asset('Songloft-Desktop-1.3.3-windows-x64.exe'),
  asset('Songloft-Desktop-1.3.3-windows-x64.zip'),
  asset('Songloft-Desktop-1.3.3-linux-x64.AppImage'),
  asset('Songloft-Desktop-1.3.3-linux-x64.deb'),
  asset('Songloft-Desktop-1.3.3-linux-x64.tar.gz'),
  asset('Songloft-Desktop-1.3.3-macos-arm64.dmg'),
  asset('Songloft-Desktop-1.3.3-macos-x64.dmg'),
  asset('Songloft-Desktop-1.3.3-macos-arm64.zip'),
  asset('Songloft-Desktop-1.3.3-macos-x64.zip')
]

describe('pickUpdateAsset', () => {
  it('Windows 挑 NSIS 安装包，不挑免安装 zip', () => {
    expect(
      pickUpdateAsset(RELEASE, { platform: 'win32', arch: 'x64', appImage: false })?.name
    ).toBe('Songloft-Desktop-1.3.3-windows-x64.exe')
  })

  it('macOS 按架构挑 dmg，不挑 zip', () => {
    expect(
      pickUpdateAsset(RELEASE, { platform: 'darwin', arch: 'arm64', appImage: false })?.name
    ).toBe('Songloft-Desktop-1.3.3-macos-arm64.dmg')
    expect(
      pickUpdateAsset(RELEASE, { platform: 'darwin', arch: 'x64', appImage: false })?.name
    ).toBe('Songloft-Desktop-1.3.3-macos-x64.dmg')
  })

  it('Linux 以 AppImage 运行时挑 AppImage，否则挑 deb；tar.gz 一律不挑', () => {
    expect(pickUpdateAsset(RELEASE, { platform: 'linux', arch: 'x64', appImage: true })?.name).toBe(
      'Songloft-Desktop-1.3.3-linux-x64.AppImage'
    )
    expect(
      pickUpdateAsset(RELEASE, { platform: 'linux', arch: 'x64', appImage: false })?.name
    ).toBe('Songloft-Desktop-1.3.3-linux-x64.deb')
    const tarOnly = [asset('Songloft-Desktop-1.3.3-linux-x64.tar.gz')]
    expect(pickUpdateAsset(tarOnly, { platform: 'linux', arch: 'x64', appImage: false })).toBeNull()
  })

  it('多架构候选里按本机架构挑，不跨架构兜底', () => {
    const both = [
      asset('Songloft-Desktop-1.3.3-macos-arm64.dmg'),
      asset('Songloft-Desktop-1.3.3-macos-x64.dmg')
    ]
    expect(
      pickUpdateAsset(both, { platform: 'darwin', arch: 'arm64', appImage: false })?.name
    ).toBe('Songloft-Desktop-1.3.3-macos-arm64.dmg')
    // 本机是 arm64 而 release 里只有 x64：宁可不挑，也不装错
    const x64Only = [asset('Songloft-Desktop-1.3.3-macos-x64.dmg')]
    expect(
      pickUpdateAsset(x64Only, { platform: 'darwin', arch: 'arm64', appImage: false })
    ).toBeNull()
  })

  it('名字里没写架构时照样收：命名式微调不至于让整条更新链路失效', () => {
    const renamed = [asset('Songloft-Desktop-1.3.3-windows.exe')]
    expect(
      pickUpdateAsset(renamed, { platform: 'win32', arch: 'x64', appImage: false })?.name
    ).toBe('Songloft-Desktop-1.3.3-windows.exe')
  })

  it('amd64 与 x64 是同一个架构（兼容别处生成的产物名）', () => {
    const renamed = [asset('Songloft-Desktop-1.3.3-windows-amd64.exe')]
    expect(
      pickUpdateAsset(renamed, { platform: 'win32', arch: 'x64', appImage: false })?.name
    ).toBe('Songloft-Desktop-1.3.3-windows-amd64.exe')
  })

  it('不认识的平台返回 null（别把某个平台的包塞给别的平台）', () => {
    expect(
      pickUpdateAsset(RELEASE, { platform: 'freebsd', arch: 'x64', appImage: false })
    ).toBeNull()
  })
})

describe('isPendingUpdateUsable', () => {
  const host = { platform: 'win32', arch: 'x64', appImage: false }
  const pending = {
    path: 'C:\\Users\\me\\Downloads\\Songloft-Desktop-1.3.3-windows-x64.exe',
    version: 'v1.3.3',
    name: 'Songloft-Desktop-1.3.3-windows-x64.exe',
    size: 1024,
    downloadedAt: 1
  }

  it('版本更新、扩展名可装、大小一致时可用', () => {
    expect(isPendingUpdateUsable(pending, host, '1.2.0', 1024)).toBe(true)
  })

  it('目标版本不新（已装或更旧）就不用再提示', () => {
    expect(isPendingUpdateUsable(pending, host, '1.3.3', 1024)).toBe(false)
    expect(isPendingUpdateUsable(pending, host, '1.4.0', 1024)).toBe(false)
  })

  it('文件大小对不上就不碰它（被删、被截断、被换掉）', () => {
    expect(isPendingUpdateUsable(pending, host, '1.2.0', 1023)).toBe(false)
    expect(isPendingUpdateUsable(pending, host, '1.2.0', 0)).toBe(false)
  })

  it('扩展名必须是本机能装的那种', () => {
    const zip = { ...pending, name: 'Songloft-Desktop-1.3.3-windows-x64.zip' }
    expect(isPendingUpdateUsable(zip, host, '1.2.0', 1024)).toBe(false)

    // Linux 以 deb 运行时，AppImage 不是本机该装的那一种
    const appImage = { ...pending, name: 'Songloft-Desktop-1.3.3-linux-x64.AppImage' }
    expect(
      isPendingUpdateUsable(
        appImage,
        { platform: 'linux', arch: 'x64', appImage: false },
        '1.2.0',
        1024
      )
    ).toBe(false)
    expect(
      isPendingUpdateUsable(
        appImage,
        { platform: 'linux', arch: 'x64', appImage: true },
        '1.2.0',
        1024
      )
    ).toBe(true)
  })
})
