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
  ensureFreshDelays,
  getDelayDataAgeMs,
  getDelayProbeSnapshot,
  probeAllProxies,
  probeCandidateProxies,
  probeNamedProxies
} from '../core/delayProbe'
import {
  mihomoChangeProxy,
  mihomoCloseAllConnections,
  mihomoGroups,
  mihomoHotReloadConfig,
  mihomoProxies,
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
  /** 数据超过这个年龄就先探测一次 */
  maxAgeMs: number
  /** true：等探测完再返回（约 1~2 秒）；false：立刻返回手上的数据，后台顺便刷一轮 */
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
    // 下限不能省：maxAge 极小时几乎每个请求都判定过期，现测会被背靠背连续触发，
    // 而且候选池回看的内核 history 只有 10 条，轮询过密时容忍机制会被直接烧穿
    maxAgeMs:
      maxAgeSec === null
        ? DELAY_PROBE_FRESH_MS
        : Math.max(SCRIPT_API_MIN_MAX_AGE_MS, maxAgeSec * 1000),
    wait: parseBoolean(query.wait, true)
  }
}

/** 按需保证数据新鲜。返回本次是否真的等待了一轮探测 */
async function applyFreshness(options: IDelayFilterOptions): Promise<boolean> {
  const age = getDelayDataAgeMs()
  if (age !== null && age <= options.maxAgeMs) return false
  if (options.wait) return await ensureFreshDelays(options.maxAgeMs)
  // 不等：先把手上的数据给出去，后台悄悄测一轮，脚本下次来就是新的
  void ensureFreshDelays(options.maxAgeMs).catch(() => {})
  return false
}

/** 取节点最近一次的延迟记录。没测过返回 null，测出连不上则 delay 为 0 */
function lastDelayOf(
  proxy: IMihomoProxy | IMihomoGroup | undefined
): { delay: number; time: string } | null {
  const history = proxy?.history
  if (!Array.isArray(history) || history.length === 0) return null
  const last = history[history.length - 1]
  if (!last || typeof last.delay !== 'number') return null
  return { delay: last.delay, time: last.time }
}

function isUsable(proxy: IMihomoProxy | IMihomoGroup | undefined, maxDelay: number): boolean {
  // 策略组不参与：组的延迟归属不清，脚本要的是能直接指定的具体节点
  if (!proxy || 'all' in proxy) return false
  const last = lastDelayOf(proxy)
  // 没测过的一律不给 —— 脚本要的是「保证能用」，没数据不算能用
  if (last === null) return false
  return last.delay > 0 && last.delay <= maxDelay
}

