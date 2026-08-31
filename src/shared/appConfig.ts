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
 * `GET /groups?maxAge=` 查询参数的下限（毫秒）。
 *
 * 没有下限的话，脚本传 `maxAge=1` 就会让几乎每个请求都判定数据过期，
 * 于是全量探测被背靠背连续触发（唯一的刹车只有探测模块的单飞锁），内核持续满负荷测速。
 *
 * 注意这个下限只管 `GET /groups` 的陈旧判定。`POST /probe` 的 `maxAge`
 * 走的是 probeStore 的按名单 lazy refresh，允许传 0 强制现测 ——
 * 那条路径只测脚本点名的节点，不会像全量那样把整个订阅打一遍。
 */
export const SCRIPT_API_MIN_MAX_AGE_MS = 30 * 1000

/**
 * **所有**探测流量同一时刻允许在飞的连接总数。全局唯一的天花板。
 *
 * 覆盖三条路径，一个都不能漏：
 * - 全量基线（runFullProbe，每隔 N 分钟测一遍整个订阅）；
 * - 名单探测（POST /probe mode=delay，脚本点名）；
 * - 工位拨测（POST /probe mode=ip，手写 raw socket 查出口 IP）。
 *
 * 跨请求也跨用途共享：两个脚本各传 400 个名字、同时还有一轮基线和一批工位拨测在跑，
 * 总并发仍然是这个数，几方互相排队拖慢。这是刻意的 —— 闸门存在的意义就是保护内核和
 * 机场，不是保证单个请求的速度。文档里写清楚了，否则脚本作者会把变慢当成 bug。
 *
 * ⚠ 名额按【连接数】算而不是节点数。工位拨测一个节点会同时拨 PROBE_IP_TARGETS 里的
 * 3 个目标，所以它一个节点要占 3 个名额。
 *
 * ⚠ 历史坑（两次，同一个病根）：
 * 1. 基线曾经不占名额（probeOne 第三参传 false），理由是「基线自己有滑动窗口」。
 *    结果两者可叠加，瞬时并发 = 基线并发 + 这个值。实测各 200（峰值 400）是所有配置里
 *    对用户上网伤害最大的一种：双通道哨兵 p50 直接翻倍（547→1137ms / 588→1473ms）、
 *    失败率 5.7%/6.2%，比「一次性把 566 个节点全部并发拨出去」还差。
 * 2. 工位拨测曾经只受工位池租约约束（100 工位 / 单请求配额 50，每工位 3 目标
 *    ⇒ 最坏 300 条连接），与本闸门完全独立，是第三份预算。
 *
 * 共同教训：**局部限流推不出全局有界**。每一路都「守规矩」和「合起来把网络压垮」
 * 可以同时成立。所以新增任何探测路径都必须过 probeGate，不要在自己模块里另立
 * 一个本地上限来代替它。
 *
 * 取值 150 的依据：实测干扰的质变点在 300（TUN p90 飙到 5213ms、失败率首破 1%），
 * 200 档已经有 0.26~0.53% 的哨兵失败率，100 档才回到 idle 噪声（失败率 0%）。
 * 150 是「留一点吞吐」与「别碰质变点」的折中；现在它是三方共用的总额，不再是
 * 某一路的专属预算，所以比原来的 200 更保守是必要的。别往 300 上调。
 */
export const PROBE_GATE_CONCURRENCY = 150

/**
 * 名单探测单次请求最多接受多少个节点名，超出部分直接截断（不报错）。
 *
 * 截断发生在**去重与校验之后**，所以重复名、不存在的名、策略组名都不占额度。
 * 顺序按脚本传进来的数组，因此脚本要把最在意的放前面。
 *
 * 最坏耗时 ≈ ceil(未命中数 / 并发) × DELAY_PROBE_TIMEOUT。400 个全未命中、
 * 并发 200、超时 6000ms 就是 2 波约 12.6 秒 —— 耗时严格按波数跳变，没有中间档。
 * 稳态下大部分名字会命中 probeStore（默认 300 秒新鲜度），实际耗时远低于此。
 * 请求体本身还有 express 的 64kb 限制兜底（约 3000 个名字）。
 */
export const SCRIPT_API_NAMED_PROBE_MAX_NAMES = 400

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

