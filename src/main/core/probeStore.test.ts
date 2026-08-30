import { beforeEach, describe, expect, it } from 'vitest'

/**
 * probeStore 的单测。
 *
 * 这张表是判据的唯一真相源，所以它的每一条归一规则都必须钉住 —— 一旦某条规则松了，
 * 错误会以「脚本拿到一个看起来完全正常的延迟数字」的形式表现出来，从现象上无法察觉。
 *
 * 重点保护三件事：
 * 1. 天花板产物必须在【写入时】被归一成失败（读取方有多个，靠读取侧过滤必漏）；
 * 2. delay > 0 与 err 非 null 绝不共存（否则调用方两个字段会给出相反答案）；
 * 3. maxAge = 0 表示强制现测，不能被当成「无门槛」。
 */

import {
  DELAY_PROBE_CEILING_MARGIN_MS,
  DELAY_PROBE_TIMEOUT,
  PROBE_STORE_DEFAULT_MAX_AGE_MS
} from '../../shared/appConfig'
import {
  clearProbeStore,
  getDelayRecord,
  getFreshDelayRecord,
  getProbeStoreStats,
  getRecordAgeMs,
  isRecordUsable,
  pruneDelayRecords,
  recordDelayResult,
  resolveProbeMaxAgeMs
} from './probeStore'

const URL_A = 'https://www.gstatic.com/generate_204'
const URL_B = 'https://cp.cloudflare.com/generate_204'

beforeEach(() => {
  clearProbeStore()
})

describe('recordDelayResult 归一规则', () => {
  it('正常延迟原样写入，err 置 null', () => {
    const record = recordDelayResult('A', { delay: 187, url: URL_A, at: 1000 })

    expect(record).toEqual({ delay: 187, err: null, at: 1000, url: URL_A })
    expect(getDelayRecord('A')).toEqual(record)
  })

  it('小数延迟取整', () => {
    expect(recordDelayResult('A', { delay: 187.6, url: URL_A }).delay).toBe(188)
  })

  it('delay <= 0 一律记为失败，没给 err 时兜底成 timeout', () => {
    expect(recordDelayResult('A', { delay: 0, url: URL_A })).toMatchObject({
      delay: 0,
      err: 'timeout'
    })
    expect(recordDelayResult('B', { delay: -5, url: URL_A })).toMatchObject({
      delay: 0,
      err: 'timeout'
    })
    // 调用方给了原因就保留原因：区分「超时」和「连不上落地」是这次改造的核心收益
    expect(recordDelayResult('C', { delay: 0, err: 'unreachable', url: URL_A })).toMatchObject({
      delay: 0,
      err: 'unreachable'
    })
  })

  it('非数字延迟按失败处理，不写进 NaN', () => {
    const record = recordDelayResult('A', { delay: Number.NaN, url: URL_A })

    expect(record.delay).toBe(0)
    expect(record.err).toBe('timeout')
  })

  it('顶到天花板的延迟被归一成失败（504 的副产品，不是真延迟）', () => {
    // 内核 URLTest 的 defer 里 err == nil，于是 history 记了一条 delay ≈ timeout、
    // alive = true 的记录，但 API 层因 ctx 超时返回 504。信 API 层。
    const ceiling = recordDelayResult('A', { delay: DELAY_PROBE_TIMEOUT, url: URL_A })
    expect(ceiling).toMatchObject({ delay: 0, err: 'timeout' })

    const justUnder = recordDelayResult('B', {
      delay: DELAY_PROBE_TIMEOUT - DELAY_PROBE_CEILING_MARGIN_MS,
      url: URL_A
    })
    expect(justUnder).toMatchObject({ delay: 0, err: 'timeout' })

    // 余量之外的值是真实测量结果，必须保留
    const legit = recordDelayResult('C', {
      delay: DELAY_PROBE_TIMEOUT - DELAY_PROBE_CEILING_MARGIN_MS - 1,
      url: URL_A
    })
    expect(legit.delay).toBe(DELAY_PROBE_TIMEOUT - DELAY_PROBE_CEILING_MARGIN_MS - 1)
    expect(legit.err).toBeNull()
  })

  it('delay > 0 时 err 必定为 null：两个字段不允许给出相反答案', () => {
    const record = recordDelayResult('A', { delay: 200, err: 'timeout', url: URL_A })

    expect(record.delay).toBe(200)
    expect(record.err).toBeNull()
  })

  it('同名重复写入按最后一次为准', () => {
    recordDelayResult('A', { delay: 100, url: URL_A, at: 1000 })
    recordDelayResult('A', { delay: 0, err: 'tls_failed', url: URL_B, at: 2000 })

    expect(getDelayRecord('A')).toEqual({ delay: 0, err: 'tls_failed', at: 2000, url: URL_B })
  })
})

