import {
  DELAY_PROBE_FULL_CONCURRENCY,
  DELAY_PROBE_FULL_INTERVAL_MINUTES,
  DELAY_PROBE_STARTUP_DELAY_MS,
  DELAY_PROBE_TIMEOUT,
  normalizeDelayProbeIntervalMinutes,
  SCRIPT_API_NAMED_PROBE_MAX_NAMES
} from '../../shared/appConfig'
import { getAppConfig } from '../config'
import { createLogger } from '../utils/logger'
import { mihomoProbeDelay, mihomoProxies } from './mihomoApi'
import { acquireProbeSlots, releaseProbeSlots } from './probeGate'
import {
  getFreshDelayRecord,
  getRecordAgeMs,
  IProbeDelayRecord,
  ProbeErrCode,
  pruneDelayRecords,
  recordDelayResult,
  resolveProbeMaxAgeMs
} from './probeStore'

const probeLogger = createLogger('delay-probe')

/**
 * 延迟探测模块。
 *
 * 存在理由：`select` 类型的策略组（例如覆写脚本生成的「[能用]」）内核不会主动做健康检查，
 * 因此它成员的延迟历史长期是空的。而「隐藏慢节点」和「脚本控制 API 只给能用的节点」
 * 这两件事都要读延迟数字才能成立 —— 数字必须有人去测，这个模块就是唯一负责测的地方。
 *
 * ## 两层结构（一张表、两种新鲜度门槛）
 *
 * - **基线全量**：3 小时一轮 + 启动/订阅更新/配置切换事件触发。职责是**保全组覆盖**，
 *   不是保新鲜。没人等它。
 * - **lazy refresh**：`POST /probe mode=delay` 按脚本点名的节点现测，职责是**保新鲜**
 *   （默认 300 秒门槛）。脚本同步等它。
 *
 * 两者写同一张表（probeStore），读取方按自己的门槛决定够不够新。
 *
 * ## 三条不变量（改动前请读完，每条都是踩过的坑）
 *
 * 1. **测量给足、判定分离**：内核测速的 timeout 恒为 DELAY_PROBE_TIMEOUT，
 *    脚本传的 maxDelay 只在**结果上过滤**，绝不反向影响测量参数。
 *    历史 bug：quick 档把 timeout 压到 1200ms 想"快点返回"，实测召回率 15.8%
 *    （给足 5000ms 是 89.5%）。原因见 appConfig 的 DELAY_PROBE_TIMEOUT 注释。
 * 2. **判据不读内核 history**：history 只有 10 条、delay=0 有三义、504 还会往里
 *    写正数假延迟。所有判定改读 probeStore（原因见 probeStore.ts 文件头）。
 * 3. **没有候选池、没有 quick 档**。候选池（"最近还达标过的才值得测"）是自我强化的
 *    负反馈：实测连跑 4 轮后池子从 175 掉到 108（−38%），因为它的时间窗 =
 *    N × 探测周期，频率一高窗口就塌。lazy refresh 让"该测什么"直接由脚本的真实
 *    需求定义，不需要任何启发式。
 */

/** 这些内置出口没有测速意义 */
const SKIP_PROXY_NAMES = new Set([
  'DIRECT',
  'REJECT',
  'REJECT-DROP',
  'PASS',
  // 实测内核还会暴露一个 PASS-RULE（type=PassRule）：它永远测不通，
  // 漏掉它等于每轮全量都白占一个 DELAY_PROBE_TIMEOUT 的槽位
  'PASS-RULE',
  'COMPATIBLE',
  'GLOBAL'
])

const SKIP_PROXY_TYPES = new Set([
  'direct',
  'reject',
  'rejectdrop',
  'reject-drop',
  'pass',
  'passrule',
  'pass-rule',
  'compatible',
  'dns'
])

/** 内核默认的 204 探测地址。实测它不是本项目召回率低的原因，换成别的 https 目标差异在抖动范围内 */
export const DEFAULT_PROBE_URL = 'https://www.gstatic.com/generate_204'

/**
 * 这个名字值不值得测。基线、名单探测、工位拨测三处共用同一口径，不要各写一份。
 *
 * 排除策略组：测一个组等于测它当前选中的那个节点，会重复且结果归属不清。
 */
