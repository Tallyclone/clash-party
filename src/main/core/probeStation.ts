import { connect as netConnect, isIP, Socket } from 'net'
import { connect as tlsConnect, TLSSocket } from 'tls'
import {
  PROBE_IP_LEASE_HARD_LIMIT_MS,
  PROBE_IP_MAX_NAMES,
  PROBE_IP_TARGET_TIMEOUT_MS,
  PROBE_IP_TARGETS,
  PROBE_STATION_DIAL_FAIL_THRESHOLD,
  PROBE_STATION_PER_REQUEST_QUOTA
} from '../../shared/appConfig'
import { probeStationGroupName } from '../../shared/scriptOutlet'
import { createLogger } from '../utils/logger'
import { isProbeableProxy, triggerBaselineProbe } from './delayProbe'
import { mihomoChangeProxy, mihomoProxies } from './mihomoApi'
import { acquireProbeSlots, releaseProbeSlots } from './probeGate'
import { getProbeStationPorts } from './probeStationRegistry'
import { ProbeErrCode } from './probeStore'

const stationLogger = createLogger('probe-station')

/**
 * 探测工位：`mode=ip` 专用。
 *
 * ## 为什么只有 mode=ip 需要工位
 *
 * 内核只会告诉你"延迟多少"，不会告诉你"从哪个 IP 出去的"。要拿真实出口 IP
 * 只能真的走一遍：把某个 select 组切到目标节点，然后经这个组绑定的本地端口发请求。
 *
 * 而"切组"是**全局可见的副作用**。这就是工位与内核测速的本质差别：
 *
 * |            | 内核测速（mode=delay）        | 工位拨测（mode=ip）                    |
 * | 性质       | 弹性：无状态，可排队          | 刚性：独占，全局副作用                 |
 * | 多脚本争用 | 各自排队变慢，答案都是对的    | 互相踩：A 切到 X，B 立刻切到 Y，       |
 * |            |                               | A 的拨测从 Y 出网，结果串味且无法察觉  |
 * | 堆数量能解决吗 | 不需要                    | 不能，只把翻车阈值推高一点             |
 *
 * 所以 mode=delay 一律走内核信号量（见 delayProbe），工位只服务这里，
 * 并且必须有配额（池 100 / 单请求 50），把"打爆"变成"排队"。
 *
 * ## 及时释放的五条机制（缺一条都会退化）
 *
 * 1. **首成功即 abort**：三个目标并行，第一个拿到合法 IP 就掐断其余两个。
 *    实测槽位 p50 1472ms，而单目标 totalMs p50 1043ms —— 差的那 430ms 是白等的。
 * 2. **每目标 2500ms 封顶 + 并行**：最坏槽位 2500ms。串行全打实测槽位均值 4192ms，
 *    总耗时 28.4s vs 并行 10.6s，是反面教材。
 * 3. **逐个立即归还**，不攒到请求结束：让第二个脚本在第一个还在跑时就能拿到工位。
 * 4. **finally + 租约 watchdog**：工位泄漏不可恢复（池子只会单向变小直到全卡死），
 *    而 finally 挡不住进程级异常路径，所以再加一道按时间强制回收。
 * 5. **TCP 预检 + dial_failed 熔断**：踩过的坑 —— 9 个不存在的端口以 0~18ms 的速度
 *    疯狂抢任务，把 100 个节点里 64 个健康的判成 dial_failed。失败越快抢到越多，
 *    坏工位会自我放大，所以必须开跑前预检 + 运行时摘除。
 *
 * ## 为什么不恢复原选中项
 *
 * PARTY-PROBE-* 是专用组，没有业务读取它。（实验脚本必须恢复，是因为它借用了业务组。）
 */

/**
 * 当前配置里实际存在的工位端口。
 *
 * **不做任何推算**：端口由注入侧（factory.ts 生成配置时调 injectProbeStations）决定，
 * 并登记到 probeStationRegistry。旧实现在这里按 `PROBE_STATION_PORT_BASE + index`
 * 自己算一遍，与注入侧构成两个真相源 —— 注入侧一旦为了避开用户的业务出口端口而平移窗口，
 * 这边就会算出一批不存在的端口，而组名↔端口的错位**不会报错、结果看起来完全正常**。
 */