/**
 * 全量基线探测间隔（分钟）的**默认值**。用户可在「脚本专用出口」页面改，
 * 实际生效值读 appConfig.delayProbeIntervalMinutes，0 表示关闭周期探测。
 *
 * 基线的职责是**保全组覆盖**，不是保新鲜：脚本要的新鲜度由 probeStore 的
 * lazy refresh 负责（见 PROBE_STORE_DEFAULT_MAX_AGE_MS）。
 *
 * 为什么不能靠基线保新鲜：要让基线数据满足 300 秒的新鲜度门槛，周期得压到 5 分钟，
 * 实测流量账是 42.4 GB/月（单次测速 8.01 KB × 642 个节点 × 288 轮/天），
 * 而其中绝大多数节点脚本根本不会点名。低频保覆盖 + 按需保新鲜才是正确的切法。
 *
 * 为什么覆盖仍然不可少：脚本的「发现型查询」（GET /groups?maxDelay=…）问的是
 * 「这个组里哪些能用」，表里没有记录的节点会被判不可用 → 不出现在返回名单 →
 * 脚本永远不会拿它的名字去 POST /probe → 永远不进表。这个自锁不会自愈，
 * 只有全组覆盖的基线能打破它。
 */
export const DELAY_PROBE_FULL_INTERVAL_MINUTES = 180

/**
 * 周期探测间隔的下限（分钟）。0 是合法值（=关闭），但只要开着就不允许比这更密。
 *
 * 取 5 的依据是流量账：一轮 ≈ 节点数 × 8.01 KB（566 个节点实测 4.5 MB），
 * 5 分钟一轮 = 288 轮/天 ≈ 1.3 GB/天 ≈ 39 GB/月。再密下去单轮耗时（实测
 * 并发 100 时 22 秒）会开始逼近周期本身，探测变成近乎连续满载，
 * 而单飞锁只会把重叠的轮次合并掉，用户得不到更新的数据，只得到更多流量。
 */
export const DELAY_PROBE_FULL_INTERVAL_MIN_MINUTES = 5

/**
 * 把用户填的间隔归一成可用值：非法输入回落到默认值，0 原样保留（关闭），
 * 其余按下限夹紧。UI 与主进程共用这一个函数，避免两边各写一份夹紧逻辑跑偏。
 */
export function normalizeDelayProbeIntervalMinutes(value: unknown): number {
  if (value === 0) return 0
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DELAY_PROBE_FULL_INTERVAL_MINUTES
  }
  const rounded = Math.floor(value)
  if (rounded <= 0) return 0
  return Math.max(DELAY_PROBE_FULL_INTERVAL_MIN_MINUTES, rounded)
}

/** GET /groups 不带 wait=1 时，数据超过这个年龄就在 meta 里标记为陈旧（毫秒） */
export const DELAY_PROBE_FRESH_MS = 5 * 60 * 1000

/**
 * 唯一的测速超时（毫秒）。基线、lazy refresh、名单探测全部共用这一个值。
 *
 * ⚠ 这里曾经是本项目最严重的一个 bug，改动前请读完这段。
 *
 * 旧代码按「压到略高于判定阈值即可 —— 慢于阈值的节点反正要被筛掉」来设（quick=1200），
 * 这个推理错在它假设 timeout 与上报的 delay 是同一个量纲。实际上
 * mihomo v1.19.29 的 GET /proxies/{name}/delay 是：
 *
 *   ctx, cancel := context.WithTimeout(ctx, timeout)   // timeout 盖住【整个操作】
 *   delay, err := proxy.URLTest(ctx, url, expectedStatus)
 *   if ctx.Err() != nil { → 504 }                      // 超时判定优先于错误判定
 *
 * 而 unified-delay: true（本项目模板默认，见 utils/template.ts）下 URLTest 的流程是
 * dial → TLS 握手 → HEAD#1 → HEAD#2，计时起点在 HEAD#2 之前被重置。
 * 于是【上报的 delay 只是最后一个 RTT，而 timeout 要盖住全部四步】。
 * 实测 墙钟/上报延迟 比值 p50=7.2、p90=16.9。
 *
 * 后果：timeout=1200 的真实语义不是「筛掉延迟 >1200ms 的节点」，而是
 * 「筛掉整链耗时 >1200ms 的节点」≈「RTT 超过 ~200ms 就出局」——
 * 一道比名义 600ms 阈值严 3 倍的暗门。指纹证据：@1200 能测出数值的节点
 * 上报延迟 p50=194 / p90=320 / max=450，永远产不出 450ms 以上的值。
 *
 * 分层抽样 97 个节点交叉验证（真实判据 = 切组后经本地端口拨测真实 https 站点）：
 *   timeout=1200 召回率 15.8%（97 个里 75 个是 504，只有 16 个是 503 真连不上）
 *   timeout=2500 召回率 57.9%
 *   timeout=5000 召回率 89.5%
 *
 * 放宽 timeout 不会放宽质量标准：上报数值本身与 timeout 无关（同节点 1200 vs 10000
 * 实测 320/312、188/176、208/229，差异只是节点抖动），放宽只是让节点有机会拿到数字。
 * @10000 测出数值的 36 个里 31 个 ≤600ms、22 个 ≤300ms。
 *
 * 所以正确姿势是【测量时给足 timeout，拿到数值后再按 maxDelay 过滤】。
 *
 * ⚠ 同样不要改成「由脚本传的 maxDelay 换算 timeout」，那会让这个 bug 换个形式复活：
 * 倍率本身不可靠（p50=7.2 / p90=16.9，另一批样本 p50 达 13，波动超过 2 倍），
 * 且耦合方向是错的 —— 脚本传 maxDelay=200 想要快节点，×8 换算出 timeout=1600，
 * 拿到的却是「整链能在 1600ms 内跑完的节点」，正是同一道暗门，只是由脚本亲手打开。
 */
