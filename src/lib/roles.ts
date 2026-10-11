import type { Role } from './types'

export type NavKey = 'dashboard' | 'register' | 'history' | 'fleet' | 'accounting' | 'settings'

export interface Access {
  roles: Role[]
  accountingRead: boolean
}

const any = (a: Access, ...r: Role[]) => r.some((x) => a.roles.includes(x))

/** Um Motorista "puro" ve literalmente so o ecra de inserir dados, sem menus. */
export const isMotoristaOnly = (a: Access) => a.roles.length > 0 && a.roles.every((r) => r === 'motorista')

export const canSeeDashboard = (a: Access) => any(a, 'super_admin', 'gestor', 'operador', 'auditor')
export const canRegister = (a: Access) => any(a, 'super_admin', 'gestor', 'operador', 'motorista')
export const canSeeHistory = (a: Access) => any(a, 'super_admin', 'gestor', 'operador', 'auditor')
export const canSeeFleet = (a: Access) => any(a, 'super_admin', 'gestor', 'operador', 'auditor')
export const canEditFleet = (a: Access) => any(a, 'super_admin', 'gestor')
export const canSeeAccounting = (a: Access) => any(a, 'super_admin', 'contabilista') || (a.roles.includes('auditor') && a.accountingRead)
export const canManageSettings = (a: Access) => any(a, 'super_admin', 'gestor')
export const canManageUsers = (a: Access) => any(a, 'super_admin')
export const canValidate = (a: Access) => any(a, 'super_admin', 'gestor')
/** Pode inserir/editar registos (nao Auditor) */
export const canWriteRecords = (a: Access) => canRegister(a)

/** Itens de navegacao por papel, por ordem de prioridade (mobile mostra 5; o resto vai para "Mais"). */
export function navFor(a: Access): NavKey[] {
  if (isMotoristaOnly(a)) return []
  const out: NavKey[] = []
  if (canSeeDashboard(a)) out.push('dashboard')
  if (canRegister(a)) out.push('register')
  if (canSeeHistory(a)) out.push('history')
  if (canSeeFleet(a)) out.push('fleet')
  if (canSeeAccounting(a)) out.push('accounting')
  out.push('settings') // preferencias pessoais existem para todos
  return out
}

export const PATHS: Record<NavKey, string> = {
  dashboard: '/',
  register: '/registar',
  history: '/historico',
  fleet: '/viaturas',
  accounting: '/contabilidade',
  settings: '/definicoes',
}

export function homeFor(a: Access): string {
  if (isMotoristaOnly(a)) return '/registar'
  const n = navFor(a)
  return PATHS[n[0] ?? 'settings']
}
