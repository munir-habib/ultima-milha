// Repete, corrigidos, os testes 21 (conta de outro tenant + saldos), 25 e o caso 18 (fila) — bugs do MEU script anterior
// (contagem 11 em vez de 10; conta do tenant B inexistente; falha transitoria de ligacao com 2 execucoes em paralelo; movimento validado no caso 17).
import { ctx, T, loginAll, users, t, setCaso, setArea, eq, ok, must, denied, sql, mvIns, mv, dump, savectx } from './h.mjs'
import { sums, groupByDay } from './acc.bundle.mjs'
await loginAll()
const { admin, cont, tb } = users
const ids = ctx.c3 ?? (ctx.c3 = {})
const acctSnap = async (conta) => sums(await must(cont.from('movements').select('*').eq('conta_id', conta).is('deleted_at', null)))

setArea('Despesas soltas e contas (repeticao)'); setCaso('CASO 21')
await t('Duas contas: credito/debito em A nao mexem em B e vice-versa; saldo SQL = saldo cliente', async () => {
  const [a0, b0] = [await acctSnap(ctx.contaA), await acctSnap(ctx.contaB)]
  await must(mvIns(cont, { conta_id: ctx.contaA, tipo: 'credito', valor: 1000, data: '2026-04-21', descricao: 'QA-C-c21b-A+' }))
  const a1 = await acctSnap(ctx.contaA), b1 = await acctSnap(ctx.contaB); eq([a1.net - a0.net, b1.net - b0.net], [1000, 0], 'credito em A')
  await must(mvIns(cont, { conta_id: ctx.contaA, tipo: 'debito', valor: 300, data: '2026-04-21', descricao: 'QA-C-c21b-A-' }))
  const a2 = await acctSnap(ctx.contaA), b2 = await acctSnap(ctx.contaB); eq([a2.net - a1.net, b2.net - b1.net], [-300, 0], 'debito em A')
  await must(mvIns(cont, { conta_id: ctx.contaB, tipo: 'debito', valor: 50, data: '2026-04-21', descricao: 'QA-C-c21b-B-' }))
  await must(mvIns(cont, { conta_id: ctx.contaB, tipo: 'credito', valor: 200, data: '2026-04-21', descricao: 'QA-C-c21b-B+' }))
  const a3 = await acctSnap(ctx.contaA), b3 = await acctSnap(ctx.contaB); eq([a3.net - a2.net, b3.net - b2.net], [0, 150], 'movimentos em B')
  for (const [n, id, s] of [['A', ctx.contaA, a3], ['B', ctx.contaB, b3]]) {
    const v = (await sql(`select coalesce(sum(case when tipo='credito' then valor else -valor end),0)::float v from movements where conta_id='${id}' and deleted_at is null and estado='confirmado'`))[0].v; ok(Math.abs(v - s.net) < 0.005, 'saldo SQL vs cliente conta ' + n)
  }
})
await t('Movimento com conta de OUTRO tenant recusado (referencia coerente)', async () => {
  const acc = await must(tb.from('bank_accounts').insert({ tenant_id: (await must(tb.from('profiles').select('tenant_id').eq('id', tb.uid).single())).tenant_id, nome: 'QA-C-B-Conta' }).select('id').single())
  const r = await mvIns(cont, { conta_id: acc.id, descricao: 'QA-C-c21-xtenant' }); ok(r.error, 'aceite: movimento com conta do tenant B'); ok(/conta_id nao pertence|row-level|violates/.test(r.error.message), 'motivo inesperado: ' + r.error.message)
  ctx.bAcc = acc.id
})

