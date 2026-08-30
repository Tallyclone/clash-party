import {
  DEFAULT_SCRIPT_API_PORT,
  PROBE_STATION_GROUP_PREFIX,
  SCRIPT_API_LISTEN_ADDRESS,
  SCRIPT_OUTLET_GROUP_PREFIX
} from '../../shared/appConfig'

/** 规范化后的脚本控制 API 配置，供 server 直接使用 */
export interface INormalizedScriptApiConfig {
  enable: boolean
  port: number
  token: string
  autoCloseConnection: boolean
}

/**
 * 归一化用户配置。端口非法时回退默认端口，token 去除首尾空白。
 * 注意：这里不判断 token 是否为空，是否允许启动交由 canStartScriptApi 决定。
 */
export function normalizeScriptApiConfig(
  config: IScriptApiConfig | undefined
): INormalizedScriptApiConfig {
  const rawPort = config?.port
  const port =
    typeof rawPort === 'number' && Number.isInteger(rawPort) && rawPort > 0 && rawPort <= 65535
      ? rawPort
      : DEFAULT_SCRIPT_API_PORT

  return {
    enable: config?.enable === true,
    port,
    token: typeof config?.token === 'string' ? config.token.trim() : '',
    autoCloseConnection: config?.autoCloseConnection !== false
  }
}

/**
 * 是否允许启动服务。
 * 强制要求 token 非空：无令牌的本机 HTTP 接口会被任意本地程序（含浏览器页面）调用，
 * 等同于把代理控制权交给所有本机进程，因此宁可不启动。
 */
export function canStartScriptApi(config: INormalizedScriptApiConfig): boolean {
  return config.enable && config.token.length > 0
}

/** 时序安全的字符串比较，避免通过响应耗时逐字节猜测令牌 */
export function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}

/** 从 Authorization 头中提取 Bearer 令牌，兼容直接传裸令牌 */
export function extractBearerToken(header: string | undefined): string {
  if (!header) return ''
  const trimmed = header.trim()
  const match = /^Bearer\s+(.+)$/i.exec(trimmed)
  return (match ? match[1] : trimmed).trim()
}

export function isAuthorized(header: string | undefined, expectedToken: string): boolean {
  if (!expectedToken) return false
  return safeCompare(extractBearerToken(header), expectedToken)
}

/**
 * 仅接受来自本机回环地址的请求。
 * 服务本身已 bind 127.0.0.1，这里是第二道防线，防止将来误改监听地址。
 */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false
  const normalized = address.replace(/^::ffff:/i, '')
  return normalized === '127.0.0.1' || normalized === '::1' || normalized.startsWith('127.')
}

/** 生成随机访问令牌，UI 首次开启时调用 */
export function generateScriptApiToken(randomBytes: (size: number) => Uint8Array): string {
  return Array.from(randomBytes(24))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * 判断组名是否为项目自动生成的隐藏组，这类组不允许脚本切换。
 *
 * 两类都要拦：
 * - SCRIPT_OUTLET_GROUP_PREFIX（PARTY-OUTLET-*）：业务出口的 fallback 组，
 *   脚本手动切它会让该出口脱离自动选优。
 * - PROBE_STATION_GROUP_PREFIX（PARTY-PROBE-*）：`POST /probe mode=ip` 的探测工位。
 *   工位的选中项由工位池独占管理，外部插一脚会让正在进行的拨测从别的节点出网，
 *   拿回一个张冠李戴的出口 IP —— 而且结果看起来完全正常，无法察觉。
 */
export function isGeneratedOutletGroup(name: string): boolean {
  return name.startsWith(SCRIPT_OUTLET_GROUP_PREFIX) || name.startsWith(PROBE_STATION_GROUP_PREFIX)
}

export function getScriptApiBaseUrl(port: number): string {
  return `http://${SCRIPT_API_LISTEN_ADDRESS}:${port}`
}