export function probeStationPorts(): number[] {
  return getProbeStationPorts()
}

interface IStation {
  port: number
  group: string
  /** 连续 dial_failed 次数，达到阈值就摘除 */
  dialFails: number
}

interface ILease {
  token: number
  station: IStation
  acquiredAt: number
}

const idleStations: IStation[] = []
const waiters: ((station: IStation) => void)[] = []
const activeLeases = new Map<number, ILease>()
const quarantined = new Set<number>()
let leaseSeq = 0
let watchdogTimer: NodeJS.Timeout | null = null
let readyPromise: Promise<number> | null = null

/** TCP 能不能连上这个端口。判"工位到底存在吗"用它，判节点好坏绝不能用它 */
function checkPort(port: number, timeoutMs: number = 800): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = netConnect({ host: '127.0.0.1', port })
    let settled = false
    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeoutMs, () => finish(false))
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}

/**
 * 懒初始化工位池：逐端口 TCP 预检，只把真的在监听的端口放进池子。
 *
 * 必须预检：注入的 listener 只有在内核重载配置之后才存在。冷启动或用户刚改配置时
 * 端口可能全都不通，此时应该明确报错，而不是让每个节点都拿到一个 dial_failed。
 */
async function ensureStationsReady(): Promise<number> {
  if (readyPromise) return readyPromise

  readyPromise = (async () => {
    const ports = probeStationPorts()
    if (!ports.length) {
      // 与"端口存在但连不上"分开记录：这一条说明配置生成阶段就没注入工位
      // （脚本 API 关着，或整段找不到连续空闲端口），排障方向完全不同。
      idleStations.length = 0
      stationLogger.warn('no probe station port registered by the config factory')
      startWatchdog()
      return 0
    }

    const alive: number[] = []
    const batch = 20
    for (let i = 0; i < ports.length; i += batch) {
      const slice = ports.slice(i, i + batch)
      const checks = await Promise.all(slice.map((port) => checkPort(port)))
      slice.forEach((port, index) => {
        if (checks[index]) alive.push(port)
      })
    }

    idleStations.length = 0
    for (const port of alive) {
      idleStations.push({ port, group: probeStationGroupName(port), dialFails: 0 })
    }

    stationLogger.info(`probe stations ready: ${alive.length}/${ports.length} ports listening`)
    startWatchdog()
    return alive.length
  })()

  return readyPromise
}

/** 配置变化后强制重新预检（端口可能刚被注入或刚被移除） */
export function resetProbeStations(): void {
  readyPromise = null
  quarantined.clear()
}

/**
 * 内核刚加载完一份配置（启动 / 重启 / 热重载）后调用。
 *
 * 两件事必须一起做，所以收在一个入口，避免调用方只做一半：
 *
 * 1. `resetProbeStations()` —— 工位池缓存的是「哪些端口真在监听」的预检结果。
 *    配置换了，端口可能刚被注入、刚被移除，或者整份配置里工位被跳过了。
 *    不重置就会拿着上一份配置的池子去拨测，得到成片的 dial_failed。
 * 2. `triggerBaselineProbe()` —— probeStore 不落盘，且只装「被点名过的节点」。
 *    换配置后节点名整批变化，不重跑一轮基线的话 `isUsableName()` 全返回 false，
 *    脚本拿到空名单；而名单里没有的名字脚本永远不会拿来 `/probe`，
 *    于是永远不进表 —— 这个死锁不会自愈。
 */
export function notifyProbeConfigReloaded(reason: string): void {
  resetProbeStations()
  triggerBaselineProbe(reason)
}

function startWatchdog(): void {
  if (watchdogTimer) return
  watchdogTimer = setInterval(() => {
    const now = Date.now()
    for (const lease of [...activeLeases.values()]) {
      if (now - lease.acquiredAt <= PROBE_IP_LEASE_HARD_LIMIT_MS * 2) continue
      // 到这里说明有人拿了工位却没归还（异常路径 / 事件循环被卡住）。
      // 工位泄漏不可恢复，宁可强制收回也不能让池子越用越小。
      stationLogger.warn(
        `force-reclaiming probe station ${lease.station.port} after ${now - lease.acquiredAt}ms`
      )
      releaseLease(lease)
    }
  }, 1000)
  watchdogTimer.unref?.()
}

