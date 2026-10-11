import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import pt from './pt.json'
import en from './en.json'

const flat = (o: Record<string, unknown>, p = ''): string[] =>
  Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' ? flat(v as Record<string, unknown>, p + k + '.') : [p + k]))

const walk = (d: string): string[] =>
  readdirSync(d).flatMap((f) => {
    const p = join(d, f)
    return statSync(p).isDirectory() ? walk(p) : /\.(tsx?|ts)$/.test(f) && !f.endsWith('.test.ts') ? [p] : []
  })

describe('i18n', () => {
  const ptKeys = new Set(flat(pt))
  const enKeys = new Set(flat(en))

  it('PT e EN tem exatamente as mesmas chaves', () => {
    expect([...ptKeys].filter((k) => !enKeys.has(k))).toEqual([])
    expect([...enKeys].filter((k) => !ptKeys.has(k))).toEqual([])
  })

  it('todas as chaves literais t("...") usadas no codigo existem', () => {
    const missing: string[] = []
    for (const file of walk('src')) {
      const src = readFileSync(file, 'utf8')
      for (const m of src.matchAll(/\bt\(\s*['"`]([a-zA-Z0-9_.]+)['"`]/g)) if (!ptKeys.has(m[1])) missing.push(`${file}: ${m[1]}`)
    }
    expect(missing).toEqual([])
  })

  it('chaves dinamicas (template) cobrem todos os valores possiveis', () => {
    const need = [
      ...['dashboard', 'register', 'history', 'fleet', 'accounting', 'settings'].map((k) => `nav.${k}`),
      ...['rascunho', 'submetido', 'validado'].map((k) => `status.${k}`),
      ...['entregues', 'devolucoes', 'recolhas', 'canceladas', 'transitadas', 'pendentes_entrega', 'pendentes_recolha'].map((k) => `orders.${k}`),
      ...['fuel', 'tolls', 'iuc', 'insurance', 'salaries', 'maintenance', 'other', 'rental', 'distributed'].map((k) => `dashboard.cost.${k}`),
      ...['por_estado', 'valor_fixo', 'por_zona', 'por_distancia'].map((k) => `dashboard.components.${k}`),
      ...['thisMonth', 'lastMonth', 'last7', 'last30'].map((k) => `dashboard.${k}`),
      ...['super_admin', 'gestor', 'operador', 'motorista', 'contabilista', 'auditor'].map((k) => `roles.${k}`),
      ...['manutencao', 'deslocacao_equipa', 'outro', 'transferencia_distribuicao', 'custo_automatico'].map((k) => `accounting.sub.${k}`),
      ...['record_submitted', 'record_reopened', 'record_missing', 'fund_unreconciled', 'margin_negative', 'cost_due', 'movement_pending_auto', 'movement_pending_alloc', 'fund_over_allocated'].map((k) => `notif.type.${k}`),
      ...['list', 'validate', 'grouped', 'board', 'distribution', 'accounts', 'settings'].map((k) => `accounting.view.${k}`),
      ...['today', 'last7', 'thisMonth', 'lastMonth', 'all'].map((k) => `accounting.period.${k}`),
      ...['combustivel', 'portagens'].map((k) => `accounting.autoCost.${k}`),
      ...['over', 'under', 'ok'].map((k) => `accounting.distributionState.${k}`),
      ...['parentRemoved', 'parentRemovedHint'].map((k) => `accounting.detail.${k}`),
      ...['alloc', 'aboveLimit', 'reverted'].map((k) => `accounting.reason.${k}`),
      ...['select', 'selectAll', 'selected', 'validate', 'assignPlaceholder', 'assign', 'clear'].map((k) => `accounting.batch.${k}`),
      'accounting.truncated', 'accounting.showMore', 'accounting.ageDays_one', 'accounting.partialSheet', 'accounting.movGone', 'accounting.noDefaultAccount', 'accounting.showNoAccount',
      'accounting.view.unlinked', 'accounting.noRecordChip', 'accounting.noRecordHint', 'accounting.ageDays',
      ...['hint', 'todo', 'empty', 'flagged'].map((k) => `accounting.unlinkedView.${k}`),
      'accounting.actions.noRecord', 'accounting.actions.backToUnlinked', 'accounting.batch.noRecord', 'accounting.batch.backToUnlinked',
      'accounting.reason.autoBelow', 'accounting.relink.bodyValidated', 'accounting.relink.targetValidated', 'accounting.detail.requestNobody',
      ...['originRecord', 'linkedRecord', 'requestCorrection', 'requestNote', 'requestSend', 'requestSent', 'requestAlready'].map((k) => `accounting.detail.${k}`),
      ...['title', 'body', 'confirm', 'cancel'].map((k) => `accounting.relink.${k}`),
      ...['allocation_unlinked', 'auto_cost_disputed'].map((k) => `notif.type.${k}`),
      ...['orphans', 'orphansHint'].map((k) => `accounting.${k}`),
      ...['pendente', 'confirmado'].map((k) => `accounting.state.${k}`),
      ...['ativa', 'devolvida', 'em_manutencao', 'vendida'].map((k) => `fleet.states.${k}`),
      ...['automatico', 'manual_rota', 'manual_geral'].map((k) => `accounting.origin.${k}`),
    ]
    expect(need.filter((k) => !ptKeys.has(k))).toEqual([])
  })
})
