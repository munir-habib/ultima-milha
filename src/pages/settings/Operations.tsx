import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '@/auth/AuthProvider'
import { useOp } from '@/components/OpContext'
import { Button, Card, ErrorNote, Field, Input, NumInput, Pill, Select, Sheet, Spinner, Toggle } from '@/components/ui'
import { supabase } from '@/lib/supabase'
import { unwrap } from '@/lib/queries'
import { ORDER_STATES, type Operation, type OrderState, type Route, type Tier, type Zone } from '@/lib/types'
import { eur, numStr, parseNum } from '@/lib/format'

const OP_COLS = 'id,tenant_id,nome,valores_estado,salario_fixo_mensal,salario_var_por_entrega,salario_var_pct_receita,outros_custos_mensais'
const ROUTE_COLS = 'id,operation_id,nome,tarifa_por_estado,tarifa_valor_fixo,tarifa_por_zona,tarifa_por_distancia,valor_fixo_default,taxa_km,escaloes_km'

export default function Operations() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { roles, profile } = useAuth()
  const isAdmin = roles.includes('super_admin')
  const { opId } = useOp()
  const { data: ops = [], isLoading, error } = useQuery({
    queryKey: ['operations'],
    queryFn: () => unwrap<Operation[]>(supabase.from('operations').select(OP_COLS).is('deleted_at', null).order('nome')),
  })
  const [sel, setSel] = useState<string>('')
  const [sheet, setSheet] = useState<'new' | 'dup' | null>(null)
  const [newName, setNewName] = useState('')

  useEffect(() => {
    if (!sel || !ops.some((o) => o.id === sel)) setSel((opId !== 'all' && ops.some((o) => o.id === opId) ? opId : ops[0]?.id) ?? '')
  }, [ops, opId, sel])

  const refresh = () => {
    for (const k of ['operations', 'operation_options', 'routes', 'route_options', 'zones', 'zone_options']) void qc.invalidateQueries({ queryKey: [k] })
  }

  const create = useMutation({
    mutationFn: async () => {
      if (sheet === 'dup') {
        const { data, error } = await supabase.rpc('duplicate_operation', { p_source: sel, p_nome: newName.trim() })
        if (error) throw error
        return data as string
      }
      const { data, error } = await supabase.from('operations').insert({ nome: newName.trim(), tenant_id: profile!.tenant_id }).select('id').single()
      if (error) throw error
      return data.id as string
    },
    onSuccess: (id) => {
      setSheet(null)
      setNewName('')
      setSel(id)
      refresh()
    },
  })

  if (isLoading) return <Spinner />
  const op = ops.find((o) => o.id === sel)

  return (
    <div className="space-y-4">
      <ErrorNote error={error} />
      <div className="flex flex-wrap items-center gap-2">
        {ops.map((o) => (
          <Pill key={o.id} active={o.id === sel} onClick={() => setSel(o.id)}>
            {o.nome}
          </Pill>
        ))}
        {isAdmin && (
          <>
            <Button variant="ghost" className="min-h-9" onClick={() => setSheet('new')}>
              + {t('settings.newOperation')}
            </Button>
            {op && (
              <Button variant="ghost" className="min-h-9" onClick={() => setSheet('dup')}>
                {t('settings.duplicateOp')}
              </Button>
            )}
          </>
        )}
      </div>

      {op && <OperationForm key={op.id} op={op} onSaved={refresh} />}
      {op && <Routes op={op} />}
      {op && <Zones op={op} />}
      {op && <Goals op={op} />}

      <Sheet open={sheet !== null} onClose={() => setSheet(null)} title={sheet === 'dup' ? t('settings.duplicateOp') : t('settings.newOperation')}>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault()
            create.mutate()
          }}
        >
          {sheet === 'dup' && <p className="text-sm text-muted">{t('settings.duplicateHint')}</p>}
          <Field label={t('settings.opName')}>
            <Input value={newName} onChange={(e) => setNewName(e.target.value)} required autoFocus />
          </Field>
          <ErrorNote error={create.error} />
          <Button type="submit" className="w-full" disabled={create.isPending}>
            {t('app.save')}
          </Button>
        </form>
      </Sheet>
    </div>
  )
}

