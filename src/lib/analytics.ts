import { ORDER_STATES, type Breakdown, type OrderState, type RecordStatus } from './types'
import { addDays, daysBetween } from './format'

/** Custos mensais (IUC, seguro, manutencao, aluguer mensal, salarios, outros) sao rateados por dias sobre 30. */
export const DAYS_IN_MONTH = 30

export const COST_KEYS = ['fuel', 'tolls', 'iuc', 'insurance', 'salaries', 'maintenance', 'other', 'rental', 'distributed'] as const
export type CostKey = (typeof COST_KEYS)[number]

export const COST_COLOR: Record<CostKey, string> = {
  fuel: 'var(--cost-fuel)',
  tolls: 'var(--cost-tolls)',
  iuc: 'var(--cost-iuc)',
  insurance: 'var(--cost-insurance)',
  salaries: 'var(--cost-salaries)',
  maintenance: 'var(--cost-maintenance)',
  other: 'var(--cost-other)',
  rental: 'var(--cost-rental)',
  distributed: 'var(--cost-other)',
}

export interface RecRow {
  id: string
  route_id: string
  data: string
  status: RecordStatus
  viatura_id: string | null
  motorista_ids: string[]
  km: number | null
  enc_entregues: number | null
  enc_devolucoes: number | null
  enc_recolhas: number | null
  enc_canceladas: number | null
  enc_transitadas: number | null
  enc_pendentes_entrega: number | null
  enc_pendentes_recolha: number | null
  comb_valor: number | null
  portagens_valor: number | null
  receita_breakdown: Breakdown
  receita_total: number
}

export interface VehicleCost {
  id: string
  iuc_ativo: boolean
  iuc_valor: number
  seguro_ativo: boolean
  seguro_valor: number
  manutencao_ativo: boolean
  manutencao_valor: number
  aluguer_custo: number | null
  aluguer_periodicidade: 'diario' | 'semanal' | 'mensal' | null
}

export interface OpCost {
  id: string
  salario_fixo_mensal: number
  salario_var_por_entrega: number
  salario_var_pct_receita: number
  outros_custos_mensais: number
}

export interface Ctx {
  routeOp: Record<string, string>
  vehicles?: Record<string, VehicleCost> // ausente = sem permissao para ver custos de viaturas
  operations?: Record<string, OpCost> // ausente = sem permissao para ver custos fixos
  /** soma das linhas de custo (ex.: pagamentos distribuidos) por registo */
  distributed: Record<string, number>
}

export interface Filters {
  from: string
  to: string
  opId: string | 'all'
  routes: string[]
  drivers: string[]
  vehicles: string[]
  statuses: RecordStatus[]
}

export interface DayPoint { date: string; revenue: number; costs: number; orders: number; delivered: number }

export interface Stats {
  orders: number
  byState: Record<OrderState, number>
  km: number
  revenue: number
  revenueParts: Omit<Breakdown, 'total'>
  costs: Record<CostKey, number>
  days: DayPoint[]
  /** false quando ha filtros que impedem atribuir custos fixos (salarios/outros) */
  fixedIncluded: boolean
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)
const n = (x: number | null | undefined) => x ?? 0

export const ordersOf = (r: RecRow): Record<OrderState, number> => ({
  entregues: n(r.enc_entregues),
  devolucoes: n(r.enc_devolucoes),
  recolhas: n(r.enc_recolhas),
  canceladas: n(r.enc_canceladas),
  transitadas: n(r.enc_transitadas),
  pendentes_entrega: n(r.enc_pendentes_entrega),
  pendentes_recolha: n(r.enc_pendentes_recolha),
})

export function filterRecords(rows: RecRow[], f: Filters, ctx: Ctx): RecRow[] {
  return rows.filter(
    (r) =>
      r.data >= f.from &&
      r.data <= f.to &&
      (f.opId === 'all' || ctx.routeOp[r.route_id] === f.opId) &&
      (f.routes.length === 0 || f.routes.includes(r.route_id)) &&
      (f.drivers.length === 0 || r.motorista_ids.some((d) => f.drivers.includes(d))) &&
      (f.vehicles.length === 0 || (r.viatura_id !== null && f.vehicles.includes(r.viatura_id))) &&
      (f.statuses.length === 0 || f.statuses.includes(r.status)),
  )
}