export function isProbeableProxy(
  name: string,
  proxy: IMihomoProxy | IMihomoGroup | undefined
): boolean {
  if (!proxy) return false
  if ('all' in proxy) return false
  if (SKIP_PROXY_NAMES.has(name)) return false
  if (SKIP_PROXY_TYPES.has(String(proxy.type ?? '').toLowerCase())) return false
  return true
}

export interface IDelayProbeSnapshot {
  /** 最近一次基线完成的时间戳，毫秒。从未探测过为 null */
  lastProbeAt: number | null
  /** 最近一次全量基线完成的时间戳，毫秒（与 lastProbeAt 同义，保留字段名兼容脚本） */
  lastFullProbeAt: number | null
  /** 最近一次基线覆盖的节点数 */
  lastProbedCount: number
  /** 最近一次基线中测出可用（延迟大于 0）的节点数 */
  lastAliveCount: number
  /** 是否有基线正在进行 */
  probing: boolean
}

const state = {
  lastProbeAt: null as number | null,
  lastFullProbeAt: null as number | null,
  lastProbedCount: 0,
  lastAliveCount: 0
}

let fullProbeTimer: NodeJS.Timeout | null = null
let startupTimer: NodeJS.Timeout | null = null
/** 同一时刻只允许一轮基线在跑，后来的调用复用同一个 Promise，避免事件密集触发时叠加 */
let inflightProbe: Promise<void> | null = null

export function getDelayProbeSnapshot(): IDelayProbeSnapshot {
  return {
    lastProbeAt: state.lastProbeAt,
    lastFullProbeAt: state.lastFullProbeAt,
    lastProbedCount: state.lastProbedCount,
    lastAliveCount: state.lastAliveCount,
    probing: inflightProbe !== null
  }
}

/** 基线数据年龄（毫秒）。从未探测过返回 null */
export function getDelayDataAgeMs(): number | null {
  if (state.lastProbeAt === null) return null
  return Date.now() - state.lastProbeAt
}

/** 只接受能解析出 http/https 的地址，其余当没传 —— 否则一个手滑的配置会让整轮探测全灭 */
function sanitizeProbeUrl(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const value = input.trim()
  if (!value) return null
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    return value
  } catch {
    return null
  }
}

/**
 * 决定这次探测打哪个地址。优先级：脚本传的 > 设置页的探测地址 > 设置页的测速地址 > 内置默认。
 *
 * ⚠ 不要换成明文 http 去省 TLS 握手流量：同一批节点 @timeout=6000 实测
 * https 版 504 只有 16~17 个（alive 82~89%），明文 http 版 504 是 47 个（alive 64.2%）。
 * 部分落地机对明文 http 出站有限制，这条路是死的。
 */
export async function resolveProbeUrl(input?: unknown): Promise<string> {
  const fromScript = sanitizeProbeUrl(input)
  if (fromScript) return fromScript
  try {
    const { probeTestUrl, delayTestUrl } = await getAppConfig()
    return sanitizeProbeUrl(probeTestUrl) ?? sanitizeProbeUrl(delayTestUrl) ?? DEFAULT_PROBE_URL
  } catch {
    return DEFAULT_PROBE_URL
  }
}

async function collectProbeTargets(): Promise<string[]> {
  const proxies = await mihomoProxies()
  const names: string[] = []

  for (const [name, proxy] of Object.entries(proxies.proxies ?? {})) {
    if (isProbeableProxy(name, proxy)) names.push(name)
  }

  return names
}

/**
 * HTTP 状态码 → 失败原因。
 *
 * 504 与 503 的区分是这次改造的核心收益之一：@1200 时 97 个样本里 75 个是 504
 * （被 deadline 截断，节点其实健康），只有 16 个是 503（真连不上）。
 * 旧代码把两者一起记成 delay=0，于是"极度保守"的原因完全看不出来。
 *
 * status=0 是 socket 层就没通（内核没起来 / 管道断了），归到 kernel_error：
 * 它和节点质量无关，不该让脚本以为节点坏了。
 */
function classifyProbeStatus(status: number): ProbeErrCode | null {
  if (status === 200) return null
  if (status === 504) return 'timeout'
  if (status === 503) return 'unreachable'
  return 'kernel_error'
}