function acquireStation(): Promise<ILease> {
  return new Promise((resolve) => {
    const handout = (station: IStation): void => {
      leaseSeq += 1
      const lease: ILease = { token: leaseSeq, station, acquiredAt: Date.now() }
      activeLeases.set(lease.token, lease)
      resolve(lease)
    }

    const station = idleStations.shift()
    if (station) {
      handout(station)
      return
    }
    waiters.push(handout)
  })
}

/** 幂等：watchdog 与业务代码的 finally 可能同时调，只有第一次生效 */
function releaseLease(lease: ILease): void {
  if (!activeLeases.delete(lease.token)) return
  if (quarantined.has(lease.station.port)) return

  const next = waiters.shift()
  if (next) next(lease.station)
  else idleStations.push(lease.station)
}

/**
 * dial_failed 聚集熔断：连续失败达阈值就把工位摘出去，后台 TCP 复检通过再放回。
 *
 * 只有 dial_failed 能触发：它的含义是"连本地端口都连不上"，与远端节点无关，
 * 是唯一能证明"工位自己坏了"的证据。用别的错误码触发会把节点问题误判成工位问题。
 */
function noteStationResult(station: IStation, err: ProbeErrCode | null): void {
  if (err !== 'dial_failed') {
    station.dialFails = 0
    return
  }

  station.dialFails += 1
  if (station.dialFails < PROBE_STATION_DIAL_FAIL_THRESHOLD) return

  quarantined.add(station.port)
  stationLogger.warn(`probe station ${station.port} quarantined after ${station.dialFails} dials`)
  void (async () => {
    const ok = await checkPort(station.port)
    quarantined.delete(station.port)
    station.dialFails = 0
    if (!ok) {
      stationLogger.warn(`probe station ${station.port} still down, dropped from pool`)
      return
    }
    const next = waiters.shift()
    if (next) next(station)
    else idleStations.push(station)
  })()
}

interface IDialOutcome {
  ip: string | null
  ipFamily: 4 | 6 | null
  loc: string | null
  target: string
  /** TCP + CONNECT + TLS 建连耗时 */
  connectMs: number | null
  /** 连接就绪后发出请求到收到首字节（纯链路 RTT，可与内核 delay 直接对比） */
  responseMs: number | null
  err: ProbeErrCode | null
}

function parseTraceBody(body: string): { ip: string | null; loc: string | null } {
  // cloudflare 的 cdn-cgi/trace 是 `key=value` 逐行，其余目标直接回一个 IP
  if (body.includes('ip=')) {
    let ip: string | null = null
    let loc: string | null = null
    for (const line of body.split('\n')) {
      const trimmed = line.trim()
      if (trimmed.startsWith('ip=')) ip = trimmed.slice(3).trim()
      else if (trimmed.startsWith('loc=')) loc = trimmed.slice(4).trim()
    }
    return { ip: ip && isIP(ip) ? ip : null, loc: loc || null }
  }
  const first = body.trim().split('\n')[0]?.trim() ?? ''
  return { ip: isIP(first) ? first : null, loc: null }
}

/**
 * 经某个工位端口拨一个目标：本地 HTTP CONNECT → TLS → GET → 解析出口 IP。
 *
 * 手写而不用 axios/undici + agent：这里要分段计时（connectMs / responseMs），
 * 而高层库把建连和请求揉在一起，拆不出来。项目里也就不用为此加依赖。
 */
