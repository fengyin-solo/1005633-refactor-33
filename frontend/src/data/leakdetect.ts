import { filterRows } from '@/api/local-service'
import { MODULE_BY_KEY } from './modules'
import { listRows, saveRows } from './local-store'
import type { ActionResult, EntryRow } from './types'

// 管网探漏的领域规则集中在这一份：列表页与导出册子共用同一套取数与判定口径，
// 不再允许页面/导出各判一次（历史上导出按漏点数量另判，复探记录会被误判成已处理）。

export const LEAK_MODULE_KEY = 'leakdetect'

const STATUS_PENDING = '待探测'
const STATUS_DETECTING = '探测中'
const STATUS_DONE = '已处理'
const STATUS_REINSPECT = '需复探'

// 现场探测方法目录由探漏班组统一维护，页面上不允许各自起名：
// - conclusive：能直接确认漏点，结论统一判为「已处理」；
// - screening：只是筛查手段，结论统一判为「需复探」，复探周期也由班组排。
type LeakMethodKind = 'conclusive' | 'screening'
type LeakMethod = { name: string; kind: LeakMethodKind; note: string }

const LEAK_METHODS: LeakMethod[] = [
  { name: '阀栓听音法', kind: 'screening', note: '阀栓听音只定位疑似点，需要复探确认' },
  { name: '地面听音法', kind: 'screening', note: '地面听音属地面筛查，需要复探确认' },
  { name: '区域噪声监测法', kind: 'screening', note: '噪声记录仪只圈定疑似区域，需要复探确认' },
  { name: '相关分析法', kind: 'conclusive', note: '相关仪可精确定位漏点' },
  { name: '探地雷达法', kind: 'conclusive', note: '雷达图像可确认管位与漏点' },
  { name: '气体示踪法', kind: 'conclusive', note: '示踪气体可确认漏点位置' },
  { name: '钻孔验证法', kind: 'conclusive', note: '钻孔验证是漏点最终确认手段' },
]

// 复探周期不由系统推算，统一由探漏班组排期，建议文案与待复核清单都带上这句。
export const REINSPECT_CYCLE_NOTE = '复探周期由探漏班组统一排期'

const ACTION_TARGETS: Record<string, string> = {
  提交探测: STATUS_DETECTING,
  确认处理: STATUS_DONE,
  要求复探: STATUS_REINSPECT,
}

const BACKFILL_FLAG_KEY = 'district-heating:leak-backfill:v1'
const JOURNAL_KEY = 'district-heating:leak-journal:v1'

type LeakIssueCode = 'INVALID_COUNT' | 'UNKNOWN_METHOD'
type LeakIssue = { code: LeakIssueCode; message: string }

// 统一判定结论：列表的处理建议列与导出册子的明细列都只认这一份结果。
export type LeakConclusion = {
  status: string
  advice: string
  returned: boolean
  issues: LeakIssue[]
  method: LeakMethod | null
}

export type LeakViewRow = EntryRow & {
  处理建议: string
  退回原因: string
}

export type LeakListResult = {
  items: LeakViewRow[]
  returned: LeakViewRow[]
  total: number
}

export type LeakJournalEntry = {
  leakId: number
  code: string
  segment: string
  method: string
  count: string | number
  target: string
  submittedAt: string
}

export type ReinspectReview = {
  leakId: number
  code: string
  segment: string
  method: string
  count: string | number
  advice: string
  submittedAt: string
}

function storageAvailable(): boolean {
  return typeof window !== 'undefined' && !!window.localStorage
}

function readFlag(key: string): boolean {
  if (!storageAvailable()) {
    return false
  }
  return window.localStorage.getItem(key) === '1'
}

function writeFlag(key: string): void {
  if (storageAvailable()) {
    window.localStorage.setItem(key, '1')
  }
}

function readJournal(): LeakJournalEntry[] {
  if (!storageAvailable()) {
    return []
  }
  const raw = window.localStorage.getItem(JOURNAL_KEY)
  if (!raw) {
    return []
  }
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as LeakJournalEntry[]) : []
  } catch {
    return []
  }
}

function writeJournal(entries: LeakJournalEntry[]): void {
  if (storageAvailable()) {
    window.localStorage.setItem(JOURNAL_KEY, JSON.stringify(entries))
  }
}

// 漏点数量只接受非负整数；空值、负数、小数、文字一律是无效值。
export function isValidLeakCount(value: unknown): boolean {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value >= 0
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed === '' || !/^\d+$/.test(trimmed)) {
      return false
    }
    return Number.isInteger(Number(trimmed))
  }
  return false
}

function findMethod(name: string): LeakMethod | null {
  const trimmed = name.trim()
  return LEAK_METHODS.find((item) => item.name === trimmed) ?? null
}