/**
 * 在飞去重表。
 *
 * key 是 `name + url`，**不含 timeout 也不含 maxDelay**：
 * - timeout 已经固定成 DELAY_PROBE_TIMEOUT，不再是变量；
 * - maxDelay 只用于过滤结果，不影响测出来的数值，所以两个脚本传不同 maxDelay
 *   查同一个节点时应该共享同一次探测（旧代码 key 里带 timeout，做不到）；
 * - url 必须进 key：换了测速地址测的就是另一件事，让它们互相冒充会给出错误答案。
 */
const inflightByKey = new Map<string, Promise<IProbeDelayRecord>>()

/**
 * 测一个节点并把结果写进 probeStore。永不抛异常。
 *
 * useSharedSlot 现在**恒为 true**：基线、名单探测、工位拨测共用 probeGate 这一个
 * 全局闸门。保留这个参数只是为了让调用点显式声明意图（以及给测试留一个旁路口）。
 *
 * 为什么基线也必须占名额：不占的话两者可以叠加，瞬时并发 = 基线窗口 + 闸门额度。
 * 实测各 200（峰值 400）时双通道哨兵 p50 直接翻倍、失败率 5.7%/6.2%，
 * 是所有配置里对用户上网最狠的一种。详见 appConfig 的
 * PROBE_GATE_CONCURRENCY 注释。
 *
 * 一次内核测速 = 一条连接 = 一个名额。
 */
function probeOne(name: string, url: string, useSharedSlot: boolean): Promise<IProbeDelayRecord> {
  const key = `${name}\u0000${url}`
  const existing = inflightByKey.get(key)
  if (existing) return existing

  const task = (async () => {
    const slots = useSharedSlot ? await acquireProbeSlots(1) : 0
    try {
      const res = await mihomoProbeDelay(name, url, DELAY_PROBE_TIMEOUT)
      const err = classifyProbeStatus(res.status)
      // err 非 null 时不要相信 body 里的 delay：504 的响应体里可能带着一个
      // 顶到 timeout 的假延迟（天花板产物），交给 probeStore 归一也行，
      // 但这里直接置 0 更明确。
      return recordDelayResult(name, { delay: err ? 0 : res.delay, err, url })
    } catch (e) {
      probeLogger.debug(`probe ${name} failed unexpectedly`, e)
      return recordDelayResult(name, { delay: 0, err: 'kernel_error', url })
    } finally {
      if (slots > 0) releaseProbeSlots(slots)
    }
  })()

  const tracked = task.finally(() => {
    inflightByKey.delete(key)
  })
  inflightByKey.set(key, tracked)
  return tracked
}

/**
 * 滑动窗口并发执行。
 *
 * ⚠ 这**不是**峰值的最终闸门 —— 真正封顶的是 probeOne 里的 probeGate。
 * 这一层的意义是限制「同时排队等名额的任务数」，避免一次性把几百个 Promise 挂上去。
 * 两层叠起来的效果是：本轮基线最多 concurrency 个在排队或在飞，且与脚本探测、
 * 工位拨测共享同一个全局额度。
 */
async function runWithWindow(
  names: string[],
  concurrency: number,
  task: (name: string) => Promise<unknown>
): Promise<void> {
  const running: Promise<void>[] = []

  for (const name of names) {
    const tracked: Promise<void> = task(name)
      .catch(() => {})
      .then(() => {
        const index = running.indexOf(tracked)
        if (index >= 0) running.splice(index, 1)
      })
    running.push(tracked)

    if (running.length >= Math.max(1, concurrency)) {
      await Promise.race(running)
    }
  }

  await Promise.all(running)
}

/**
 * 全量基线：把所有具体节点测一遍，写进 probeStore。
 *
 * 为什么这一层不能省（自锁论证）：表里只有"曾被点名过的节点"。没被基线测过的节点
 * 在 isUsable() 里恒为 false → 不出现在 GET /groups 的名单 → 脚本拿不到它的名字 →
 * 永远不会去 POST /probe 点它 → 永远不进表。这个死锁不会自愈。
 */
