/**
 * CF 盾探测器：批量测出「能过 Cloudflare 挑战」的节点。
 *
 * 原理：借用「脚本专用出口 + 脚本控制 API」。50 条出口（7800~7849）各绑一个
 * `出口能用01~50` 组，一轮把 50 个待测节点分别 PUT 进这 50 个组，然后 50 路并发
 * 走各自端口去请求 CF 保护的站点，看返回是 200 还是挑战/拦截。403+cloudflare、
 * cf-mitigated 头、"Just a moment" 挑战页都算没过盾。
 *
 * 用法（PowerShell，仓库根目录）：
 *   node scripts/cf-shield-probe.mjs
 *   node scripts/cf-shield-probe.mjs --group "[能用]" --max-delay 800 --require majority
 *   node scripts/cf-shield-probe.mjs --targets https://claude.ai/,https://discord.com/
 *   node scripts/cf-shield-probe.mjs --limit 60          # 只测前 60 个（按延迟升序）
 *   node scripts/cf-shield-probe.mjs --outlet-prefix 过盾  # 只用备注 过盾01/过盾02… 的出口当工位
 *
 * 参数不必都写在命令行上：脚本会读自己的配置文件（默认找 <仓库根>/cf-shield.config.json，
 * 其次 <仓库根>/scripts/cf-shield.config.json，也可 --settings <path> 指定）。
 * 取值优先级 = 命令行 > 配置文件 > 内置默认。配置文件是可选的，没有就用内置默认值。
 *
 * 每日自动更新「过盾」组（pm2 调度，见 ecosystem.cf-shield.config.cjs）：
 *   node scripts/cf-shield-probe.mjs --targets "https://nowsecure.nl/,https://discord.com/" --require all --apply
 *   加上 --apply 后会把通过名单写进覆写脚本的 CF-SHIELD-AUTO 区块，再调 POST /reload
 *   让内核热重载，「过盾」组的成员就真的换成今天实测能过的那批。
 *
 * 注意：
 * - 需要 Clash Party 正在运行，且「脚本专用出口」已应用、「脚本控制 API」已启用。
 * - 测的是「IP 声誉」，不是「客户端指纹」。靶标必须是「干净 IP 用 curl 就能 200」的站点，
 *   chatgpt.com 这类还要校验 TLS 指纹的站点会全员 403，不能拿来当靶标。
 * - 切换出口组时统一带 `?close=0`，不触发内核全局断连，所以探测期间你的浏览器不会被掐断。
 *   （--apply 最后那次热重载仍会重建 adapter，进行中的连接会断一次，这是无法避免的。）
 * - 默认会按**出口 IP** 去重：机场常把一个 IP 拆成十几个「节点」卖，同 IP 只保留延迟
 *   最低的那个。想看全量就加 `--dedupe-ip false`，输出的 yaml 里也留了 [过盾-全部] 组。
 * - 结果写到 .snow/cf/ 下（gitignored）。
 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import yaml from 'js-yaml'
import axios from 'axios'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { HttpProxyAgent } from 'http-proxy-agent'

// ---------------------------------------------------------------- CLI 参数

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i++) {
    const item = argv[i]
    if (!item.startsWith('--')) continue
    const key = item.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) {
      args[key] = 'true'
    } else {
      args[key] = next
      i++
    }
  }
  return args
}

const args = parseArgs(process.argv.slice(2))

const REPO_ROOT = path.resolve(import.meta.dirname, '..')
const DEFAULT_CONFIG_CANDIDATES = [
  path.join(REPO_ROOT, 'dist', 'win-unpacked', 'data', 'config.yaml'),
  path.join(process.env.APPDATA ?? '', 'clash-party', 'config.yaml'),
  path.join(process.env.APPDATA ?? '', 'mihomo-party', 'config.yaml')
]

/**
 * 探测器自己的配置文件（不是 Clash Party 的 config.yaml）。
 * 没有就用内置默认值，所以这个文件是可选的。
 */
const DEFAULT_SETTINGS_CANDIDATES = [
  path.join(REPO_ROOT, 'cf-shield.config.json'),
  path.join(REPO_ROOT, 'scripts', 'cf-shield.config.json')
]

/**
 * 默认探测目标：都在 Cloudflare 后面，且会对机房 IP 上挑战。
 *
 * ⚠ 别把 chatgpt.com 放进来。它除了看 IP 还校验 TLS/HTTP2 指纹，Node 的 axios
 * 无论走哪个节点都是 403（已用干净的日常代理验证过），会把所有节点误判成不能过盾。
 * 同理，任何「必须真浏览器才能过」的站点都不适合当靶标 —— 这个脚本测的是
 * 「IP 声誉」，不是「客户端指纹」。真要测 chatgpt 得用 puppeteer 跑真浏览器。
 */