describe('新鲜度与年龄', () => {
  it('没有记录时年龄是 null，用来区分「没数据」和「数据旧」', () => {
    expect(getRecordAgeMs('A')).toBeNull()

    recordDelayResult('A', { delay: 100, url: URL_A, at: 1000 })
    expect(getRecordAgeMs('A', 4000)).toBe(3000)
  })

  it('时钟回拨时年龄不为负', () => {
    recordDelayResult('A', { delay: 100, url: URL_A, at: 5000 })

    expect(getRecordAgeMs('A', 1000)).toBe(0)
  })

  it('getFreshDelayRecord 只在年龄不超过门槛时命中', () => {
    recordDelayResult('A', { delay: 100, url: URL_A, at: 1000 })

    expect(getFreshDelayRecord('A', 1000, 2000)).toBeDefined()
    // 边界：正好等于门槛算新鲜
    expect(getFreshDelayRecord('A', 1000, 2000)?.delay).toBe(100)
    expect(getFreshDelayRecord('A', 1000, 2001)).toBeUndefined()
    expect(getFreshDelayRecord('missing', 999_999, 2000)).toBeUndefined()
  })

  it('maxAgeMs = 0 时任何已有记录都算过期（强制现测）', () => {
    recordDelayResult('A', { delay: 100, url: URL_A, at: 1000 })

    expect(getFreshDelayRecord('A', 0, 1000)).toBeDefined()
    expect(getFreshDelayRecord('A', 0, 1001)).toBeUndefined()
  })

  it('极大 maxAgeMs 不会被内部逻辑截断', () => {
    recordDelayResult('A', { delay: 100, url: URL_A, at: 1 })

    expect(getFreshDelayRecord('A', Number.MAX_SAFE_INTEGER, Date.now())?.delay).toBe(100)
  })
})

describe('isRecordUsable', () => {
  it('没有记录一律不算能用：没数据不等于能用', () => {
    expect(isRecordUsable(undefined, 600)).toBe(false)
  })

  it('测通且不慢于阈值才算能用', () => {
    const fast = recordDelayResult('A', { delay: 200, url: URL_A })
    const slow = recordDelayResult('B', { delay: 900, url: URL_A })
    const dead = recordDelayResult('C', { delay: 0, err: 'unreachable', url: URL_A })

    expect(isRecordUsable(fast, 600)).toBe(true)
    expect(isRecordUsable(slow, 600)).toBe(false)
    expect(isRecordUsable(dead, 600)).toBe(false)
    // 边界：正好等于阈值算能用
    expect(isRecordUsable(recordDelayResult('D', { delay: 600, url: URL_A }), 600)).toBe(true)
  })
})

describe('pruneDelayRecords', () => {
  it('只保留名单里的记录，返回清掉的条数', () => {
    recordDelayResult('A', { delay: 100, url: URL_A })
    recordDelayResult('B', { delay: 100, url: URL_A })
    recordDelayResult('C', { delay: 0, url: URL_A })

    const removed = pruneDelayRecords(new Set(['A', 'C']))

    expect(removed).toBe(1)
    expect(getDelayRecord('A')).toBeDefined()
    expect(getDelayRecord('B')).toBeUndefined()
    expect(getDelayRecord('C')).toBeDefined()
  })

  it('空名单会清空整张表 —— 所以只允许在全量基线跑完后调用', () => {
    recordDelayResult('A', { delay: 100, url: URL_A })

    expect(pruneDelayRecords(new Set())).toBe(1)
    expect(getProbeStoreStats().size).toBe(0)
  })
})

describe('getProbeStoreStats', () => {
  it('空表', () => {
    expect(getProbeStoreStats()).toEqual({ size: 0, alive: 0, newestAt: null })
  })

  it('alive 只数 delay > 0，newestAt 取最大时间戳', () => {
    recordDelayResult('A', { delay: 100, url: URL_A, at: 1000 })
    recordDelayResult('B', { delay: 0, err: 'timeout', url: URL_A, at: 3000 })
    recordDelayResult('C', { delay: 250, url: URL_A, at: 2000 })

    expect(getProbeStoreStats()).toEqual({ size: 3, alive: 2, newestAt: 3000 })
  })
})

describe('resolveProbeMaxAgeMs', () => {
  it('非数字取默认值', () => {
    expect(resolveProbeMaxAgeMs(undefined)).toBe(PROBE_STORE_DEFAULT_MAX_AGE_MS)
    expect(resolveProbeMaxAgeMs('300')).toBe(PROBE_STORE_DEFAULT_MAX_AGE_MS)
    expect(resolveProbeMaxAgeMs(Number.NaN)).toBe(PROBE_STORE_DEFAULT_MAX_AGE_MS)
    expect(resolveProbeMaxAgeMs(Number.POSITIVE_INFINITY)).toBe(PROBE_STORE_DEFAULT_MAX_AGE_MS)
  })

  it('秒换算成毫秒，小数取整', () => {
    expect(resolveProbeMaxAgeMs(300)).toBe(300_000)
    expect(resolveProbeMaxAgeMs(30.9)).toBe(30_000)
  })

  it('0 与负数都表示强制现测，不能被当成「无门槛」', () => {
    expect(resolveProbeMaxAgeMs(0)).toBe(0)
    expect(resolveProbeMaxAgeMs(-1)).toBe(0)
  })
})
