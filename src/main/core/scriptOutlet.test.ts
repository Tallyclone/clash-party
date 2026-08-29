import { describe, it, expect, vi } from 'vitest'
import {
  PROBE_STATION_COUNT,
  PROBE_STATION_GROUP_PREFIX,
  PROBE_STATION_LISTENER_PREFIX,
  PROBE_STATION_PORT_BASE,
  SCRIPT_OUTLET_GROUP_PREFIX,
  SCRIPT_OUTLET_LISTEN_ADDRESS,
  SCRIPT_OUTLET_LISTENER_PREFIX
} from '../../shared/appConfig'
import {
  getOutletGroupName,
  getOutletListenerName,
  injectProbeStations,
  injectScriptOutlets
} from './scriptOutlet'

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

  it('expands a batch outlet into one listener per port', () => {
    const profile = baseProfile()
    const result = injectScriptOutlets(profile, [
      outlet({
        id: 'batch',
        port: 7900,
        count: 2,
        remark: 'test',
        batchTargets: ['US-01', 'TW-01']
      })
    ])

    expect(result.injected).toBe(2)
    expect(profile.listeners).toEqual([
      {
        name: `${SCRIPT_OUTLET_LISTENER_PREFIX}7900`,
        type: 'mixed',
        listen: SCRIPT_OUTLET_LISTEN_ADDRESS,
        port: 7900,
        proxy: 'US-01',
        udp: true
      },
      {
        name: `${SCRIPT_OUTLET_LISTENER_PREFIX}7901`,
        type: 'mixed',
        listen: SCRIPT_OUTLET_LISTEN_ADDRESS,
        port: 7901,
        proxy: 'TW-01',
        udp: true
      }
    ])
  })

  it('skips only the batch member whose target is missing', () => {
    const profile = baseProfile()
    const result = injectScriptOutlets(profile, [
      outlet({ id: 'batch', port: 7900, count: 3, batchTargets: ['US-01'] })
    ])

    // 第 1 个有目标可注入，后两个目标缺失被跳过
    expect(result.injected).toBe(1)
    expect(result.skipped.map((s) => s.id)).toEqual(['batch#02', 'batch#03'])
    expect(profile.listeners?.map((l) => l.port)).toEqual([7900])
  })

  it('detects port conflicts between a batch range and a single outlet', () => {
    const profile = baseProfile()
    const result = injectScriptOutlets(profile, [
      outlet({ id: 'batch', port: 7900, count: 3, batchTargets: ['US-01', 'US-01', 'US-01'] }),
      outlet({ id: 'single', port: 7901 })
    ])

    // 批量占用 7900~7902，单出口的 7901 落在区间内被跳过
    expect(result.injected).toBe(3)
    expect(result.skipped.map((s) => s.id)).toEqual(['single'])
  })

  it('creates one fallback group per port sharing the same targets', () => {
    const profile = baseProfile()
    injectScriptOutlets(profile, [
      outlet({
        id: 'batch',
        port: 7900,
        count: 2,
        mode: 'fallback',
        target: undefined,
        targets: ['US-01', 'TW-01']
      })
    ])

    const groups = (profile['proxy-groups'] ?? []).filter((g) =>
      String(g.name).startsWith(SCRIPT_OUTLET_GROUP_PREFIX)
    )
    expect(groups).toHaveLength(2)
    expect(
      groups.every((g) => JSON.stringify(g.proxies) === JSON.stringify(['US-01', 'TW-01']))
    ).toBe(true)
  })
})

describe('injectProbeStations', () => {
  const stationPorts = (profile: Partial<IMihomoConfig>): number[] =>
    (profile.listeners ?? [])
      .filter((listener) => String(listener.name).startsWith(PROBE_STATION_LISTENER_PREFIX))
      .map((listener) => listener.port)

  it('uses the default window when nothing conflicts', () => {
    const profile = baseProfile()

    const result = injectProbeStations(profile)

    expect(result.injected).toBe(PROBE_STATION_COUNT)
    expect(result.windowStart).toBe(PROBE_STATION_PORT_BASE)
    expect(result.ports[0]).toBe(PROBE_STATION_PORT_BASE)
    expect(result.ports).toHaveLength(PROBE_STATION_COUNT)
    // 注入结果就是端口的唯一真相源，必须与实际写进 profile 的 listener 端口逐项一致
    expect(stationPorts(profile)).toEqual(result.ports)
  })

  it('shifts the whole window past the user business outlets instead of skipping stations', () => {
    // 实机故障复现：用户在界面里配了 port: 17900 / count: 100 的业务出口，
    // 旧实现按死基址算端口、逐个跳过冲突，结果 injected=0 且 mode=ip 静默不可用。
    const profile = baseProfile()
    profile.listeners = []
    for (let index = 0; index < 100; index += 1) {
      profile.listeners.push({
        name: `party-outlet-${17900 + index}`,
        type: 'http',
        listen: '127.0.0.1',
        port: 17900 + index,
        proxy: 'US-01'
      } as IMihomoListener)
    }

    const result = injectProbeStations(profile)

    expect(result.injected).toBe(PROBE_STATION_COUNT)
    expect(result.ports.some((port) => port >= 17900 && port <= 17999)).toBe(false)
    expect(result.skippedReason).toBeUndefined()
  })

  it('jumps over a block sitting on the default window', () => {
    const profile = baseProfile()
    profile.listeners = []
    for (let index = 0; index < PROBE_STATION_COUNT; index += 1) {
      profile.listeners.push({
        name: `party-outlet-${PROBE_STATION_PORT_BASE + index}`,
        type: 'http',
        listen: '127.0.0.1',
        port: PROBE_STATION_PORT_BASE + index,
        proxy: 'US-01'
      } as IMihomoListener)
    }

    const result = injectProbeStations(profile)

    expect(result.windowStart).toBe(PROBE_STATION_PORT_BASE + PROBE_STATION_COUNT)
    expect(result.injected).toBe(PROBE_STATION_COUNT)
  })

  it('treats the extra reserved ports (script api) as occupied', () => {
    const profile = baseProfile()

    const result = injectProbeStations(profile, [PROBE_STATION_PORT_BASE + 5])

    expect(result.ports).not.toContain(PROBE_STATION_PORT_BASE + 5)
    expect(result.injected).toBe(PROBE_STATION_COUNT)
  })

  it('group names are derived from the port, so a shifted window keeps them aligned', () => {
    const profile = baseProfile()

    const result = injectProbeStations(profile, [PROBE_STATION_PORT_BASE])

    const groups = (profile['proxy-groups'] ?? []).filter((g) =>
      String(g.name).startsWith(PROBE_STATION_GROUP_PREFIX)
    )
    expect(groups.map((g) => String(g.name))).toEqual(
      result.ports.map((port) => `${PROBE_STATION_GROUP_PREFIX}${port}`)
    )
  })

  it('skips entirely when the profile has nothing to probe', () => {
    const profile: Partial<IMihomoConfig> = { 'mixed-port': 7890 }

    const result = injectProbeStations(profile)

    expect(result.injected).toBe(0)
    expect(result.ports).toEqual([])
    expect(result.windowStart).toBeNull()
    expect(result.skippedReason).toContain('no proxies or proxy-providers')
  })
})
