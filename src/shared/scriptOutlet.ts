import { SCRIPT_OUTLET_MAX_BATCH_COUNT } from './appConfig'

/**
 * 批量出口的展开规则（主进程注入内核与渲染层预览共用同一份实现）。
 *
 * 一条 count > 1 的配置在 UI 上永远只占一张卡片，真正注入内核时才展开为多个 listener：
 * - 端口：从 port 起按 +1 递增
 * - 备注：remark 前缀 + 补零序号（test + 01 → test01）
 * - direct 模式：按 batchTargets 的顺序 1:1 对应各端口
 * - fallback 模式：所有端口共用同一份 targets（各自生成成员相同的 fallback 组）
 */

/** 展开后的单个出口，附带来源信息便于日志定位 */
export interface IExpandedScriptOutlet extends IScriptOutlet {
  /** 来源条目 id（批量卡片自身的 id） */
  sourceId: string
  /** 批量内序号，从 1 开始；非批量恒为 1 */
  index: number
}

/** 个数归一化：非法值退化为 1（等于普通单出口），并夹到上限内 */
export function normalizeOutletCount(count: unknown): number {
  if (typeof count !== 'number' || !Number.isFinite(count)) return 1
  const value = Math.floor(count)
  if (value <= 1) return 1
  return Math.min(value, SCRIPT_OUTLET_MAX_BATCH_COUNT)
}

export function isBatchOutlet(outlet: IScriptOutlet): boolean {
  return normalizeOutletCount(outlet.count) > 1
}

/** 序号宽度：至少两位（test01），个数超过 99 时自动加宽 */
export function outletSequenceWidth(count: number): number {
  return Math.max(2, String(Math.max(1, Math.floor(count))).length)
}

export function formatOutletSequence(index: number, count: number): string {
  return String(index).padStart(outletSequenceWidth(count), '0')
}

/** 批量出口的备注：前缀 + 补零序号；前缀为空时只留序号 */
export function formatBatchOutletRemark(
  remark: string | undefined,
  index: number,
  count: number
): string {
  const prefix = remark?.trim() ?? ''
  const sequence = formatOutletSequence(index, count)
  return prefix ? `${prefix}${sequence}` : sequence
}

/** 批量出口占用的端口闭区间；非批量时 start === end */
export function getOutletPortRange(outlet: IScriptOutlet): { start: number; end: number } {
  const count = normalizeOutletCount(outlet.count)
  return { start: outlet.port, end: outlet.port + count - 1 }
}

/** 一条配置实际会占用的全部端口 */
export function getOutletPorts(outlet: IScriptOutlet): number[] {
  const count = normalizeOutletCount(outlet.count)
  return Array.from({ length: count }, (_, i) => outlet.port + i)
}

/**
 * 把一条出口配置展开成实际要注入内核的出口列表。
 * 非批量条目原样返回（仅补上 sourceId / index），批量条目按上文规则展开。
 */
export function expandScriptOutlet(outlet: IScriptOutlet): IExpandedScriptOutlet[] {
  const count = normalizeOutletCount(outlet.count)
  if (count <= 1) {
    return [{ ...outlet, count: 1, sourceId: outlet.id, index: 1 }]
  }

  // 只做 trim，不能 filter 掉空串：batchTargets 的下标就是出口序号，
  // 过滤会让后面的目标整体前移，导致 UI 预览与实际注入错位
  const batchTargets = (outlet.batchTargets ?? []).map((item) => item.trim())
  const expanded: IExpandedScriptOutlet[] = []
  for (let i = 0; i < count; i++) {
    expanded.push({
      ...outlet,
      // 展开产物是「单个出口」，清掉批量字段避免被二次展开
      count: 1,
      batchTargets: undefined,
      id: `${outlet.id}#${formatOutletSequence(i + 1, count)}`,
      sourceId: outlet.id,
      index: i + 1,
      port: outlet.port + i,
      remark: formatBatchOutletRemark(outlet.remark, i + 1, count),
      // fallback 模式下 target 无意义（走共用的 targets）；direct 模式按序取第 i 个目标，
      // 目标不够时留空，由注入阶段按「缺少目标」跳过并记日志
      target: outlet.mode === 'fallback' ? outlet.target : batchTargets[i]
    })
  }
  return expanded
}

export function expandScriptOutlets(outlets: IScriptOutlet[] | undefined): IExpandedScriptOutlet[] {
  if (!outlets?.length) return []
  return outlets.flatMap((outlet) => expandScriptOutlet(outlet))
}