function OperationForm({ op, onSaved }: { op: Operation; onSaved: () => void }) {
  const { t } = useTranslation()
  const [nome, setNome] = useState(op.nome)
  const [vals, setVals] = useState<Record<OrderState, string>>(Object.fromEntries(ORDER_STATES.map((s) => [s, numStr(op.valores_estado?.[s] ?? 0)])) as Record<OrderState, string>)
  const [c, setC] = useState({ fixo: numStr(op.salario_fixo_mensal), porEnt: numStr(op.salario_var_por_entrega), pct: numStr(op.salario_var_pct_receita), outros: numStr(op.outros_custos_mensais) })
  const save = useMutation({
    mutationFn: async () => {
      const { error } = await supabase
        .from('operations')
        .update({
          nome: nome.trim(),
          valores_estado: Object.fromEntries(ORDER_STATES.map((s) => [s, parseNum(vals[s]) ?? 0])),
          salario_fixo_mensal: parseNum(c.fixo) ?? 0,
          salario_var_por_entrega: parseNum(c.porEnt) ?? 0,
          salario_var_pct_receita: parseNum(c.pct) ?? 0,
          outros_custos_mensais: parseNum(c.outros) ?? 0,
        })
        .eq('id', op.id)
      if (error) throw error
    },
    onSuccess: onSaved,
  })
  return (
    <Card>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault()
          save.mutate()
        }}
      >
        <Field label={t('settings.opName')}>
          <Input value={nome} onChange={(e) => setNome(e.target.value)} required />
        </Field>
        <div>
          <h3 className="mb-2 font-semibold">{t('settings.stateValues')}</h3>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {ORDER_STATES.map((s) => (
              <Field key={s} label={t(`orders.${s}`)}>
                <NumInput value={vals[s]} onChange={(e) => setVals({ ...vals, [s]: e.target.value })} />
              </Field>
            ))}
          </div>
          <p className="mt-2 text-xs text-muted">{t('settings.tariffChangeNote')}</p>
        </div>
        <div>
          <h3 className="mb-2 font-semibold">{t('settings.fixedCosts')}</h3>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Field label={t('settings.salaryFixed')}>
              <NumInput value={c.fixo} onChange={(e) => setC({ ...c, fixo: e.target.value })} />
            </Field>
            <Field label={t('settings.salaryPerDelivery')}>
              <NumInput value={c.porEnt} onChange={(e) => setC({ ...c, porEnt: e.target.value })} />
            </Field>
            <Field label={t('settings.salaryPct')}>
              <NumInput value={c.pct} onChange={(e) => setC({ ...c, pct: e.target.value })} />
            </Field>
            <Field label={t('settings.otherCosts')}>
              <NumInput value={c.outros} onChange={(e) => setC({ ...c, outros: e.target.value })} />
            </Field>
          </div>
        </div>
        <ErrorNote error={save.error} />
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? t('app.saving') : t('app.save')}
        </Button>
      </form>
    </Card>
  )
}

/* ---------------- Rotas + tarifario ---------------- */

interface RForm {
  nome: string
  por_estado: boolean
  valor_fixo: boolean
  por_zona: boolean
  por_distancia: boolean
  fixo_default: string
  taxa_km: string
  usar_escaloes: boolean
  escaloes: { de: string; ate: string; valor: string }[]
}

const rFrom = (r?: Route): RForm => ({
  nome: r?.nome ?? '',
  por_estado: r?.tarifa_por_estado ?? true,
  valor_fixo: r?.tarifa_valor_fixo ?? false,
  por_zona: r?.tarifa_por_zona ?? false,
  por_distancia: r?.tarifa_por_distancia ?? false,
  fixo_default: numStr(r?.valor_fixo_default),
  taxa_km: numStr(r?.taxa_km),
  usar_escaloes: Boolean(r?.escaloes_km?.length),
  escaloes: (r?.escaloes_km ?? []).map((e) => ({ de: numStr(e.de), ate: numStr(e.ate), valor: numStr(e.valor) })),
})

