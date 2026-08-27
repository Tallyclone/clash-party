import { Cron } from 'croner'
import {
  DELAY_PROBE_CANDIDATE_HISTORY_COUNT,
  DELAY_PROBE_CANDIDATE_MAX_AGE_MS,
  DELAY_PROBE_CANDIDATE_MAX_DELAY,
  DELAY_PROBE_FULL_CONCURRENCY,
  DELAY_PROBE_FULL_INTERVAL_MINUTES,
  DELAY_PROBE_FULL_TIMEOUT,
  DELAY_PROBE_QUICK_CONCURRENCY,
  DELAY_PROBE_QUICK_TIMEOUT,
  DELAY_PROBE_STARTUP_DELAY_MS
} from '../../shared/appConfig'
import { createLogger } from '../utils/logger'
import { mihomoProxies, mihomoProxyDelay } from './mihomoApi'

const probeLogger = createLogger('delay-probe')

/**
 * 延迟探测模块。
 *
 * 存在理由：`select` 类型的策略组（例如覆写脚本生成的「[能用]」）内核不会主动做健康检查，
 * 因此它成员的延迟历史长期是空的。而「隐藏慢节点」和「脚本控制 API 只给能用的节点」
 * 这两件事都要读延迟数字才能成立 —— 数字必须有人去测，这个模块就是唯一负责测的地方。
 *
 * 两种工作：
 * - 全量基线：每 DELAY_PROBE_FULL_INTERVAL_MINUTES 分钟把所有具体节点测一遍。
 *   没人等它，超时给得宽，目的是让代理页面随时有数字可看。这是唯一的固定开销。
 * - 现测（quick）：脚本请求名单且数据已经太旧时临时触发。只测「最近还达标过」的候选，
 *   超时压到略高于判定阈值，因此通常 1 秒级就能返回。
 *
 * 候选池判定回看最近若干条 history（见 isProbeCandidate），不是只看最后一条 ——
 * 只看最后一条会让一次失败等于永久除名，实测有 22% 的节点处于抖动状态，会被大量误杀。
 *
 * 延迟数字本身不在这里缓存 —— 它由内核记在每个节点的 history 上，
 * 读 `/proxies` 就是最新值。这里只记录「最近一次探测是什么时候」，用于判断数据新鲜度。
 */

