import {
  DELAY_PROBE_CEILING_MARGIN_MS,
  DELAY_PROBE_TIMEOUT,
  PROBE_STORE_DEFAULT_MAX_AGE_MS
} from '../../shared/appConfig'

/**
 * 探测结果表：app 侧唯一的延迟真相源。
 *
 * ## 为什么不直接读内核的 history
 *
 * 改动前 isUsable() 和候选池判定都读 `proxy.history` 的最后一条，那条路有四个
 * 无法在读取侧修复的缺陷，全部是实测确认的：
 *
 * 1. **delay=0 有二义性**：既表示「测了不通」，也表示「压根没测过」，还表示
 *    「被 timeout 截断但节点其实健康」。三种情况必须区分，脚本才能判断
 *    「确实都不可用」和「还没数据」，而 history 里它们长得一模一样。
 *
 * 2. **504 会写正数延迟（天花板产物）**：mihomo 的 URLTest 在 defer 里
 *    err == nil（第二次 HEAD 的错误被 ignoredErr 吞掉），于是记录
 *    record.Delay = 全程耗时 ≈ timeout、alive = true；但 API 层因
 *    ctx.Err() != nil 返回 504。两边结论相反。实测 6420 条 history 里有
 *    87 条 delay≈1200、63 条 delay≈3000，正数 delay 的 p90 恰好是 1201。
 *    这些假延迟在 maxDelay ≥ timeout 时会变成假阳性，把死节点报给脚本。
 *
 * 3. **只保留 10 条**：任何「回看最近 N 条」的判据，其时间窗都等于
 *    N × 探测周期，于是判定语义会随探测频率漂移。实测踩过：把探测频率提到
 *    5 分钟一轮后，候选池 4 轮内从 175 掉到 108（−38%）—— 窗口从 90 分钟
 *    缩到 15 分钟，抖动节点被永久除名，池子越小转得越快、窗口越短，自我强化。
 *
 * 4. **不知道当条记录用的是什么 timeout**：timeout=1200 下的 0 和 6000 下的 0
 *    含义完全不同（前者大概率只是被截断），history 不带这个上下文。
 *
 * 这张表把上面四条一次解决：err 让失败原因可区分、写入时就滤掉天花板产物、
 * 容量不受内核限制、每条记录自带 at 和 url。
 *
 * ## 谁写谁读
 *
 * 写：全量基线（保全组覆盖）、POST /probe mode=delay 的 lazy refresh（保热点新鲜）。
 * 读：isUsable()（脚本名单过滤）、POST /probe 的命中判定。
 *
 * 两个写入方共用一张表、但读取方用不同的新鲜度门槛 —— 基线数据可能有 90 分钟旧，
 * 对 `GET /groups` 够用（它要的是覆盖），对 `POST /probe` 不够（默认要求 300 秒内），
 * 后者会自己触发重测。一张表两种要求，比两套存储干净。
 *
 * ## 不落盘
 *
 * 延迟数据的价值随时间衰减得很快，重启后的旧数据没有参考意义；
 * 而重启不频繁，靠启动事件触发的一轮基线（20 秒后）补齐覆盖就够。
 */

/**
 * 探测失败的原因分类。
 *
 * `dial_failed` 特别重要：它的含义是【连本地端口都连不上】，与远端节点无关，
 * 所以它是判定「探测工位自己坏了」的唯一硬证据（见 probeStation 的熔断逻辑）。
 */
export type ProbeErrCode =
  | 'timeout'
  | 'unreachable'
  | 'dial_failed'
  | 'tls_failed'
  | 'bad_response'
  | 'kernel_error'

export interface IProbeDelayRecord {
  /** 上报延迟（毫秒）。> 0 表示测通；0 一律表示失败，具体原因看 err */
  delay: number
  /** 失败原因；测通时为 null。绝不会出现 delay > 0 且 err 非 null 的组合 */
  err: ProbeErrCode | null
  /** 写入时间戳（毫秒） */
  at: number
  /** 这条记录是用哪个测速地址测出来的 —— 换了地址的旧记录不该被当成同一口径 */
  url: string
}

export interface IProbeStoreStats {
  /** 表内记录总数 */
  size: number
  /** 其中 delay > 0 的条数 */
  alive: number
  /** 最新一条记录的时间戳，空表为 null */
  newestAt: number | null
}

const delayTable = new Map<string, IProbeDelayRecord>()

