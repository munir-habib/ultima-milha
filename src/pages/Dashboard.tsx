import { useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Bar, CartesianGrid, Cell, ComposedChart, Legend, Line, LineChart, LabelList, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import clsx from 'clsx'
import { useOp } from '@/components/OpContext'
import { Button, Card, ErrorNote, PageTitle, Pill, Sheet, Spinner } from '@/components/ui'
import { useDriverOptions, useRouteOptions, useVehicleOptions } from '@/lib/queries'
import { buildCtx, presetRange, useDashboardData, useGoals, type Preset, type RawRec } from '@/lib/dashData'
import { exportDashboard } from '@/lib/export'
import { filterRecords } from '@/lib/analytics'
import { useNavigate } from 'react-router-dom'
import { COST_COLOR, COST_KEYS, computeStats, delta, goalColor, goalValue, margin, previousPeriod, totalCosts, type CostKey, type Ctx, type Filters, type GoalMetric, type Stats } from '@/lib/analytics'
import { ORDER_STATES, type OrderState, type RecordStatus } from '@/lib/types'
import { dateShort, eur, num, pct, startOfMonth, todayISO } from '@/lib/format'

export default function Dashboard() {
  const { t } = useTranslation()
  const { opId, ops } = useOp()
  const nav = useNavigate()
  const [exporting, setExporting] = useState(false)
  const { data: routes = [] } = useRouteOptions()
  const { data: drivers = [] } = useDriverOptions()
  const { data: vehiclesOpt = [] } = useVehicleOptions()

  const [preset, setPreset] = useState<Preset>('thisMonth')
  const [fRoutes, setRoutes] = useState<string[]>([])
  const [fDrivers, setDrivers] = useState<string[]>([])
  const [fVehicles, setVehicles] = useState<string[]>([])
  const [fStatus, setStatus] = useState<RecordStatus[]>([])
  const [include, setInclude] = useState<ReadonlySet<CostKey>>(new Set(COST_KEYS))
  const [costSheet, setCostSheet] = useState(false)
  const [showTable, setShowTable] = useState(false)
  const [goalDetail, setGoalDetail] = useState<string | null>(null)

  const range = presetRange(preset)
  const prev = previousPeriod(range.from, range.to)
  const { data, isLoading, error, isFetching } = useDashboardData(prev.from, range.to)
  const { data: goals = [] } = useGoals()

  const ctx: Ctx | null = useMemo(() => (data ? buildCtx(data, routes) : null), [data, routes])

  const filters: Filters = { ...range, opId, routes: fRoutes, drivers: fDrivers, vehicles: fVehicles, statuses: fStatus }
  const cur = useMemo(() => (data && ctx ? computeStats(data.recs, filters, ctx) : null), [data, ctx, range.from, range.to, opId, fRoutes, fDrivers, fVehicles, fStatus]) // eslint-disable-line react-hooks/exhaustive-deps
  const old = useMemo(() => (data && ctx ? computeStats(data.recs, { ...filters, ...prev }, ctx) : null), [data, ctx, prev.from, prev.to, opId, fRoutes, fDrivers, fVehicles, fStatus]) // eslint-disable-line react-hooks/exhaustive-deps

  const anyFilter = fRoutes.length + fDrivers.length + fVehicles.length + fStatus.length > 0
  const clear = () => {
    setRoutes([])
    setDrivers([])
    setVehicles([])
    setStatus([])
  }
  const toggle = <T,>(list: T[], set: (v: T[]) => void, v: T) => set(list.includes(v) ? list.filter((x) => x !== v) : [...list, v])

  const routeChoices = routes.filter((r) => opId === 'all' || r.operation_id === opId)
  const chartData = useMemo(() => {
    if (!cur) return []
    return cur.days.map((d) => ({ ...d, label: d.date.slice(8) + '/' + d.date.slice(5, 7), rate: d.orders > 0 ? d.delivered / d.orders : null }))
  }, [cur])

  if (error) return <ErrorNote error={error} />
  if (isLoading || !data || !cur || !old || !ctx) return <Spinner />

  const m = margin(cur, include)
  const mOld = margin(old, include)
  const deliveryRate = cur.orders > 0 ? cur.byState.entregues / cur.orders : 0
  const costPct = cur.revenue > 0 ? m.costs / cur.revenue : 0

  const exportXlsx = async () => {
    setExporting(true)
    try {
      const opName = (routeId: string) => ops.find((o) => o.id === ctx.routeOp[routeId])?.nome ?? '—'
      await exportDashboard({
        t,
        opName: opId === 'all' ? null : (ops.find((o) => o.id === opId)?.nome ?? null),
        period: range,
        records: filterRecords(data.recs, filters, ctx).map((r) => ({ ...r, op: opName(r.route_id) })),
        route: Object.fromEntries(routes.map((r) => [r.id, r.nome])),
        vehicle: Object.fromEntries(vehiclesOpt.map((v) => [v.id, v.matricula])),
        driver: Object.fromEntries(drivers.map((d) => [d.id, d.nome])),
        stats: cur,
        margin: m,
      })
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className={clsx('space-y-4 transition-opacity', isFetching && 'opacity-70')}>
      <PageTitle
        action={
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="ghost" onClick={() => setCostSheet(true)}>
              {t('dashboard.costsSelector')} ({include.size}/{COST_KEYS.length})
            </Button>
            <Button variant="ghost" disabled={exporting} onClick={() => void exportXlsx()}>
              {t('export.excel')}
            </Button>
            <Button onClick={() => nav(`/relatorio?p=${preset}${opId !== 'all' ? `&op=${opId}` : ''}`)}>{t('report.generate')}</Button>
          </div>
        }
      >
        {t('dashboard.title')}
      </PageTitle>

      {/* Filtros: uma so linha acima de tudo o que filtram */}
      <Card className="space-y-3">
        <div className="flex flex-wrap gap-2">
          {(['thisMonth', 'lastMonth', 'last7', 'last30'] as Preset[]).map((p) => (
            <Pill key={p} active={preset === p} onClick={() => setPreset(p)}>
              {t(`dashboard.${p}`)}
            </Pill>
          ))}
        </div>
        <details className="group" open={anyFilter}>
          <summary className="flex min-h-9 cursor-pointer items-center justify-between text-sm text-muted">
            <span>{t('dashboard.filters')}</span>
            {anyFilter && (
              <button
                type="button"
                className="text-brand"
                onClick={(e) => {
                  e.preventDefault()
                  clear()
                }}
              >
                {t('app.clearFilters')}
              </button>
            )}
          </summary>
          <div className="mt-2 space-y-3">
            <FilterRow label={t('dashboard.route')}>
              {routeChoices.map((r) => (
                <Pill key={r.id} active={fRoutes.includes(r.id)} onClick={() => toggle(fRoutes, setRoutes, r.id)}>
                  {r.nome}
                </Pill>
              ))}
            </FilterRow>
            {drivers.length > 0 && (
              <FilterRow label={t('dashboard.driver')}>
                {drivers.map((d) => (
                  <Pill key={d.id} active={fDrivers.includes(d.id)} onClick={() => toggle(fDrivers, setDrivers, d.id)}>
                    {d.nome}
                  </Pill>
                ))}
              </FilterRow>
            )}
            {vehiclesOpt.length > 0 && (
              <FilterRow label={t('dashboard.vehicle')}>
                {vehiclesOpt.map((v) => (
                  <Pill key={v.id} active={fVehicles.includes(v.id)} onClick={() => toggle(fVehicles, setVehicles, v.id)}>
                    {v.matricula}
                  </Pill>
                ))}
              </FilterRow>
            )}
            <FilterRow label={t('dashboard.state')}>
              {(['rascunho', 'submetido', 'validado'] as RecordStatus[]).map((s) => (
                <Pill key={s} active={fStatus.includes(s)} onClick={() => toggle(fStatus, setStatus, s)}>
                  {t(`status.${s}`)}
                </Pill>
              ))}
            </FilterRow>
          </div>
        </details>
        <div className="text-xs text-muted">
          {dateShort(range.from)} – {dateShort(range.to)} · {t('dashboard.vsPrev')}: {dateShort(prev.from)} – {dateShort(prev.to)}
        </div>
      </Card>

      {/* KPIs */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat label={t('dashboard.orders')} value={num(cur.orders)} sub={`${pct(deliveryRate)} ${t('orders.entregues').toLowerCase()}`} d={delta(cur.orders, old.orders)} />
        <Stat label={t('dashboard.km')} value={num(cur.km)} sub={cur.orders ? `${num(cur.km / cur.orders, 1)} km${t('dashboard.perOrder')}` : '—'} d={delta(cur.km, old.km)} />
        <Stat label={t('dashboard.revenue')} value={eur(cur.revenue, 0)} color="var(--revenue)" sub={cur.orders ? `${eur(cur.revenue / cur.orders)}${t('dashboard.perOrder')}` : '—'} d={delta(cur.revenue, old.revenue)} />
        <Stat label={t('dashboard.costs')} value={eur(m.costs, 0)} sub={`${pct(costPct)} ${t('dashboard.revenue').toLowerCase()}`} d={delta(m.costs, mOld.costs)} upIsGood={false} />
        <Stat
          label={t('dashboard.margin')}
          value={eur(m.value, 0)}
          color={m.value >= 0 ? 'var(--positive)' : 'var(--negative)'}
          sub={pct(m.pct)}
          d={delta(m.value, mOld.value)}
          className="col-span-2 lg:col-span-1"
        />
      </div>

      {/* Estado das encomendas + receita por componente */}
      <div className="grid gap-3 md:grid-cols-2">
        <Card>
          <h2 className="mb-3 font-semibold">{t('dashboard.volumeByState')}</h2>
          <StateVolume stats={cur} />
        </Card>
        <Card>
          <h2 className="mb-3 font-semibold">{t('dashboard.revenueBreakdown')}</h2>
          <ul className="space-y-2 text-sm">
            {(Object.keys(cur.revenueParts) as (keyof Stats['revenueParts'])[]).map((k) => (
              <li key={k} className="flex items-center justify-between">
                <span>{t(`dashboard.components.${k}`)}</span>
                <span className="text-right">
                  <span className="font-semibold tabular-nums">{eur(cur.revenueParts[k])}</span>
                  <span className="ml-2 text-xs text-muted">{pct(cur.revenue > 0 ? cur.revenueParts[k] / cur.revenue : 0)}</span>
                </span>
              </li>
            ))}
          </ul>
          <h2 className="mb-2 mt-4 font-semibold">{t('dashboard.costs')}</h2>
          <ul className="space-y-2 text-sm">
            {COST_KEYS.filter((k) => cur.costs[k] > 0).map((k) => (
              <li key={k} className={clsx('flex items-center justify-between', !include.has(k) && 'opacity-40')}>
                <span className="flex items-center gap-2">
                  <span className="h-2.5 w-2.5 rounded-full" style={{ background: COST_COLOR[k] }} />
                  {t(`dashboard.cost.${k}`)}
                </span>
                <span className="tabular-nums">
                  {eur(cur.costs[k])} <span className="ml-1 text-xs text-muted">{pct(cur.revenue > 0 ? cur.costs[k] / cur.revenue : 0)}</span>
                </span>
              </li>
            ))}
          </ul>
          {!cur.fixedIncluded && anyFilter && <p className="mt-3 text-xs text-muted">{t('dashboard.fixedExcluded')}</p>}
        </Card>
      </div>

      {/* Graficos */}
      <Card>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-semibold">{t('dashboard.revenueVsCosts')}</h2>
          <button className="text-sm text-brand" onClick={() => setShowTable((v) => !v)}>
            {showTable ? t('dashboard.chart') : t('dashboard.table')}
          </button>
        </div>
        {showTable ? <DayTable rows={chartData} /> : <RevenueCosts data={chartData} />}
      </Card>
      <Card>
        <h2 className="mb-3 font-semibold">{t('dashboard.deliveryRate')}</h2>
        <RateChart data={chartData} />
      </Card>

      {/* Metas */}
      <Card>
        <h2 className="mb-3 font-semibold">{t('dashboard.goals')}</h2>
        {goals.length === 0 ? (
          <p className="text-sm text-muted">{t('dashboard.noGoals')}</p>
        ) : (
          <div className="space-y-3">
            {goals.map((g) => (
              <GoalBar key={g.id} goal={g} data={data.recs} ctx={ctx} include={include} routes={routes} ops={ops} onOpen={() => setGoalDetail(g.id)} />
            ))}
          </div>
        )}
      </Card>

      <Sheet open={costSheet} onClose={() => setCostSheet(false)} title={t('dashboard.costsSelector')}>
        <div className="flex flex-wrap gap-2">
          {COST_KEYS.map((k) => (
            <Pill
              key={k}
              color={COST_COLOR[k]}
              active={include.has(k)}
              onClick={() => {
                const n = new Set(include)
                if (n.has(k)) n.delete(k)
                else n.add(k)
                setInclude(n)
              }}
            >
              {t(`dashboard.cost.${k}`)} · {eur(cur.costs[k], 0)}
            </Pill>
          ))}
        </div>
        <div className="mt-4 rounded-xl border border-border p-3 text-sm">
          {t('dashboard.margin')}: <b style={{ color: m.value >= 0 ? 'var(--positive)' : 'var(--negative)' }}>{eur(m.value)}</b> ({pct(m.pct)})
          <div className="text-xs text-muted">{t('dashboard.costs')}: {eur(totalCosts(cur, include))}</div>
        </div>
      </Sheet>

      <Sheet open={goalDetail !== null} onClose={() => setGoalDetail(null)} title={t('dashboard.goals')}>
        {goalDetail && (
          <GoalDetail goal={goals.find((g) => g.id === goalDetail)!} data={data.recs} ctx={ctx} include={include} routes={routes} />
        )}
      </Sheet>
    </div>
  )
}

function FilterRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-xs uppercase tracking-wide text-muted">{label}</div>
      <div className="flex flex-wrap gap-2">{children}</div>
    </div>
  )
}

function Stat({ label, value, sub, d, color, upIsGood = true, className }: { label: string; value: string; sub: string; d: number | null; color?: string; upIsGood?: boolean; className?: string }) {
  const good = d === null || d === 0 ? null : d > 0 === upIsGood
  return (
    <Card className={className}>
      <div className="text-sm text-muted">{label}</div>
      <div className="kpi-value mt-1" style={color ? { color } : undefined}>
        {value}
      </div>
      <div className="mt-1 text-sm text-muted">{sub}</div>
      {d !== null && (
        <div className="mt-1 text-xs font-medium" style={{ color: good === null ? 'var(--muted)' : good ? 'var(--positive)' : 'var(--negative)' }}>
          {d > 0 ? '▲' : d < 0 ? '▼' : '■'} {pct(Math.abs(d))}
        </div>
      )}
    </Card>
  )
}

const axisTick = { fill: 'var(--muted)', fontSize: 12 }
const tooltipStyle = { background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 12, color: 'var(--fg)' }

export function RevenueCosts({ data }: { data: { label: string; revenue: number; costs: number }[] }) {
  const { t } = useTranslation()
  return (
    <div className="h-72 w-full">
      <ResponsiveContainer>
        <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} stroke="var(--border)" />
          <XAxis dataKey="label" tick={axisTick} tickLine={false} axisLine={{ stroke: 'var(--border)' }} minTickGap={16} />
          <YAxis tick={axisTick} tickLine={false} axisLine={false} width={48} tickFormatter={(v: number) => num(v)} />
          <Tooltip contentStyle={tooltipStyle} formatter={(v) => eur(Number(v))} cursor={{ fill: 'var(--field)' }} />
          <Legend iconType="circle" wrapperStyle={{ fontSize: 13, color: 'var(--muted)' }} />
          <Bar isAnimationActive={false} dataKey="revenue" name={t('dashboard.revenue')} fill="var(--revenue)" maxBarSize={24} radius={[4, 4, 0, 0]} />
          <Line isAnimationActive={false} dataKey="costs" name={t('dashboard.costs')} stroke="var(--cost-salaries)" strokeWidth={2} dot={false} activeDot={{ r: 4, stroke: 'var(--card)', strokeWidth: 2 }} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  )
}

