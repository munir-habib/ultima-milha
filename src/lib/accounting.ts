import { addDays, startOfMonth } from './format'

export type Subcat = 'manutencao' | 'deslocacao_equipa' | 'outro' | 'transferencia_distribuicao' | 'custo_automatico'
export type MovState = 'pendente' | 'confirmado'
export type Origin = 'automatico' | 'manual_rota' | 'manual_geral'

export interface Movement {
  id: string
  data: string
  conta_id: string | null
  tipo: 'debito' | 'credito'
  valor: number
  operation_id: string | null
  subcategoria: Subcat
  pessoa_responsavel: string | null
  lancamento_referencia_id: string | null
  rota_id: string | null
  motorista_id: string | null
  descricao: string | null
  estado: MovState
  origem: Origin
  registo_id: string | null
  custo_tipo: 'combustivel' | 'portagens' | null
  versao_anterior_id: string | null
  validado_por: string | null
  validado_em: string | null
  deleted_at: string | null
  motivo_apagado: string | null
  /** alocacao "por ligar" marcada como "sem registo previsto" (nao alerta nem entra na vista "Por ligar") */
  sem_registo_previsto: boolean
  created_at: string
}

/** Teto de movimentos carregados (por paginas de 1000: o PostgREST nao devolve mais de 1000 por pedido). Acima disto os totais/saldos calculados no cliente ficam incompletos e a UI avisa. */
export const MOVEMENTS_CAP = 10000

export const MOVEMENT_COLS =
  'id,data,conta_id,tipo,valor,operation_id,subcategoria,pessoa_responsavel,lancamento_referencia_id,rota_id,motorista_id,descricao,estado,origem,registo_id,custo_tipo,versao_anterior_id,validado_por,validado_em,deleted_at,motivo_apagado,sem_registo_previsto,created_at'

/** Rota do cartao "Geral": movimentos sem rota (transferencias, despesas soltas). */
export const GERAL = '__geral'

export const signed = (m: Pick<Movement, 'tipo' | 'valor'>) => (m.tipo === 'credito' ? 1 : -1) * Number(m.valor)
export const isAllocation = (m: Movement) => m.lancamento_referencia_id !== null
/** Alocacao com operacao+rota ainda sem registo diario onde propagar. */
/** Alocacao "por ligar" que ainda espera um registo diario (fora as marcadas "sem registo previsto"): a vista "Por ligar". */
export const needsRecord = (m: Movement) => !m.deleted_at && isUnlinked(m) && !m.sem_registo_previsto
/** Alocacao por ligar marcada como "sem registo previsto". */
export const noRecordExpected = (m: Movement) => !m.deleted_at && isUnlinked(m) && m.sem_registo_previsto

export const isUnlinked = (m: Movement) => isAllocation(m) && m.operation_id !== null && m.rota_id !== null && m.tipo === 'debito' && m.registo_id === null

export interface Sums {
  /** Totais OFICIAIS: so contam Confirmado */
  credit: number
  debit: number
  net: number
  /** Pendentes: sempre a parte, nunca somados ao saldo */
  pendingCount: number
  pendingAmount: number
}

export function sums(list: Movement[]): Sums {
  const s: Sums = { credit: 0, debit: 0, net: 0, pendingCount: 0, pendingAmount: 0 }
  for (const m of list) {
    if (m.deleted_at) continue // so conta o lancamento ativo de cada cadeia de versoes
    const v = Number(m.valor)
    if (m.estado === 'confirmado') {
      if (m.tipo === 'credito') s.credit += v
      else s.debit += v
    } else {
      s.pendingCount += 1
      s.pendingAmount += v
    }
  }
  s.net = s.credit - s.debit
  return s
}

// ---------- filtros ----------
export type Period = 'today' | 'last7' | 'thisMonth' | 'lastMonth' | 'all'

export function periodRange(p: Period, today: string): { from: string; to: string } | null {
  if (p === 'all') return null
  if (p === 'today') return { from: today, to: today }
  if (p === 'last7') return { from: addDays(today, -6), to: today }
  if (p === 'thisMonth') return { from: startOfMonth(today), to: today }
  const lastOfPrev = addDays(startOfMonth(today), -1)
  return { from: startOfMonth(lastOfPrev), to: lastOfPrev }
}

export interface AccFilters {
  period: Period
  /** id de conta | 'all' | 'none' (movimentos sem conta, tipicamente automaticos antes de haver conta por defeito) */
  account: string | 'all' | 'none'
  origin: Origin | 'all'
  /** 'other' = despesas soltas (sem operacao) | id de operacao */
  category: string | 'all' | 'other'
  /** limita a uma operacao (seletor de operacao da app): SO os movimentos dessa operacao — as despesas soltas (sem operacao) NAO entram (como no dashboard) */
  opId?: string | 'all'
  /** exceção para a fila "por validar" e as Distribuicoes: com operacao selecionada, incluem tambem os movimentos sem operacao (nunca se escondem pendentes nem transferencias) */
  general?: boolean
}

