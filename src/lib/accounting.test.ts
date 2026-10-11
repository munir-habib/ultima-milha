import { describe, expect, it } from 'vitest'
import { GERAL, MoveCancelled, needsRecord, noRecordExpected, oldestFirst, relinkTarget, allocationStatus, applyFilters, boardRows, changesLink, chunk, groupByDay, movePatch, pendingQueue, pendingReason, periodRange, sums, isUnlinked, type Movement } from './accounting'

let n = 0
const mv = (o: Partial<Movement>): Movement => ({
  id: `m${++n}`, data: '2026-09-10', conta_id: 'c1', tipo: 'debito', valor: 10, operation_id: null, subcategoria: 'outro', pessoa_responsavel: null,
  lancamento_referencia_id: null, rota_id: null, motorista_id: null, descricao: null, estado: 'confirmado', origem: 'manual_geral', registo_id: null,
  custo_tipo: null, versao_anterior_id: null, validado_por: null, validado_em: null, deleted_at: null, motivo_apagado: null, sem_registo_previsto: false, created_at: '2026-09-10T10:00:00Z', ...o,
})
const routes = [
  { id: 'rA', nome: 'Rota A', operation_id: 'op1' },
  { id: 'rB', nome: 'Rota B', operation_id: 'op2' },
]

describe('sums: so o Confirmado conta nos totais oficiais', () => {
  it('pendentes ficam a parte e nunca entram no saldo', () => {
    const s = sums([mv({ tipo: 'credito', valor: 1000 }), mv({ valor: 100 }), mv({ valor: 50, estado: 'pendente' }), mv({ valor: 20, estado: 'pendente', tipo: 'credito' })])
    expect(s.credit).toBe(1000)
    expect(s.debit).toBe(100)
    expect(s.net).toBe(900)
    expect(s.pendingCount).toBe(2)
    expect(s.pendingAmount).toBe(70)
  })
  it('versoes substituidas (soft-deleted) nao contam: so o ativo mais recente da cadeia', () => {
    const old = mv({ valor: 40, deleted_at: '2026-09-11T00:00:00Z', motivo_apagado: 'substituído por edição' })
    const cur = mv({ valor: 150, versao_anterior_id: old.id })
    expect(sums([old, cur]).debit).toBe(150)
  })
})

describe('groupByDay: cada movimento aparece exatamente uma vez', () => {
  const transfer = mv({ data: '2026-09-10', valor: 300, subcategoria: 'transferencia_distribuicao', pessoa_responsavel: 'Joao' })
  const alloc1 = mv({ data: '2026-09-11', valor: 120, rota_id: 'rA', operation_id: 'op1', lancamento_referencia_id: transfer.id, estado: 'pendente', origem: 'manual_rota' })
  const alloc2 = mv({ data: '2026-09-10', valor: 80, rota_id: 'rB', operation_id: 'op2', lancamento_referencia_id: transfer.id, estado: 'pendente', origem: 'manual_rota' })
  const auto = mv({ data: '2026-09-10', valor: 40, rota_id: 'rA', operation_id: 'op1', origem: 'automatico', custo_tipo: 'combustivel' })
  const solta = mv({ data: '2026-09-10', valor: 15 })
  const all = [transfer, alloc1, alloc2, auto, solta]
  const days = groupByDay(all, (id) => routes.find((r) => r.id === id)!.nome, 'Geral')

  it('agrupa por dia (mais recente primeiro) e, dentro do dia, por rota; sem rota = Geral', () => {
    expect(days.map((d) => d.date)).toEqual(['2026-09-11', '2026-09-10'])
    const d10 = days[1]
    expect(d10.groups.map((g) => g.label)).toEqual(['Rota A', 'Rota B', 'Geral']) // Geral no fim
    expect(d10.groups.find((g) => g.key === GERAL)!.items.map((m) => m.id).sort()).toEqual([transfer.id, solta.id].sort())
  })
  it('a transferencia e as suas alocacoes sao movimentos distintos e nao se duplicam nem se juntam', () => {
    const ids = days.flatMap((d) => d.groups.flatMap((g) => g.items.map((m) => m.id)))
    expect(ids.sort()).toEqual(all.map((m) => m.id).sort())
    expect(new Set(ids).size).toBe(all.length)
    // a alocacao 1 esta noutro dia que a transferencia
    expect(days[0].groups[0].items).toEqual([alloc1])
  })
  it('subtotal por grupo e total por dia somam certo (so Confirmado no oficial, Pendente a parte)', () => {
    const d10 = days[1]
    expect(d10.groups.find((g) => g.label === 'Rota A')!.sums.debit).toBe(40)
    expect(d10.groups.find((g) => g.label === 'Rota B')!.sums.pendingAmount).toBe(80)
    expect(d10.sums.debit).toBe(300 + 40 + 15) // transferencia + automatico + solta (confirmados)
    expect(d10.sums.pendingAmount).toBe(80)
    expect(d10.sums.debit + d10.sums.pendingAmount).toBe(300 + 80 + 40 + 15)
  })
})

