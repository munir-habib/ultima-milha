import type { DragEventHandler, ReactNode } from 'react'
import clsx from 'clsx'
import type { TFunction } from 'i18next'
import { Button } from '@/components/ui'
import { isAllocation, isUnlinked, needsRecord, noRecordExpected, pendingReason, signed, type Movement, type RouteRef } from '@/lib/accounting'
import { dateShort, daysBetween, eur, todayISO } from '@/lib/format'

export interface Account { id: string; nome: string; banco: string | null; iban: string | null }

/** Tudo o que os componentes da Contabilidade precisam para mostrar nomes e decidir permissoes. */
export interface AccCtx {
  t: TFunction
  canWrite: boolean
  isAdmin: boolean
  accounts: Account[]
  ops: { id: string; nome: string }[]
  routes: RouteRef[]
  drivers: { id: string; nome: string }[]
  /** limite de validacao dos automaticos (accounting_settings) — para explicar porque um movimento esta Pendente */
  threshold: number
  accName: (id: string | null) => string
  opName: (id: string | null) => string
  routeName: (id: string | null) => string
  label: (m: Movement) => string
}

/** "Mostrar mais" por blocos (a lista completa continua a alimentar totais, selecao e exportacao). */
export function ShowMore({ rest, next, onClick, ctx }: { rest: number; next: number; onClick: () => void; ctx: AccCtx }) {
  if (rest <= 0) return null
  return (
    <Button variant="ghost" className="w-full" onClick={onClick} data-show-more data-rest={rest}>
      {ctx.t('accounting.showMore', { step: next, rest })}
    </Button>
  )
}

export const Chip = ({ children, tone }: { children: ReactNode; tone?: 'warn' | 'info' }) => (
  <span
    className="inline-flex items-center rounded-full border px-2 py-0.5 text-[11px]"
    style={{ borderColor: tone === 'warn' ? 'var(--pending)' : 'var(--border)', color: tone === 'warn' ? 'var(--pending)' : 'var(--muted)' }}
  >
    {children}
  </span>
)

interface CardProps {
  m: Movement
  ctx: AccCtx
  onOpen: () => void
  onValidate?: () => void
  busy?: boolean
  compact?: boolean
  drag?: { draggable: boolean; onDragStart: DragEventHandler; onDragEnd: DragEventHandler }
  /** selecao para acoes em lote */
  check?: { checked: boolean; onChange: () => void }
}

/** Qualquer lancamento Pendente leva o contorno vermelho, em qualquer vista. */
export function MovementCard({ m, ctx, onOpen, onValidate, busy, compact, drag, check }: CardProps) {
  const { t } = ctx
  const pending = m.estado === 'pendente'
  const reason = pendingReason(m, ctx.threshold)
  const meta = [dateShort(m.data), ctx.accName(m.conta_id), ctx.opName(m.operation_id), m.rota_id ? ctx.routeName(m.rota_id) : null, t(`accounting.origin.${m.origem}`), m.pessoa_responsavel]
    .filter(Boolean)
    .join(' · ')
  return (
    <div
      role="button"
      tabIndex={0}
      data-pending={pending || undefined}
      data-movement={m.id}
      onClick={onOpen}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onOpen()}
      draggable={drag?.draggable}
      onDragStart={drag?.onDragStart}
      onDragEnd={drag?.onDragEnd}
      className={clsx(
        'block w-full cursor-pointer select-none rounded-xl bg-card text-left transition',
        compact ? 'p-2' : 'p-3',
        pending ? 'pending-outline' : 'border border-border',
        drag?.draggable && 'cursor-grab active:cursor-grabbing',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        {check && (
          <input
            type="checkbox"
            data-check
            className="mt-1 h-4 w-4 shrink-0 accent-[var(--brand)]"
            checked={check.checked}
            onChange={check.onChange}
            onClick={(e) => e.stopPropagation()}
            aria-label={t('accounting.batch.select')}
          />
        )}
        <span className="min-w-0 flex-1">
          <span className={clsx('block truncate font-medium', compact && 'text-sm')}>{ctx.label(m)}</span>
          {!compact && <span className="block truncate text-xs text-muted">{meta}</span>}
        </span>
        <span className={clsx('shrink-0 font-semibold', compact && 'text-sm')} style={{ color: m.tipo === 'credito' ? 'var(--positive)' : 'var(--negative)' }}>
          {signed(m) > 0 ? '+' : '−'}
          {eur(m.valor)}
        </span>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <Chip tone={pending ? 'warn' : undefined}>{t(`accounting.state.${m.estado}`)}</Chip>
        {reason && !compact && <span data-reason={reason}><Chip tone="warn">{t(`accounting.reason.${reason}`, { limit: ctx.threshold })}</Chip></span>}
        {compact && <span className="text-[11px] text-muted">{dateShort(m.data)}</span>}
        {needsRecord(m) && <Chip tone="warn">{t('accounting.unlinked')}{daysBetween(m.data, todayISO()) >= 1 ? ` · ${t('accounting.ageDays', { count: daysBetween(m.data, todayISO()) })}` : ''}</Chip>}
        {noRecordExpected(m) && <Chip>{t('accounting.noRecordChip')}</Chip>}
        {isAllocation(m) && !isUnlinked(m) && m.registo_id && !compact && <Chip>{t('accounting.linked')}</Chip>}
        {onValidate && pending && (
          <Button
            variant="ghost"
            className="ml-auto min-h-8 px-3 text-xs"
            disabled={busy}
            onClick={(e) => {
              e.stopPropagation()
              onValidate()
            }}
          >
            {t('accounting.actions.validate')}
          </Button>
        )}
      </div>
    </div>
  )
}