/** 过滤结果的元信息，让脚本自己判断这批名单值不值得信 */
function buildFilterMeta(options: IDelayFilterOptions, probed: boolean): Record<string, unknown> {
  const snapshot = getDelayProbeSnapshot()
  return {
    maxDelay: options.maxDelay,
    maxAgeSec: Math.round(options.maxAgeMs / 1000),
    // 本次请求是否等待了一轮现测
    probed,
    // 数据年龄（毫秒），从未探测过为 null
    dataAgeMs: getDelayDataAgeMs(),
    lastProbeAt: snapshot.lastProbeAt ? new Date(snapshot.lastProbeAt).toISOString() : null,
    lastFullProbeAt: snapshot.lastFullProbeAt
      ? new Date(snapshot.lastFullProbeAt).toISOString()
      : null,
    // 最近一次探测覆盖 / 测活的节点数，用于区分「确实都不可用」和「还没测过」
    lastProbedCount: snapshot.lastProbedCount,
    lastAliveCount: snapshot.lastAliveCount,
    probing: snapshot.probing
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
      const probed = filter ? await applyFreshness(filter) : false
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
          const usable = group.all.filter((proxy) => isUsable(proxy, filter.maxDelay))
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
      const probed = filter ? await applyFreshness(filter) : false
      const proxies = await mihomoProxies()
      const target = proxies.proxies[req.params.group]
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

      const details = target.all
        .map((name) => {
          const member = proxies.proxies[name]
          if (!isUsable(member, filter.maxDelay)) return null
          const last = lastDelayOf(member)
          return last ? { name, delay: last.delay, time: last.time } : null
        })
        .filter((item): item is { name: string; delay: number; time: string } => item !== null)
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
      const proxies = await mihomoProxies()
      const group = proxies.proxies[groupName]
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

      // listener 的连接可能仍复用旧节点，按配置断开让新节点立刻生效。
      // `?close=0` 可以单次抑制：批量探测要连着切几百次，每次都断全局连接
      // 会把用户正在跑的浏览器/下载反复掐断，而探测本身走的是独立出口端口，
      // 新建连接自然就用新节点，不需要清场。
      const shouldClose = parseBoolean(
        (req.query as Record<string, unknown>).close,
        config.autoCloseConnection
      )
      if (shouldClose) {
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
   * 主动触发一轮延迟探测。三种范围，按参数分派：
   *
   * - 不带参数：只测候选池（最近几次成绩里还有能看的那批），约 1 秒级返回。
   * - `?full=1`：测全部节点，慢得多（几百个节点要二十几秒），一般只在刚启动或长时间没测时用。
   * - body 里带 `proxies` 数组：只测这批指定节点，并**逐节点**返回延迟。
   *
   * 名单走 body 而不是 query 是必须的：节点名普遍含 emoji、方括号和空格，
   * 塞进 query 要逐个 encodeURIComponent，而且 URL 长度撑不住几百个名字。
   *
   * 名单探测与前两种不共享闸门，也不刷新全局数据新鲜度（细节见 probeNamedProxies 的注释），
   * 所以响应里额外回一个 dataAgeMs 让脚本自己知道全局数据有多旧。
   */
  app.post('/probe', async (req, res) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>
      if (Array.isArray(body.proxies)) {
        const timeout = typeof body.timeout === 'number' ? body.timeout : undefined
        const probe = await probeNamedProxies(body.proxies, timeout)
        res.json({
          ok: true,
          scope: 'named',
          limits: {
            received: probe.received,
            deduped: probe.deduped,
            accepted: probe.accepted,
            truncated: probe.truncated,
            limit: SCRIPT_API_NAMED_PROBE_MAX_NAMES
          },
          timeout: probe.timeout,
          elapsedMs: probe.elapsedMs,
          probedCount: probe.accepted,
          aliveCount: probe.aliveCount,
          results: probe.results,
          unknown: probe.unknown,
          rejected: probe.rejected,
          // 名单探测刻意不刷新这个时钟，所以它反映的是最近一轮全量/现测的年龄
          dataAgeMs: getDelayDataAgeMs()
        })
        return
      }

      const full = parseBoolean((req.query as Record<string, unknown>).full, false)
      const snapshot = full ? await probeAllProxies() : await probeCandidateProxies()
      res.json({
        ok: true,
        scope: full ? 'full' : 'quick',
        probedCount: snapshot.lastProbedCount,
        aliveCount: snapshot.lastAliveCount,
        lastProbeAt: snapshot.lastProbeAt ? new Date(snapshot.lastProbeAt).toISOString() : null,
        lastFullProbeAt: snapshot.lastFullProbeAt
          ? new Date(snapshot.lastFullProbeAt).toISOString()
          : null
      })
    } catch (e) {
      sendError(res, 500, `${e}`)
    }
  })

  /**
   * 重新生成配置并热重载内核。
   *
   * 为什么需要这个端点：改策略组的**成员名单**（不是选中项）属于配置文件内容，
   * mihomo 的 PATCH /configs 不接受 proxy-groups，只能重写 work/config.yaml 再
   * `PUT /configs?force=true`。而覆写文件（override/*.js）没有 watcher，脚本改完
   * 若没人触发 generateProfile，改动要等到用户下次在 UI 里动配置才生效。
   *
   * mihomoHotReloadConfig() 内部已经包含 generateProfile()，所以覆写脚本里写的
   * 新名单会在这一步被重新执行、写进 work config，再交给内核整图重建。
   * 内核没在跑时它会自动退化成 restartCore()。
   *
   * 副作用：adapter 整图重建，进行中的连接会中断，别在循环里调用。
   */
  app.post('/reload', async (_req, res) => {
    try {
      await mihomoHotReloadConfig()
      scriptApiLogger.info('Script API triggered config hot reload')
      res.json({ ok: true, reloaded: true })
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
