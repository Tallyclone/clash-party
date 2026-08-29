import { randomBytes } from 'crypto'
import http from 'http'
import express from 'express'
import {
  DEFAULT_AVAILABLE_DELAY_THRESHOLD,
  DELAY_PROBE_FRESH_MS,
  SCRIPT_API_LISTEN_ADDRESS,
  SCRIPT_API_MIN_MAX_AGE_MS,
  SCRIPT_API_NAMED_PROBE_MAX_NAMES
} from '../../shared/appConfig'
import { expandScriptOutlets } from '../../shared/scriptOutlet'
import { getAppConfig } from '../config'
import {
  getDelayDataAgeMs,
  getDelayProbeSnapshot,
  probeAllProxies,
  probeNamedProxies
} from '../core/delayProbe'
import { probeIpByStations } from '../core/probeStation'
import { getDelayRecord, getProbeStoreStats, isRecordUsable } from '../core/probeStore'
import {
  mihomoChangeProxy,
  mihomoCloseAllConnections,
  mihomoGroups,
  mihomoProxyDetail,
  mihomoUnfixedProxy
} from '../core/mihomoApi'
import {
  canStartScriptApi,
  generateScriptApiToken,
  isAuthorized,
  isGeneratedOutletGroup,
  isLoopbackAddress,
  normalizeScriptApiConfig,
  type INormalizedScriptApiConfig
} from '../core/scriptApi'
import { createLogger } from '../utils/logger'

const scriptApiLogger = createLogger('script-api')

let scriptApiServer: http.Server | null = null
let runningConfig: INormalizedScriptApiConfig | null = null

export function getScriptApiPort(): number | null {
  return runningConfig?.port ?? null
}

export function isScriptApiRunning(): boolean {
  return scriptApiServer !== null
}

/** 供 UI 首次开启时生成令牌 */
export function createScriptApiToken(): string {
  return generateScriptApiToken((size) => randomBytes(size))
}

function sendError(res: express.Response, status: number, message: string): void {
  res.status(status).json({ ok: false, error: message })
}

/**
 * 延迟过滤参数。
 *
 * 只有请求显式带了 `maxDelay` 才启用过滤 —— 不带就是老行为（返回全部成员），
 * 保证既有脚本升级后行为不变。
 */
interface IDelayFilterOptions {
  /** 保留延迟在 (0, maxDelay] 之内的节点 */
  maxDelay: number
  /**
   * 数据超过这个年龄就在 meta 里标记为陈旧。
   *
   * ⚠ 这里只是**提示**，不再触发探测。旧行为是「数据旧就顺手 quick 一轮」，
   * 那条路依赖候选池（已删除），而且会让一个只是想读名单的请求突然等十几秒。
   * 想要现测请显式带 `wait=1`（全量基线），或用 `POST /probe` 只测点名的节点。
   */
  staleAfterMs: number
  /** true：先同步跑一轮全量基线再返回 */
  wait: boolean
}

function parsePositiveInt(raw: unknown): number | null {
  if (typeof raw !== 'string') return null
  const value = Number(raw.trim())
  if (!Number.isFinite(value) || value <= 0) return null
  return Math.floor(value)
}

function parseBoolean(raw: unknown, fallback: boolean): boolean {
  if (typeof raw !== 'string') return fallback
  const value = raw.trim().toLowerCase()
  // `?wait` 这种不带值的写法按开启处理
  if (value === '' || value === '1' || value === 'true' || value === 'yes' || value === 'on') {
    return true
  }
  if (value === '0' || value === 'false' || value === 'no' || value === 'off') return false
  return fallback
}

async function resolveDelayFilter(
  query: Record<string, unknown>
): Promise<IDelayFilterOptions | null> {
  if (query.maxDelay === undefined) return null

  // maxDelay 带了但不是正数（maxDelay= / maxDelay=auto）时，取设置页里的统一阈值
  let maxDelay = parsePositiveInt(query.maxDelay)
  if (maxDelay === null) {
    const { availableDelayThreshold } = await getAppConfig()
    maxDelay = availableDelayThreshold || DEFAULT_AVAILABLE_DELAY_THRESHOLD
  }

  const maxAgeSec = parsePositiveInt(query.maxAge)
  return {
    maxDelay,
    staleAfterMs:
      maxAgeSec === null
        ? DELAY_PROBE_FRESH_MS
        : Math.max(SCRIPT_API_MIN_MAX_AGE_MS, maxAgeSec * 1000),
    // 默认不等：读名单是高频操作，让它顺带触发全量探测会把「查一下」变成「等十几秒」
    wait: parseBoolean(query.wait, false)
  }
}

