import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/auth/AuthProvider'
import { Button, Card, Field, PageTitle, Pill, Select } from '@/components/ui'
import { canManageSettings, canManageUsers } from '@/lib/roles'
import { currentSubscription, disablePush, enablePush, pushSupported } from '@/lib/push'
import Operations from './settings/Operations'
import Users from './settings/Users'

type Tab = 'prefs' | 'operations' | 'users'

export default function Settings() {
  const { t } = useTranslation()
  const { roles, profile } = useAuth()
  const access = { roles, accountingRead: profile?.accounting_read ?? false }
  const tabs: Tab[] = ['prefs', ...(canManageSettings(access) ? (['operations'] as Tab[]) : []), ...(canManageUsers(access) || roles.includes('gestor') ? (['users'] as Tab[]) : [])]
  const [tab, setTab] = useState<Tab>('prefs')
  const label: Record<Tab, string> = { prefs: t('settings.profile'), operations: t('settings.operations'), users: t('users.title') }
  return (
    <div>
      <PageTitle>{t('settings.title')}</PageTitle>
      {tabs.length > 1 && (
        <div className="mb-4 flex gap-2 overflow-x-auto">
          {tabs.map((k) => (
            <Pill key={k} active={tab === k} onClick={() => setTab(k)}>
              {label[k]}
            </Pill>
          ))}
        </div>
      )}
      {tab === 'prefs' && <Preferences />}
      {tab === 'operations' && <Operations />}
      {tab === 'users' && <Users />}
    </div>
  )
}

function Preferences() {
  const { t } = useTranslation()
  const { profile, updatePrefs, signOut, roles } = useAuth()
  if (!profile) return null
  return (
    <Card className="max-w-xl space-y-4">
      <div>
        <div className="font-semibold">{profile.nome}</div>
        <div className="text-sm text-muted">
          {profile.email} · {roles.map((r) => t(`roles.${r}`)).join(', ')}
        </div>
      </div>
      <Field label={t('settings.theme')}>
        <div className="flex gap-2">
          {(['light', 'dark'] as const).map((th) => (
            <Pill key={th} active={profile.tema === th} onClick={() => void updatePrefs({ tema: th })}>
              {t(`settings.${th}`)}
            </Pill>
          ))}
        </div>
      </Field>
      <Field label={t('settings.language')}>
        <Select value={profile.idioma} onChange={(e) => void updatePrefs({ idioma: e.target.value as 'pt' | 'en' })}>
          <option value="pt">Português</option>
          <option value="en">English</option>
        </Select>
      </Field>
      <PushToggle userId={profile.id} />
      <Button variant="ghost" onClick={signOut}>
        {t('auth.signOut')}
      </Button>
    </Card>
  )
}

function PushToggle({ userId }: { userId: string }) {
  const { t } = useTranslation()
  const [on, setOn] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    void currentSubscription().then((s) => setOn(Boolean(s)))
  }, [])
  const toggle = async () => {
    setBusy(true)
    setMsg(null)
    try {
      if (on) await disablePush()
      else await enablePush(userId)
      setOn(!on)
    } catch (e) {
      setMsg(e instanceof Error && e.message === 'denied' ? t('push.denied') : e instanceof Error ? e.message : t('errors.generic'))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Field label={t('push.title')} hint={pushSupported() ? t('push.hint') : t('push.unsupported')}>
      <div className="space-y-2">
        <Button type="button" variant="ghost" disabled={busy || !pushSupported()} onClick={() => void toggle()}>
          {on ? t('push.disable') : t('push.enable')}
        </Button>
        {on && <div className="text-sm text-positive">{t('push.on')}</div>}
        {msg && <div className="text-sm text-negative">{msg}</div>}
      </div>
    </Field>
  )
}
