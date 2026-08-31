import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 名单探测（probeNamedProxies）的单测。
 *
 * 这条路径的价值全在边界上：它是唯一由脚本直接决定测谁、测多少的入口，
 * 所以名单清洗（去重 / 未知 / 策略组 / 截断）、命中判定、并发闸门都必须钉住。
 *
 * 另外有四条纪律必须由测试保证，否则回归了根本看不出来：
 * 1. 内核测速 timeout 恒为 DELAY_PROBE_TIMEOUT，脚本传的 maxDelay 只过滤结果，
 *    绝不反向影响测量参数（历史 bug：timeout 被压到 1200ms，召回率从 89.5% 掉到 15.8%）；
 * 2. 不走 inflightProbe 单飞锁（否则会 join 一轮全量，返回与名单无关的数据）；
 * 3. 不动 state 里的任何字段（否则 GET /groups 的陈旧提示会失真）；
 * 4. 超龄记录一律重测，不返回旧值。
 */

vi.mock('croner', () => ({
  Cron: class {
    stop = vi.fn()
  }
}))
vi.mock('../utils/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))
vi.mock('../config', () => ({
  getAppConfig: vi.fn(async () => ({}))
}))
vi.mock('./mihomoApi', () => ({
  mihomoProxies: vi.fn(),
  mihomoProbeDelay: vi.fn()
}))

const { DELAY_PROBE_TIMEOUT, PROBE_GATE_CONCURRENCY, SCRIPT_API_NAMED_PROBE_MAX_NAMES } =
  await import('../../shared/appConfig')
const { DEFAULT_PROBE_URL, getDelayDataAgeMs, getDelayProbeSnapshot, probeNamedProxies } =
  await import('./delayProbe')
const { mihomoProbeDelay, mihomoProxies } = await import('./mihomoApi')
const { clearProbeStore, recordDelayResult } = await import('./probeStore')

const proxiesMock = vi.mocked(mihomoProxies)
const delayMock = vi.mocked(mihomoProbeDelay)

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

/** 内核 200 + 一个正常延迟 */
function ok(delay: number): { status: number; delay: number; message: string } {
  return { status: 200, delay, message: '' }
}

beforeEach(() => {
  clearProbeStore()
  proxiesMock.mockReset()
  delayMock.mockReset()
  delayMock.mockResolvedValue(ok(100))
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
    expect(result.results).toHaveLength(1)
    expect(result.results[0]).toMatchObject({ name: 'A', delay: 100, err: null, usable: true })
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

  it('每个送进来的名字都必须出现在 results / unknown / rejected 之一', async () => {
    setProxies({ A: proxy('A'), G: group('G', ['A']) })

    const result = await probeNamedProxies(['A', 'G', '不存在'])

    const covered = [
      ...result.results.map((item) => item.name),
      ...result.unknown,
      ...result.rejected
    ]
    expect(covered.sort()).toEqual(['A', 'G', '不存在'].sort())
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

describe('probeNamedProxies 测量参数固定', () => {
  it('内核测速 timeout 恒为 DELAY_PROBE_TIMEOUT，与 maxDelay 无关', async () => {
    setProxies({ A: proxy('A') })

    const loose = await probeNamedProxies(['A'], { maxDelay: 600 })
    const strict = await probeNamedProxies(['A'], { maxDelay: 50, maxAge: 0 })

    expect(loose.timeout).toBe(DELAY_PROBE_TIMEOUT)
    expect(strict.timeout).toBe(DELAY_PROBE_TIMEOUT)
    for (const call of delayMock.mock.calls) {
      expect(call[2]).toBe(DELAY_PROBE_TIMEOUT)
    }
  })

  it('脚本没传地址时用默认探测地址，并把它回给脚本自查', async () => {
    setProxies({ A: proxy('A') })

    const result = await probeNamedProxies(['A'])

    expect(result.url).toBe(DEFAULT_PROBE_URL)
    expect(delayMock).toHaveBeenCalledWith('A', DEFAULT_PROBE_URL, DELAY_PROBE_TIMEOUT)
  })

  it('脚本传的 probeUrl 生效；非法地址被忽略而不是让整轮全灭', async () => {
    setProxies({ A: proxy('A') })

    const custom = await probeNamedProxies(['A'], { probeUrl: 'https://api.ipify.org/', maxAge: 0 })
    expect(custom.url).toBe('https://api.ipify.org/')

    const bogus = await probeNamedProxies(['A'], { probeUrl: 'not a url', maxAge: 0 })
    expect(bogus.url).toBe(DEFAULT_PROBE_URL)

    const wrongScheme = await probeNamedProxies(['A'], { probeUrl: 'ftp://example.com', maxAge: 0 })
    expect(wrongScheme.url).toBe(DEFAULT_PROBE_URL)
  })
})

describe('probeNamedProxies 命中与重测', () => {
  it('命中足够新的记录时直接返回，不打内核', async () => {
    setProxies({ A: proxy('A') })
    recordDelayResult('A', { delay: 222, url: DEFAULT_PROBE_URL })

    const result = await probeNamedProxies(['A'], { maxAge: 300 })

    expect(result.freshCount).toBe(1)
    expect(result.probedCount).toBe(0)
    expect(result.results[0]).toMatchObject({ name: 'A', delay: 222, err: null, usable: true })
    expect(delayMock).not.toHaveBeenCalled()
  })

  it('超龄记录一律重测，不返回旧值', async () => {
    setProxies({ A: proxy('A') })
    recordDelayResult('A', { delay: 222, url: DEFAULT_PROBE_URL, at: Date.now() - 10 * 60 * 1000 })
    delayMock.mockResolvedValue(ok(333))

    const result = await probeNamedProxies(['A'], { maxAge: 300 })

    expect(result.freshCount).toBe(0)
    expect(result.probedCount).toBe(1)
    expect(result.results[0].delay).toBe(333)
    expect(result.results[0].ageMs).toBeLessThan(1000)
  })

  it('maxAge=0 强制现测，即使刚写过记录', async () => {
    setProxies({ A: proxy('A') })
    recordDelayResult('A', { delay: 222, url: DEFAULT_PROBE_URL })
    delayMock.mockResolvedValue(ok(444))

    const result = await probeNamedProxies(['A'], { maxAge: 0 })

    expect(result.probedCount).toBe(1)
    expect(result.results[0].delay).toBe(444)
  })

  it('换了测速地址的旧记录不算命中：不是同一口径的数据', async () => {
    setProxies({ A: proxy('A') })
    recordDelayResult('A', { delay: 222, url: 'https://api.ipify.org/' })
    delayMock.mockResolvedValue(ok(555))

    const result = await probeNamedProxies(['A'], { maxAge: 300 })

    expect(result.freshCount).toBe(0)
    expect(result.results[0].delay).toBe(555)
  })
})

describe('probeNamedProxies 结果口径', () => {
  it('504/503/其他状态码映射成可区分的 err，且都算不可用', async () => {
    setProxies({ A: proxy('A'), B: proxy('B'), C: proxy('C'), D: proxy('D') })
    delayMock.mockImplementation(async (name: string) => {
      if (name === 'A') return ok(132)
      // 被 deadline 截断 —— 节点可能完全健康，只是整链没跑完
      if (name === 'B') return { status: 504, delay: 0, message: 'timeout' }
      // 真连不上落地
      if (name === 'C') return { status: 503, delay: 0, message: 'unreachable' }
      // socket 层就没通：与节点质量无关
      return { status: 0, delay: 0, message: 'socket hang up' }
    })

    const result = await probeNamedProxies(['A', 'B', 'C', 'D'], { maxAge: 0 })

    expect(result.results).toEqual([
      expect.objectContaining({ name: 'A', delay: 132, err: null, usable: true }),
      expect.objectContaining({ name: 'B', delay: 0, err: 'timeout', usable: false }),
      expect.objectContaining({ name: 'C', delay: 0, err: 'unreachable', usable: false }),
      expect.objectContaining({ name: 'D', delay: 0, err: 'kernel_error', usable: false })
    ])
    expect(result.aliveCount).toBe(1)
  })

  it('maxDelay 只过滤结果：测通但太慢的节点仍回报延迟数字，只是 usable=false', async () => {
    setProxies({ A: proxy('A'), B: proxy('B') })
    delayMock.mockImplementation(async (name: string) => ok(name === 'A' ? 200 : 900))

    const result = await probeNamedProxies(['A', 'B'], { maxDelay: 600, maxAge: 0 })

    expect(result.aliveCount).toBe(2)
    expect(result.filteredCount).toBe(1)
    expect(result.results[1]).toMatchObject({ name: 'B', delay: 900, err: null, usable: false })
  })

  it('maxDelay 缺省或非法时不过滤', async () => {
    setProxies({ A: proxy('A') })
    delayMock.mockResolvedValue(ok(5000 - 100))

    const result = await probeNamedProxies(['A'], { maxDelay: Number.NaN, maxAge: 0 })

    expect(result.maxDelay).toBe(0)
    expect(result.filteredCount).toBe(0)
    expect(result.results[0].usable).toBe(true)
  })

  it('测速抛异常时记 kernel_error 而不是让整个请求失败', async () => {
    setProxies({ A: proxy('A'), B: proxy('B') })
    delayMock.mockImplementation(async (name: string) => {
      if (name === 'A') throw new Error('boom')
      return ok(120)
    })

    const result = await probeNamedProxies(['A', 'B'], { maxAge: 0 })

    expect(result.results[0]).toMatchObject({ name: 'A', delay: 0, err: 'kernel_error' })
    expect(result.results[1]).toMatchObject({ name: 'B', delay: 120, err: null })
  })

  it('同一个节点同时被两个请求点到时只测一次（in-flight 合并）', async () => {
    setProxies({ A: proxy('A'), B: proxy('B') })
    let release: (() => void) | null = null
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    delayMock.mockImplementation(async () => {
      await gate
      return ok(88)
    })

    const first = probeNamedProxies(['A', 'B'], { maxAge: 0 })
    const second = probeNamedProxies(['A'], { maxAge: 0 })
    // 让两个请求都排到测速那一步
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    release?.()
    const [a, b] = await Promise.all([first, second])

    expect(a.results.map((item) => item.delay)).toEqual([88, 88])
    expect(b.results.map((item) => item.delay)).toEqual([88])
    // A 被两个请求同时要，但只打了一次内核；B 一次 —— 合计 2 而不是 3
    expect(delayMock).toHaveBeenCalledTimes(2)
  })
})

describe('probeNamedProxies 并发闸门', () => {
  it('在飞的测速请求数不超过上限', async () => {
    const total = PROBE_GATE_CONCURRENCY + 60
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
      return ok(50)
    })

    const result = await probeNamedProxies(names, { maxAge: 0 })

    expect(result.accepted).toBe(Math.min(total, SCRIPT_API_NAMED_PROBE_MAX_NAMES))
    expect(peak).toBe(PROBE_GATE_CONCURRENCY)
    expect(inflight).toBe(0)
  })

  it('两个请求共享同一个闸门，总在飞数仍不超上限', async () => {
    const half = PROBE_GATE_CONCURRENCY
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
      return ok(50)
    })

    await Promise.all([
      probeNamedProxies(names.slice(0, half), { maxAge: 0 }),
      probeNamedProxies(names.slice(half), { maxAge: 0 })
    ])

    expect(peak).toBe(PROBE_GATE_CONCURRENCY)
    expect(inflight).toBe(0)
  })

  it('测速全部抛错时名额照样归还，不会把闸门卡死', async () => {
    const names = Array.from({ length: PROBE_GATE_CONCURRENCY + 5 }, (_, i) => `E${i}`)
    const entries: Record<string, unknown> = {}
    for (const name of names) entries[name] = proxy(name)
    setProxies(entries)
    delayMock.mockRejectedValue(new Error('boom'))

    const result = await probeNamedProxies(names, { maxAge: 0 })

    expect(result.aliveCount).toBe(0)
    expect(result.accepted).toBe(names.length)

    // 闸门没卡死：紧接着的一次探测还能正常跑完
    delayMock.mockResolvedValue(ok(70))
    const after = await probeNamedProxies(['E0'], { maxAge: 0 })
    expect(after.results[0]).toMatchObject({ name: 'E0', delay: 70 })
  })
})

describe('probeNamedProxies 不污染全局状态', () => {
  it('不刷新 lastProbeAt / lastProbedCount / lastAliveCount', async () => {
    setProxies({ A: proxy('A'), B: proxy('B') })
    const before = getDelayProbeSnapshot()
    const ageBefore = getDelayDataAgeMs()

    const result = await probeNamedProxies(['A', 'B'], { maxAge: 0 })

    expect(result.aliveCount).toBe(2)
    // 局部测几个节点不代表全局覆盖变新。刷了它 GET /groups 的陈旧提示就会失真，
    // 而且表面上一切正常，极难排查。
    expect(getDelayProbeSnapshot()).toEqual(before)
    expect(getDelayDataAgeMs()).toBe(ageBefore)
  })
})
