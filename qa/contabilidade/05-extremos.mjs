// Casos-limite adicionais (fora da numeracao 1-31): valores extremos, concorrencia, campos que o cliente nao devia controlar.
import { ctx, T, loginAll, users, t, setCaso, setArea, eq, ok, must, denied, sql, mvIns, mv, mkRec, autos, dump } from './h.mjs'
await loginAll(); const { admin, cont, oper } = users
setArea('Extremos'); setCaso('EXTRA')
const transfer = (o) => must(mvIns(cont, { subcategoria: 'transferencia_distribuicao', pessoa_responsavel: 'QA-Extra', data: '2026-06-10', ...o, descricao: 'QA-C-x-' + (o.descricao ?? 't') }).single())
const alloc = (tr, o) => must(mvIns(cont, { subcategoria: 'outro', pessoa_responsavel: 'QA-Extra', lancamento_referencia_id: tr.id, data: '2026-06-10', operation_id: ctx.opLN, rota_id: ctx.R1, ...o, descricao: 'QA-C-x-' + (o.descricao ?? 'a') }).single())
const status = async (id) => (await must(cont.from('fund_transfer_status').select('*').eq('id', id)))[0]
const notifN = async (id) => (await sql(`select count(*)::int n from notifications where tipo='fund_over_allocated' and payload->>'movement_id'='${id}'`))[0].n

