import { createServer, Server, Socket } from 'net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 探测工位（`POST /probe mode=ip`）的单测。
 *
 * 这里跑的是**真实 socket**：在 127.0.0.1 上起几个假的 HTTP CONNECT 代理当工位，
 * 再把探测目标换成明文 http，于是 dialTarget 的整条链路（CONNECT → GET → 解析 IP）
 * 都被真的走了一遍。用 mock 替 net/tls 只能证明代码调了哪些函数，证明不了协议解析对不对，
 * 而这个模块出过的两次事故（端口错位、坏端口疯狂抢任务）恰恰都在协议/调度层面。
 *
 * 被钉住的不变量：
 * 1. 组名 ↔ 端口的换算只有一份实现（probeStationPorts 与 shared 的 helper 同源）；
 * 2. 池子里只放【预检通过】的端口，一个都不听时必须明确报错而不是给一片 dial_failed；
 * 3. 工位用完立即归还 —— 配额小于名单时必须靠复用把剩下的跑完，不能卡死；
 * 4. totalMs === queueMs + connectMs + responseMs 严格成立；
 * 5. 本地端口连不上记 dial_failed（工位坏了），隧道被拒记 unreachable（落地不通）。
 */

/** 固定端口区间，避开常用端口。工位 3 个：39140~39142 */
const PORT_BASE = 39140
const STATION_COUNT = 3

vi.mock('../../shared/appConfig', async () => {
  const actual =
    await vi.importActual<typeof import('../../shared/appConfig')>('../../shared/appConfig')
  return {
    ...actual,
    PROBE_STATION_COUNT: 3,
    PROBE_STATION_PORT_BASE: 39140,
    PROBE_STATION_PORT_SEARCH_END: 39200,
    PROBE_STATION_PER_REQUEST_QUOTA: 2,
    PROBE_STATION_DIAL_FAIL_THRESHOLD: 2,
    // 明文 http：让 dialTarget 跳过 TLS，假代理就能自己把响应写回去
    PROBE_IP_TARGETS: ['http://probe.invalid/trace'],
    PROBE_IP_TARGET_TIMEOUT_MS: 1500,
    PROBE_IP_MAX_NAMES: 4
  }
})
vi.mock('../utils/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))
vi.mock('./delayProbe', () => ({
  // 与真实实现同口径的简化版：策略组和内置出口不可探测。
  // 完整口径由 delayProbe 自己的单测负责，这里只需要分类行为。
  isProbeableProxy: (name: string, proxy: unknown): boolean => {
    if (!proxy || typeof proxy !== 'object') return false
    if ('all' in proxy) return false
    return name !== 'DIRECT' && name !== 'REJECT'
  },
  triggerBaselineProbe: vi.fn()
}))
vi.mock('./mihomoApi', () => ({
  mihomoProxies: vi.fn(),
  mihomoChangeProxy: vi.fn(async () => {})
}))

const { PROBE_STATION_GROUP_PREFIX } = await import('../../shared/appConfig')
const { probeStationGroupName, probeStationPort } = await import('../../shared/scriptOutlet')
const { setProbeStationPorts } = await import('./probeStationRegistry')
const { notifyProbeConfigReloaded, probeIpByStations, probeStationPorts, resetProbeStations } =
  await import('./probeStation')
const { triggerBaselineProbe } = await import('./delayProbe')
const { mihomoChangeProxy, mihomoProxies } = await import('./mihomoApi')

const proxiesMock = vi.mocked(mihomoProxies)
const changeProxyMock = vi.mocked(mihomoChangeProxy)

function proxy(name: string): unknown {
  return { name, type: 'vless', alive: true, history: [], extra: {} }
}

function group(name: string, all: string[] = []): unknown {
  return { name, type: 'Selector', all, alive: true, history: [], extra: {}, now: all[0] ?? '' }
}

function setProxies(entries: Record<string, unknown>): void {
  proxiesMock.mockResolvedValue({ proxies: entries } as unknown as IMihomoProxies)
}

const TRACE_BODY = 'fl=abc\nip=203.0.113.7\nts=1\nloc=SG\n'

/**
 * 假工位：一个只懂 CONNECT 的极简本地代理。
 *
 * behavior:
 * - 'ok'      : CONNECT 回 200，随后把 GET 的响应自己写回去（不真的出网）
 * - 'refuse'  : CONNECT 回 502 —— 对应「内核到落地这一段没通」
 * - 'garbage' : 隧道建了，但响应是 403 —— 对应落地机劫持
 */
function createStation(
  port: number,
  behavior: 'ok' | 'refuse' | 'garbage' = 'ok'
): Promise<Server> {
  const server = createServer((socket: Socket) => {
    let phase: 'connect' | 'request' = 'connect'
    let buffer = ''
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('latin1')
      if (buffer.indexOf('\r\n\r\n') < 0) return
      if (phase === 'connect') {
        buffer = ''
        if (behavior === 'refuse') {
          socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n')
          return
        }
        phase = 'request'
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        return
      }
      const body = behavior === 'garbage' ? 'blocked' : TRACE_BODY
      const status = behavior === 'garbage' ? '403 Forbidden' : '200 OK'
      socket.end(
        `HTTP/1.1 ${status}\r\nContent-Type: text/plain\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`
      )
    })
    socket.on('error', () => {})
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve(server))
  })
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve())
  })
}

