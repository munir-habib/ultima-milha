import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '@/auth/AuthProvider'
import { Button, Card, ErrorNote, Field, Input, NumInput, PageTitle, Pill, Select, Sheet, Spinner, Toggle } from '@/components/ui'
import { supabase } from '@/lib/supabase'
import { unwrap } from '@/lib/queries'
import { canEditFleet } from '@/lib/roles'
import type { Driver, Slot, SlotAssignment, Vehicle } from '@/lib/types'
import { dateShort, eur, numStr, parseNum } from '@/lib/format'
import { slotStay } from '@/lib/slots'

type Tab = 'vehicles' | 'slots' | 'drivers'

export default function Fleet() {
  const { t } = useTranslation()
  const { roles } = useAuth()
  const editable = canEditFleet({ roles, accountingRead: false })
  const [tab, setTab] = useState<Tab>('vehicles')
  return (
    <div>
      <PageTitle>{t('fleet.title')}</PageTitle>
      <div className="mb-4 flex gap-2">
        {(['vehicles', 'slots', 'drivers'] as Tab[]).map((k) => (
          <Pill key={k} active={tab === k} onClick={() => setTab(k)}>
            {t(`fleet.${k}`)}
          </Pill>
        ))}
      </div>
      {tab === 'vehicles' && <Vehicles editable={editable} />}
      {tab === 'slots' && <Slots editable={editable} />}
      {tab === 'drivers' && <Drivers editable={editable} />}
    </div>
  )
}

function useTable<T>(table: string, cols: string, order: string) {
  return useQuery({ queryKey: [table], queryFn: () => unwrap<T[]>(supabase.from(table).select(cols).is('deleted_at', null).order(order)) })
}

/* ---------------- Viaturas ---------------- */

const VCOLS =
  'id,matricula,tipo,posto_id,estado,iuc_ativo,iuc_valor,seguro_ativo,seguro_valor,iuc_vencimento,seguro_vencimento,manutencao_ativo,manutencao_valor,aluguer_fornecedor,aluguer_custo,aluguer_periodicidade,aluguer_data_inicio,aluguer_data_fim'

interface VForm {
  matricula: string
  tipo: 'propria' | 'alugada'
  posto_id: string
  estado: Vehicle['estado']
  iuc_ativo: boolean
  iuc_valor: string
  seguro_ativo: boolean
  seguro_valor: string
  iuc_vencimento: string
  seguro_vencimento: string
  manutencao_ativo: boolean
  manutencao_valor: string
  fornecedor: string
  custo: string
  periodicidade: 'diario' | 'semanal' | 'mensal'
  inicio: string
  fim: string
}

const vEmpty: VForm = {
  matricula: '', tipo: 'propria', posto_id: '', estado: 'ativa',
  iuc_ativo: false, iuc_valor: '', seguro_ativo: false, seguro_valor: '', iuc_vencimento: '', seguro_vencimento: '', manutencao_ativo: false, manutencao_valor: '',
  fornecedor: '', custo: '', periodicidade: 'mensal', inicio: '', fim: '',
}

const vFrom = (v: Vehicle): VForm => ({
  matricula: v.matricula, tipo: v.tipo, posto_id: v.posto_id ?? '', estado: v.estado,
  iuc_ativo: v.iuc_ativo, iuc_valor: numStr(v.iuc_valor), seguro_ativo: v.seguro_ativo, seguro_valor: numStr(v.seguro_valor), iuc_vencimento: v.iuc_vencimento ?? '', seguro_vencimento: v.seguro_vencimento ?? '',
  manutencao_ativo: v.manutencao_ativo, manutencao_valor: numStr(v.manutencao_valor),
  fornecedor: v.aluguer_fornecedor ?? '', custo: numStr(v.aluguer_custo), periodicidade: v.aluguer_periodicidade ?? 'mensal',
  inicio: v.aluguer_data_inicio ?? '', fim: v.aluguer_data_fim ?? '',
})