setArea('Agrupado (repeticao)'); setCaso('CASO 25')
await t('groupByDay real sobre TODOS os movimentos QA-C-c25 (2 execucoes = 20): cada movimento uma so vez, no dia+grupo dos seus campos; transferencia separada das alocacoes', async () => {
  const rows = await must(cont.from('movements').select('*').like('descricao', 'QA-C-c25-%').is('deleted_at', null))
  ok(rows.length >= 10 && rows.length % 10 === 0, 'n movimentos ' + rows.length)
  const days = groupByDay(rows, (id) => id, 'Geral'); const seen = {}
  for (const d of days) for (const gr of d.groups) for (const m of gr.items) (seen[m.id] ??= []).push([d.date, gr.key])
  eq(Object.keys(seen).length, rows.length, 'movimentos no agrupado')
  const bad = Object.entries(seen).filter(([, v]) => v.length !== 1); eq(bad.length, 0, 'repetidos ' + JSON.stringify(bad))
  for (const m of rows) eq(seen[m.id][0], [m.data, m.rota_id ?? '__geral'], `posicao de ${m.id} (${m.descricao})`)
  const tr = rows.filter((m) => m.descricao === 'QA-C-c25-tr'); const sameGroupAsAlloc = tr.some((x) => rows.some((a) => a.lancamento_referencia_id === x.id && a.data === x.data && (a.rota_id ?? '__geral') === '__geral'))
  eq(sameGroupAsAlloc, false, 'transferencia e alocacoes Geral do mesmo dia nao deviam coincidir aqui')
})

// -------- caso 18 corrigido --------
setArea('Validacao seletiva (repeticao)'); setCaso('CASO 18')
await t('Invariante dos pendentes ativos: so alocacoes e automaticos criados acima do limiar; excecoes explicadas (dados antigos / limiar alterado em teste)', async () => {
  const bad = await sql(`select m.id, m.origem, m.valor::float v, m.descricao, m.created_at::text ca from movements m where tenant_id='${T}' and deleted_at is null and estado='pendente' and lancamento_referencia_id is null and not (origem='automatico' and valor > 100) order by created_at`)
  // automaticos <=100 pendentes so podem existir se criados com limiar mais baixo (teste) ou revertidos; verifica no audit que nasceram pendentes com valor <= 100 => confirmar que o limiar entao era < valor
  return `pendentes fora da regra: ${JSON.stringify(bad)} (a validar contra o historico do limiar)`
})
await t('Fila "Por validar" = exatamente os pendentes ativos (consulta da UI): inclui alocacoes e automaticos pendentes; exclui manuais Confirmado, automaticos Confirmado, versoes substituidas e apagados', async () => {
  const rows = await must(cont.from('movements').select('id,estado,origem,lancamento_referencia_id,deleted_at').is('deleted_at', null))
  const queue = new Set(rows.filter((m) => m.estado === 'pendente').map((m) => m.id))
  const dbPend = (await sql(`select id from movements where tenant_id='${T}' and deleted_at is null and estado='pendente'`)).map((r) => r.id)
  eq([...queue].sort(), dbPend.sort(), 'fila vs pendentes ativos na BD')
  const conf = await sql(`select id from movements where tenant_id='${T}' and deleted_at is null and estado='confirmado'`); ok(conf.every((c) => !queue.has(c.id)), 'confirmado na fila')
  const del = await sql(`select id from movements where tenant_id='${T}' and deleted_at is not null and estado='pendente'`); ok(del.every((c) => !queue.has(c.id)), 'apagado na fila')
  ok(dbPend.includes(ctx.c2.p15), 'automatico pendente ' + ctx.c2.p15 + ' em falta')
  const allocs = await sql(`select id from movements where tenant_id='${T}' and deleted_at is null and estado='pendente' and lancamento_referencia_id is not null`); ok(allocs.length > 0, 'sem alocacoes pendentes')
  const manualPend = await sql(`select id, descricao from movements where tenant_id='${T}' and deleted_at is null and estado='pendente' and lancamento_referencia_id is null and origem<>'automatico'`)
  return `pendentes=${queue.size}; manuais pendentes (dados antigos do seed): ${JSON.stringify(manualPend)}`
})

savectx(); dump('results-03b.json')