const DEFAULT_TARGETS = ['https://nowsecure.nl/', 'https://claude.ai/', 'https://discord.com/']

/**
 * 读配置文件。`--settings <path>` 显式指定，否则按 DEFAULT_SETTINGS_CANDIDATES 探测。
 *
 * 两种失败区别对待：显式指定的路径不存在 / JSON 语法错 → 直接退出（配置写错了却静默
 * 用默认值跑，最后名单不对还很难查）；没显式指定又一个候选都没有 → 正常，用内置默认。
 */
function loadSettings() {
  const explicit = args.settings ? path.resolve(REPO_ROOT, args.settings) : null
  for (const file of explicit ? [explicit] : DEFAULT_SETTINGS_CANDIDATES) {
    if (!fs.existsSync(file)) continue
    let parsed
    try {
      // 剥 BOM：Windows 上记事本 / PowerShell 的 Set-Content -Encoding UTF8 都会写 BOM，
      // JSON.parse 见到 \uFEFF 直接抛错，报「不是合法 JSON」会把人往错方向带。
      parsed = JSON.parse(fs.readFileSync(file, 'utf-8').replace(/^\uFEFF/, ''))
    } catch (e) {
      console.error(`配置文件解析失败（不是合法 JSON）：${file}\n${e.message}`)
      process.exit(1)
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      console.error(`配置文件顶层必须是一个对象：${file}`)
      process.exit(1)
    }
    return { file, data: parsed }
  }
  if (explicit) {
    console.error(`--settings 指定的配置文件不存在：${explicit}`)
    process.exit(1)
  }
  return { file: null, data: {} }
}

const SETTINGS = loadSettings()

/** 取值优先级统一为：命令行 > 配置文件 > 内置默认 */
function pickRaw(cliKey, fileKey) {
  if (args[cliKey] !== undefined) return args[cliKey]
  const value = SETTINGS.data[fileKey]
  return value === null ? undefined : value
}

function pickString(cliKey, fileKey, fallback) {
  const raw = pickRaw(cliKey, fileKey)
  return raw === undefined || raw === '' ? fallback : String(raw)
}

function pickNumber(cliKey, fileKey, fallback) {
  const raw = pickRaw(cliKey, fileKey)
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  return Number.isFinite(value) ? value : fallback
}

/** 布尔项：命令行里「出现即为真」，只有显式写 false 才关；配置文件里可直接写 true/false */
function pickBool(cliKey, fileKey, fallback) {
  if (args[cliKey] !== undefined) return args[cliKey] !== 'false'
  const value = SETTINGS.data[fileKey]
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') return value !== 'false'
  return fallback
}

/** 靶标：命令行是逗号分隔字符串，配置文件里可以直接写数组 */
function pickTargets() {
  const raw = pickRaw('targets', 'targets')
  if (raw === undefined || raw === '') return DEFAULT_TARGETS
  const list = Array.isArray(raw) ? raw : String(raw).split(',')
  const cleaned = list.map((item) => String(item).trim()).filter(Boolean)
  return cleaned.length > 0 ? cleaned : DEFAULT_TARGETS
}

