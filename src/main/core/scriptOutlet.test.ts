import { describe, it, expect, vi } from 'vitest'
import { SCRIPT_OUTLET_LISTEN_ADDRESS } from '../../shared/appConfig'
import { getOutletGroupName, getOutletListenerName, injectScriptOutlets } from './scriptOutlet'

vi.mock('../utils/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  })
}))

const baseProfile = (): Partial<IMihomoConfig> => ({
  'mixed-port': 7890,
  proxies: [{ name: 'US-01' }, { name: 'TW-01' }],
  'proxy-groups': [{ name: '过盾', type: 'select', proxies: ['US-01', 'TW-01'] }]
})

const outlet = (patch: Partial<IScriptOutlet> = {}): IScriptOutlet => ({
  id: 'o1',
  enable: true,
  port: 7900,
  type: 'mixed',
  mode: 'direct',
  target: 'US-01',
  ...patch
})

describe('injectScriptOutlets', () => {
  it('does nothing when there is no enabled outlet', () => {
    const profile = baseProfile()
    expect(injectScriptOutlets(profile, undefined).injected).toBe(0)
    expect(injectScriptOutlets(profile, [outlet({ enable: false })]).injected).toBe(0)
    expect(profile.listeners).toBeUndefined()
  })

  it('injects a listener bound to 127.0.0.1 in direct mode', () => {
    const profile = baseProfile()
    const result = injectScriptOutlets(profile, [outlet()])

    expect(result.injected).toBe(1)
    expect(profile.listeners).toEqual([
      {
        name: getOutletListenerName(outlet()),
        type: 'mixed',
        listen: SCRIPT_OUTLET_LISTEN_ADDRESS,
        port: 7900,
        proxy: 'US-01',
        udp: true
      }
    ])
    // direct 模式不应产生额外策略组
    expect(profile['proxy-groups']).toHaveLength(1)
  })

  it('allows an existing proxy group as direct target', () => {
    const profile = baseProfile()
    injectScriptOutlets(profile, [outlet({ target: '过盾' })])
    expect(profile.listeners?.[0].proxy).toBe('过盾')
  })

  it('creates a hidden fallback group in fallback mode', () => {
    const profile = baseProfile()
    const item = outlet({ mode: 'fallback', target: undefined, targets: ['US-01', 'TW-01'] })
    injectScriptOutlets(profile, [item])

    const groupName = getOutletGroupName(item)
    const group = profile['proxy-groups']?.find((g) => g.name === groupName)
    expect(group).toMatchObject({
      type: 'fallback',
      proxies: ['US-01', 'TW-01'],
      hidden: true
    })
    expect(profile.listeners?.[0].proxy).toBe(groupName)
  })

  it('normalizes interval instead of validating it as a port', () => {
    const profile = baseProfile()
    const item = outlet({
      mode: 'fallback',
      target: undefined,
      targets: ['US-01'],
      interval: 86400
    })
    injectScriptOutlets(profile, [item])

    const group = profile['proxy-groups']?.find((g) => g.name === getOutletGroupName(item))
    expect(group?.interval).toBe(86400)
  })

  it('skips outlets whose port conflicts with a mihomo inbound port', () => {
    const profile = baseProfile()
    const result = injectScriptOutlets(profile, [outlet({ port: 7890 })])
    expect(result.injected).toBe(0)
    expect(result.skipped).toHaveLength(1)
    expect(profile.listeners).toBeUndefined()
  })

  it('skips duplicated ports and unknown targets', () => {
    const profile = baseProfile()
    const result = injectScriptOutlets(profile, [
      outlet({ id: 'a', port: 7900 }),
      outlet({ id: 'b', port: 7900 }),
      outlet({ id: 'c', port: 7901, target: 'NOT-EXIST' })
    ])
    expect(result.injected).toBe(1)
    expect(result.skipped.map((s) => s.id)).toEqual(['b', 'c'])
  })

  it('keeps listeners that already exist in the subscription', () => {
    const profile = baseProfile()
    profile.listeners = [
      { name: 'user-own', type: 'mixed', port: 8000, listen: '127.0.0.1', proxy: 'TW-01' }
    ]
    injectScriptOutlets(profile, [outlet()])
    expect(profile.listeners?.map((l) => l.name)).toEqual([
      'user-own',
      getOutletListenerName(outlet())
    ])
  })

  it('relaxes target existence check when proxy-providers are used', () => {
    const profile = { ...baseProfile(), 'proxy-providers': { airport: {} } }
    const result = injectScriptOutlets(profile, [outlet({ target: 'from-provider' })])
    expect(result.injected).toBe(1)
    expect(profile.listeners?.[0].proxy).toBe('from-provider')
  })
})
