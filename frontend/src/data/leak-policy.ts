import type { EntryRow } from './types'

// 探漏域的唯一口径：列表展示、导出册子、抢修待复核清单都从这里取判定，
// 不再在各处按状态或漏点数量各判一遍。

export const LEAK_KEY = 'leakdetect'

export const LEAK_FIELDS = [
  '探漏编号',
  '探测管段',
  '探测方法',
  '漏点数量',
  '漏点位置',
  '处理建议',
  '探测日期',
  '复探周期',
  '探漏状态',
] as const

export const LEAK_STATUSES = ['待探测', '探测中', '已处理', '需复探'] as const

export const LEAK_ACTION_TARGETS: Record<string, string> = {
  提交探测: '探测中',
  确认处理: '已处理',
  要求复探: '需复探',
}

// 现场探测方法由班组统一登记，结论环节直接沿用记录上的方法，不再各自录入。
export const LEAK_METHODS = ['音听法', '相关分析法', '区域泄漏监测', '探坑验证'] as const

// 已处理的存量记录打上历史结论标记：历史结论原样保留，后续流转才按新口径重算。
export const LEAK_HISTORY_LOCK = '历史结论'

/** 漏点数量只认非负整数；空值、负数、小数、文字都是无效值，结论提交时先退回。 */
export function parseLeakCount(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value >= 0 ? value : null
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const text = value.trim()
    if (!/^\d+$/.test(text)) {
      return null
    }
    const parsed = Number(text)
    return Number.isSafeInteger(parsed) ? parsed : null
  }
  return null
}

export function isValidLeakCount(value: unknown): boolean {
  return parseLeakCount(value) !== null
}

function methodOf(row: EntryRow): string {
  const method = String(row['探测方法'] ?? '').trim()
  return method || '班组统一探测方法'
}

/**
 * 处理建议的唯一实现：顺着状态给，并统一带上现场探测方法。
 * 需复探永远不会被判成已处理；已处理的历史结论由调用方在外层保留。
 * 复探周期由班组排，这里不替班组算日期。
 */
export function resolveLeakAdvice(row: EntryRow): string {
  const method = methodOf(row)
  switch (String(row.status)) {
    case '待探测':
      return '等待班组安排现场探测，探测方法由班组统一确定'
    case '探测中':
      return `现场采用${method}探测，核实漏点后提交处置结论`
    case '已处理':
      return `现场采用${method}确认，漏点处置闭环，无需复探`
    case '需复探':
      return `现场采用${method}，疑点需复探核实，复探周期由班组排`
    default:
      return `现场采用${method}，按班组安排继续跟进`
  }
}

/**
 * 列表/明细/导出共用的行口径：处理建议走唯一判定。
 * 历史里已经处理且保留原结论的，继续显示原结论，其余状态按现场探测方法重算。
 */
export function decorateLeakRow(row: EntryRow): EntryRow {
  const locked = row[LEAK_HISTORY_LOCK] === true
  const storedAdvice = String(row['处理建议'] ?? '').trim()
  if (locked && storedAdvice !== '') {
    return row
  }
  return { ...row, 处理建议: resolveLeakAdvice(row) }
}

/** 存量漏点数量无效值按采集顺序（探漏编号自增即采集先后）回填一遍。 */
export function backfillLeakCounts(rows: EntryRow[]): boolean {
  const ordered = [...rows].sort((a, b) => Number(a.id) - Number(b.id))
  let seq = 1
  let changed = false
  for (const row of ordered) {
    if (!isValidLeakCount(row['漏点数量'])) {
      row['漏点数量'] = seq
      changed = true
    }
    seq += 1
  }
  return changed
}

/**
 * 兼容既有记录：
 * 1) 无效的漏点数量按采集顺序回填；
 * 2) 历史里已经处理且带原结论的，标记为历史结论，后续不再被新口径覆盖。
 * 原地整理，幂等可重复执行。
 */
export function migrateLeakRows(rows: EntryRow[]): boolean {
  let changed = backfillLeakCounts(rows)
  for (const row of rows) {
    const isHandled = String(row.status) === '已处理'
    const hasAdvice = String(row['处理建议'] ?? '').trim() !== ''
    if (isHandled && hasAdvice && row[LEAK_HISTORY_LOCK] !== true) {
      row[LEAK_HISTORY_LOCK] = true
      changed = true
    }
  }
  return changed
}
