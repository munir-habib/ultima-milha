import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '@/auth/AuthProvider'
import { useOp } from '@/components/OpContext'
import { Button, Card, ErrorNote, Field, Input, NumInput, PageTitle, Pill, Select, Spinner, StatusBadge, Toggle } from '@/components/ui'
import { supabase } from '@/lib/supabase'
import { unwrap, useDriverOptions, useRouteOptions, useVehicleOptions, useZoneOptions } from '@/lib/queries'
import { canValidate } from '@/lib/roles'
import { ORDER_STATES, type Breakdown, type DailyRecord, type OrderState, type RecordStatus, type RouteOption } from '@/lib/types'
import { eur, numStr, parseNum, todayISO } from '@/lib/format'

const ENC_COL: Record<OrderState, keyof DailyRecord> = {
  entregues: 'enc_entregues',
  devolucoes: 'enc_devolucoes',
  recolhas: 'enc_recolhas',
  canceladas: 'enc_canceladas',
  transitadas: 'enc_transitadas',
  pendentes_entrega: 'enc_pendentes_entrega',
  pendentes_recolha: 'enc_pendentes_recolha',
}

interface FormState {
  viatura_id: string
  motorista_ids: string[]
  km: string
  enc: Record<OrderState, string>
  valor_fixo: string
  incluir_entregas: boolean
  zonas: Record<string, string>
  comb_litros: string
  comb_valor: string
  comb_tipo: string
  portagens: string
}

const emptyForm = (): FormState => ({
  viatura_id: '',
  motorista_ids: [],
  km: '',
  enc: Object.fromEntries(ORDER_STATES.map((s) => [s, ''])) as Record<OrderState, string>,
  valor_fixo: '',
  incluir_entregas: true,
  zonas: {},
  comb_litros: '',
  comb_valor: '',
  comb_tipo: '',
  portagens: '',
})

const fromRecord = (r: DailyRecord): FormState => ({
  viatura_id: r.viatura_id ?? '',
  motorista_ids: r.motorista_ids ?? [],
  km: numStr(r.km),
  enc: Object.fromEntries(ORDER_STATES.map((s) => [s, numStr(r[ENC_COL[s]] as number | null)])) as Record<OrderState, string>,
  valor_fixo: numStr(r.valor_fixo_do_dia),
  incluir_entregas: r.incluir_entregas,
  zonas: Object.fromEntries(Object.entries(r.entregas_por_zona ?? {}).map(([k, v]) => [k, String(v)])),
  comb_litros: numStr(r.comb_litros),
  comb_valor: numStr(r.comb_valor),
  comb_tipo: r.comb_tipo ?? '',
  portagens: numStr(r.portagens_valor),
})

function toPayload(f: FormState) {
  const int = (s: string) => {
    const n = parseNum(s)
    return n === null ? null : Math.max(0, Math.round(n))
  }
  const zonas: Record<string, number> = {}
  for (const [k, v] of Object.entries(f.zonas)) {
    const n = int(v)
    if (n) zonas[k] = n
  }
  return {
    viatura_id: f.viatura_id || null,
    motorista_ids: f.motorista_ids,
    km: parseNum(f.km),
    enc_entregues: int(f.enc.entregues),
    enc_devolucoes: int(f.enc.devolucoes),
    enc_recolhas: int(f.enc.recolhas),
    enc_canceladas: int(f.enc.canceladas),
    enc_transitadas: int(f.enc.transitadas),
    enc_pendentes_entrega: int(f.enc.pendentes_entrega),
    enc_pendentes_recolha: int(f.enc.pendentes_recolha),
    valor_fixo_do_dia: parseNum(f.valor_fixo),
    incluir_entregas: f.incluir_entregas,
    entregas_por_zona: zonas,
    comb_litros: parseNum(f.comb_litros),
    comb_valor: parseNum(f.comb_valor),
    comb_tipo: f.comb_tipo.trim() || null,
    portagens_valor: parseNum(f.portagens),
  }
}

