import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * mihomoApi 的两个「省流量」改造的回归测试。
 *
 * 背景（2026-08-28 实机实测，mihomo v1.19.29 + 643 节点 / 174 策略组的真实配置）：
 *
 * ```
 * GET /proxies              5.11 MB    net 247~306ms   JSON.parse 24~52ms
 * GET /proxies/出口能用01   28034 B    net 1~4ms       JSON.parse 0ms
 * GET /providers/proxies  148.52 MB    net 7~10s       JSON.parse 1574~2825ms
 * ```
 *
 * 两处改造：
 * 1. `mihomoProxyDetail(name)` —— 只要一个组时走单组查询，404/异常再退回全量复核，
 *    保证「组不存在」的语义与改动前完全一致。
 * 2. `mihomoProxyProviders()` —— 只拉 runtime config 里声明的真订阅 provider，
 *    不再全量拉那 148 MB（里面 93% 是 mihomo 把 proxy-group 镜像成的 Compatible 伪 provider）。
 *
 * 这两条都必须由测试锁住「没走全量」这件事，否则回归时性能问题会静默复发。
 */

const probeGet = vi.fn()
const fullGet = vi.fn()

vi.mock('electron', () => ({
  app: { getPath: () => '', getVersion: () => '0.0.0', isReady: () => true }
}))
vi.mock('../window', () => ({ mainWindow: null }))
vi.mock('../resolve/tray', () => ({ tray: null }))
vi.mock('../resolve/floatingWindow', () => ({ floatingWindow: null }))
vi.mock('../utils/calc', () => ({ calcTraffic: () => '' }))
vi.mock('../utils/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))
vi.mock('../utils/dirs', () => ({ mihomoWorkConfigPath: () => '' }))
vi.mock('./manager', () => ({
  getMihomoIpcPath: () => '/tmp/mihomo.sock',
  hasCoreProcess: () => true,
  restartCore: vi.fn()
}))
vi.mock('ws', () => ({ default: class {} }))

// 两个 axios 实例靠 validateStatus 区分：只有 getProbeAxios() 会传它
// （那是「4xx/5xx 不抛异常、自己读 status」的探测专用实例）。
vi.mock('axios', () => ({
  default: {
    create: (config: { validateStatus?: unknown }) => {
      if (config?.validateStatus) {
        return { interceptors: { response: { use: vi.fn() } }, get: probeGet }
      }
      return {
        interceptors: { response: { use: vi.fn() } },
        get: fullGet,
        put: vi.fn(),
        patch: vi.fn(),
        delete: vi.fn(),
        post: vi.fn()
      }
    }
  }
}))

const getControledMihomoConfig = vi.fn()
const getRuntimeConfig = vi.fn()

vi.mock('../config', () => ({
  getAppConfig: vi.fn(async () => ({})),
  getControledMihomoConfig: () => getControledMihomoConfig()
}))
vi.mock('./factory', () => ({
  generateProfile: vi.fn(),
  getRuntimeConfig: () => getRuntimeConfig()
}))

const { mihomoProxyDetail, mihomoProxyProviders } = await import('./mihomoApi')

// GLOBAL 必须存在，否则 mihomoProxies() 会直接抛 'GLOBAL proxy not found'
const fullProxiesPayload = {
  proxies: {
    GLOBAL: { name: 'GLOBAL', type: 'Selector', all: [], now: '', history: [] },
    出口能用01: {
      name: '出口能用01',
      type: 'Selector',
      all: ['节点A', '节点B'],
      now: '节点A',
      history: []
    }
  }
}

beforeEach(() => {
  probeGet.mockReset()
  fullGet.mockReset()
  getControledMihomoConfig.mockReset()
  getRuntimeConfig.mockReset()

  getControledMihomoConfig.mockResolvedValue({ mode: 'rule' })
  getRuntimeConfig.mockResolvedValue({})
  // getAxios 的响应拦截器在真实实现里会把 response 降级成 response.data，
  // 这里桩掉了拦截器，所以直接返回 data 形态。
  fullGet.mockImplementation(async (url: string) => {
    if (url === '/proxies') return fullProxiesPayload
    return {}
  })
})

describe('mihomoProxyDetail', () => {
  it('returns the single-object payload without touching the full /proxies list', async () => {
    probeGet.mockResolvedValue({
      status: 200,
      data: { name: '出口能用01', type: 'Selector', all: ['节点A'], now: '节点A' }
    })

    const result = await mihomoProxyDetail('出口能用01')

    expect(result.proxy?.name).toBe('出口能用01')
    expect(result.notFound).toBe(false)
    expect(result.error).toBe('')
    expect(probeGet).toHaveBeenCalledWith('/proxies/%E5%87%BA%E5%8F%A3%E8%83%BD%E7%94%A801', {
      timeout: 5000
    })
    // 关键断言：热路径一次全量都不能拉，否则 5.11MB / 250ms 的开销原封不动回来了
    expect(fullGet).not.toHaveBeenCalledWith('/proxies')
  })

  it('maps a kernel 404 to notFound after re-checking the full list', async () => {
    probeGet.mockResolvedValue({ status: 404, data: { message: 'Resource not found' } })

    const result = await mihomoProxyDetail('不存在的组')

    expect(result.notFound).toBe(true)
    expect(result.proxy).toBeNull()
    expect(result.error).toBe('')
    expect(fullGet).toHaveBeenCalledWith('/proxies')
  })

  it('still resolves the proxy when the single-object route 404s but the name does exist', async () => {
    // 这条覆盖「内核版本没有 /proxies/{name} 这条路由」的场景：
    // 若直接把 404 当成组不存在，所有单组请求会集体误报 404。
    probeGet.mockResolvedValue({ status: 404, data: { message: 'Resource not found' } })

    const result = await mihomoProxyDetail('出口能用01')

    expect(result.notFound).toBe(false)
    expect(result.proxy?.name).toBe('出口能用01')
    expect(result.error).toBe('')
  })

  it('surfaces the kernel message for non-200 non-404 responses', async () => {
    probeGet.mockResolvedValue({ status: 500, data: { message: 'kernel exploded' } })

    const result = await mihomoProxyDetail('出口能用01')

    expect(result.error).toBe('kernel exploded')
    expect(result.proxy).toBeNull()
    expect(result.notFound).toBe(false)
    expect(fullGet).not.toHaveBeenCalledWith('/proxies')
  })

  it('falls back to the full list when a 200 payload has no name field', async () => {
    probeGet.mockResolvedValue({ status: 200, data: { unexpected: true } })

    const result = await mihomoProxyDetail('出口能用01')

    expect(result.proxy?.name).toBe('出口能用01')
    expect(fullGet).toHaveBeenCalledWith('/proxies')
  })

  it('falls back to the full list on socket-level failures', async () => {
    probeGet.mockRejectedValue(new Error('ENOENT'))

    const result = await mihomoProxyDetail('出口能用01')

    expect(result.proxy?.name).toBe('出口能用01')
    expect(fullGet).toHaveBeenCalledWith('/proxies')
  })

  it('reports the fallback failure instead of pretending the group is missing', async () => {
    probeGet.mockRejectedValue(new Error('socket closed'))
    fullGet.mockRejectedValue(new Error('core is restarting'))

    const result = await mihomoProxyDetail('出口能用01')

    expect(result.proxy).toBeNull()
    expect(result.notFound).toBe(false)
    expect(result.error).toBe('core is restarting')
  })
})

describe('mihomoProxyProviders', () => {
  it('issues zero requests when the runtime config declares no proxy-providers', async () => {
    getRuntimeConfig.mockResolvedValue({ 'proxy-groups': [{ name: '出口能用01' }] })

    const result = await mihomoProxyProviders()

    expect(result).toEqual({ providers: {} })
    // 改动前这里会打 GET /providers/proxies —— 实测 148.52MB / 同步 parse 1.5~2.8s，
    // 而这份配置里真订阅 provider 是 0 个，浪费率 100%。
    expect(fullGet).not.toHaveBeenCalled()
  })

  it('fetches only the declared subscription providers, one by one', async () => {
    getRuntimeConfig.mockResolvedValue({
      'proxy-providers': { 机场A: { type: 'http' }, 机场B: { type: 'http' } }
    })
    fullGet.mockImplementation(async (url: string) => {
      if (url === '/providers/proxies/%E6%9C%BA%E5%9C%BAA') {
        return { name: '机场A', vehicleType: 'HTTP', type: 'Proxy', expectedStatus: '*' }
      }
      if (url === '/providers/proxies/%E6%9C%BA%E5%9C%BAB') {
        return { name: '机场B', vehicleType: 'HTTP', type: 'Proxy', expectedStatus: '*' }
      }
      throw new Error(`unexpected url: ${url}`)
    })

    const result = await mihomoProxyProviders()

    expect(Object.keys(result.providers).sort()).toEqual(['机场A', '机场B'])
    expect(fullGet).toHaveBeenCalledTimes(2)
    expect(fullGet).not.toHaveBeenCalledWith('/providers/proxies')
  })

  it('skips a single failing provider instead of failing the whole list', async () => {
    getRuntimeConfig.mockResolvedValue({
      'proxy-providers': { 机场A: { type: 'http' }, 已删除: { type: 'http' } }
    })
    fullGet.mockImplementation(async (url: string) => {
      if (url === '/providers/proxies/%E6%9C%BA%E5%9C%BAA') {
        return { name: '机场A', vehicleType: 'HTTP', type: 'Proxy', expectedStatus: '*' }
      }
      throw new Error('Resource not found')
    })

    const result = await mihomoProxyProviders()

    expect(Object.keys(result.providers)).toEqual(['机场A'])
  })

  it('returns an empty list when the runtime config is unavailable', async () => {
    getRuntimeConfig.mockRejectedValue(new Error('not generated yet'))

    const result = await mihomoProxyProviders()

    expect(result).toEqual({ providers: {} })
    expect(fullGet).not.toHaveBeenCalled()
  })
})
