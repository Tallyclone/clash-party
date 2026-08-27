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

/** 单条批量出口最多展开多少个 listener，防止误填个数把内核端口打满 */
export const SCRIPT_OUTLET_MAX_BATCH_COUNT = 200

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

/**
 * `maxAge` 查询参数的下限（毫秒）。
 *
 * 没有下限的话，脚本传 `maxAge=1` 就会让几乎每个请求都判定数据过期，
 * 于是现测被背靠背连续触发（唯一的刹车只有探测模块的单飞锁），内核持续满负荷测速。
 * 另一个原因是候选池判定要回看内核的 history，而 history 只保留 10 条：
 * 轮询过密时这 10 条只跨十几秒，「容忍几次失败」的机制会被直接烧穿。
 */
export const SCRIPT_API_MIN_MAX_AGE_MS = 30 * 1000

/**
 * 名单探测（`POST /probe` 带 `body.proxies`）同一时刻允许在飞的测速请求总数。
 *
 * 这是**全局**上限，跨请求共享：两个脚本各传 400 个名字，总并发仍然是这个数，
 * 两个请求会互相拖慢。这是刻意的 —— 闸门存在的意义就是保护内核和机场，
 * 不是保证单个请求的速度。文档里写清楚了，否则脚本作者会把变慢当成 bug。
 *
 * 参照现有量级：代理页面「测组延迟」默认并发 50（可在设置页改）、
 * 托盘「测试延迟」把整组丢给内核、内核全并发无上限（70 成员组就是 70 个）、
 * 延迟探测模块现测 64 / 全量 32。所以这个数不算激进。
 *
 * ⚠ 名单探测**不走**探测模块的单飞锁，所以它可以和一轮全量（并发 32）同时跑，
 * 瞬时叠加最坏是 200 + 64 = 264。想消掉这个叠加得让 probeNames() 接受外部信号量，
 * 那是侵入全量/现测的热路径，收益不值当 —— 264 和 200 在机场眼里没有本质区别。
 *
 * ⚠ 真正的风险不是耗时而是**误判**：并发过高时机场可能限速或丢包，
 * 一批健康节点同时超时 → 内核全记成 delay 0 → 同时污染 isUsable()（看最后一条）
 * 和 isProbeCandidate()（看最近 3 条），脚本会在接下来几分钟拿到错误的「不可用」名单。
 * 如果观察到「测完一轮之后可用节点数突然掉一截」，把这个数降下来即可。
 */
export const SCRIPT_API_NAMED_PROBE_CONCURRENCY = 200

/**
 * 名单探测单次请求最多接受多少个节点名，超出部分直接截断（不报错）。
 *
 * 截断发生在**去重与校验之后**，所以重复名、不存在的名、策略组名都不占额度。
 * 顺序按脚本传进来的数组，因此脚本要把最在意的放前面。
 *
 * 最坏耗时 ≈ ceil(名单数 / 并发) × timeout。400 个名字、并发 200、超时 1200ms
 * 就是 2 轮窗口约 2.4 秒。请求体本身还有 express 的 64kb 限制兜底（约 3000 个名字）。
 */
export const SCRIPT_API_NAMED_PROBE_MAX_NAMES = 400

/**
 * 名单探测 timeout 参数的下限（毫秒）。
 *
 * 不加下限的话传 `timeout=1` 会把所有节点都测成 delay 0，那不只是没用而是有害 ——
 * 这些 0 会写进内核 history，污染候选池判定和「能用」判定。
 */
export const SCRIPT_API_NAMED_PROBE_MIN_TIMEOUT = 500

/** 名单探测 timeout 参数的上限（毫秒）。并发固定后，timeout 是唯一决定最坏耗时的量 */
export const SCRIPT_API_NAMED_PROBE_MAX_TIMEOUT = 5000

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
 * 现测的候选范围：history 里的延迟在此值以内才算「还值得测一次」。
 *
 * 故意放宽于「能用」判定阈值（1000）—— 上一轮全量测出 1000~2000ms 的节点，
 * 下一轮现测仍值得碰一次运气。注意这个放宽**只对全量产出的记录有意义**：
 * 现测超时压到了 1200ms，失败会被内核记成 delay 0，
 * 所以现测本身永远产不出 (1200, 2000] 区间的值。
 * 「抖动的节点能自己爬回来」靠的不是这个上限，而是下面的回看条数。
 */
export const DELAY_PROBE_CANDIDATE_MAX_DELAY = 2000

/**
 * 候选池判定回看的 history 条数。
 *
 * 只看最后一条的话，一次失败就等于永久除名：现测超时 1200ms，一个真实延迟抖到
 * 1300ms 的健康节点会被记成 delay 0，此后所有现测都不再碰它，只能等下一轮全量捞回来。
 * 实测 426 个节点的订阅里有 94 个（22%）处于「最近 3 条既有失败又有达标」的抖动状态，
 * 因此这个容忍不是可选优化。
 *
 * 取 3 的含义是「容忍 2 次连续失败」。上限是内核侧的 history 长度（实测 10 条）。
 * **设成 1 即精确等价于改动前的行为**，可以当回滚开关用（有单测保证）。
 */
export const DELAY_PROBE_CANDIDATE_HISTORY_COUNT = 3

/**
 * 候选池判定的陈旧上限（毫秒）：再往前的达标记录不再采信。
 *
 * 必须 ≥ (回看条数 - 1) × 全量间隔，否则时间窗会先咬住条数、让回看机制失效 ——
 * 实测只有全量在写记录的节点是 30 分钟一条（占 79%），W=30min 时窗口内只剩 1 条，
 * 等于把整个机制关掉。取「回看条数 × 全量间隔」留一轮余量。
 *
 * 放得足够宽之后，生效的约束只剩条数，于是判定语义与写入速率无关，
 * 恒定是「容忍 N-1 次连续失败」—— 这一点很重要，因为实测各节点的写入间隔
 * 相差 30 倍（全量 30min/条 vs 内核对 lazy 组健康检查时的 60s/条）。
 * 它剩下的职责是兜住休眠唤醒、订阅节点不再被测这类「历史整体变古老」的场景。
 */
export const DELAY_PROBE_CANDIDATE_MAX_AGE_MS =
  DELAY_PROBE_CANDIDATE_HISTORY_COUNT * DELAY_PROBE_FULL_INTERVAL_MINUTES * 60 * 1000

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
