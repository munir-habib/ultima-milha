import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Button, ErrorNote, Field, Input, Select, Sheet } from '@/components/ui'
import { supabase } from '@/lib/supabase'
import { unwrap } from '@/lib/queries'
import { MOVEMENT_COLS, isUnlinked, needsRecord, noRecordExpected, pendingReason, type Movement } from '@/lib/accounting'
import { dateShort, eur } from '@/lib/format'
import { Chip, type AccCtx } from './shared'

interface AuditRow { id: number; acao: string; user_id: string | null; em: string; antes: Record<string, unknown> | null; depois: Record<string, unknown> | null }

const SHOWN = ['estado', 'valor', 'rota_id', 'operation_id', 'conta_id', 'data', 'descricao', 'pessoa_responsavel', 'deleted_at', 'motivo_apagado']

interface Props {
  m: Movement | null
  ctx: AccCtx
  busy: boolean
  error: unknown
  onClose: () => void
  onPatch: (id: string, patch: Partial<Movement>) => void
  onEdit: (m: Movement) => void
  onMove: (m: Movement) => void
  onDelete: (id: string, reason: string) => void
}

export default function Detail({ m, ctx, busy, error, onClose, onPatch, onEdit, onMove, onDelete }: Props) {
  const { t } = ctx
  const [reason, setReason] = useState('')
  const [delOpen, setDelOpen] = useState(false)
  const [ask, setAsk] = useState(false)
  const [note, setNote] = useState('')
  // pedir ao Gestor da operacao a correcao de um automatico (o automatico so muda no registo diario, que o Contabilista nao le)
  const request = useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await supabase.rpc('request_cost_correction', { p_movement: id, p_note: note.trim() || null })
      if (error) throw error
      return Number(data)
    },
    onSuccess: () => { setAsk(false); setNote('') },
  })

  // historico de versoes (inclui as substituidas, que estao soft-deleted)
  const versions = useQuery({
    enabled: Boolean(m && m.origem === 'automatico' && m.registo_id && m.custo_tipo),
    queryKey: ['movement-versions', m?.registo_id, m?.custo_tipo, m?.id],
    queryFn: () => unwrap<Movement[]>(supabase.from('movements').select(MOVEMENT_COLS).eq('registo_id', m!.registo_id!).eq('custo_tipo', m!.custo_tipo!).eq('origem', 'automatico').order('created_at')),
  })
  // transferencia de origem (uma alocacao cuja transferencia foi apagada continua a existir e diz-o)
  const parent = useQuery({
    enabled: Boolean(m && m.lancamento_referencia_id),
    queryKey: ['movement-parent', m?.lancamento_referencia_id],
    queryFn: () => unwrap<Movement[]>(supabase.from('movements').select(MOVEMENT_COLS).eq('id', m!.lancamento_referencia_id!)).then((r) => r[0] ?? null),
  })
  // registo diario de origem/ligado (o Contabilista nao le daily_records: vem por RPC; a rota do MOVIMENTO pode ter sido reclassificada)
  const origin = useQuery({
    enabled: Boolean(m && m.registo_id),
    queryKey: ['movement-origin', m?.id, m?.registo_id],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('movement_origin_record', { p_movement: m!.id })
      if (error) throw error
      return ((data ?? []) as { route: string; data: string }[])[0] ?? null
    },
  })
  // registo de alteracoes (so o Super Admin le o audit_log)
  const audit = useQuery({
    enabled: Boolean(m && ctx.isAdmin),
    queryKey: ['movement-audit', m?.id],
    queryFn: async () => {
      const [rows, people] = await Promise.all([
        unwrap<AuditRow[]>(supabase.from('audit_log').select('id,acao,user_id,em,antes,depois').eq('tabela', 'movements').eq('registo_id', m!.id).order('id', { ascending: false }).limit(30)),
        unwrap<{ id: string; nome: string }[]>(supabase.from('profiles').select('id,nome')),
      ])
      return { rows, name: Object.fromEntries(people.map((p) => [p.id, p.nome])) as Record<string, string> }
    },
  })

  if (!m) return null
  const deleted = Boolean(m.deleted_at)
  const auto = m.origem === 'automatico'
  const validator = audit.data?.name[m.validado_por ?? ''] ?? ''
  const changed = (a: AuditRow) =>
    SHOWN.filter((k) => JSON.stringify(a.antes?.[k]) !== JSON.stringify(a.depois?.[k]) && a.antes && a.depois).map((k) => `${k}: ${String(a.antes![k] ?? '—')} → ${String(a.depois![k] ?? '—')}`)

  return (
    <Sheet open onClose={() => { setDelOpen(false); setReason(''); onClose() }} title={ctx.label(m)}>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-2xl font-bold" style={{ color: m.tipo === 'credito' ? 'var(--positive)' : 'var(--negative)' }}>
            {m.tipo === 'credito' ? '+' : '−'}{eur(m.valor)}
          </span>
          <Chip tone={m.estado === 'pendente' ? 'warn' : undefined}>{t(`accounting.state.${m.estado}`)}</Chip>
          {needsRecord(m) && <Chip tone="warn">{t('accounting.unlinked')}</Chip>}
          {noRecordExpected(m) && <Chip>{t('accounting.noRecordChip')}</Chip>}
        </div>
        {m.estado === 'pendente' && !deleted && (
          <p className="text-sm text-muted">
            <b data-reason={pendingReason(m, ctx.threshold) ?? undefined}>{t(`accounting.reason.${pendingReason(m, ctx.threshold)}`, { limit: ctx.threshold })}</b> · {t('accounting.detail.pendingNote')}
          </p>
        )}
        {needsRecord(m) && <p className="text-sm text-muted">{t('accounting.unlinkedHint')}</p>}
        {noRecordExpected(m) && <p className="text-sm text-muted">{t('accounting.noRecordHint')}</p>}
        {parent.data?.deleted_at && (
          <div className="rounded-xl border border-border p-3 text-sm" data-parent-removed>
            <b>{t('accounting.detail.parentRemoved')}</b>
            <p className="text-muted">{t('accounting.detail.parentRemovedHint', { date: dateShort(parent.data.deleted_at.slice(0, 10)), reason: parent.data.motivo_apagado ?? '—' })}</p>
          </div>
        )}

        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-muted">{t('register.date')}</dt><dd>{dateShort(m.data)}</dd>
          <dt className="text-muted">{t('accounting.account')}</dt><dd>{ctx.accName(m.conta_id)}</dd>
          <dt className="text-muted">{t('accounting.category')}</dt><dd>{ctx.opName(m.operation_id)}</dd>
          {m.rota_id && (<><dt className="text-muted">{t('register.route')}</dt><dd>{ctx.routeName(m.rota_id)}</dd></>)}
          {origin.data && (
            <><dt className="text-muted">{t(auto ? 'accounting.detail.originRecord' : 'accounting.detail.linkedRecord')}</dt><dd data-record-link>{origin.data.route} · {dateShort(origin.data.data)}</dd></>
          )}
          <dt className="text-muted">{t('accounting.subcategory')}</dt><dd>{t(`accounting.sub.${m.subcategoria}`)}</dd>
          <dt className="text-muted">{t('export.origin')}</dt><dd>{t(`accounting.origin.${m.origem}`)}</dd>
          {m.pessoa_responsavel && (<><dt className="text-muted">{t('accounting.person')}</dt><dd>{m.pessoa_responsavel}</dd></>)}
          {m.descricao && (<><dt className="text-muted">{t('accounting.description')}</dt><dd>{m.descricao}</dd></>)}
        </dl>
        {m.validado_em && m.estado === 'confirmado' && <p className="text-xs text-muted">{t('accounting.detail.validatedBy', { name: validator || '—', date: dateShort(m.validado_em.slice(0, 10)) })}</p>}
        {deleted && (
          <div className="rounded-xl border border-border p-3 text-sm">
            <b>{t('settings.delete')}</b> · {dateShort((m.deleted_at as string).slice(0, 10))} · {t('accounting.detail.reason')}: {m.motivo_apagado}
          </div>
        )}

        {auto && <p className="text-xs text-muted">{t('accounting.detail.editInDaily')}</p>}
        {ctx.canWrite && !deleted && auto && m.operation_id && (
          <div className="space-y-2" data-request-correction>
            {!ask ? (
              <Button variant="ghost" onClick={() => { request.reset(); setAsk(true) }}>{t('accounting.detail.requestCorrection')}</Button>
            ) : (
              <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); request.mutate(m.id) }}>
                <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('accounting.detail.requestNote')} maxLength={500} />
                <div className="flex gap-2">
                  <Button type="submit" disabled={request.isPending}>{t('accounting.detail.requestSend')}</Button>
                  <Button type="button" variant="ghost" onClick={() => setAsk(false)}>{t('app.cancel')}</Button>
                </div>
              </form>
            )}
            {request.isSuccess && <p className="text-sm text-muted" data-request-result={request.data}>{request.data > 0 ? t('accounting.detail.requestSent') : request.data < 0 ? t('accounting.detail.requestNobody') : t('accounting.detail.requestAlready')}</p>}
            <ErrorNote error={request.error} />
          </div>
        )}

        {/* historico de versoes do lancamento automatico */}
        {versions.data && versions.data.length > 1 && (
          <section>
            <h3 className="mb-2 font-semibold">{t('accounting.detail.versions')}</h3>
            <ol className="space-y-1.5 text-sm">
              {versions.data.map((v, i) => (
                <li key={v.id} className={`flex flex-wrap items-center gap-2 rounded-lg border px-2 py-1.5 ${v.id === m.id ? 'border-brand' : 'border-border'}`}>
                  <span className="text-muted">v{i + 1}</span>
                  <b className="tabular-nums">{eur(v.valor)}</b>
                  <Chip tone={v.estado === 'pendente' ? 'warn' : undefined}>{t(`accounting.state.${v.estado}`)}</Chip>
                  <span className="text-xs text-muted">{v.deleted_at ? `${t('accounting.detail.replaced')} — ${v.motivo_apagado ?? ''}` : t('accounting.detail.active')}</span>
                </li>
              ))}
            </ol>
          </section>
        )}

        {/* acoes (so Contabilista / Super Admin; o Auditor so le) */}
        {ctx.canWrite && !deleted && (
          <div className="flex flex-wrap gap-2">
            {m.estado === 'pendente' ? (
              <Button disabled={busy} onClick={() => onPatch(m.id, { estado: 'confirmado' })}>{t('accounting.actions.validate')}</Button>
            ) : (
              <Button variant="ghost" disabled={busy} onClick={() => onPatch(m.id, { estado: 'pendente' })}>{t('accounting.actions.revert')}</Button>
            )}
            <Button variant="ghost" onClick={() => onMove(m)}>{t('accounting.actions.move')}</Button>
            {!auto && <Button variant="ghost" onClick={() => onEdit(m)}>{t('accounting.actions.edit')}</Button>}
            {isUnlinked(m) && (
              <Button variant="ghost" disabled={busy} onClick={() => onPatch(m.id, { sem_registo_previsto: !m.sem_registo_previsto })} data-norecord-toggle>
                {t(m.sem_registo_previsto ? 'accounting.actions.backToUnlinked' : 'accounting.actions.noRecord')}
              </Button>
            )}
          </div>
        )}

        {ctx.canWrite && !deleted && auto && (
          <Field label={t('accounting.actions.assignAccount')}>
            <Select value={m.conta_id ?? ''} onChange={(e) => onPatch(m.id, { conta_id: e.target.value || null })} disabled={busy}>
              <option value="">{t('accounting.noAccount')}</option>
              {ctx.accounts.map((a) => (<option key={a.id} value={a.id}>{a.nome}</option>))}
            </Select>
          </Field>
        )}

        {ctx.isAdmin && !deleted && (
          <div className="space-y-2 border-t border-border pt-3">
            {!delOpen ? (
              <Button variant="danger" onClick={() => setDelOpen(true)}>{t('accounting.actions.delete')}</Button>
            ) : (
              <>
                <Field label={t('accounting.detail.reasonLabel')}>
                  <Input value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
                </Field>
                <Button variant="danger" disabled={busy || reason.trim() === ''} onClick={() => onDelete(m.id, reason.trim())}>{t('accounting.detail.deleteConfirm')}</Button>
              </>
            )}
          </div>
        )}
        <ErrorNote error={error} />

        {ctx.isAdmin && audit.data && audit.data.rows.length > 0 && (
          <section>
            <h3 className="mb-2 font-semibold">{t('accounting.detail.audit')}</h3>
            <ul className="space-y-1 text-xs text-muted">
              {audit.data.rows.map((a) => (
                <li key={a.id}>
                  {new Date(a.em).toLocaleString()} · {audit.data.name[a.user_id ?? ''] ?? '—'} · {a.acao}
                  {a.acao !== 'INSERT' && changed(a).length > 0 && <span className="block pl-3">{changed(a).join(' · ')}</span>}
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </Sheet>
  )
}