function Routes({ op }: { op: Operation }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { data: routes = [], error } = useQuery({
    queryKey: ['routes', op.id],
    queryFn: () => unwrap<Route[]>(supabase.from('routes').select(ROUTE_COLS).eq('operation_id', op.id).is('deleted_at', null).order('nome')),
  })
  const [edit, setEdit] = useState<{ id: string | null; form: RForm } | null>(null)

  const save = useMutation({
    mutationFn: async () => {
      const { id, form: f } = edit!
      const tiers: Tier[] | null =
        f.por_distancia && f.usar_escaloes
          ? f.escaloes.map((e) => ({ de: parseNum(e.de) ?? 0, ate: parseNum(e.ate), valor: parseNum(e.valor) ?? 0 })).sort((a, b) => a.de - b.de)
          : null
      const body = {
        nome: f.nome.trim(),
        tarifa_por_estado: f.por_estado,
        tarifa_valor_fixo: f.valor_fixo,
        tarifa_por_zona: f.por_zona,
        tarifa_por_distancia: f.por_distancia,
        valor_fixo_default: f.valor_fixo ? parseNum(f.fixo_default) : null,
        taxa_km: f.por_distancia && !f.usar_escaloes ? parseNum(f.taxa_km) : null,
        escaloes_km: tiers,
      }
      const { error } = id ? await supabase.from('routes').update(body).eq('id', id) : await supabase.from('routes').insert({ ...body, operation_id: op.id })
      if (error) throw error
    },
    onSuccess: () => {
      setEdit(null)
      void qc.invalidateQueries({ queryKey: ['routes'] })
      void qc.invalidateQueries({ queryKey: ['route_options'] })
    },
  })

  const archive = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('routes').update({ deleted_at: new Date().toISOString() }).eq('id', id)
      if (error) throw error
    },
    onSuccess: () => {
      setEdit(null)
      void qc.invalidateQueries({ queryKey: ['routes'] })
      void qc.invalidateQueries({ queryKey: ['route_options'] })
    },
  })

  const comps = (r: Route) =>
    [r.tarifa_por_estado && t('settings.byState'), r.tarifa_valor_fixo && t('settings.fixed'), r.tarifa_por_zona && t('settings.byZone'), r.tarifa_por_distancia && t('settings.byDistance')].filter(Boolean).join(' · ')

  return (
    <Card>
      <div className="mb-3 flex items-center justify-between">
        <h3 className="font-semibold">{t('settings.routes')}</h3>
        <Button variant="ghost" className="min-h-9" onClick={() => setEdit({ id: null, form: rFrom() })}>
          + {t('settings.newRoute')}
        </Button>
      </div>
      <ErrorNote error={error} />
      <ul className="divide-y divide-border">
        {routes.map((r) => (
          <li key={r.id}>
            <button className="flex min-h-14 w-full flex-col items-start justify-center py-2 text-left" onClick={() => setEdit({ id: r.id, form: rFrom(r) })}>
              <span className="font-medium">{r.nome}</span>
              <span className="text-xs text-muted">{comps(r) || '—'}</span>
            </button>
          </li>
        ))}
      </ul>

      <Sheet open={edit !== null} onClose={() => setEdit(null)} title={edit?.id ? edit.form.nome : t('settings.newRoute')}>
        {edit && (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault()
              save.mutate()
            }}
          >
            {(() => {
              const f = edit.form
              const set = (p: Partial<RForm>) => setEdit({ ...edit, form: { ...f, ...p } })
              return (
                <>
                  <Field label={t('settings.routeName')}>
                    <Input value={f.nome} onChange={(e) => set({ nome: e.target.value })} required />
                  </Field>
                  <div>
                    <h4 className="font-semibold">{t('settings.tariff')}</h4>
                    <p className="mb-1 text-xs text-muted">{t('settings.tariffHint')}</p>
                    <div className="divide-y divide-border rounded-xl border border-border px-3">
                      <Toggle checked={f.por_estado} onChange={(v) => set({ por_estado: v })} label={t('settings.byState')} />
                      <div>
                        <Toggle checked={f.valor_fixo} onChange={(v) => set({ valor_fixo: v })} label={t('settings.fixed')} />
                        {f.valor_fixo && (
                          <Field label={t('settings.fixedDefault')} className="pb-3">
                            <NumInput value={f.fixo_default} onChange={(e) => set({ fixo_default: e.target.value })} />
                          </Field>
                        )}
                      </div>
                      <Toggle checked={f.por_zona} onChange={(v) => set({ por_zona: v })} label={t('settings.byZone')} />
                      <div>
                        <Toggle checked={f.por_distancia} onChange={(v) => set({ por_distancia: v })} label={t('settings.byDistance')} />
                        {f.por_distancia && (
                          <div className="space-y-3 pb-3">
                            <Toggle checked={f.usar_escaloes} onChange={(v) => set({ usar_escaloes: v, escaloes: v && f.escaloes.length === 0 ? [{ de: '0', ate: '', valor: '' }] : f.escaloes })} label={t('settings.useTiers')} />
                            {!f.usar_escaloes ? (
                              <Field label={t('settings.kmRate')}>
                                <NumInput value={f.taxa_km} onChange={(e) => set({ taxa_km: e.target.value })} />
                              </Field>
                            ) : (
                              <div className="space-y-2">
                                {f.escaloes.map((e, i) => (
                                  <div key={i} className="grid grid-cols-[1fr_1fr_1fr_auto] items-end gap-2">
                                    <Field label={t('settings.tierFrom')}>
                                      <NumInput value={e.de} onChange={(ev) => set({ escaloes: f.escaloes.map((x, j) => (j === i ? { ...x, de: ev.target.value } : x)) })} />
                                    </Field>
                                    <Field label={t('settings.tierTo')}>
                                      <NumInput value={e.ate} onChange={(ev) => set({ escaloes: f.escaloes.map((x, j) => (j === i ? { ...x, ate: ev.target.value } : x)) })} />
                                    </Field>
                                    <Field label={t('settings.tierValue')}>
                                      <NumInput value={e.valor} onChange={(ev) => set({ escaloes: f.escaloes.map((x, j) => (j === i ? { ...x, valor: ev.target.value } : x)) })} />
                                    </Field>
                                    <button type="button" aria-label={t('app.remove')} className="h-11 w-11 text-xl text-muted" onClick={() => set({ escaloes: f.escaloes.filter((_, j) => j !== i) })}>
                                      ×
                                    </button>
                                  </div>
                                ))}
                                <Button type="button" variant="ghost" className="min-h-9" onClick={() => set({ escaloes: [...f.escaloes, { de: f.escaloes.at(-1)?.ate ?? '', ate: '', valor: '' }] })}>
                                  + {t('settings.addTier')}
                                </Button>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                    <p className="mt-2 text-xs text-muted">{t('settings.tariffChangeNote')}</p>
                  </div>
                </>
              )
            })()}
            <ErrorNote error={save.error ?? archive.error} />
            <Button type="submit" className="w-full" disabled={save.isPending}>
              {t('app.save')}
            </Button>
            {edit.id && (
              <Button type="button" variant="danger" className="w-full" disabled={archive.isPending} onClick={() => archive.mutate(edit.id!)}>
                {t('settings.delete')}
              </Button>
            )}
          </form>
        )}
      </Sheet>
    </Card>
  )
}

/* ---------------- Zonas postais ---------------- */

function Zones({ op }: { op: Operation }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { data: zones = [], error } = useQuery({
    queryKey: ['zones', op.id],
    queryFn: () => unwrap<Zone[]>(supabase.from('postal_zones').select('id,operation_id,nome,prefixos,valor_por_entrega').eq('operation_id', op.id).is('deleted_at', null).order('nome')),
  })
  const [edit, setEdit] = useState<{ id: string | null; nome: string; prefixos: string; valor: string } | null>(null)
  const done = () => {
    setEdit(null)
    void qc.invalidateQueries({ queryKey: ['zones'] })
    void qc.invalidateQueries({ queryKey: ['zone_options'] })
  }
  const save = useMutation({
    mutationFn: async () => {
      const e = edit!
      const body = { nome: e.nome.trim(), prefixos: e.prefixos.split(',').map((p) => p.trim()).filter(Boolean), valor_por_entrega: parseNum(e.valor) ?? 0 }
      const { error } = e.id ? await supabase.from('postal_zones').update(body).eq('id', e.id) : await supabase.from('postal_zones').insert({ ...body, operation_id: op.id })
      if (error) throw error
    },
    onSuccess: done,
  })
  const archive = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('postal_zones').update({ deleted_at: new Date().toISOString() }).eq('id', id)
      if (error) throw error
    },
    onSuccess: done,
  })
  return (
    <Card>
      <div className="mb-3 flex items-center justify-between">
        <h3 className="font-semibold">{t('settings.zones')}</h3>
        <Button variant="ghost" className="min-h-9" onClick={() => setEdit({ id: null, nome: '', prefixos: '', valor: '' })}>
          + {t('settings.newZone')}
        </Button>
      </div>
      <ErrorNote error={error} />
      <ul className="divide-y divide-border">
        {zones.map((z) => (
          <li key={z.id}>
            <button className="flex min-h-14 w-full items-center justify-between py-2 text-left" onClick={() => setEdit({ id: z.id, nome: z.nome, prefixos: z.prefixos.join(', '), valor: numStr(z.valor_por_entrega) })}>
              <span>
                <span className="block font-medium">{z.nome}</span>
                <span className="text-xs text-muted">{z.prefixos.join(', ')}</span>
              </span>
              <span className="tabular-nums">{eur(z.valor_por_entrega)}</span>
            </button>
          </li>
        ))}
      </ul>
      <Sheet open={edit !== null} onClose={() => setEdit(null)} title={edit?.id ? edit.nome : t('settings.newZone')}>
        {edit && (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault()
              save.mutate()
            }}
          >
            <Field label={t('settings.zoneName')}>
              <Input value={edit.nome} onChange={(e) => setEdit({ ...edit, nome: e.target.value })} required />
            </Field>
            <Field label={t('settings.zonePrefixes')}>
              <Input value={edit.prefixos} onChange={(e) => setEdit({ ...edit, prefixos: e.target.value })} inputMode="numeric" />
            </Field>
            <Field label={t('settings.zoneValue')}>
              <NumInput value={edit.valor} onChange={(e) => setEdit({ ...edit, valor: e.target.value })} />
            </Field>
            <p className="text-xs text-muted">{t('settings.tariffChangeNote')}</p>
            <ErrorNote error={save.error ?? archive.error} />
            <Button type="submit" className="w-full" disabled={save.isPending}>
              {t('app.save')}
            </Button>
            {edit.id && (
              <Button type="button" variant="danger" className="w-full" onClick={() => archive.mutate(edit.id!)}>
                {t('settings.delete')}
              </Button>
            )}
          </form>
        )}
      </Sheet>
    </Card>
  )
}

