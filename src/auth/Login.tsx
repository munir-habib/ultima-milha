import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { supabase, setKeepSession, isConfigured } from '@/lib/supabase'
import { ENTRY } from '@/lib/entryTransition'
import { Button, ErrorNote, Field, Input } from '@/components/ui'

/** `leaving`: fase 1 da transicao de entrada — o cartao encolhe e desvanece (so transform/opacity) */
export default function Login({ leaving = false }: { leaving?: boolean }) {
  const { t } = useTranslation()
  const [mode, setMode] = useState<'in' | 'up'>('in')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [company, setCompany] = useState('')
  const [keep, setKeep] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [info, setInfo] = useState<string | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    setInfo(null)
    setKeepSession(keep)
    try {
      if (mode === 'in') {
        const { error } = await supabase.auth.signInWithPassword({ email, password })
        if (error) throw error
      } else {
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: { data: { full_name: name, tenant_name: company } },
        })
        if (error) throw error
        if (!data.session) setInfo(t('auth.checkEmail'))
      }
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  async function google() {
    setError(null)
    setKeepSession(keep)
    const { error } = await supabase.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: window.location.origin } })
    if (error) setError(error)
  }

  return (
    <div className="grid min-h-dvh place-items-center px-4 py-8">
      <div
        className={`w-full max-w-sm ${leaving ? 'entry-login-leave' : ''}`}
        style={{ ['--entry-login-ms' as string]: `${ENTRY.loginFadeMs}ms` }}
        aria-hidden={leaving || undefined}
        inert={leaving}
      >
        <div className="mb-6 text-center">
          <img src="/icon.svg" alt="" className="mx-auto mb-3 h-14 w-14 rounded-2xl" />
          <h1 className="text-2xl font-bold">{t('app.name')}</h1>
        </div>
        {!isConfigured && <div className="mb-4 rounded-xl border border-pending/50 bg-pending/10 px-3 py-2 text-sm text-pending">{t('app.notConfigured')}</div>}
        <form onSubmit={submit} className="space-y-4 rounded-card border border-border bg-card p-5">
          {mode === 'up' && (
            <>
              <Field label={t('auth.name')}>
                <Input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" required />
              </Field>
              <Field label={t('auth.company')} hint={t('auth.invited')}>
                <Input value={company} onChange={(e) => setCompany(e.target.value)} autoComplete="organization" />
              </Field>
            </>
          )}
          <Field label={t('auth.email')}>
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required />
          </Field>
          <Field label={t('auth.password')}>
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={mode === 'in' ? 'current-password' : 'new-password'}
              minLength={8}
              required
            />
          </Field>
          <label className="flex min-h-11 items-center gap-3 text-sm">
            <input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} className="h-5 w-5 accent-[var(--brand)]" />
            {t('auth.keepSession')}
          </label>
          <ErrorNote error={error} />
          {info && <div className="rounded-xl border border-positive/50 bg-positive/10 px-3 py-2 text-sm text-positive">{info}</div>}
          <Button type="submit" disabled={busy} className="w-full">
            {mode === 'in' ? t('auth.signIn') : t('auth.signUp')}
          </Button>
          <div className="flex items-center gap-3 text-xs text-muted">
            <span className="h-px flex-1 bg-border" />
            {t('auth.or')}
            <span className="h-px flex-1 bg-border" />
          </div>
          <Button type="button" variant="ghost" className="w-full" onClick={google}>
            {t('auth.google')}
          </Button>
        </form>
        <p className="mt-4 text-center text-sm text-muted">
          {mode === 'in' ? t('auth.noAccount') : t('auth.haveAccount')}{' '}
          <button className="font-semibold text-brand" onClick={() => setMode(mode === 'in' ? 'up' : 'in')}>
            {mode === 'in' ? t('auth.signUp') : t('auth.signIn')}
          </button>
        </p>
      </div>
    </div>
  )
}
