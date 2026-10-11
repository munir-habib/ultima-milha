import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '@/auth/AuthProvider'
import { supabase } from '@/lib/supabase'
import { unwrap } from '@/lib/queries'
import { Button, Sheet } from './ui'
import { Icon } from './Icon'
import { dateShort } from '@/lib/format'

interface Notif {
  id: string
  tipo: string
  payload: Record<string, string | number | null>
  lido_em: string | null
  created_at: string
}

function target(n: Notif, canRegister: boolean): string {
  const p = n.payload
  switch (n.tipo) {
    case 'record_submitted':
    case 'record_reopened':
    case 'record_missing':
      return p.route_id ? `/registar?rota=${p.route_id}${p.data ? `&data=${p.data}` : ''}` : '/historico'
    case 'fund_unreconciled':
    case 'fund_over_allocated':
      return '/contabilidade'
    case 'movement_pending':
      return p.movement_id ? `/contabilidade?view=validate&mov=${p.movement_id}` : '/contabilidade?view=validate'
    case 'allocation_unlinked':
      // quem pode registar vai criar o registo diario em falta; o Contabilista ve as distribuicoes
      return canRegister && p.route_id ? `/registar?rota=${p.route_id}${p.data ? `&data=${p.data}` : ''}` : '/contabilidade?view=unlinked'
    case 'auto_cost_disputed':
      return p.route_id ? `/registar?rota=${p.route_id}${p.data ? `&data=${p.data}` : ''}` : '/historico'
    case 'cost_due':
      return '/viaturas'
    default:
      return '/'
  }
}

export default function NotificationBell() {
  const { t } = useTranslation()
  const nav = useNavigate()
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const { roles } = useAuth()
  const canRegister = roles.some((r) => r === 'super_admin' || r === 'gestor' || r === 'operador')

  const { data = [] } = useQuery({
    queryKey: ['notifications'],
    refetchInterval: 60_000,
    queryFn: () => unwrap<Notif[]>(supabase.from('notifications').select('id,tipo,payload,lido_em,created_at').order('created_at', { ascending: false }).limit(40)),
  })
  // contagem VERDADEIRA de nao lidas (a lista so traz as 40 mais recentes)
  const { data: unreadCount = 0 } = useQuery({
    queryKey: ['notifications', 'unread'],
    refetchInterval: 60_000,
    queryFn: async () => {
      const { count, error } = await supabase.from('notifications').select('id', { count: 'exact', head: true }).is('lido_em', null)
      if (error) throw error
      return count ?? 0
    },
  })
  const unread = unreadCount

  const read = useMutation({
    // ids = as indicadas; sem ids = TODAS as nao lidas do utilizador (a policy limita a user_id = auth.uid())
    mutationFn: async (ids?: string[]) => {
      const q = supabase.from('notifications').update({ lido_em: new Date().toISOString() })
      const { error } = await (ids ? q.in('id', ids) : q.is('lido_em', null))
      if (error) throw error
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  })

  return (
    <>
      <button onClick={() => setOpen(true)} aria-label={t('notif.title')} className="relative grid h-11 w-11 shrink-0 place-items-center rounded-xl text-muted hover:bg-field hover:text-fg">
        <Icon name="bell" />
        {unread > 0 && (
          <span className="absolute right-1 top-1 grid min-h-4 min-w-4 place-items-center rounded-full bg-negative px-1 text-[10px] font-bold text-white">{unread > 9 ? '9+' : unread}</span>
        )}
      </button>
      <Sheet open={open} onClose={() => setOpen(false)} title={t('notif.title')}>
        {unread > 0 && (
          <Button variant="ghost" className="mb-3 min-h-9" onClick={() => read.mutate(undefined)}>
            {t('notif.markAll')}
          </Button>
        )}
        {data.length === 0 ? (
          <p className="py-8 text-center text-muted">{t('notif.empty')}</p>
        ) : (
          <ul className="divide-y divide-border">
            {data.map((n) => (
              <li key={n.id}>
                <button
                  className="flex min-h-14 w-full items-start gap-3 py-3 text-left"
                  onClick={() => {
                    if (!n.lido_em) read.mutate([n.id])
                    setOpen(false)
                    nav(target(n, canRegister))
                  }}
                >
                  <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full" style={{ background: n.lido_em ? 'transparent' : 'var(--brand)' }} />
                  <span>
                    <span className="block text-sm">{t(`notif.type.${n.tipo === 'movement_pending' ? `movement_pending_${n.payload.kind === 'auto' ? 'auto' : 'alloc'}` : n.tipo}`, { ...n.payload, defaultValue: n.tipo })}</span>
                    <span className="text-xs text-muted">{dateShort(n.created_at.slice(0, 10))}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Sheet>
    </>
  )
}