function RateChart({ data }: { data: { label: string; rate: number | null }[] }) {
  const { t } = useTranslation()
  return (
    <div className="h-56 w-full">
      <ResponsiveContainer>
        <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} stroke="var(--border)" />
          <XAxis dataKey="label" tick={axisTick} tickLine={false} axisLine={{ stroke: 'var(--border)' }} minTickGap={16} />
          <YAxis domain={[0, 1]} tick={axisTick} tickLine={false} axisLine={false} width={48} tickFormatter={(v: number) => pct(v, 0)} />
          <Tooltip contentStyle={tooltipStyle} formatter={(v) => pct(Number(v))} />
          <Line isAnimationActive={false} dataKey="rate" name={t('dashboard.deliveryRate')} stroke="var(--brand)" strokeWidth={2} dot={false} activeDot={{ r: 4, stroke: 'var(--card)', strokeWidth: 2 }} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}

function StateVolume({ stats }: { stats: Stats }) {
  const { t } = useTranslation()
  const rows = ORDER_STATES.map((s: OrderState) => ({ key: s, name: t(`orders.${s}`), value: stats.byState[s] }))
  return (
    <div style={{ height: rows.length * 40 + 16 }} className="w-full">
      <ResponsiveContainer>
        <BarChart data={rows} layout="vertical" margin={{ top: 0, right: 40, bottom: 0, left: 0 }}>
          <XAxis type="number" hide />
          <YAxis type="category" dataKey="name" width={120} tick={axisTick} tickLine={false} axisLine={false} />
          <Tooltip contentStyle={tooltipStyle} cursor={{ fill: 'var(--field)' }} formatter={(v) => num(Number(v))} />
          <Bar isAnimationActive={false} dataKey="value" maxBarSize={16} radius={[0, 4, 4, 0]}>
            {rows.map((r) => (
              <Cell key={r.key} fill={r.key.startsWith('pendentes') ? 'var(--pending)' : 'var(--revenue)'} />
            ))}
            <LabelList dataKey="value" position="right" fill="var(--fg)" fontSize={12} formatter={(v: unknown) => num(Number(v))} />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

function DayTable({ rows }: { rows: { date: string; revenue: number; costs: number; orders: number }[] }) {
  const { t } = useTranslation()
  return (
    <div className="max-h-72 overflow-y-auto">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-card text-left text-muted">
          <tr>
            <th className="py-1 font-medium"> </th>
            <th className="py-1 text-right font-medium">{t('dashboard.orders')}</th>
            <th className="py-1 text-right font-medium">{t('dashboard.revenue')}</th>
            <th className="py-1 text-right font-medium">{t('dashboard.costs')}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((r) => (
            <tr key={r.date}>
              <td className="py-1.5">{dateShort(r.date)}</td>
              <td className="py-1.5 text-right tabular-nums">{num(r.orders)}</td>
              <td className="py-1.5 text-right tabular-nums">{eur(r.revenue)}</td>
              <td className="py-1.5 text-right tabular-nums">{eur(r.costs)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

type Goal = { id: string; operation_id: string; route_id: string | null; metrica: GoalMetric; alvo: number }

function goalStats(goal: Goal, data: RawRec[], ctx: Ctx, routeId?: string) {
  const today = todayISO()
  const f: Filters = { from: startOfMonth(today), to: today, opId: goal.operation_id, routes: routeId ? [routeId] : goal.route_id ? [goal.route_id] : [], drivers: [], vehicles: [], statuses: [] }
  return computeStats(data, f, ctx)
}

function GoalBar({ goal, data, ctx, include, routes, ops, onOpen }: { goal: Goal; data: RawRec[]; ctx: Ctx; include: ReadonlySet<CostKey>; routes: { id: string; nome: string }[]; ops: { id: string; nome: string }[]; onOpen: () => void }) {
  const { t } = useTranslation()
  const s = goalStats(goal, data, ctx)
  const v = goalValue(goal.metrica, s, include)
  const ratio = Math.max(0, v / goal.alvo)
  const name = goal.route_id ? routes.find((r) => r.id === goal.route_id)?.nome : ops.find((o) => o.id === goal.operation_id)?.nome
  const fmt = (x: number) => (goal.metrica === 'encomendas' ? num(x) : eur(x, 0))
  return (
    <button onClick={onOpen} className="block w-full text-left">
      <div className="mb-1 flex justify-between text-sm">
        <span>
          {name} · {t(`dashboard.${goal.metrica === 'receita' ? 'revenue' : goal.metrica === 'margem' ? 'margin' : 'orders'}`)}
        </span>
        <span className="tabular-nums text-muted">
          {fmt(v)} {t('dashboard.goalOf')} {fmt(goal.alvo)} · {pct(ratio, 0)}
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-border" role="progressbar" aria-valuenow={Math.round(ratio * 100)} aria-valuemin={0} aria-valuemax={100}>
        <div className="h-full rounded-full" style={{ width: `${Math.min(100, ratio * 100)}%`, background: goalColor(ratio) }} />
      </div>
    </button>
  )
}

function GoalDetail({ goal, data, ctx, include, routes }: { goal: Goal; data: RawRec[]; ctx: Ctx; include: ReadonlySet<CostKey>; routes: { id: string; nome: string; operation_id: string }[] }) {
  const list = goal.route_id ? routes.filter((r) => r.id === goal.route_id) : routes.filter((r) => r.operation_id === goal.operation_id)
  const fmt = (x: number) => (goal.metrica === 'encomendas' ? num(x) : eur(x, 2))
  return (
    <ul className="divide-y divide-border text-sm">
      {list.map((r) => {
        const s = goalStats(goal, data, ctx, r.id)
        return (
          <li key={r.id} className="flex justify-between py-2.5">
            <span>{r.nome}</span>
            <span className="tabular-nums">{fmt(goalValue(goal.metrica, s, include))}</span>
          </li>
        )
      })}
    </ul>
  )
}
