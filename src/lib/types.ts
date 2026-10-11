export type Role = 'super_admin' | 'gestor' | 'operador' | 'motorista' | 'contabilista' | 'auditor'
export type RecordStatus = 'rascunho' | 'submetido' | 'validado'
export type Theme = 'light' | 'dark'

export const ORDER_STATES = [
  'entregues',
  'devolucoes',
  'recolhas',
  'canceladas',
  'transitadas',
  'pendentes_entrega',
  'pendentes_recolha',
] as const
export type OrderState = (typeof ORDER_STATES)[number]

export interface Profile {
  id: string
  tenant_id: string
  nome: string
  email: string
  tema: Theme
  idioma: 'pt' | 'en'
  manter_sessao: boolean
  accounting_read: boolean
  deleted_at: string | null
}

export interface OperationOption { id: string; nome: string }

export interface RouteOption {
  id: string
  operation_id: string
  nome: string
  tarifa_por_estado: boolean
  tarifa_valor_fixo: boolean
  tarifa_por_zona: boolean
  tarifa_por_distancia: boolean
  valor_fixo_default: number | null
}

export interface ZoneOption { id: string; operation_id: string; nome: string }
export interface VehicleOption { id: string; matricula: string; posto_id: string | null; estado: string }
export interface DriverOption { id: string; nome: string; user_id: string | null }

export interface Breakdown {
  por_estado: number
  valor_fixo: number
  por_zona: number
  por_distancia: number
  total: number
}

export interface DailyRecord {
  id: string
  route_id: string
  data: string
  status: RecordStatus
  viatura_id: string | null
  motorista_ids: string[]
  km: number | null
  enc_entregues: number | null
  enc_devolucoes: number | null
  enc_recolhas: number | null
  enc_canceladas: number | null
  enc_transitadas: number | null
  enc_pendentes_entrega: number | null
  enc_pendentes_recolha: number | null
  valor_fixo_do_dia: number | null
  incluir_entregas: boolean
  entregas_por_zona: Record<string, number>
  comb_litros: number | null
  comb_valor: number | null
  comb_tipo: string | null
  portagens_valor: number | null
  receita_breakdown: Breakdown
  receita_total: number
  created_by: string | null
  validado_por: string | null
  deleted_at: string | null
}

export interface Operation {
  id: string
  tenant_id: string
  nome: string
  valores_estado: Record<OrderState, number>
  salario_fixo_mensal: number
  salario_var_por_entrega: number
  salario_var_pct_receita: number
  outros_custos_mensais: number
}

export interface Tier { de: number; ate: number | null; valor: number }

export interface Route {
  id: string
  operation_id: string
  nome: string
  tarifa_por_estado: boolean
  tarifa_valor_fixo: boolean
  tarifa_por_zona: boolean
  tarifa_por_distancia: boolean
  valor_fixo_default: number | null
  taxa_km: number | null
  escaloes_km: Tier[] | null
}

export interface Zone {
  id: string
  operation_id: string
  nome: string
  prefixos: string[]
  valor_por_entrega: number
}

export interface Vehicle {
  id: string
  matricula: string
  tipo: 'propria' | 'alugada'
  posto_id: string | null
  estado: 'ativa' | 'devolvida' | 'em_manutencao' | 'vendida'
  iuc_ativo: boolean
  iuc_valor: number
  seguro_ativo: boolean
  seguro_valor: number
  iuc_vencimento: string | null
  seguro_vencimento: string | null
  manutencao_ativo: boolean
  manutencao_valor: number
  aluguer_fornecedor: string | null
  aluguer_custo: number | null
  aluguer_periodicidade: 'diario' | 'semanal' | 'mensal' | null
  aluguer_data_inicio: string | null
  aluguer_data_fim: string | null
}

export interface Slot { id: string; nome: string }
export interface SlotAssignment { id: string; posto_id: string; vehicle_id: string; data_inicio: string; data_fim: string | null }
export interface Driver { id: string; nome: string; contacto: string | null; user_id: string | null }
