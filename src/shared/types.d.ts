type OutboundMode = 'rule' | 'global' | 'direct'
type LogLevel = 'info' | 'debug' | 'warning' | 'error' | 'silent'
type SysProxyMode = 'auto' | 'manual'
type CardStatus = 'col-span-2' | 'col-span-1' | 'hidden'
type SiderCardKey =
  | 'sysproxy'
  | 'tun'
  | 'profile'
  | 'proxy'
  | 'rule'
  | 'resource'
  | 'override'
  | 'connection'
  | 'mihomo'
  | 'dns'
  | 'sniff'
  | 'log'
  | 'substore'
  | 'network'
  | 'usage'
  | 'outlet'
type NetworkInfoCardKey = 'ip' | 'topology' | 'latency'
type AppTheme = 'system' | 'light' | 'dark'
type MihomoGroupType = 'Selector' | 'URLTest' | 'Fallback' | 'LoadBalance' | 'Relay'
type Priority =
  | 'PRIORITY_LOW'
  | 'PRIORITY_BELOW_NORMAL'
  | 'PRIORITY_NORMAL'
  | 'PRIORITY_ABOVE_NORMAL'
  | 'PRIORITY_HIGH'
  | 'PRIORITY_HIGHEST'
type MihomoProxyType =
  | 'Direct'
  | 'Reject'
  | 'RejectDrop'
  | 'Pass'
  | 'Dns'
  | 'Compatible'
  | 'Socks5'
  | 'Http'
  | 'Ssh'
  | 'Shadowsocks'
  | 'ShadowsocksR'
  | 'Snell'
  | 'Vmess'
  | 'Vless'
  | 'Trojan'
  | 'Hysteria'
  | 'Hysteria2'
  | 'Tuic'
  | 'WireGuard'
  | 'Mieru'
  | 'AnyTLS'
  | 'Sudoku'
  | 'Masque'
  | 'TrustTunnel'
type TunStack = 'gvisor' | 'mixed' | 'system'
type FindProcessMode = 'off' | 'strict' | 'always'
type DnsMode = 'normal' | 'fake-ip' | 'redir-host' | 'hosts'
type FilterMode = 'blacklist' | 'whitelist' | 'rule'
type NetworkInterfaceInfo = os.NetworkInterfaceInfo

interface IAppVersion {
  version: string
  changelog: string
}

interface IMihomoVersion {
  version: string
  meta: boolean
}

interface IMihomoTrafficInfo {
  up: number
  down: number
}

interface IMihomoMemoryInfo {
  inuse: number
  oslimit: number
}

interface IMihomoLogInfo {
  type: LogLevel
  payload: string
  time?: string
}

interface IMihomoRulesInfo {
  rules: IMihomoRulesDetail[]
}

interface IMihomoRulesDetail {
  type: string
  payload: string
  proxy: string
  size: number
  index: number
  extra?: {
    disabled: boolean
    hitCount: number
    hitAt: string
    missCount: number
    missAt: string
  }
}

interface IMihomoConnectionsInfo {
  downloadTotal: number
  uploadTotal: number
  connections?: IMihomoConnectionDetail[]
  memory: number
}

interface IMihomoConnectionDetail {
  id: string
  isActive: boolean
  metadata: {
    network: 'tcp' | 'udp'
    type: string
    sourceIP: string
    sourceGeoIP: string[]
    sourceIPASN: string
    destinationIP: string
    destinationGeoIP: string[]
    destinationIPASN: string
    sourcePort: string
    destinationPort: string
    inboundIP: string
    inboundPort: string
    inboundName: string
    inboundUser: string
    host: string
    dnsMode: string
    uid: number
    process: string
    processPath: string
    specialProxy: string
    specialRules: string
    remoteDestination: string
    dscp: number
    sniffHost: string
  }
  uploadSpeed?: number
  downloadSpeed?: number
  upload: number
  download: number
  start: string
  chains: string[]
  providerChains: string[]
  rule: string
  rulePayload: string
}

