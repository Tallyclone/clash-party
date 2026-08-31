import { beforeEach, describe, expect, it } from 'vitest'
import { PROBE_GATE_CONCURRENCY } from '../../shared/appConfig'
import {
  acquireProbeSlots,
  probeGateInflight,
  probeGateWaiting,
  releaseProbeSlots,
  resetProbeGate
} from './probeGate'

/**
 * 这些用例锁的都是**刻意设计**的语义，不是实现细节：
 * 队头阻塞、有人排队就不许直取、申请量夹到上限。
 * 任何一条被"优化"掉都会重新引入之前踩过的坑（饿死 / 超上限 / 永久挂住），
 * 所以改动这些断言前先读 probeGate.ts 的文件级注释。
 */
beforeEach(() => {
  resetProbeGate()
})

/** 让已经就绪的 microtask 队列跑完，用来观察"该不该被唤醒" */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve()
}

describe('probeGate 基本收放', () => {
  it('没到上限时直接拿到，返回值等于申请量', async () => {
    expect(await acquireProbeSlots(1)).toBe(1)
    expect(probeGateInflight()).toBe(1)

    expect(await acquireProbeSlots(3)).toBe(3)
    expect(probeGateInflight()).toBe(4)

    releaseProbeSlots(1)
    releaseProbeSlots(3)
    expect(probeGateInflight()).toBe(0)
    expect(probeGateWaiting()).toBe(0)
  })

  it('省略参数时按 1 个名额算', async () => {
    expect(await acquireProbeSlots()).toBe(1)
    expect(probeGateInflight()).toBe(1)
  })

  it('归还量对得上就不会泄漏：跑满一整轮后 inflight 归零', async () => {
    const total = PROBE_GATE_CONCURRENCY + 37
    await Promise.all(
      Array.from({ length: total }, async () => {
        const slots = await acquireProbeSlots(1)
        await new Promise((resolve) => setTimeout(resolve, 0))
        releaseProbeSlots(slots)
      })
    )

    expect(probeGateInflight()).toBe(0)
    expect(probeGateWaiting()).toBe(0)
  })
})

describe('probeGate 上限', () => {
  it('单名额申请：在飞数永不超过上限', async () => {
    const total = PROBE_GATE_CONCURRENCY + 50
    let peak = 0

    await Promise.all(
      Array.from({ length: total }, async () => {
        const slots = await acquireProbeSlots(1)
        peak = Math.max(peak, probeGateInflight())
        await new Promise((resolve) => setTimeout(resolve, 1))
        releaseProbeSlots(slots)
      })
    )

    expect(peak).toBe(PROBE_GATE_CONCURRENCY)
    expect(probeGateInflight()).toBe(0)
  })

  it('单名额与 3 名额混着申请，在飞数仍不超上限', async () => {
    let peak = 0
    const task = async (need: number): Promise<void> => {
      const slots = await acquireProbeSlots(need)
      peak = Math.max(peak, probeGateInflight())
      await new Promise((resolve) => setTimeout(resolve, 1))
      releaseProbeSlots(slots)
    }

    // 交替混排，模拟"基线在跑 + 工位拨测插进来"
    await Promise.all(
      Array.from({ length: PROBE_GATE_CONCURRENCY + 40 }, (_, i) => task(i % 4 === 0 ? 3 : 1))
    )

    expect(peak).toBeLessThanOrEqual(PROBE_GATE_CONCURRENCY)
    expect(probeGateInflight()).toBe(0)
  })
})

describe('probeGate 排队语义', () => {
  it('有人排队时，后到的小额申请不许直取（先到先得）', async () => {
    // 占满
    const held: number[] = []
    for (let i = 0; i < PROBE_GATE_CONCURRENCY; i += 1) held.push(await acquireProbeSlots(1))

    let firstDone = false
    let secondDone = false
    const first = acquireProbeSlots(1).then((n) => {
      firstDone = true
      return n
    })
    const second = acquireProbeSlots(1).then((n) => {
      secondDone = true
      return n
    })

    await flush()
    expect(probeGateWaiting()).toBe(2)
    expect(firstDone).toBe(false)
    expect(secondDone).toBe(false)

    // 只放一个名额出来：必须是排在前面的那个拿到
    releaseProbeSlots(held.pop() as number)
    await flush()
    expect(firstDone).toBe(true)
    expect(secondDone).toBe(false)

    releaseProbeSlots(await first)
    await flush()
    releaseProbeSlots(await second)
    for (const n of held) releaseProbeSlots(n)
    expect(probeGateInflight()).toBe(0)
  })

  it('队头阻塞是刻意的：队头要 3 个而只剩 2 个时，后面要 1 个的不许插队', async () => {
    const held: number[] = []
    for (let i = 0; i < PROBE_GATE_CONCURRENCY; i += 1) held.push(await acquireProbeSlots(1))

    let bigDone = false
    let smallDone = false
    const big = acquireProbeSlots(3).then((n) => {
      bigDone = true
      return n
    })
    const small = acquireProbeSlots(1).then((n) => {
      smallDone = true
      return n
    })
    await flush()
    expect(probeGateWaiting()).toBe(2)

    // 只放出 2 个名额：不够队头的 3 个，宁可空着也不给后面的 1 个
    releaseProbeSlots(held.pop() as number)
    releaseProbeSlots(held.pop() as number)
    await flush()
    expect(bigDone).toBe(false)
    expect(smallDone).toBe(false)
    expect(probeGateInflight()).toBe(PROBE_GATE_CONCURRENCY - 2)

    // 第三个名额到位，队头先走，随后小额才跟上
    releaseProbeSlots(held.pop() as number)
    await flush()
    expect(bigDone).toBe(true)
    expect(smallDone).toBe(false)

    releaseProbeSlots(await big)
    await flush()
    expect(smallDone).toBe(true)

    releaseProbeSlots(await small)
    for (const n of held) releaseProbeSlots(n)
    expect(probeGateInflight()).toBe(0)
    expect(probeGateWaiting()).toBe(0)
  })
})

describe('probeGate 申请量归一化', () => {
  it('0 / 负数 / NaN 都按 1 个名额算', async () => {
    expect(await acquireProbeSlots(0)).toBe(1)
    expect(await acquireProbeSlots(-1)).toBe(1)
    expect(await acquireProbeSlots(Number.NaN)).toBe(1)
    expect(probeGateInflight()).toBe(3)
  })

  it('小数向下取整', async () => {
    expect(await acquireProbeSlots(7.9)).toBe(7)
    expect(probeGateInflight()).toBe(7)
  })

  it('Infinity 不是"要无限多"，按 1 个名额算', async () => {
    expect(await acquireProbeSlots(Number.POSITIVE_INFINITY)).toBe(1)
    expect(probeGateInflight()).toBe(1)
  })

  it('超过上限的申请被夹到上限，而不是永久挂住', async () => {
    // 夹上限是防死锁的硬要求：凑不出来的申请会让调用方永远等下去
    expect(await acquireProbeSlots(PROBE_GATE_CONCURRENCY + 999)).toBe(PROBE_GATE_CONCURRENCY)
    expect(probeGateInflight()).toBe(PROBE_GATE_CONCURRENCY)
  })

  it('归还量同样被归一化，不会把计数压成负数', () => {
    releaseProbeSlots(10)
    expect(probeGateInflight()).toBe(0)
  })
})
