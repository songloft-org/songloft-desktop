/**
 * 「服务器配的代理在本机能不能用」的单测。
 *
 * 这里钉住的都是**会静默走错方向**的判断：
 *   * 代理地址解析错 → 探活探到一个不存在的端口，于是明明能用的代理被跳过（退化成直连）；
 *   * 写法认不出来却当成可用 → 把一串垃圾配给 Chromium，请求直接失败（连「已改为直连」都没有）。
 */

import { describe, expect, it } from 'vitest'

import { parseProxyTarget, planProxies, usablePrefix } from './proxy'

describe('parseProxyTarget', () => {
  it('认得带协议的写法', () => {
    expect(parseProxyTarget('http://192.168.1.1:7890')).toEqual({
      host: '192.168.1.1',
      port: 7890
    })
    expect(parseProxyTarget('https://proxy.example.com:8443')).toEqual({
      host: 'proxy.example.com',
      port: 8443
    })
  })

  it('省掉协议也按 http 算（设置页允许 host:port）', () => {
    expect(parseProxyTarget('127.0.0.1:7890')).toEqual({ host: '127.0.0.1', port: 7890 })
  })

  it('socks 的默认端口是 1080，http 是 80', () => {
    expect(parseProxyTarget('socks5://127.0.0.1')).toEqual({ host: '127.0.0.1', port: 1080 })
    expect(parseProxyTarget('http://proxy.lan')).toEqual({ host: 'proxy.lan', port: 80 })
  })

  it('IPv6 的方括号要去掉：net.connect 不认带括号的地址', () => {
    expect(parseProxyTarget('http://[::1]:7890')).toEqual({ host: '::1', port: 7890 })
  })

  it('认不出来的一律返回 null（调用方按「不可用」处理）', () => {
    expect(parseProxyTarget('')).toBeNull()
    expect(parseProxyTarget('   ')).toBeNull()
    expect(parseProxyTarget('http://')).toBeNull()
    expect(parseProxyTarget('http://host:0')).toBeNull()
    expect(parseProxyTarget('http://host:99999')).toBeNull()
  })
})

describe('usablePrefix', () => {
  it('正常的加速前缀原样返回（前后空白去掉）', () => {
    expect(usablePrefix(' https://ghfast.top/ ')).toBe('https://ghfast.top/')
  })

  it('不像前缀的写法折成空串，免得拼出一个必定 404 的地址', () => {
    expect(usablePrefix('ghfast.top')).toBe('')
    expect(usablePrefix('https://ghfast.top/?a=1')).toBe('')
    expect(usablePrefix('ftp://ghfast.top/')).toBe('')
    expect(usablePrefix('')).toBe('')
  })
})

describe('planProxies', () => {
  it('没配代理时两条通路都不给（调用方只剩直连）', async () => {
    await expect(planProxies({ githubProxy: '', httpProxy: '' })).resolves.toEqual({
      prefix: '',
      proxyRules: '',
      httpProxyUnreachable: false
    })
  })

  it('HTTP 代理连不上就标记出来，并且不把它交给 Chromium', async () => {
    // 端口 1 上不会有服务在听：本机 connect 立刻 ECONNREFUSED，探活必然是 false
    await expect(
      planProxies({ githubProxy: '', httpProxy: 'http://127.0.0.1:1' })
    ).resolves.toEqual({ prefix: '', proxyRules: '', httpProxyUnreachable: true })
  })

  it('代理写法认不出来也算不可用，而不是硬塞给 Chromium', async () => {
    await expect(planProxies({ githubProxy: '', httpProxy: 'not a proxy' })).resolves.toEqual({
      prefix: '',
      proxyRules: '',
      httpProxyUnreachable: true
    })
  })

  it('加速前缀与 HTTP 代理互不影响：前者能填、后者不可用时照样能用', async () => {
    await expect(
      planProxies({ githubProxy: 'https://ghfast.top/', httpProxy: '127.0.0.1:1' })
    ).resolves.toEqual({
      prefix: 'https://ghfast.top/',
      proxyRules: '',
      httpProxyUnreachable: true
    })
  })
})