function Vehicles({ editable }: { editable: boolean }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { profile } = useAuth()
  const { data: vehicles = [], isLoading, error } = useTable<Vehicle>('vehicles', VCOLS, 'matricula')
  const { data: slots = [] } = useTable<Slot>('fleet_slots', 'id,nome', 'nome')
  const [editing, setEditing] = useState<{ id: string | null; form: VForm } | null>(null)

  const save = useMutation({
    mutationFn: async () => {
      const { id, form: f } = editing!
      const rented = f.tipo === 'alugada'
      const body = {
        matricula: f.matricula.trim().toUpperCase(),
        tipo: f.tipo,
        posto_id: f.posto_id || null,
        estado: f.estado,
        iuc_ativo: f.iuc_ativo, iuc_valor: parseNum(f.iuc_valor) ?? 0,
        seguro_ativo: f.seguro_ativo, seguro_valor: parseNum(f.seguro_valor) ?? 0,
        iuc_vencimento: f.iuc_ativo ? f.iuc_vencimento || null : null,
        seguro_vencimento: f.seguro_ativo ? f.seguro_vencimento || null : null,
        manutencao_ativo: f.manutencao_ativo, manutencao_valor: parseNum(f.manutencao_valor) ?? 0,
        aluguer_fornecedor: rented ? f.fornecedor.trim() || null : null,
        aluguer_custo: rented ? parseNum(f.custo) : null,
        aluguer_periodicidade: rented ? f.periodicidade : null,
        aluguer_data_inicio: rented ? f.inicio || null : null,
        aluguer_data_fim: rented ? f.fim || null : null,
      }
      const { error } = id ? await supabase.from('vehicles').update(body).eq('id', id) : await supabase.from('vehicles').insert({ ...body, tenant_id: profile!.tenant_id })
      if (error) throw error
    },
    onSuccess: () => {
      setEditing(null)
      void qc.invalidateQueries({ queryKey: ['vehicles'] })
      void qc.invalidateQueries({ queryKey: ['vehicle_options'] })
      void qc.invalidateQueries({ queryKey: ['fleet_slots'] })
    },
  })

  const slotName = (id: string | null) => slots.find((s) => s.id === id)?.nome

  if (isLoading) return <Spinner />
  return (
    <div className="space-y-3">
      <ErrorNote error={error} />
      {editable && (
        <Button onClick={() => setEditing({ id: null, form: vEmpty })} className="w-full sm:w-auto">
          + {t('fleet.newVehicle')}
        </Button>
      )}
      <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
        {vehicles.map((v) => (
          <Card key={v.id} className={editable ? 'cursor-pointer' : ''} onClick={() => editable && setEditing({ id: v.id, form: vFrom(v) })}>
            <div className="flex items-start justify-between">
              <div className="text-lg font-bold">{v.matricula}</div>
              <span className="rounded-full border border-border px-2 py-0.5 text-xs">{t(`fleet.states.${v.estado}`)}</span>
            </div>
            <div className="mt-1 text-sm text-muted">
              {v.tipo === 'propria' ? t('fleet.own') : t('fleet.rented')} · {slotName(v.posto_id) ?? t('fleet.noSlot')}
            </div>
            <div className="mt-3 flex flex-wrap gap-1.5 text-xs">
              {v.iuc_ativo && <Chip color="var(--cost-iuc)">{t('fleet.iuc')} {eur(v.iuc_valor, 0)}</Chip>}
              {v.seguro_ativo && <Chip color="var(--cost-insurance)">{t('fleet.insurance')} {eur(v.seguro_valor, 0)}</Chip>}
              {v.manutencao_ativo && <Chip color="var(--cost-maintenance)">{t('fleet.maintenance')} {eur(v.manutencao_valor, 0)}</Chip>}
              {v.tipo === 'alugada' && v.aluguer_custo !== null && <Chip color="var(--cost-rental)">{t('fleet.rental')} {eur(v.aluguer_custo, 0)}</Chip>}
            </div>
          </Card>
        ))}
      </div>

      <Sheet open={editing !== null} onClose={() => setEditing(null)} title={editing?.id ? editing.form.matricula : t('fleet.newVehicle')}>
        {editing && (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault()
              save.mutate()
            }}
          >
            {(() => {
              const f = editing.form
              const set = (p: Partial<VForm>) => setEditing({ ...editing, form: { ...f, ...p } })
              return (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    <Field label={t('fleet.plate')}>
                      <Input value={f.matricula} onChange={(e) => set({ matricula: e.target.value })} required autoCapitalize="characters" />
                    </Field>
                    <Field label={t('fleet.type')}>
                      <Select value={f.tipo} onChange={(e) => set({ tipo: e.target.value as VForm['tipo'] })}>
                        <option value="propria">{t('fleet.own')}</option>
                        <option value="alugada">{t('fleet.rented')}</option>
                      </Select>
                    </Field>
                    <Field label={t('fleet.slot')}>
                      <Select value={f.posto_id} onChange={(e) => set({ posto_id: e.target.value })}>
                        <option value="">{t('fleet.noSlot')}</option>
                        {slots.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.nome}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label={t('fleet.state')}>
                      <Select value={f.estado} onChange={(e) => set({ estado: e.target.value as VForm['estado'] })}>
                        {(['ativa', 'devolvida', 'em_manutencao', 'vendida'] as const).map((s) => (
                          <option key={s} value={s}>
                            {t(`fleet.states.${s}`)}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  </div>
                  {/* cada custo tem o seu proprio interruptor + valor: nunca "tudo ou nada" */}
                  {(['iuc', 'seguro', 'manutencao'] as const).map((k) => (
                    <div key={k} className="rounded-xl border border-border p-3">
                      <Toggle checked={f[`${k}_ativo`]} onChange={(v) => set({ [`${k}_ativo`]: v } as Partial<VForm>)} label={t(`fleet.${k === 'seguro' ? 'insurance' : k === 'manutencao' ? 'maintenance' : 'iuc'}`)} />
                      {f[`${k}_ativo`] && (
                        <div className="mt-2 grid grid-cols-2 gap-3">
                          <Field label={t('fleet.value')}>
                            <NumInput value={f[`${k}_valor`]} onChange={(e) => set({ [`${k}_valor`]: e.target.value } as Partial<VForm>)} />
                          </Field>
                          {k !== 'manutencao' && (
                            <Field label={t(k === 'iuc' ? 'fleet.iucDue' : 'fleet.insuranceDue')}>
                              <Input type="date" value={k === 'iuc' ? f.iuc_vencimento : f.seguro_vencimento} onChange={(e) => set(k === 'iuc' ? { iuc_vencimento: e.target.value } : { seguro_vencimento: e.target.value })} />
                            </Field>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                  {f.tipo === 'alugada' && (
                    <div className="space-y-3 rounded-xl border border-border p-3">
                      <div className="font-medium">{t('fleet.rental')}</div>
                      <Field label={t('fleet.supplier')}>
                        <Input value={f.fornecedor} onChange={(e) => set({ fornecedor: e.target.value })} />
                      </Field>
                      <div className="grid grid-cols-2 gap-3">
                        <Field label={t('fleet.cost')}>
                          <NumInput value={f.custo} onChange={(e) => set({ custo: e.target.value })} />
                        </Field>
                        <Field label={t('fleet.period')}>
                          <Select value={f.periodicidade} onChange={(e) => set({ periodicidade: e.target.value as VForm['periodicidade'] })}>
                            {(['diario', 'semanal', 'mensal'] as const).map((p) => (
                              <option key={p} value={p}>
                                {t(`fleet.periods.${p}`)}
                              </option>
                            ))}
                          </Select>
                        </Field>
                        <Field label={t('fleet.startDate')}>
                          <Input type="date" value={f.inicio} onChange={(e) => set({ inicio: e.target.value })} />
                        </Field>
                        <Field label={t('fleet.endDate')}>
                          <Input type="date" value={f.fim} onChange={(e) => set({ fim: e.target.value })} />
                        </Field>
                      </div>
                    </div>
                  )}
                </>
              )
            })()}
            <ErrorNote error={save.error} />
            <Button type="submit" className="w-full" disabled={save.isPending}>
              {t('app.save')}
            </Button>
          </form>
        )}
      </Sheet>
    </div>
  )
}

const Chip = ({ color, children }: { color: string; children: React.ReactNode }) => (
  <span className="inline-flex items-center gap-1.5 rounded-full border border-border px-2 py-0.5">
    <span className="h-2 w-2 rounded-full" style={{ background: color }} />
    {children}
  </span>
)

/* ---------------- Postos ---------------- */

function Slots({ editable }: { editable: boolean }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { profile } = useAuth()
  const { data: slots = [], isLoading, error } = useTable<Slot>('fleet_slots', 'id,nome', 'nome')
  const { data: vehicles = [] } = useTable<Vehicle>('vehicles', VCOLS, 'matricula')
  const { data: history = [] } = useQuery({
    queryKey: ['slot_assignments'],
    queryFn: () => unwrap<SlotAssignment[]>(supabase.from('slot_assignments').select('*').order('data_inicio', { ascending: false })),
  })
  const [name, setName] = useState('')
  const add = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from('fleet_slots').insert({ nome: name.trim(), tenant_id: profile!.tenant_id })
      if (error) throw error
    },
    onSuccess: () => {
      setName('')
      void qc.invalidateQueries({ queryKey: ['fleet_slots'] })
    },
  })
  const plate = (id: string) => vehicles.find((v) => v.id === id)?.matricula ?? '—'
  if (isLoading) return <Spinner />
  return (
    <div className="space-y-3">
      <ErrorNote error={error ?? add.error} />
      {editable && (
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (name.trim()) add.mutate()
          }}
        >
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('fleet.newSlot')} />
          <Button type="submit" disabled={add.isPending}>
            {t('app.add')}
          </Button>
        </form>
      )}
      <div className="grid gap-3 md:grid-cols-2">
        {slots.map((s) => {
          const h = history.filter((a) => a.posto_id === s.id)
          return (
            <Card key={s.id}>
              <div className="font-bold">{s.nome}</div>
              <div className="text-xs uppercase tracking-wide text-muted">{t('fleet.history')}</div>
              <div className="mb-2 text-xs text-muted">{t('fleet.historyHint')}</div>
              <ul className="space-y-1 text-sm">
                {h.map((a) => (
                  <li key={a.id} className="flex justify-between">
                    <span>{plate(a.vehicle_id)}</span>
                    <span className="text-muted">
                      {(() => {
                        const s = slotStay(a)
                        return t(`fleet.stay.${s.kind}`, { from: dateShort(s.from), to: s.kind === 'range' ? dateShort(s.to) : '' })
                      })()}
                    </span>
                  </li>
                ))}
                {h.length === 0 && <li className="text-muted">—</li>}
              </ul>
            </Card>
          )
        })}
      </div>
    </div>
  )
}

/* ---------------- Motoristas ---------------- */

function Drivers({ editable }: { editable: boolean }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { profile } = useAuth()
  const { data: drivers = [], isLoading, error } = useTable<Driver>('drivers', 'id,nome,contacto,user_id', 'nome')
  const [name, setName] = useState('')
  const [contact, setContact] = useState('')
  const add = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from('drivers').insert({ nome: name.trim(), contacto: contact.trim() || null, tenant_id: profile!.tenant_id })
      if (error) throw error
    },
    onSuccess: () => {
      setName('')
      setContact('')
      void qc.invalidateQueries({ queryKey: ['drivers'] })
      void qc.invalidateQueries({ queryKey: ['driver_options'] })
    },
  })
  if (isLoading) return <Spinner />
  return (
    <div className="space-y-3">
      <ErrorNote error={error ?? add.error} />
      {editable && (
        <form
          className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]"
          onSubmit={(e) => {
            e.preventDefault()
            if (name.trim()) add.mutate()
          }}
        >
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('fleet.name')} required />
          <Input value={contact} onChange={(e) => setContact(e.target.value)} placeholder={t('fleet.contact')} inputMode="tel" />
          <Button type="submit" disabled={add.isPending}>
            {t('app.add')}
          </Button>
        </form>
      )}
      <Card className="divide-y divide-border p-0">
        {drivers.map((d) => (
          <div key={d.id} className="flex items-center justify-between px-4 py-3">
            <span className="font-medium">{d.nome}</span>
            <span className="text-sm text-muted">{d.contacto ?? ''}</span>
          </div>
        ))}
      </Card>
    </div>
  )
}