interface IMihomoHistory {
  time: string
  delay: number
}

type IMihomoGroupDelay = Record<string, number>

interface IMihomoDelay {
  delay?: number
  message?: string
}

interface IMihomoProxy {
  alive: boolean
  extra: Record<string, { alive: boolean; history: IMihomoHistory[] }>
  history: IMihomoHistory[]
  id: string
  name: string
  tfo: boolean
  type: MihomoProxyType
  udp: boolean
  uot: boolean
  xudp: boolean
  mptcp: boolean
  smux: boolean
  interface?: string
  'routing-mark'?: number
  'provider-name'?: string
  'dialer-proxy'?: string
}

interface IMihomoGroup {
  alive: boolean
  all: string[]
  extra: Record<string, { alive: boolean; history: IMihomoHistory[] }>
  testUrl?: string
  expectedStatus?: string
  fixed?: string
  hidden: boolean
  history: IMihomoHistory[]
  icon: string
  name: string
  now: string
  tfo: boolean
  type: MihomoGroupType
  udp: boolean
  xudp: boolean
}

interface IMihomoProxies {
  proxies: Record<string, IMihomoProxy | IMihomoGroup>
}

interface IMihomoMixedGroup extends IMihomoGroup {
  all: (IMihomoProxy | IMihomoGroup)[]
}

interface IMihomoRuleProviders {
  providers: Record<string, IMihomoRuleProvider>
}

interface IMihomoRuleProvider {
  behavior: string
  format: string
  name: string
  ruleCount: number
  type: string
  updatedAt: string
  vehicleType: string
  payload?: string[]
}

interface IMihomoProxyProviders {
  providers: Record<string, IMihomoProxyProvider>
}

interface ISubscriptionUserInfoUpper {
  Upload: number
  Download: number
  Total: number
  Expire: number
}

interface IMihomoProxyProvider {
  name: string
  type: string
  proxies?: IMihomoProxy[]
  subscriptionInfo?: ISubscriptionUserInfoUpper
  expectedStatus: string
  testUrl?: string
  updatedAt?: string
  vehicleType: string
}

interface ISysProxyConfig {
  enable: boolean
  host?: string
  mode?: SysProxyMode
  bypass?: string[]
  pacScript?: string
}

interface INetworkLatencyTarget {
  name: string
  url: string
}

interface ICustomTrayIcons {
  off?: string
  sysProxy?: string
  tun?: string
}

type ScriptOutletMode = 'direct' | 'fallback'

type ScriptOutletListenerType = 'mixed' | 'socks5' | 'http'

interface IScriptOutlet {
  id: string
  enable: boolean
  /** 监听端口，脚本通过 --proxy-server=127.0.0.1:<port> 指向该出口 */
  port: number
  /** 入站类型，mixed 同时支持 HTTP 与 SOCKS5 */
  type: ScriptOutletListenerType
  /**
   * direct: proxy 直接指向 target（节点名或已有策略组名），不生成额外策略组
   * fallback: 用 targets 生成一个专用 fallback 组，listener 指向该组，具备容错能力
   */
  mode: ScriptOutletMode
  /** mode=direct 时使用：节点名或策略组名 */
  target?: string
  /** mode=fallback 时使用：按顺序容错的节点名列表 */
  targets?: string[]
  /**
   * 批量出口个数：为空或 <=1 表示普通单个出口。
   * >1 时该条目在 UI 上仍是一张卡片，注入内核时展开为 count 个 listener：
   * 端口从 port 起递增，备注为 remark + 补零序号（test01、test02…）。
   */
  count?: number
  /**
   * 批量 + mode=direct 时使用：按选择顺序 1:1 对应各出口端口的目标列表，
   * 第 i 个出口用 batchTargets[i]。mode=fallback 时忽略，所有出口共用 targets。
   */
  batchTargets?: string[]
  /** mode=fallback 时的健康检查地址，为空则用默认值 */
  testUrl?: string
  /** mode=fallback 时的健康检查间隔（秒），为空则用默认值 */
  interval?: number
  /** 备注，仅 UI 展示，例如“USA-签到专用” */
  remark?: string
  udp?: boolean
}

