import { describe, expect, it } from 'vitest'
import { computeStats, delta, goalColor, margin, previousPeriod, COST_KEYS, type Ctx, type Filters, type RecRow } from './analytics'

const rec = (o: Partial<RecRow>): RecRow => ({
  id: 'r' + Math.random(), route_id: 'rt1', data: '2026-09-10', status: 'validado', viatura_id: null, motorista_ids: [], km: null,
  enc_entregues: null, enc_devolucoes: null, enc_recolhas: null, enc_canceladas: null, enc_transitadas: null,
  enc_pendentes_entrega: null, enc_pendentes_recolha: null, comb_valor: null, portagens_valor: null,
  receita_breakdown: { por_estado: 0, valor_fixo: 0, por_zona: 0, por_distancia: 0, total: 0 }, receita_total: 0, ...o,
})
const f = (o: Partial<Filters> = {}): Filters => ({ from: '2026-09-01', to: '2026-09-30', opId: 'all', routes: [], drivers: [], vehicles: [], statuses: [], ...o })
const ctx = (o: Partial<Ctx> = {}): Ctx => ({ routeOp: { rt1: 'op1', rt2: 'op2' }, distributed: {}, ...o })
const ALL = new Set(COST_KEYS)

describe('computeStats', () => {
  it('soma encomendas, km, receita e componentes', () => {
    const rows = [
      rec({ enc_entregues: 10, enc_devolucoes: 2, km: 50, receita_total: 100, receita_breakdown: { por_estado: 60, valor_fixo: 40, por_zona: 0, por_distancia: 0, total: 100 } }),
      rec({ data: '2026-09-11', enc_entregues: 5, enc_pendentes_entrega: 3, km: 30, receita_total: 50, receita_breakdown: { por_estado: 50, valor_fixo: 0, por_zona: 0, por_distancia: 0, total: 50 } }),
    ]
    const s = computeStats(rows, f(), ctx())
    expect(s.orders).toBe(20)
    expect(s.byState.entregues).toBe(15)
    expect(s.km).toBe(80)
    expect(s.revenue).toBe(150)
    expect(s.revenueParts.por_estado).toBe(110)
    expect(s.days).toHaveLength(2)
  })

  it('filtra por periodo, operacao, rota, motorista, viatura e estado (cumulativos)', () => {
    const rows = [
      rec({ receita_total: 10 }),
      rec({ data: '2026-08-31', receita_total: 1000 }),
      rec({ route_id: 'rt2', receita_total: 100 }),
      rec({ motorista_ids: ['d1'], viatura_id: 'v1', status: 'rascunho', receita_total: 1 }),
    ]
    expect(computeStats(rows, f(), ctx()).revenue).toBe(111)
    expect(computeStats(rows, f({ opId: 'op1' }), ctx()).revenue).toBe(11)
    expect(computeStats(rows, f({ routes: ['rt2'] }), ctx()).revenue).toBe(100)
    expect(computeStats(rows, f({ drivers: ['d1'] }), ctx()).revenue).toBe(1)
    expect(computeStats(rows, f({ vehicles: ['v1'], statuses: ['rascunho'] }), ctx()).revenue).toBe(1)
    expect(computeStats(rows, f({ vehicles: ['v1'], statuses: ['validado'] }), ctx()).revenue).toBe(0)
  })

  it('custos de viatura contam uma vez por viatura e dia; aluguer por periodicidade', () => {
    const vehicles = { v1: { id: 'v1', iuc_ativo: true, iuc_valor: 30, seguro_ativo: false, seguro_valor: 999, manutencao_ativo: true, manutencao_valor: 60, aluguer_custo: 70, aluguer_periodicidade: 'semanal' as const } }
    const rows = [rec({ viatura_id: 'v1' }), rec({ viatura_id: 'v1', route_id: 'rt2' }), rec({ viatura_id: 'v1', data: '2026-09-11' })]
    const s = computeStats(rows, f(), ctx({ vehicles }))
    expect(s.costs.iuc).toBeCloseTo(2) // 30/30 * 2 dias
    expect(s.costs.insurance).toBe(0) // interruptor desligado
    expect(s.costs.maintenance).toBeCloseTo(4) // 60/30 * 2 dias
    expect(s.costs.rental).toBeCloseTo(20) // 70/7 * 2 dias
  })

  it('combustivel, portagens e pagamentos distribuidos entram nos custos', () => {
    const r = rec({ comb_valor: 40, portagens_valor: 10, receita_total: 200 })
    const s = computeStats([r], f(), ctx({ distributed: { [r.id]: 25 } }))
    expect(s.costs.fuel).toBe(40)
    expect(s.costs.tolls).toBe(10)
    expect(s.costs.distributed).toBe(25)
    const m = margin(s, ALL)
    expect(m.costs).toBe(75)
    expect(m.value).toBe(125)
    expect(m.pct).toBeCloseTo(0.625)
    // o seletor de custos exclui em tempo real
    expect(margin(s, new Set(['fuel'] as const)).value).toBe(160)
  })

  it('custos fixos da operacao: rateio por dias; excluidos com filtros de rota/motorista/viatura', () => {
    const operations = { op1: { id: 'op1', salario_fixo_mensal: 3000, salario_var_por_entrega: 0.5, salario_var_pct_receita: 10, outros_custos_mensais: 300 } }
    const r = rec({ enc_entregues: 10, receita_total: 200 })
    const s = computeStats([r], f({ from: '2026-09-01', to: '2026-09-10' }), ctx({ operations }))
    // 10 dias: 3000/30*10 = 1000 + 0.5*10 + 10%*200 = 1025 ; outros 300/30*10 = 100
    expect(s.costs.salaries).toBeCloseTo(1025)
    expect(s.costs.other).toBeCloseTo(100)
    expect(s.fixedIncluded).toBe(true)
    const filtered = computeStats([r], f({ routes: ['rt1'] }), ctx({ operations }))
    expect(filtered.fixedIncluded).toBe(false)
    expect(filtered.costs.salaries).toBe(0)
  })

  it('sem permissao para custos (operations/vehicles ausentes) nao inventa custos', () => {
    const s = computeStats([rec({ viatura_id: 'v1', comb_valor: 5 })], f(), ctx())
    expect(s.costs.salaries + s.costs.iuc + s.costs.rental).toBe(0)
    expect(s.costs.fuel).toBe(5)
  })
})

describe('periodos, deltas e metas', () => {
  it('periodo anterior tem a mesma duracao', () => {
    expect(previousPeriod('2026-09-01', '2026-09-10')).toEqual({ from: '2026-08-22', to: '2026-08-31' })
  })
  it('delta', () => {
    expect(delta(150, 100)).toBeCloseTo(0.5)
    expect(delta(50, 100)).toBeCloseTo(-0.5)
    expect(delta(10, 0)).toBeNull()
  })
  it('cor da meta: vermelho <50%, ambar 50-80%, verde >80%', () => {
    expect(goalColor(0.49)).toBe('var(--negative)')
    expect(goalColor(0.5)).toBe('var(--pending)')
    expect(goalColor(0.8)).toBe('var(--pending)')
    expect(goalColor(0.81)).toBe('var(--positive)')
  })
})