describe('filtros', () => {
  const list = [
    mv({ data: '2026-09-19', conta_id: 'c1' }),
    mv({ data: '2026-09-05', conta_id: 'c2', operation_id: 'op1', origem: 'manual_rota' }),
    mv({ data: '2026-08-20', operation_id: 'op2', origem: 'automatico' }),
    mv({ data: '2026-09-19', deleted_at: '2026-09-19T00:00:00Z', motivo_apagado: 'x' }),
  ]
  const F = { period: 'all', account: 'all', origin: 'all', category: 'all' } as const
  it('periodos', () => {
    expect(periodRange('today', '2026-09-19')).toEqual({ from: '2026-09-19', to: '2026-09-19' })
    expect(periodRange('lastMonth', '2026-09-19')).toEqual({ from: '2026-08-01', to: '2026-08-31' })
    expect(applyFilters(list, { ...F, period: 'thisMonth' }, '2026-09-19')).toHaveLength(2)
    expect(applyFilters(list, { ...F, period: 'today' }, '2026-09-19')).toHaveLength(1)
  })
  it('conta, origem e categoria combinam; apagados nunca aparecem', () => {
    expect(applyFilters(list, F, '2026-09-19')).toHaveLength(3)
    expect(applyFilters(list, { ...F, account: 'c2' }, '2026-09-19')).toHaveLength(1)
    expect(applyFilters(list, { ...F, origin: 'automatico' }, '2026-09-19')).toHaveLength(1)
    expect(applyFilters(list, { ...F, category: 'other' }, '2026-09-19')).toHaveLength(1)
    expect(applyFilters(list, { ...F, category: 'op1', account: 'c2' }, '2026-09-19')).toHaveLength(1)
    // com uma operacao selecionada: SO os movimentos dessa operacao; as despesas soltas (sem operacao) NAO entram (como no dashboard)
    const strict = applyFilters(list, { ...F, opId: 'op1' }, '2026-09-19')
    expect(strict).toHaveLength(1)
    expect(strict.every((m) => m.operation_id === 'op1')).toBe(true)
    expect(sums(strict).debit).toBe(sums(list.filter((m) => m.operation_id === 'op1')).debit)
    expect(applyFilters(list, { ...F, opId: 'all' }, '2026-09-19')).toHaveLength(3)
    // excecao explicita (fila "por validar" e Distribuicoes): inclui tambem o que nao tem operacao
    expect(applyFilters(list, { ...F, opId: 'op1', general: true }, '2026-09-19')).toHaveLength(2)
  })
  it('despesa solta Confirmada nao entra nos totais de uma operacao, mas continua nos totais gerais', () => {
    const solta = mv({ valor: 250, tipo: 'debito', subcategoria: 'manutencao' })
    const daOp = mv({ valor: 40, tipo: 'debito', operation_id: 'op1', origem: 'manual_rota' })
    expect(sums(applyFilters([solta, daOp], { ...F, opId: 'op1' }, '2026-09-19')).debit).toBe(40)
    expect(sums(applyFilters([solta, daOp], F, '2026-09-19')).debit).toBe(290)
  })
  it('fila "Por validar": todos os pendentes (bate sempre com o cartao "por validar"), nunca confirmados nem apagados', () => {
    const list = [
      mv({ estado: 'pendente', origem: 'automatico' }),
      mv({ estado: 'pendente', lancamento_referencia_id: 'x' }),
      mv({ estado: 'pendente' }), // legado: por regra um manual nao nasce pendente, mas se existir nao pode ficar escondido
      mv({ estado: 'confirmado', origem: 'automatico' }),
      mv({ estado: 'pendente', deleted_at: '2026-09-01T00:00:00Z' }),
    ]
    const q = pendingQueue(list)
    expect(q).toHaveLength(3)
    expect(sums(list).pendingCount).toBe(q.length)
  })
  it('alocacao "por ligar ao operacional"', () => {
    expect(isUnlinked(mv({ lancamento_referencia_id: 't', operation_id: 'op1', rota_id: 'rA' }))).toBe(true)
    expect(isUnlinked(mv({ lancamento_referencia_id: 't', operation_id: 'op1', rota_id: 'rA', registo_id: 'rec' }))).toBe(false)
    expect(isUnlinked(mv({ lancamento_referencia_id: 't' }))).toBe(false)
  })
})