/**
 * 天花板产物归一：delay 顶到 timeout 附近的记录不是真延迟，是 504 的副产品。
 *
 * 必须在【写入时】做而不是读取时：读取方有多个（isUsable、/probe、界面），
 * 漏一个就会有一条路径吃到假阳性。写入是唯一的收口点。
 */
function normalizeDelay(
  delay: unknown,
  err: ProbeErrCode | null
): { delay: number; err: ProbeErrCode | null } {
  const value = typeof delay === 'number' && Number.isFinite(delay) ? Math.round(delay) : 0

  if (value <= 0) {
    return { delay: 0, err: err ?? 'timeout' }
  }
  if (value >= DELAY_PROBE_TIMEOUT - DELAY_PROBE_CEILING_MARGIN_MS) {
    // 内核说「测通了，延迟 6000ms」，API 层却回 504。信 API 层。
    return { delay: 0, err: err ?? 'timeout' }
  }
  return { delay: value, err: null }
}

/** 写入一条探测结果。delay ≤ 0 或顶到天花板都会被归一成失败 */
export function recordDelayResult(
  name: string,
  input: { delay?: number; err?: ProbeErrCode | null; url: string; at?: number }
): IProbeDelayRecord {
  const { delay, err } = normalizeDelay(input.delay, input.err ?? null)
  const record: IProbeDelayRecord = {
    delay,
    err,
    at: input.at ?? Date.now(),
    url: input.url
  }
  delayTable.set(name, record)
  return record
}

export function getDelayRecord(name: string): IProbeDelayRecord | undefined {
  return delayTable.get(name)
}

/** 记录年龄（毫秒）。表里没有返回 null，调用方据此区分「没数据」和「数据旧」 */
export function getRecordAgeMs(name: string, now: number = Date.now()): number | null {
  const record = delayTable.get(name)
  if (!record) return null
  return Math.max(0, now - record.at)
}

/**
 * 取一条足够新的记录；不够新或不存在都返回 undefined，由调用方决定要不要现测。
 *
 * maxAgeMs = 0 表示「任何已有记录都算过期」，即强制现测。
 */
export function getFreshDelayRecord(
  name: string,
  maxAgeMs: number,
  now: number = Date.now()
): IProbeDelayRecord | undefined {
  const record = delayTable.get(name)
  if (!record) return undefined
  if (now - record.at > maxAgeMs) return undefined
  return record
}

/**
 * 「能用」判定：测通且不慢于阈值。
 *
 * 没有记录一律不算能用 —— 脚本要的是「保证能用」，没数据不算保证。
 * 这也是为什么全组覆盖的基线不能省：没被基线测过的节点在这里永远是 false。
 */
export function isRecordUsable(record: IProbeDelayRecord | undefined, maxDelay: number): boolean {
  if (!record) return false
  return record.delay > 0 && record.delay <= maxDelay
}

/**
 * 清掉不在名单里的记录，防止订阅反复变更时表无界增长。
 *
 * 只在全量基线跑完后调用：那时候拿到的是完整的节点集合。
 * 用局部名单调用会把没被点名的节点全删掉，直接破坏覆盖。
 */
export function pruneDelayRecords(validNames: Set<string>): number {
  let removed = 0
  for (const name of delayTable.keys()) {
    if (!validNames.has(name)) {
      delayTable.delete(name)
      removed += 1
    }
  }
  return removed
}

export function getProbeStoreStats(): IProbeStoreStats {
  let alive = 0
  let newestAt: number | null = null
  for (const record of delayTable.values()) {
    if (record.delay > 0) alive += 1
    if (newestAt === null || record.at > newestAt) newestAt = record.at
  }
  return { size: delayTable.size, alive, newestAt }
}

/** 仅供测试与「配置整体切换」时重置 */
export function clearProbeStore(): void {
  delayTable.clear()
}

/**
 * 把脚本传的 maxAge（秒）收敛成毫秒。
 *
 * 允许 0（强制现测）—— 与 GET /groups 的 SCRIPT_API_MIN_MAX_AGE_MS 下限不同，
 * 因为这条路径只测脚本点名的那几十个节点，不会把整个订阅打一遍。
 */
export function resolveProbeMaxAgeMs(input: unknown): number {
  if (typeof input !== 'number' || !Number.isFinite(input)) return PROBE_STORE_DEFAULT_MAX_AGE_MS
  if (input <= 0) return 0
  return Math.floor(input) * 1000
}
