import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '@/auth/AuthProvider'
import { Button, Card, ErrorNote, Field, Input, NumInput, Select, Sheet } from '@/components/ui'
import { supabase } from '@/lib/supabase'
import { unwrap } from '@/lib/queries'
import { allocationStatus, sums, type Movement } from '@/lib/accounting'
import { dateShort, eur, parseNum } from '@/lib/format'
import { MovementCard, type AccCtx } from './shared'

const TONE = { over: 'var(--negative)', under: 'var(--pending)', ok: 'var(--positive)' } as const

/** Distribuicao de fundos: total recebido vs soma alocada. Sobre/sub-alocacao nunca ficam escondidas. */
export function DistributionPanel({ all, ctx, busy, onOpen, onValidate, onAddAllocation }: { all: Movement[]; ctx: AccCtx; busy: boolean; onOpen: (m: Movement) => void; onValidate: (m: Movement) => void; onAddAllocation: (t: Movement) => void }) {
  const { t } = ctx
  const [detail, setDetail] = useState<string | null>(null)
  const live = all.filter((m) => !m.deleted_at)
  const transfers = live.filter((m) => m.subcategoria === 'transferencia_distribuicao' && !m.lancamento_referencia_id)
  const allocOf = (id: string) => live.filter((m) => m.lancamento_referencia_id === id)
  const tr = transfers.find((x) => x.id === detail)
  // alocacoes cuja transferencia ja nao esta ativa (apagada): nunca desaparecem da vista
  const transferIds = new Set(live.map((m) => m.id))
  const orphans = live.filter((m) => m.lancamento_referencia_id && !transferIds.has(m.lancamento_referencia_id))

  const line = (m: Movement) => {
    const s = allocationStatus(m, allocOf(m.id))
    return (
      <>
        <div className="mt-2 text-sm">
          {t('accounting.allocated')}: <b>{eur(s.allocated)}</b> / {eur(m.valor)}
          <span className="ml-2 font-semibold" style={{ color: TONE[s.state] }} data-alloc-state={s.state}>
            {t(`accounting.distributionState.${s.state}`)}{s.state !== 'ok' ? ` ${eur(Math.abs(s.diff))}` : ''}
          </span>
        </div>
        <div className="mt-1 h-2 overflow-hidden rounded-full bg-border">
          <div className="h-full rounded-full" style={{ width: `${Math.min(100, (s.allocated / Number(m.valor)) * 100)}%`, background: TONE[s.state] }} />
        </div>
      </>
    )
  }

  return (
    <div className="grid gap-3 md:grid-cols-2">
      {transfers.map((m) => (
        <Card key={m.id} className="cursor-pointer" onClick={() => setDetail(m.id)}>
          <div className="flex justify-between">
            <span className="font-semibold">{m.pessoa_responsavel ?? '—'}</span>
            <span className="tabular-nums">{eur(m.valor)}</span>
          </div>
          <div className="text-xs text-muted">{dateShort(m.data)}</div>
          {line(m)}
        </Card>
      ))}
      {transfers.length === 0 && orphans.length === 0 && <p className="py-8 text-center text-muted md:col-span-2">{t('app.empty')}</p>}
      {orphans.length > 0 && (
        <section className="space-y-2 md:col-span-2" data-orphans>
          <h3 className="font-semibold">{t('accounting.orphans')}</h3>
          <p className="text-sm text-muted">{t('accounting.orphansHint')}</p>
          {orphans.map((a) => (
            <MovementCard key={a.id} m={a} ctx={ctx} busy={busy} onOpen={() => onOpen(a)} onValidate={ctx.canWrite ? () => onValidate(a) : undefined} />
          ))}
        </section>
      )}

      <Sheet open={tr !== undefined} onClose={() => setDetail(null)} title={tr?.pessoa_responsavel ?? t('accounting.view.distribution')}>
        {tr && (
          <div className="space-y-4">
            <div className="rounded-xl border border-border p-3">
              <div className="text-sm">{t('accounting.received')}: <b>{eur(tr.valor)}</b></div>
              {line(tr)}
            </div>
            <div className="space-y-2">
              {allocOf(tr.id).map((a) => (
                <MovementCard key={a.id} m={a} ctx={ctx} busy={busy} onOpen={() => { setDetail(null); onOpen(a) }} onValidate={ctx.canWrite ? () => onValidate(a) : undefined} />
              ))}
            </div>
            {ctx.canWrite && (
              <Button className="w-full" onClick={() => { setDetail(null); onAddAllocation(tr) }}>+ {t('accounting.addAllocation')}</Button>
            )}
          </div>
        )}
      </Sheet>
    </div>
  )
}