async function runFullProbe(reason: string): Promise<void> {
  const startedAt = Date.now()
  const url = await resolveProbeUrl()
  const names = await collectProbeTargets()

  if (names.length === 0) {
    probeLogger.warn('No probeable proxies found, skipping')
    return
  }

  let alive = 0
  // 第三参 true：与脚本的名单探测共用同一个全局闸门，杜绝两者叠加出双倍峰值。
  await runWithWindow(names, DELAY_PROBE_FULL_CONCURRENCY, async (name) => {
    const record = await probeOne(name, url, true)
    if (record.delay > 0) alive += 1
  })

  // 只在这里 prune：这是唯一拿到完整节点集合的时机，用局部名单剪表会破坏覆盖
  const removed = pruneDelayRecords(new Set(names))

  const now = Date.now()
  state.lastProbeAt = now
  state.lastFullProbeAt = now
  state.lastProbedCount = names.length
  state.lastAliveCount = alive

  probeLogger.info(
    `baseline probe done (${reason}): ${alive}/${names.length} alive in ${now - startedAt}ms, ` +
      `timeout ${DELAY_PROBE_TIMEOUT}ms, url ${url}` +
      (removed > 0 ? `, pruned ${removed} stale records` : '')
  )
}

/** 串行化基线：已有一轮在跑时直接复用，不叠加 */
function runProbeExclusive(reason: string): Promise<void> {
  if (inflightProbe) return inflightProbe
  inflightProbe = runFullProbe(reason)
    .catch((e) => {
      probeLogger.warn(`Failed to run baseline delay probe (${reason})`, e)
    })
    .finally(() => {
      inflightProbe = null
    })
  return inflightProbe
}

/** 同步等一轮基线跑完。供 `GET /groups?wait=1` 与 `POST /probe`（不带 proxies）使用 */
export async function probeAllProxies(reason: string = 'manual'): Promise<IDelayProbeSnapshot> {
  await runProbeExclusive(reason)
  return getDelayProbeSnapshot()
}

/**
 * 事件触发一轮基线，不等结果。供订阅更新完成 / 配置切换完成调用。
 *
 * 事件密集时不会叠加：单飞锁会让后来的直接复用在跑的那一轮。
 */
export function triggerBaselineProbe(reason: string): void {
  void runProbeExclusive(reason)
}

/** 名单探测里单个节点的结果 */
export interface INamedProbeItem {
  name: string
  /** 上报延迟；0 一律表示失败，原因看 err */
  delay: number
  /** 失败原因；测通为 null */
  err: ProbeErrCode | null
  /** 这条数据的年龄（毫秒）。0 表示本次现测 */
  ageMs: number
  /** 测通且不慢于 maxDelay。maxDelay 没传时等价于 delay > 0 */
  usable: boolean
}

/** 名单探测的结果。计数字段的用途是让脚本知道自己传的名单被怎么处理了 */
export interface INamedProbeResult {
  /** 逐节点结果，顺序与传入名单一致（去重后） */
  results: INamedProbeItem[]
  /** 内核里查不到的名字。订阅更新后失效的旧名字通常落在这里 */
  unknown: string[]
  /** 拒测的名字：策略组，或 DIRECT/REJECT 这类内置出口 */
  rejected: string[]
  /** 传进来多少个（含重复与非法项） */
  received: number
  /** 去重后剩多少个 */
  deduped: number
  /** 校验通过、真正参与的有多少个 */
  accepted: number
  /** 因为超过名单上限被截掉多少个 */
  truncated: number
  /** 其中多少个直接命中了足够新的记录（没有现测） */
  freshCount: number
  /** 其中多少个做了现测 */
  probedCount: number
  /** 测出可用（延迟大于 0）的数量 */
  aliveCount: number
  /** 测通但被 maxDelay 判为太慢的数量 */
  filteredCount: number
  /** 本次实际生效的测速超时（恒为 DELAY_PROBE_TIMEOUT，回给脚本便于自查） */
  timeout: number
  /** 本次实际使用的测速地址 */
  url: string
  /** 本次生效的新鲜度门槛（毫秒），0 表示强制现测 */
  maxAgeMs: number
  /** 本次生效的过滤阈值（毫秒），0 表示不过滤 */
  maxDelay: number
  elapsedMs: number
}

/** maxDelay 只用于过滤。非法或 ≤0 都当"不过滤"，绝不允许它影响测量参数 */
function resolveMaxDelay(input: unknown): number {
  if (typeof input !== 'number' || !Number.isFinite(input)) return 0
  if (input <= 0) return 0
  return Math.floor(input)
}

