import {
  DEFAULT_SCRIPT_OUTLET_INTERVAL,
  DEFAULT_SCRIPT_OUTLET_TEST_URL,
  SCRIPT_OUTLET_GROUP_PREFIX,
  SCRIPT_OUTLET_LISTEN_ADDRESS,
  SCRIPT_OUTLET_LISTENER_PREFIX
} from '../../shared/appConfig'
import { expandScriptOutlets, type IExpandedScriptOutlet } from '../../shared/scriptOutlet'
import { createLogger } from '../utils/logger'

const outletLogger = createLogger('script-outlet')

export interface IScriptOutletInjectResult {
  /** 实际注入的 listener 数量 */
  injected: number
  /** 被跳过的出口及原因，用于日志与 UI 提示 */
  skipped: { id: string; reason: string }[]
}

/** mihomo listener 的 type 字段取值与 UI 选项保持一致 */
function normalizeListenerType(type: ScriptOutletListenerType | undefined): string {
  switch (type) {
    case 'socks5':
      return 'socks'
    case 'http':
      return 'http'
    default:
      return 'mixed'
  }
}

export function getOutletListenerName(outlet: IScriptOutlet): string {
  return `${SCRIPT_OUTLET_LISTENER_PREFIX}${outlet.port}`
}

export function getOutletGroupName(outlet: IScriptOutlet): string {
  return `${SCRIPT_OUTLET_GROUP_PREFIX}${outlet.port}`
}

function isValidPort(port: unknown): port is number {
  return typeof port === 'number' && Number.isInteger(port) && port > 0 && port <= 65535
}

function normalizeInterval(interval: unknown): number {
  if (typeof interval === 'number' && Number.isFinite(interval) && interval > 0) {
    return Math.floor(interval)
  }
  return DEFAULT_SCRIPT_OUTLET_INTERVAL
}

/**
 * 收集配置中已被占用的端口，避免出口 listener 与内核主入站端口冲突。
 * 冲突时 mihomo 会启动失败或该 listener 静默不可用，必须提前拦下。
 */
function collectReservedPorts(profile: Partial<IMihomoConfig>): Set<number> {
  const reserved = new Set<number>()
  const candidates = [
    profile['mixed-port'],
    profile['socks-port'],
    profile.port,
    profile['redir-port'],
    profile['tproxy-port']
  ]
  for (const port of candidates) {
    if (isValidPort(port)) reserved.add(port)
  }

  // external-controller 形如 127.0.0.1:9090，占用的端口同样不能复用
  const controller = profile['external-controller']
  if (typeof controller === 'string' && controller.includes(':')) {
    const port = Number(controller.slice(controller.lastIndexOf(':') + 1))
    if (isValidPort(port)) reserved.add(port)
  }

  return reserved
}

/**
 * 把「脚本专用出口」编译成 mihomo 的 listeners + 专用 fallback 策略组。
 *
 * 设计要点：
 * - listener 固定 listen 到 127.0.0.1，绝不监听 0.0.0.0，避免局域网出现无鉴权代理
 * - fallback 模式会生成独立策略组，不复用用户日常分组，切换日常分组不影响脚本出口
 * - 直接就地修改传入的 profile 对象，与 generateProfile 中其他注入逻辑保持一致
 */