const OPTIONS = {
  configPath:
    pickString('config', 'config', undefined) ??
    DEFAULT_CONFIG_CANDIDATES.find((item) => item && fs.existsSync(item)),
  group: pickString('group', 'group', '[能用]'),
  maxDelay: pickString('max-delay', 'maxDelay', 'auto'),
  limit: pickNumber('limit', 'limit', 0),
  timeout: pickNumber('timeout', 'timeout', 15000),
  // all = 所有目标都过才算过；majority = 过半；any = 过一个就算
  require: pickString('require', 'require', 'all'),
  // require=all 时遇到第一个失败就跳过剩余目标（快但拿不到逐目标明细）
  fast: pickBool('fast', 'fast', false),
  // 连接层错误的重试次数（不含首次）。CF 的挑战/403 是确定结论，不重试
  retry: pickNumber('retry', 'retry', 1),
  targets: pickTargets(),
  restore: pickBool('restore', 'restore', true),
  // 只用备注以此开头的出口当「工位」。比如配了 `过盾`，就只挑 过盾01 / 过盾02 / …
  // 留空（默认）= 用全部可用出口。用途：把出口池按用途分区，几个脚本各占一批互不抢。
  outletPrefix: pickString('outlet-prefix', 'outletPrefix', '').trim(),
  // 同一出口 IP 只保留延迟最低的那个节点。机场常把一个 IP 拆成十几个「节点」卖，
  // 全塞进「过盾」组只会让手选列表变长，容灾能力一点没涨（那台机器一挂全挂）。
  dedupeIp: pickBool('dedupe-ip', 'dedupeIp', true),
  // 回显出口 IP 的地址。要求：轻量、不被 CF 拦、响应里能直接找到 IP 字面量。
  // ipify 返回裸 IP，cloudflare 的 /cdn-cgi/trace 返回 `ip=1.2.3.4` 这类 kv 文本，
  // 两种都能用 —— 解析时按正则抠 IP，不假设响应格式。
  ipUrl: pickString('ip-url', 'ipUrl', 'https://api.ipify.org/'),
  // 把通过名单写回覆写脚本的 CF-SHIELD-AUTO 区块，并热重载内核让「过盾」组真的换人
  apply: pickBool('apply', 'apply', false),
  // --apply 时至少要有这么多个通过节点才肯写入。防止某次网络抽风只剩 1 个就
  // 把「过盾」组缩成孤零零一个节点；不达标就保留上一次的名单原样不动。
  minApply: pickNumber('min-apply', 'minApply', 3),
  outDir: path.resolve(REPO_ROOT, pickString('out', 'out', path.join(REPO_ROOT, '.snow', 'cf')))
}

// ------------------------------------------------- 写回覆写脚本（--apply）

const AUTO_BEGIN = '// ===== CF-SHIELD-AUTO-BEGIN'
const AUTO_END = '// ===== CF-SHIELD-AUTO-END ====='

/**
 * 找出带 CF-SHIELD-AUTO 标记区块的覆写脚本。
 *
 * 不硬编码文件名：override 目录用哈希 id 命名（如 1a00025c664.js），换一台机器或
 * 重建覆写就变了。所以扫整个 override 目录、按标记内容认领，找不到就明确报错。
 */
function findShieldOverride() {
  const dataDir = path.dirname(OPTIONS.configPath)
  const overrideDir = path.join(dataDir, 'override')
  if (!fs.existsSync(overrideDir)) return null
  for (const name of fs.readdirSync(overrideDir)) {
    if (!name.endsWith('.js')) continue
    const file = path.join(overrideDir, name)
    const text = fs.readFileSync(file, 'utf-8')
    if (text.includes(AUTO_BEGIN) && text.includes(AUTO_END)) return { file, text }
  }
  return null
}

/**
 * 把名单写进 CF-SHIELD-AUTO 区块。
 *
 * 只整体替换标记之间的内容，标记行本身保留，其余代码一个字节都不碰 ——
 * 用户在 SHIELD_NODES_MANUAL 和其他参数上的手工改动不会被覆盖。
 * 换行统一成 CRLF：这个文件历史上就是 CRLF，混合换行符会让后续 diff 一片红。
 */
function applyShieldList(nodes) {
  const found = findShieldOverride()
  if (!found) {
    console.error(
      `未找到带 ${AUTO_BEGIN} 标记的覆写脚本。请先在覆写里加上该标记区块，参见 docs 说明。`
    )
    return false
  }

  const begin = found.text.indexOf(AUTO_BEGIN)
  const endMarker = found.text.indexOf(AUTO_END)
  if (begin < 0 || endMarker < 0 || endMarker < begin) {
    console.error('CF-SHIELD-AUTO 标记不成对，拒绝写入')
    return false
  }
  const beginLineEnd = found.text.indexOf('\n', begin)

  const body = [
    'const SHIELD_NODES_AUTO = [',
    ...nodes.map((name) => `  ${JSON.stringify(name)},`),
    ']',
    `// 自动更新于 ${new Date().toISOString()}`,
    `// 靶标 ${OPTIONS.targets.join(' ')}  判定=${OPTIONS.require}`,
    `// 保留 ${nodes.length} 个${OPTIONS.dedupeIp ? '（已按出口 IP 去重，同一 IP 只留延迟最低的那个）' : ''}`
  ].join('\n')

  const next = `${found.text.slice(0, beginLineEnd + 1)}${body}\n${found.text.slice(endMarker)}`
    .replace(/\r\n/g, '\n')
    .replace(/\n/g, '\r\n')

  fs.writeFileSync(found.file, next, 'utf-8')
  console.log(`   已写入   ${found.file}`)
  return true
}

// ---------------------------------------------------------------- 主流程

if (!OPTIONS.configPath || !fs.existsSync(OPTIONS.configPath)) {
  console.error(
    `找不到 config.yaml，请用 --config 指定。已尝试：\n${DEFAULT_CONFIG_CANDIDATES.join('\n')}`
  )
  process.exit(1)
}