/**
 * 按脚本给定的名单查延迟：命中足够新的记录就直接返回，否则**阻塞现测**一次再返回。
 *
 * 关键决策（不要"顺手优化"回去）：
 *
 * 1. **不返回旧值**。超龄记录一律重测后再返回。脚本要的是"这一刻能用"，
 *    给它一条 20 分钟前的数据然后标个 ageMs，等于把判断责任推回脚本。
 * 2. **不保证返回时间**。耗时严格等于「波数 × timeout」，没有中间档
 *    （实测 1 波 6.3s / 2 波 12.6s / 3 波 17.7s）。想要 2 秒 SLA 只能靠
 *    "返回旧值或返回不确定"，而那两条都被否掉了。稳态下大部分名字命中缓存，实际很快。
 * 3. **不走基线的单飞锁**。走锁的话脚本指定测 A/B/C，却可能 join 上一轮正在跑的
 *    全量，等二十几秒拿回来的数据跟它要的名单毫无关系。这里用信号量代替。
 * 4. **不更新 state 里的任何字段**。lastProbeAt 代表"基线覆盖面的新鲜度"，
 *    局部测几个节点不能代表全组数据变新；刷了它会让 GET /groups 的陈旧提示失真。
 */
export async function probeNamedProxies(
  names: unknown,
  options: { maxDelay?: unknown; maxAge?: unknown; probeUrl?: unknown } = {}
): Promise<INamedProbeResult> {
  const startedAt = Date.now()
  const raw = Array.isArray(names) ? names : []

  const maxAgeMs = resolveProbeMaxAgeMs(options.maxAge)
  const maxDelay = resolveMaxDelay(options.maxDelay)
  const url = await resolveProbeUrl(options.probeUrl)

  // 去重保留首次出现顺序：重复名不该占掉名单额度
  const seen = new Set<string>()
  const deduped: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const name = item.trim()
    if (!name || seen.has(name)) continue
    seen.add(name)
    deduped.push(name)
  }

  const proxies = await mihomoProxies()
  const unknown: string[] = []
  const rejected: string[] = []
  const valid: string[] = []

  for (const name of deduped) {
    const proxy = proxies.proxies?.[name]
    if (!proxy) {
      unknown.push(name)
      continue
    }
    if (!isProbeableProxy(name, proxy)) {
      rejected.push(name)
      continue
    }
    valid.push(name)
  }

  // 截断放在去重与校验之后：重复名、不存在的名、策略组名都不该占额度
  const targets = valid.slice(0, SCRIPT_API_NAMED_PROBE_MAX_NAMES)

  // 命中判定要连 url 一起比：换了测速地址的旧记录不是同一口径的数据
  const hits = new Map<string, IProbeDelayRecord>()
  const toProbe: string[] = []
  for (const name of targets) {
    const record = maxAgeMs > 0 ? getFreshDelayRecord(name, maxAgeMs, startedAt) : undefined
    if (record && record.url === url) hits.set(name, record)
    else toProbe.push(name)
  }

  await Promise.all(toProbe.map((name) => probeOne(name, url, true)))

  const now = Date.now()
  const results: INamedProbeItem[] = targets.map((name) => {
    const record = hits.get(name)
    if (record) {
      return {
        name,
        delay: record.delay,
        err: record.err,
        ageMs: Math.max(0, now - record.at),
        usable: record.delay > 0 && (maxDelay === 0 || record.delay <= maxDelay)
      }
    }
    // 现测路径：probeOne 一定写过表，读不到只可能是并发 prune（基线刚跑完）擦掉了
    const fresh = getFreshDelayRecord(name, Number.MAX_SAFE_INTEGER, now)
    const ageMs = getRecordAgeMs(name, now) ?? 0
    const delay = fresh?.delay ?? 0
    return {
      name,
      delay,
      // ⚠ 不能写成 `fresh?.err ?? 'kernel_error'`：测通的记录 err 就是 null，
      // ?? 对 null 也会兜底，于是每一个成功的现测都会被标成 kernel_error。
      // 这里要区分的是「表里没这条记录」和「记录里 err 是 null」。
      err: fresh ? fresh.err : 'kernel_error',
      ageMs,
      usable: delay > 0 && (maxDelay === 0 || delay <= maxDelay)
    }
  })

  const aliveCount = results.filter((item) => item.delay > 0).length
  const filteredCount = results.filter((item) => item.delay > 0 && !item.usable).length
  const elapsedMs = Date.now() - startedAt

  probeLogger.info(
    `named probe done: ${aliveCount}/${targets.length} alive in ${elapsedMs}ms ` +
      `(fresh ${hits.size}, probed ${toProbe.length}, filtered ${filteredCount}, ` +
      `received ${raw.length}, unknown ${unknown.length}, rejected ${rejected.length}, ` +
      `truncated ${valid.length - targets.length}, maxAge ${maxAgeMs}ms, maxDelay ${maxDelay})`
  )

  return {
    results,
    unknown,
    rejected,
    received: raw.length,
    deduped: deduped.length,
    accepted: targets.length,
    truncated: valid.length - targets.length,
    freshCount: hits.size,
    probedCount: toProbe.length,
    aliveCount,
    filteredCount,
    timeout: DELAY_PROBE_TIMEOUT,
    url,
    maxAgeMs,
    maxDelay,
    elapsedMs
  }
}