export const DELAY_PROBE_TIMEOUT = 6000

/**
 * 天花板产物的判定余量（毫秒）：delay ≥ DELAY_PROBE_TIMEOUT − 这个值 即视为超时失败。
 *
 * 起因：504 会往内核 history 写一条【正数】延迟。URLTest 的 defer 里第二次 HEAD 的
 * 错误被 ignoredErr 吞掉 → err == nil → 记录 record.Delay = 全程耗时 ≈ timeout、
 * alive = true；但 API 层因 ctx.Err() != nil 返回 504，app 侧判为失败。两边结论相反。
 *
 * 实测（6420 条 history）：87 条 delay≈1200、63 条 delay≈3000，
 * 正数 delay 的 p90 恰好是 1201。这些假延迟一旦被当成真数据，
 * 在 maxDelay ≥ timeout 时就变成假阳性，把死节点报给脚本。
 * 所以必须在【写入 probeStore 时】归一成失败，而不是指望读取方过滤。
 */
export const DELAY_PROBE_CEILING_MARGIN_MS = 50

/**
 * 全量基线探测并发。
 *
 * 这个值有两个约束，必须同时满足：
 *
 * ### 约束一：探测自身的准确率（并发开太大会把健康节点打成 delay 0）
 *
 * ABABA 交替对照（全量 642 @timeout=6000，交错模式已排除时间趋势）：
 *   并发 200  → 17.7s，alive 172~206（均值 191.5）
 *   并发 300  → 12.2s，alive 146      （−15%）
 *   并发 400  → 12.3s，alive 156      （−9%，与 300 同为 2 波所以耗时相同）
 *   不限并发  →  6.4s，alive  80~130  （均值 103，−40%）
 * 档内波动（50/29）远小于档间差距（88.5），所以并发效应是真实的。
 *
 * 独立复现（566 个节点，3 轮 ABCABC）：alive 率 100→53.3% / 200→51.4% /
 * 300→46.2% / 400→44.1% / 不限(566)→29%。质变确实从 300 开始。
 *
 * ### 约束二：对用户正常上网的干扰（旧注释漏掉了这一维）
 *
 * 探测和用户流量共用同一个内核，所以要独立测量。方法：双通道哨兵
 * （mixed-port CONNECT 隧道 + TUN 直连各 100ms 固定节奏发起，不等上一个结束），
 * 所有指标对 idle 窗口归一化：
 *   并发 100 → 单轮 21.9s，哨兵 p90 1475/1730ms，哨兵失败率 0%
 *   并发 200 → 单轮 13.3s，哨兵 p90 1669/1919ms，哨兵失败率 0.26%/0.53%
 *   并发 300 → 单轮 12.3s，哨兵 p90 2438/5213ms，哨兵失败率 1.25%/0.31%
 *   不限并发 → 单轮  9.5s，哨兵 p90 7771/7516ms，哨兵失败率 4.4%/8.0%
 * ECONNRESET 在两条通道上同时出现，说明压力不只在机场出口，
 * 本机转发层（fd / conntrack / goroutine）也吃到了。
 *
 * ### 为什么取 100 而不是 200
 *
 * 100 在两个约束上同时更优：召回率略高（53.3% vs 51.4%）、干扰掉回 idle
 * 噪声以内。唯一代价是单轮 13s→22s，而基线是低频事件（默认 3 小时一轮）、
 * 没有任何人在等它，所以这个代价不构成权衡。
 *
 * ### 不要做的两件事
 *
 * - **不要加波间 sleep**（一波跑满后 sleep 再开下一波）。实测 gap=0/100/250/500ms
 *   的总伤害指标是 -4.4 / 10.2 / -1.2 / 36.4，无单调趋势、全在噪声量级。
 *   根因是它不降低真实峰值：每波开头照样 N 个并发同时拨号，只降了占空比。
 * - **不要靠加并发提速**。耗时严格等于「波数 × timeout」，只有离散档位，
 *   想更快只能减少要测的节点数。
 */