const appConfig = yaml.load(fs.readFileSync(OPTIONS.configPath, 'utf-8')) ?? {}
const scriptApi = appConfig.scriptApi ?? {}
if (!scriptApi.enable) console.warn('⚠ config.yaml 里 scriptApi.enable 不是 true，接口可能没在跑')
if (!scriptApi.token) {
  console.error('scriptApi.token 为空，脚本控制 API 不会启动，请先在「脚本专用出口」页面生成令牌')
  process.exit(1)
}

const API_BASE = `http://127.0.0.1:${scriptApi.port ?? 17890}`
const API_HEADERS = { Authorization: `Bearer ${scriptApi.token}` }

/**
 * 备注补零宽度。⚠ 必须与 src/shared/scriptOutlet.ts 的 outletSequenceWidth 保持一致：
 * 至少两位（出口01），个数超过 99 时自动加宽。那边改了这里也要跟着改，
 * 否则 --outlet-prefix 会静默匹配不到任何出口。
 */
function outletSequenceWidth(count) {
  return Math.max(2, String(Math.max(1, Math.floor(count))).length)
}

/** 展开批量出口卡片 → [{ port, group, remark }]（与 src/shared/scriptOutlet.ts 的规则一致） */
function expandOutlets(outlets) {
  const list = []
  for (const outlet of outlets ?? []) {
    if (!outlet?.enable) continue
    // 上限 200 与 SCRIPT_OUTLET_MAX_BATCH_COUNT 对齐
    const count = Number.isFinite(outlet.count)
      ? Math.min(200, Math.max(1, Math.floor(outlet.count)))
      : 1
    const prefix = String(outlet.remark ?? '').trim()
    if (count <= 1) {
      if (outlet.mode === 'direct' && outlet.target)
        list.push({ port: outlet.port, group: outlet.target, remark: prefix })
      continue
    }
    const targets = (outlet.batchTargets ?? []).map((item) => String(item).trim())
    const width = outletSequenceWidth(count)
    for (let i = 0; i < count; i++) {
      if (outlet.mode !== 'direct' || !targets[i]) continue
      const sequence = String(i + 1).padStart(width, '0')
      list.push({
        port: outlet.port + i,
        group: targets[i],
        remark: prefix ? `${prefix}${sequence}` : sequence
      })
    }
  }
  return list
}

const ALL_OUTLETS = expandOutlets(appConfig.scriptOutlets)
if (ALL_OUTLETS.length === 0) {
  console.error('没有可用的 direct 模式出口（需要「出口目标」绑定到具体策略组）')
  process.exit(1)
}

// 按备注前缀挑工位。命中 0 条时直接报错退出，不回落全部出口 ——
// 静默回落会让脚本跑到别的分区上去抢工位，比明确失败更难查。
const OUTLETS = OPTIONS.outletPrefix
  ? ALL_OUTLETS.filter((item) => item.remark.startsWith(OPTIONS.outletPrefix))
  : ALL_OUTLETS
if (OUTLETS.length === 0) {
  console.error(
    `出口备注前缀「${OPTIONS.outletPrefix}」没有匹配到任何出口。` +
      `当前可用出口备注：${ALL_OUTLETS.map((item) => item.remark || '(空)').join(' ')}`
  )
  process.exit(1)
}

// ---------------------------------------------------------------- API 封装

const api = axios.create({ baseURL: API_BASE, headers: API_HEADERS, timeout: 60000 })

async function apiGet(url) {
  const res = await api.get(url)
  return res.data
}

/**
 * 切换出口组的选中节点。
 *
 * 固定带 `close=0`：默认行为（autoCloseConnection）会在每次切换后断开内核**全部**
 * 连接，而一轮探测要切几百次，用户的浏览器/下载会被反复掐断。探测走的是独立出口
 * 端口，新建连接自然用新节点，不需要清场。
 */
async function switchGroup(group, proxyName) {
  await api.put(`/groups/${encodeURIComponent(group)}?close=0`, { name: proxyName })
}

/** 触发主进程重新生成配置并热重载内核（改组成员唯一的生效途径） */
async function reloadCore() {
  await api.post('/reload', undefined, { timeout: 120000 })
}

/**
 * 预热延迟测试。
 *
 * 内核刚启动时谁都没测过延迟，带 maxDelay 过滤去取组成员会拿到空数组。
 * 交互使用时直接报错让人自己重试还行，但每日定时任务是无人值守的，
 * 必须自己预热一轮再取，否则夜里那次跑必然空转。
 */
