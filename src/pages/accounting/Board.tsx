import { useEffect, useState } from 'react'
import clsx from 'clsx'
import { Button, ErrorNote, Field, Select, Sheet } from '@/components/ui'
import { GERAL, MoveCancelled, boardRows, movePatch, type MovePatch, type MovState, type Movement } from '@/lib/accounting'
import { keyedSerial } from '@/lib/serial'
import { SHOW_STEP, showMoreInfo } from '@/lib/showMore'
import { MovementCard, ShowMore, type AccCtx } from './shared'

/** Arrasto completo so em ecras largos com rato/caneta; em toque usa-se o bottom sheet. */
function useDragCapable() {
  const q = '(min-width: 768px) and (pointer: fine)'
  const [ok, setOk] = useState(() => typeof window !== 'undefined' && window.matchMedia(q).matches)
  useEffect(() => {
    const mq = window.matchMedia(q)
    const on = () => setOk(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return ok
}

interface Props {
  list: Movement[]
  ctx: AccCtx
  /** aplica a atualizacao (uma so) e rejeita se falhar */
  apply: (id: string, patch: MovePatch) => Promise<void>
  onOpen: (m: Movement) => void
  /** pede o bottom sheet "Mover" (toque) - renderizado pelo ecra principal */
  onMoveRequest: (m: Movement) => void
}

export default function Board({ list, ctx, apply, onOpen, onMoveRequest }: Props) {
  const { t } = ctx
  const dragOk = useDragCapable()
  const writable = ctx.canWrite
  const [overlay, setOverlay] = useState<Record<string, MovePatch>>({}) // atualizacao otimista
  const [dragId, setDragId] = useState<string | null>(null)
  const [over, setOver] = useState<string | null>(null)
  // quantos cartoes se desenham por celula (a celula so mostra um bloco; os totais nao dependem disto)
  const [cellShown, setCellShown] = useState<Record<string, number>>({})
  const [error, setError] = useState<string | null>(null)

  // aplica o overlay otimista por cima dos dados
  const shown = list.map((m) => (overlay[m.id] ? ({ ...m, ...overlay[m.id] } as Movement) : m))
  const rows = boardRows(shown, ctx.routes, t('accounting.general'))

  // Arrastos consecutivos do MESMO cartao correm em serie (o 2.o so parte quando o 1.o termina): sem PATCH concorrentes,
  // o resultado e sempre o do ultimo arrasto. O overlay otimista so cai quando a cadeia do cartao acaba.
  const [serial] = useState(() => keyedSerial())

  function move(m: Movement, target: { estado?: MovState; row?: string }): Promise<void> {
    const patch = movePatch(m, target, ctx.routes) // m ja inclui o overlay de um arrasto anterior ainda em curso
    if (!patch) return Promise.resolve()
    setError(null)
    setOverlay((o) => ({ ...o, [m.id]: { ...o[m.id], ...patch } })) // move ja o cartao
    return serial.run(
      m.id,
      async () => {
        try {
          await apply(m.id, patch)
        } catch (e) {
          if (e instanceof MoveCancelled) return // o utilizador desistiu: o cartao volta ao sitio sem mensagem de erro
          setError(t('accounting.board.failed', { msg: e instanceof Error ? e.message : String(e) })) // o cartao volta ao sitio
        }
      },
      () =>
        setOverlay((o) => {
          const { [m.id]: _drop, ...rest } = o
          void _drop
          return rest
        }),
    )
  }

  const cols: MovState[] = ['pendente', 'confirmado']
  const colLabel = (c: MovState) => t(c === 'pendente' ? 'accounting.board.pending' : 'accounting.board.confirmed')
  const total = list.length

  return (
    <div className="space-y-3" data-testid="board">
      <p className="text-xs text-muted">
        {!writable ? t('accounting.board.readOnly') : dragOk ? t('accounting.board.dragHint') : t('accounting.board.mobileHint')}
      </p>
      {error && <ErrorNote error={new Error(error)} />}
      {total === 0 && <p className="py-8 text-center text-muted">{t('accounting.board.empty')}</p>}

      <div className={clsx('overflow-x-auto', total === 0 && 'hidden')}>
        <div className="min-w-[560px] space-y-2">
          <div className="grid grid-cols-[minmax(90px,140px)_1fr_1fr] gap-2 px-1 text-xs font-semibold uppercase tracking-wide text-muted">
            <span />
            {cols.map((c) => (<span key={c}>{colLabel(c)}</span>))}
          </div>
          {rows.map((r) => (
            <div key={r.key} className="grid grid-cols-[minmax(90px,140px)_1fr_1fr] gap-2" data-row={r.key}>
              <div className="pt-2 text-sm font-medium">{r.label}</div>
              {cols.map((c) => {
                const cell = `${r.key}|${c}`
                return (
                  <div
                    key={c}
                    data-cell={cell}
                    onDragOver={(e) => { if (dragId && writable) { e.preventDefault(); setOver(cell) } }}
                    onDragLeave={() => setOver((o) => (o === cell ? null : o))}
                    onDrop={(e) => {
                      e.preventDefault()
                      const m = shown.find((x) => x.id === (dragId ?? e.dataTransfer.getData('text/plain')))
                      setOver(null)
                      setDragId(null)
                      if (m) void move(m, { estado: c, row: r.key }) // m = cartao como se ve (com o overlay otimista)
                    }}
                    className={clsx(
                      'min-h-16 space-y-2 rounded-xl border border-dashed p-2 transition',
                      over === cell ? 'border-brand bg-brand/10' : 'border-border bg-field/40',
                    )}
                  >
                    {r.cells[c].slice(0, showMoreInfo(r.cells[c].length, cellShown[cell] ?? SHOW_STEP).visible).map((m) => (
                      <MovementCard
                        key={m.id}
                        m={m}
                        ctx={ctx}
                        compact
                        onOpen={() => (dragOk || !writable ? onOpen(m) : onMoveRequest(m))}
                        drag={writable && dragOk ? { draggable: true, onDragStart: (e) => { setDragId(m.id); e.dataTransfer.setData('text/plain', m.id); e.dataTransfer.effectAllowed = 'move' }, onDragEnd: () => { setDragId(null); setOver(null) } } : undefined}
                      />
                    ))}
                    {(() => {
                      const { rest, next } = showMoreInfo(r.cells[c].length, cellShown[cell] ?? SHOW_STEP)
                      return <ShowMore rest={rest} next={next} onClick={() => setCellShown((s) => ({ ...s, [cell]: (s[cell] ?? SHOW_STEP) + SHOW_STEP }))} ctx={ctx} />
                    })()}
                  </div>
                )
              })}
            </div>
          ))}
        </div>
      </div>

    </div>
  )
}

/** Mesma acao do arrasto, por toque: escolher o destino num bottom sheet. */
export function MoveSheet({ m, ctx, onClose, onApply, onOpen }: { m: Movement | null; ctx: AccCtx; onClose: () => void; onApply: (t: { estado: MovState; row: string }) => void; onOpen?: (m: Movement) => void }) {
  const { t } = ctx
  const [estado, setEstado] = useState<MovState>('pendente')
  const [row, setRow] = useState<string>(GERAL)
  useEffect(() => {
    if (m) { setEstado(m.estado); setRow(m.rota_id ?? GERAL) }
  }, [m])
  return (
    <Sheet open={m !== null} onClose={onClose} title={t('accounting.board.moveTitle')}>
      {m && (
        <div className="space-y-4">
          <div className="font-medium">{ctx.label(m)}</div>
          <Field label={t('accounting.board.moveState')}>
            <Select value={estado} onChange={(e) => setEstado(e.target.value as MovState)}>
              <option value="pendente">{t('accounting.board.pending')}</option>
              <option value="confirmado">{t('accounting.board.confirmed')}</option>
            </Select>
          </Field>
          <Field label={t('accounting.board.moveRow')}>
            <Select value={row} onChange={(e) => setRow(e.target.value)}>
              {ctx.routes.map((r) => (<option key={r.id} value={r.id}>{r.nome}</option>))}
              <option value={GERAL}>{t('accounting.general')}</option>
            </Select>
          </Field>
          <Button className="w-full" onClick={() => onApply({ estado, row })}>{t('accounting.board.apply')}</Button>
          {onOpen && <Button variant="ghost" className="w-full" onClick={() => { onClose(); onOpen(m) }}>{t('app.edit')}…</Button>}
        </div>
      )}
    </Sheet>
  )
}