export const DELAY_PROBE_FULL_CONCURRENCY = 100

/** 启动后延迟多久跑第一次基线（毫秒），避开内核刚起来的忙碌期 */
export const DELAY_PROBE_STARTUP_DELAY_MS = 20 * 1000

/**
 * probeStore 记录的默认新鲜度门槛（毫秒）。
 *
 * POST /probe mode=delay 命中且未超龄就直接返回；超龄则阻塞现测一轮再返回
 * （不返回旧值，脚本拿到的永远是它要求的新鲜度内的数据）。
 * 脚本可传 maxAge=0 强制现测。
 *
 * 取 300 秒是流量与时效的折中：脚本每分钟查 100 个节点的稳态下，真实测速频率
 * 收敛到每 5 分钟一轮 ≈ 9.6 MB/小时 ≈ 6.9 GB/月，与旧版 30 分钟全量基线的
 * 7.06 GB/月 持平；代价是节点挂掉最多 5 分钟后才会被发现。
 */
export const PROBE_STORE_DEFAULT_MAX_AGE_MS = 300 * 1000

/**
 * 探测工位总数。工位只服务 POST /probe mode=ip，内核测速不占工位。
 *
 * 为什么 delay 走内核而 ip 用工位 —— 两者的资源性质根本不同，不是快慢之差：
 *
 * 内核测速走 acquireNamedProbeSlot 的跨请求信号量，是【弹性】资源：
 * 十个脚本同时压 400 个名字，结果是各自排队变慢，没有人拿到错误答案。
 *
 * 工位是【刚性】资源：PUT /proxies/{组} 改的是组的选中项，这是全局可见的副作用。
 * 两个请求争同一工位不是排队问题而是互相踩 —— A 切到节点 X，B 立刻切到 Y，
 * A 的拨测就从 Y 出网了，结果串味且无法察觉。
 * 堆工位数量不改变这个性质，只是把翻车阈值推高一点，所以配额机制是必需的。
 */
export const PROBE_STATION_COUNT = 100

/**
 * 单个 POST /probe mode=ip 请求最多同时占用多少工位。
 *
 * 语义是「同时最多占这么多」而不是预留：脚本 A 独占时占 50、池剩 50；
 * B 进来占 50、池剩 0；C 进来排队等归还。留一半给别人是刻意的 ——
 * 单请求配额等于池大小时，一个脚本就能把工位全占死。
 *
 * 工位是【逐个】归还的，不是攒到请求结束一起还，这样后来的脚本能在前一个
 * 还在跑的时候就拿到工位。
 */
export const PROBE_STATION_PER_REQUEST_QUOTA = 50

/**
 * 探测工位端口的【搜索起始位】，不是死的占用区间。
 *
 * 语义变更的原因（踩过的坑）：这个值原来是死基址，工位端口写成 BASE + index，
 * 注入侧和拨测侧各算一遍。实机上用户在界面里配了一批业务出口
 * `port: 17900, count: 100`，与旧基址 100 个端口全撞，于是 100 个工位【全部被跳过】，
 * mode=ip 直接不可用，而 app 照常启动、只在日志里留一行 ERROR。
 *
 * 为什么不能借用业务出口当工位：拨测要改组的选中项，这是全局副作用。
 * 借用业务组会与用户脚本互相踩（脚本刚切到 X，拨测把它切到 Y，业务流量静默走错节点），
 * 反向也一样且【无法察觉】。所以工位必须专用，端口也必须与业务出口互斥。
 *
 * 改为搜索起始位后，注入时从这里往后找第一段【连续空闲】的 PROBE_STATION_COUNT 个端口，
 * 实际端口由注入结果决定，拨测侧读内核实际加载的配置、不再自行推算。
 * 这样用户以后在任意区间加出口都会自动让位。
 *
 * 取 18100 而不是继续用 17900：给用户现有的 17900~17999 让出整段，
 * 且与 scriptApi 默认端口 17890 保持距离。
 */