export function applyFilters(list: Movement[], f: AccFilters, today: string): Movement[] {
  const r = periodRange(f.period, today)
  return list.filter(
    (m) =>
      !m.deleted_at &&
      (!r || (m.data >= r.from && m.data <= r.to)) &&
      (f.account === 'all' || (f.account === 'none' ? m.conta_id === null : m.conta_id === f.account)) &&
      (f.origin === 'all' || m.origem === f.origin) &&
      (f.category === 'all' || (f.category === 'other' ? m.operation_id === null : m.operation_id === f.category)) &&
      (!f.opId || f.opId === 'all' || m.operation_id === f.opId || (f.general === true && m.operation_id === null)),
  )
}

/**
 * Fila de trabalho do Contabilista (independente de periodo). Por regra so nascem pendentes os automaticos acima do limite
 * e as alocacoes; a fila mostra qualquer pendente para que o cartao "por validar" e a fila nunca divirjam.
 */
/** Porque e que um movimento esta Pendente (derivado dos campos que o servidor usa para decidir o estado inicial). */
export type PendingReason = 'alloc' | 'aboveLimit' | 'autoBelow' | 'reverted'
export function pendingReason(m: Pick<Movement, 'estado' | 'lancamento_referencia_id' | 'origem' | 'valor'>, threshold: number): PendingReason | null {
  if (m.estado !== 'pendente') return null
  if (m.lancamento_referencia_id) return 'alloc' // alocacao de fundos: sempre Pendente
  if (m.origem === 'automatico') {
    if (Number(m.valor) > threshold) return 'aboveLimit'
    // pendente mas nao acima do limite ATUAL: ou foi revertido, ou o limite subiu depois — nao se afirma qual
    return 'autoBelow'
  }
  return 'reverted' // manual: revertido a Pendente pelo Contabilista
}

/** O utilizador desistiu de uma alteracao que pedia confirmacao (nao e um erro a mostrar). */
export class MoveCancelled extends Error {
  constructor() { super('cancelled'); this.name = 'MoveCancelled' }
}

/**
 * Mudar rota, operacao ou data de uma alocacao JA propagada (com registo_id) tem consequencias no registo diario:
 * a linha de custo antiga e removida (soft delete), um registo Validado volta a Submetido e a alocacao liga-se ao registo
 * da nova rota+data, se existir. Por isso a UI pede confirmacao antes.
 */
export function changesLink(m: Pick<Movement, 'lancamento_referencia_id' | 'registo_id' | 'rota_id' | 'data' | 'tipo'>, p: { rota_id?: string | null; operation_id?: string | null; data?: string; tipo?: 'debito' | 'credito' }): boolean {
  if (!m.lancamento_referencia_id || !m.registo_id) return false
  // so a rota, a data e o TIPO decidem a que registo diario a alocacao pertence e se gera custo (mudar so a operacao nao mexe na copia)
  return (p.rota_id !== undefined && p.rota_id !== m.rota_id) || (p.data !== undefined && p.data !== m.data) || (p.tipo !== undefined && p.tipo !== m.tipo)
}

/** Onde uma alocacao AINDA nao ligada vai ligar-se depois da alteracao: rota+data do destino (ou null se nao liga a nada). */
export function relinkTarget(m: Pick<Movement, 'lancamento_referencia_id' | 'registo_id' | 'rota_id' | 'operation_id' | 'data' | 'tipo'>, p: { rota_id?: string | null; operation_id?: string | null; data?: string; tipo?: 'debito' | 'credito' }): { rota: string; data: string } | null {
  const tipo = p.tipo ?? m.tipo
  if (!m.lancamento_referencia_id || tipo !== 'debito') return null // um credito nao gera custo nem se liga
  const rota = p.rota_id !== undefined ? p.rota_id : m.rota_id
  const op = p.operation_id !== undefined ? p.operation_id : m.operation_id
  const data = p.data ?? m.data
  const changed = (p.rota_id !== undefined && p.rota_id !== m.rota_id) || (p.data !== undefined && p.data !== m.data) || (p.tipo !== undefined && p.tipo !== m.tipo)
  return changed && rota && op ? { rota, data } : null
}

