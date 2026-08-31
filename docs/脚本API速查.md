# Clash Party 脚本控制 API 速查

> 给第三方脚本快速上手用。完整背景、设计依据、实测数据见 [脚本专用出口使用说明.md](./脚本专用出口使用说明.md)。

---

## 0. 三分钟跑通

```bash
BASE=http://127.0.0.1:17890
TOKEN=你的令牌          # 设置 → 脚本控制 API → 访问令牌

# 1. 通不通
curl -s -H "Authorization: Bearer $TOKEN" $BASE/ping

# 2. 拿一批能用的节点（延迟 ≤1000ms，已按延迟升序）
curl -s -H "Authorization: Bearer $TOKEN" \
  "$BASE/groups/%E5%87%BA%E5%8F%A3%E8%83%BD%E7%94%A801?maxDelay=1000"

# 3. 把这个组切到某个节点
curl -s -X PUT -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"香港01"}' \
  "$BASE/groups/%E5%87%BA%E5%8F%A3%E8%83%BD%E7%94%A801"

# 4. 从这个组对应的出口端口出网
curl -s -x http://127.0.0.1:7900 https://api.ipify.org
```

组名要 `encodeURIComponent`（含中文、emoji、方括号时必须）。

---

## 1. 连接与鉴权

| 项       | 值                                           |
| -------- | -------------------------------------------- |
| Base URL | `http://127.0.0.1:17890`（端口可在设置页改） |
| 鉴权     | 请求头 `Authorization: Bearer <令牌>`        |
| 来源限制 | 只接受本机（loopback）请求，其它来源 `403`   |
| 请求体   | `application/json`，上限 64 KB               |
| 成功响应 | 一律带 `"ok": true`                          |
| 失败响应 | `{"ok": false, "error": "..."}`              |

鉴权失败：`401 invalid or missing token`。非本机：`403 only loopback requests are allowed`。

---

## 2. 端点总览（7 个）

| 方法   | 路径             | 用途                                  |
| ------ | ---------------- | ------------------------------------- |
| GET    | `/ping`          | 存活探测                              |
| GET    | `/groups`        | 列出所有可切换的策略组及成员          |
| GET    | `/groups/:group` | 查单个组的成员与当前选中项            |
| PUT    | `/groups/:group` | **切换组的当前节点**（核心能力）      |
| DELETE | `/groups/:group` | 解除 url-test / fallback 组的固定选择 |
| POST   | `/probe`         | 探测延迟 / 查真实出口 IP / 跑全量基线 |
| GET    | `/outlets`       | 列出已配置的脚本出口端口              |

---

## 3. GET /ping

```json
{ "ok": true, "service": "clash-party-script-api" }
```

---

## 4. GET /groups

列出所有策略组。**不带 `maxDelay` 时返回全部成员**（老行为）。

**查询参数**

| 参数       | 默认      | 说明                                                                                                                                |
| ---------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `maxDelay` | 无        | 带上才启用过滤，只保留延迟在 `(0, maxDelay]` 的**具体节点**（策略组成员被排除）。传 `auto` 或空值 = 用设置页的统一阈值（默认 1000） |
| `maxAge`   | 300（秒） | 数据超过这个年龄就在 `filter.stale` 里标记。**只是提示，不触发探测**。下限 30 秒                                                    |
| `wait`     | `0`       | `1` = 先同步跑一轮全量基线再返回（会等十几秒）                                                                                      |

**响应（带 maxDelay 时）**

```json
{
  "ok": true,
  "groups": [
    {
      "name": "出口能用01",
      "type": "Selector",
      "now": "香港01",
      "fixed": "",
      "proxies": ["香港01", "日本02"],
      "total": 642,
      "usable": 2
    }
  ],
  "filter": {
    "maxDelay": 1000,
    "maxAgeSec": 300,
    "probed": false,
    "dataAgeMs": 125000,
    "stale": false,
    "lastProbeAt": "2026-08-29T02:00:00.000Z",
    "lastFullProbeAt": "2026-08-29T02:00:00.000Z",
    "lastProbedCount": 642,
    "lastAliveCount": 191,
    "probing": false,
    "storeSize": 642,
    "storeAlive": 191
  }
}
```

