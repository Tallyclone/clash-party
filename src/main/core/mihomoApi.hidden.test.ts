import { describe, expect, it, vi, beforeEach } from 'vitest'

/**
 * 回归测试：mihomoGroups() 的 hidden 过滤必须以 runtime 配置为准。
 *
 * 背景 BUG（2026-08-25）：原实现写的是 `!group.hidden`，其中 group 来自
 * mihomo 的 /proxies API 响应 —— 而该 API **不返回** hidden 字段，
 * 于是 `undefined` 被当成「不隐藏」，50 个 出口能用NN 隐藏组全部漏进了
 * 代理页面和托盘菜单。修复方式是改为从 runtime YAML 建 hiddenNames 集合。
 */

const groupDefs = [
  { name: '节点选择', type: 'select' },
  { name: '[DOGEGG]-自动', type: 'url-test', hidden: true },
  { name: '[DOGEGG]', type: 'select' },
  { name: '[能用]', type: 'select' },
  { name: '出口能用01', type: 'select', hidden: true },
  { name: '出口能用02', type: 'select', hidden: true }
]

// 复刻 /proxies 的真实响应：只有 name/type/all/now/history，**没有 hidden**
// GLOBAL 必须存在，否则 mihomoProxies() 会直接抛 'GLOBAL proxy not found'
const proxiesPayload = {
  proxies: Object.fromEntries(
    [...groupDefs, { name: 'GLOBAL', type: 'select' }].map((g) => [
      g.name,
      {
        name: g.name,
        type: g.type === 'url-test' ? 'URLTest' : 'Selector',
        all: [] as string[],
        now: '',
        history: []
      }
    ])
  )
}

vi.mock('electron', () => ({ app: { getPath: () => '', getVersion: () => '0.0.0' } }))
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

// axios 桩：拦掉 /proxies，其余返回空对象。注意要带 interceptors 结构，
// 因为 getAxios() 会调用 interceptors.response.use()
vi.mock('axios', () => ({
  default: {
    create: () => ({
      interceptors: { response: { use: vi.fn() } },
      get: vi.fn(async (url: string) => {
        if (url === '/proxies') return proxiesPayload
        return {}
      }),
      put: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
      post: vi.fn()
    })
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

describe('mihomoGroups hidden filtering', () => {
  beforeEach(() => {
    getControledMihomoConfig.mockResolvedValue({ mode: 'rule' })
    getRuntimeConfig.mockResolvedValue({ 'proxy-groups': groupDefs })
  })

  it('reads hidden from the runtime config, not from the /proxies API payload', async () => {
    const { mihomoGroups } = await import('./mihomoApi')
    const names = (await mihomoGroups()).map((g) => g.name)

    // 若实现改回读 API 响应对象上的 .hidden，这里会拿到全部 6 个组而失败
    expect(names).not.toContain('出口能用01')
    expect(names).not.toContain('出口能用02')
    expect(names).not.toContain('[DOGEGG]-自动')
  })

  it('keeps non-hidden groups visible', async () => {
    const { mihomoGroups } = await import('./mihomoApi')
    const names = (await mihomoGroups()).map((g) => g.name)

    expect(names).toContain('节点选择')
    expect(names).toContain('[DOGEGG]')
    expect(names).toContain('[能用]')
  })

  it('returns hidden groups when includeHidden is true (script outlet page)', async () => {
    const { mihomoGroups } = await import('./mihomoApi')
    const names = (await mihomoGroups(true)).map((g) => g.name)

    expect(names).toContain('出口能用01')
    expect(names).toContain('出口能用02')
    expect(names).toContain('[DOGEGG]-自动')
  })

  it('marks the hidden flag on returned groups', async () => {
    const { mihomoGroups } = await import('./mihomoApi')
    const groups = await mihomoGroups(true)

    expect(groups.find((g) => g.name === '出口能用01')?.hidden).toBe(true)
    expect(groups.find((g) => g.name === '节点选择')?.hidden).toBe(false)
  })
})