export function injectScriptOutlets(
  profile: Partial<IMihomoConfig>,
  outlets: IScriptOutlet[] | undefined
): IScriptOutletInjectResult {
  const result: IScriptOutletInjectResult = { injected: 0, skipped: [] }
  if (!outlets?.length) return result

  // 批量出口（count > 1）在这里展开成实际的单个出口，
  // 之后的端口冲突 / 目标存在性校验全部以展开后的结果为准
  const enabled = expandScriptOutlets(outlets.filter((outlet) => outlet.enable))
  if (!enabled.length) return result

  const reservedPorts = collectReservedPorts(profile)
  const usedPorts = new Set<number>()

  const listeners: IMihomoListener[] = Array.isArray(profile.listeners)
    ? [...profile.listeners]
    : []
  const groups: Record<string, unknown>[] = Array.isArray(profile['proxy-groups'])
    ? [...profile['proxy-groups']]
    : []

  // 订阅里已存在的节点/组名，用于校验 target 是否真的存在
  const knownNames = new Set<string>()
  if (Array.isArray(profile.proxies)) {
    for (const proxy of profile.proxies) {
      if (typeof proxy?.name === 'string') knownNames.add(proxy.name)
    }
  }
  for (const group of groups) {
    if (typeof group?.name === 'string') knownNames.add(group.name)
  }
  // 订阅可能通过 proxy-providers 提供节点，此时节点名在运行时才可知，
  // 无法静态校验，因此存在 provider 时放宽 target 存在性检查。
  const hasProviders = Boolean(
    (profile as { 'proxy-providers'?: Record<string, unknown> })['proxy-providers'] &&
    Object.keys(
      (profile as { 'proxy-providers'?: Record<string, unknown> })['proxy-providers'] ?? {}
    ).length > 0
  )

  const skip = (outlet: IExpandedScriptOutlet, reason: string): void => {
    result.skipped.push({ id: outlet.id, reason })
    outletLogger.warn(`Skipped script outlet ${outlet.id}: ${reason}`)
  }

  for (const outlet of enabled) {
    if (!isValidPort(outlet.port)) {
      skip(outlet, `invalid port: ${outlet.port}`)
      continue
    }
    if (reservedPorts.has(outlet.port)) {
      skip(outlet, `port ${outlet.port} conflicts with a mihomo inbound or controller port`)
      continue
    }
    if (usedPorts.has(outlet.port)) {
      skip(outlet, `duplicated port ${outlet.port}`)
      continue
    }

    let proxyTarget: string

    if (outlet.mode === 'fallback') {
      const targets = (outlet.targets ?? []).map((t) => t.trim()).filter(Boolean)
      if (!targets.length) {
        skip(outlet, 'fallback mode requires at least one target')
        continue
      }
      const missing = hasProviders ? [] : targets.filter((t) => !knownNames.has(t))
      if (missing.length === targets.length) {
        skip(outlet, `none of the targets exist in current profile: ${targets.join(', ')}`)
        continue
      }
      if (missing.length) {
        outletLogger.warn(
          `Script outlet ${outlet.id} has targets missing from profile: ${missing.join(', ')}`
        )
      }

      const groupName = getOutletGroupName(outlet)
      if (knownNames.has(groupName)) {
        skip(outlet, `generated group name ${groupName} already exists in profile`)
        continue
      }

      groups.push({
        name: groupName,
        type: 'fallback',
        proxies: targets,
        url: outlet.testUrl?.trim() || DEFAULT_SCRIPT_OUTLET_TEST_URL,
        interval: normalizeInterval(outlet.interval),
        // 该组仅供脚本使用，隐藏以免污染代理页面与托盘菜单
        hidden: true
      })
      knownNames.add(groupName)
      proxyTarget = groupName
    } else {
      const target = outlet.target?.trim()
      if (!target) {
        skip(outlet, 'direct mode requires a target')
        continue
      }
      if (!hasProviders && !knownNames.has(target) && target !== 'DIRECT' && target !== 'REJECT') {
        skip(outlet, `target does not exist in current profile: ${target}`)
        continue
      }
      proxyTarget = target
    }

    const listenerName = getOutletListenerName(outlet)
    if (listeners.some((l) => l.name === listenerName)) {
      skip(outlet, `listener name ${listenerName} already exists`)
      continue
    }

    listeners.push({
      name: listenerName,
      type: normalizeListenerType(outlet.type),
      listen: SCRIPT_OUTLET_LISTEN_ADDRESS,
      port: outlet.port,
      proxy: proxyTarget,
      udp: outlet.udp ?? true
    })
    usedPorts.add(outlet.port)
    result.injected += 1
  }

  if (listeners.length) {
    profile.listeners = listeners
  }
  if (groups.length) {
    profile['proxy-groups'] = groups
  }

  return result
}