// 采集顺序：探测日期早的在前，同日按编号（id）排，回填结果才稳定可重复。
function compareCollectionOrder(a: EntryRow, b: EntryRow): number {
  const da = String(a['探测日期'] ?? '')
  const db = String(b['探测日期'] ?? '')
  if (da !== db) {
    return da < db ? -1 : 1
  }
  return Number(a.id) - Number(b.id)
}

// 存量记录兼容：漏点数量缺失/无效的，按采集顺序（1 起）回填一遍；
// 已经是有效值的一律不动。迁移只跑一次，重复执行不会再改数据。
function ensureLeakRows(): EntryRow[] {
  const rows = listRows(LEAK_MODULE_KEY)
  if (readFlag(BACKFILL_FLAG_KEY)) {
    return rows
  }
  const ordered = [...rows].sort(compareCollectionOrder)
  let changed = false
  const backfilled = rows.map((row) => {
    if (isValidLeakCount(row['漏点数量'])) {
      return row
    }
    changed = true
    const ordinal = ordered.findIndex((item) => Number(item.id) === Number(row.id)) + 1
    return { ...row, 漏点数量: ordinal }
  })
  if (changed) {
    saveRows(LEAK_MODULE_KEY, backfilled)
  }
  writeFlag(BACKFILL_FLAG_KEY)
  return changed ? backfilled : rows
}

// 唯一的一份判定实现：已处理与需复探只按班组统一的现场探测方法判，
// 不再看状态、也不再按漏点数量另判；历史已处理记录保留原结论。
export function resolveLeakConclusion(row: EntryRow): LeakConclusion {
  const storedStatus = String(row.status)
  const originalAdvice = String(row['处理建议'] ?? '').trim()

  if (storedStatus === STATUS_DONE) {
    return {
      status: STATUS_DONE,
      advice:
        originalAdvice ||
        '现场探测已确认漏点，按班组统一口径判定为已处理',
      returned: false,
      issues: [],
      method: findMethod(String(row['探测方法'] ?? '')),
    }
  }

  if (storedStatus === STATUS_PENDING) {
    return {
      status: STATUS_PENDING,
      advice: '待探测：现场探测方法由班组统一安排，暂不出结论',
      returned: false,
      issues: [],
      method: findMethod(String(row['探测方法'] ?? '')),
    }
  }

  const methodName = String(row['探测方法'] ?? '').trim()
  const method = findMethod(methodName)
  const issues: LeakIssue[] = []
  if (!isValidLeakCount(row['漏点数量'])) {
    issues.push({
      code: 'INVALID_COUNT',
      message: `漏点数量「${String(row['漏点数量'] ?? '').trim() || '空'}」无效，先退回班组重新采集核对`,
    })
  }
  if (!method) {
    issues.push({
      code: 'UNKNOWN_METHOD',
      message: `现场探测方法「${methodName || '未登记'}」不在班组统一目录内，先退回班组确认`,
    })
  }
  if (issues.length > 0) {
    return {
      status: storedStatus,
      advice: issues.map((issue) => issue.message).join('；'),
      returned: true,
      issues,
      method,
    }
  }
  if (!method) {
    // 理论上不可达：方法不在目录里时上面已随 issues 一起退回。
    return {
      status: storedStatus,
      advice: '现场探测方法未在班组统一目录内，先退回班组确认',
      returned: true,
      issues: [{ code: 'UNKNOWN_METHOD', message: '现场探测方法未在班组统一目录内' }],
      method,
    }
  }

  if (method.kind === 'conclusive') {
    return {
      status: STATUS_DONE,
      advice: `现场探测方法「${method.name}」${method.note}，按班组统一口径判定为已处理`,
      returned: false,
      issues: [],
      method,
    }
  }

  return {
    status: STATUS_REINSPECT,
    advice: `现场探测方法「${method.name}」${method.note}，按班组统一口径判定为需复探；${REINSPECT_CYCLE_NOTE}`,
    returned: false,
    issues: [],
    method,
  }
}

function toViewRow(row: EntryRow): LeakViewRow {
  const conclusion = resolveLeakConclusion(row)
  return {
    ...row,
    处理建议: conclusion.advice,
    退回原因: conclusion.returned ? conclusion.advice : '',
  }
}

// 列表与导出册子共用的取数口径：筛选沿用各模块既有口径，
// 判定（处理建议、是否退回）统一走 resolveLeakConclusion。
// 漏点数量无效、探测方法不在班组目录的先退回，不进清单正文，也不进导出册子。
export function listLeakEntries(filters: Record<string, string> = {}): LeakListResult {
  const matched = filterRows(ensureLeakRows(), filters)
  const views = matched.map(toViewRow)
  const returned = views.filter((view) => view.退回原因 !== '')
  const items = views.filter((view) => view.退回原因 === '')
  return { items, returned, total: items.length }
}