describe('quadro: um arrasto = uma atualizacao', () => {
  const m = mv({ estado: 'pendente', rota_id: 'rA', operation_id: 'op1', origem: 'automatico' })
  it('outra coluna, mesma linha = validar (e reverter)', () => {
    expect(movePatch(m, { estado: 'confirmado', row: 'rA' }, routes)).toEqual({ estado: 'confirmado' })
    expect(movePatch({ ...m, estado: 'confirmado' }, { estado: 'pendente', row: 'rA' }, routes)).toEqual({ estado: 'pendente' })
  })
  it('outra linha, mesma coluna = reclassifica rota e operacao', () => {
    expect(movePatch(m, { estado: 'pendente', row: 'rB' }, routes)).toEqual({ rota_id: 'rB', operation_id: 'op2' })
  })
  it('Geral remove a rota (mantem a operacao)', () => {
    expect(movePatch(m, { estado: 'pendente', row: GERAL }, routes)).toEqual({ rota_id: null })
  })
  it('diagonal = as duas mudancas juntas', () => {
    expect(movePatch(m, { estado: 'confirmado', row: 'rB' }, routes)).toEqual({ estado: 'confirmado', rota_id: 'rB', operation_id: 'op2' })
  })
  it('largar no mesmo sitio nao faz nada', () => {
    expect(movePatch(m, { estado: 'pendente', row: 'rA' }, routes)).toBeNull()
  })
  it('manual geral que passa a ter rota ganha operacao; a origem NAO e enviada (e o servidor que a decide)', () => {
    const g = mv({ estado: 'confirmado' })
    expect(movePatch(g, { estado: 'confirmado', row: 'rA' }, routes)).toEqual({ rota_id: 'rA', operation_id: 'op1' })
  })
  it('cartao com rota fora do ambito nunca desaparece: cai em Geral', () => {
    const rows = boardRows([mv({ rota_id: 'arquivada', operation_id: 'op9' })], routes, 'Geral')
    expect(rows.find((r) => r.key === GERAL)!.cells.confirmado).toHaveLength(1)
  })
  it('linhas do quadro: rotas + Geral, colunas Pendente|Confirmado', () => {
    const rows = boardRows([m, mv({ estado: 'confirmado' }), mv({ estado: 'confirmado', rota_id: 'rA', operation_id: 'op1' })], routes, 'Geral')
    expect(rows.map((r) => r.label)).toEqual(['Rota A', 'Rota B', 'Geral'])
    expect(rows[0].cells.pendente).toHaveLength(1)
    expect(rows[0].cells.confirmado).toHaveLength(1)
    expect(rows[2].cells.confirmado).toHaveLength(1)
  })
})

