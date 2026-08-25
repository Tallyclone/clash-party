import { describe, it, expect } from 'vitest'
import { SCRIPT_OUTLET_MAX_BATCH_COUNT } from './appConfig'
import {
  expandScriptOutlet,
  expandScriptOutlets,
  formatBatchOutletRemark,
  formatOutletSequence,
  getOutletPortRange,
  getOutletPorts,
  isBatchOutlet,
  normalizeOutletCount,
  outletSequenceWidth
} from './scriptOutlet'

const outlet = (patch: Partial<IScriptOutlet> = {}): IScriptOutlet => ({
  id: 'o1',
  enable: true,
  port: 7900,
  type: 'mixed',
  mode: 'direct',
  target: 'US-01',
  ...patch
})

describe('normalizeOutletCount', () => {
  it('falls back to 1 for missing or invalid values', () => {
    expect(normalizeOutletCount(undefined)).toBe(1)
    expect(normalizeOutletCount(null)).toBe(1)
    expect(normalizeOutletCount('10')).toBe(1)
    expect(normalizeOutletCount(NaN)).toBe(1)
    expect(normalizeOutletCount(Infinity)).toBe(1)
    expect(normalizeOutletCount(0)).toBe(1)
    expect(normalizeOutletCount(-5)).toBe(1)
    expect(normalizeOutletCount(1)).toBe(1)
  })

  it('floors fractional counts and clamps to the upper bound', () => {
    expect(normalizeOutletCount(1.7)).toBe(1)
    expect(normalizeOutletCount(10.9)).toBe(10)
    expect(normalizeOutletCount(SCRIPT_OUTLET_MAX_BATCH_COUNT + 50)).toBe(
      SCRIPT_OUTLET_MAX_BATCH_COUNT
    )
  })
})

describe('isBatchOutlet', () => {
  it('treats legacy outlets without count as single outlets', () => {
    expect(isBatchOutlet(outlet())).toBe(false)
    expect(isBatchOutlet(outlet({ count: 1 }))).toBe(false)
    expect(isBatchOutlet(outlet({ count: 2 }))).toBe(true)
  })
})

describe('sequence formatting', () => {
  it('keeps at least two digits and widens past 99', () => {
    expect(outletSequenceWidth(10)).toBe(2)
    expect(outletSequenceWidth(99)).toBe(2)
    expect(outletSequenceWidth(100)).toBe(3)
    expect(formatOutletSequence(1, 10)).toBe('01')
    expect(formatOutletSequence(10, 10)).toBe('10')
    expect(formatOutletSequence(3, 100)).toBe('003')
  })

  it('joins the trimmed prefix with the padded sequence', () => {
    expect(formatBatchOutletRemark('test', 1, 10)).toBe('test01')
    expect(formatBatchOutletRemark('  test  ', 10, 10)).toBe('test10')
    expect(formatBatchOutletRemark('', 2, 10)).toBe('02')
    expect(formatBatchOutletRemark(undefined, 2, 10)).toBe('02')
  })
})

describe('port range', () => {
  it('collapses to a single port for non batch outlets', () => {
    expect(getOutletPortRange(outlet())).toEqual({ start: 7900, end: 7900 })
    expect(getOutletPorts(outlet())).toEqual([7900])
  })

  it('spans count ports starting from the base port', () => {
    expect(getOutletPortRange(outlet({ count: 10 }))).toEqual({ start: 7900, end: 7909 })
    expect(getOutletPorts(outlet({ count: 3 }))).toEqual([7900, 7901, 7902])
  })
})

describe('expandScriptOutlet', () => {
  it('returns the outlet as-is when it is not a batch entry', () => {
    const expanded = expandScriptOutlet(outlet())
    expect(expanded).toHaveLength(1)
    expect(expanded[0]).toMatchObject({ id: 'o1', sourceId: 'o1', index: 1, count: 1, port: 7900 })
  })

  it('maps direct targets to ports in order', () => {
    const expanded = expandScriptOutlet(
      outlet({
        remark: 'test',
        count: 3,
        batchTargets: ['出口能用01', '出口能用02', '出口能用03']
      })
    )

    expect(expanded.map((item) => [item.remark, item.port, item.target])).toEqual([
      ['test01', 7900, '出口能用01'],
      ['test02', 7901, '出口能用02'],
      ['test03', 7902, '出口能用03']
    ])
    expect(expanded.map((item) => item.id)).toEqual(['o1#01', 'o1#02', 'o1#03'])
    expect(expanded.every((item) => item.sourceId === 'o1')).toBe(true)
  })

  it('leaves the target empty when there are fewer targets than outlets', () => {
    const expanded = expandScriptOutlet(
      outlet({ remark: 'test', count: 3, batchTargets: ['US-01'] })
    )
    expect(expanded[0].target).toBe('US-01')
    expect(expanded[1].target).toBeUndefined()
    expect(expanded[2].target).toBeUndefined()
  })

  it('keeps slot alignment when a middle target is blank', () => {
    const expanded = expandScriptOutlet(
      outlet({ count: 3, batchTargets: ['US-01', '   ', 'TW-01'] })
    )
    // 空串不能被过滤掉，否则 TW-01 会前移到第 2 个出口
    expect(expanded.map((item) => item.target)).toEqual(['US-01', '', 'TW-01'])
  })

  it('shares the same fallback target pool in fallback mode', () => {
    const expanded = expandScriptOutlet(
      outlet({
        mode: 'fallback',
        target: undefined,
        count: 2,
        targets: ['US-01', 'TW-01'],
        batchTargets: ['ignored']
      })
    )
    expect(expanded).toHaveLength(2)
    expect(expanded.every((item) => item.targets?.join() === 'US-01,TW-01')).toBe(true)
    // fallback 模式忽略 batchTargets，target 保持原值
    expect(expanded.every((item) => item.target === undefined)).toBe(true)
  })

  it('clears batch fields so the result can never be expanded twice', () => {
    const expanded = expandScriptOutlet(outlet({ count: 4, batchTargets: ['US-01'] }))
    expect(expanded.every((item) => item.count === 1)).toBe(true)
    expect(expanded.every((item) => item.batchTargets === undefined)).toBe(true)
    expect(expanded.flatMap((item) => expandScriptOutlet(item))).toHaveLength(4)
  })
})

describe('expandScriptOutlets', () => {
  it('returns an empty array for empty input', () => {
    expect(expandScriptOutlets(undefined)).toEqual([])
    expect(expandScriptOutlets([])).toEqual([])
  })

  it('flattens mixed single and batch entries', () => {
    const expanded = expandScriptOutlets([
      outlet({ id: 'single', port: 7800 }),
      outlet({ id: 'batch', port: 7900, count: 3, batchTargets: ['a', 'b', 'c'] })
    ])
    expect(expanded.map((item) => item.port)).toEqual([7800, 7900, 7901, 7902])
  })
})
