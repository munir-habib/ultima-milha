import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { fetchAllPages, type Page } from './paginate'
import { unwrap } from '@/lib/queries'
import type { Ctx, GoalMetric, RecRow } from '@/lib/analytics'
import type { RouteOption } from '@/lib/types'
import { addDays, startOfMonth, todayISO } from '@/lib/format'

export type Preset = 'thisMonth' | 'lastMonth' | 'last7' | 'last30'

export function presetRange(p: Preset): { from: string; to: string } {
  const today = todayISO()
  if (p === 'thisMonth') return { from: startOfMonth(today), to: today }
  if (p === 'last7') return { from: addDays(today, -6), to: today }
  if (p === 'last30') return { from: addDays(today, -29), to: today }
  const lastOfPrev = addDays(startOfMonth(today), -1)
  return { from: startOfMonth(lastOfPrev), to: lastOfPrev }
}

export interface RawRec extends RecRow {
  daily_record_costs: { valor: number; deleted_at: string | null }[]
}

const REC_COLS =
  'id,route_id,data,status,viatura_id,motorista_ids,km,enc_entregues,enc_devolucoes,enc_recolhas,enc_canceladas,enc_transitadas,enc_pendentes_entrega,enc_pendentes_recolha,comb_valor,portagens_valor,receita_breakdown,receita_total,daily_record_costs(valor,deleted_at)'

export function useDashboardData(from: string, to: string) {
  return useQuery({
    queryKey: ['records', 'dash', from, to],
    placeholderData: (prev) => prev, // sem flash de skeleton ao refazer o pedido
    queryFn: async () => {
      const [recs, vehicles, ops] = await Promise.all([
        // por paginas: o PostgREST devolve no maximo 1000 linhas por pedido (um .limit(20000) sozinho truncava em silencio)
        fetchAllPages<RawRec>(
          (a, b, wantCount) =>
            supabase.from('daily_records').select(REC_COLS, wantCount ? { count: 'exact' } : undefined).gte('data', from).lte('data', to).is('deleted_at', null)
              .order('data').order('id').range(a, b) as unknown as PromiseLike<Page<RawRec>>,
          20000,
          undefined,
          (r) => r.id,
        ).then((r) => r.rows),
        unwrap<NonNullable<Ctx['vehicles']>[string][]>(
          supabase.from('vehicles').select('id,iuc_ativo,iuc_valor,seguro_ativo,seguro_valor,manutencao_ativo,manutencao_valor,aluguer_custo,aluguer_periodicidade').is('deleted_at', null),
        ),
        unwrap<NonNullable<Ctx['operations']>[string][]>(
          supabase.from('operations').select('id,salario_fixo_mensal,salario_var_por_entrega,salario_var_pct_receita,outros_custos_mensais').is('deleted_at', null),
        ),
      ])
      return { recs, vehicles, ops }
    },
  })
}

export function useGoals() {
  return useQuery({
    queryKey: ['goals'],
    queryFn: () => unwrap<{ id: string; operation_id: string; route_id: string | null; metrica: GoalMetric; alvo: number }[]>(supabase.from('goals').select('id,operation_id,route_id,metrica,alvo').is('deleted_at', null)),
  })
}

/** Contexto de calculo (custos so existem se o papel os puder ler; RLS devolve vazio caso contrario). */
export function buildCtx(data: { recs: RawRec[]; vehicles: NonNullable<Ctx['vehicles']>[string][]; ops: NonNullable<Ctx['operations']>[string][] }, routes: RouteOption[]): Ctx {
  return {
    routeOp: Object.fromEntries(routes.map((r) => [r.id, r.operation_id])),
    vehicles: data.vehicles.length ? Object.fromEntries(data.vehicles.map((v) => [v.id, v])) : undefined,
    operations: data.ops.length ? Object.fromEntries(data.ops.map((o) => [o.id, o])) : undefined,
    distributed: Object.fromEntries(data.recs.map((r) => [r.id, r.daily_record_costs.filter((c) => !c.deleted_at).reduce((a, c) => a + Number(c.valor), 0)])),
  }
}
