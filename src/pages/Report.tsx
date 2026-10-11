import { useMemo } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { useAuth } from '@/auth/AuthProvider'
import { useOp } from '@/components/OpContext'
import { Button, Card, ErrorNote, Spinner } from '@/components/ui'
import { supabase } from '@/lib/supabase'
import { unwrap, useRouteOptions } from '@/lib/queries'
import { buildCtx, presetRange, useDashboardData, useGoals, type Preset } from '@/lib/dashData'
import { COST_KEYS, computeStats, delta, goalColor, goalValue, margin, previousPeriod, type Filters } from '@/lib/analytics'
import { dateShort, eur, num, pct, startOfMonth, todayISO } from '@/lib/format'
import { RevenueCosts } from './Dashboard'

const ALL = new Set(COST_KEYS)
const PRESETS: Preset[] = ['thisMonth', 'lastMonth', 'last7', 'last30']

export default function Report() {
  const { t } = useTranslation()
  const [params] = useSearchParams()
  const { profile } = useAuth()
  const { ops } = useOp()
  const { data: routes = [] } = useRouteOptions()
  const preset = (PRESETS.includes(params.get('p') as Preset) ? params.get('p') : 'thisMonth') as Preset
  const opParam = params.get('op') ?? 'all'
  const opId = opParam === 'all' || ops.some((o) => o.id === opParam) ? opParam : 'all'

  const range = presetRange(preset)
  const prev = previousPeriod(range.from, range.to)
  const { data, isLoading, error } = useDashboardData(prev.from, range.to)
  const { data: goals = [] } = useGoals()
  const tenant = useQuery({ queryKey: ['tenant'], queryFn: () => unwrap<{ nome: string }>(supabase.from('tenants').select('nome').single()) })
  // fundos por reconciliar (so existe para quem le a Contabilidade; RLS devolve vazio caso contrario)
  const movements = useQuery({
    queryKey: ['movements', 'report'],
    queryFn: () => unwrap<{ id: string; data: string; valor: number; subcategoria: string; lancamento_referencia_id: string | null; pessoa_responsavel: string | null }[]>(
      supabase.from('movements').select('id,data,valor,subcategoria,lancamento_referencia_id,pessoa_responsavel').is('deleted_at', null)),
  })

  const ctx = useMemo(() => (data ? buildCtx(data, routes) : null), [data, routes])
  const f = (o: Partial<Filters> = {}): Filters => ({ ...range, opId, routes: [], drivers: [], vehicles: [], statuses: [], ...o })

  const view = useMemo(() => {
    if (!data || !ctx) return null
    const cur = computeStats(data.recs, f(), ctx)
    const old = computeStats(data.recs, f({ ...prev }), ctx)
    const perOp = ops
      .filter((o) => opId === 'all' || o.id === opId)
      .map((o) => {
        const s = computeStats(data.recs, f({ opId: o.id }), ctx)
        const rows = routes
          .filter((r) => r.operation_id === o.id)
          .map((r) => ({ r, s: computeStats(data.recs, f({ opId: o.id, routes: [r.id] }), ctx) }))
        return { o, s, m: margin(s, ALL), rows }
      })
    return { cur, old, perOp }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, ctx, routes, ops, opId, range.from, range.to])

  if (error) return <ErrorNote error={error} />
  if (isLoading || !view || !ctx || !data) return <Spinner />

  const { cur, old, perOp } = view
  const m = margin(cur, ALL)
  const mOld = margin(old, ALL)
  const chartData = cur.days.map((d) => ({ ...d, label: d.date.slice(8) + '/' + d.date.slice(5, 7) }))

  // ---- alertas ----
  const negative = perOp.filter((x) => x.m.value < 0)
  const today = todayISO()
  const monthGoals = goals
    .filter((g) => opId === 'all' || g.operation_id === opId)
    .map((g) => {
      const s = computeStats(data.recs, { from: startOfMonth(today), to: today, opId: g.operation_id, routes: g.route_id ? [g.route_id] : [], drivers: [], vehicles: [], statuses: [] }, ctx)
      return { g, v: goalValue(g.metrica, s, ALL) }
    })
  const unmet = monthGoals.filter((x) => x.v / x.g.alvo < 0.5)
  const all = movements.data ?? []
  const unreconciled = all
    .filter((x) => x.subcategoria === 'transferencia_distribuicao' && !x.lancamento_referencia_id)
    .map((x) => ({ x, left: x.valor - all.filter((a) => a.lancamento_referencia_id === x.id).reduce((s, a) => s + Number(a.valor), 0) }))
    .filter((u) => u.left > 0.005)
  const opLabel = opId === 'all' ? t('nav.allOperations') : (ops.find((o) => o.id === opId)?.nome ?? '')
  const noAlerts = negative.length + unmet.length + unreconciled.length === 0
  const kpi = (label: string, value: string, sub: string, d: number | null, up = true) => (
    <div className="rounded-xl border border-border p-3">
      <div className="text-xs text-muted">{label}</div>
      <div className="text-2xl font-bold">{value}</div>
      <div className="text-xs text-muted">
        {sub}
        {d !== null && (
          <span style={{ color: d === 0 ? 'var(--muted)' : d > 0 === up ? 'var(--positive)' : 'var(--negative)' }}>
            {' '}
            {d > 0 ? '▲' : d < 0 ? '▼' : '■'} {pct(Math.abs(d))}
          </span>
        )}
      </div>
    </div>
  )

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <div className="print-hide flex flex-wrap items-center justify-between gap-2">
        <Link to="/" className="text-sm text-brand">
          ← {t('app.back')}
        </Link>
        <Button onClick={() => window.print()}>{t('report.savePdf')}</Button>
      </div>

      <header className="border-b border-border pb-3">
        <h1 className="text-2xl font-bold">{t('report.title')}</h1>
        <p className="text-sm text-muted">
          {tenant.data?.nome} · {opLabel} · {dateShort(range.from)} – {dateShort(range.to)}
        </p>
        <p className="text-xs text-muted">
          {t('report.generatedBy', { name: profile?.nome ?? '', date: dateShort(today) })}
        </p>
      </header>

      <section className="break-inside-avoid">
        <h2 className="mb-2 text-lg font-semibold">{t('report.executive')}</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {kpi(t('dashboard.orders'), num(cur.orders), `${pct(cur.orders ? cur.byState.entregues / cur.orders : 0)} ${t('orders.entregues').toLowerCase()}`, delta(cur.orders, old.orders))}
          {kpi(t('dashboard.revenue'), eur(cur.revenue, 0), `${num(cur.km)} km`, delta(cur.revenue, old.revenue))}
          {kpi(t('dashboard.costs'), eur(m.costs, 0), `${pct(cur.revenue ? m.costs / cur.revenue : 0)} ${t('dashboard.revenue').toLowerCase()}`, delta(m.costs, mOld.costs), false)}
          {kpi(t('dashboard.margin'), eur(m.value, 0), pct(m.pct), delta(m.value, mOld.value))}
        </div>
        <p className="mt-1 text-xs text-muted">{t('dashboard.vsPrev')}: {dateShort(prev.from)} – {dateShort(prev.to)}</p>
      </section>

      <section className="break-inside-avoid">
        <h2 className="mb-2 text-lg font-semibold">{t('dashboard.revenueVsCosts')}</h2>
        <RevenueCosts data={chartData} />
      </section>

      <section>
        <h2 className="mb-2 text-lg font-semibold">{t('report.byOperation')}</h2>
        {perOp.map(({ o, s, m: om, rows }) => (
          <Card key={o.id} className="mb-3 break-inside-avoid p-0">
            <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border px-4 py-2">
              <b>{o.nome}</b>
              <span className="text-sm">
                {t('dashboard.revenue')} {eur(s.revenue)} · {t('dashboard.costs')} {eur(om.costs)} ·{' '}
                <b style={{ color: om.value >= 0 ? 'var(--positive)' : 'var(--negative)' }}>
                  {t('dashboard.margin')} {eur(om.value)} ({pct(om.pct)})
                </b>
              </span>
            </div>
            <table className="w-full text-sm">
              <thead className="text-left text-muted">
                <tr>
                  <th className="px-4 py-1.5 font-medium">{t('register.route')}</th>
                  <th className="px-2 py-1.5 text-right font-medium">{t('dashboard.orders')}</th>
                  <th className="px-2 py-1.5 text-right font-medium">{t('dashboard.km')}</th>
                  <th className="px-2 py-1.5 text-right font-medium">{t('dashboard.revenue')}</th>
                  <th className="px-4 py-1.5 text-right font-medium">{t('report.directCosts')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map(({ r, s: rs }) => (
                  <tr key={r.id}>
                    <td className="px-4 py-1.5">{r.nome}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{num(rs.orders)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{num(rs.km)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{eur(rs.revenue)}</td>
                    <td className="px-4 py-1.5 text-right tabular-nums">{eur(COST_KEYS.reduce((a, k) => a + rs.costs[k], 0))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        ))}
        <p className="text-xs text-muted">{t('report.directCostsNote')}</p>
      </section>

      <section className="break-inside-avoid">
        <h2 className="mb-2 text-lg font-semibold">{t('report.alerts')}</h2>
        {noAlerts ? (
          <p className="text-sm text-muted">{t('report.noAlerts')}</p>
        ) : (
          <ul className="space-y-2 text-sm">
            {negative.map(({ o, m: om }) => (
              <li key={o.id} className="flex items-center gap-2">
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: 'var(--negative)' }} />
                {t('report.negativeMargin', { op: o.nome, value: eur(om.value) })}
              </li>
            ))}
            {unmet.map(({ g, v }) => (
              <li key={g.id} className="flex items-center gap-2">
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: goalColor(v / g.alvo) }} />
                {t('report.goalBehind', { name: g.route_id ? (routes.find((r) => r.id === g.route_id)?.nome ?? '') : (ops.find((o) => o.id === g.operation_id)?.nome ?? ''), metric: t(`dashboard.${g.metrica === 'receita' ? 'revenue' : g.metrica === 'margem' ? 'margin' : 'orders'}`), pct: pct(v / g.alvo, 0) })}
              </li>
            ))}
            {unreconciled.map(({ x, left }) => (
              <li key={x.id} className="flex items-center gap-2">
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: 'var(--pending)' }} />
                {t('report.unreconciled', { person: x.pessoa_responsavel ?? '—', value: eur(left), date: dateShort(x.data) })}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