/* ---------------- Metas ---------------- */

type Metric = 'receita' | 'encomendas' | 'margem'
interface GoalRow { id: string; operation_id: string; route_id: string | null; metrica: Metric; alvo: number }

function Goals({ op }: { op: Operation }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { data: goals = [], error } = useQuery({
    queryKey: ['goals', 'settings', op.id],
    queryFn: () => unwrap<GoalRow[]>(supabase.from('goals').select('id,operation_id,route_id,metrica,alvo').eq('operation_id', op.id).is('deleted_at', null)),
  })
  const { data: routes = [] } = useQuery({
    queryKey: ['routes', op.id],
    queryFn: () => unwrap<Route[]>(supabase.from('routes').select(ROUTE_COLS).eq('operation_id', op.id).is('deleted_at', null).order('nome')),
  })
  const [edit, setEdit] = useState<{ id: string | null; metrica: Metric; route_id: string; alvo: string } | null>(null)
  const done = () => {
    setEdit(null)
    void qc.invalidateQueries({ queryKey: ['goals'] })
  }
  const save = useMutation({
    mutationFn: async () => {
      const e = edit!
      const body = { metrica: e.metrica, route_id: e.route_id || null, alvo: parseNum(e.alvo) ?? 0 }
      const { error } = e.id ? await supabase.from('goals').update(body).eq('id', e.id) : await supabase.from('goals').insert({ ...body, operation_id: op.id })
      if (error) throw error
    },
    onSuccess: done,
  })
  const archive = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('goals').update({ deleted_at: new Date().toISOString() }).eq('id', id)
      if (error) throw error
    },
    onSuccess: done,
  })
  const metricLabel = (m: Metric) => t(`dashboard.${m === 'receita' ? 'revenue' : m === 'margem' ? 'margin' : 'orders'}`)
  const fmt = (g: GoalRow) => (g.metrica === 'encomendas' ? String(g.alvo) : eur(g.alvo, 0))
  return (
    <Card>
      <div className="mb-3 flex items-center justify-between">
        <h3 className="font-semibold">{t('goals.title')}</h3>
        <Button variant="ghost" className="min-h-9" onClick={() => setEdit({ id: null, metrica: 'receita', route_id: '', alvo: '' })}>
          + {t('goals.add')}
        </Button>
      </div>
      <ErrorNote error={error} />
      {goals.length === 0 && <p className="text-sm text-muted">{t('goals.empty')}</p>}
      <ul className="divide-y divide-border">
        {goals.map((g) => (
          <li key={g.id}>
            <button className="flex min-h-14 w-full items-center justify-between py-2 text-left" onClick={() => setEdit({ id: g.id, metrica: g.metrica, route_id: g.route_id ?? '', alvo: String(g.alvo) })}>
              <span>
                <span className="block font-medium">{metricLabel(g.metrica)}</span>
                <span className="text-xs text-muted">{g.route_id ? routes.find((r) => r.id === g.route_id)?.nome : t('goals.wholeOp')} · {t('dashboard.thisMonth').toLowerCase()}</span>
              </span>
              <span className="tabular-nums">{fmt(g)}</span>
            </button>
          </li>
        ))}
      </ul>
      <Sheet open={edit !== null} onClose={() => setEdit(null)} title={t('goals.title')}>
        {edit && (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault()
              save.mutate()
            }}
          >
            <Field label={t('goals.metric')}>
              <Select value={edit.metrica} onChange={(e) => setEdit({ ...edit, metrica: e.target.value as Metric })}>
                {(['receita', 'encomendas', 'margem'] as Metric[]).map((m) => (
                  <option key={m} value={m}>
                    {metricLabel(m)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('goals.scope')}>
              <Select value={edit.route_id} onChange={(e) => setEdit({ ...edit, route_id: e.target.value })}>
                <option value="">{t('goals.wholeOp')}</option>
                {routes.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.nome}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('goals.target')}>
              <NumInput value={edit.alvo} onChange={(e) => setEdit({ ...edit, alvo: e.target.value })} required />
            </Field>
            <ErrorNote error={save.error ?? archive.error} />
            <Button type="submit" className="w-full" disabled={save.isPending}>
              {t('app.save')}
            </Button>
            {edit.id && (
              <Button type="button" variant="danger" className="w-full" onClick={() => archive.mutate(edit.id!)}>
                {t('settings.delete')}
              </Button>
            )}
          </form>
        )}
      </Sheet>
    </Card>
  )
}
