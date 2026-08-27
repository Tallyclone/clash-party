import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 名单探测（probeNamedProxies）的单测。
 *
 * 这条路径的价值全在边界上：它是唯一由脚本直接决定测谁、测多少的入口，
 * 所以名单清洗（去重 / 未知 / 策略组 / 截断）、超时收敛、并发闸门都必须钉住。
 *
 * 另外有两条纪律必须由测试保证，否则回归了根本看不出来：
 * 1. 不走 inflightProbe 单飞锁（否则会 join 一轮全量，返回与名单无关的数据）；
 * 2. 不动 state 里的任何字段（否则 applyFreshness 会误判数据很新，悄悄返回陈旧名单）。
 */

vi.mock('croner', () => ({
  Cron: class {
    stop = vi.fn()
  }
}))
vi.mock('../utils/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))
vi.mock('./mihomoApi', () => ({
  mihomoProxies: vi.fn(),
  mihomoProxyDelay: vi.fn()
}))

const {
  DELAY_PROBE_QUICK_TIMEOUT,
  SCRIPT_API_NAMED_PROBE_CONCURRENCY,
  SCRIPT_API_NAMED_PROBE_MAX_NAMES,
  SCRIPT_API_NAMED_PROBE_MAX_TIMEOUT,
  SCRIPT_API_NAMED_PROBE_MIN_TIMEOUT
} = await import('../../shared/appConfig')
const { getDelayDataAgeMs, getDelayProbeSnapshot, probeNamedProxies } = await import('./delayProbe')
const { mihomoProxies, mihomoProxyDelay } = await import('./mihomoApi')

const proxiesMock = vi.mocked(mihomoProxies)
const delayMock = vi.mocked(mihomoProxyDelay)

/** 造一个具体节点。只有 type 会被判定用到，其余字段补齐是为了满足类型 */
function proxy(name: string, type = 'vless'): unknown {
  return { name, type, alive: true, history: [], extra: {} }
}

/** 造一个策略组：判定靠的是 `'all' in proxy`，所以 all 必须存在 */
function group(name: string, all: string[] = []): unknown {
  return { name, type: 'Selector', all, alive: true, history: [], extra: {}, now: all[0] ?? '' }
}

function setProxies(entries: Record<string, unknown>): void {
  proxiesMock.mockResolvedValue({ proxies: entries } as unknown as IMihomoProxies)
}

beforeEach(() => {
  proxiesMock.mockReset()
  delayMock.mockReset()
  delayMock.mockResolvedValue({ delay: 100 })
})

describe('probeNamedProxies 名单清洗', () => {
  it('按首次出现顺序去重，重复名不占额度也不重复测速', async () => {
    setProxies({ A: proxy('A'), B: proxy('B') })

    const result = await probeNamedProxies(['B', 'A', 'B', 'A', 'B'])

    expect(result.received).toBe(5)
    expect(result.deduped).toBe(2)
    expect(result.accepted).toBe(2)
    // 顺序必须是首次出现的顺序，不是字典序 —— 文档里承诺「最在意的放前面」
    expect(result.results.map((item) => item.name)).toEqual(['B', 'A'])
    expect(delayMock).toHaveBeenCalledTimes(2)
  })

  it('内核里查不到的名字进 unknown，不影响其余节点', async () => {
    setProxies({ A: proxy('A') })

    const result = await probeNamedProxies(['A', '订阅更新后没了的节点'])

    expect(result.unknown).toEqual(['订阅更新后没了的节点'])
    expect(result.results).toEqual([{ name: 'A', delay: 100 }])
    // 整个请求不能因为一个失效名字失败：脚本手里的名字过期是常态
    expect(delayMock).toHaveBeenCalledTimes(1)
  })

  it('策略组与内置出口进 rejected', async () => {
    setProxies({
      A: proxy('A'),
      '🇯🇵 日本-自动': group('🇯🇵 日本-自动', ['A']),
      DIRECT: proxy('DIRECT', 'Direct'),
      'PASS-RULE': proxy('PASS-RULE', 'PassRule')
    })

    const result = await probeNamedProxies(['A', '🇯🇵 日本-自动', 'DIRECT', 'PASS-RULE'])

    expect(result.rejected).toEqual(['🇯🇵 日本-自动', 'DIRECT', 'PASS-RULE'])
    expect(result.accepted).toBe(1)
    expect(delayMock).toHaveBeenCalledTimes(1)
  })

  it('忽略非字符串项与空白名，不会把它们当成节点去测', async () => {
    setProxies({ A: proxy('A') })

    const result = await probeNamedProxies(['A', '', '   ', null, 123, undefined, { name: 'A' }])

    expect(result.received).toBe(7)
    expect(result.deduped).toBe(1)
    expect(result.accepted).toBe(1)
    expect(result.unknown).toEqual([])
  })

  it('names 不是数组时按空名单处理，不抛异常', async () => {
    setProxies({ A: proxy('A') })

    const result = await probeNamedProxies('A')

    expect(result.received).toBe(0)
    expect(result.accepted).toBe(0)
    expect(result.results).toEqual([])
    expect(delayMock).not.toHaveBeenCalled()
  })

  it('截断发生在去重与校验之后：重复名、未知名、策略组都不占额度', async () => {
    const total = SCRIPT_API_NAMED_PROBE_MAX_NAMES + 10
    const names = Array.from({ length: total }, (_, i) => `N${i}`)
    const entries: Record<string, unknown> = {}
    for (const name of names) entries[name] = proxy(name)
    entries['G'] = group('G')
    setProxies(entries)

    // 前面塞满噪声：如果截断在清洗之前，这些会白占掉 10 个额度
    const result = await probeNamedProxies(['N0', 'N0', 'G', '不存在1', '不存在2', ...names])

    expect(result.accepted).toBe(SCRIPT_API_NAMED_PROBE_MAX_NAMES)
    expect(result.truncated).toBe(total - SCRIPT_API_NAMED_PROBE_MAX_NAMES)
    expect(result.unknown).toEqual(['不存在1', '不存在2'])
    expect(result.rejected).toEqual(['G'])
    // 被截掉的名字不回响应（脚本自己 slice 就知道），只回计数
    expect(result.results).toHaveLength(SCRIPT_API_NAMED_PROBE_MAX_NAMES)
    expect(result.results[0].name).toBe('N0')
  })
})

describe('probeNamedProxies 超时收敛', () => {
  it('不传 timeout 时用现测的超时', async () => {
    setProxies({ A: proxy('A') })

    const result = await probeNamedProxies(['A'])

    expect(result.timeout).toBe(DELAY_PROBE_QUICK_TIMEOUT)
    expect(delayMock).toHaveBeenCalledWith('A', undefined, undefined, DELAY_PROBE_QUICK_TIMEOUT)
  })

  it('过小的 timeout 抬到下限：timeout=1 会把所有节点测成 0 并污染内核 history', async () => {
    setProxies({ A: proxy('A') })

    const result = await probeNamedProxies(['A'], 1)

    expect(result.timeout).toBe(SCRIPT_API_NAMED_PROBE_MIN_TIMEOUT)
  })

  it('过大的 timeout 压到上限：并发固定后 timeout 是唯一决定最坏耗时的量', async () => {
    setProxies({ A: proxy('A') })

    const result = await probeNamedProxies(['A'], 999_999)

    expect(result.timeout).toBe(SCRIPT_API_NAMED_PROBE_MAX_TIMEOUT)
  })

  it('区间内的 timeout 原样生效，小数取整', async () => {
    setProxies({ A: proxy('A') })

    const result = await probeNamedProxies(['A'], 2500.9)

    expect(result.timeout).toBe(2500)
  })

  it('非数字 timeout 退回默认值', async () => {
    setProxies({ A: proxy('A') })

    const result = await probeNamedProxies(['A'], Number.NaN)

    expect(result.timeout).toBe(DELAY_PROBE_QUICK_TIMEOUT)
  })
})

describe('probeNamedProxies 结果口径', () => {
  it('延迟 0 与测速抛错都算不可用，但仍逐个回报', async () => {
    setProxies({ A: proxy('A'), B: proxy('B'), C: proxy('C'), D: proxy('D') })
    delayMock.mockImplementation(async (name: string) => {
      if (name === 'A') return { delay: 132 }
      if (name === 'B') return { delay: 0 }
      if (name === 'C') throw new Error('connection refused')
      return { message: 'timeout' }
    })

    const result = await probeNamedProxies(['A', 'B', 'C', 'D'])

    expect(result.results).toEqual([
      { name: 'A', delay: 132 },
      { name: 'B', delay: 0 },
      { name: 'C', delay: 0 },
      { name: 'D', delay: 0 }
    ])
    expect(result.aliveCount).toBe(1)
  })

  it('同一个节点同时被两个请求点到时只测一次（in-flight 合并）', async () => {
    setProxies({ A: proxy('A'), B: proxy('B') })
    let release: (() => void) | null = null
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    delayMock.mockImplementation(async () => {
      await gate
      return { delay: 88 }
    })

    const first = probeNamedProxies(['A', 'B'])
    const second = probeNamedProxies(['A'])
    // 让两个请求都排到测速那一步
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    release?.()
    const [a, b] = await Promise.all([first, second])

    expect(a.results).toEqual([
      { name: 'A', delay: 88 },
      { name: 'B', delay: 88 }
    ])
    expect(b.results).toEqual([{ name: 'A', delay: 88 }])
    // A 被两个请求同时要，但只打了一次内核；B 一次 —— 合计 2 而不是 3
    expect(delayMock).toHaveBeenCalledTimes(2)
  })
})

describe('probeNamedProxies 并发闸门', () => {
  it('在飞的测速请求数不超过上限', async () => {
    const total = SCRIPT_API_NAMED_PROBE_CONCURRENCY + 60
    const names = Array.from({ length: total }, (_, i) => `N${i}`)
    const entries: Record<string, unknown> = {}
    for (const name of names) entries[name] = proxy(name)
    setProxies(entries)

    let inflight = 0
    let peak = 0
    delayMock.mockImplementation(async () => {
      inflight += 1
      peak = Math.max(peak, inflight)
      await new Promise((resolve) => setTimeout(resolve, 1))
      inflight -= 1
      return { delay: 50 }
    })

    const result = await probeNamedProxies(names)

    expect(result.accepted).toBe(Math.min(total, SCRIPT_API_NAMED_PROBE_MAX_NAMES))
    expect(peak).toBe(SCRIPT_API_NAMED_PROBE_CONCURRENCY)
    expect(inflight).toBe(0)
  })

  it('两个请求共享同一个闸门，总在飞数仍不超上限', async () => {
    const half = SCRIPT_API_NAMED_PROBE_CONCURRENCY
    const names = Array.from({ length: half * 2 }, (_, i) => `N${i}`)
    const entries: Record<string, unknown> = {}
    for (const name of names) entries[name] = proxy(name)
    setProxies(entries)

    let inflight = 0
    let peak = 0
    delayMock.mockImplementation(async () => {
      inflight += 1
      peak = Math.max(peak, inflight)
      await new Promise((resolve) => setTimeout(resolve, 1))
      inflight -= 1
      return { delay: 50 }
    })

    await Promise.all([
      probeNamedProxies(names.slice(0, half)),
      probeNamedProxies(names.slice(half))
    ])

    expect(peak).toBe(SCRIPT_API_NAMED_PROBE_CONCURRENCY)
    expect(inflight).toBe(0)
  })

  it('测速全部抛错时名额照样归还，不会把闸门卡死', async () => {
    const names = Array.from({ length: SCRIPT_API_NAMED_PROBE_CONCURRENCY + 5 }, (_, i) => `E${i}`)
    const entries: Record<string, unknown> = {}
    for (const name of names) entries[name] = proxy(name)
    setProxies(entries)
    delayMock.mockRejectedValue(new Error('boom'))

    const result = await probeNamedProxies(names)

    expect(result.aliveCount).toBe(0)
    expect(result.accepted).toBe(names.length)

    // 闸门没卡死：紧接着的一次探测还能正常跑完
    delayMock.mockResolvedValue({ delay: 70 })
    const after = await probeNamedProxies(['E0'])
    expect(after.results).toEqual([{ name: 'E0', delay: 70 }])
  })
})

describe('probeNamedProxies 不污染全局状态', () => {
  it('不刷新 lastProbeAt / lastProbedCount / lastAliveCount', async () => {
    setProxies({ A: proxy('A'), B: proxy('B') })
    const before = getDelayProbeSnapshot()
    const ageBefore = getDelayDataAgeMs()

    const result = await probeNamedProxies(['A', 'B'])

    expect(result.aliveCount).toBe(2)
    // 局部测几个节点不代表全局数据变新。刷了它 applyFreshness() 就会跳过真正需要的
    // 现测，脚本会拿到陈旧名单，而且表面上一切正常，极难排查。
    expect(getDelayProbeSnapshot()).toEqual(before)
    expect(getDelayDataAgeMs()).toBe(ageBefore)
  })
})
