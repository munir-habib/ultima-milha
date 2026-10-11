import type { TFunction } from 'i18next'
import type { Workbook, Worksheet } from 'exceljs'
import { ORDER_STATES } from './types'
import { COST_KEYS, ordersOf, type RecRow, type Stats } from './analytics'
import { todayISO } from './format'

/** Nome de ficheiro seguro: "Lisboa Norte" -> "Lisboa_Norte" */
const safe = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9-]+/g, '_').replace(/^_+|_+$/g, '') || 'Export'
export const fileName = (base: string, suffix = '') => `${safe(base)}_${todayISO()}${suffix}.xlsx`

async function save(name: string, build: (wb: Workbook) => void) {
  const { Workbook } = await import('exceljs') // carregado so quando se exporta
  const wb = new Workbook()
  wb.creator = 'Última Milha'
  wb.created = new Date()
  build(wb)
  const buf = await wb.xlsx.writeBuffer()
  const url = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}

function table(ws: Worksheet, headers: string[], rows: (string | number | null)[][], money: number[] = []) {
  ws.addRow(headers).font = { bold: true }
  ws.getRow(1).border = { bottom: { style: 'thin' } }
  for (const r of rows) ws.addRow(r)
  for (const c of money) ws.getColumn(c + 1).numFmt = '#,##0.00 [$€-x-euro2]'
  ws.columns.forEach((col, i) => {
    const w = Math.max(headers[i]?.length ?? 8, ...rows.slice(0, 200).map((r) => String(r[i] ?? '').length))
    col.width = Math.min(40, w + 2)
  })
  ws.views = [{ state: 'frozen', ySplit: 1 }]
}

export interface DashboardExport {
  t: TFunction
  /** nome da operacao filtrada, ou null = todas (uma folha por operacao) */
  opName: string | null
  period: { from: string; to: string }
  records: (RecRow & { op: string })[]
  route: Record<string, string>
  vehicle: Record<string, string>
  driver: Record<string, string>
  stats: Stats
  margin: { value: number; pct: number; costs: number }
}

export async function exportDashboard(d: DashboardExport) {
  const { t } = d
  const name = fileName(d.opName ?? t('nav.allOperations'))
  await save(name, (wb) => {
    // Resumo
    const s = wb.addWorksheet(t('export.summary'))
    table(
      s,
      [t('export.metric'), t('export.value')],
      [
        [t('dashboard.period'), `${d.period.from} → ${d.period.to}`],
        [t('dashboard.orders'), d.stats.orders],
        ...ORDER_STATES.map((k) => [t(`orders.${k}`), d.stats.byState[k]] as (string | number)[]),
        [t('dashboard.km'), d.stats.km],
        [t('dashboard.revenue'), d.stats.revenue],
        ...(['por_estado', 'valor_fixo', 'por_zona', 'por_distancia'] as const).map((k) => [`  ${t(`dashboard.components.${k}`)}`, d.stats.revenueParts[k]] as (string | number)[]),
        ...COST_KEYS.map((k) => [`${t('dashboard.costs')} — ${t(`dashboard.cost.${k}`)}`, d.stats.costs[k]] as (string | number)[]),
        [t('dashboard.costs'), d.margin.costs],
        [t('dashboard.margin'), d.margin.value],
        [`${t('dashboard.margin')} %`, Math.round(d.margin.pct * 10000) / 100],
      ],
    )
    s.getColumn(2).numFmt = '#,##0.00'

    // Registos (uma folha por operacao quando "todas")
    const ops = d.opName ? [d.opName] : [...new Set(d.records.map((r) => r.op))].sort()
    for (const op of ops.length ? ops : [d.opName ?? '—']) {
      const ws = wb.addWorksheet(safe(op).slice(0, 28) || 'Registos')
      const rows = d.records
        .filter((r) => !d.opName ? r.op === op : true)
        .sort((a, b) => (a.data < b.data ? -1 : 1))
        .map((r) => {
          const o = ordersOf(r)
          return [
            r.data,
            d.route[r.route_id] ?? '',
            t(`status.${r.status}`),
            r.viatura_id ? d.vehicle[r.viatura_id] ?? '' : '',
            r.motorista_ids.map((m) => d.driver[m] ?? '').join(', '),
            r.km,
            ...ORDER_STATES.map((k) => o[k]),
            r.receita_breakdown?.por_estado ?? 0,
            r.receita_breakdown?.valor_fixo ?? 0,
            r.receita_breakdown?.por_zona ?? 0,
            r.receita_breakdown?.por_distancia ?? 0,
            r.receita_total,
            r.comb_valor,
            r.portagens_valor,
          ] as (string | number | null)[]
        })
      const base = 6 + ORDER_STATES.length
      table(
        ws,
        [t('register.date'), t('register.route'), t('fleet.state'), t('register.vehicle'), t('register.drivers'), t('register.km'), ...ORDER_STATES.map((k) => t(`orders.${k}`)),
          ...(['por_estado', 'valor_fixo', 'por_zona', 'por_distancia'] as const).map((k) => t(`dashboard.components.${k}`)), t('dashboard.revenue'), t('register.fuel'), t('register.tolls')],
        rows,
        [base, base + 1, base + 2, base + 3, base + 4, base + 5, base + 6],
      )
    }
  })
}

export interface AccountingExportRow {
  data: string
  conta: string
  tipo: string
  valor: number
  categoria: string
  rota: string
  estado: string
  origem: string
  descricao: string
  pessoa: string
  subcategoria: string
}

/** Colunas: as 8 exigidas (Data, Conta, Tipo, Valor, Categoria/Origem, Rota, Estado, Origem) + Descricao, Pessoa e Subcategoria (para casar com o extrato bancario). */
export function accountingTable(t: TFunction, rows: AccountingExportRow[]) {
  return {
    headers: [t('register.date'), t('accounting.account'), t('accounting.type'), t('register.amount'), t('export.categoryOrigin'), t('register.route'), t('fleet.state'), t('export.origin'), t('accounting.description'), t('accounting.person'), t('accounting.subcategory')],
    rows: rows.map((r) => [r.data, r.conta, r.tipo, r.valor, r.categoria, r.rota, r.estado, r.origem, r.descricao, r.pessoa, r.subcategoria] as (string | number | null)[]),
  }
}

/** Contabilidade_AAAA-MM-DD.xlsx — exporta a vista e os filtros atuais. */
/** `partial`: so ha parte dos movimentos carregada (teto): o ficheiro NAO pode parecer completo (nome _PARCIAL + folha de aviso). */
export async function exportAccounting(t: TFunction, rows: AccountingExportRow[], partial?: { shown: number; total: number | string }) {
  await save(fileName('Contabilidade', partial ? '_PARCIAL' : ''), (wb) => {
    if (partial) {
      const aviso = wb.addWorksheet(t('accounting.partialSheet'))
      aviso.addRow([t('accounting.truncated', { shown: partial.shown, total: partial.total })]).font = { bold: true, color: { argb: 'FFB91C1C' } }
      aviso.getColumn(1).width = 110
    }
    const ws = wb.addWorksheet(t('accounting.title'))
    const { headers, rows: body } = accountingTable(t, rows)
    table(ws, headers, body, [3])
  })
}
