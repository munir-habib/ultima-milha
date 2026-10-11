// Caso 29 (variante): arrasto na DIAGONAL de uma alocacao JA propagada (estado + rota numa so atualizacao).
// O PATCH e o mesmo que o Quadro envia. Conta as entradas de audit: a do utilizador (estado+rota juntos) e as do sistema (religar registo).
import { ctx, T, loginAll, users, t, setCaso, setArea, eq, ok, must, sql, mvIns, mv, mkRec, dump } from './h.mjs'
await loginAll(['cont', 'oper', 'admin']); const { cont, oper } = users
setArea('Caso 29 - diagonal numa alocacao propagada'); setCaso('CASO 29')
await t('Diagonal (Pendente R1 -> Confirmado R2) numa alocacao propagada: UMA entrada do utilizador com estado E rota; as restantes (registo_id) sao do sistema', async () => {
  const D = '2026-09-05'; const r1 = await mkRec(oper, ctx.R1, D), r2 = await mkRec(oper, ctx.R2, D)
  const tr = await must(mvIns(cont, { subcategoria: 'transferencia_distribuicao', valor: 500, pessoa_responsavel: 'QA-C-Diag', data: D, descricao: 'QA-C-d-tr' }).single())
  const a = await must(mvIns(cont, { subcategoria: 'outro', valor: 20, pessoa_responsavel: 'QA-C-Diag', lancamento_referencia_id: tr.id, data: D, operation_id: ctx.opLN, rota_id: ctx.R1, descricao: 'QA-C-d-a' }).single())
  eq((await mv(a.id)).registo_id, r1, 'propagada ' + a.id)
  const n0 = (await sql(`select count(*)::int n from audit_log where tabela='movements' and registo_id='${a.id}'`))[0].n
  await must(cont.from('movements').update({ estado: 'confirmado', rota_id: ctx.R2, operation_id: ctx.opLN }).eq('id', a.id).select())
  const au = await sql(`select id, acao, user_id, antes->>'estado' ae, depois->>'estado' de, antes->>'rota_id' ar, depois->>'rota_id' dr, antes->>'registo_id' arg, depois->>'registo_id' drg from audit_log where tabela='movements' and registo_id='${a.id}' order by id offset ${n0}`)
  const both = au.filter((x) => x.ae === 'pendente' && x.de === 'confirmado' && x.ar === ctx.R1 && x.dr === ctx.R2)
  eq(both.length, 1, 'entradas com estado E rota juntos ' + a.id + ': ' + JSON.stringify(au))
  const m = await mv(a.id); eq([m.estado, m.rota_id, m.registo_id, m.validado_por], ['confirmado', ctx.R2, r2, cont.uid], 'estado final ' + a.id)
  return `${au.length} entradas de audit no total (${au.map((x) => `${x.arg?.slice(0, 4) ?? 'null'}->${x.drg?.slice(0, 4) ?? 'null'}/${x.ae}->${x.de}`).join(' ; ')}); so 1 tem estado+rota; as outras sao alteracoes de registo_id feitas pelo sistema (desligar/ligar)`
})
dump('results-15.json')