/**
 * 脚本控制 API：给外部脚本提供一个受限的 HTTP 接口，
 * 让脚本能在运行时主动切换策略组节点，而无需开放 mihomo 的 external-controller。
 */
interface IScriptApiConfig {
  enable?: boolean
  /** HTTP 监听端口 */
  port?: number
  /** 访问令牌，请求需带 Authorization: Bearer <token> */
  token?: string
  /** 切换节点后是否自动断开旧连接，让新节点立即生效 */
  autoCloseConnection?: boolean
}

interface IAppConfig {
  core: 'mihomo' | 'mihomo-alpha' | 'mihomo-smart' | 'mihomo-specific'
  specificVersion?: string
  enableSmartCore: boolean
  enableSmartOverride: boolean
  smartCoreUseLightGBM: boolean
  smartCoreCollectData: boolean
  smartCoreStrategy: 'sticky-sessions' | 'round-robin'
  smartCollectorSize?: number
  proxyDisplayMode: 'simple' | 'full'
  proxyDisplayOrder: 'default' | 'delay' | 'name'
  profileDisplayDate?: 'expire' | 'update'
  envType?: ('bash' | 'cmd' | 'powershell' | 'fish' | 'nushell')[]
  proxyCols: 'auto' | '1' | '2' | '3' | '4'
  hideUnavailableProxies?: boolean
  /** 代理页面隐藏延迟超过 availableDelayThreshold 的节点（未测过的节点照常显示） */
  hideSlowProxies?: boolean
  /** 「隐藏慢节点」只在这些分组内生效；留空则对所有分组生效 */
  hideSlowProxiesGroups?: string[]
  /** 「能用」判定阈值（毫秒）：代理页面隐藏慢节点、脚本控制 API 过滤名单都用它 */
  availableDelayThreshold?: number
  connectionDirection: 'asc' | 'desc'
  connectionOrderBy: 'time' | 'upload' | 'download' | 'uploadSpeed' | 'downloadSpeed'
  connectionViewMode?: 'list' | 'table'
  connectionTableColumns?: string[]
  connectionTableColumnWidths?: Record<string, number>
  connectionTableSortColumn?: string
  connectionTableSortDirection?: 'asc' | 'desc'
  displayIcon?: boolean
  displayAppName?: boolean
  spinFloatingIcon?: boolean
  disableTray?: boolean
  swapTrayClick?: boolean
  showFloatingWindow?: boolean
  floatingWindowCompatMode?: boolean
  disableHardwareAcceleration?: boolean
  connectionCardStatus?: CardStatus
  dnsCardStatus?: CardStatus
  logCardStatus?: CardStatus
  hideConnectionCardWave?: boolean
  pauseSSID?: string[]
  disableDnsOnPauseSSID?: boolean
  controlDnsBeforePause?: boolean
  mihomoCoreCardStatus?: CardStatus
  overrideCardStatus?: CardStatus
  profileCardStatus?: CardStatus
  proxyCardStatus?: CardStatus
  networkCardStatus?: CardStatus
  resourceCardStatus?: CardStatus
  ruleCardStatus?: CardStatus
  sniffCardStatus?: CardStatus
  substoreCardStatus?: CardStatus
  sysproxyCardStatus?: CardStatus
  tunCardStatus?: CardStatus
  usageCardStatus?: CardStatus
  githubToken?: string
  gistAgeEncrypt?: boolean
  gistAgeRecipient?: string
  gistAgeSecretKey?: string
  useSubStore: boolean
  subStoreHost?: string
  subStoreBackendSyncCron?: string
  subStoreBackendDownloadCron?: string
  subStoreBackendUploadCron?: string
  autoQuitWithoutCore?: boolean
  autoQuitWithoutCoreDelay?: number
  autoQuitWithoutCoreMode?: 'core' | 'tray'
  useCustomSubStore?: boolean
  useProxyInSubStore?: boolean
  pluginUseProxy?: boolean // 插件网关请求经由本地混合端口代理（安全保证降级，默认关闭）
  mihomoCpuPriority?: Priority
  coreStartupMode?: 'log' | 'post-up'
  customSubStoreUrl?: string
  diffWorkDir?: boolean
  autoSetDNS?: boolean
  originDNS?: string
  useWindowFrame: boolean
  proxyInTray: boolean
  showCurrentProxyInTray: boolean
  enableTrafficLogger?: boolean
  siderOrder: string[]
  lastSelectedSiderCard?: SiderCardKey
  rememberSelectedSiderCard?: boolean
  lockSiderCards?: boolean
  siderWidth: number
  appTheme: AppTheme
  customTheme?: string
  autoCheckUpdate: boolean
  silentUpdate: boolean
  githubProxy?: string
  silentStart: boolean
  autoCloseConnection: boolean
  sysProxy: ISysProxyConfig
  maxLogDays: number
  maxLogFileSize: number
  disableAppLog?: boolean
  userAgent?: string
  delayTestConcurrency?: number
  delayTestUrl?: string
  delayTestTimeout?: number
  /**
   * 脚本专用出口的延迟探测地址（`POST /probe mode=delay` 与基线全量共用）。
   *
   * 与 delayTestUrl 分开是因为两者服务对象不同：delayTestUrl 是界面上「点一下测延迟」
   * 给人看的，改它会立刻影响 UI 显示；而探测判据一旦换地址，probeStore 里所有旧记录
   * 就不是同一口径的数据了（记录里带 url 字段正是为此）。让脚本侧有一个独立开关，
   * 用户调 UI 测速地址时不会顺手打乱脚本的判据。
   *
   * 留空时回退到 delayTestUrl，再回退到内核默认的 https://www.gstatic.com/generate_204。
   */
  probeTestUrl?: string
  networkLatencyTargets?: INetworkLatencyTarget[]
  networkIPProvider?: 'ip.sb' | 'ipwho.is' | 'ipapi.is'
  networkInfoCardOrder?: NetworkInfoCardKey[]
  subscriptionTimeout?: number
  encryptedPassword?: number[]
  controlDns?: boolean
  controlSniff?: boolean
  useDockIcon?: boolean
  showTraffic?: boolean
  disableTrayIconColor?: boolean
  customTrayIcon?: string
  customTrayIcons?: ICustomTrayIcons
  trayProxyGroupStyle?: 'default' | 'submenu'
  disableAnimations?: boolean
  webdavUrl?: string
  webdavDir?: string
  webdavUsername?: string
  webdavPassword?: string
  webdavMaxBackups?: number
  webdavBackupCron?: string
  webdavIgnoreCert?: boolean
  useNameserverPolicy: boolean
  nameserverPolicy: { [key: string]: string | string[] }
  showWindowShortcut?: string
  showFloatingWindowShortcut?: string
  triggerSysProxyShortcut?: string
  triggerTunShortcut?: string
  ruleModeShortcut?: string
  globalModeShortcut?: string
  directModeShortcut?: string
  restartAppShortcut?: string
  quitWithoutCoreShortcut?: string
  copyEnvShortcut?: string
  language?: 'zh-CN' | 'zh-TW' | 'en-US' | 'ru-RU' | 'fa-IR'
  triggerMainWindowBehavior?: 'show' | 'toggle'
  showMixedPort?: number
  enableMixedPort?: boolean
  showSocksPort?: number
  enableSocksPort?: boolean
  showHttpPort?: number
  enableHttpPort?: boolean
  showRedirPort?: number
  enableRedirPort?: boolean
  showTproxyPort?: number
  enableTproxyPort?: boolean
  testProfileOnStart?: boolean
  useHotReloadProfile?: boolean
  hotReloadProfileAutoCloseConnection?: boolean
  /** 脚本专用出口：为每个出口生成独立 listener，供外部脚本用 --proxy-server 指定 */
  scriptOutlets?: IScriptOutlet[]
  /** 脚本控制 API：受限 HTTP 接口，供脚本运行时切换策略组节点 */
  scriptApi?: IScriptApiConfig
  outletCardStatus?: CardStatus
}

