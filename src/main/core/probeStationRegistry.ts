/**
 * 探测工位端口的**唯一真相源**。
 *
 * ## 为什么需要这个模块
 *
 * 工位端口曾经是常量 `PROBE_STATION_PORT_BASE + index`，注入侧（core/scriptOutlet.ts）
 * 和拨测侧（core/probeStation.ts）各按常量算一遍。这带来两个已发生的问题：
 *
 * 1. **端口不能动**。实机上用户在界面里配了 `port: 17900, count: 100` 的业务出口，
 *    与常量基址 100 个端口全撞，注入侧只能整批跳过 —— 一个工位都没生成，
 *    `mode=ip` 完全不可用，而 app 照常启动、只在日志里留一行 ERROR。
 *    要让端口能自动让位，注入侧就必须能改端口，可一改两边就不一致了。
 * 2. **两边各算一份 = 错位的土壤**。这个错位踩过一次：PUT 了一个组、
 *    却从下一个组的端口出网，整轮实际只反复拨测了几个固定节点，
 *    而**结果看起来完全正常**，整轮结论作废。
 *
 * 所以端口改成「注入侧决定 → 登记到这里 → 拨测侧读取」的单向流动。
 * 拨测侧不再有任何推算逻辑，结构上就不可能与实际配置不一致。
 *
 * ## 为什么单独一个文件
 *
 * factory.ts（注入方）与 probeStation.ts（读取方）之间已有一条依赖链
 * `probeStation → delayProbe → mihomoApi → factory`，把登记表放在任一侧都会成环。
 * 这里刻意保持**零依赖**，两侧都能静态 import。
 */

let injectedPorts: number[] = []
let injectedWindowStart: number | null = null

/**
 * 由注入侧（factory.ts 生成配置时）登记实际写进内核配置的工位端口。
 *
 * 每次生成配置都要调用，包括注入 0 个的情况 —— 传空数组即表示「本份配置没有工位」，
 * 这样切换配置后不会拿着上一份配置的端口去拨测（那会得到成片的 dial_failed）。
 */
export function setProbeStationPorts(ports: readonly number[], windowStart: number | null): void {
  injectedPorts = [...ports]
  injectedWindowStart = windowStart
}

/** 当前配置里实际存在的工位端口。空数组表示没有工位，调用方应据此明确报错 */
export function getProbeStationPorts(): number[] {
  return [...injectedPorts]
}

/** 工位端口窗口起点，仅用于日志与排障展示 */
export function getProbeStationWindowStart(): number | null {
  return injectedWindowStart
}
