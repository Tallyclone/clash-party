import {
  DEFAULT_SCRIPT_OUTLET_INTERVAL,
  DEFAULT_SCRIPT_OUTLET_TEST_URL,
  PROBE_STATION_COUNT,
  PROBE_STATION_PORT_BASE,
  PROBE_STATION_PORT_SEARCH_END,
  SCRIPT_OUTLET_GROUP_PREFIX,
  SCRIPT_OUTLET_LISTEN_ADDRESS,
  SCRIPT_OUTLET_LISTENER_PREFIX
} from '../../shared/appConfig'
import {
  expandScriptOutlets,
  findProbeStationWindow,
  probeStationGroupName,
  probeStationListenerName,
  probeStationPort,
  type IExpandedScriptOutlet
} from '../../shared/scriptOutlet'
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

export interface IProbeStationInjectResult {
  /** 实际注入的工位数量 */
  injected: number
  /** 实际注入的端口（升序）。这是端口的**唯一真相源**，拨测侧不要自行推算 */
  ports: number[]
  /** 实际使用的窗口起点；未能注入时为 null */
  windowStart: number | null
  /** 整体被跳过的原因（没有可探测节点 / 找不到连续空闲窗口） */
  skippedReason?: string
}

/**
 * 注入「探测工位」：PROBE_STATION_COUNT 个本地 http listener + 同样多的隐藏 select 组。
 *
 * ## 它解决什么
 *
 * `POST /probe mode=ip` 要拿到某个节点的**真实出口 IP**，内核没有这种接口 ——
 * 唯一办法是把某个本地入站的出口固定到该节点，然后自己经这个入站去拨一个回显 IP 的网站。
 * 而「把入站的出口固定到某节点」是**改选中项**，是一个全局可见的副作用：
 * 两个脚本共用同一个组就会互相踩（A 切到 X，B 立刻切到 Y，A 的拨测从 Y 出网，
 * 结果串味且无法察觉）。所以每个并发单位必须有自己独占的一对 listener + 组，
 * 这一对就是一个「工位」。
 *
 * 同理，工位**不能借用用户配置的业务出口**：那些组正被第三方脚本读写，
 * 拨测去切它们会让用户的业务流量静默走错节点，反向也会让拨测结果串味。
 *
 * 工位组以 PROBE_STATION_GROUP_PREFIX 开头，scriptApi.isGeneratedOutletGroup() 会拦住
 * 脚本对它的 `PUT /groups/:group`，避免业务脚本把探测工位切走。
 *
 * ## 为什么用 http 而不是 mixed
 *
 * probeStation.ts 是手写 `CONNECT host:port HTTP/1.1` 上去的（要分段计时，
 * 高层库把建连和请求揉在一起拆不出来），只需要 HTTP 代理语义，不需要 SOCKS5，
 * 也不需要 UDP。给最小的能力面。
 *
 * ## 端口：整段让位，而不是逐个跳过
 *
 * 旧实现把端口写成常量 `BASE + index`，撞车的工位逐个跳过。实机上用户在界面里配了
 * `port: 17900, count: 100` 的业务出口，与旧基址 100 个端口全撞，于是
 * **一个工位都没注入**、mode=ip 完全不可用，而 app 照常启动、只在日志里留一行 ERROR。
 *
 * 现在改为：先从 PROBE_STATION_PORT_BASE 起找第一段**连续空闲**的 COUNT 个端口，
 * 整段平移过去。这样用户在任何区间加出口，工位都会自动让位。
 *
 * 关键前提是**组名与 listener 名都由端口派生、不由 index 派生**，所以整段平移不会
 * 造成组名↔端口错位 —— 那个错位踩过一次，表现是"结果看起来完全正常"，
 * 实际上 PUT 了一个组却从下一个组的端口出网，整轮结论作废。
 *
 * 端口的唯一真相源是本函数返回的 `ports`，拨测侧从内核实际加载的配置里读，
 * 不再按常量重算 —— 两边各算一份就是上面那个错位的土壤。
 */
