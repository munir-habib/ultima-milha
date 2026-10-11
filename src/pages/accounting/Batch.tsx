import { useState } from 'react'
import { Button, Select } from '@/components/ui'
import { needsRecord, noRecordExpected, type Movement } from '@/lib/accounting'
import type { AccCtx } from './shared'

/** Barra de acoes em lote (so Contabilista/Super Admin). Validar e atribuir conta a varios movimentos de uma vez. */
export default function BatchBar({ selected, ctx, busy, onValidate, onAssign, onNoRecord, onClear }: {
  selected: Movement[]
  ctx: AccCtx
  busy: boolean
  onValidate: (ids: string[]) => void
  onAssign: (ids: string[], contaId: string) => void
  /** marcar/desmarcar alocacoes por ligar como "sem registo previsto" */
  onNoRecord?: (ids: string[], value: boolean) => void
  onClear: () => void
}) {
  const { t } = ctx
  const [conta, setConta] = useState('')
  if (selected.length === 0) return null
  const pending = selected.filter((m) => m.estado === 'pendente')
  const toMark = selected.filter(needsRecord)
  const toUnmark = selected.filter(noRecordExpected)
  return (
    <div className="sticky bottom-2 z-10 mt-3 flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card p-3 shadow-lg" data-testid="batch-bar">
      <span className="text-sm font-semibold" data-batch-count={selected.length}>{t('accounting.batch.selected', { count: selected.length })}</span>
      {pending.length > 0 && (
        <Button disabled={busy} onClick={() => onValidate(pending.map((m) => m.id))} data-batch-validate>
          {t('accounting.batch.validate', { count: pending.length })}
        </Button>
      )}
      {onNoRecord && toMark.length > 0 && (
        <Button variant="ghost" disabled={busy} onClick={() => onNoRecord(toMark.map((m) => m.id), true)} data-batch-norecord>{t('accounting.batch.noRecord', { count: toMark.length })}</Button>
      )}
      {onNoRecord && toUnmark.length > 0 && (
        <Button variant="ghost" disabled={busy} onClick={() => onNoRecord(toUnmark.map((m) => m.id), false)} data-batch-unnorecord>{t('accounting.batch.backToUnlinked', { count: toUnmark.length })}</Button>
      )}
      <Select value={conta} onChange={(e) => setConta(e.target.value)} aria-label={t('accounting.batch.assign')} className="!min-h-9 !w-auto" data-batch-account>
        <option value="">{t('accounting.batch.assignPlaceholder')}</option>
        {ctx.accounts.map((a) => (<option key={a.id} value={a.id}>{a.nome}</option>))}
      </Select>
      <Button variant="ghost" disabled={busy || !conta} onClick={() => { onAssign(selected.map((m) => m.id), conta); setConta('') }} data-batch-assign>
        {t('accounting.batch.assign')}
      </Button>
      <Button variant="ghost" className="ml-auto" onClick={onClear}>{t('accounting.batch.clear')}</Button>
    </div>
  )
}
