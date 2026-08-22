export const DEFAULT_CONTROL_DNS = false

export const DEFAULT_CONTROL_SNIFF = true

export const DEFAULT_USE_NAMESERVER_POLICY = false

export const DEFAULT_NAMESERVER_POLICY: IAppConfig['nameserverPolicy'] = {}

export const DEFAULT_ENABLE_TRAFFIC_LOGGER = true

export const DEFAULT_USE_SUB_STORE = true

export const DEFAULT_SIDER_ORDER: SiderCardKey[] = [
  'sysproxy',
  'tun',
  'profile',
  'proxy',
  'rule',
  'resource',
  'override',
  'connection',
  'mihomo',
  'dns',
  'sniff',
  'log',
  'substore',
  'network',
  'usage',
  'outlet'
]

export const DEFAULT_NETWORK_INFO_CARD_ORDER: NetworkInfoCardKey[] = ['ip', 'topology', 'latency']

export const DEFAULT_MIHOMO_PORTS = {
  mixed: 7890,
  socks: 7891,
  http: 7892,
  redir: 0,
  tproxy: 0
} as const

export const DEFAULT_MIHOMO_SKIP_AUTH_PREFIXES = ['127.0.0.1/32', '::1/128']

/** 脚本专用出口相关常量 */
export const SCRIPT_OUTLET_LISTENER_PREFIX = 'party-outlet-'

export const SCRIPT_OUTLET_GROUP_PREFIX = 'PARTY-OUTLET-'

/** 出口 listener 固定只监听回环，避免在局域网暴露无鉴权代理 */
export const SCRIPT_OUTLET_LISTEN_ADDRESS = '127.0.0.1'

export const DEFAULT_SCRIPT_OUTLET_TEST_URL = 'https://cp.cloudflare.com/generate_204'

export const DEFAULT_SCRIPT_OUTLET_INTERVAL = 300
export const DEFAULT_SCRIPT_OUTLETS: IScriptOutlet[] = []

/** 脚本控制 API 相关常量 */
export const SCRIPT_API_LISTEN_ADDRESS = '127.0.0.1'

export const DEFAULT_SCRIPT_API_PORT = 17890

export const DEFAULT_SCRIPT_API_CONFIG: IScriptApiConfig = {
  enable: false,
  port: DEFAULT_SCRIPT_API_PORT,
  token: '',
  autoCloseConnection: true
}

/** 「能用」判定阈值（毫秒）。代理页面隐藏慢节点与脚本控制 API 过滤名单共用同一个口径 */
export const DEFAULT_AVAILABLE_DELAY_THRESHOLD = 1000

/** 代理页面默认不隐藏慢节点，需要用户主动打开 */
export const DEFAULT_HIDE_SLOW_PROXIES = false

/**
 * 「隐藏慢节点」只在这些分组内生效；留空数组则对所有分组生效。
 *
 * 默认只管覆写脚本生成的「[能用]」「[出口能用]」两组：日常分组不该因为一次抖动
 * 就少掉半屏节点，而这两组的存在意义本来就是「现在挑得出来能用的」。
 * 两组成员逐项一致，区别只在前者供手动切换、后者专供脚本出口。
 */
export const DEFAULT_HIDE_SLOW_PROXIES_GROUPS = ['[能用]', '[出口能用]']

/** 全量基线探测间隔（分钟）。这是唯一躲不掉的固定开销：界面要有延迟数字才能筛 */
export const DELAY_PROBE_FULL_INTERVAL_MINUTES = 30

/** 数据超过这个年龄，脚本请求名单时才值得先做一次现测（毫秒） */
export const DELAY_PROBE_FRESH_MS = 5 * 60 * 1000

/**
 * 现测超时（毫秒）。压到略高于判定阈值即可 —— 慢于阈值的节点反正要被筛掉，
 * 没必要等它把话说完。这是把等待从 5 秒压到 1 秒级的关键。
 */
export const DELAY_PROBE_QUICK_TIMEOUT = 1200

/** 全量基线探测超时（毫秒）。没人等它，可以给宽一点以便区分「慢」和「死」 */
export const DELAY_PROBE_FULL_TIMEOUT = 3000