let servers: Server[] = []

async function startStations(
  behaviors: ('ok' | 'refuse' | 'garbage')[] = Array(STATION_COUNT).fill('ok')
): Promise<void> {
  servers = []
  for (let index = 0; index < behaviors.length; index += 1) {
    servers.push(await createStation(PORT_BASE + index, behaviors[index]))
  }
}

beforeEach(() => {
  proxiesMock.mockReset()
  changeProxyMock.mockClear()
  changeProxyMock.mockResolvedValue(undefined as never)
  // 端口来自注入侧的登记表（生产里由 factory.ts 生成配置时写入），
  // 拨测侧不再按常量推算，所以用例必须自己先登记一份。
  setProbeStationPorts(
    Array.from({ length: STATION_COUNT }, (_, index) => PORT_BASE + index),
    PORT_BASE
  )
  // 每个用例都强制重新预检：池子缓存的是「哪些端口在监听」，而用例之间端口会变
  resetProbeStations()
})

afterEach(async () => {
  for (const server of servers) await closeServer(server)
  servers = []
  resetProbeStations()
})

describe('端口来源与组名换算', () => {
  it('probeStationPorts 直接返回注入侧登记的端口，不做推算', () => {
    expect(probeStationPorts()).toEqual([PORT_BASE, PORT_BASE + 1, PORT_BASE + 2])
  })

  it('注入侧平移窗口时拨测侧跟着走 —— 两边各算一份是踩过的坑', () => {
    // 曾经把 port = base + index 在实验脚本里写成别的算法，结果 PUT 了一个组
    // 却从下一个组的端口出网，整轮只反复拨测了几个固定节点，而结果看起来完全正常。
    // 现在端口只有一个来源，注入侧为了避开用户业务出口而整段让位时不会再错位。
    const shifted = [48000, 48001, 48002]
    setProbeStationPorts(shifted, 48000)
    expect(probeStationPorts()).toEqual(shifted)

    probeStationPorts().forEach((port, index) => {
      // 组名一律由【端口】派生，不由 index 派生，所以窗口平移后对应关系天然一致
      expect(port).toBe(probeStationPort(48000, index))
      expect(probeStationGroupName(port)).toBe(`${PROBE_STATION_GROUP_PREFIX}${port}`)
    })
  })

  it('注入 0 个工位时端口表为空', () => {
    setProbeStationPorts([], null)
    expect(probeStationPorts()).toEqual([])
  })
})

describe('probeIpByStations 名单清洗', () => {
  beforeEach(async () => {
    await startStations()
  })

  it('去重保序、策略组进 rejected、未知名进 unknown，每个名字都有归属', async () => {
    setProxies({ A: proxy('A'), B: proxy('B'), G: group('G', ['A']), DIRECT: proxy('DIRECT') })

    const result = await probeIpByStations(['B', 'A', 'B', 'G', 'DIRECT', '没了的节点'])

    expect(result.received).toBe(6)
    expect(result.deduped).toBe(5)
    expect(result.accepted).toBe(2)
    expect(result.results.map((item) => item.name)).toEqual(['B', 'A'])
    expect(result.rejected).toEqual(['G', 'DIRECT'])
    expect(result.unknown).toEqual(['没了的节点'])

    const covered = [
      ...result.results.map((item) => item.name),
      ...result.rejected,
      ...result.unknown
    ]
    expect(covered.sort()).toEqual(['A', 'B', 'DIRECT', 'G', '没了的节点'].sort())
  })

  it('超过上限的名字被截掉，只回计数', async () => {
    const names = ['N0', 'N1', 'N2', 'N3', 'N4', 'N5']
    const entries: Record<string, unknown> = {}
    for (const name of names) entries[name] = proxy(name)
    setProxies(entries)

    const result = await probeIpByStations(names)

    expect(result.limit).toBe(4)
    expect(result.accepted).toBe(4)
    expect(result.truncated).toBe(2)
    expect(result.results).toHaveLength(4)
  })

  it('names 不是数组时按空名单处理，不抛异常也不切组', async () => {
    setProxies({ A: proxy('A') })

    const result = await probeIpByStations('A')

    expect(result.accepted).toBe(0)
    expect(result.results).toEqual([])
    expect(changeProxyMock).not.toHaveBeenCalled()
  })
})

