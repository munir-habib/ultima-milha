import { useState, type ReactNode } from 'react'
import { NavLink, Outlet, Link, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import clsx from 'clsx'
import { useAuth } from '@/auth/AuthProvider'
import { useOp } from './OpContext'
import { Select, Sheet } from './ui'
import { PATHS, canRegister, isMotoristaOnly, navFor } from '@/lib/roles'
import { Icon } from './Icon'
import NotificationBell from './NotificationBell'

function OpSelect({ className }: { className?: string }) {
  const { t } = useTranslation()
  const { ops, opId, setOpId } = useOp()
  if (ops.length < 2) return null
  return (
    <Select value={opId} onChange={(e) => setOpId(e.target.value)} aria-label={t('nav.operation')} className={className}>
      <option value="all">{t('nav.allOperations')}</option>
      {ops.map((o) => (
        <option key={o.id} value={o.id}>
          {o.nome}
        </option>
      ))}
    </Select>
  )
}

const itemCls = ({ isActive }: { isActive: boolean }) => clsx('transition', isActive ? 'text-brand' : 'text-muted hover:text-fg')

export default function Shell(): ReactNode {
  const { t } = useTranslation()
  const { profile, roles, session, signOut } = useAuth()
  const access = { roles, accountingRead: profile?.accounting_read ?? false }
  const { pathname } = useLocation()
  const [more, setMore] = useState(false)

  // Motorista: literalmente so o ecra de inserir dados, sem menus.
  if (isMotoristaOnly(access)) {
    return (
      <div className="mx-auto min-h-dvh max-w-2xl px-4 pb-10 pt-4">
        <header className="mb-4 flex items-center justify-between">
          <span className="text-sm text-muted">{profile?.nome ?? session?.user.email}</span>
          <button onClick={signOut} aria-label={t('auth.signOut')} className="grid h-11 w-11 place-items-center rounded-xl text-muted hover:bg-card">
            <Icon name="out" />
          </button>
        </header>
        <Outlet />
      </div>
    )
  }

  const items = navFor(access)
  const mobileMain = items.length > 5 ? items.slice(0, 4) : items
  const mobileMore = items.length > 5 ? items.slice(4) : []
  const showFab = canRegister(access) && pathname !== PATHS.register

  return (
    <div className="min-h-dvh md:flex">
      {/* Tablet: navegacao lateral */}
      <aside className="print-hide hidden w-20 shrink-0 flex-col items-center gap-2 border-r border-border bg-card py-4 md:flex lg:hidden">
        {items.map((k) => (
          <NavLink key={k} to={PATHS[k]} end={k === 'dashboard'} className={(s) => clsx(itemCls(s), 'flex w-16 flex-col items-center gap-1 rounded-xl py-2 text-[11px]')}>
            <Icon name={k} />
            {t(`nav.${k}`)}
          </NavLink>
        ))}
        <button onClick={signOut} className="mt-auto flex w-16 flex-col items-center gap-1 py-2 text-[11px] text-muted">
          <Icon name="out" />
          {t('auth.signOut')}
        </button>
      </aside>

      <div className="min-w-0 flex-1">
        {/* Desktop: navegacao horizontal no topo */}
        <header className="print-hide sticky top-0 z-30 hidden items-center gap-6 border-b border-border bg-card px-6 py-3 lg:flex">
          <Link to="/" className="text-base font-bold">
            {t('app.name')}
          </Link>
          <OpSelect className="!w-56" />
          <nav className="flex flex-1 items-center gap-1">
            {items.map((k) => (
              <NavLink key={k} to={PATHS[k]} end={k === 'dashboard'} className={(s) => clsx(itemCls(s), 'rounded-xl px-3 py-2 text-sm font-medium', s.isActive && 'bg-brand/10')}>
                {t(`nav.${k}`)}
              </NavLink>
            ))}
          </nav>
          <NotificationBell />
          <span className="text-sm text-muted">{profile?.nome}</span>
          <button onClick={signOut} className="text-sm text-muted hover:text-fg">
            {t('auth.signOut')}
          </button>
        </header>

        {/* Tablet/mobile: seletor de operacao no topo da pagina */}
        <div className="print-hide flex items-center gap-2 px-4 pt-3 lg:hidden">
          <div className="min-w-0 flex-1">
            <OpSelect />
          </div>
          <NotificationBell />
        </div>

        <main className="pb-nav mx-auto max-w-7xl px-4 pt-4 md:px-6 md:pb-10 lg:px-8">
          <Outlet />
        </main>
      </div>

      {/* Mobile: bottom navigation + FAB */}
      <nav className="print-hide safe-bottom fixed inset-x-0 bottom-0 z-40 flex border-t border-border bg-card md:hidden">
        {mobileMain.map((k) => (
          <NavLink key={k} to={PATHS[k]} end={k === 'dashboard'} className={(s) => clsx(itemCls(s), 'flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 text-[11px]')}>
            <Icon name={k} />
            {t(`nav.${k}`)}
          </NavLink>
        ))}
        {mobileMore.length > 0 && (
          <button onClick={() => setMore(true)} className="flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 text-[11px] text-muted">
            <Icon name="more" />
            {t('nav.more')}
          </button>
        )}
      </nav>
      {showFab && (
        <Link
          to={PATHS.register}
          aria-label={t('nav.registerDay')}
          className="print-hide fixed right-4 z-40 flex h-14 items-center gap-2 rounded-full bg-brand px-5 font-semibold text-black shadow-lg md:hidden"
          style={{ bottom: 'calc(4.5rem + env(safe-area-inset-bottom))' }}
        >
          <Icon name="plus" className="h-5 w-5" />
          {t('nav.registerDay')}
        </Link>
      )}
      <Sheet open={more} onClose={() => setMore(false)} title={t('nav.more')}>
        <div className="grid gap-2">
          {mobileMore.map((k) => (
            <NavLink key={k} to={PATHS[k]} onClick={() => setMore(false)} className="flex min-h-12 items-center gap-3 rounded-xl border border-border px-4">
              <Icon name={k} />
              {t(`nav.${k}`)}
            </NavLink>
          ))}
          <button onClick={signOut} className="flex min-h-12 items-center gap-3 rounded-xl border border-border px-4 text-left text-muted">
            <Icon name="out" />
            {t('auth.signOut')}
          </button>
        </div>
      </Sheet>
    </div>
  )
}
