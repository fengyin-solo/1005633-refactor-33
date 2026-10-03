import { filterRows } from './query'
import { listRows, saveRows } from './local-store'
import {
  decorateLeakRow,
  isValidLeakCount,
  LEAK_ACTION_TARGETS,
  LEAK_HISTORY_LOCK,
  LEAK_KEY,
} from './leak-policy'
import type { ActionResult, EntryRow, PageResult } from './types'

// 探漏列表、导出册子、抢修待复核清单共用的取数口径：
// 同一份筛选 + 同一份行判定，三个出口看到的结论完全一致。

export function listLeakEntries(filters: Record<string, string> = {}): PageResult {
  const items = filterRows(listRows(LEAK_KEY), filters).map(decorateLeakRow)
  return { items, total: items.length, page: 1, size: items.length }
}

/** 复探结论反映到抢修处置：需复探记录进待复核清单，确认处理后自动移出。 */
export function listReinspectionReviews(): EntryRow[] {
  return listLeakEntries().items.filter((row) => String(row.status) === '需复探')
}

/**
 * 探漏结论提交：
 * - 漏点数量是无效值的先退回，不允许落结论；
 * - 同一结论重提只记一遍，不重复写数据；
 * - 现场探测方法沿用班组登记，处理建议按唯一口径回填；
 * - 复探周期由班组排，这里不生成具体复探日期。
 */
export function submitLeakAction(id: number, action: string): ActionResult {
  const target = LEAK_ACTION_TARGETS[action]
  if (!target) {
    return { ok: false, message: `探漏记录没有登记「${action}」这个动作` }
  }
  const rows = listRows(LEAK_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的探漏记录` }
  }
  const current = rows[index]
  if (String(current.status) === target) {
    return {
      ok: true,
      duplicated: true,
      message: `探漏记录已是「${target}」，结论只记一遍，无需重复提交`,
    }
  }
  if (!isValidLeakCount(current['漏点数量'])) {
    return { ok: false, message: '漏点数量为无效值，请按非负整数核对后再提交结论' }
  }
  const updated: EntryRow = {
    ...current,
    status: target,
    pending: target !== '已处理',
    abnormal: false,
    // 流转产生的新结论覆盖旧建议，避免需复探沿用已处理结论。
    [LEAK_HISTORY_LOCK]: false,
  }
  updated['处理建议'] = decorateLeakRow(updated)['处理建议']
  const next = [...rows]
  next[index] = updated
  saveRows(LEAK_KEY, next)
  return { ok: true, message: `探漏记录已${action}，当前状态「${target}」` }
}