export function injectProbeStations(
  profile: Partial<IMihomoConfig>,
  extraReservedPorts?: Iterable<number>
): IProbeStationInjectResult {
  const result: IProbeStationInjectResult = { injected: 0, ports: [], windowStart: null }

  // 工位组要能选中「所有节点」：内联节点靠 proxies 逐个列出，provider 节点靠 use 引用。
  // 不用 include-all —— 那个字段本机无法验证，一旦内核不认就是整份配置加载失败。
  const inlineNames: string[] = []
  if (Array.isArray(profile.proxies)) {
    for (const proxy of profile.proxies) {
      if (typeof proxy?.name === 'string' && proxy.name) inlineNames.push(proxy.name)
    }
  }
  const providers = (profile as { 'proxy-providers'?: Record<string, unknown> })['proxy-providers']
  const providerNames = providers ? Object.keys(providers) : []

  if (!inlineNames.length && !providerNames.length) {
    result.skippedReason = 'current profile has no proxies or proxy-providers to probe'
    return result
  }

  const listeners: IMihomoListener[] = Array.isArray(profile.listeners)
    ? [...profile.listeners]
    : []
  const groups: Record<string, unknown>[] = Array.isArray(profile['proxy-groups'])
    ? [...profile['proxy-groups']]
    : []

  // 已占用端口：内核主入站 + external-controller + 已注入的业务出口 listener + 调用方额外传入的
  const reservedPorts = collectReservedPorts(profile)
  for (const listener of listeners) {
    if (isValidPort(listener.port)) reservedPorts.add(listener.port)
  }
  if (extraReservedPorts) {
    for (const port of extraReservedPorts) {
      if (isValidPort(port)) reservedPorts.add(port)
    }
  }

  const windowStart = findProbeStationWindow(
    reservedPorts,
    PROBE_STATION_COUNT,
    PROBE_STATION_PORT_BASE,
    PROBE_STATION_PORT_SEARCH_END
  )
  if (windowStart === null) {
    // 整段找不到才算失败，而且必须让它显眼：这条路径下 mode=ip 完全不可用。
    result.skippedReason =
      `no free window of ${PROBE_STATION_COUNT} consecutive ports in ` +
      `[${PROBE_STATION_PORT_BASE}, ${PROBE_STATION_PORT_SEARCH_END})`
    outletLogger.error(`Probe stations skipped: ${result.skippedReason}`)
    return result
  }

  const listenerNames = new Set(listeners.map((listener) => listener.name))
  const groupNames = new Set(
    groups.map((group) => (typeof group?.name === 'string' ? group.name : ''))
  )

  for (let index = 0; index < PROBE_STATION_COUNT; index += 1) {
    const port = probeStationPort(windowStart, index)
    const listenerName = probeStationListenerName(port)
    const groupName = probeStationGroupName(port)

    // 端口已由窗口查找保证空闲，这里只剩「同名 listener / 同名组已存在」这一类
    // 与端口无关的碰撞（例如用户手写配置里恰好有 party-probe-* 命名）。
    // 名字冲突时跳过单个工位是安全的：池子小一点、并行度低一点，不会错位。
    if (!isValidPort(port)) continue
    if (listenerNames.has(listenerName)) {
      outletLogger.warn(`Probe station skipped: listener name ${listenerName} already exists`)
      continue
    }
    if (groupNames.has(groupName)) {
      outletLogger.warn(`Probe station skipped: group name ${groupName} already exists`)
      continue
    }

    const group: Record<string, unknown> = {
      name: groupName,
      type: 'select',
      // 该组仅供出口 IP 拨测使用，隐藏以免污染代理页面与托盘菜单
      hidden: true
    }
    if (inlineNames.length) group.proxies = [...inlineNames]
    if (providerNames.length) group.use = [...providerNames]
    groups.push(group)
    groupNames.add(groupName)

    listeners.push({
      name: listenerName,
      // 只需要 HTTP CONNECT 语义（见函数注释），不给 socks、不给 udp
      type: 'http',
      listen: SCRIPT_OUTLET_LISTEN_ADDRESS,
      port,
      proxy: groupName,
      udp: false
    })
    listenerNames.add(listenerName)
    reservedPorts.add(port)
    result.ports.push(port)
    result.injected += 1
  }

  result.windowStart = result.injected > 0 ? windowStart : null
  if (result.injected === 0) {
    result.skippedReason = `all ${PROBE_STATION_COUNT} station names already exist in this profile`
    outletLogger.error(`Probe stations skipped: ${result.skippedReason}`)
  }

  if (listeners.length) {
    profile.listeners = listeners
  }
  if (groups.length) {
    profile['proxy-groups'] = groups
  }

  return result
}
