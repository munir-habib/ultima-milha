import type { ReactNode } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuth } from './auth/AuthProvider'
import Login from './auth/Login'
import { EntryOverlay, useEntrySequence } from './components/EntryTransition'
import { ENTRY } from './lib/entryTransition'
import Shell from './components/Shell'
import { OpProvider } from './components/OpContext'
import { Button, Spinner } from './components/ui'
import { canRegister, canSeeAccounting, canSeeDashboard, canSeeFleet, canSeeHistory, homeFor, type Access } from './lib/roles'
import Dashboard from './pages/Dashboard'
import Register from './pages/Register'
import History from './pages/History'
import Fleet from './pages/Fleet'
import Accounting from './pages/Accounting'
import Settings from './pages/Settings'
import Report from './pages/Report'

function Guard({ allow, access, children }: { allow: (a: Access) => boolean; access: Access; children: ReactNode }) {
  return allow(access) ? <>{children}</> : <Navigate to={homeFor(access)} replace />
}

export default function App() {
  const { t } = useTranslation()
  const { session, profile, roles, loading, profileReady, blocked, signOut } = useAuth()
  const { phase, fromLogin, willPlay } = useEntrySequence(loading, !!session, profileReady)

  // ecra de transicao por cima de tudo: enquanto se carrega (sessao guardada), no loader e a desvanecer no reveal
  const overlay =
    phase === 'loader' || phase === 'reveal' || (phase === 'pending' && willPlay && (loading || (!!session && !profileReady && !fromLogin))) ? (
      <EntryOverlay fading={phase === 'reveal'} />
    ) : null

  let main: ReactNode
  if (loading) main = willPlay ? null : <Spinner />
  else if (!session) main = <Login />
  else if (!profileReady) main = fromLogin ? <Login /> : willPlay ? null : <Spinner />
  else if (blocked) {
    main = (
      <div className="grid min-h-dvh place-items-center p-6 text-center">
        <div className="space-y-4">
          <p>{blocked === 'deactivated' ? t('auth.deactivated') : t('auth.noProfile')}</p>
          <Button variant="ghost" onClick={signOut}>
            {t('auth.signOut')}
          </Button>
        </div>
      </div>
    )
  } else if (phase === 'leaving') main = <Login leaving />
  else main = null

  if (main !== null || loading || !session || !profileReady || blocked || phase === 'leaving') {
    return (
      <>
        {main}
        {overlay}
      </>
    )
  }

  const access: Access = { roles, accountingRead: profile?.accounting_read ?? false }
  const home = homeFor(access)

  const appClass = phase === 'reveal' ? 'entry-app-reveal' : phase === 'pending' || phase === 'loader' ? 'entry-app-hidden' : ''

  return (
    <>
    <div className={appClass} style={{ ['--entry-reveal-ms' as string]: `${ENTRY.revealMs}ms` }} inert={appClass === 'entry-app-hidden'}>
    <OpProvider>
      <Routes>
        <Route element={<Shell />}>
          <Route index element={canSeeDashboard(access) ? <Dashboard /> : <Navigate to={home} replace />} />
          <Route path="registar" element={<Guard access={access} allow={canRegister}><Register /></Guard>} />
          <Route path="historico" element={<Guard access={access} allow={canSeeHistory}><History /></Guard>} />
          <Route path="viaturas" element={<Guard access={access} allow={canSeeFleet}><Fleet /></Guard>} />
          <Route path="relatorio" element={<Guard access={access} allow={canSeeDashboard}><Report /></Guard>} />
          <Route path="contabilidade" element={<Guard access={access} allow={canSeeAccounting}><Accounting /></Guard>} />
          <Route path="definicoes" element={<Guard access={access} allow={(a) => !a.roles.every((r) => r === 'motorista')}><Settings /></Guard>} />
          <Route path="*" element={<Navigate to={home} replace />} />
        </Route>
      </Routes>
    </OpProvider>
    </div>
    {overlay}
    </>
  )
}