async function warmupProbe() {
  await api.post('/probe', undefined, { timeout: 180000 })
}

// ---------------------------------------------------------------- CF 判定

const CHALLENGE_PATTERNS = [
  /just a moment/i,
  /enable javascript and cookies/i,
  /challenge-platform/i,
  /cf_chl_opt/i,
  /cf-chl/i,
  /attention required/i,
  /checking if the site connection is secure/i,
  /verify you are human/i
]

const httpAgentCache = new Map()
function agentsFor(port) {
  if (!httpAgentCache.has(port)) {
    const proxy = `http://127.0.0.1:${port}`
    httpAgentCache.set(port, {
      httpAgent: new HttpProxyAgent(proxy),
      httpsAgent: new HttpsProxyAgent(proxy)
    })
  }
  return httpAgentCache.get(port)
}

/** 返回 { verdict: 'pass'|'challenge'|'blocked'|'error', detail } */
async function probeTarget(port, url) {
  const { httpAgent, httpsAgent } = agentsFor(port)
  try {
    const res = await axios.get(url, {
      httpAgent,
      httpsAgent,
      proxy: false,
      timeout: OPTIONS.timeout,
      maxRedirects: 3,
      responseType: 'text',
      transformResponse: (data) => data,
      validateStatus: () => true,
      // 有些站点对默认 UA 直接上挑战，用常见浏览器 UA 才测得出「IP 本身干不干净」
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    })

    const status = res.status
    const headers = res.headers ?? {}
    const body = typeof res.data === 'string' ? res.data.slice(0, 4000) : ''
    const mitigated = headers['cf-mitigated']
    const challenged = CHALLENGE_PATTERNS.some((re) => re.test(body))

    if (mitigated) return { verdict: 'challenge', detail: `cf-mitigated=${mitigated}` }
    if (status === 403) return { verdict: 'blocked', detail: `403 ${headers.server ?? ''}`.trim() }
    if ((status === 503 || status === 429) && challenged)
      return { verdict: 'challenge', detail: `${status} challenge` }
    if (challenged) return { verdict: 'challenge', detail: `${status} challenge page` }
    if (status >= 200 && status < 400) return { verdict: 'pass', detail: String(status) }
    return { verdict: 'blocked', detail: `HTTP ${status}` }
  } catch (e) {
    const code = e.code ?? e.message ?? 'unknown'
    return { verdict: 'error', detail: String(code).slice(0, 80) }
  }
}

// ------------------------------------------------------------ 出口 IP 识别

// 从任意响应体里抠出第一个 IP 字面量。ipify 返回裸 IP，cloudflare 的
// /cdn-cgi/trace 返回 `ip=1.2.3.4` 这类 kv 文本，ip-api 返回 JSON ——
// 与其为每种端点写一套解析，不如统一按正则找，换 --ip-url 时不用改代码。
const IPV4_PATTERN = /\b\d{1,3}(?:\.\d{1,3}){3}\b/
const IPV6_PATTERN = /\b(?:[0-9a-f]{1,4}:){2,7}[0-9a-f]{1,4}\b/i

async function fetchExitIp(port) {
  const { httpAgent, httpsAgent } = agentsFor(port)
  try {
    const res = await axios.get(OPTIONS.ipUrl, {
      httpAgent,
      httpsAgent,
      proxy: false,
      timeout: OPTIONS.timeout,
      maxRedirects: 2,
      responseType: 'text',
      transformResponse: (data) => data,
      validateStatus: () => true
    })
    const text = typeof res.data === 'string' ? res.data : JSON.stringify(res.data ?? '')
    const matched = text.match(IPV4_PATTERN) ?? text.match(IPV6_PATTERN)
    return matched ? matched[0] : null
  } catch {
    return null
  }
}

/**
 * 查出口 IP，失败按 --retry 重试。
 *
 * 拿不到就返回 null，调用方要把这种节点当「IP 未知」保留 —— 查询失败通常只是
 * 回显端点抖了一下，因为查不到就把节点丢掉属于误杀。
 */
async function resolveExitIp(port) {
  for (let attempt = 0; attempt <= OPTIONS.retry; attempt++) {
    const ip = await fetchExitIp(port)
    if (ip) return ip
  }
  return null
}

/**
 * 同一出口 IP 只保留一个节点。
 *
 * 机场经常把一台机器的一个 IP 拆成十几个「节点」卖（不同端口/不同协议/不同名字），
 * 全塞进「过盾」组只会让手选列表变长，容灾能力一点没涨 —— 那台机器一挂全挂。
 *
 * 入参必须已按延迟升序，这样每个 IP 首次出现的那个就是最快的，直接留它。
 * IP 未知（查询失败）的节点一律保留，理由见 resolveExitIp。
 */
