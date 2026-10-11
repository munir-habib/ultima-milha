import { Button, ErrorNote, Field, Input, NumInput, Select, Sheet } from '@/components/ui'
import type { Movement, Subcat } from '@/lib/accounting'
import { todayISO } from '@/lib/format'
import type { AccCtx } from './shared'

export interface MForm {
  id: string | null
  data: string
  conta_id: string
  tipo: 'debito' | 'credito'
  valor: string
  operation_id: string
  subcategoria: Subcat
  pessoa: string
  ref: string
  rota_id: string
  motorista_id: string
  descricao: string
}

const MANUAL_SUBCATS: Subcat[] = ['manutencao', 'deslocacao_equipa', 'outro', 'transferencia_distribuicao']

export const blankForm = (conta: string, patch: Partial<MForm> = {}): MForm => ({
  id: null, data: todayISO(), conta_id: conta, tipo: 'debito', valor: '', operation_id: '', subcategoria: 'outro', pessoa: '', ref: '', rota_id: '', motorista_id: '', descricao: '', ...patch,
})

export const formFrom = (m: Movement): MForm => ({
  id: m.id, data: m.data, conta_id: m.conta_id ?? '', tipo: m.tipo, valor: String(m.valor), operation_id: m.operation_id ?? '', subcategoria: m.subcategoria,
  pessoa: m.pessoa_responsavel ?? '', ref: m.lancamento_referencia_id ?? '', rota_id: m.rota_id ?? '', motorista_id: m.motorista_id ?? '', descricao: m.descricao ?? '',
})

interface Props {
  form: MForm | null
  setForm: (f: MForm | null) => void
  ctx: AccCtx
  saving: boolean
  error: unknown
  onSubmit: () => void
}

/** Lancamento manual. O estado nao se escolhe: nasce Confirmado (manual) ou Pendente (alocacao de fundos). */
export default function MovementForm({ form, setForm, ctx, saving, error, onSubmit }: Props) {
  const { t } = ctx
  return (
    <Sheet open={form !== null} onClose={() => setForm(null)} title={form?.id ? t('app.edit') : t('accounting.newMovement')}>
      {form && (
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); onSubmit() }}>
          {(() => {
            const set = (p: Partial<MForm>) => setForm({ ...form, ...p })
            const routes = ctx.routes.filter((r) => r.operation_id === form.operation_id)
            const allocation = form.ref !== ''
            return (
              <>
                <p className="rounded-xl border border-border px-3 py-2 text-xs text-muted">
                  {allocation ? t('accounting.newMovementHint.allocation') : t('accounting.newMovementHint.manual')}
                </p>
                <div className="grid grid-cols-2 gap-3">
                  <Field label={t('register.date')}>
                    <Input type="date" value={form.data} onChange={(e) => set({ data: e.target.value })} required />
                  </Field>
                  <Field label={t('accounting.account')}>
                    <Select value={form.conta_id} onChange={(e) => set({ conta_id: e.target.value })} required>
                      {ctx.accounts.map((a) => (<option key={a.id} value={a.id}>{a.nome}</option>))}
                    </Select>
                  </Field>
                  <Field label={t('accounting.type')}>
                    <Select value={form.tipo} onChange={(e) => set({ tipo: e.target.value as MForm['tipo'] })}>
                      <option value="debito">{t('accounting.debit')}</option>
                      <option value="credito">{t('accounting.credit')}</option>
                    </Select>
                  </Field>
                  <Field label={t('register.amount')}>
                    <NumInput value={form.valor} onChange={(e) => set({ valor: e.target.value })} required />
                  </Field>
                </div>
                <Field label={t('accounting.category')} hint={form.operation_id ? t('accounting.origin.manual_rota') : t('accounting.origin.manual_geral')}>
                  <Select value={form.operation_id} onChange={(e) => set({ operation_id: e.target.value, rota_id: '' })}>
                    <option value="">{t('accounting.other')}</option>
                    {ctx.ops.map((o) => (<option key={o.id} value={o.id}>{o.nome}</option>))}
                  </Select>
                </Field>
                <Field label={t('accounting.subcategory')}>
                  <Select value={form.subcategoria} onChange={(e) => set({ subcategoria: e.target.value as Subcat })}>
                    {MANUAL_SUBCATS.map((s) => (<option key={s} value={s}>{t(`accounting.sub.${s}`)}</option>))}
                  </Select>
                </Field>
                {form.operation_id && (
                  <div className="grid grid-cols-2 gap-3">
                    <Field label={t('register.route')}>
                      <Select value={form.rota_id} onChange={(e) => set({ rota_id: e.target.value })}>
                        <option value="">{t('register.none')}</option>
                        {routes.map((r) => (<option key={r.id} value={r.id}>{r.nome}</option>))}
                      </Select>
                    </Field>
                    <Field label={t('dashboard.driver')}>
                      <Select value={form.motorista_id} onChange={(e) => set({ motorista_id: e.target.value })}>
                        <option value="">{t('register.none')}</option>
                        {ctx.drivers.map((d) => (<option key={d.id} value={d.id}>{d.nome}</option>))}
                      </Select>
                    </Field>
                  </div>
                )}
                <Field label={t('accounting.person')}>
                  <Input value={form.pessoa} onChange={(e) => set({ pessoa: e.target.value })} />
                </Field>
                <Field label={t('accounting.description')}>
                  <Input value={form.descricao} onChange={(e) => set({ descricao: e.target.value })} />
                </Field>
                {allocation && form.operation_id && form.rota_id && <p className="text-xs text-muted">{t('accounting.propagateHint')}</p>}
              </>
            )
          })()}
          <ErrorNote error={error} />
          <Button type="submit" className="w-full" disabled={saving}>{t('app.save')}</Button>
        </form>
      )}
    </Sheet>
  )
}