describe('distribuicao: sobre/sub-alocacao nunca escondidas', () => {
  const t = { valor: 300 }
  it('sub, exata e sobre', () => {
    expect(allocationStatus(t, [mv({ valor: 120 })])).toMatchObject({ allocated: 120, diff: 180, state: 'under' })
    expect(allocationStatus(t, [mv({ valor: 120 }), mv({ valor: 180 })])).toMatchObject({ diff: 0, state: 'ok' })
    expect(allocationStatus(t, [mv({ valor: 200 }), mv({ valor: 150 })])).toMatchObject({ diff: -50, state: 'over' })
    expect(allocationStatus(t, [mv({ valor: 400, deleted_at: 'x' })])).toMatchObject({ allocated: 0, state: 'under' })
    // so alocacoes a debito contam (igual ao servidor)
    expect(allocationStatus(t, [mv({ valor: 500, tipo: 'credito' })])).toMatchObject({ allocated: 0, state: 'under' })
    expect(allocationStatus(t, [mv({ valor: 300 }), mv({ valor: 999, tipo: 'credito' })])).toMatchObject({ allocated: 300, state: 'ok' })
  })
})

describe('filtro "Sem conta"', () => {
  const list = [mv({ conta_id: null, origem: 'automatico' }), mv({ conta_id: 'c1' }), mv({ conta_id: 'c2' }), mv({ conta_id: null, deleted_at: 'x' })]
  const F = { period: 'all', account: 'all', origin: 'all', category: 'all' } as const
  it('"none" mostra so os ativos sem conta; uma conta so os dessa conta; "all" todos', () => {
    expect(applyFilters(list, { ...F, account: 'none' }, '2026-09-19').map((m) => m.conta_id)).toEqual([null])
    expect(applyFilters(list, { ...F, account: 'c1' }, '2026-09-19')).toHaveLength(1)
    expect(applyFilters(list, F, '2026-09-19')).toHaveLength(3)
  })
})

describe('motivo do Pendente', () => {
  it('alocacao de fundos: sempre, seja qual for o valor', () => {
    expect(pendingReason(mv({ estado: 'pendente', lancamento_referencia_id: 't', valor: 1 }), 100)).toBe('alloc')
    expect(pendingReason(mv({ estado: 'pendente', lancamento_referencia_id: 't', valor: 5000, origem: 'manual_rota' }), 100)).toBe('alloc')
  })
  it('automatico so acima do limite; igual ou abaixo nao tem motivo de limiar', () => {
    expect(pendingReason(mv({ estado: 'pendente', origem: 'automatico', valor: 100.01 }), 100)).toBe('aboveLimit')
    expect(pendingReason(mv({ estado: 'pendente', origem: 'automatico', valor: 100 }), 100)).toBe('autoBelow') // nao afirma o motivo (limite pode ter subido)
  })
  it('manual pendente = revertido; confirmado = sem motivo', () => {
    expect(pendingReason(mv({ estado: 'pendente' }), 100)).toBe('reverted')
    expect(pendingReason(mv({ estado: 'confirmado' }), 100)).toBeNull()
  })
})

describe('chunk (pedidos em lote)', () => {
  it('parte em blocos sem perder nem duplicar ids', () => {
    const ids = Array.from({ length: 250 }, (_, i) => 'id' + i)
    const parts = chunk(ids, 100)
    expect(parts.map((p) => p.length)).toEqual([100, 100, 50])
    expect(parts.flat()).toEqual(ids)
    expect(chunk([], 100)).toEqual([])
  })
})

