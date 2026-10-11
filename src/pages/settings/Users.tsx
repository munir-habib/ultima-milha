import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '@/auth/AuthProvider'
import { Button, Card, ErrorNote, Field, Input, Pill, Sheet, Spinner, Toggle } from '@/components/ui'
import { supabase } from '@/lib/supabase'
import { unwrap, useOperationOptions } from '@/lib/queries'
import type { Profile, Role } from '@/lib/types'

const ALL_ROLES: Role[] = ['super_admin', 'gestor', 'operador', 'motorista', 'contabilista', 'auditor']
const INVITABLE: Role[] = ['gestor', 'operador', 'motorista', 'contabilista', 'auditor']
const GESTOR_INVITABLE: Role[] = ['operador', 'motorista']

export default function Users() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { roles, session } = useAuth()
  const isAdmin = roles.includes('super_admin')
  const { data: ops = [] } = useOperationOptions()

  const users = useQuery({
    enabled: isAdmin,
    queryKey: ['users'],
    queryFn: async () => {
      const [p, r, o] = await Promise.all([
        unwrap<Profile[]>(supabase.from('profiles').select('*').order('nome')),
        unwrap<{ user_id: string; role: Role }[]>(supabase.from('user_roles').select('user_id,role')),
        unwrap<{ user_id: string; operation_id: string }[]>(supabase.from('user_operations').select('user_id,operation_id')),
      ])
      return p.map((u) => ({ ...u, roles: r.filter((x) => x.user_id === u.id).map((x) => x.role), ops: o.filter((x) => x.user_id === u.id).map((x) => x.operation_id) }))
    },
  })
  const pending = useQuery({
    queryKey: ['invitations'],
    queryFn: () => unwrap<{ id: string; email: string; roles: Role[] }[]>(supabase.from('invitations').select('id,email,roles').is('accepted_at', null).order('created_at', { ascending: false })),
  })

  const [invite, setInvite] = useState<{ email: string; roles: Role[]; ops: string[]; acc: boolean } | null>(null)
  const [edit, setEdit] = useState<{ id: string; nome: string; roles: Role[]; ops: string[]; acc: boolean } | null>(null)
  const [sent, setSent] = useState(false)

  const send = useMutation({
    mutationFn: async () => {
      const i = invite!
      const { data, error } = await supabase.functions.invoke('invite-user', { body: { email: i.email, roles: i.roles, operation_ids: i.ops, accounting_read: i.acc } })
      if (error) throw error
      if (data?.error) throw new Error(data.error)
    },
    onSuccess: () => {
      setInvite(null)
      setSent(true)
      void qc.invalidateQueries({ queryKey: ['invitations'] })
    },
  })

  const saveAccess = useMutation({
    mutationFn: async () => {
      const e = edit!
      const { error } = await supabase.rpc('set_user_access', { p_user: e.id, p_roles: e.roles, p_operation_ids: e.ops, p_accounting_read: e.acc })
      if (error) throw error
    },
    onSuccess: () => {
      setEdit(null)
      void qc.invalidateQueries({ queryKey: ['users'] })
    },
  })

  const setActive = useMutation({
    mutationFn: async ({ id, active }: { id: string; active: boolean }) => {
      const { error } = await supabase.rpc('set_user_active', { p_user: id, p_active: active })
      if (error) throw error
    },
    onSuccess: () => {
      setEdit(null)
      void qc.invalidateQueries({ queryKey: ['users'] })
    },
  })

  const invitable = isAdmin ? INVITABLE : GESTOR_INVITABLE
  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v])

  return (
    <div className="space-y-4">
      {sent && <div className="rounded-xl border border-positive/50 bg-positive/10 px-3 py-2 text-sm text-positive">{t('users.sent')}</div>}
      <Button onClick={() => setInvite({ email: '', roles: [invitable[0]], ops: [], acc: false })}>+ {t('users.invite')}</Button>

      {isAdmin &&
        (users.isLoading ? (
          <Spinner />
        ) : (
          <Card className="divide-y divide-border p-0">
            {(users.data ?? []).map((u) => (
              <button
                key={u.id}
                className="flex min-h-14 w-full items-center justify-between gap-3 px-4 py-2 text-left"
                onClick={() => setEdit({ id: u.id, nome: u.nome, roles: u.roles, ops: u.ops, acc: u.accounting_read })}
              >
                <span>
                  <span className="block font-medium">
                    {u.nome} {u.deleted_at && <span className="text-xs text-negative">({t('auth.deactivated')})</span>}
                  </span>
                  <span className="text-xs text-muted">{u.email}</span>
                </span>
                <span className="text-right text-xs text-muted">{u.roles.map((r) => t(`roles.${r}`)).join(', ')}</span>
              </button>
            ))}
          </Card>
        ))}

      {(pending.data ?? []).length > 0 && (
        <Card>
          <h3 className="mb-2 font-semibold">{t('users.pending')}</h3>
          <ul className="divide-y divide-border text-sm">
            {pending.data!.map((i) => (
              <li key={i.id} className="flex justify-between py-2">
                <span>{i.email}</span>
                <span className="text-muted">{i.roles.map((r) => t(`roles.${r}`)).join(', ')}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Sheet open={invite !== null} onClose={() => setInvite(null)} title={t('users.invite')}>
        {invite && (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault()
              send.mutate()
            }}
          >
            <Field label={t('users.email')}>
              <Input type="email" value={invite.email} onChange={(e) => setInvite({ ...invite, email: e.target.value })} required />
            </Field>
            <RolePicker label={t('users.roles')} allowed={invitable} value={invite.roles} onChange={(v) => setInvite({ ...invite, roles: v })} />
            <OpPicker label={t('users.operations')} ops={ops} value={invite.ops} onChange={(v) => setInvite({ ...invite, ops: v })} />
            {isAdmin && invite.roles.includes('auditor') && <Toggle checked={invite.acc} onChange={(v) => setInvite({ ...invite, acc: v })} label={t('users.accountingRead')} />}
            <ErrorNote error={send.error} />
            <Button type="submit" className="w-full" disabled={send.isPending || invite.roles.length === 0}>
              {t('users.invite')}
            </Button>
          </form>
        )}
      </Sheet>

      <Sheet open={edit !== null} onClose={() => setEdit(null)} title={edit?.nome ?? ''}>
        {edit && (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault()
              saveAccess.mutate()
            }}
          >
            <RolePicker label={t('users.roles')} allowed={ALL_ROLES} value={edit.roles} onChange={(v) => setEdit({ ...edit, roles: v })} />
            <OpPicker label={t('users.operations')} ops={ops} value={edit.ops} onChange={(v) => setEdit({ ...edit, ops: v })} />
            <Toggle checked={edit.acc} onChange={(v) => setEdit({ ...edit, acc: v })} label={t('users.accountingRead')} />
            <ErrorNote error={saveAccess.error ?? setActive.error} />
            <Button type="submit" className="w-full" disabled={saveAccess.isPending || edit.roles.length === 0}>
              {t('app.save')}
            </Button>
            {edit.id !== session?.user.id && (
              <Button type="button" variant="danger" className="w-full" onClick={() => setActive.mutate({ id: edit.id, active: !(users.data ?? []).find((u) => u.id === edit.id)?.deleted_at })}>
                {(users.data ?? []).find((u) => u.id === edit.id)?.deleted_at ? t('app.confirm') : t('auth.deactivated')}
              </Button>
            )}
          </form>
        )}
      </Sheet>
    </div>
  )

  function RolePicker({ label, allowed, value, onChange }: { label: string; allowed: Role[]; value: Role[]; onChange: (v: Role[]) => void }) {
    return (
      <div>
        <div className="mb-1 text-sm font-medium text-muted">{label}</div>
        <div className="flex flex-wrap gap-2">
          {allowed.map((r) => (
            <Pill key={r} active={value.includes(r)} onClick={() => onChange(toggle(value, r))}>
              {t(`roles.${r}`)}
            </Pill>
          ))}
        </div>
      </div>
    )
  }
  function OpPicker({ label, ops, value, onChange }: { label: string; ops: { id: string; nome: string }[]; value: string[]; onChange: (v: string[]) => void }) {
    return (
      <div>
        <div className="mb-1 text-sm font-medium text-muted">{label}</div>
        <div className="flex flex-wrap gap-2">
          {ops.map((o) => (
            <Pill key={o.id} active={value.includes(o.id)} onClick={() => onChange(toggle(value, o.id))}>
              {o.nome}
            </Pill>
          ))}
        </div>
      </div>
    )
  }
}