`usable` 一直是 0 时先看 `filter.storeSize`：`0` = 启动基线还没跑完（等一会儿或 `POST /probe`）；`>0` 而 `storeAlive=0` = 确实全都不通。

---

## 5. GET /groups/:group

查单个组。带 `maxDelay` 时**只返回达标节点并按延迟升序排好**——脚本直接取 `proxies[0]` 就是最快的。查询参数同 `/groups`。

```json
{
  "ok": true,
  "name": "出口能用01",
  "type": "Selector",
  "now": "香港01",
  "fixed": "",
  "proxies": ["香港01", "日本02"],
  "details": [
    { "name": "香港01", "delay": 185, "time": "2026-08-29T02:01:00.000Z", "ageMs": 60000 },
    { "name": "日本02", "delay": 206, "time": "2026-08-29T02:01:00.000Z", "ageMs": 60000 }
  ],
  "total": 642,
  "usable": 2,
  "filter": {}
}
```

不带 `maxDelay` 时只有 `proxies`（全部成员名），没有 `details` / `total` / `usable` / `filter`。

组不存在：`404 group not found: <名字>`。

---

## 6. PUT /groups/:group —— 切换节点

```http
PUT /groups/出口能用01
Content-Type: application/json

{ "name": "香港01" }
```

```json
{ "ok": true, "group": "出口能用01", "now": "香港01" }
```

切换后 **400ms 内即可拨测**（实测切组耗时 p50 仅 14~15ms）。若设置里开了「切换后断开旧连接」，旧连接会被一起断掉，新节点立刻生效。

**错误**

| 状态 | 文案                                                         | 原因                                                         |
| ---- | ------------------------------------------------------------ | ------------------------------------------------------------ |
| 400  | `body.name is required`                                      | 没给 `name`                                                  |
| 400  | `proxy X is not a member of group Y`                         | 只能切到该组自己的成员                                       |
| 403  | `group X is managed by script outlet and cannot be switched` | 你在切 `PARTY-OUTLET-*` 或 `PARTY-PROBE-*`，这些是程序托管的 |
| 404  | `group not found: X`                                         | 组名拼错或忘了 `encodeURIComponent`                          |

---

## 7. DELETE /groups/:group

解除 url-test / fallback 组的固定选择，恢复自动测速。

```json
{ "ok": true, "group": "自动选择", "unfixed": true }
```

---

## 8. POST /probe —— 探测

一个端点三种用法，靠 body 区分：

| body                                                      | 行为                        |
| --------------------------------------------------------- | --------------------------- |
| `{"proxies":[...]}` 或 `{"proxies":[...],"mode":"delay"}` | 查这批节点的延迟（默认）    |
| `{"proxies":[...],"mode":"ip"}`                           | 实际拨号，拿**真实出口 IP** |
| `{}`（不带 `proxies`）                                    | 跑一轮全量基线，返回统计    |

> ⚠ 节点名字段是 **`proxies`**，不是 `names`。名单必须走 body：节点名普遍含 emoji 和空格，塞 query 撑不住。

### 8.1 mode="delay"（默认）

| body 字段     | 默认        | 说明                                                                     |
| ------------- | ----------- | ------------------------------------------------------------------------ |
| `proxies`     | 必填        | 节点名数组，单请求上限 **400** 个（超出静默截断，看 `limits.truncated`） |
| `maxDelay`    | 0（不过滤） | **只用于过滤结果**，不影响测量                                           |
| `maxAge`      | 300（秒）   | 记录比这个新就直接返回；`0` = 强制现测                                   |
| `probeUrl`    | 见下        | 覆盖本次测速地址                                                         |
| ~~`timeout`~~ | —           | **已废弃**，传了会被忽略并回 `timeoutIgnored: true`                      |