describe('reclassificar uma alocacao ja propagada pede confirmacao', () => {
  const propagada = mv({ lancamento_referencia_id: 't', registo_id: 'rec', rota_id: 'rA', operation_id: 'op1', data: '2026-09-10' })
  it('mudar rota, operacao ou data de uma alocacao com registo_id', () => {
    expect(changesLink(propagada, { rota_id: 'rB', operation_id: 'op2' })).toBe(true)
    expect(changesLink(propagada, { operation_id: 'op2' })).toBe(false) // so a operacao: nao mexe na copia
    expect(changesLink(propagada, { tipo: 'credito' })).toBe(true)      // deixa de ser um custo
    expect(changesLink(propagada, { tipo: 'debito' })).toBe(false)      // igual ao atual
    expect(changesLink(propagada, { rota_id: null })).toBe(true)
    expect(changesLink(propagada, { data: '2026-09-11' })).toBe(true)
  })
  it('sem alteracao real, so valor/estado/descricao, "por ligar", manuais soltos e automaticos: sem confirmacao', () => {
    expect(changesLink(propagada, { rota_id: 'rA', operation_id: 'op1', data: '2026-09-10' })).toBe(false)
    expect(changesLink(propagada, {})).toBe(false)
    expect(changesLink({ ...propagada, registo_id: null }, { rota_id: 'rB' })).toBe(false) // ainda por ligar: nada a limpar
    expect(changesLink({ ...propagada, lancamento_referencia_id: null }, { rota_id: 'rB' })).toBe(false)
  })
  it('MoveCancelled distingue-se de um erro real', () => {
    expect(new MoveCancelled()).toBeInstanceOf(Error)
    expect(new MoveCancelled().name).toBe('MoveCancelled')
  })
})

describe('"Por ligar" e "sem registo previsto"', () => {
  const porLigar = mv({ lancamento_referencia_id: 't', operation_id: 'op1', rota_id: 'rA', registo_id: null })
  it('needsRecord so conta as por ligar NAO marcadas; noRecordExpected so as marcadas', () => {
    expect(needsRecord(porLigar)).toBe(true); expect(noRecordExpected(porLigar)).toBe(false)
    const marcada = { ...porLigar, sem_registo_previsto: true }
    expect(needsRecord(marcada)).toBe(false); expect(noRecordExpected(marcada)).toBe(true)
    expect(needsRecord({ ...porLigar, registo_id: 'rec' })).toBe(false)          // ja ligada
    expect(needsRecord({ ...porLigar, deleted_at: 'x' })).toBe(false)             // apagada
    expect(needsRecord({ ...porLigar, tipo: 'credito' })).toBe(false)             // so debitos propagam
    expect(needsRecord({ ...porLigar, rota_id: null })).toBe(false)               // sem rota nao ha para onde propagar
  })
  it('mais antigo primeiro', () => {
    const a = mv({ data: '2026-03-01' }), b = mv({ data: '2026-09-01' }), c = mv({ data: '2026-06-01' })
    expect(oldestFirst([b, a, c]).map((m) => m.data)).toEqual(['2026-03-01', '2026-06-01', '2026-09-01'])
  })
  it('relinkTarget: onde uma alocacao ainda nao ligada vai ligar-se (so se rota ou data mudam e ha operacao+rota)', () => {
    expect(relinkTarget(porLigar, { rota_id: 'rB' })).toEqual({ rota: 'rB', data: '2026-09-10' })
    expect(relinkTarget(porLigar, { data: '2026-09-12' })).toEqual({ rota: 'rA', data: '2026-09-12' })
    expect(relinkTarget(porLigar, { rota_id: null })).toBeNull()
    expect(relinkTarget(porLigar, { descricao: 'x' } as never)).toBeNull()
    expect(relinkTarget({ ...porLigar, tipo: 'credito' }, { rota_id: 'rB' })).toBeNull()
    expect(relinkTarget({ ...porLigar, tipo: 'credito' }, { tipo: 'debito' })).toEqual({ rota: 'rA', data: '2026-09-10' }) // credito -> debito liga-se
    expect(relinkTarget(porLigar, { tipo: 'credito' })).toBeNull()
  })
})