/** Parte uma lista em blocos (pedidos em lote com in(...) nao podem ter URLs enormes). */
export const chunk = <T,>(list: T[], size: number): T[][] => {
  const out: T[][] = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

/** Mais antigo primeiro (o que espera ha mais tempo e o mais urgente). */
export const oldestFirst = (list: Movement[]) => [...list].sort((a, b) => (a.data < b.data ? -1 : a.data > b.data ? 1 : a.created_at < b.created_at ? -1 : 1))

export const pendingQueue = (list: Movement[]) => list.filter((m) => !m.deleted_at && m.estado === 'pendente')

// ---------- agrupado por dia / rota ----------
export interface Group { key: string; label: string; items: Movement[]; sums: Sums }
export interface Day { date: string; groups: Group[]; sums: Sums }

/**
 * Cada movimento aparece exatamente UMA vez, no dia e grupo dados pelos seus proprios campos:
 * uma transferencia e as suas alocacoes sao movimentos distintos (podem cair em dias/grupos diferentes).
 */
export function groupByDay(list: Movement[], routeName: (id: string) => string, geralLabel: string): Day[] {
  const days = new Map<string, Map<string, Movement[]>>()
  for (const m of list) {
    if (m.deleted_at) continue
    const key = m.rota_id ?? GERAL
    const d = days.get(m.data) ?? new Map<string, Movement[]>()
    d.set(key, [...(d.get(key) ?? []), m])
    days.set(m.data, d)
  }
  return [...days.entries()]
    .sort(([a], [b]) => (a < b ? 1 : -1))
    .map(([date, groups]) => {
      const gs: Group[] = [...groups.entries()]
        .map(([key, items]) => ({ key, label: key === GERAL ? geralLabel : routeName(key), items, sums: sums(items) }))
        .sort((a, b) => (a.key === GERAL ? 1 : b.key === GERAL ? -1 : a.label.localeCompare(b.label)))
      return { date, groups: gs, sums: sums(gs.flatMap((g) => g.items)) }
    })
}

// ---------- quadro (kanban) ----------
export interface RouteRef { id: string; nome: string; operation_id: string }

export interface MovePatch {
  estado?: MovState
  rota_id?: string | null
  operation_id?: string | null
}

/**
 * Traduz um arrasto no quadro numa unica atualizacao:
 *  - outra COLUNA (mesma linha)  = validar / reverter
 *  - outra LINHA (mesma coluna)  = reclassificar rota/operacao ("Geral" remove a rota)
 *  - diagonal                    = as duas juntas (uma so entrada de audit)
 */
export function movePatch(m: Movement, target: { estado?: MovState; row?: string }, routes: RouteRef[]): MovePatch | null {
  const patch: MovePatch = {}
  if (target.estado && target.estado !== m.estado) patch.estado = target.estado
  if (target.row !== undefined && target.row !== (m.rota_id ?? GERAL)) {
    if (target.row === GERAL) {
      patch.rota_id = null // a operacao mantem-se (a origem "Manual — Rota/Operacao" continua valida)
    } else {
      const r = routes.find((x) => x.id === target.row)
      if (!r) return null
      patch.rota_id = r.id
      patch.operation_id = r.operation_id // a origem manual acompanha a operacao: e o servidor que a decide
    }
  }
  return Object.keys(patch).length ? patch : null
}

export interface BoardRow { key: string; label: string; cells: Record<MovState, Movement[]> }

export function boardRows(list: Movement[], routes: RouteRef[], geralLabel: string): BoardRow[] {
  const rows: BoardRow[] = [...routes.map((r) => ({ key: r.id, label: r.nome })), { key: GERAL, label: geralLabel }].map((r) => ({
    ...r,
    cells: { pendente: [], confirmado: [] } as Record<MovState, Movement[]>,
  }))
  const byKey = new Map(rows.map((r) => [r.key, r]))
  for (const m of list) {
    if (m.deleted_at) continue
    // um cartao nunca desaparece: rota fora do ambito (ou arquivada) cai em "Geral"
    const row = byKey.get(m.rota_id ?? GERAL) ?? byKey.get(GERAL)
    if (row) row.cells[m.estado].push(m)
  }
  return rows
}

/** Distribuicao: soma alocada vs total recebido; sobre/sub-alocacao ficam sempre visiveis. */
export function allocationStatus(transfer: Pick<Movement, 'valor'>, allocations: Movement[]) {
  // so alocacoes a DEBITO contam (igual ao servidor: fund_transfer_status)
  const allocated = allocations.filter((a) => !a.deleted_at && a.tipo === 'debito').reduce((s, a) => s + Number(a.valor), 0)
  const diff = Math.round((Number(transfer.valor) - allocated) * 100) / 100
  return { allocated, diff, state: diff > 0 ? ('under' as const) : diff < 0 ? ('over' as const) : ('ok' as const) }
}