/** Contas bancarias: saldo OFICIAL (so Confirmado) e o que esta por validar, a parte. */
export function AccountsPanel({ all, ctx, onOpenNoAccount }: { all: Movement[]; ctx: AccCtx; onOpenNoAccount?: () => void }) {
  const { t } = ctx
  const qc = useQueryClient()
  const { profile } = useAuth()
  const [n, setN] = useState({ nome: '', banco: '', iban: '' })
  const add = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from('bank_accounts').insert({ nome: n.nome.trim(), banco: n.banco.trim() || null, iban: n.iban.trim() || null, tenant_id: profile!.tenant_id })
      if (error) throw error
    },
    onSuccess: () => { setN({ nome: '', banco: '', iban: '' }); void qc.invalidateQueries({ queryKey: ['bank_accounts'] }) },
  })
  const noAcc = sums(all.filter((m) => m.conta_id === null && !m.deleted_at))
  return (
    <div className="space-y-3">
      {ctx.canWrite && (
        <Card>
          <form className="grid gap-2 sm:grid-cols-[1fr_1fr_1fr_auto]" onSubmit={(e) => { e.preventDefault(); add.mutate() }}>
            <Input placeholder={t('accounting.accountName')} value={n.nome} onChange={(e) => setN({ ...n, nome: e.target.value })} required />
            <Input placeholder={t('accounting.bank')} value={n.banco} onChange={(e) => setN({ ...n, banco: e.target.value })} />
            <Input placeholder="IBAN" value={n.iban} onChange={(e) => setN({ ...n, iban: e.target.value })} />
            <Button type="submit" disabled={add.isPending}>{t('app.add')}</Button>
          </form>
          <ErrorNote error={add.error} />
        </Card>
      )}
      <Card className="divide-y divide-border p-0">
        {[...ctx.accounts.map((a) => ({ key: a.id, name: a.nome, sub: [a.banco, a.iban].filter(Boolean).join(' · '), s: sums(all.filter((m) => m.conta_id === a.id && !m.deleted_at)) })),
          ...(noAcc.pendingCount + noAcc.credit + noAcc.debit > 0 ? [{ key: '__none', name: t('accounting.noAccount'), sub: '', s: noAcc }] : [])].map((r) => (
          <div
            key={r.key}
            className={`flex items-center justify-between gap-3 px-4 py-3${r.key === '__none' && onOpenNoAccount ? ' cursor-pointer hover:bg-field' : ''}`}
            {...(r.key === '__none' && onOpenNoAccount ? { role: 'button', tabIndex: 0, 'data-no-account': true, onClick: onOpenNoAccount, onKeyDown: (e: React.KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') onOpenNoAccount() } } : {})}
          >
            <span className="min-w-0">
              <span className="block truncate font-medium">{r.name}</span>
              <span className="block truncate text-xs text-muted">{r.sub}</span>
            </span>
            <span className="text-right">
              <span className="block font-semibold tabular-nums">{eur(r.s.net)}</span>
              {r.s.pendingCount > 0 && <span className="block text-xs" style={{ color: 'var(--negative)' }}>+ {eur(r.s.pendingAmount)} {t('accounting.summary.toValidate')}</span>}
            </span>
          </div>
        ))}
      </Card>
      <p className="text-xs text-muted">{t('accounting.summary.official')}</p>
    </div>
  )
}

/** Definicoes da Contabilidade: limite de validacao e conta dos lancamentos automaticos (so o Super Admin altera). */
export function SettingsPanel({ ctx, noAccountCount = 0, onShowNoAccount }: { ctx: AccCtx; noAccountCount?: number; onShowNoAccount?: () => void }) {
  const { t } = ctx
  const qc = useQueryClient()
  const { profile } = useAuth()
  const q = useQuery({
    queryKey: ['accounting_settings'],
    queryFn: () => unwrap<{ validation_threshold: number; default_account_id: string | null }[]>(supabase.from('accounting_settings').select('validation_threshold,default_account_id')),
  })
  const cur = q.data?.[0]
  const [threshold, setThreshold] = useState('100')
  const [account, setAccount] = useState('')
  const [saved, setSaved] = useState(false)
  useEffect(() => {
    if (q.data) {
      setThreshold(String(cur?.validation_threshold ?? 100))
      setAccount(cur?.default_account_id ?? '')
    }
  }, [q.data, cur])
  const save = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from('accounting_settings').upsert(
        { tenant_id: profile!.tenant_id, validation_threshold: parseNum(threshold) ?? 100, default_account_id: account || null, updated_by: profile!.id },
        { onConflict: 'tenant_id' },
      )
      if (error) throw error
    },
    onSuccess: () => { setSaved(true); void qc.invalidateQueries({ queryKey: ['accounting_settings'] }) },
  })
  return (
    <Card className="max-w-xl space-y-4">
      <h2 className="font-semibold">{t('accounting.settings.title')}</h2>
      {!q.isLoading && !cur?.default_account_id && noAccountCount > 0 && (
        <div className="rounded-xl border border-border p-3 text-sm" data-testid="no-default-account" style={{ borderColor: 'var(--pending)' }}>
          <p>{t('accounting.noDefaultAccount', { count: noAccountCount })}</p>
          {onShowNoAccount && <Button variant="ghost" className="mt-2 min-h-8" onClick={onShowNoAccount}>{t('accounting.showNoAccount')}</Button>}
        </div>
      )}
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); setSaved(false); save.mutate() }}>
        <Field label={t('accounting.settings.threshold')} hint={t('accounting.settings.thresholdHint')}>
          <NumInput value={threshold} onChange={(e) => setThreshold(e.target.value)} disabled={!ctx.isAdmin} />
        </Field>
        <Field label={t('accounting.settings.defaultAccount')}>
          <Select value={account} onChange={(e) => setAccount(e.target.value)} disabled={!ctx.isAdmin}>
            <option value="">{t('accounting.settings.noneAccount')}</option>
            {ctx.accounts.map((a) => (<option key={a.id} value={a.id}>{a.nome}</option>))}
          </Select>
        </Field>
        {ctx.isAdmin ? (
          <Button type="submit" disabled={save.isPending}>{t('app.save')}</Button>
        ) : (
          <p className="text-sm text-muted">{t('accounting.settings.onlyAdmin')}</p>
        )}
        {saved && <p className="text-sm text-positive">{t('accounting.settings.saved')}</p>}
        <ErrorNote error={save.error} />
      </form>
    </Card>
  )
}