/** 这些内置出口没有测速意义 */
const SKIP_PROXY_NAMES = new Set([
  'DIRECT',
  'REJECT',
  'REJECT-DROP',
  'PASS',
  // 实测内核还会暴露一个 PASS-RULE（type=PassRule）：它永远测不通，
  // 漏掉它等于每轮全量都白占一个 DELAY_PROBE_FULL_TIMEOUT 的槽位
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

export interface IDelayProbeSnapshot {
  /** 最近一次探测（全量或现测）完成的时间戳，毫秒。从未探测过为 null */
  lastProbeAt: number | null
  /** 最近一次全量基线完成的时间戳，毫秒 */
  lastFullProbeAt: number | null
  /** 最近一次探测覆盖的节点数 */
  lastProbedCount: number
  /** 最近一次探测中测出可用（延迟大于 0）的节点数 */
  lastAliveCount: number
  /** 是否有探测正在进行 */
  probing: boolean
}

const state = {
  lastProbeAt: null as number | null,
  lastFullProbeAt: null as number | null,
  lastProbedCount: 0,
  lastAliveCount: 0
}

let fullProbeCron: Cron | null = null
let startupTimer: NodeJS.Timeout | null = null
/** 同一时刻只允许一个探测在跑，后来的调用复用同一个 Promise，避免脚本并发把机场打爆 */
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

/** 数据年龄（毫秒）。从未探测过返回 null */
export function getDelayDataAgeMs(): number | null {
  if (state.lastProbeAt === null) return null
  return Date.now() - state.lastProbeAt
}

interface IProbeTargets {
  names: string[]
  /** 节点名 -> 最近若干条延迟记录（内核 history 的尾部切片，按时间升序） */
  histories: Map<string, IMihomoHistory[]>
}

/**
 * 这个节点还值不值得花一个现测槽位。
 *
 * 判定口径：最近 count 条记录里存在一条「延迟达标且不算太旧」的成绩。
 *
 * 为什么要回看多条而不是只看最后一条：现测超时压到了 1200ms，内核会把超时记成
 * delay 0（与「连不上」无法区分），于是一个真实延迟抖到 1300ms 的健康节点会被
 * 记成 0 → 出候选池 → 之后所有现测都不再碰它 → 只能等下一轮全量捞回来。
 * 实测 426 个节点的订阅里有 94 个（22%）处于「最近 3 条既有失败又有达标」的抖动状态。
 *
 * 时间解析失败时**不因此排除**：`history[].time` 由内核给出（实测是带时区偏移的
 * RFC3339），万一某个版本/平台格式变了，严格判断会让候选池恒空，
 * 于是每轮现测都退化成测全部节点 —— 那是比放宽严重得多的故障。
 *
 * ⚠ 注意与 scriptApiServer 的 isUsable() 分工：这里回答「要不要测它」，看最近多条；
 * 那里回答「要不要把它给脚本」，只看最后一条。两者故意不一致，**不要对齐** ——
 * 对齐会让脚本拿到实际已经挂掉的节点，直接违背这套过滤存在的意义。
 * 因此「节点在候选池里、每轮都被测，但因为最后一条是 0 而不进名单」是预期状态。
 */
export function isProbeCandidate(
  history: IMihomoHistory[] | undefined,
  now: number = Date.now(),
  options: { count?: number; maxAgeMs?: number } = {}
): boolean {
  if (!Array.isArray(history) || history.length === 0) return false

  const count = options.count ?? DELAY_PROBE_CANDIDATE_HISTORY_COUNT
  const maxAgeMs = options.maxAgeMs ?? DELAY_PROBE_CANDIDATE_MAX_AGE_MS

  return history.slice(-count).some((record) => {
    if (!record || typeof record.delay !== 'number') return false
    if (record.delay <= 0 || record.delay > DELAY_PROBE_CANDIDATE_MAX_DELAY) return false
    const time = Date.parse(record.time)
    return Number.isNaN(time) || now - time <= maxAgeMs
  })
}

/** 「只看最后一条」的旧口径。仅用于日志里算出有多少节点是靠回看留下来的 */
function hasUsableLastRecord(history: IMihomoHistory[] | undefined): boolean {
  if (!Array.isArray(history) || history.length === 0) return false
  const last = history[history.length - 1]
  return (
    !!last &&
    typeof last.delay === 'number' &&
    last.delay > 0 &&
    last.delay <= DELAY_PROBE_CANDIDATE_MAX_DELAY
  )
}

async function collectProbeTargets(): Promise<IProbeTargets> {
  const proxies = await mihomoProxies()
  const names: string[] = []
  const histories = new Map<string, IMihomoHistory[]>()

  for (const [name, proxy] of Object.entries(proxies.proxies ?? {})) {
    if (!proxy) continue
    // 策略组不测：测一个组等于测它当前选中的那个节点，会重复且结果归属不清
    if ('all' in proxy) continue
    if (SKIP_PROXY_NAMES.has(name)) continue
    if (SKIP_PROXY_TYPES.has(String(proxy.type ?? '').toLowerCase())) continue

    names.push(name)
    const history = proxy.history
    // 只留尾部若干条：候选池判定用不到更早的（内核每个节点最多也只给 10 条）
    histories.set(
      name,
      Array.isArray(history) ? history.slice(-DELAY_PROBE_CANDIDATE_HISTORY_COUNT) : []
    )
  }

  return { names, histories }
}

/**
 * 并发跑一批测速。返回测出可用（延迟大于 0）的节点数。
 *
 * 单个节点失败一律吞掉：节点连不上是常态，内核会把它记成延迟 0，
 * 这本身就是我们要的信息，没必要往上抛。
 */
async function probeNames(names: string[], timeout: number, concurrency: number): Promise<number> {
  let alive = 0
  const running: Promise<void>[] = []

  for (const name of names) {
    const task = mihomoProxyDelay(name, undefined, undefined, timeout)
      .then((res) => {
        if (res && typeof res.delay === 'number' && res.delay > 0) alive += 1
      })
      .catch(() => {})

    const tracked: Promise<void> = task.then(() => {
      const index = running.indexOf(tracked)
      if (index >= 0) running.splice(index, 1)
    })
    running.push(tracked)

    if (running.length >= Math.max(1, concurrency)) {
      await Promise.race(running)
    }
  }

  await Promise.all(running)
  return alive
}

async function runProbe(scope: 'full' | 'quick'): Promise<void> {
  const startedAt = Date.now()
  const { names, histories } = await collectProbeTargets()

  if (names.length === 0) {
    probeLogger.warn('No probeable proxies found, skipping')
    return
  }

  let targets = names
  let timeout = DELAY_PROBE_FULL_TIMEOUT
  let concurrency = DELAY_PROBE_FULL_CONCURRENCY
  let rescued = 0

  if (scope === 'quick') {
    timeout = DELAY_PROBE_QUICK_TIMEOUT
    concurrency = DELAY_PROBE_QUICK_CONCURRENCY
    // 候选池：最近若干条 history 里还达标过的节点。
    // 一个都没有（例如刚启动、从未测过，或整体断网连挂数轮）时退化成测全部，
    // 否则名单会永远是空的。
    const candidates = names.filter((name) => isProbeCandidate(histories.get(name), startedAt))
    // 其中有多少是靠回看留下来的（旧口径只看最后一条，会把它们剔掉）。
    // 没有这个计数就没法判断回看机制到底有没有在起作用。
    rescued = candidates.filter((name) => !hasUsableLastRecord(histories.get(name))).length
    targets = candidates.length > 0 ? candidates : names
  }

  const alive = await probeNames(targets, timeout, concurrency)

  const now = Date.now()
  state.lastProbeAt = now
  state.lastProbedCount = targets.length
  state.lastAliveCount = alive
  if (scope === 'full') state.lastFullProbeAt = now

  probeLogger.info(
    `${scope} probe done: ${alive}/${targets.length} alive in ${now - startedAt}ms` +
      (scope === 'quick'
        ? targets.length === names.length
          ? ` (candidate pool empty, fell back to all ${names.length})`
          : ` (candidates out of ${names.length}, ${rescued} kept by history look-back)`
        : '')
  )
}

/** 串行化探测：已有探测在跑时直接复用，不叠加请求 */
function runProbeExclusive(scope: 'full' | 'quick'): Promise<void> {
  if (inflightProbe) return inflightProbe
  inflightProbe = runProbe(scope)
    .catch((e) => {
      probeLogger.warn(`Failed to run ${scope} delay probe`, e)
    })
    .finally(() => {
      inflightProbe = null
    })
  return inflightProbe
}

/** 手动触发一次全量基线，供脚本控制 API 的 /probe 使用 */
export async function probeAllProxies(): Promise<IDelayProbeSnapshot> {
  await runProbeExclusive('full')
  return getDelayProbeSnapshot()
}

/** 手动触发一次现测，供脚本控制 API 的 /probe 使用 */
export async function probeCandidateProxies(): Promise<IDelayProbeSnapshot> {
  await runProbeExclusive('quick')
  return getDelayProbeSnapshot()
}

/**
 * 保证延迟数据不超过 maxAgeMs。数据够新则什么都不做。
 *
 * @returns 本次是否真的触发了探测
 */
export async function ensureFreshDelays(maxAgeMs: number): Promise<boolean> {
  const age = getDelayDataAgeMs()
  if (age !== null && age <= maxAgeMs) return false
  await runProbeExclusive('quick')
  return true
}

export async function initDelayProbe(): Promise<void> {
  stopDelayProbe()

  // 启动后先等一会儿再跑第一轮：内核刚起来时还在建连接、拉 geo 数据，
  // 这时候打 159 个测速请求既慢又不准。
  startupTimer = setTimeout(() => {
    startupTimer = null
    void runProbeExclusive('full')
  }, DELAY_PROBE_STARTUP_DELAY_MS)

  try {
    fullProbeCron = new Cron(`0 */${DELAY_PROBE_FULL_INTERVAL_MINUTES} * * * *`, () => {
      void runProbeExclusive('full')
    })
    probeLogger.info(`Delay probe scheduled every ${DELAY_PROBE_FULL_INTERVAL_MINUTES} minutes`)
  } catch (e) {
    probeLogger.warn('Failed to schedule delay probe cron', e)
  }
}

export function stopDelayProbe(): void {
  if (startupTimer) {
    clearTimeout(startupTimer)
    startupTimer = null
  }
  if (fullProbeCron) {
    fullProbeCron.stop()
    fullProbeCron = null
  }
}