/**
 * `wait=1` 时同步跑一轮全量基线。返回本次是否真的等了。
 *
 * **刻意不受 maxAge 刹车**：脚本带 wait=1 就是明确要求「现在测一遍」，
 * 用「数据还算新」把它挡回去会让脚本没有任何办法强制刷新。
 * 防滥用靠探测模块的单飞锁：并发的 wait=1 会 join 同一轮，不会叠加压力。
 */
async function applyWait(options: IDelayFilterOptions): Promise<boolean> {
  if (!options.wait) return false
  await probeAllProxies('groups-wait')
  return true
}

/**
 * 「能用」判定：只认 probeStore 里的记录。
 *
 * 为什么不读内核 history（这是本次改造的核心修正之一）：history 的最后一条里
 * delay=0 同时表示「测了不通」「压根没测过」「被 timeout 截断但节点其实健康」，
 * 而 504 还会往 history 写一条顶到 timeout 的正数假延迟。四种情况在那条路上
 * 无法区分，实测导致真实可出网的节点里 82.5% 被判成不可用。详见 probeStore.ts。
 *
 * 策略组自然被排除：基线只测具体节点，组名不会出现在表里。
 */
function isUsableName(name: string, maxDelay: number): boolean {
  return isRecordUsable(getDelayRecord(name), maxDelay)
}

/** 取一个节点在表里的明细，给 `/groups/:group` 排序用 */
function delayDetailOf(
  name: string,
  maxDelay: number,
  now: number
): { name: string; delay: number; time: string; ageMs: number } | null {
  const record = getDelayRecord(name)
  if (!isRecordUsable(record, maxDelay) || !record) return null
  return {
    name,
    delay: record.delay,
    time: new Date(record.at).toISOString(),
    ageMs: Math.max(0, now - record.at)
  }
}

/** 过滤结果的元信息，让脚本自己判断这批名单值不值得信 */
function buildFilterMeta(options: IDelayFilterOptions, probed: boolean): Record<string, unknown> {
  const snapshot = getDelayProbeSnapshot()
  const store = getProbeStoreStats()
  const dataAgeMs = getDelayDataAgeMs()
  return {
    maxDelay: options.maxDelay,
    maxAgeSec: Math.round(options.staleAfterMs / 1000),
    // 本次请求是否等待了一轮基线
    probed,
    // 数据年龄（毫秒），从未探测过为 null
    dataAgeMs,
    // 超过 maxAge 只是提示，不会自动触发探测；要新数据请带 wait=1 或用 POST /probe
    stale: dataAgeMs === null || dataAgeMs > options.staleAfterMs,
    lastProbeAt: snapshot.lastProbeAt ? new Date(snapshot.lastProbeAt).toISOString() : null,
    lastFullProbeAt: snapshot.lastFullProbeAt
      ? new Date(snapshot.lastFullProbeAt).toISOString()
      : null,
    // 最近一轮基线覆盖 / 测活的节点数，用于区分「确实都不可用」和「还没测过」
    lastProbedCount: snapshot.lastProbedCount,
    lastAliveCount: snapshot.lastAliveCount,
    probing: snapshot.probing,
    // 表里有多少条记录、其中多少条测得通。表为空说明启动基线还没跑完
    storeSize: store.size,
    storeAlive: store.alive
  }
}

