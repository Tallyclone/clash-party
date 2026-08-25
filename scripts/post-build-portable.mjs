import { existsSync, writeFileSync } from 'fs'
import { join } from 'path'

/**
 * 在 electron-builder 重建 dist/win-unpacked 之后，自动补回 PORTABLE 标记。
 *
 * 背景：
 *   electron-builder 打包前会清空 appOutDir，导致 win-unpacked 下的 PORTABLE 标记
 *   被一并删除。没有这个标记，dirs.ts 的 isPortable() 返回 false，本地构建的 exe
 *   会直接读写 %APPDATA%\mihomo-party（你正式安装版的真实配置），订阅/规则/覆写
 *   全在里面 —— 等于在动生产数据。
 *
 *   重建一个空 PORTABLE 文件后，exe 会把数据写到 win-unpacked\data\ 下，与正式
 *   版完全隔离，参考官方 CI 的做法（.github/workflows/build.yml 的
 *   "Add Portable Flag" 步骤同样创建空文件）。
 */

const unpackedDir = join('dist', 'win-unpacked')
const portableFlag = join(unpackedDir, 'PORTABLE')

if (!existsSync(unpackedDir)) {
  console.error(`❌ ${unpackedDir} 不存在，请先运行 pnpm run build:win:unpacked`)
  process.exit(1)
}

if (existsSync(portableFlag)) {
  console.log(`ℹ️ ${portableFlag} 已存在，跳过（幂等）`)
  process.exit(0)
}

writeFileSync(portableFlag, '')
console.log(`✅ 已创建 PORTABLE 标记：${portableFlag}`)
console.log('   → 启用便携模式，exe 数据写入 win-unpacked\\data\\，与正式版隔离')