function dialTarget(
  port: number,
  target: string
): { promise: Promise<IDialOutcome>; cancel: () => void } {
  const url = new URL(target)
  const host = url.hostname
  const hostPort = url.port ? Number(url.port) : url.protocol === 'http:' ? 80 : 443
  const path = `${url.pathname || '/'}${url.search}`

  let socket: Socket | null = null
  let secure: TLSSocket | null = null
  let timer: NodeJS.Timeout | null = null
  let settled = false
  let cancelFn: () => void = () => {}

  const promise = new Promise<IDialOutcome>((resolve) => {
    const startedAt = Date.now()
    let connectMs: number | null = null
    let requestSentAt = 0
    let responseMs: number | null = null
    let headerDone = false
    let statusCode = 0
    let body = ''
    let connectBuffer = Buffer.alloc(0)

    const cleanup = (): void => {
      if (timer) clearTimeout(timer)
      timer = null
      secure?.destroy()
      socket?.destroy()
    }

    const finish = (err: ProbeErrCode | null, ip: string | null, loc: string | null): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve({
        ip,
        ipFamily: ip ? ((isIP(ip) === 6 ? 6 : 4) as 4 | 6) : null,
        loc,
        target,
        connectMs,
        responseMs,
        err
      })
    }

    cancelFn = () => finish('timeout', null, null)

    timer = setTimeout(() => finish('timeout', null, null), PROBE_IP_TARGET_TIMEOUT_MS)

    const onBodyEnd = (): void => {
      if (settled) return
      if (statusCode < 200 || statusCode >= 300) {
        // 有响应但不是 2xx：落地机劫持或中间设备拦截
        finish('bad_response', null, null)
        return
      }
      const parsed = parseTraceBody(body)
      if (!parsed.ip) {
        finish('bad_response', null, null)
        return
      }
      finish(null, parsed.ip, parsed.loc)
    }

    const sendRequest = (stream: TLSSocket | Socket): void => {
      connectMs = Date.now() - startedAt
      requestSentAt = Date.now()
      stream.write(
        `GET ${path} HTTP/1.1\r\n` +
          `Host: ${host}\r\n` +
          `User-Agent: clash-party-probe/1.0\r\n` +
          `Accept: */*\r\n` +
          `Connection: close\r\n\r\n`
      )
      stream.on('data', (chunk: Buffer) => {
        if (responseMs === null) responseMs = Date.now() - requestSentAt
        if (!headerDone) {
          body += chunk.toString('latin1')
          const split = body.indexOf('\r\n\r\n')
          if (split < 0) return
          const head = body.slice(0, split)
          statusCode = Number(head.split('\r\n')[0]?.split(' ')[1] ?? 0)
          body = body.slice(split + 4)
          headerDone = true
        } else {
          body += chunk.toString('latin1')
        }
        // trace/ipify 的响应都很小；够长就不必等对端关连接
        if (body.length > 4096) onBodyEnd()
      })
      stream.once('end', onBodyEnd)
      stream.once('close', onBodyEnd)
      stream.once('error', () => finish('bad_response', null, null))
    }

    const upgradeTls = (): void => {
      secure = tlsConnect({
        socket: socket as Socket,
        servername: host,
        ALPNProtocols: ['http/1.1']
      })
      secure.once('secureConnect', () => sendRequest(secure as TLSSocket))
      // TLS 失败是有信息量的失败：落地机拒绝或中间链路阻断，与"节点连不上"不同
      secure.once('error', () => finish('tls_failed', null, null))
    }

    socket = netConnect({ host: '127.0.0.1', port })
    // 本地端口连不上 = 工位坏了，与节点无关。这是熔断的唯一硬证据
    socket.once('error', () => finish('dial_failed', null, null))
    socket.once('connect', () => {
      socket?.write(`CONNECT ${host}:${hostPort} HTTP/1.1\r\nHost: ${host}:${hostPort}\r\n\r\n`)
    })
    socket.on('data', (chunk: Buffer) => {
      if (settled) return
      connectBuffer = Buffer.concat([connectBuffer, chunk])
      const split = connectBuffer.indexOf('\r\n\r\n')
      if (split < 0) return

      const head = connectBuffer.slice(0, split).toString('latin1')
      const rest = connectBuffer.slice(split + 4)
      const code = Number(head.split('\r\n')[0]?.split(' ')[1] ?? 0)
      socket?.removeAllListeners('data')
      if (code !== 200) {
        // 本地代理拒绝建隧道：内核那边到落地这一段没通
        finish('unreachable', null, null)
        return
      }
      if (rest.length > 0) socket?.unshift(rest)
      if (url.protocol === 'http:') sendRequest(socket as Socket)
      else upgradeTls()
    })
  })

  return { promise, cancel: () => cancelFn() }
}