function buildApp(config: INormalizedScriptApiConfig): express.Express {
  const app = express()
  app.disable('x-powered-by')
  app.use(express.json({ limit: '64kb' }))

  // 双重防线：即使监听地址被误改，也只服务本机请求
  app.use((req, res, next) => {
    if (!isLoopbackAddress(req.socket.remoteAddress ?? undefined)) {
      sendError(res, 403, 'only loopback requests are allowed')
      return
    }
    if (!isAuthorized(req.headers.authorization, config.token)) {
      sendError(res, 401, 'invalid or missing token')
      return
    }
    next()
  })

  app.get('/ping', (_req, res) => {
    res.json({ ok: true, service: 'clash-party-script-api' })
  })

  // 列出可切换的策略组及其成员，脚本据此决定切到哪个节点。
  // 带 ?maxDelay=1000 时只返回延迟达标的具体节点（策略组成员会被排除）。
  app.get('/groups', async (req, res) => {
    try {
      const filter = await resolveDelayFilter(req.query as Record<string, unknown>)
      const probed = filter ? await applyWait(filter) : false
      const groups = await mihomoGroups()

      res.json({
        ok: true,
        groups: groups.map((group) => {
          const base = {
            name: group.name,
            type: group.type,
            now: group.now,
            fixed: group.fixed
          }
          if (!filter) {
            return { ...base, proxies: group.all.map((proxy) => proxy.name) }
          }
          const usable = group.all.filter((proxy) => isUsableName(proxy.name, filter.maxDelay))
          return {
            ...base,
            proxies: usable.map((proxy) => proxy.name),
            total: group.all.length,
            usable: usable.length
          }
        }),
        ...(filter ? { filter: buildFilterMeta(filter, probed) } : {})
      })
    } catch (e) {
      sendError(res, 500, `${e}`)
    }
  })

  // 查询单个策略组当前选中的节点。
  // 带 ?maxDelay=1000 时只返回达标节点，并按延迟升序排好 —— 脚本直接取第一个就是最快的。
  app.get('/groups/:group', async (req, res) => {
    try {
      const filter = await resolveDelayFilter(req.query as Record<string, unknown>)
      const probed = filter ? await applyWait(filter) : false
      // 只需要这一个组，走单组查询：全量 /proxies 在大配置下是 5MB / parse 数十毫秒的
      // 主进程同步开销，而这里从来只用到 target 一个对象。
      const detail = await mihomoProxyDetail(req.params.group)
      if (detail.error) {
        sendError(res, 500, detail.error)
        return
      }
      const target = detail.proxy
      if (!target || !('all' in target)) {
        sendError(res, 404, `group not found: ${req.params.group}`)
        return
      }

      const base = {
        ok: true,
        name: target.name,
        type: target.type,
        now: target.now,
        fixed: target.fixed
      }

      if (!filter) {
        res.json({ ...base, proxies: target.all })
        return
      }

      const now = Date.now()
      const details = target.all
        .map((name) => delayDetailOf(name, filter.maxDelay, now))
        .filter(
          (item): item is { name: string; delay: number; time: string; ageMs: number } =>
            item !== null
        )
        .sort((a, b) => a.delay - b.delay)

      res.json({
        ...base,
        proxies: details.map((item) => item.name),
        details,
        total: target.all.length,
        usable: details.length,
        filter: buildFilterMeta(filter, probed)
      })
    } catch (e) {
      sendError(res, 500, `${e}`)
    }
  })

  // 核心能力：切换策略组当前节点
  app.put('/groups/:group', async (req, res) => {
    const groupName = req.params.group
    const body = req.body as { name?: unknown } | undefined
    const proxyName = typeof body?.name === 'string' ? body.name.trim() : ''
    if (!proxyName) {
      sendError(res, 400, 'body.name is required')
      return
    }
    // 出口自动生成的隐藏组由内核托管（fallback 自动测速），人为固定会破坏容错语义
    if (isGeneratedOutletGroup(groupName)) {
      sendError(res, 403, `group ${groupName} is managed by script outlet and cannot be switched`)
      return
    }

    try {
      // 同样走单组查询，避免为了一次切换付全量 /proxies 的解析开销。
      // 单组响应的 all[] 已核实与全量里的同名对象逐项一致（含顺序），成员校验语义不变。
      const detail = await mihomoProxyDetail(groupName)
      if (detail.error) {
        sendError(res, 500, detail.error)
        return
      }
      const group = detail.proxy
      if (!group || !('all' in group)) {
        sendError(res, 404, `group not found: ${groupName}`)
        return
      }
      // 只允许切到该组自身成员，避免脚本把组指向任意节点导致配置不一致。
      // 这里故意用全量成员校验、不套延迟阈值：脚本明确点名的节点就让它切，
      // 强行拦住反而让问题难排查。
      if (!group.all.includes(proxyName)) {
        sendError(res, 400, `proxy ${proxyName} is not a member of group ${groupName}`)
        return
      }

      await mihomoChangeProxy(groupName, proxyName)

      // listener 的连接可能仍复用旧节点，按配置断开让新节点立刻生效
      if (config.autoCloseConnection) {
        await mihomoCloseAllConnections()
      }

      scriptApiLogger.info(`Script API switched ${groupName} -> ${proxyName}`)
      res.json({ ok: true, group: groupName, now: proxyName })
    } catch (e) {
      sendError(res, 500, `${e}`)
    }
  })

  // 解除 url-test / fallback 组的固定选择，恢复自动测速
  app.delete('/groups/:group', async (req, res) => {
    try {
      await mihomoUnfixedProxy(req.params.group)
      if (config.autoCloseConnection) {
        await mihomoCloseAllConnections()
      }
      res.json({ ok: true, group: req.params.group, unfixed: true })
    } catch (e) {
      sendError(res, 500, `${e}`)
    }
  })

  /**
   * 探测入口。三种用法：
   *
   * - body 带 `proxies` + `mode:"delay"`（默认）：查这批节点的延迟。命中 probeStore 里
   *   足够新的记录（默认 300 秒，可用 `maxAge` 调，0 = 强制现测）就直接返回，
   *   否则**现测一次**再返回。不返回旧值。
   * - body 带 `proxies` + `mode:"ip"`：占用探测工位实拨，返回真实出口 IP。
   *   这是内核测速做不到的事（内核只给延迟），所以只有这个模式需要工位。
   * - 不带 `proxies`：跑一轮全量基线（保全组覆盖），返回统计。
   *
   * 名单走 body 而不是 query 是必须的：节点名普遍含 emoji、方括号和空格，
   * 塞进 query 要逐个 encodeURIComponent，而且 URL 长度撑不住几百个名字。
   *
   * ⚠ 耗时不做承诺。内核测速的耗时严格等于「波数 × 6000ms」，只有离散档位
   * （实测 1 波 6.3s / 2 波 12.6s / 3 波 17.7s），堆并发只会把健康节点打成 delay 0。
   * 稳态下大部分名字命中缓存，实际很快。
   *
   * ⚠ 旧的 `body.timeout` 参数已废弃并被忽略：测速 timeout 现在固定 6000ms，
   * 脚本只需要给 `maxDelay`（只用于过滤结果）。详见 appConfig 的 DELAY_PROBE_TIMEOUT。
   */
  app.post('/probe', async (req, res) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>
      const mode = typeof body.mode === 'string' ? body.mode.trim().toLowerCase() : 'delay'

      if (Array.isArray(body.proxies)) {
        if (mode === 'ip') {
          const probe = await probeIpByStations(body.proxies)
          res.json({
            ok: true,
            mode: 'ip',
            stations: probe.stations,
            targets: probe.targets,
            targetTimeout: probe.targetTimeout,
            elapsedMs: probe.elapsedMs,
            limits: {
              received: probe.received,
              deduped: probe.deduped,
              accepted: probe.accepted,
              truncated: probe.truncated,
              limit: probe.limit
            },
            counts: { ok: probe.okCount, failed: probe.accepted - probe.okCount },
            results: probe.results,
            unknown: probe.unknown,
            rejected: probe.rejected
          })
          return
        }

        if (mode !== 'delay') {
          sendError(res, 400, `unknown mode: ${mode} (expected "delay" or "ip")`)
          return
        }

        const probe = await probeNamedProxies(body.proxies, {
          maxDelay: body.maxDelay,
          maxAge: body.maxAge,
          probeUrl: body.probeUrl
        })
        res.json({
          ok: true,
          mode: 'delay',
          scope: 'named',
          timeout: probe.timeout,
          url: probe.url,
          maxAgeSec: Math.round(probe.maxAgeMs / 1000),
          maxDelay: probe.maxDelay,
          elapsedMs: probe.elapsedMs,
          limits: {
            received: probe.received,
            deduped: probe.deduped,
            accepted: probe.accepted,
            truncated: probe.truncated,
            limit: SCRIPT_API_NAMED_PROBE_MAX_NAMES
          },
          counts: {
            fresh: probe.freshCount,
            probed: probe.probedCount,
            alive: probe.aliveCount,
            filtered: probe.filteredCount
          },
          // 兼容旧字段名，脚本迁移期两套都能读
          probedCount: probe.accepted,
          aliveCount: probe.aliveCount,
          results: probe.results,
          unknown: probe.unknown,
          rejected: probe.rejected,
          // 名单探测刻意不刷新这个时钟，所以它反映的是最近一轮全量基线的年龄
          dataAgeMs: getDelayDataAgeMs(),
          ...(body.timeout !== undefined ? { timeoutIgnored: true } : {})
        })
        return
      }

      // 不带名单 = 跑一轮全量基线。`?full=1` 保留但已无意义：quick 档不存在了
      const snapshot = await probeAllProxies('script-api')
      const store = getProbeStoreStats()
      res.json({
        ok: true,
        mode: 'delay',
        scope: 'full',
        probedCount: snapshot.lastProbedCount,
        aliveCount: snapshot.lastAliveCount,
        storeSize: store.size,
        storeAlive: store.alive,
        lastProbeAt: snapshot.lastProbeAt ? new Date(snapshot.lastProbeAt).toISOString() : null,
        lastFullProbeAt: snapshot.lastFullProbeAt
          ? new Date(snapshot.lastFullProbeAt).toISOString()
          : null
      })
    } catch (e) {
      sendError(res, 500, `${e}`)
    }
  })

  // 列出已配置的脚本出口，方便脚本自检端口与目标是否匹配
  // 批量出口在这里展开成逐个端口，返回结果与内核里实际的 listener 一一对应
  app.get('/outlets', async (_req, res) => {
    try {
      const { scriptOutlets = [] } = await getAppConfig()
      res.json({
        ok: true,
        outlets: expandScriptOutlets(scriptOutlets).map((outlet) => ({
          port: outlet.port,
          enable: outlet.enable,
          mode: outlet.mode,
          type: outlet.type,
          target: outlet.target,
          targets: outlet.targets,
          remark: outlet.remark
        }))
      })
    } catch (e) {
      sendError(res, 500, `${e}`)
    }
  })

  app.use((_req, res) => {
    sendError(res, 404, 'unknown endpoint')
  })

  return app
}

