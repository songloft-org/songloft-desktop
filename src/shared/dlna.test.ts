import { describe, expect, it } from 'vitest'

import {
  absoluteUrl,
  buildDidl,
  buildSearchRequest,
  escapeXml,
  findService,
  formatSecondsToHms,
  isBackendLocalFile,
  isVirtualInterface,
  mimeForFormat,
  parseDescription,
  parseSoapValue,
  parseSsdpResponse,
  parseTimeToSeconds,
  prefetchUrl,
  rewriteToLan
} from './dlna'

/*
 * 这些解析器面对的是**别家固件**写出来的文本：头大小写混着来、XML 带命名空间与换行、
 * 时间格式五花八门。所以用例里刻意写的是实录样本（小爱音箱 / GUPnP）而不是理想格式。
 */

describe('parseSsdpResponse', () => {
  it('解析一条标准的 200 应答', () => {
    const raw = [
      'HTTP/1.1 200 OK',
      'CACHE-CONTROL: max-age=1800',
      'LOCATION: http://192.168.23.110:9999/desc.xml',
      'ST: urn:schemas-upnp-org:device:MediaRenderer:1',
      'USN: uuid:e670f3d8::urn:schemas-upnp-org:device:MediaRenderer:1',
      'SERVER: Linux/3.10 UPnP/1.0 GUPnP/1.0.2',
      '',
      ''
    ].join('\r\n')

    const parsed = parseSsdpResponse(raw)
    expect(parsed?.location).toBe('http://192.168.23.110:9999/desc.xml')
    expect(parsed?.server).toContain('GUPnP')
    expect(parsed?.usn).toContain('uuid:e670f3d8')
  })

  it('头名大小写混着来也认', () => {
    const raw = 'HTTP/1.1 200 OK\r\nLocation: http://a/1.xml\r\n\r\n'
    expect(parseSsdpResponse(raw)?.location).toBe('http://a/1.xml')
  })

  it('非 200（NOTIFY 之类）丢掉', () => {
    expect(parseSsdpResponse('NOTIFY * HTTP/1.1\r\nLOCATION: http://a/1.xml\r\n')).toBeNull()
  })

  it('没有 LOCATION 的丢掉 —— 后面什么都做不了', () => {
    expect(parseSsdpResponse('HTTP/1.1 200 OK\r\nST: ssdp:all\r\n')).toBeNull()
  })
})

describe('parseDescription', () => {
  const xml = `<?xml version="1.0"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
  <device>
    <deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType>
    <friendlyName>小爱音箱-7479</friendlyName>
    <manufacturer>Xiaomi</manufacturer>
    <modelName>LX06</modelName>
    <UDN>uuid:e670f3d8-d904-4042-beec-70d4b2891a1c</UDN>
    <serviceList>
      <service>
        <serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType>
        <serviceId>urn:upnp-org:serviceId:AVTransport</serviceId>
        <controlURL>/upnp/control/AVTransport1</controlURL>
        <eventSubURL>/upnp/event/AVTransport1</eventSubURL>
      </service>
      <service>
        <serviceType>urn:schemas-upnp-org:service:RenderingControl:1</serviceType>
        <serviceId>urn:upnp-org:serviceId:RenderingControl</serviceId>
        <controlURL>/upnp/control/RenderingControl1</controlURL>
      </service>
    </serviceList>
  </device>
</root>`

  it('取出名字、型号与两个服务', () => {
    const parsed = parseDescription(xml)
    expect(parsed.friendlyName).toBe('小爱音箱-7479')
    expect(parsed.modelName).toBe('LX06')
    expect(parsed.udn).toContain('uuid:')
    expect(parsed.services).toHaveLength(2)
    expect(findService(parsed.services, 'AVTransport')?.controlUrl).toBe(
      '/upnp/control/AVTransport1'
    )
    expect(findService(parsed.services, 'RenderingControl')?.controlUrl).toBe(
      '/upnp/control/RenderingControl1'
    )
  })

  it('没有 AVTransport 的设备返回 null（不能投送）', () => {
    const parsed = parseDescription('<device><friendlyName>路由</friendlyName></device>')
    expect(findService(parsed.services, 'AVTransport')).toBeNull()
  })

  it('少 controlURL 的服务块跳过，不产生半条记录', () => {
    const parsed = parseDescription(
      '<service><serviceType>urn:x:service:AVTransport:1</serviceType></service>'
    )
    expect(parsed.services).toHaveLength(0)
  })
})

describe('absoluteUrl', () => {
  it('相对路径按 LOCATION 拼', () => {
    expect(absoluteUrl('http://192.168.23.110:9999/desc.xml', '/upnp/control/AVTransport1')).toBe(
      'http://192.168.23.110:9999/upnp/control/AVTransport1'
    )
  })

  it('已经是绝对地址就原样返回', () => {
    expect(absoluteUrl('http://a/desc.xml', 'http://b/ctl')).toBe('http://b/ctl')
  })
})

describe('DIDL 与 MIME', () => {
  it('标题里的特殊字符要转义，否则设备解析不出 XML', () => {
    const didl = buildDidl('A & B <live>', 'http://h/a.mp3?x=1&y=2', 'audio/mpeg')
    expect(didl).toContain('<dc:title>A &amp; B &lt;live&gt;</dc:title>')
    expect(didl).toContain('http://h/a.mp3?x=1&amp;y=2')
    expect(didl).toContain('protocolInfo="http-get:*:audio/mpeg:*"')
  })

  it('格式 → MIME：认不出来的按 mp3（转码后的地址本来就是 mp3）', () => {
    expect(mimeForFormat('flac')).toBe('audio/flac')
    expect(mimeForFormat('wav')).toBe('audio/wav')
    expect(mimeForFormat('m4a')).toBe('audio/mp4')
    expect(mimeForFormat('ape')).toBe('audio/mpeg')
    expect(mimeForFormat(undefined)).toBe('audio/mpeg')
  })

  it('escapeXml 连引号一起转（属性里要用）', () => {
    expect(escapeXml(`a"b'c`)).toBe('a&quot;b&apos;c')
  })
})