interface IMihomoTunConfig {
  enable?: boolean
  stack?: TunStack
  'auto-route'?: boolean
  'auto-redirect'?: boolean
  'auto-detect-interface'?: boolean
  'dns-hijack'?: string[]
  device?: string
  mtu?: number
  'strict-route'?: boolean
  gso?: boolean
  'gso-max-size'?: number
  'udp-timeout'?: number
  'iproute2-table-index'?: number
  'iproute2-rule-index'?: number
  'endpoint-independent-nat'?: boolean
  'route-address-set'?: string[]
  'route-exclude-address-set'?: string[]
  'route-address'?: string[]
  'route-exclude-address'?: string[]
  'include-interface'?: string[]
  'exclude-interface'?: string[]
  'include-uid'?: number[]
  'include-uid-range'?: string[]
  'exclude-uid'?: number[]
  'exclude-uid-range'?: string[]
  'include-android-user'?: string[]
  'include-package'?: string[]
  'exclude-package'?: string[]
}
interface IMihomoDNSConfig {
  enable?: boolean
  listen?: string
  ipv6?: boolean
  'ipv6-timeout'?: number
  'prefer-h3'?: boolean
  'enhanced-mode'?: DnsMode
  'fake-ip-range'?: string
  'fake-ip-filter'?: string[]
  'fake-ip-filter-mode'?: FilterMode
  'use-hosts'?: boolean
  'use-system-hosts'?: boolean
  'respect-rules'?: boolean
  'default-nameserver'?: string[]
  nameserver?: string[]
  fallback?: string[]
  'fallback-filter'?: { [key: string]: boolean | string | string[] }
  'proxy-server-nameserver'?: string[]
  'direct-nameserver'?: string[]
  'direct-nameserver-follow-policy'?: boolean
  'nameserver-policy'?: { [key: string]: string | string[] }
  'cache-algorithm'?: string
}