export async function stopScriptApiServer(): Promise<void> {
  const server = scriptApiServer
  scriptApiServer = null
  runningConfig = null
  if (!server) return

  await new Promise<void>((resolve) => {
    server.close(() => resolve())
    // close 只等待空闲连接，keep-alive 连接需要强制断开
    server.closeAllConnections?.()
  })
}

export async function startScriptApiServer(): Promise<void> {
  await stopScriptApiServer()

  const { scriptApi } = await getAppConfig()
  const config = normalizeScriptApiConfig(scriptApi)
  if (!canStartScriptApi(config)) {
    if (config.enable && !config.token) {
      scriptApiLogger.warn('Script API is enabled but token is empty, refusing to start')
    }
    return
  }

  const app = buildApp(config)

  await new Promise<void>((resolve) => {
    const server = http.createServer(app)
    server.once('error', (err) => {
      scriptApiLogger.error(`Failed to start script API on port ${config.port}`, err)
      scriptApiServer = null
      runningConfig = null
      resolve()
    })
    server.listen(config.port, SCRIPT_API_LISTEN_ADDRESS, () => {
      scriptApiServer = server
      runningConfig = config
      scriptApiLogger.info(
        `Script API listening on ${SCRIPT_API_LISTEN_ADDRESS}:${config.port} (autoCloseConnection=${config.autoCloseConnection})`
      )
      resolve()
    })
  })
}

/**
 * 配置变更后重新应用。端口/令牌/开关任一变化都需要重建监听，
 * 因此直接停后再启，逻辑比增量判断更可靠。
 */
export async function restartScriptApiServer(): Promise<void> {
  await startScriptApiServer()
}