export function computeStats(all: RecRow[], f: Filters, ctx: Ctx): Stats {
  const rows = filterRecords(all, f, ctx)
  const byState = Object.fromEntries(ORDER_STATES.map((s) => [s, 0])) as Record<OrderState, number>
  const costs = Object.fromEntries(COST_KEYS.map((k) => [k, 0])) as Record<CostKey, number>
  const parts = { por_estado: 0, valor_fixo: 0, por_zona: 0, por_distancia: 0 }
  const perDay = new Map<string, DayPoint>()
  const day = (d: string) => {
    let p = perDay.get(d)
    if (!p) perDay.set(d, (p = { date: d, revenue: 0, costs: 0, orders: 0, delivered: 0 }))
    return p
  }
  const seenVehicleDay = new Set<string>()
  let km = 0
  let revenue = 0

  for (const r of rows) {
    const o = ordersOf(r)
    const p = day(r.data)
    for (const s of ORDER_STATES) byState[s] += o[s]
    const tot = sum(Object.values(o))
    p.orders += tot
    p.delivered += o.entregues
    km += n(r.km)
    revenue += r.receita_total
    p.revenue += r.receita_total
    for (const k of Object.keys(parts) as (keyof typeof parts)[]) parts[k] += n(r.receita_breakdown?.[k])

    const add = (k: CostKey, v: number, d = r.data) => {
      costs[k] += v
      day(d).costs += v
    }
    add('fuel', n(r.comb_valor))
    add('tolls', n(r.portagens_valor))
    add('distributed', n(ctx.distributed[r.id]))

    // custos de viatura: uma vez por viatura e dia de utilizacao
    const v = r.viatura_id && ctx.vehicles?.[r.viatura_id]
    if (v && r.viatura_id) {
      const key = `${r.viatura_id}|${r.data}`
      if (!seenVehicleDay.has(key)) {
        seenVehicleDay.add(key)
        if (v.iuc_ativo) add('iuc', v.iuc_valor / DAYS_IN_MONTH)
        if (v.seguro_ativo) add('insurance', v.seguro_valor / DAYS_IN_MONTH)
        if (v.manutencao_ativo) add('maintenance', v.manutencao_valor / DAYS_IN_MONTH)
        if (v.aluguer_custo) {
          const div = v.aluguer_periodicidade === 'semanal' ? 7 : v.aluguer_periodicidade === 'mensal' ? DAYS_IN_MONTH : 1
          add('rental', v.aluguer_custo / div)
        }
      }
    }
  }

  // custos fixos gerais da operacao: so quando nao ha filtros de rota/motorista/viatura
  const fixedIncluded = Boolean(ctx.operations) && f.routes.length === 0 && f.drivers.length === 0 && f.vehicles.length === 0
  if (fixedIncluded && ctx.operations) {
    const nDays = Math.max(1, daysBetween(f.from, f.to) + 1)
    const ops = Object.values(ctx.operations).filter((o) => f.opId === 'all' || o.id === f.opId)
    for (const op of ops) {
      const opRows = rows.filter((r) => ctx.routeOp[r.route_id] === op.id)
      const opRevenue = sum(opRows.map((r) => r.receita_total))
      const opDelivered = sum(opRows.map((r) => n(r.enc_entregues)))
      const fixedPerDay = op.salario_fixo_mensal / DAYS_IN_MONTH
      const otherPerDay = op.outros_custos_mensais / DAYS_IN_MONTH
      costs.salaries += fixedPerDay * nDays + op.salario_var_por_entrega * opDelivered + (op.salario_var_pct_receita / 100) * opRevenue
      costs.other += otherPerDay * nDays
      for (let i = 0; i < nDays; i++) day(addDays(f.from, i)).costs += fixedPerDay + otherPerDay
      for (const r of opRows) day(r.data).costs += op.salario_var_por_entrega * n(r.enc_entregues) + (op.salario_var_pct_receita / 100) * r.receita_total
    }
  }

  return {
    orders: sum(Object.values(byState)),
    byState,
    km,
    revenue,
    revenueParts: parts,
    costs,
    days: [...perDay.values()].sort((a, b) => (a.date < b.date ? -1 : 1)),
    fixedIncluded,
  }
}

export const totalCosts = (s: Stats, include: ReadonlySet<CostKey>) => COST_KEYS.filter((k) => include.has(k)).reduce((a, k) => a + s.costs[k], 0)

export const margin = (s: Stats, include: ReadonlySet<CostKey>) => {
  const c = totalCosts(s, include)
  return { value: s.revenue - c, pct: s.revenue > 0 ? (s.revenue - c) / s.revenue : 0, costs: c }
}

/** Periodo imediatamente anterior, com a mesma duracao. */
export function previousPeriod(from: string, to: string) {
  const len = daysBetween(from, to) + 1
  return { from: addDays(from, -len), to: addDays(from, -1) }
}

export const delta = (cur: number, prev: number): number | null => (prev === 0 ? null : (cur - prev) / Math.abs(prev))

export type GoalMetric = 'receita' | 'encomendas' | 'margem'
export function goalValue(metric: GoalMetric, s: Stats, include: ReadonlySet<CostKey>): number {
  return metric === 'receita' ? s.revenue : metric === 'encomendas' ? s.orders : margin(s, include).value
}
/** cor da barra: vermelho <50%, ambar 50-80%, verde >80% */
export const goalColor = (ratio: number) => (ratio < 0.5 ? 'var(--negative)' : ratio <= 0.8 ? 'var(--pending)' : 'var(--positive)')