interface IMihomoSnifferConfig {
  enable?: boolean
  'parse-pure-ip'?: boolean
  'override-destination'?: boolean
  'force-dns-mapping'?: boolean
  'force-domain'?: string[]
  'skip-domain'?: string[]
  'skip-dst-address'?: string[]
  'skip-src-address'?: string[]
  sniff?: {
    HTTP?: {
      ports: (number | string)[]
      'override-destination'?: boolean
    }
    TLS?: {
      ports: (number | string)[]
    }
    QUIC?: {
      ports: (number | string)[]
    }
  }
}

interface IMihomoProfileConfig {
  'store-selected'?: boolean
  'store-fake-ip'?: boolean
}

/** mihomo listeners 入站监听器，用于给脚本提供独立出口端口 */
interface IMihomoListener {
  name: string
  type: string
  port: number
  listen?: string
  proxy?: string
  udp?: boolean
}

interface IMihomoConfig {
  'external-controller-pipe': string
  'external-controller-unix': string
  'external-controller': string
  'external-ui': string
  'external-ui-url': string
  'external-controller-cors'?: {
    'allow-origins'?: string[]
    'allow-private-network'?: boolean
  }
  secret?: string
  ipv6: boolean
  mode: OutboundMode
  'mixed-port': number
  'allow-lan': boolean
  'unified-delay': boolean
  'tcp-concurrent': boolean
  'log-level': LogLevel
  'find-process-mode': FindProcessMode
  'socks-port'?: number
  'redir-port'?: number
  'tproxy-port'?: number
  'skip-auth-prefixes'?: string[]
  'bind-address'?: string
  'lan-allowed-ips'?: string[]
  'lan-disallowed-ips'?: string[]
  authentication: string[]
  port?: number
  proxies?: Record<string, unknown>[]
  'proxy-groups'?: Record<string, unknown>[]
  listeners?: IMihomoListener[]
  rules?: []
  hosts?: { [key: string]: string | string[] }
  'geodata-mode'?: boolean
  'geo-auto-update'?: boolean
  'geo-update-interval'?: number
  'geox-url'?: {
    geoip?: string
    geosite?: string
    mmdb?: string
    asn?: string
  }
  tun: IMihomoTunConfig
  dns: IMihomoDNSConfig
  sniffer: IMihomoSnifferConfig
  profile: IMihomoProfileConfig
}

