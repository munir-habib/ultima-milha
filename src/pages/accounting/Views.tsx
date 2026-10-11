import { useState, type ReactNode } from 'react'
import { Card } from '@/components/ui'
import { groupByDay, type Movement, type Sums } from '@/lib/accounting'
import { dateShort, eur } from '@/lib/format'
import { SHOW_STEP, showMoreInfo } from '@/lib/showMore'
import { MovementCard, ShowMore, type AccCtx } from './shared'

interface ListProps {
  list: Movement[]
  ctx: AccCtx
  busy: boolean
  onOpen: (m: Movement) => void
  onValidate: (m: Movement) => void
  empty: string
  /** acoes em lote (so Contabilista/Super Admin): ids selecionados e como alterar */
  batch?: { checked: Set<string>; toggle: (id: string) => void; toggleAll: () => void }
}

/** Lista simples (default) e fila "Por validar": o contorno vermelho vem do proprio cartao. */
export function ListView({ list, ctx, busy, onOpen, onValidate, empty, batch }: ListProps) {
  const [shown, setShown] = useState(SHOW_STEP) // o pai remonta a lista (key) quando mudam os filtros: volta ao 1.o bloco
  if (list.length === 0) return <p className="py-10 text-center text-muted">{empty}</p>
  const { visible, rest, next } = showMoreInfo(list.length, shown)
  const allChecked = batch !== undefined && list.every((m) => batch.checked.has(m.id))
  return (
    <div className="space-y-2" data-testid="movement-list">
      {batch && (
        <label className="flex items-center gap-2 px-1 text-sm text-muted">
          <input type="checkbox" data-check-all className="h-4 w-4 accent-[var(--brand)]" checked={allChecked} onChange={batch.toggleAll} />
          {ctx.t('accounting.batch.selectAll', { count: list.length })}
        </label>
      )}
      {list.slice(0, visible).map((m) => (
        <MovementCard key={m.id} m={m} ctx={ctx} busy={busy} onOpen={() => onOpen(m)} onValidate={ctx.canWrite ? () => onValidate(m) : undefined} check={batch ? { checked: batch.checked.has(m.id), onChange: () => batch.toggle(m.id) } : undefined} />
      ))}
      <ShowMore rest={rest} next={next} onClick={() => setShown((n) => n + SHOW_STEP)} ctx={ctx} />
    </div>
  )
}

/** Alocacoes "por ligar ao operacional" (mais antigas primeiro) e as marcadas "sem registo previsto". */
export function UnlinkedView({ todo, flagged, ctx, busy, onOpen, onValidate, batchTodo, batchFlagged }: {
  todo: Movement[]; flagged: Movement[]; ctx: AccCtx; busy: boolean; onOpen: (m: Movement) => void; onValidate: (m: Movement) => void
  batchTodo?: ListProps['batch']; batchFlagged?: ListProps['batch']
}) {
  const t = ctx.t
  return (
    <div className="space-y-5" data-testid="unlinked-view">
      <p className="text-sm text-muted">{t('accounting.unlinkedView.hint')}</p>
      <section className="space-y-2">
        <h3 className="font-semibold">{t('accounting.unlinkedView.todo', { count: todo.length })}</h3>
        <ListView list={todo} ctx={ctx} busy={busy} onOpen={onOpen} onValidate={onValidate} empty={t('accounting.unlinkedView.empty')} batch={batchTodo} />
      </section>
      {flagged.length > 0 && (
        <section className="space-y-2" data-testid="unlinked-flagged">
          <h3 className="font-semibold">{t('accounting.unlinkedView.flagged', { count: flagged.length })}</h3>
          <ListView list={flagged} ctx={ctx} busy={busy} onOpen={onOpen} onValidate={onValidate} empty="" batch={batchFlagged} />
        </section>
      )}
    </div>
  )
}

/** Subtotal oficial (so Confirmado) + os pendentes a parte, sem os somar ao saldo. */
function SumsLine({ s, ctx }: { s: Sums; ctx: AccCtx }) {
  return (
    <span className="flex flex-wrap items-baseline justify-end gap-x-3 text-sm tabular-nums">
      <b style={{ color: s.net >= 0 ? 'var(--positive)' : 'var(--negative)' }}>{eur(s.net)}</b>
      {s.pendingCount > 0 && (
        <span className="text-xs" style={{ color: 'var(--negative)' }}>
          + {eur(s.pendingAmount)} {ctx.t('accounting.summary.toValidate')}
        </span>
      )}
    </span>
  )
}

interface GroupedProps {
  list: Movement[]
  ctx: AccCtx
  busy: boolean
  onOpen: (m: Movement) => void
  onValidate: (m: Movement) => void
}

/** Dia -> Rota (ou "Geral"). Cada movimento aparece exatamente uma vez. Blocos colapsaveis. */
/** <details> que so monta o conteudo quando esta aberto (fechado, nao poe milhares de cartoes no DOM). */
function LazyDetails({ open, summary, summaryClass, children }: { open: boolean; summary: ReactNode; summaryClass: string; children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(open)
  return (
    <details open={open} onToggle={(e) => setIsOpen(e.currentTarget.open)}>
      <summary className={summaryClass}>{summary}</summary>
      {isOpen ? children : null}
    </details>
  )
}

/** Cartoes de um grupo do Agrupado, um bloco de cada vez (o subtotal do grupo ja conta TODOS). */
function GroupItems({ items, ctx, busy, onOpen, onValidate }: { items: Movement[]; ctx: AccCtx; busy: boolean; onOpen: (m: Movement) => void; onValidate: (m: Movement) => void }) {
  const [shown, setShown] = useState(SHOW_STEP)
  const { visible, rest, next } = showMoreInfo(items.length, shown)
  return (
    <div className="space-y-2 px-2 pb-2">
      {items.slice(0, visible).map((m) => (
        <MovementCard key={m.id} m={m} ctx={ctx} busy={busy} onOpen={() => onOpen(m)} onValidate={ctx.canWrite ? () => onValidate(m) : undefined} />
      ))}
      <ShowMore rest={rest} next={next} onClick={() => setShown((n) => n + SHOW_STEP)} ctx={ctx} />
    </div>
  )
}

export function GroupedView({ list, ctx, busy, onOpen, onValidate }: GroupedProps) {
  const days = groupByDay(list, (id) => ctx.routeName(id), ctx.t('accounting.general'))
  if (days.length === 0) return <p className="py-10 text-center text-muted">{ctx.t('app.empty')}</p>
  return (
    <div className="space-y-3" data-testid="grouped-view">
      {days.map((d, i) => (
        <Card key={d.date} className="p-0">
          <LazyDetails open={i < 3} summary={<><span className="font-semibold">{dateShort(d.date)}</span><SumsLine s={d.sums} ctx={ctx} /></>} summaryClass="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3">
            <div className="space-y-2 border-t border-border px-3 py-3">
              {d.groups.map((g) => (
                <details key={g.key} open className="rounded-xl border border-border">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2">
                    <span className="text-sm font-medium">{g.label}</span>
                    <SumsLine s={g.sums} ctx={ctx} />
                  </summary>
                  <GroupItems items={g.items} ctx={ctx} busy={busy} onOpen={onOpen} onValidate={onValidate} />
                </details>
              ))}
            </div>
          </LazyDetails>
        </Card>
      ))}
    </div>
  )
}
