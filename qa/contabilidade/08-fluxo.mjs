// Fluxo normal do registo (item 4): Rascunho -> Submetido -> Validado; editar Validado reabre; Operador nao edita Validado (RLS).
import { ctx, loginAll, users, t, setCaso, setArea, eq, ok, must, denied, sql, mkRec, dump } from './h.mjs'
await loginAll(); const { admin, oper, gest } = users
setArea('Fluxo do registo'); setCaso('F3')
await t('Rascunho -> Submetido -> Validado (Gestor); editar Validado (Super Admin) reabre para Submetido, limpa validado_por e avisa o validador; Operador nao edita Validado', async () => {
  const rec = await mkRec(oper, ctx.R2, '2026-08-20', { comb_valor: 10 })
  await must(oper.from('daily_records').update({ status: 'submetido' }).eq('id', rec).select('id'))
  await must(gest.from('daily_records').update({ status: 'validado' }).eq('id', rec).select('id'))
  let r = (await sql(`select status, validado_por from daily_records where id='${rec}'`))[0]; eq([r.status, r.validado_por], ['validado', gest.uid], 'validado ' + rec)
  await denied(oper.from('daily_records').update({ comb_valor: 11 }).eq('id', rec).select('id'), 'operador edita validado ' + rec)
  await must(admin.from('daily_records').update({ comb_valor: 12 }).eq('id', rec).select('id'))
  r = (await sql(`select status, validado_por, validado_em from daily_records where id='${rec}'`))[0]; eq([r.status, r.validado_por, r.validado_em], ['submetido', null, null], 'reaberto ' + rec)
  eq((await sql(`select count(*)::int n from notifications where tipo='record_reopened' and payload->>'record_id'='${rec}' and user_id='${gest.uid}'`))[0].n, 1, 'aviso ao validador ' + rec)
})
dump('results-08.json')
