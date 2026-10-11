import { describe, expect, it } from 'vitest'
import i18n from '@/i18n'
import { canSeeAccounting, isMotoristaOnly, navFor, type Access } from './roles'
import { accountingTable, fileName } from './export'
import type { Role } from './types'

const a = (roles: Role[], accountingRead = false): Access => ({ roles, accountingRead })

describe('acesso a Contabilidade', () => {
  it('so Super Admin, Contabilista e Auditor com acesso atribuido', () => {
    expect(canSeeAccounting(a(['super_admin']))).toBe(true)
    expect(canSeeAccounting(a(['contabilista']))).toBe(true)
    expect(canSeeAccounting(a(['auditor'], true))).toBe(true)
    expect(canSeeAccounting(a(['auditor'], false))).toBe(false)
  })
  it('Gestor, Operador e Motorista nao veem a Contabilidade (nem no menu)', () => {
    for (const r of ['gestor', 'operador', 'motorista'] as Role[]) {
      expect(canSeeAccounting(a([r]))).toBe(false)
      expect(navFor(a([r]))).not.toContain('accounting')
    }
    expect(isMotoristaOnly(a(['motorista']))).toBe(true)
  })
})

describe('export da Contabilidade', () => {
  it('nome do ficheiro, as 8 colunas exigidas pela ordem e as 3 extra (descricao, pessoa, subcategoria)', () => {
    expect(fileName('Contabilidade')).toMatch(/^Contabilidade_\d{4}-\d{2}-\d{2}\.xlsx$/)
    const t = i18n.getFixedT('pt')
    const { headers, rows } = accountingTable(t, [{ data: '2026-09-10', conta: 'Conta Principal', tipo: 'Débito', valor: -40, categoria: 'Lisboa Norte', rota: 'Rota A', estado: 'Confirmado', origem: 'Automático', descricao: 'Combustível', pessoa: 'Miguel', subcategoria: 'Custo automático' }])
    expect(headers).toEqual(['Data', 'Conta', 'Tipo', 'Valor (€)', 'Categoria/Origem', 'Rota', 'Estado', 'Origem', 'Descrição', 'Pessoa responsável', 'Subcategoria'])
    expect(rows[0]).toEqual(['2026-09-10', 'Conta Principal', 'Débito', -40, 'Lisboa Norte', 'Rota A', 'Confirmado', 'Automático', 'Combustível', 'Miguel', 'Custo automático'])
    const en = accountingTable(i18n.getFixedT('en'), []).headers
    expect(en).toHaveLength(11)
  })
})
