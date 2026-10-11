import { useEffect, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from 'react'
import clsx from 'clsx'
import { useTranslation } from 'react-i18next'

export const Card = ({ className, ...p }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={clsx('rounded-card border border-border bg-card p-4', className)} {...p} />
)

type BtnVariant = 'primary' | 'ghost' | 'danger'
export function Button({ variant = 'primary', className, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BtnVariant }) {
  return (
    <button
      className={clsx(
        'inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-4 text-sm font-semibold transition disabled:opacity-50',
        variant === 'primary' && 'bg-brand text-black hover:opacity-90',
        variant === 'ghost' && 'border border-border bg-transparent text-fg hover:bg-field',
        variant === 'danger' && 'border border-negative text-negative hover:bg-field',
        className,
      )}
      {...p}
    />
  )
}

const inputCls =
  'min-h-11 w-full rounded-xl border border-border bg-field px-3 text-base text-fg outline-none placeholder:text-muted focus:border-brand disabled:opacity-60'

export const Input = ({ className, ...p }: InputHTMLAttributes<HTMLInputElement>) => <input className={clsx(inputCls, className)} {...p} />
export const Select = ({ className, ...p }: SelectHTMLAttributes<HTMLSelectElement>) => <select className={clsx(inputCls, className)} {...p} />

/** Campo numerico: teclado numerico no mobile. */
export const NumInput = ({ decimal = true, className, ...p }: InputHTMLAttributes<HTMLInputElement> & { decimal?: boolean }) => (
  <input inputMode={decimal ? 'decimal' : 'numeric'} pattern={decimal ? '[0-9]*[.,]?[0-9]*' : '[0-9]*'} className={clsx(inputCls, className)} {...p} />
)

export function Field({ label, hint, children, className }: { label: ReactNode; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={clsx('block', className)}>
      <span className="mb-1 block text-sm font-medium text-muted">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-muted">{hint}</span>}
    </label>
  )
}

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="flex min-h-11 w-full items-center justify-between gap-3 text-left text-sm disabled:opacity-60"
    >
      <span>{label}</span>
      <span className={clsx('relative h-6 w-11 shrink-0 rounded-full transition', checked ? 'bg-brand' : 'bg-border')}>
        <span className={clsx('absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all', checked ? 'left-[22px]' : 'left-0.5')} />
      </span>
    </button>
  )
}

export function Pill({ active, onClick, children, color }: { active?: boolean; onClick?: () => void; children: ReactNode; color?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={clsx(
        'inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-full border px-3 text-sm transition',
        active ? 'border-brand bg-brand/15 text-fg' : 'border-border text-muted hover:text-fg',
      )}
    >
      {color && <span className="h-2.5 w-2.5 rounded-full" style={{ background: color }} />}
      {children}
    </button>
  )
}

const STATUS_COLOR: Record<string, string> = { rascunho: 'var(--muted)', submetido: 'var(--pending)', validado: 'var(--positive)' }
export function StatusBadge({ status }: { status: 'rascunho' | 'submetido' | 'validado' }) {
  const { t } = useTranslation()
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-border px-2 py-0.5 text-xs">
      <span className="h-2 w-2 rounded-full" style={{ background: STATUS_COLOR[status] }} />
      {t(`status.${status}`)}
    </span>
  )
}

/** Bottom sheet full-screen no mobile; modal centrado a partir de md. */
export function Sheet({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode }) {
  const { t } = useTranslation()
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [open, onClose])
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 md:items-center" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        className="safe-bottom flex h-full w-full flex-col bg-card md:h-auto md:max-h-[85vh] md:max-w-xl md:rounded-card md:border md:border-border"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button onClick={onClose} aria-label={t('app.close')} className="grid h-11 w-11 place-items-center rounded-xl text-xl text-muted hover:bg-field">
            ×
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-4">{children}</div>
      </div>
    </div>
  )
}

export const Spinner = () => {
  const { t } = useTranslation()
  return <div className="p-6 text-center text-sm text-muted">{t('app.loading')}</div>
}

export const ErrorNote = ({ error }: { error: unknown }) => {
  const { t } = useTranslation()
  if (!error) return null
  const msg = error instanceof Error ? error.message : typeof error === 'object' && error && 'message' in error ? String((error as { message: unknown }).message) : t('errors.generic')
  return <div className="rounded-xl border border-negative/50 bg-negative/10 px-3 py-2 text-sm text-negative">{msg}</div>
}

export const PageTitle = ({ children, action }: { children: ReactNode; action?: ReactNode }) => (
  <div className="mb-4 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
    <h1 className="text-2xl font-bold">{children}</h1>
    {action}
  </div>
)