/** 失败也要挑一个最有信息量的错误码回去：dial_failed 最重要（它决定要不要熔断工位） */
const ERR_PRIORITY: ProbeErrCode[] = [
  'dial_failed',
  'tls_failed',
  'unreachable',
  'timeout',
  'bad_response'
]

function pickWorst(outcomes: IDialOutcome[]): IDialOutcome {
  for (const code of ERR_PRIORITY) {
    const hit = outcomes.find((item) => item.err === code)
    if (hit) return hit
  }
  return outcomes[0]
}

/**
 * 三目标并行、首成功即 abort。
 *
 * 为什么必须多目标：实测三个目标各自成功率几乎一样（79/77/80、86/85/88），
 * 但**失败集合不同** —— cf-trace 失败的 21 个里有 9 个换目标就通了，
 * 而且被救回的全部是 cf=timeout。单目标会有 5~9% 的"目标问题"假阴性。
 */
async function dialAllTargets(port: number): Promise<IDialOutcome> {
  return await new Promise<IDialOutcome>((resolve) => {
    const attempts = PROBE_IP_TARGETS.map((target) => dialTarget(port, target))
    const failures: IDialOutcome[] = []
    let done = false

    attempts.forEach(({ promise }) => {
      void promise.then((outcome) => {
        if (done) return
        if (outcome.ip) {
          done = true
          attempts.forEach((attempt) => attempt.cancel())
          resolve(outcome)
          return
        }
        failures.push(outcome)
        if (failures.length === attempts.length) {
          done = true
          resolve(pickWorst(failures))
        }
      })
    })
  })
}

export interface IProbeIpItem {
  name: string
  ip: string | null
  ipFamily: 4 | 6 | null
  loc: string | null
  target: string | null
  /** 排队等工位 + PUT 切组的耗时（切组实测 p50 14~15ms） */
  queueMs: number
  connectMs: number | null
  responseMs: number | null
  /** 恒等于 queueMs + connectMs + responseMs */
  totalMs: number
  err: ProbeErrCode | null
}

export interface IProbeIpResult {
  results: IProbeIpItem[]
  unknown: string[]
  rejected: string[]
  received: number
  deduped: number
  accepted: number
  truncated: number
  limit: number
  okCount: number
  stations: { pool: number; quota: number; granted: number }
  targets: string[]
  targetTimeout: number
  elapsedMs: number
}

/**
 * 按名单实拨，返回每个节点的真实出口 IP。每次都现测（不缓存）。
 *
 * ⚠ 文档必须写清：**ip 模式失败 ≠ 节点不可用**。目标站点自身的抖动会造成
 * 5~9% 的假阴性，业务侧照着这个结果去"误杀"健康节点是错误用法。
 * 判可用性请用 mode=delay。
 *
 * ⚠ 另一个容易踩的坑：出口 IP 大量共用。实测 91 个可用节点只对应 70 个唯一出口 IP，
 * 单个 IP 最多被 4 个节点名共用。把节点数当出口数会高估容量。
 */