function dedupeByExitIp(list) {
  const kept = []
  const dropped = []
  const firstByIp = new Map()
  for (const item of list) {
    if (!item.ip) {
      kept.push(item)
      continue
    }
    const first = firstByIp.get(item.ip)
    if (first) {
      dropped.push({ ...item, duplicateOf: first.name })
      continue
    }
    firstByIp.set(item.ip, item)
    kept.push(item)
  }
  return { kept, dropped, uniqueIps: firstByIp.size }
}

async function probeNode(port) {
  const results = []
  for (const url of OPTIONS.targets) {
    let item = await probeTarget(port, url)
    // 连接层错误（ECONNRESET / 超时）重试一次：机房节点抖一下很常见，
    // 一次 reset 就判「不能过盾」会误杀。CF 的挑战/403 是确定性结论，不重试。
    for (let attempt = 0; attempt < OPTIONS.retry && item.verdict === 'error'; attempt++) {
      item = await probeTarget(port, url)
    }
    results.push({ url, ...item })
    // --fast 才提前收工。默认把每个目标都测完：不同站点的 CF 策略强度差很多，
    // 「过了 discord 但被 claude 拦」是常态，逐目标的结果比一个布尔值有用得多。
    if (OPTIONS.fast && OPTIONS.require === 'all' && item.verdict !== 'pass') break
  }
  const passed = results.filter((item) => item.verdict === 'pass').length
  const ok =
    OPTIONS.require === 'any'
      ? passed > 0
      : OPTIONS.require === 'majority'
        ? passed * 2 > OPTIONS.targets.length
        : passed === OPTIONS.targets.length

  // 只给通过的节点查 IP：没过盾的节点后面根本不会进名单，多这一次请求纯浪费时间。
  // 复用同一个出口端口，所以查到的就是这个节点真实的出口 IP。
  const ip = ok && OPTIONS.dedupeIp ? await resolveExitIp(port) : null
  return { ok, passed, results, ip }
}

// ---------------------------------------------------------------- 主流程

function fmt(node, width = 46) {
  const text = node.length > width ? `${node.slice(0, width - 1)}…` : node
  return text.padEnd(width, ' ')
}