interface IProfileConfig {
  current?: string
  items: IProfileItem[]
}

interface IOverrideItem {
  id: string
  type: 'remote' | 'local'
  ext: 'js' | 'yaml'
  name: string
  updated: number
  global?: boolean
  url?: string
  file?: string
}

interface IOverrideConfig {
  items: IOverrideItem[]
}

interface ISubscriptionUserInfo {
  upload: number
  download: number
  total: number
  expire: number
}

interface IProfileItem {
  id: string
  type: 'remote' | 'local' | 'plugin'
  name: string
  url?: string // remote
  file?: string // local
  interval?: number | string
  home?: string
  updated?: number
  override?: string[]
  useProxy?: boolean
  extra?: ISubscriptionUserInfo
  substore?: boolean
  allowFixedInterval?: boolean
  autoUpdate?: boolean
  authToken?: string
  userAgent?: string
  ageSecretKey?: string
  updateTimeout?: number
  pluginId?: string
}

interface ISubStoreSub {
  name: string
  displayName?: string
  icon?: string
  tag?: string[]
}

interface IPluginProvider {
  name: string
  icon?: string
  site?: string
}

// .cpx v2 — public, unencrypted descriptor. Contains NO secrets.
interface IPluginDescriptor {
  magic: 'CPXF'
  v: 2
  spec: 'cpx-plugin/2'
  loginUrl: string // OAuth authorize endpoint, https, no query/fragment
  provider: IPluginProvider
}

// Subset returned by previewPlugin for the install-confirm page (no records, no network)
interface IPluginDescriptorPreview {
  name: string
  icon?: string
  site?: string
  loginUrl: string // full url; UI shows the host
  spec: string
}

interface IPluginFilePayload {
  name: string
  fileBytesB64: string
}

interface IGatewayEndpoints {
  enroll: string
  challenge: string
  config: string
  revoke: string
}

// /.well-known/cpx-gateway discovery response
interface IGatewayWellKnown {
  spec: 'cpx-plugin/2'
  gateway: string // https origin, no path/query/fragment
  endpoints: IGatewayEndpoints
}

type IPluginStatus = 'needs-login' | 'active' | 'needs-reauth'

interface IPluginItem {
  id: string
  name: string
  icon?: string
  site?: string
  loginUrl: string // public metadata; required to re-open the browser after restart
  spec: string
  profileId?: string // absent while 'needs-login'; present once 'active'/'needs-reauth'
  status: IPluginStatus
  interval?: number
  autoUpdate?: boolean
  useProxy?: boolean // 插件请求经由代理开关（可选，覆盖全局配置）
  created: number
  updated: number
  lastUpdateErrorType?: 'auth' | 'transient'
  lastUpdateErrorAt?: number
  nextRetryAt?: number
  failureCount?: number
}

interface IPluginConfig {
  items: IPluginItem[]
}

// safeStorage-encrypted vault payload — the ONLY place secrets live.
interface IPluginVault {
  devicePrivKey: string // Ed25519 raw 32-byte seed, base64 (standard, padded)
  deviceId: string // UUIDv4
  gateway: {
    gateway: string // discovered https origin (cached for silent updates)
    endpoints: IGatewayEndpoints
  }
}