function csvCell(value: unknown): string {
  const text = String(value ?? '')
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

// 导出册子：与列表同一份 listLeakEntries 取数，退回记录不导出。
export function exportLeakBooklet(): { filename: string; content: string } {
  const meta = MODULE_BY_KEY.get(LEAK_MODULE_KEY)
  const fields = meta ? meta.fields : []
  const { items } = listLeakEntries()
  const header = ['编号', ...fields, '当前状态']
  const lines = [header.map(csvCell).join(',')]
  for (const row of items) {
    lines.push(
      [row.id, ...fields.map((field) => row[field] ?? ''), row.status]
        .map(csvCell)
        .join(','),
    )
  }
  return {
    filename: `${meta ? meta.name : '管网探漏'}-清单.csv`,
    content: `﻿${lines.join('\n')}`,
  }
}

export function downloadLeakBooklet(): void {
  const { filename, content } = exportLeakBooklet()
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

// 探漏结论提交：确认处理/要求复探的最终状态只按现场探测方法判，
// 同一条记录重复提交同一结论只往结论台账记一遍。
export function submitLeakConclusion(id: number, action: string): ActionResult {
  const target = ACTION_TARGETS[action]
  if (!target) {
    return { ok: false, message: `探漏记录没有登记「${action}」这个动作` }
  }

  const rows = ensureLeakRows()
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的探漏记录` }
  }
  const row = rows[index]
  const current = String(row.status)

  if (action === '提交探测') {
    if (current === STATUS_DETECTING) {
      return { ok: false, message: '探漏记录已经在探测中，不用重复提交' }
    }
    if (current !== STATUS_PENDING) {
      return { ok: false, message: `当前状态为「${current}」，不能再提交探测` }
    }
    const updated: EntryRow = { ...row, status: STATUS_DETECTING, pending: true }
    const next = [...rows]
    next[index] = updated
    saveRows(LEAK_MODULE_KEY, next)
    return { ok: true, message: '探漏记录已提交，现场探测方法由班组统一安排' }
  }

  const conclusion = resolveLeakConclusion(row)
  if (conclusion.returned) {
    return { ok: false, message: conclusion.advice }
  }

  // 历史已处理保留原结论，不因复探类操作被改判。
  if (current === STATUS_DONE) {
    if (action === '确认处理') {
      return { ok: true, message: '已处理结论此前已提交，重提只记一遍，未重复记录' }
    }
    return { ok: false, message: '该记录为历史已处理结论，按兼容口径保留原结论，不再改判' }
  }

  if (current === STATUS_REINSPECT && action === '要求复探') {
    return { ok: true, message: '需复探结论此前已提交，重提只记一遍，未重复记录' }
  }

  if (conclusion.status !== target) {
    return {
      ok: false,
      message: `现场探测方法「${conclusion.method?.name ?? ''}」按班组统一口径应判定为「${conclusion.status}」，不能提交为「${target}」；${REINSPECT_CYCLE_NOTE}`,
    }
  }

  const updated: EntryRow = {
    ...row,
    status: target,
    pending: target !== STATUS_DONE,
  }
  const next = [...rows]
  next[index] = updated
  saveRows(LEAK_MODULE_KEY, next)

  // 结论台账按「记录 + 目标结论」去重，重复重提只记一遍。
  const journal = readJournal()
  const alreadyRecorded = journal.some(
    (entry) => entry.leakId === id && entry.target === target,
  )
  if (!alreadyRecorded) {
    journal.push({
      leakId: id,
      code: String(row['探漏编号'] ?? ''),
      segment: String(row['探测管段'] ?? ''),
      method: String(row['探测方法'] ?? ''),
      count: (row['漏点数量'] ?? '') as string | number,
      target,
      submittedAt: new Date().toLocaleString('zh-CN', { hour12: false }),
    })
    writeJournal(journal)
  }

  return {
    ok: true,
    message: `已按现场探测方法「${conclusion.method?.name ?? ''}」的班组统一口径判定为「${target}」`,
  }
}

// 探漏的复探结论反映到抢修处置的待复核清单：只取当前仍是需复探的记录。
export function listReinspectReviews(): ReinspectReview[] {
  const journal = readJournal()
  return ensureLeakRows()
    .filter((row) => String(row.status) === STATUS_REINSPECT)
    .map((row) => {
      const conclusion = resolveLeakConclusion(row)
      const recorded = journal
        .filter(
          (entry) =>
            entry.leakId === Number(row.id) && entry.target === STATUS_REINSPECT,
        )
        .slice(-1)[0]
      return {
        leakId: Number(row.id),
        code: String(row['探漏编号'] ?? ''),
        segment: String(row['探测管段'] ?? ''),
        method: String(row['探测方法'] ?? ''),
        count: (row['漏点数量'] ?? '') as string | number,
        advice: conclusion.advice.includes(REINSPECT_CYCLE_NOTE)
          ? conclusion.advice
          : `${conclusion.advice}；${REINSPECT_CYCLE_NOTE}`,
        submittedAt: recorded ? recorded.submittedAt : '',
      }
    })
}
