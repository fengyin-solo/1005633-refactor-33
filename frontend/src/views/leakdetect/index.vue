<template>
  <section class="page" data-module="leakdetect">
    <header class="page-head">
      <div>
        <h2>管网探漏管理</h2>
        <p class="page-desc">维护探漏记录，围绕探漏编号、探测管段、探测方法、漏点数量做登记、筛选与状态流转。现场探测方法与复探周期由探漏班组统一。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记探漏记录</button>
        <button class="btn" type="button" @click="exportRows">导出管网探漏清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <section v-if="returnedRows.length" class="returned-block">
      <h3>先退回核对的探漏记录（{{ returnedRows.length }}）</h3>
      <p class="returned-hint">漏点数量无效或现场探测方法不在班组统一目录内，不进清单正文，也不进导出册子：</p>
      <ul class="returned-list">
        <li v-for="row in returnedRows" :key="`returned-${String(row.id)}`">
          {{ row['探漏编号'] }}｜{{ row['探测管段'] }}｜{{ row.退回原因 }}
        </li>
      </ul>
    </section>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ displayCell(row, column) }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无管网探漏数据，可先登记探漏记录</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条管网探漏记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { moduleMeta } from '@/api/local-service'
import {
  downloadLeakBooklet,
  listLeakEntries,
  submitLeakConclusion,
  type LeakViewRow,
} from '@/data/leakdetect'

const meta = moduleMeta('leakdetect')
const columns = ["探漏编号", "探测管段", "探测方法", "漏点数量", "漏点位置", "处理建议", "探测日期", "探漏状态"]
const adviceColumn = '处理建议'
const actions = ["提交探测", "确认处理", "要求复探"]
const statuses = ["待探测", "探测中", "已处理", "需复探"]
const stats = [{"label": "待探测管段", "value": 0}, {"label": "探测中管段", "value": 0}, {"label": "本月漏点数", "value": 0}]

const rows = ref<LeakViewRow[]>([])
const returnedRows = ref<LeakViewRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

// 处理建议列统一用领域层的判定结果（resolveLeakConclusion），其它列沿用既有字段口径。
function displayCell(row: LeakViewRow, column: string) {
  if (column === adviceColumn) {
    return row[adviceColumn]
  }
  return row[column] ?? '—'
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadLeakBooklet()
}

function openCreate() {
  errorMessage.value = '探漏记录登记入口尚未接入审批流'
}

function runAction(action: string, row: LeakViewRow) {
  errorMessage.value = ''
  const result = submitLeakConclusion(Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  errorMessage.value = result.message
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listLeakEntries(filters.value)
    rows.value = payload.items
    returnedRows.value = payload.returned
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '管网探漏列表读取失败'
  }
}

onMounted(reload)
</script>