describe('probeIpByStations 拨测结果', () => {
  it('解析出 IP / loc / ipFamily，并把工位组切到目标节点', async () => {
    await startStations()
    setProxies({ A: proxy('A') })

    const result = await probeIpByStations(['A'])

    expect(result.okCount).toBe(1)
    const item = result.results[0]
    expect(item).toMatchObject({
      name: 'A',
      ip: '203.0.113.7',
      ipFamily: 4,
      loc: 'SG',
      target: 'http://probe.invalid/trace',
      err: null
    })
    // 切的必须是工位专用组，绝不能碰业务组
    expect(changeProxyMock).toHaveBeenCalledTimes(1)
    expect(changeProxyMock.mock.calls[0][0]).toMatch(
      new RegExp(`^${PROBE_STATION_GROUP_PREFIX}\\d+$`)
    )
    expect(changeProxyMock.mock.calls[0][1]).toBe('A')
  })

  it('totalMs 严格等于 queueMs + connectMs + responseMs', async () => {
    await startStations()
    setProxies({ A: proxy('A'), B: proxy('B') })

    const result = await probeIpByStations(['A', 'B'])

    for (const item of result.results) {
      expect(item.connectMs).not.toBeNull()
      expect(item.responseMs).not.toBeNull()
      expect(item.totalMs).toBe(item.queueMs + (item.connectMs ?? 0) + (item.responseMs ?? 0))
    }
  })

  it('配额小于名单时靠复用把剩下的跑完（工位必须逐个立即归还）', async () => {
    await startStations()
    const names = ['A', 'B', 'C', 'D']
    const entries: Record<string, unknown> = {}
    for (const name of names) entries[name] = proxy(name)
    setProxies(entries)

    const result = await probeIpByStations(names)

    // 配额 2、名单 4：只有在用完立即归还的前提下才可能全部拿到结果
    expect(result.stations.quota).toBe(2)
    expect(result.stations.granted).toBe(2)
    expect(result.results).toHaveLength(4)
    expect(result.okCount).toBe(4)
    expect(result.results.map((item) => item.name)).toEqual(names)
  })

  it('隧道被拒记 unreachable（落地不通，不是工位坏）', async () => {
    await startStations(['refuse', 'refuse', 'refuse'])
    setProxies({ A: proxy('A') })

    const result = await probeIpByStations(['A'])

    expect(result.results[0]).toMatchObject({ name: 'A', ip: null, err: 'unreachable' })
    expect(result.okCount).toBe(0)
  })

  it('有响应但不是 2xx 记 bad_response（落地机劫持）', async () => {
    await startStations(['garbage', 'garbage', 'garbage'])
    setProxies({ A: proxy('A') })

    const result = await probeIpByStations(['A'])

    expect(result.results[0]).toMatchObject({ name: 'A', ip: null, err: 'bad_response' })
  })

  it('切组失败记 kernel_error，且不影响其余节点', async () => {
    await startStations()
    setProxies({ A: proxy('A'), B: proxy('B') })
    changeProxyMock.mockImplementation(async (_group: string, name: string) => {
      if (name === 'A') throw new Error('kernel says no')
    })

    const result = await probeIpByStations(['A', 'B'])

    expect(result.results[0]).toMatchObject({ name: 'A', err: 'kernel_error', ip: null })
    expect(result.results[1]).toMatchObject({ name: 'B', err: null, ip: '203.0.113.7' })
  })

  it('工位在预检之后挂掉时记 dial_failed，而不是当成节点问题', async () => {
    await startStations()
    setProxies({ A: proxy('A'), B: proxy('B'), C: proxy('C') })
    // 先跑一次让池子建立（预检通过），再把所有工位拔掉
    await probeIpByStations(['A'])
    for (const server of servers) await closeServer(server)
    servers = []

    const result = await probeIpByStations(['B', 'C'])

    // 连续 dial_failed 达到阈值会熔断工位，但当次结果必须诚实地报 dial_failed：
    // 它的语义是「工位坏了」，业务侧据此重试而不是把节点标成不可用。
    for (const item of result.results) {
      expect(item.err).toBe('dial_failed')
      expect(item.ip).toBeNull()
    }
  })
})

describe('工位池生命周期', () => {
  it('端口在册但没有一个在监听时报"内核还没重载"', async () => {
    setProxies({ A: proxy('A') })

    await expect(probeIpByStations(['A'])).rejects.toThrow(/no probe station is listening/)
  })

  it('端口表为空时报"压根没注入"，与上一条区分开', async () => {
    // 两种成因的排障方向完全不同：一个查内核有没有重载，一个查配置生成阶段
    // 为什么没注入（脚本 API 关着 / 找不到连续空闲窗口）。
    setProbeStationPorts([], null)
    setProxies({ A: proxy('A') })

    await expect(probeIpByStations(['A'])).rejects.toThrow(/no probe station was injected/)
  })

  it('notifyProbeConfigReloaded 会重置预检结果并触发一轮基线', async () => {
    await startStations()
    setProxies({ A: proxy('A') })

    const first = await probeIpByStations(['A'])
    expect(first.stations.pool).toBe(STATION_COUNT)

    for (const server of servers) await closeServer(server)
    servers = []
    vi.mocked(triggerBaselineProbe).mockClear()

    notifyProbeConfigReloaded('config-hot-reload')

    // 重置了预检 → 下一次会重新探端口，此时全都不在监听
    expect(vi.mocked(triggerBaselineProbe)).toHaveBeenCalledWith('config-hot-reload')
    await expect(probeIpByStations(['A'])).rejects.toThrow(/no probe station is listening/)
  })
})