**命中缓存就返回，否则现测一次再返回——不会返回旧值。**

```json
{
  "ok": true,
  "mode": "delay",
  "scope": "named",
  "timeout": 6000,
  "url": "https://www.gstatic.com/generate_204",
  "maxAgeSec": 300,
  "maxDelay": 1000,
  "elapsedMs": 6321,
  "limits": { "received": 50, "deduped": 50, "accepted": 50, "truncated": 0, "limit": 400 },
  "counts": { "fresh": 12, "probed": 38, "alive": 31, "filtered": 4 },
  "probedCount": 50,
  "aliveCount": 31,
  "results": [
    { "name": "香港01", "delay": 185, "err": null, "ageMs": 0, "usable": true },
    { "name": "日本02", "delay": 0, "err": "timeout", "ageMs": 0, "usable": false }
  ],
  "unknown": ["不存在的节点"],
  "rejected": ["某个策略组名"],
  "dataAgeMs": 125000
}
```

- `results` / `unknown` / `rejected` 三者合起来覆盖你送进来的每一个名字。
- `unknown` = 内核里没这个名字；`rejected` = 是策略组或不可探测项。
- `usable = delay > 0 && delay <= maxDelay`。`delay > 0` 时 `err` 恒为 `null`。

**耗时是跳变的**，等于 `ceil(未命中数 / 150) × 6000ms`：1 波 6.3s / 2 波 12.6s / 3 波 17.7s（这三个数实测于旧上限 200 时期，档位含义不变）。这 150 是**全局共用**的，全量基线和 mode=ip 也在抢，撞上时波数会更多。**HTTP 客户端超时给到 20 秒以上**，并靠提高 `maxAge` 提升缓存命中率。

### 8.2 mode="ip" —— 拿真实出口 IP

内核测速只给延迟，拿真实 IP 必须实际拨号，所以这个模式要占用**探测工位**（程序自动注入的专用组 + 端口，你不用配也切不了）。

| body 字段 | 说明                       |
| --------- | -------------------------- |
| `proxies` | 必填，单请求上限 **50** 个 |
| `mode`    | `"ip"`                     |

**无缓存，每次都现测。**

```json
{
  "ok": true,
  "mode": "ip",
  "stations": { "pool": 100, "quota": 50, "granted": 50 },
  "targets": [
    "https://www.cloudflare.com/cdn-cgi/trace",
    "https://api.ipify.org/",
    "https://icanhazip.com/"
  ],
  "targetTimeout": 2500,
  "elapsedMs": 10600,
  "limits": { "received": 6, "deduped": 6, "accepted": 6, "truncated": 0, "limit": 50 },
  "counts": { "ok": 5, "failed": 1 },
  "results": [
    {
      "name": "香港01",
      "ip": "1.2.3.4",
      "ipFamily": 4,
      "loc": "HK",
      "target": "https://www.cloudflare.com/cdn-cgi/trace",
      "queueMs": 15,
      "connectMs": 620,
      "responseMs": 410,
      "totalMs": 1045,
      "err": null
    },
    {
      "name": "日本02",
      "ip": null,
      "ipFamily": null,
      "loc": null,
      "target": null,
      "queueMs": 18,
      "connectMs": null,
      "responseMs": null,
      "totalMs": 2518,
      "err": "timeout"
    }
  ],
  "unknown": [],
  "rejected": []
}
```

- `totalMs = queueMs + connectMs + responseMs`；`queueMs` 含排队等工位 + 切组。
- 三个目标**并行**打，第一个成功就掐断其余；`target` 告诉你是哪个赢了。
- `loc`（地区码）**只有 cf-trace 会给**，另两个目标只有 IP。
- `stations.granted` 小于 50 说明池子紧张，表现是耗时变长，不是报错。

**两个必须知道的坑**