/**
 * 读配置里的周期间隔（分钟）。0 = 关闭周期探测。
 *
 * 读不到配置时回落到默认值而不是 0：把「读配置失败」解释成「用户不想测速」会让
 * probeStore 永远空着，脚本拿到空名单却查不出原因。
 */
async function resolveIntervalMinutes(): Promise<number> {
  try {
    const { delayProbeIntervalMinutes } = await getAppConfig()
    return normalizeDelayProbeIntervalMinutes(delayProbeIntervalMinutes)
  } catch (e) {
    probeLogger.warn('Failed to read delay probe interval, falling back to default', e)
    return DELAY_PROBE_FULL_INTERVAL_MINUTES
  }
}

export async function initDelayProbe(): Promise<void> {
  stopDelayProbe()

  // 启动后先等一会儿再跑第一轮：内核刚起来时还在建连接、拉 geo 数据，
  // 这时候打几百个测速请求既慢又不准。
  //
  // 这一轮不是可选项：probeStore 不落盘，冷启动时表是空的，
  // 而 isUsable() 读表 —— 没有这一轮，脚本会拿到空名单。
  //
  // ⚠ 即使用户把间隔设成 0（关闭周期探测），这一轮**照样跑**。0 的语义是
  // 「不要每隔一段时间自动测」，不是「永远不要有数据」。同理事件触发
  // （订阅更新 / 切配置 / 配置热重载）也不受间隔设置影响。
  startupTimer = setTimeout(() => {
    startupTimer = null
    void runProbeExclusive('startup')
  }, DELAY_PROBE_STARTUP_DELAY_MS)

  const minutes = await resolveIntervalMinutes()
  if (minutes <= 0) {
    probeLogger.info('Periodic delay probe disabled by config (interval = 0)')
    return
  }

  // 用 setInterval 而不是 cron 表达式：这里的语义是「每隔 N 分钟」，而 cron 是
  // 「在某些时刻」。旧实现写成 `0 0 */H * * *`，于是它其实是整点对齐的
  // （0/3/6…点），任意分钟数根本表达不出来，还带来一个边界坑：2:59 启动 app
  // 会在 2:59:20 跑一轮 startup，3:00:00 又被 cron 触发一轮，两轮能不能合并
  // 完全取决于第一轮有没有跨过整点（靠单飞锁碰运气）。间隔计时没有这个问题。
  fullProbeTimer = setInterval(
    () => {
      void runProbeExclusive('interval')
    },
    minutes * 60 * 1000
  )
  probeLogger.info(`Delay probe scheduled every ${minutes} minute(s)`)
}

/**
 * 配置改了之后重建调度。供 IPC 在用户保存间隔设置后调用。
 *
 * 会重新走一遍 startup 延迟首轮 —— 这是刻意的：用户刚把间隔从 0 改成有值时，
 * 大概率就是想要一轮数据，不该让他等一个完整周期。
 */
export async function restartDelayProbe(): Promise<void> {
  await initDelayProbe()
}

export function stopDelayProbe(): void {
  if (startupTimer) {
    clearTimeout(startupTimer)
    startupTimer = null
  }
  if (fullProbeTimer) {
    clearInterval(fullProbeTimer)
    fullProbeTimer = null
  }
}