async function main() {
  await apiGet('/ping')

  const delayQuery = OPTIONS.maxDelay ? `?maxDelay=${encodeURIComponent(OPTIONS.maxDelay)}` : ''
  const groupPath = `/groups/${encodeURIComponent(OPTIONS.group)}${delayQuery}`
  let groupInfo = await apiGet(groupPath)

  // 名单为空一般是内核刚起来还没测过延迟，maxDelay 把所有节点都滤掉了。
  // 自己预热一轮再取，别指望有人在旁边看着重试（每日定时任务是无人值守的）。
  if ((groupInfo.proxies ?? []).length === 0) {
    console.log('待测名单为空，先 POST /probe 预热延迟测试……')
    try {
      await warmupProbe()
    } catch (e) {
      console.warn(`   预热请求失败：${e.response?.data?.message ?? e.message}`)
    }
    groupInfo = await apiGet(groupPath)
  }

  const delayMap = new Map((groupInfo.details ?? []).map((item) => [item.name, item.delay]))
  let nodes = groupInfo.proxies ?? []
  if (OPTIONS.limit > 0) nodes = nodes.slice(0, OPTIONS.limit)

  console.log(`配置文件   ${OPTIONS.configPath}`)
  console.log(`参数配置   ${SETTINGS.file ?? '(未找到，用内置默认值)'}`)
  console.log(`控制 API   ${API_BASE}`)
  console.log(
    `来源组     ${OPTIONS.group}  可用 ${groupInfo.usable ?? nodes.length} / 共 ${groupInfo.total ?? '?'}`
  )
  console.log(`探测目标   ${OPTIONS.targets.join('  ')}   判定=${OPTIONS.require}`)
  console.log(
    `并发出口   ${OUTLETS.length} 条（端口 ${OUTLETS[0].port}~${OUTLETS[OUTLETS.length - 1].port}）` +
      (OPTIONS.outletPrefix
        ? `  按备注前缀「${OPTIONS.outletPrefix}」筛出，共 ${ALL_OUTLETS.length} 条可用`
        : '  未设前缀，用全部出口')
  )
  console.log(`待测节点   ${nodes.length} 个，共 ${Math.ceil(nodes.length / OUTLETS.length)} 轮\n`)

  if (nodes.length === 0) {
    console.error('待测名单为空。可能是刚启动还没测过延迟，先 POST /probe 预热再重试。')
    process.exit(1)
  }

  // 记录各组原本选中的节点，结束后还原，避免探测把你的出口组留在随机节点上
  const original = new Map()
  if (OPTIONS.restore) {
    for (const outlet of OUTLETS) {
      try {
        const info = await apiGet(`/groups/${encodeURIComponent(outlet.group)}`)
        original.set(outlet.group, info.now)
      } catch {
        /* 组不存在就跳过 */
      }
    }
  }

  const passList = []
  const failList = []
  const startedAt = Date.now()

  for (let offset = 0; offset < nodes.length; offset += OUTLETS.length) {
    const batch = nodes.slice(offset, offset + OUTLETS.length)
    const round = Math.floor(offset / OUTLETS.length) + 1
    console.log(`── 第 ${round} 轮：${batch.length} 个节点 ────────────────────────`)

    // 先把节点逐个绑到各自出口组（PUT 必须串行，避免内核批量断连时互相打架）
    const assigned = []
    for (let i = 0; i < batch.length; i++) {
      const outlet = OUTLETS[i]
      try {
        await switchGroup(outlet.group, batch[i])
        assigned.push({ node: batch[i], port: outlet.port, group: outlet.group })
      } catch (e) {
        const msg = e.response?.data?.message ?? e.message
        console.log(`   跳过 ${fmt(batch[i])} 切换失败: ${msg}`)
      }
    }

    // 再并发测；每条出口只测自己那一个节点，互不影响
    const probed = await Promise.all(
      assigned.map(async (item) => ({ ...item, ...(await probeNode(item.port)) }))
    )

    for (const item of probed) {
      const delay = delayMap.get(item.node)
      const record = {
        name: item.node,
        delay: delay ?? null,
        ip: item.ip ?? null,
        passed: item.passed,
        results: item.results
      }
      if (item.ok) {
        passList.push(record)
        const tail = [delay ? `${delay}ms` : '', item.ip ? `ip=${item.ip}` : ''].join(' ').trim()
        console.log(`   ✅ ${fmt(item.node)} ${tail}`)
      } else {
        failList.push(record)
        const why = item.results.map((r) => `${new URL(r.url).host}:${r.verdict}`).join(' ')
        console.log(`   ❌ ${fmt(item.node)} ${why}`)
      }
    }
    console.log('')
  }

  if (OPTIONS.restore) {
    for (const [group, now] of original) {
      if (!now) continue
      try {
        await switchGroup(group, now)
      } catch {
        /* 还原失败不影响结果 */
      }
    }
  }

  passList.sort((a, b) => (a.delay ?? 9999) - (b.delay ?? 9999))

  // 按出口 IP 去重（必须在排序之后：靠「已按延迟升序」这个前提留下最快的那个）。
  // finalList 才是真正写进「过盾」组的名单，passList 保留全量用于诊断输出。
  const dedupe = OPTIONS.dedupeIp
    ? dedupeByExitIp(passList)
    : { kept: passList, dropped: [], uniqueIps: 0 }
  const finalList = dedupe.kept
  const unknownIpCount = OPTIONS.dedupeIp ? finalList.filter((item) => !item.ip).length : 0

  // 逐目标统计：同一个 IP 在不同站点的 CF 策略下结果差别很大，
  // 汇总成 per-target 名单比单一「过/不过」实用（想过 chatgpt 就取 chatgpt 那份）
  const allProbed = [...passList, ...failList]
  const perTarget = OPTIONS.targets.map((url) => {
    const host = new URL(url).host
    const okNodes = allProbed
      .filter((node) => node.results.some((item) => item.url === url && item.verdict === 'pass'))
      .sort((a, b) => (a.delay ?? 9999) - (b.delay ?? 9999))
    return { url, host, passed: okNodes.length, proxies: okNodes.map((node) => node.name) }
  })

  fs.mkdirSync(OPTIONS.outDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const jsonPath = path.join(OPTIONS.outDir, `cf-probe-${stamp}.json`)
  const yamlPath = path.join(OPTIONS.outDir, `cf-probe-${stamp}.yaml`)

  fs.writeFileSync(
    jsonPath,
    JSON.stringify(
      {
        probedAt: new Date().toISOString(),
        group: OPTIONS.group,
        targets: OPTIONS.targets,
        require: OPTIONS.require,
        total: allProbed.length,
        passed: passList.length,
        // 去重后真正写进「过盾」组的数量。passed 是「能过盾」的总数，
        // final 是「能过盾且出口 IP 互不相同」的数量，两者差多少就是同 IP 的冗余节点。
        final: finalList.length,
        dedupe: {
          enabled: OPTIONS.dedupeIp,
          ipUrl: OPTIONS.ipUrl,
          uniqueIps: dedupe.uniqueIps,
          unknownIp: unknownIpCount,
          dropped: dedupe.dropped.map(({ name, ip, delay, duplicateOf }) => ({
            name,
            ip,
            delay,
            duplicateOf
          }))
        },
        perTarget: perTarget.map(({ host, passed, proxies }) => ({ host, passed, proxies })),
        finalProxies: finalList.map((item) => item.name),
        pass: passList,
        fail: failList
      },
      null,
      2
    ),
    'utf-8'
  )

  fs.writeFileSync(
    yamlPath,
    yaml.dump(
      {
        'proxy-groups': [
          {
            // 去重后的名单：同一出口 IP 只留延迟最低的那个，也是 --apply 写进覆写脚本的那份
            name: '[过盾]',
            type: 'select',
            proxies: finalList.map((item) => item.name)
          },
          // 去重前的全量留一份，方便对比「到底被合并掉了多少」
          ...(OPTIONS.dedupeIp && dedupe.dropped.length
            ? [{ name: '[过盾-全部]', type: 'select', proxies: passList.map((item) => item.name) }]
            : []),
          ...perTarget.map((item) => ({
            name: `[过盾-${item.host}]`,
            type: 'select',
            proxies: item.proxies
          }))
        ]
      },
      { lineWidth: -1 }
    ),
    'utf-8'
  )

  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1)
  console.log(
    `══ 结果：${passList.length} / ${allProbed.length} 能过 CF 盾（判定=${OPTIONS.require}），用时 ${seconds}s`
  )
  console.log('   逐目标通过数：')
  for (const item of perTarget) {
    console.log(`     ${item.host.padEnd(24, ' ')} ${item.passed} / ${allProbed.length}`)
  }
  console.log(`   明细     ${jsonPath}`)
  console.log(`   策略组   ${yamlPath}`)

  if (OPTIONS.dedupeIp) {
    console.log(
      `   IP 去重   ${passList.length} → ${finalList.length} 个（唯一 IP ${dedupe.uniqueIps} 个，合并掉 ${dedupe.dropped.length} 个同 IP 节点${unknownIpCount ? `，IP 未知保留 ${unknownIpCount} 个` : ''}）`
    )
  }

  if (finalList.length) {
    console.log(`\n最终名单（${OPTIONS.dedupeIp ? '已按 IP 去重，' : ''}按延迟升序）：`)
    for (const item of finalList) {
      const tail = [item.delay ? `${item.delay}ms` : '', item.ip ?? 'ip=?'].join(' ').trim()
      console.log(`   ${fmt(item.name)} ${tail}`)
    }
  }

  if (OPTIONS.dedupeIp && dedupe.dropped.length) {
    console.log(`\n被合并掉的同 IP 节点（${dedupe.dropped.length} 个，完整清单见 JSON）：`)
    for (const item of dedupe.dropped.slice(0, 20)) {
      console.log(`   ${fmt(item.name)} ${item.ip}  ← 同 IP 保留了 ${item.duplicateOf}`)
    }
    if (dedupe.dropped.length > 20) console.log(`   …… 另有 ${dedupe.dropped.length - 20} 个`)
  }

  if (!OPTIONS.apply) return

  // 写回覆写脚本 + 热重载。
  //
  // 门槛检查放在写入之前：某次网络抽风只剩一两个节点通过是常态，那时候宁可
  // 保留昨天的名单不动，也不要把「过盾」组缩成孤零零一两个节点。
  console.log('\n── 应用到「过盾」组 ────────────────────────')
  if (finalList.length < OPTIONS.minApply) {
    console.warn(
      `   去重后 ${finalList.length} 个 < --min-apply ${OPTIONS.minApply}，跳过写入，保留上一次的名单`
    )
    return
  }

  if (!applyShieldList(finalList.map((item) => item.name))) {
    process.exitCode = 1
    return
  }

  // 覆写文件没有 watcher，不主动触发就得等用户下次在 UI 里动配置才生效。
  // 这一步会让内核整图重建，进行中的连接断一次，无法避免 —— 所以放在最后跑。
  console.log('   热重载   POST /reload …')
  await reloadCore()
  console.log(`   ✅ 「过盾」组已更新为 ${finalList.length} 个节点并生效`)
}

main().catch((e) => {
  console.error('探测失败：', e.response?.data ?? e.message)
  process.exit(1)
})
