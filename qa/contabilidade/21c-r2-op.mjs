// R2.1 alternativo: mudar SO a operacao (rota e data iguais): move-se a rota QA (Super Admin) para outra operacao e reclassifica-se a alocacao.
import { ctx, T, loginAll, users, t, setCaso, setArea, eq, ok, must, sql, mvIns, mv, mkRec, dump } from './h.mjs'
await loginAll(); const { admin, cont, gest, oper } = users
const lines = (mid) => sql(`select id, record_id, deleted_at from daily_record_costs where movimento_id='${mid}' order by created_at, id`)
setArea('R2 - relink so por rota/data'); setCaso('R2')
await t('R2.1b mudar so a OPERACAO (rota+data iguais; rota movida a outra operacao) nao desliga a linha, nao reverte o registo Validado e nao avisa', async () => {
  const D = '2026-06-16'
  const tr = await must(mvIns(cont, { subcategoria: 'transferencia_distribuicao', valor: 500, pessoa_responsavel: 'QA-C-R2b', data: D, descricao: 'QA-C-r2b-tr' }).single())
  const r = await mkRec(oper, ctx.R1, D); const a = await must(mvIns(cont, { subcategoria: 'outro', valor: 44, pessoa_responsavel: 'QA-C-R2b', lancamento_referencia_id: tr.id, data: D, operation_id: ctx.opLN, rota_id: ctx.R1, descricao: 'QA-C-r2b-al' }).single())
  eq((await mv(a.id)).registo_id, r, 'propagada'); await must(gest.from('daily_records').update({ status: 'validado' }).eq('id', r).select('id'))
  const before = await lines(a.id)
  const mr = await admin.from('routes').update({ operation_id: ctx.opPC }).eq('id', ctx.R1).select('id'); ok(!mr.error, 'mover rota: ' + mr.error?.message)
  try {
    const u = await cont.from('movements').update({ operation_id: ctx.opPC }).eq('id', a.id).select('id'); ok(!u.error, 'reclassificar so a operacao: ' + u.error?.message)
    const m = await mv(a.id); const rr = (await sql(`select status, validado_por from daily_records where id='${r}'`))[0]
    eq([m.operation_id, m.rota_id, m.registo_id, rr.status, rr.validado_por], [ctx.opPC, ctx.R1, r, 'validado', gest.uid], `alocacao ${a.id} / registo ${r}`)
    eq(JSON.stringify(await lines(a.id)), JSON.stringify(before), 'linha de custo intacta')
    eq((await sql(`select count(*)::int n from notifications where tipo='record_reopened' and payload->>'record_id'='${r}'`))[0].n, 0, 'record_reopened indevido')
  } finally { await must(admin.from('routes').update({ operation_id: ctx.opLN }).eq('id', ctx.R1).select('id')) }
})
dump('results-21c.json'); process.exit(0)