export default function Register() {
  const { t } = useTranslation()
  const [params, setParams] = useSearchParams()
  const { opId } = useOp()
  const { data: routes = [], isLoading } = useRouteOptions()
  const visible = useMemo(() => routes.filter((r) => opId === 'all' || r.operation_id === opId), [routes, opId])
  const routeId = params.get('rota') ?? ''
  const date = params.get('data') ?? todayISO()
  const route = routes.find((r) => r.id === routeId) ?? null

  const set = (k: 'rota' | 'data', v: string) => {
    const p = new URLSearchParams(params)
    p.set(k, v)
    setParams(p, { replace: true })
  }

  // uma so rota disponivel -> pre-seleciona
  useEffect(() => {
    if (!routeId && visible.length === 1) set('rota', visible[0].id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, routeId])

  return (
    <div>
      <PageTitle>{t('register.title')}</PageTitle>
      <Card className="mb-4 grid gap-3 sm:grid-cols-2">
        <Field label={t('register.route')}>
          <Select value={routeId} onChange={(e) => set('rota', e.target.value)}>
            <option value="">{t('register.chooseRoute')}</option>
            {visible.map((r) => (
              <option key={r.id} value={r.id}>
                {r.nome}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('register.date')}>
          <Input type="date" value={date} max="9999-12-31" onChange={(e) => e.target.value && set('data', e.target.value)} />
        </Field>
      </Card>
      {isLoading ? <Spinner /> : route ? <Loader key={`${route.id}|${date}`} route={route} date={date} /> : null}
    </div>
  )
}

/** Carrega o registo existente (se houver) antes de montar o formulario. */
function Loader({ route, date }: { route: RouteOption; date: string }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['record', route.id, date],
    queryFn: () =>
      unwrap<DailyRecord | null>(supabase.from('daily_records').select('*').eq('route_id', route.id).eq('data', date).is('deleted_at', null).maybeSingle()),
    staleTime: 0,
    gcTime: 0,
  })
  if (isLoading) return <Spinner />
  if (error) return <ErrorNote error={error} />
  return <RecordForm route={route} date={date} initial={data ?? null} />
}

function RecordForm({ route, date, initial }: { route: RouteOption; date: string; initial: DailyRecord | null }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { session, roles } = useAuth()
  const manager = canValidate({ roles, accountingRead: false })
  const { data: vehicles = [] } = useVehicleOptions()
  const { data: drivers = [] } = useDriverOptions()
  const { data: zoneAll = [] } = useZoneOptions()
  const zones = useMemo(() => zoneAll.filter((z) => z.operation_id === route.operation_id), [zoneAll, route.operation_id])
  const myDriver = drivers.find((d) => d.user_id === session?.user.id)

  const [form, setForm] = useState<FormState>(() => {
    if (initial) return fromRecord(initial)
    const f = emptyForm()
    if (route.tarifa_valor_fixo && route.valor_fixo_default !== null) f.valor_fixo = String(route.valor_fixo_default)
    return f
  })
  const [status, setStatus] = useState<RecordStatus>(initial?.status ?? 'rascunho')
  const [revenue, setRevenue] = useState<{ total: number; breakdown: Breakdown | null }>({
    total: initial?.receita_total ?? 0,
    breakdown: initial?.receita_breakdown ?? null,
  })
  const [saveState, setSaveState] = useState<'idle' | 'dirty' | 'saving' | 'saved'>('idle')
  const [error, setError] = useState<unknown>(null)
  const [duplicate, setDuplicate] = useState(false)

  const recordId = useRef<string | null>(initial?.id ?? null)
  const latest = useRef(form)
  const dirty = useRef(false)
  const chain = useRef<Promise<void>>(Promise.resolve())
  latest.current = form

  // motorista com conta: pre-seleciona o proprio nome em registos novos
  const appliedDriver = useRef(false)
  useEffect(() => {
    if (!initial && myDriver && !appliedDriver.current) {
      appliedDriver.current = true
      setForm((f) => (f.motorista_ids.length ? f : { ...f, motorista_ids: [myDriver.id] }))
    }
  }, [initial, myDriver])

  const readOnly = status === 'validado' && !manager

  const persist = useCallback(
    (nextStatus?: RecordStatus) => {
      chain.current = chain.current.then(async () => {
        if (!dirty.current && !nextStatus) return
        dirty.current = false
        setSaveState('saving')
        setError(null)
        const body: Record<string, unknown> = { ...toPayload(latest.current) }
        if (nextStatus) body.status = nextStatus
        const q = recordId.current
          ? supabase.from('daily_records').update(body).eq('id', recordId.current)
          : supabase.from('daily_records').insert({ ...body, route_id: route.id, data: date })
        const { data, error: err } = await q.select('*').single()
        if (err) {
          dirty.current = true
          setSaveState('dirty')
          if (err.code === '23505') setDuplicate(true)
          else setError(err)
          return
        }
        const rec = data as DailyRecord
        recordId.current = rec.id
        setStatus(rec.status)
        setRevenue({ total: rec.receita_total, breakdown: rec.receita_breakdown })
        setSaveState(dirty.current ? 'dirty' : 'saved')
        void qc.invalidateQueries({ queryKey: ['records'] })
      })
      return chain.current
    },
    [route.id, date, qc],
  )

  // rascunho automatico (debounce) enquanto o utilizador preenche
  useEffect(() => {
    if (!dirty.current || readOnly || duplicate) return
    const h = setTimeout(() => void persist(), 1200)
    return () => clearTimeout(h)
  }, [form, persist, readOnly, duplicate])

  // ao sair da app/separador, grava de imediato
  useEffect(() => {
    const flush = () => {
      if (document.visibilityState === 'hidden' && dirty.current && !readOnly && !duplicate) void persist()
    }
    document.addEventListener('visibilitychange', flush)
    window.addEventListener('pagehide', flush)
    return () => {
      document.removeEventListener('visibilitychange', flush)
      window.removeEventListener('pagehide', flush)
    }
  }, [persist, readOnly, duplicate])

  const edit = (fn: (f: FormState) => FormState) => {
    dirty.current = true
    setSaveState('dirty')
    setForm(fn)
  }

  const { data: costs = [] } = useQuery({
    queryKey: ['record-costs', recordId.current, saveState === 'saved'],
    enabled: Boolean(recordId.current),
    queryFn: () =>
      unwrap<{ id: string; categoria: string; valor: number }[]>(
        supabase.from('daily_record_costs').select('id,categoria,valor').eq('record_id', recordId.current!).is('deleted_at', null),
      ),
  })

  if (duplicate) return <ErrorNote error={new Error(t('register.duplicate'))} />

  const label = saveState === 'saving' ? t('app.saving') : saveState === 'saved' ? t('register.autosave') : ''

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault()
        void persist('submetido')
      }}
    >
      <div className="flex items-center justify-between">
        <StatusBadge status={status} />
        <span className="text-xs text-muted">{label}</span>
      </div>
      {readOnly && <div className="rounded-xl border border-border bg-card px-3 py-2 text-sm text-muted">{t('register.readOnly')}</div>}
      <ErrorNote error={error} />

      <fieldset disabled={readOnly} className="space-y-4">
        <Card className="grid gap-3 sm:grid-cols-2">
          <Field label={t('register.vehicle')}>
            <Select value={form.viatura_id} onChange={(e) => edit((f) => ({ ...f, viatura_id: e.target.value }))}>
              <option value="">{t('register.none')}</option>
              {vehicles.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.matricula}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('register.km')}>
            <NumInput value={form.km} onChange={(e) => edit((f) => ({ ...f, km: e.target.value }))} />
          </Field>
          {drivers.length > 0 && (
            <div className="sm:col-span-2">
              <span className="mb-1 block text-sm font-medium text-muted">{t('register.drivers')}</span>
              <div className="flex flex-wrap gap-2">
                {drivers.map((d) => (
                  <Pill
                    key={d.id}
                    active={form.motorista_ids.includes(d.id)}
                    onClick={() =>
                      edit((f) => ({
                        ...f,
                        motorista_ids: f.motorista_ids.includes(d.id) ? f.motorista_ids.filter((x) => x !== d.id) : [...f.motorista_ids, d.id],
                      }))
                    }
                  >
                    {d.nome}
                  </Pill>
                ))}
              </div>
            </div>
          )}
        </Card>

        <Card>
          <h2 className="mb-3 font-semibold">{t('register.orders')}</h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {ORDER_STATES.map((s) => (
              <Field key={s} label={t(`orders.${s}`)}>
                <NumInput decimal={false} value={form.enc[s]} onChange={(e) => edit((f) => ({ ...f, enc: { ...f.enc, [s]: e.target.value } }))} />
              </Field>
            ))}
          </div>
          {route.tarifa_por_estado && (
            <div className="mt-2 border-t border-border pt-2">
              <Toggle checked={form.incluir_entregas} onChange={(v) => edit((f) => ({ ...f, incluir_entregas: v }))} label={t('register.includeDeliveries')} />
            </div>
          )}
        </Card>

        {route.tarifa_valor_fixo && (
          <Card>
            <Field label={t('register.fixedValue')}>
              <NumInput value={form.valor_fixo} onChange={(e) => edit((f) => ({ ...f, valor_fixo: e.target.value }))} />
            </Field>
          </Card>
        )}

        {route.tarifa_por_zona && zones.length > 0 && (
          <Card>
            <h2 className="mb-3 font-semibold">{t('register.zones')}</h2>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {zones.map((z) => (
                <Field key={z.id} label={z.nome}>
                  <NumInput decimal={false} value={form.zonas[z.id] ?? ''} onChange={(e) => edit((f) => ({ ...f, zonas: { ...f.zonas, [z.id]: e.target.value } }))} />
                </Field>
              ))}
            </div>
          </Card>
        )}

        <Card>
          <h2 className="mb-3 font-semibold">{t('register.fuel')}</h2>
          <div className="grid grid-cols-3 gap-3">
            <Field label={t('register.liters')}>
              <NumInput value={form.comb_litros} onChange={(e) => edit((f) => ({ ...f, comb_litros: e.target.value }))} />
            </Field>
            <Field label={t('register.amount')}>
              <NumInput value={form.comb_valor} onChange={(e) => edit((f) => ({ ...f, comb_valor: e.target.value }))} />
            </Field>
            <Field label={t('register.fuelType')}>
              <Input value={form.comb_tipo} onChange={(e) => edit((f) => ({ ...f, comb_tipo: e.target.value }))} />
            </Field>
          </div>
          <Field label={t('register.tolls')} className="mt-3">
            <NumInput value={form.portagens} onChange={(e) => edit((f) => ({ ...f, portagens: e.target.value }))} />
          </Field>
        </Card>
      </fieldset>

      {costs.length > 0 && (
        <Card>
          <h2 className="mb-2 font-semibold">{t('register.costLines')}</h2>
          <ul className="divide-y divide-border text-sm">
            {costs.map((c) => (
              <li key={c.id} className="flex justify-between py-2">
                <span>{c.categoria}</span>
                <span className="tabular-nums">{eur(c.valor)}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card>
        <div className="text-sm text-muted">{t('register.revenue')}</div>
        <div className="kpi-value text-revenue">{eur(revenue.total)}</div>
        <div className="mt-1 text-xs text-muted">{t('register.revenueHint')}</div>
      </Card>

      {!readOnly && (
        <div className="flex flex-col gap-2 sm:flex-row">
          {status !== 'validado' && (
            <Button type="submit" className="flex-1" disabled={saveState === 'saving'}>
              {t('register.submit')}
            </Button>
          )}
          {manager && status !== 'validado' && recordId.current && (
            <Button type="button" variant="ghost" className="flex-1" onClick={() => void persist('validado')}>
              {t('register.validate')}
            </Button>
          )}
        </div>
      )}
    </form>
  )
}
