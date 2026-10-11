import i18n from '@/i18n'

// v1: apenas EUR. Centralizado aqui para permitir moeda por Tenant no futuro.
export const CURRENCY = 'EUR'

const locale = () => (i18n.language === 'en' ? 'en-GB' : 'pt-PT')

export const eur = (n: number | null | undefined, digits = 2) =>
  new Intl.NumberFormat(locale(), { style: 'currency', currency: CURRENCY, minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n ?? 0)

export const num = (n: number | null | undefined, digits = 0) =>
  new Intl.NumberFormat(locale(), { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n ?? 0)

export const pct = (n: number | null | undefined, digits = 1) =>
  new Intl.NumberFormat(locale(), { style: 'percent', minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n ?? 0)

/** yyyy-mm-dd -> data local formatada (sem deslocamento de fuso) */
export const dateShort = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number)
  return new Intl.DateTimeFormat(locale(), { day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(y, m - 1, d))
}

const p2 = (n: number) => String(n).padStart(2, '0')
export const toISO = (d: Date) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`
export const todayISO = () => toISO(new Date())
export const addDays = (iso: string, days: number) => {
  const [y, m, d] = iso.split('-').map(Number)
  return toISO(new Date(y, m - 1, d + days))
}
export const startOfMonth = (iso: string) => iso.slice(0, 8) + '01'
export const daysBetween = (a: string, b: string) => {
  const [y1, m1, d1] = a.split('-').map(Number)
  const [y2, m2, d2] = b.split('-').map(Number)
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000)
}

/** campo de formulario (texto) -> numero | null. Aceita virgula decimal. */
export const parseNum = (s: string): number | null => {
  const t = s.trim().replace(',', '.')
  if (t === '') return null
  const n = Number(t)
  return Number.isFinite(n) ? n : null
}
export const numStr = (n: number | null | undefined) => (n === null || n === undefined ? '' : String(n))
