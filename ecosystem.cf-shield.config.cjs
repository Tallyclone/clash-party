// pm2 调度配置：每天凌晨 4 点跑一次 CF 盾探测，把过盾节点写进「过盾」策略组。
//
// 为什么用 .cjs 而不是 .js：package.json 里 type=module，根目录下的 .js 会被当 ESM 解析，
// 而 pm2 是用 require() 读这个文件的，写成 .js 会直接报 module is not defined。
//
// 为什么 pm2 直接跑探测器本体、不套一层 .ps1 包装：包装脚本无非做「定位 node + 拼参数 +
// 日志落盘轮转」，这三件事 pm2 自己全包了（node 解释器、args、out_file/error_file、
// pm2-logrotate）。多套一层只会让排查时多一跳，所以早期的 cf-shield-daily.ps1 已删除。
//
// 用法：
//   pm2 start ecosystem.cf-shield.config.cjs   # 注册（会立刻跑一次，见下）
//   pm2 save                                    # 必须！否则重启机器 resurrect 不会带上它
//   pm2 logs clash-party-cf-shield              # 看日志
//   pm2 restart clash-party-cf-shield           # 手动立刻跑一次
//
// ⚠ 前提：探测器要经 127.0.0.1:17890 控制内核，所以 Clash Party 必须在运行中。
//   pm2 的 cron 不会唤醒睡眠的机器、也不补跑错过的时间点 —— 4 点机器没醒就跳过这天。

const path = require('path')

const repoRoot = __dirname
const logDir = path.join(repoRoot, '.snow', 'cf', 'logs')

module.exports = {
  apps: [
    {
      name: 'clash-party-cf-shield',
      cwd: repoRoot,
      script: path.join(repoRoot, 'scripts', 'cf-shield-probe.mjs'),
      // 只留 --apply。靶站、超时、重试、--min-apply 这些参数都在探测器自己的
      // cf-shield.config.json 里（优先级：命令行 > 配置文件 > 内置默认），改参数
      // 只改那个 JSON 就行，不用动这里、也不用重新 pm2 save。
      //
      // --apply 刻意**不**写进配置文件：那样一来随手手动试跑也会改线上覆写并热重载
      // 内核。让它只出现在这里，手动跑就永远是只读的。
      args: ['--apply'],

      // 一次性任务，不是常驻服务：跑完就该躺着，靠 cron 唤醒。
      // 少了 autorestart:false，pm2 会在脚本正常退出后立刻重启它 —— 变成无限循环跑探测，
      // 每轮末尾还带一次 /reload，等于把内核连接反复掐断。这行是硬要求。
      autorestart: false,
      cron_restart: '0 4 * * *',

      // 探测全程十几分钟，别让 pm2 以为「起得太快退出」而把它标成 errored。
      // 不设 max_memory_restart：按内存杀一个跑到一半的探测只会留下半份名单。
      min_uptime: 0,
      max_restarts: 0,

      // 日志：out/err 分开落到 .snow/cf/logs（已 gitignore），带时间戳前缀。
      // 轮转交给 pm2-logrotate：pm2 install pm2-logrotate
      out_file: path.join(logDir, 'cf-shield-out.log'),
      error_file: path.join(logDir, 'cf-shield-err.log'),
      time: true,

      env: {
        // 探测器自己从 config.yaml 读 scriptApi token，这里不需要放任何凭据
        NODE_ENV: 'production'
      }
    }
  ]
}