await t('Reduzir o valor da TRANSFERENCIA abaixo do alocado (500 -> 300 com 400 alocados): estado over e notificacao', async () => {
  const tr = await transfer({ valor: 500, descricao: 't1' }); await alloc(tr, { valor: 400, rota_id: null, operation_id: null })
  eq((await status(tr.id)).estado, 'under', 'antes'); const n0 = await notifN(tr.id)
  await must(cont.from('movements').update({ valor: 300 }).eq('id', tr.id).select())
  const s = await status(tr.id); eq([s.estado, Number(s.diferenca)], ['over', -100], 'transferencia ' + tr.id); ok((await notifN(tr.id)) > n0, 'sem notificacao ao reduzir a transferencia ' + tr.id)
})
await t('Mover uma alocacao para outra transferencia (UPDATE lancamento_referencia_id): as duas vistas recalculam', async () => {
  const t1 = await transfer({ valor: 100, descricao: 't2a' }), t2 = await transfer({ valor: 100, descricao: 't2b' }); const a = await alloc(t1, { valor: 100, rota_id: null, operation_id: null })
  await must(cont.from('movements').update({ lancamento_referencia_id: t2.id }).eq('id', a.id).select())
  eq([(await status(t1.id)).estado, (await status(t2.id)).estado], ['under', 'ok'], `t1 ${t1.id} t2 ${t2.id}`)
})
await t('Alocacao a CREDITO conta como alocado na vista do servidor? (um credito nao devia consumir o fundo)', async () => {
  const tr = await transfer({ valor: 100, descricao: 't3' }); await alloc(tr, { valor: 100, tipo: 'credito', rota_id: null, operation_id: null })
  const s = await status(tr.id)
  if (s.estado === 'ok') throw new Error(`transferencia ${tr.id}: uma alocacao do tipo CREDITO de 100 conta como alocado (estado ok, alocado ${s.alocado}); fund_transfer_status soma valor sem olhar a tipo (0014)`)
})
await t('Alocacao pode apontar para um lancamento que NAO e transferencia, para outra alocacao, ou para transferencia ja apagada', async () => {
  const man = await must(mvIns(cont, { valor: 50, descricao: 'QA-C-x-manual-ref' }).single())
  const r1 = await mvIns(cont, { subcategoria: 'outro', valor: 5, lancamento_referencia_id: man.id, descricao: 'QA-C-x-ref-manual' })
  const tr = await transfer({ valor: 50, descricao: 't4' }); const a = await alloc(tr, { valor: 5, rota_id: null, operation_id: null })
  const r2 = await mvIns(cont, { subcategoria: 'outro', valor: 5, lancamento_referencia_id: a.id, descricao: 'QA-C-x-ref-alloc' })
  const acc = []; if (!r1.error) acc.push('alocacao -> lancamento manual ' + man.id + ' (' + r1.data[0].id + ')'); if (!r2.error) acc.push('alocacao -> alocacao ' + a.id + ' (' + r2.data[0].id + ')')
  if (acc.length) return 'nota (sem regra que o proiba): aceite ' + acc.join('; ')
})
await t('Valores extremos: 0.001 (arredonda a 0) e 1e12 (excede numeric(14,2)) recusados com erro limpo; 999999999999.99 aceite', async () => {
  const r0 = await mvIns(cont, { valor: 0.001, descricao: 'QA-C-x-0001' }); ok(r0.error, '0.001 aceite: ' + JSON.stringify(r0.data?.map((x) => [x.id, x.valor])))
  const r1 = await mvIns(cont, { valor: 1e12, descricao: 'QA-C-x-1e12' }); ok(r1.error, '1e12 aceite')
  const r2 = await mvIns(cont, { valor: 999999999999.99, descricao: 'QA-C-x-max' }); ok(!r2.error, 'maximo recusado: ' + r2.error?.message)
  const r3 = await mvIns(cont, { valor: 10.005, descricao: 'QA-C-x-10005' }); return `10.005 gravado como ${r3.data?.[0]?.valor}; ${r1.error.message}`
})
await t('Datas extremas (1900-01-01, 2100-12-31) e formato invalido: comportamento', async () => {
  const a = await mvIns(cont, { data: '1900-01-01', descricao: 'QA-C-x-1900' }), b = await mvIns(cont, { data: '2100-12-31', descricao: 'QA-C-x-2100' }), c = await mvIns(cont, { data: '2026-02-30', descricao: 'QA-C-x-fev30' })
  ok(c.error, '2026-02-30 aceite'); return `1900-01-01 ${a.error ? 'recusada' : 'aceite'}; 2100-12-31 ${b.error ? 'recusada' : 'aceite'} (sem regra de intervalo de datas)`
})
await t('Concorrencia: 6 edicoes simultaneas do combustivel do mesmo registo deixam exatamente 1 lancamento ativo', async () => {
  const rec = await mkRec(oper, ctx.R1, '2026-06-11', { comb_valor: 10, status: 'submetido' })
  await Promise.all([11, 12, 13, 14, 15, 16].map((v) => oper.from('daily_records').update({ comb_valor: v }).eq('id', rec).select('id')))
  const a = await autos(rec, 'combustivel'); const act = a.filter((x) => !x.deleted_at); eq(act.length, 1, `versoes ativas do registo ${rec}: ` + JSON.stringify(act.map((x) => [x.id, x.v])))
  const rec2 = await mkRec(oper, ctx.R2, '2026-06-11', { comb_valor: 10, status: 'submetido' })
  await Promise.all([1, 2, 3, 4].map((i) => oper.from('daily_records').update({ comb_valor: 20 + i, portagens_valor: 30 + i }).eq('id', rec2).select('id')))
  const c = await autos(rec2, 'combustivel'), p = await autos(rec2, 'portagens'); eq([c.filter((x) => !x.deleted_at).length, p.filter((x) => !x.deleted_at).length], [1, 1], 'registo ' + rec2)
})
await t('Autoria/tempo de um lancamento nao pode ser reescrito pelo cliente (created_by, created_at)', async () => {
  const m = await must(mvIns(cont, { descricao: 'QA-C-x-autoria' }).single())
  const other = (await sql(`select id from profiles where email='qa.operador@example.test'`))[0].id
  const r = await cont.from('movements').update({ created_by: other, created_at: '2001-01-01T00:00:00Z' }).eq('id', m.id).select('created_by,created_at')
  const now = await mv(m.id)
  if (now.created_by === other || String(now.created_at).startsWith('2001')) throw new Error(`Contabilista reescreveu created_by/created_at do movimento ${m.id} (created_by=${now.created_by}, created_at=${now.created_at}); o audit_log mantem o autor real mas o proprio registo mente`)
})
await t('Um lancamento AUTOMATICO nao pode ser transformado em alocacao/transferencia (lancamento_referencia_id, subcategoria, pessoa) na Contabilidade', async () => {
  const rec = await mkRec(oper, ctx.R2, '2026-06-12', { comb_valor: 15, status: 'submetido' }); const a = (await autos(rec, 'combustivel'))[0]
  const tr = await transfer({ valor: 500, descricao: 't5' })
  const r = await cont.from('movements').update({ lancamento_referencia_id: tr.id, subcategoria: 'transferencia_distribuicao', pessoa_responsavel: 'QA-forjada' }).eq('id', a.id).select('id')
  const now = await mv(a.id)
  if (now.lancamento_referencia_id === tr.id || now.subcategoria === 'transferencia_distribuicao') throw new Error(`Contabilista passou o lancamento automatico ${a.id} (registo ${rec}) a alocacao de ${tr.id} / subcategoria transferencia (o guard so protege valor,data,tipo,origem,registo_id,custo_tipo,versao_anterior_id): a transferencia fica com alocado=${(await status(tr.id))?.alocado} e o estado do automatico nao e reavaliado`)
})
dump('results-05.json')