/**
 * 现测的候选范围：上次延迟在此值以内的节点才参与。
 * 故意放宽于判定阈值，这样偶尔抖到阈值以上的节点下一次现测还能自己爬回来，
 * 不用等 30 分钟那轮全量。
 */
export const DELAY_PROBE_CANDIDATE_MAX_DELAY = 2000

/** 全量基线探测并发 */
export const DELAY_PROBE_FULL_CONCURRENCY = 32

/** 现测并发。调高是为了让候选池一批打完，把等待压在一个超时周期内 */
export const DELAY_PROBE_QUICK_CONCURRENCY = 64

/** 启动后延迟多久跑第一次基线（毫秒），避开内核刚起来的忙碌期 */
export const DELAY_PROBE_STARTUP_DELAY_MS = 20 * 1000

export const DEFAULT_MIHOMO_LAN_ALLOWED_IPS = ['0.0.0.0/0', '::/0']

export function getDefaultMihomoTunDevice(platform: NodeJS.Platform | string): string {
  return platform === 'darwin' ? 'utun1500' : 'Mihomo'
}

type DefaultMihomoTunConfig = {
  enable: boolean
  stack: TunStack
  'auto-route': boolean
  'auto-redirect': boolean
  'auto-detect-interface': boolean
  'dns-hijack': string[]
  'route-exclude-address': string[]
  mtu: number
}

export const DEFAULT_MIHOMO_TUN_CONFIG: DefaultMihomoTunConfig = {
  enable: false,
  stack: 'mixed',
  'auto-route': true,
  'auto-redirect': false,
  'auto-detect-interface': true,
  'dns-hijack': ['any:53'],
  'route-exclude-address': [],
  mtu: 1500
}

export const DEFAULT_MIHOMO_DNS_CONFIG: IMihomoDNSConfig = {
  enable: true,
  ipv6: false,
  'enhanced-mode': 'fake-ip',
  'fake-ip-range': '198.18.0.1/16',
  'fake-ip-filter': ['*', '+.lan', '+.local', 'time.*.com', 'ntp.*.com', '+.market.xiaomi.com'],
  'use-hosts': false,
  'use-system-hosts': false,
  'respect-rules': false,
  'default-nameserver': ['tls://223.5.5.5'],
  nameserver: ['https://doh.pub/dns-query', 'https://dns.alidns.com/dns-query'],
  'proxy-server-nameserver': ['https://doh.pub/dns-query', 'https://dns.alidns.com/dns-query'],
  'direct-nameserver': [],
  fallback: [],
  'fallback-filter': {
    geoip: true,
    'geoip-code': 'CN',
    ipcidr: ['240.0.0.0/4', '0.0.0.0/32'],
    domain: ['+.google.com', '+.facebook.com', '+.youtube.com']
  }
}

// 仅包含旧模板实际下发到内核的字段，QUIC / force-domain / skip-src-address
// 等属于设置页可选项，不写入默认配置，避免凭空给已有用户的内核加参数。
type DefaultMihomoSnifferConfig = {
  enable: boolean
  'parse-pure-ip': boolean
  'force-dns-mapping': boolean
  'override-destination': boolean
  sniff: {
    HTTP: {
      ports: (number | string)[]
      'override-destination': boolean
    }
    TLS: {
      ports: (number | string)[]
    }
  }
  'skip-domain': string[]
  'skip-dst-address': string[]
}

export const DEFAULT_MIHOMO_SNIFFER_CONFIG: DefaultMihomoSnifferConfig = {
  enable: true,
  'parse-pure-ip': true,
  'force-dns-mapping': true,
  'override-destination': false,
  sniff: {
    HTTP: {
      ports: [80, 443],
      'override-destination': false
    },
    TLS: {
      ports: [443]
    }
  },
  'skip-domain': ['+.push.apple.com'],
  'skip-dst-address': [
    '91.105.192.0/23',
    '91.108.4.0/22',
    '91.108.8.0/21',
    '91.108.16.0/21',
    '91.108.56.0/22',
    '95.161.64.0/20',
    '149.154.160.0/20',
    '185.76.151.0/24',
    '2001:67c:4e8::/48',
    '2001:b28:f23c::/47',
    '2001:b28:f23f::/48',
    '2a0a:f280:203::/48'
  ]
}