export async function probeIpByStations(names: unknown): Promise<IProbeIpResult> {
  const startedAt = Date.now()
  const raw = Array.isArray(names) ? names : []

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

  const limit = PROBE_IP_MAX_NAMES
  const targets = valid.slice(0, limit)

  const pool = await ensureStationsReady()
  if (pool === 0) {
    // 两种成因要能从报错里分辨出来，排障方向完全不同：
    // 端口表是空的 → 配置生成阶段没注入（脚本 API 关着，或找不到连续空闲端口窗口）；
    // 端口表非空但一个都连不上 → 内核还没重载这份配置。
    if (probeStationPorts().length === 0) {
      throw new Error(
        'no probe station was injected into the running config; ' +
          'check the "Probe stations injected" line in the app log'
      )
    }
    throw new Error(
      'no probe station is listening; the core may not have reloaded the injected listeners yet'
    )
  }

  // 配额是"同时最多占这么多"，不是预留：脚本 A 占 50、池剩 50；B 也占 50、池剩 0；
  // C 只能排队等归还。这样多脚本并行时是排队变慢，而不是互相踩。
  const quota = Math.max(1, Math.min(PROBE_STATION_PER_REQUEST_QUOTA, pool))
  const results: IProbeIpItem[] = new Array(targets.length)
  let cursor = 0
  let okCount = 0

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= targets.length) return

      const name = targets[index]
      const queueStartedAt = Date.now()

      // ⚠ 顺序不能反：**先领全局闸门名额，再拿工位**。
      //
      // 反过来（先占工位再等闸门）会踩两个坑：
      // 1. 死锁风险 —— 两个 worker 一个持工位等名额、一个持名额等工位，就锁住了。
      //    统一成「名额 → 工位」后，任何持工位的人都已经拿到名额、必定能往下走。
      // 2. watchdog 误收 —— 租约超过 PROBE_IP_LEASE_HARD_LIMIT_MS × 2 就会被强制回收。
      //    闸门在基线满载时的排队时间远超这个值，于是工位会在 worker 眼皮底下被收走
      //    转给别人，两个 worker 同时切同一个组 —— 正是工位机制要防的「串味」。
      //    先等闸门就不会让租约里含有排队时间。
      //
      // 名额按连接数算：一个节点会同时拨 PROBE_IP_TARGETS 里的每个目标。
      const slots = await acquireProbeSlots(PROBE_IP_TARGETS.length)
      const lease = await acquireStation()
      let outcome: IDialOutcome | null = null
      let queueMs = Date.now() - queueStartedAt
      let switchErr: ProbeErrCode | null = null

      try {
        await mihomoChangeProxy(lease.station.group, name)
        // 切组后不需要 sleep：实测直接拨测即可，PUT 返回时选择已生效
        queueMs = Date.now() - queueStartedAt
        outcome = await dialAllTargets(lease.station.port)
      } catch (e) {
        stationLogger.debug(`failed to switch ${lease.station.group} -> ${name}`, e)
        switchErr = 'kernel_error'
        queueMs = Date.now() - queueStartedAt
      } finally {
        // 逐个立即归还，不攒到请求结束
        noteStationResult(lease.station, outcome?.err ?? null)
        releaseLease(lease)
        releaseProbeSlots(slots)
      }

      const connectMs = outcome?.connectMs ?? null
      const responseMs = outcome?.responseMs ?? null
      const item: IProbeIpItem = {
        name,
        ip: outcome?.ip ?? null,
        ipFamily: outcome?.ipFamily ?? null,
        loc: outcome?.loc ?? null,
        target: outcome?.ip ? outcome.target : null,
        queueMs,
        connectMs,
        responseMs,
        totalMs: queueMs + (connectMs ?? 0) + (responseMs ?? 0),
        err: switchErr ?? outcome?.err ?? null
      }
      if (item.ip) okCount += 1
      results[index] = item
    }
  }

  await Promise.all(Array.from({ length: Math.min(quota, targets.length) }, () => worker()))

  const elapsedMs = Date.now() - startedAt
  stationLogger.info(
    `ip probe done: ${okCount}/${targets.length} resolved in ${elapsedMs}ms ` +
      `(pool ${pool}, quota ${quota}, received ${raw.length}, unknown ${unknown.length}, ` +
      `rejected ${rejected.length}, truncated ${valid.length - targets.length})`
  )

  return {
    results: results.filter((item): item is IProbeIpItem => item !== undefined),
    unknown,
    rejected,
    received: raw.length,
    deduped: deduped.length,
    accepted: targets.length,
    truncated: valid.length - targets.length,
    limit,
    okCount,
    stations: { pool, quota, granted: Math.min(quota, targets.length) },
    targets: [...PROBE_IP_TARGETS],
    targetTimeout: PROBE_IP_TARGET_TIMEOUT_MS,
    elapsedMs
  }
}
