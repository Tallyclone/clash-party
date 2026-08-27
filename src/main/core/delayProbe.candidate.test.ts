import { describe, expect, it, vi } from 'vitest'

/**
 * 候选池判定（isProbeCandidate）的单测。
 *
 * 背景：原实现只看 history 最后一条，于是一次失败等于永久除名 —— 现测超时压到
 * 1200ms，内核会把超时记成 delay 0（与「连不上」无法区分），一个真实延迟抖到
 * 1300ms 的健康节点就此掉出候选池，之后所有现测都不再碰它，只能等 30 分钟后的
 * 全量把它捞回来。实测 426 个节点的订阅里有 94 个（22%）处于抖动状态。
 *
 * 改为回看最近 DELAY_PROBE_CANDIDATE_HISTORY_COUNT 条，语义是「容忍 N-1 次连续失败」。
 */

// delayProbe 会连带拉起 mihomoApi -> electron，桩掉这条链，只测纯函数
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
  DELAY_PROBE_CANDIDATE_HISTORY_COUNT,
  DELAY_PROBE_CANDIDATE_MAX_AGE_MS,
  DELAY_PROBE_CANDIDATE_MAX_DELAY,
  DELAY_PROBE_FULL_INTERVAL_MINUTES
} = await import('../../shared/appConfig')
const { isProbeCandidate } = await import('./delayProbe')

const NOW = Date.parse('2026-08-27T12:00:00.000+08:00')

/** 造一条记录：minutesAgo 分钟前测出 delay */
function record(delay: number, minutesAgo = 0): IMihomoHistory {
  return { delay, time: new Date(NOW - minutesAgo * 60_000).toISOString() }
}

describe('isProbeCandidate', () => {
  it('常量关系必须成立：时间窗要装得下 N-1 个全量间隔', () => {
    // 否则时间窗会先咬住条数，让回看机制失效 —— 实测 79% 的节点是 30 分钟一条记录，
    // 时间窗设成 30 分钟时窗口内只剩最后那 1 条，等于把整个机制关掉
    expect(DELAY_PROBE_CANDIDATE_MAX_AGE_MS).toBeGreaterThanOrEqual(
      (DELAY_PROBE_CANDIDATE_HISTORY_COUNT - 1) * DELAY_PROBE_FULL_INTERVAL_MINUTES * 60_000
    )
  })

  it('没有历史一律不算候选', () => {
    expect(isProbeCandidate(undefined, NOW)).toBe(false)
    expect(isProbeCandidate([], NOW)).toBe(false)
  })

  it('最后一条达标 → 候选（旧行为不回归）', () => {
    expect(isProbeCandidate([record(320)], NOW)).toBe(true)
  })

  it('最后一条是 0、但倒数第二条达标 → 候选（本次改动的核心）', () => {
    const history = [record(280, 60), record(0, 30)]
    expect(isProbeCandidate(history, NOW)).toBe(true)
  })

  it('最近 N 条全是 0 → 淘汰（容忍不是无限的）', () => {
    const history = [
      record(280, 80),
      ...Array.from({ length: DELAY_PROBE_CANDIDATE_HISTORY_COUNT }, (_, i) =>
        record(0, 20 - i * 5)
      )
    ]
    expect(isProbeCandidate(history, NOW)).toBe(false)
  })

  it('达标记录太旧 → 淘汰', () => {
    const tooOld = DELAY_PROBE_CANDIDATE_MAX_AGE_MS / 60_000 + 1
    expect(isProbeCandidate([record(300, tooOld)], NOW)).toBe(false)
  })

  it('时间窗边界是闭区间', () => {
    const exactly = DELAY_PROBE_CANDIDATE_MAX_AGE_MS / 60_000
    expect(isProbeCandidate([record(300, exactly)], NOW)).toBe(true)
  })

  it('延迟上限边界是闭区间', () => {
    expect(isProbeCandidate([record(DELAY_PROBE_CANDIDATE_MAX_DELAY)], NOW)).toBe(true)
    expect(isProbeCandidate([record(DELAY_PROBE_CANDIDATE_MAX_DELAY + 1)], NOW)).toBe(false)
  })

  it('delay 为 0 或负数不算达标', () => {
    expect(isProbeCandidate([record(0)], NOW)).toBe(false)
    expect(isProbeCandidate([record(-1)], NOW)).toBe(false)
  })

  it('delay 不是数字时安全返回 false', () => {
    const broken = [{ delay: undefined, time: new Date(NOW).toISOString() }]
    expect(isProbeCandidate(broken as unknown as IMihomoHistory[], NOW)).toBe(false)
  })

  it('时间解析失败时不因此排除 —— 否则候选池会恒空、每轮退化成测全部', () => {
    expect(isProbeCandidate([{ delay: 300, time: 'not-a-date' }], NOW)).toBe(true)
    expect(isProbeCandidate([{ delay: 300, time: '' }], NOW)).toBe(true)
  })

  it('认得内核真实的时间格式（带时区偏移与 7 位小数秒）', () => {
    // 实测样本，别改成 toISOString() —— 这条就是用来钉住格式假设的
    const history = [{ delay: 300, time: '2026-08-27T11:55:00.0710136+08:00' }]
    expect(isProbeCandidate(history, NOW)).toBe(true)
    expect(isProbeCandidate([{ delay: 300, time: '2026-08-27T07:00:00.0710136+08:00' }], NOW)).toBe(
      false // 5 小时前，超出时间窗
    )
  })

  it('count 设为 1 时精确等价于「只看最后一条」的旧行为（回滚开关）', () => {
    const flapping = [record(280, 60), record(0, 30)]
    expect(isProbeCandidate(flapping, NOW, { count: 1 })).toBe(false)
    expect(isProbeCandidate([record(280, 30)], NOW, { count: 1 })).toBe(true)
  })

  it('只回看尾部 count 条，更早的达标记录不参与', () => {
    const history = [record(280, 50), record(0, 40), record(0, 30), record(0, 20)]
    expect(isProbeCandidate(history, NOW, { count: 3 })).toBe(false)
    expect(isProbeCandidate(history, NOW, { count: 4 })).toBe(true)
  })
})