1. **ip 模式失败 ≠ 节点不可用。** 目标站点抖动会造成 5~9% 假阴性。判可用性用 `mode:"delay"`，别照着 ip 模式的失败拉黑节点。
2. **出口 IP 大量共用。** 实测 91 个可用节点只对应 **70 个唯一出口 IP**，单个 IP 最多被 4 个节点名共用。**把节点数当出口数会高估容量**——业务要求「一账号一 IP」的话，必须按 `ip` 去重后再算。

**工位相关报错**

| 文案                                                                | 处置                                                                 |
| ------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `no probe station was injected into the running config; ...`        | 配置生成阶段没注入工位：脚本 API 关着，或本机找不到连续 100 个空端口 |
| `no probe station is listening; the core may not have reloaded ...` | 端口在册但内核还没重载，点「应用并重启内核」后重试                   |

### 8.3 不带 proxies —— 跑全量基线

```json
{
  "ok": true,
  "mode": "delay",
  "scope": "full",
  "probedCount": 642,
  "aliveCount": 191,
  "storeSize": 642,
  "storeAlive": 191,
  "lastProbeAt": "2026-08-29T02:00:00.000Z",
  "lastFullProbeAt": "2026-08-29T02:00:00.000Z"
}
```

程序自己每 3 小时跑一轮（默认值，用户可在设置页「出口脚本 → 全量测速间隔」改，`0` = 关掉周期轮，下限 5 分钟），另外在启动 / 订阅更新 / 切配置时触发。冷启动后表是空的，第一轮跑完（启动约 20 秒后开始）名单才有内容。⚠ 即使间隔设为 `0`，启动首轮与这些事件触发依旧会跑 —— 否则名单永远是空的。

---

## 9. GET /outlets

列出已配置的脚本出口，用来自检端口和目标对不对。批量出口在这里**展开成逐个端口**，与内核里实际的 listener 一一对应。

```json
{
  "ok": true,
  "outlets": [
    {
      "port": 7900,
      "enable": true,
      "mode": "direct",
      "type": "mixed",
      "target": "出口能用01",
      "remark": "test01"
    }
  ]
}
```

`mode` 是 `direct` | `fallback`，`type` 是 `mixed` | `socks5` | `http`。`direct` 模式给 `target`（单个目标），`fallback` 模式给 `targets`（备选节点数组）。

---

## 10. 错误码 `err` 语义

| `err`          | 含义                              | 脚本该怎么办                              |
| -------------- | --------------------------------- | ----------------------------------------- |
| `timeout`      | 6000ms 内没跑完整链（内核回 504） | 值得重试，**不要立刻拉黑**                |
| `unreachable`  | 内核连不上落地（回 503）          | 大概率真坏了                              |
| `tls_failed`   | TLS 握手被拒                      | 落地机或中间链路问题                      |
| `bad_response` | 连上了但响应不对（劫持 / 门户页） | 出网被拦，换节点                          |
| `dial_failed`  | 连**本地**端口都失败              | 本机工位 / 内核问题，只出现在 `mode:"ip"` |
| `kernel_error` | 其它内核侧异常                    | 与节点质量无关                            |

---

## 11. 关键限额一览

| 项                            | 值                                     |
| ----------------------------- | -------------------------------------- |
| `mode=delay` 单请求名字上限   | 400                                    |
| `mode=ip` 单请求名字上限      | 50                                     |
| `mode=ip` 工位池 / 单请求配额 | 100 / 50                               |
| 内核测速 timeout（固定）      | 6000 ms                                |
| 探测并发总上限（全局共用）    | 150 条连接                             |
| `mode=ip` 单目标超时          | 2500 ms                                |
| `maxAge` 默认 / 下限          | 300 秒 / 30 秒                         |
| 全量基线周期                  | 默认 3 小时，可配（0=关，下限 5 分钟） |
| 请求体上限                    | 64 KB                                  |

---

## 12. 可直接抄的最小封装