describe('时间', () => {
  it('H:MM:SS / 带毫秒的都认', () => {
    expect(parseTimeToSeconds('00:03:45')).toBe(225)
    expect(parseTimeToSeconds('0:00:03.120')).toBeCloseTo(3.12)
    expect(parseTimeToSeconds('03:45')).toBe(225)
    expect(parseTimeToSeconds('')).toBe(0)
    expect(parseTimeToSeconds('NOT_IMPLEMENTED')).toBe(0)
  })

  it('秒 → H:MM:SS 补零', () => {
    expect(formatSecondsToHms(225)).toBe('00:03:45')
    expect(formatSecondsToHms(0)).toBe('00:00:00')
    expect(formatSecondsToHms(-5)).toBe('00:00:00')
  })
})

describe('isVirtualInterface', () => {
  it('排除容器与虚拟网桥（本机常年挂着它们）', () => {
    expect(isVirtualInterface('docker0')).toBe(true)
    expect(isVirtualInterface('br-2f1a')).toBe(true)
    expect(isVirtualInterface('vboxnet0')).toBe(true)
    expect(isVirtualInterface('virbr0')).toBe(true)
    expect(isVirtualInterface('lo')).toBe(true)
    expect(isVirtualInterface('tun0')).toBe(true)
  })

  it('保留真实网卡', () => {
    expect(isVirtualInterface('enp0s31f6')).toBe(false)
    expect(isVirtualInterface('wlp3s0')).toBe(false)
    expect(isVirtualInterface('eth0')).toBe(false)
    expect(isVirtualInterface('wlan0')).toBe(false)
  })
})

describe('rewriteToLan', () => {
  it('localhost 换成本机局域网 IP（否则音箱连的是它自己）', () => {
    expect(rewriteToLan('http://localhost:58091/a.mp3?access_token=t', '192.168.23.125')).toBe(
      'http://192.168.23.125:58091/a.mp3?access_token=t'
    )
    expect(rewriteToLan('http://127.0.0.1:58091/a.mp3', '10.0.0.2')).toBe(
      'http://10.0.0.2:58091/a.mp3'
    )
  })

  it('本来就是局域网地址时一个字都不动', () => {
    const url = 'http://192.168.23.51:58091/a.mp3?access_token=t'
    expect(rewriteToLan(url, '192.168.23.125')).toBe(url)
  })

  it('拿不到局域网 IP 时原样返回（宁可让设备报错，也别乱改地址）', () => {
    expect(rewriteToLan('http://localhost:58091/a.mp3', null)).toBe('http://localhost:58091/a.mp3')
  })
})

describe('buildSearchRequest', () => {
  it('是一段合法的 M-SEARCH', () => {
    const request = buildSearchRequest('urn:schemas-upnp-org:device:MediaRenderer:1')
    expect(request.startsWith('M-SEARCH * HTTP/1.1\r\n')).toBe(true)
    expect(request).toContain('HOST: 239.255.255.250:1900')
    expect(request).toContain('MAN: "ssdp:discover"')
    expect(request).toContain('ST: urn:schemas-upnp-org:device:MediaRenderer:1')
    expect(request.endsWith('\r\n\r\n')).toBe(true)
  })
})

describe('parseSoapValue', () => {
  it('取出字段并解码实体', () => {
    const xml = '<CurrentTransportState>PLAYING</CurrentTransportState>'
    expect(parseSoapValue(xml, 'CurrentTransportState')).toBe('PLAYING')
    expect(parseSoapValue(xml, 'RelTime')).toBe('')
  })
})

describe('prefetchUrl', () => {
  it('接在已有查询参数后面（后端缓存键要求与真实播放完全一致）', () => {
    expect(prefetchUrl('/songs/1/play?access_token=t&format=mp3')).toBe(
      '/songs/1/play?access_token=t&format=mp3&prefetch=1'
    )
  })

  it('没有查询参数时自己补一个问号', () => {
    expect(prefetchUrl('http://host/songs/1/play')).toBe('http://host/songs/1/play?prefetch=1')
  })

  it('空地址返回空（没有可预热的对象）', () => {
    expect(prefetchUrl('')).toBe('')
  })
})

describe('isBackendLocalFile', () => {
  const headers = (pairs: Record<string, string>) => ({
    get: (name: string) => pairs[name.toLowerCase()] ?? null
  })

  it('ServeFile 的响应：有长度、可 Range → 是本地文件', () => {
    expect(
      isBackendLocalFile(headers({ 'content-length': '8123456', 'accept-ranges': 'bytes' }))
    ).toBe(true)
  })

  it('边转边发那条流给不出确定长度 → 不算', () => {
    expect(isBackendLocalFile(headers({ 'accept-ranges': 'bytes' }))).toBe(false)
    expect(isBackendLocalFile(headers({ 'content-length': '0', 'accept-ranges': 'bytes' }))).toBe(
      false
    )
  })

  it('不能 Range（直播流 / 代理流）→ 不算', () => {
    expect(isBackendLocalFile(headers({ 'content-length': '8123456' }))).toBe(false)
    expect(isBackendLocalFile(headers({}))).toBe(false)
  })
})
