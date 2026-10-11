// Regras "ja em vigor" (item 9): origem so do servidor, estado inicial nao escolhido pelo cliente, referencias coerentes / tenant.
import { ctx, T, loginAll, users, t, setCaso, setArea, eq, ok, must, denied, sql, mvIns, mv, dump } from './h.mjs'
await loginAll(); const { admin, cont, oper, tb } = users
setArea('Origem e referencias coerentes'); setCaso('REGRAS')
await t('Manual com estado=pendente forjado nasce Confirmado (o cliente nao escolhe o estado); origem forjada no INSERT ignorada/recusada; Manual-Rota vs Manual-Geral pela operacao', async () => {
  const m = await must(mvIns(cont, { descricao: 'QA-C-r-estado', estado: 'pendente' }).single()); eq([m.estado, m.origem], ['confirmado', 'manual_geral'], 'manual ' + m.id)
  for (const o of ['automatico', 'manual_rota', 'manual_geral']) {
    const r = await mvIns(cont, { descricao: 'QA-C-r-origem-' + o, origem: o }); ok(r.error, `INSERT com origem='${o}' enviada foi aceite (${r.data?.[0]?.id})`)
  }
  await denied(mvIns(cont, { descricao: 'QA-C-r-rota-forjada', operation_id: ctx.opLN, rota_id: ctx.R1, origem: 'automatico' }), 'INSERT com origem enviada (Contabilista)')
  await denied(mvIns(admin, { descricao: 'QA-C-r-rota-forjada-sa', operation_id: ctx.opLN, rota_id: ctx.R1, origem: 'automatico' }), 'INSERT com origem enviada (Super Admin)')
  const rr = await must(mvIns(cont, { descricao: 'QA-C-r-rota', operation_id: ctx.opLN, rota_id: ctx.R1 }).single()); eq(rr.origem, 'manual_rota', 'origem com operacao ' + rr.id)
  const r1 = await cont.from('movements').update({ origem: 'automatico' }).eq('id', m.id).select('id'); ok(r1.error || !r1.data?.length, 'UPDATE origem->automatico (Contabilista) aceite ' + m.id)
  const r2 = await admin.from('movements').update({ origem: 'automatico' }).eq('id', m.id).select('id'); ok(r2.error || !r2.data?.length, 'UPDATE origem->automatico (Super Admin) aceite ' + m.id)
  eq((await mv(m.id)).origem, 'manual_geral', 'origem final ' + m.id)
})
await t('Forjar registo_id / custo_tipo / versao_anterior_id / validado_por / validado_em no INSERT e UPDATE de um manual: recusado ou ignorado', async () => {
  const rec = (await sql(`select id from daily_records d where d.deleted_at is null and route_id='${ctx.R1}' limit 1`))[0]?.id
  const m = await must(mvIns(cont, { descricao: 'QA-C-r-server-fields' }).single())
  const r = await cont.from('movements').update({ registo_id: rec, custo_tipo: 'combustivel' }).eq('id', m.id).select('id'); ok(r.error || !r.data?.length, 'registo_id/custo_tipo aceites em ' + m.id)
  const r2 = await cont.from('movements').update({ validado_por: cont.uid, validado_em: new Date().toISOString() }).eq('id', m.id).select('id'); ok(r2.error || !r2.data?.length, 'validado_por aceite em ' + m.id)
  const ins = await mvIns(cont, { descricao: 'QA-C-r-ins-forjado', registo_id: rec, custo_tipo: 'combustivel', validado_por: cont.uid, validado_em: new Date().toISOString() })
  if (!ins.error) { const x = ins.data[0]; eq([x.registo_id, x.custo_tipo, x.validado_por], [null, null, null], 'campos do servidor aceites no INSERT ' + x.id) }
})
await t('Operacao+rota incoerentes recusadas (manual, INSERT e UPDATE); rota de outra operacao; despesa solta com rota sem operacao', async () => {
  await denied(mvIns(cont, { descricao: 'QA-C-r-incoe', operation_id: ctx.opLN, rota_id: ctx.RP }), 'INSERT op Lisboa + rota Porto')
  const m = await must(mvIns(cont, { descricao: 'QA-C-r-incoe2', operation_id: ctx.opLN, rota_id: ctx.R1 }).single())
  await denied(cont.from('movements').update({ operation_id: ctx.opPC }).eq('id', m.id).select('id'), 'UPDATE so operacao (rota R1 e de Lisboa) ' + m.id)
  await denied(cont.from('movements').update({ rota_id: ctx.RP }).eq('id', m.id).select('id'), 'UPDATE so rota (Porto) ' + m.id)
  await denied(mvIns(cont, { descricao: 'QA-C-r-incoe3', rota_id: ctx.R1 }), 'rota sem operacao')
})
await t('Tenant B: nao consegue ver/escrever movimentos do tenant A; movimento do tenant A nao aceita referencias (rota/operacao/motorista/registo/transferencia) do tenant B', async () => {
  eq((await must(tb.from('movements').select('id').like('descricao', 'QA-C-%').eq('tenant_id', T))).length, 0, 'tenant B ve movimentos QA-C')
  const tbTenant = (await must(tb.from('profiles').select('tenant_id').eq('id', tb.uid).single())).tenant_id
  let tbOp = (await must(tb.from('operation_options').select('id').limit(1)))[0]?.id
  if (!tbOp) tbOp = (await must(tb.from('operations').insert({ tenant_id: tbTenant, nome: 'QA-C-OpB' }).select('id').single())).id
  let tbRoute = (await sql(`select r.id from routes r join operations o on o.id=r.operation_id where o.tenant_id='${tbTenant}' and r.deleted_at is null limit 1`))[0]?.id
  if (!tbRoute) tbRoute = (await must(tb.from('routes').insert({ operation_id: tbOp, nome: 'QA-C-RB' }).select('id').single())).id
  const tbAcc = (await sql(`select id from bank_accounts where tenant_id='${tbTenant}' and deleted_at is null limit 1`))[0]?.id
  const tbRec = (await sql(`select d.id from daily_records d join routes r on r.id=d.route_id join operations o on o.id=r.operation_id where o.tenant_id='${tbTenant}' limit 1`))[0]?.id
  const tbTr = await must(tb.from('movements').insert({ tenant_id: tbTenant, conta_id: tbAcc, data: '2026-08-20', tipo: 'debito', valor: 5, subcategoria: 'transferencia_distribuicao', pessoa_responsavel: 'QA-C-tb', descricao: 'QA-C-tb-transf' }).select('id').single()).catch((e) => ({ err: e.message }))
  const tried = []
  if (tbOp) { await denied(mvIns(cont, { descricao: 'QA-C-r-xop', operation_id: tbOp }), 'operacao do tenant B'); tried.push('operacao') }
  if (tbRoute) { await denied(mvIns(cont, { descricao: 'QA-C-r-xrota', operation_id: ctx.opLN, rota_id: tbRoute }), 'rota do tenant B'); tried.push('rota') }
  if (tbTr?.id) { await denied(mvIns(cont, { descricao: 'QA-C-r-xref', subcategoria: 'outro', lancamento_referencia_id: tbTr.id }), 'transferencia do tenant B'); tried.push('transferencia') }
  const tbDriver = (await sql(`select id from drivers where tenant_id='${tbTenant}' limit 1`))[0]?.id
  if (tbDriver) { await denied(mvIns(cont, { descricao: 'QA-C-r-xmot', motorista_id: tbDriver }), 'motorista do tenant B'); tried.push('motorista') }
  const write = await tb.from('movements').insert({ tenant_id: T, data: '2026-08-20', tipo: 'debito', valor: 5, subcategoria: 'outro', descricao: 'QA-C-r-tb-into-A' }).select('id'); ok(write.error || !write.data?.length, 'tenant B inseriu no tenant A')
  if (tbRec) tried.push('registo(sem endpoint)')
  return 'referencias testadas: ' + tried.join(', ') + (tbTr?.err ? ' (transferencia B nao criada: ' + tbTr.err + ')' : '')
})
dump('results-07.json')
