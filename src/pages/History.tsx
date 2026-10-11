import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '@/auth/AuthProvider'
import { useOp } from '@/components/OpContext'
import { Button, Card, ErrorNote, PageTitle, Pill, Spinner, StatusBadge } from '@/components/ui'
import { supabase } from '@/lib/supabase'
import { unwrap, useRouteOptions } from '@/lib/queries'
import { canValidate } from '@/lib/roles'
import { ORDER_STATES, type RecordStatus } from '@/lib/types'
import { dateShort, eur, num } from '@/lib/format'

interface Row {
  id: string
  route_id: string
  data: string
  status: RecordStatus
  km: number | null
  receita_total: number
  enc_entregues: number | null
  enc_devolucoes: number | null
  enc_recolhas: number | null
  enc_canceladas: number | null
  enc_transitadas: number | null
  enc_pendentes_entrega: number | null
  enc_pendentes_recolha: number | null
}

const COLS = 'id,route_id,data,status,km,receita_total,enc_entregues,enc_devolucoes,enc_recolhas,enc_canceladas,enc_transitadas,enc_pendentes_entrega,enc_pendentes_recolha'

export default function History() {
  const { t } = useTranslation()
  const nav = useNavigate()
  const qc = useQueryClient()
  const { roles } = useAuth()
  const manager = canValidate({ roles, accountingRead: false })
  const { opId } = useOp()
  const { data: routes = [] } = useRouteOptions()
  const [status, setStatus] = useState<RecordStatus | 'all'>('all')

  const { data, isLoading, error } = useQuery({
    queryKey: ['records', 'history'],
    queryFn: () => unwrap<Row[]>(supabase.from('daily_records').select(COLS).is('deleted_at', null).order('data', { ascending: false }).limit(300)),
  })

  const setState = useMutation({
    mutationFn: async ({ id, status }: { id: string; status: RecordStatus }) => {
      const { error } = await supabase.from('daily_records').update({ status }).eq('id', id)
      if (error) throw error
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['records'] }),
  })

  const routeName = useMemo(() => Object.fromEntries(routes.map((r) => [r.id, r.nome])), [routes])
  const routeOp = useMemo(() => Object.fromEntries(routes.map((r) => [r.id, r.operation_id])), [routes])
  const rows = (data ?? []).filter((r) => (opId === 'all' || routeOp[r.route_id] === opId) && (status === 'all' || r.status === status))
  const orders = (r: Row) => ORDER_STATES.reduce((a, s) => a + (((r as unknown as Record<string, number | null>)[`enc_${s}`]) ?? 0), 0)

  const actions = (r: Row) =>
    manager && (
      <div className="flex gap-2" onClick={(e) => e.stopPropagation()}>
        {r.status !== 'validado' && (
          <Button variant="ghost" className="min-h-9 px-3" disabled={setState.isPending} onClick={() => setState.mutate({ id: r.id, status: 'validado' })}>
            {t('register.validate')}
          </Button>
        )}
        {r.status === 'validado' && (
          <Button variant="ghost" className="min-h-9 px-3" disabled={setState.isPending} onClick={() => setState.mutate({ id: r.id, status: 'submetido' })}>
            {t('register.reopen')}
          </Button>
        )}
      </div>
    )

  const open = (r: Row) => nav(`/registar?rota=${r.route_id}&data=${r.data}`)

  return (
    <div>
      <PageTitle>{t('history.title')}</PageTitle>
      <div className="mb-4 flex flex-wrap gap-2">
        <Pill active={status === 'all'} onClick={() => setStatus('all')}>
          {t('app.all')}
        </Pill>
        {(['rascunho', 'submetido', 'validado'] as RecordStatus[]).map((s) => (
          <Pill key={s} active={status === s} onClick={() => setStatus(s)}>
            {t(`status.${s}`)}
          </Pill>
        ))}
      </div>
      <ErrorNote error={error ?? setState.error} />
      {isLoading ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <p className="py-10 text-center text-muted">{t('history.empty')}</p>
      ) : (
        <>
          {/* Mobile: cartoes (sem tabelas com scroll horizontal) */}
          <div className="space-y-2 md:hidden">
            {rows.map((r) => (
              <Card key={r.id} className="cursor-pointer" onClick={() => open(r)}>
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="font-semibold">{routeName[r.route_id] ?? '—'}</div>
                    <div className="text-sm text-muted">{dateShort(r.data)}</div>
                  </div>
                  <StatusBadge status={r.status} />
                </div>
                <div className="mt-2 flex items-end justify-between">
                  <div className="text-sm text-muted">
                    {num(orders(r))} {t('history.orders')} · {num(r.km ?? 0)} km
                  </div>
                  <div className="text-lg font-bold text-revenue">{eur(r.receita_total)}</div>
                </div>
                <div className="mt-2">{actions(r)}</div>
              </Card>
            ))}
          </div>
          {/* Tablet/desktop: tabela completa */}
          <Card className="hidden overflow-hidden p-0 md:block">
            <table className="w-full text-sm">
              <thead className="border-b border-border text-left text-muted">
                <tr>
                  <th className="px-4 py-3 font-medium">{t('register.date')}</th>
                  <th className="px-4 py-3 font-medium">{t('register.route')}</th>
                  <th className="px-4 py-3 text-right font-medium">{t('orders.total')}</th>
                  <th className="px-4 py-3 text-right font-medium">{t('register.km')}</th>
                  <th className="px-4 py-3 text-right font-medium">{t('history.revenue')}</th>
                  <th className="px-4 py-3 font-medium" />
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((r) => (
                  <tr key={r.id} className="cursor-pointer hover:bg-field" onClick={() => open(r)}>
                    <td className="px-4 py-3">{dateShort(r.data)}</td>
                    <td className="px-4 py-3">{routeName[r.route_id] ?? '—'}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{num(orders(r))}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{num(r.km ?? 0)}</td>
                    <td className="px-4 py-3 text-right font-semibold tabular-nums text-revenue">{eur(r.receita_total)}</td>
                    <td className="px-4 py-3">
                      <StatusBadge status={r.status} />
                    </td>
                    <td className="px-4 py-3">{actions(r)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </>
      )}
    </div>
  )
}