```javascript
const BASE = 'http://127.0.0.1:17890'
const TOKEN = process.env.CLASH_PARTY_TOKEN

async function api(path, { timeoutMs = 10000, ...init } = {}) {
  const res = await fetch(BASE + path, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers
    },
    // 探测可能要十几秒，别用默认超时
    signal: AbortSignal.timeout(timeoutMs)
  })
  const data = await res.json()
  if (!data.ok) throw new Error(`${path} -> ${res.status} ${data.error}`)
  return data
}

/** 取一个组里延迟达标的节点，已按快慢排序 */
async function usableNodes(group, maxDelay = 1000) {
  const g = encodeURIComponent(group)
  const data = await api(`/groups/${g}?maxDelay=${maxDelay}`)
  return data.proxies
}

/** 切换组的当前节点 */
async function switchTo(group, name) {
  return api(`/groups/${encodeURIComponent(group)}`, {
    method: 'PUT',
    body: JSON.stringify({ name })
  })
}

/** 强制刷新一批节点的延迟（maxAge=0 = 不吃缓存） */
async function refreshDelays(names, maxDelay = 1000) {
  const data = await api('/probe', {
    method: 'POST',
    timeoutMs: 30000, // 耗时按波数跳变，给足
    body: JSON.stringify({ mode: 'delay', proxies: names, maxDelay, maxAge: 0 })
  })
  return data.results.filter((item) => item.usable).map((item) => item.name)
}

/** 查真实出口 IP（一次最多 50 个） */
async function realIps(names) {
  const data = await api('/probe', {
    method: 'POST',
    timeoutMs: 60000,
    body: JSON.stringify({ mode: 'ip', proxies: names.slice(0, 50) })
  })
  return data.results.filter((item) => item.ip).map((item) => ({ name: item.name, ip: item.ip }))
}

/** 节点轮换：拿一批候选，逐个切过去执行任务，失败就换下一个 */
async function runWithRotation(group, port, task, maxDelay = 1000) {
  const nodes = await usableNodes(group, maxDelay)
  if (!nodes.length) throw new Error(`${group} 没有可用节点`)
  for (const node of nodes) {
    await switchTo(group, node)
    await new Promise((r) => setTimeout(r, 400)) // 等连接切过去
    try {
      return await task(node, `http://127.0.0.1:${port}`)
    } catch (e) {
      console.warn(`节点 ${node} 失败：${e.message}，换下一个`)
    }
  }
  throw new Error(`${group} 全部节点都失败`)
}
```

---

## 13. 多脚本并发的唯一注意事项

**切换策略组是全局副作用。** 两个脚本切同一个组，谁都不知道自己正在用哪个节点。

解法：**一脚本一组一端口**。在设置页用批量出口一次配好一批（`出口能用01~50` 对应端口 `7900~7949`），每个脚本认领一个：

| 脚本 | 组           | 出口端口 |
| ---- | ------------ | -------- |
| A    | `出口能用01` | 7900     |
| B    | `出口能用02` | 7901     |
| C    | `出口能用03` | 7902     |

端口对应关系用 `GET /outlets` 核对，不要自己按序号推算。

`POST /probe` 两个模式都不需要你做隔离：`mode=delay` 走内核测速（弹性，多脚本一起压只是各自变慢），`mode=ip` 由工位池自动隔离。

⚠ 但两个模式（加上程序自己的全量基线）**共用同一个 150 条连接的全局闸门**：`mode=delay` 一个节点占 1 个名额，`mode=ip` 一个节点占 3 个（并行拨三个目标）。多方同时跑的结果是排队变慢，不是报错，客户端超时要给足。

---

## 14. 三条最容易踩的

1. **组名要 `encodeURIComponent`**，否则 `404 group not found`。
2. **`POST /probe` 的字段是 `proxies`**，写成 `names` 会静默拿不到结果。
3. **探测请求的客户端超时要给够**（delay 模式 ≥20 秒，ip 模式 ≥60 秒），耗时按波数跳变，不是慢慢变慢。
