import { describe, expect, it, vi } from 'vitest'

/**
 * 回归测试：GroupsProvider 取策略组时，绝不能把 mihomoGroups 裸传给 useSWR 当 fetcher。
 *
 * 背景 BUG（2026-08-25，用户实测「出口能用01~50 并没有在 UI 上隐藏」）：
 *   mihomoGroups 的签名从 `()` 改成 `(includeHidden = false)` 之后，
 *   use-groups.tsx 里原有的写法
 *
 *       useSWR<IMihomoMixedGroup[]>('mihomoGroups', mihomoGroups, {...})
 *
 *   就变成了一个隐蔽的地雷 —— SWR 会把 key 作为第一个实参传给 fetcher，
 *   即实际调用 `mihomoGroups('mihomoGroups')`。非空字符串是 truthy，
 *   于是 includeHidden 被意外置为 true，hidden 策略组全部泄露到代理页面。
 *
 *   主进程侧的过滤逻辑（mihomoApi.hidden.test.ts）当时是完全正确的，
 *   所以这个 BUG 无法靠主进程测试发现，必须在渲染层调用点上锁。
 *
 * 本测试直接复刻 SWR 的「把 key 传给 fetcher」行为，
 * 确保 fetcher 无论被传入什么实参，落到 mihomoGroups 的都是零参调用。
 */

describe('use-groups fetcher wiring', () => {
  it('SWR 把 key 传给 fetcher 时，mihomoGroups 仍必须零参调用', () => {
    const mihomoGroups = vi.fn(async (includeHidden = false) => [{ includeHidden }])

    // 正确写法：箭头函数包一层，显式无参调用
    const fetcher = (): Promise<unknown[]> => mihomoGroups()

    // 复刻 SWR 行为：以 key 作为第一个实参调用 fetcher
    fetcher.call(null, 'mihomoGroups' as never)

    expect(mihomoGroups).toHaveBeenCalledTimes(1)
    // 关键断言：实参列表必须为空，绝不能收到 'mihomoGroups' 这个 key
    expect(mihomoGroups.mock.calls[0]).toEqual([])
  })

  it('反例验证：裸传函数会让 key 变成 includeHidden=true（此为已修复的 BUG）', () => {
    const mihomoGroups = vi.fn(async (includeHidden = false) => [{ includeHidden }])

    // 错误写法：直接把函数交给 SWR
    const badFetcher = mihomoGroups as unknown as (key: string) => Promise<unknown[]>
    badFetcher('mihomoGroups')

    // 证明 key 确实会被当作 includeHidden，且是 truthy —— 这正是隐藏组泄露的成因
    expect(mihomoGroups.mock.calls[0]).toEqual(['mihomoGroups'])
    expect(Boolean(mihomoGroups.mock.calls[0][0])).toBe(true)
  })

  it('源码实现必须用箭头函数包裹 mihomoGroups，而非裸传', async () => {
    const { readFileSync } = await import('fs')
    const { join } = await import('path')
    const source = readFileSync(join(__dirname, 'use-groups.tsx'), 'utf8')

    // 裸传写法（fetcher 位置直接是标识符 mihomoGroups）必须不存在
    expect(source).not.toMatch(/useSWR<[^>]*>\(\s*'mihomoGroups'\s*,\s*mihomoGroups\s*,/)
    // 必须存在显式零参调用
    expect(source).toMatch(/\(\)\s*=>\s*mihomoGroups\(\)/)
  })
})