export const PROBE_STATION_PORT_BASE = 18100

/**
 * 工位端口搜索上限（不含）。找不到连续窗口时明确失败，不做无边界扫描。
 *
 * 取 49152 是 Windows 动态端口范围的下界
 * （netsh int ipv4 show dynamicport tcp 默认 49152~65535）：
 * 工位端口落在动态范围里会与系统临时端口偶发争用，表现为工位时好时坏。
 */
export const PROBE_STATION_PORT_SEARCH_END = 49152

export const PROBE_STATION_LISTENER_PREFIX = 'party-probe-'

export const PROBE_STATION_GROUP_PREFIX = 'PARTY-PROBE-'

/**
 * 同一工位连续多少次「全部目标 dial_failed」就摘除它并重新预检。
 *
 * dial_failed 的含义是【连本地工位端口都连不上】，与远端节点无关，
 * 所以它聚集在同一个工位上只可能是工位自己坏了。这个判据很硬，不会误伤节点。
 *
 * 这条熔断不是防御性编程，是踩过的坑：实测中 9 个不存在的端口以 0~18ms 的速度
 * 疯狂抢任务，把 100 个节点里 64 个健康的全判成 dial_failed。
 * 抢占式队列 + 坏工位会自我放大 —— 失败得越快，抢到的任务就越多。
 */
export const PROBE_STATION_DIAL_FAIL_THRESHOLD = 5

/**
 * mode=ip 每个拨测目标的超时（毫秒）。
 *
 * 有实测依据，不要再往下压：cf-trace 成功项的 totalMs
 * p50=1043~1059 / p75=1294~1329 / p90=1502~1680 / max=2392~2406，
 * max 始终低于 2500，所以这个值几乎不截断成功项；
 * 压到 1641 以下会砍掉 7~11 个本来能成功的节点。
 *
 * 也不要往上放：吞吐瓶颈在失败项。100 个节点 / 17 工位 / timeout=5000 时，
 * 20 个失败节点吃掉 20×5.0s = 100s，占总工作量的 52%。
 */
export const PROBE_IP_TARGET_TIMEOUT_MS = 2500

/**
 * 工位租约硬上限（毫秒），超过就由巡检强制回收。
 *
 * finally 释放挡不住所有异常路径，而工位泄漏是【不可恢复】的 ——
 * 池子只会单向变小直到全部卡死。所以必须有这道与业务逻辑无关的兜底。
 */
export const PROBE_IP_LEASE_HARD_LIMIT_MS = 3000

/** mode=ip 单次请求最多接受多少个节点名（与工位配额对齐，一波打完） */
export const PROBE_IP_MAX_NAMES = 50

/**
 * mode=ip 的拨测目标：三个并行，第一个拿到合法 IP 就掐断其余两个。
 *
 * 为什么要三个而不是一个：三者各自成功率几乎相同（实测 79/77/80 与 86/85/88），
 * 但【失败集合不同】。两轮实测里 cf-trace 失败的节点分别有 9 个和 5 个被
 * 另外两个目标救回，并集召回 88/100 与 91/100。被救回的全部是 cf=timeout，
 * 集中在特定机场的 SSR/HTTP 与 VMESS 节点上。
 *
 * 为什么并行而不是串行：三目标串行全打 28.4s / 槽位均值 4192ms，
 * 并行取最快 10.6s / 槽位均值 1595ms —— 快 2.7 倍，并集召回还略高（91 vs 88）。
 *
 * cf-trace 放第一个是因为它是唯一能给出 loc（地区）的目标。
 */
export const PROBE_IP_TARGETS = [
  'https://www.cloudflare.com/cdn-cgi/trace',
  'https://api.ipify.org/',
  'https://icanhazip.com/'
] as const

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
