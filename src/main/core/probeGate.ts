import { PROBE_GATE_CONCURRENCY } from '../../shared/appConfig'

/**
 * 所有探测流量的**唯一**全局并发闸门。
 *
 * 为什么必须收成一个模块：这个项目里打测速流量的来源有三个 ——
 *
 * 1. 全量基线（`runFullProbe`，每隔 N 分钟把整个订阅测一遍）；
 * 2. 名单探测（脚本调 `POST /probe mode=delay`）；
 * 3. 工位拨测（脚本调 `POST /probe mode=ip`，手写 raw socket 查出口 IP）。
 *
 * 它们此前各有各的限流：1 和 2 共用一个信号量，3 用工位池的租约。于是「每一路都
 * 守规矩」和「合起来把网络压垮」可以同时成立 —— 实测两路叠加（峰值 400）时双通道
 * 哨兵 p50 直接翻倍、失败率 5.7%，比「一次性把 566 个节点全部并发拨出去」还差。
 * 局部限流不能推出全局有界，所以必须有这么一个所有人都要过的总闸。
 *
 * ⚠ 新增任何探测路径时都必须过这个闸门。判据很简单：**只要你要往外发连接**，
 * 就先 `acquireProbeSlots(要开几条)`、`finally` 里 `releaseProbeSlots(同一个数)`。
 * 不要试图在自己的模块里再加一层「本地并发上限」来代替它 —— 那正是之前出问题的
 * 形态。本地窗口只能限制「同时排队的任务数」，封顶必须由这里做。
 *
 * ⚠ 名额是按**连接数**算的，不是按节点数。工位拨测一个节点会同时拨 3 个目标
 * （`PROBE_IP_TARGETS`），所以它一次要申请 3 个名额，不是 1 个。
 */

interface IWaiter {
  /** 这个等待者要几个名额，唤醒时必须一次给足 */
  need: number
  resolve: () => void
}

let inflight = 0
const waiters: IWaiter[] = []

/**
 * 把申请量夹到 [1, 上限]。
 *
 * 夹上限是防死锁的硬要求：一次申请超过总额度的话，无论怎么等都凑不出来，
 * 调用方会永久挂住。宁可让它超额跑（上限本身就是个保守值），也不能卡死。
 */
function normalizeNeed(need: number): number {
  if (!Number.isFinite(need)) return 1
  const rounded = Math.floor(need)
  if (rounded < 1) return 1
  return Math.min(rounded, PROBE_GATE_CONCURRENCY)
}

/**
 * 把名额发给队头，能发几个发几个。
 *
 * 队头阻塞是**刻意保留**的：队头要 3 个而现在只剩 2 个时，宁可让这 2 个空着，
 * 也不让后面「只要 1 个」的插队。否则在基线满载（几百个单名额申请排着）的时候，
 * 工位拨测的 3 名额申请永远凑不到机会 —— 空转一点吞吐可以接受，饿死不行。
 */
function pump(): void {
  while (waiters.length > 0 && inflight + waiters[0].need <= PROBE_GATE_CONCURRENCY) {
    const waiter = waiters.shift() as IWaiter
    inflight += waiter.need
    waiter.resolve()
  }
}

/**
 * 申请 need 个名额，拿不到就排队。返回实际占用的数量 ——
 * **必须**把这个返回值原样传给 releaseProbeSlots，不要自己重算，
 * 因为申请量可能被夹紧过，两边算法一旦跑偏就会导致名额泄漏或虚增。
 */
export async function acquireProbeSlots(need: number = 1): Promise<number> {
  const want = normalizeNeed(need)

  // 只有在「没人排队」时才允许直接拿，否则先到先得会被后到的小额申请插队。
  if (waiters.length === 0 && inflight + want <= PROBE_GATE_CONCURRENCY) {
    inflight += want
    return want
  }

  await new Promise<void>((resolve) => {
    waiters.push({ need: want, resolve })
  })
  // 名额已由 releaseProbeSlots → pump 记在 inflight 上（交接语义），这里不再自增：
  // 「先减计数、再让下一个自己抢」中间有个计数为空的窗口，会被同一 tick 里的其他
  // acquire 插队，实际并发就超了上限。
  return want
}

export function releaseProbeSlots(count: number): void {
  const back = normalizeNeed(count)
  inflight = Math.max(0, inflight - back)
  pump()
}

/** 当前在飞的连接数。仅供日志与测试断言 */
export function probeGateInflight(): number {
  return inflight
}

/** 当前排队的申请数。仅供日志与测试断言 */
export function probeGateWaiting(): number {
  return waiters.length
}

/**
 * 清空闸门状态。**仅供测试**在用例之间隔离，生产代码不要调 ——
 * 它会把正在飞的请求的名额直接抹掉，之后它们归还时会把计数压成负数（被 max(0) 兜住），
 * 但期间的实际并发会突破上限。
 */
export function resetProbeGate(): void {
  inflight = 0
  waiters.length = 0
}
