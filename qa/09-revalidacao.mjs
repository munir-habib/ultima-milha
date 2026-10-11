// Revalidacao pos-migracoes 0011-0014: F1..F10 + campos geridos pelo servidor (registo_id, custo_tipo, versao_anterior_id, validado_por, validado_em)
// + fluxos legitimos + sobre-alocacao. Tudo como utilizador real (RLS) exceto montagem/verificacao (sql = postgres).
// Dados criados com prefixo QA-R9-. Nunca escreve codigo da app.
import { login, ADMIN, sql, t, setArea, eq, ok, must, save } from './lib.mjs'

const admin = await login(...ADMIN)
const [cont, gest, oper, mot, tb] = await Promise.all(['qa.contabilista', 'qa.gestor', 'qa.operador', 'qa.motorista', 'qa.tenantb'].map((n) => login(n + '@example.test')))
const A = (await must(admin.from('profiles').select('tenant_id').eq('id', admin.uid).single())).tenant_id
const B = (await must(tb.from('profiles').select('tenant_id').eq('id', tb.uid).single())).tenant_id
const today = (await sql(`select (now() at time zone 'Europe/Lisbon')::date::text d`))[0].d
const addDays = (d, n) => new Date(new Date(d + 'T12:00:00Z').getTime() + n * 86400000).toISOString().slice(0, 10)
const CONTA = (await must(admin.from('bank_accounts').select('id').is('deleted_at', null).limit(1).single())).id
const ids = {}

// refusa: tem de haver erro; opcionalmente o erro tem de vir do gatilho esperado (nao de outra coisa)
async function refused(p, re, label) {
  const r = await p
  if (!r.error) throw new Error(`${label}: NAO recusado (${JSON.stringify(r.data)?.slice(0, 160)})`)
  if (re && !re.test(r.error.message)) throw new Error(`${label}: recusado por motivo inesperado: ${r.error.message}`)
  return r.error.message
}
const ins = (sb, o) => sb.from('movements').insert({ tenant_id: A, data: '2026-04-15', conta_id: CONTA, tipo: 'debito', valor: 10, subcategoria: 'outro', ...o }).select('*')
const mv = async (id) => (await sql(`select * from movements where id='${id}'`))[0]

// ---------- cenario ----------
const opLN = (await must(admin.from('operation_options').select('id,nome'))).find((o) => o.nome === 'Lisboa Norte').id
const opPC = (await must(admin.from('operation_options').select('id,nome'))).find((o) => o.nome === 'Porto Centro').id
const mkRoute = (operation_id, nome, extra = {}) => must(admin.from('routes').insert({ operation_id, nome, tarifa_por_estado: false, tarifa_valor_fixo: true, tarifa_por_distancia: true, taxa_km: 0.5, valor_fixo_default: 40, ...extra }).select('id').single()).then((r) => r.id)
const rLN = await mkRoute(opLN, 'QA-R9-LN'); const rPC = await mkRoute(opPC, 'QA-R9-PC')
// Tenant B
const bOp = (await must(tb.from('operations').select('id').is('deleted_at', null).limit(1).single())).id
const bRoute = await must(tb.from('routes').insert({ operation_id: bOp, nome: 'QA-R9-B-Rota' }).select('id').single()).then((r) => r.id)
const bVeh = await must(tb.from('vehicles').insert({ tenant_id: B, matricula: 'QA-R9-BV1' }).select('id').single()).then((r) => r.id)
const bAcc = (await must(tb.from('bank_accounts').select('id').is('deleted_at', null).limit(1).single())).id
const bDrv = (await sql(`insert into drivers (tenant_id, nome) values ('${B}', 'QA-R9-B-Motorista') returning id`))[0].id
const bMov = await must(tb.from('movements').insert({ tenant_id: B, data: '2026-04-15', conta_id: bAcc, tipo: 'debito', valor: 5, subcategoria: 'outro', descricao: 'QA-R9-B-mov' }).select('id').single()).then((r) => r.id)
const bRec = await must(tb.from('daily_records').insert({ route_id: bRoute, data: '2026-04-15' }).select('id').single()).then((r) => r.id)
const aVeh = (await must(admin.from('vehicle_options').select('id').limit(1).single())).id
const aDrv = (await must(admin.from('driver_options').select('id').limit(1).single())).id
console.log('cenario montado:', { A, B, opLN, opPC, rLN, rPC, bOp, bRoute, bVeh, bAcc, bDrv, bMov, bRec })

// ===================================================================
setArea('F1-F3 referencias de lancamentos (movements_refs)')
const mOK = await must(ins(cont, { descricao: 'QA-R9-base', operation_id: opLN, rota_id: rLN }).single())
ids.mOK = mOK.id
await t('controlo positivo: lancamento coerente (operacao LN + rota da LN) e aceite', async () => { eq([mOK.origem, mOK.estado], ['manual_rota', 'confirmado'], 'mov ' + mOK.id) })
const cross = [
  ['F1 operation_id de outro tenant', { operation_id: bOp }, /operation_id nao pertence/],
  ['F1 conta_id de outro tenant', { conta_id: bAcc }, /conta_id nao pertence/],
  ['F2 motorista_id de outro tenant', { motorista_id: bDrv }, /motorista_id nao pertence/],
  ['F2 lancamento_referencia_id de outro tenant', { lancamento_referencia_id: bMov }, /lancamento_referencia_id nao pertence/],
  ['F3 rota_id de outro tenant (com operacao propria)', { operation_id: opLN, rota_id: bRoute }, /rota nao pertence/],
  ['F3 rota da operacao PC com operacao LN (mesmo tenant, incoerente)', { operation_id: opLN, rota_id: rPC }, /rota nao pertence/],
]
for (const [nome, extra, re] of cross) {
  await t(`${nome}: INSERT recusado (Contabilista)`, async () => { return await refused(ins(cont, { descricao: 'QA-R9-x', ...extra }), re, nome) })
  await t(`${nome}: UPDATE recusado (Contabilista, mov ${mOK.id})`, async () => {
    const patch = { ...extra }
    return await refused(cont.from('movements').update(patch).eq('id', mOK.id).select(), re, nome + ' update')
  })
}
await t('F1-F3 tambem como Super Admin (nao ha excecao): conta B, operacao B, rota incoerente', async () => {
  for (const extra of [{ conta_id: bAcc }, { operation_id: bOp }, { operation_id: opLN, rota_id: rPC }, { motorista_id: bDrv }]) await refused(ins(admin, { descricao: 'QA-R9-sa', ...extra }), /nao pertence/, 'SA ' + Object.keys(extra))
})
await t('F1-F3 sentido inverso: Tenant B (Super Admin B) nao referencia dados do tenant A (operation_id/conta_id/motorista_id/rota_id de A)', async () => {
  const insB = (o) => tb.from('movements').insert({ tenant_id: B, data: '2026-04-15', conta_id: bAcc, tipo: 'debito', valor: 5, subcategoria: 'outro', descricao: 'QA-R9-Bx', ...o }).select()
  for (const extra of [{ operation_id: opLN }, { conta_id: CONTA }, { motorista_id: aDrv }, { operation_id: bOp, rota_id: rLN }, { lancamento_referencia_id: ids.mOK }]) await refused(insB(extra), null, 'B->A ' + Object.keys(extra))
})
await t('F3 update de operacao deixa rota incoerente e recusado (mov ' + mOK.id + ': operation_id -> PC com rota LN)', async () => {
  return await refused(cont.from('movements').update({ operation_id: opPC }).eq('id', mOK.id).select(), /rota nao pertence/, 'operation_id->PC')
})
await t('F3 reclassificar coerente (rota+operacao juntas, LN -> PC) e aceite', async () => {
  const r = await must(cont.from('movements').update({ operation_id: opPC, rota_id: rPC }).eq('id', mOK.id).select('operation_id,rota_id,origem').single())
  eq([r.operation_id, r.rota_id, r.origem], [opPC, rPC, 'manual_rota'], 'mov ' + mOK.id)
})

// ===================================================================
setArea('F4 referencias de registos diarios (records_refs)')
await t('F4 INSERT registo com viatura de outro tenant recusado (Super Admin, Operador)', async () => {
  for (const [n, sb] of [['admin', admin], ['operador', oper]]) {
    const route = n === 'admin' ? rLN : (await must(oper.from('route_options').select('id').limit(1))).at(0)?.id
    await refused(sb.from('daily_records').insert({ route_id: route, data: addDays(today, -200), viatura_id: bVeh }).select(), /viatura_id nao pertence/, n + ' viatura B')
  }
})
await t('F4 INSERT registo com motorista de outro tenant recusado', async () => {
  return await refused(admin.from('daily_records').insert({ route_id: rLN, data: addDays(today, -201), motorista_ids: [aDrv, bDrv] }).select(), /motorista_ids nao pertencem/, 'motorista B')
})
const recOK = await must(admin.from('daily_records').insert({ route_id: rLN, data: addDays(today, -202), viatura_id: aVeh, motorista_ids: [aDrv] }).select('id').single())
await t('F4 controlo positivo: viatura+motorista do proprio tenant aceites (registo ' + recOK.id + ')', async () => 'ok')
await t('F4 UPDATE do registo ' + recOK.id + ' para viatura/motorista de outro tenant recusado', async () => {
  await refused(admin.from('daily_records').update({ viatura_id: bVeh }).eq('id', recOK.id).select(), /viatura_id nao pertence/, 'update viatura')
  await refused(admin.from('daily_records').update({ motorista_ids: [bDrv] }).eq('id', recOK.id).select(), /motorista_ids nao pertencem/, 'update motorista')
})
await t('F4 sentido inverso: Tenant B nao pode ligar viatura/motorista do tenant A ao registo ' + bRec, async () => {
  await refused(tb.from('daily_records').update({ viatura_id: aVeh }).eq('id', bRec).select(), /viatura_id nao pertence/, 'B->A viatura')
  await refused(tb.from('daily_records').update({ motorista_ids: [aDrv] }).eq('id', bRec).select(), /motorista_ids nao pertencem/, 'B->A motorista')
})

// ===================================================================
setArea('F5 tarifario: cada mudanca = snapshot proprio, imutaveis')
const rT = await mkRoute(opLN, 'QA-R9-Tar', { taxa_km: 0.5 })
const snaps = () => must(admin.from('tariff_snapshots').select('id,valid_from,versao,config').eq('route_id', rT).order('valid_from').order('versao'))
const recT = (data, km = 100) => must(admin.from('daily_records').insert({ route_id: rT, data, km, valor_fixo_do_dia: 40 }).select('id,receita_total,tarifa_valid_from').single())
const rOld = await recT(addDays(today, -1))                 // criado ANTES das mudancas do dia, data anterior
await must(admin.from('routes').update({ taxa_km: 0.6 }).eq('id', rT))
const rMid = await recT(today)                              // criado apos a 1.a mudanca do dia
await must(admin.from('routes').update({ taxa_km: 0.7 }).eq('id', rT))
await must(admin.from('routes').update({ taxa_km: 0.8 }).eq('id', rT))
const rNew = await recT(addDays(today, 1))                  // criado no fim, data futura
await t('F5: 3 mudancas no mesmo dia = 3 snapshots novos (versao 1,2,3 em ' + today + ') + o inicial, sem sobrescrever', async () => {
  const s = await snaps()
  eq(s.length, 4, 'n.o snapshots da rota ' + rT)
  eq(s.map((x) => [x.valid_from, x.versao, Number(x.config.taxa_km)]), [['1900-01-01', 1, 0.5], [today, 1, 0.6], [today, 2, 0.7], [today, 3, 0.8]], 'snapshots ' + rT)
})
await t('F5: cada registo mantem a receita do tarifario da sua data/momento (antigo 90, meio 100, novo 120) e nao foi recalculado', async () => {
  const r = await must(admin.from('daily_records').select('id,receita_total').in('id', [rOld.id, rMid.id, rNew.id]))
  const g = (id) => Number(r.find((x) => x.id === id).receita_total)
  eq([g(rOld.id), g(rMid.id), g(rNew.id)], [90, 100, 120], `receitas ${rOld.id} / ${rMid.id} / ${rNew.id}`)
  await must(admin.from('daily_records').update({ comb_valor: 1 }).eq('id', rMid.id))   // campo que nao e input de receita
  eq(Number((await mv0(rMid.id)).receita_total), 100, 'rMid apos editar combustivel')
})
async function mv0(id) { return (await sql(`select receita_total from daily_records where id='${id}'`))[0] }
await t('F5: snapshots imutaveis - UPDATE recusado (utilizador Super Admin e ligacao postgres)', async () => {
  const s = await snaps()
  const r1 = await admin.from('tariff_snapshots').update({ config: { ...s[1].config, taxa_km: 9 } }).eq('id', s[1].id).select()
  ok(r1.error || !r1.data?.length, 'Super Admin alterou snapshot ' + s[1].id)
  let msg = null
  try { sql(`update tariff_snapshots set config = config || '{"taxa_km": 9}'::jsonb where id='${s[1].id}'`) } catch (e) { msg = e.message }
  ok(msg && /imutavel/.test(msg), 'postgres consegue alterar snapshot ' + s[1].id + ': ' + msg)
  eq(Number((await snaps())[1].config.taxa_km), 0.6, 'snapshot ' + s[1].id)
})
await t('F5: reeditar inputs do registo antigo recalcula com o tarifario DA SUA DATA (km 200 em ' + addDays(today, -1) + ' -> 40+100=140)', async () => {
  await must(admin.from('daily_records').update({ km: 200 }).eq('id', rOld.id))
  eq(Number((await mv0(rOld.id)).receita_total), 140, 'rOld ' + rOld.id)
})

// ===================================================================
setArea('F6-F8 frota: um posto = uma viatura aberta; fim exclusivo; vendida/manutencao/apagada libertam')
const slot = (nome) => must(admin.from('fleet_slots').insert({ tenant_id: A, nome }).select('id').single()).then((x) => x.id)
const veh = (m, o = {}) => must(admin.from('vehicles').insert({ tenant_id: A, matricula: m, tipo: 'propria', ...o }).select('id').single()).then((x) => x.id)
const hist = (p) => sql(`select a.id::text id, v.matricula, a.data_inicio::text di, a.data_fim::text df from slot_assignments a join vehicles v on v.id=a.vehicle_id where a.posto_id='${p}' order by a.data_inicio, a.data_fim nulls last, a.id`)
const S1 = await slot('QA-R9-Posto-1'); const V1 = await veh('QA-R9-V1'); const V2 = await veh('QA-R9-V2'); const V3 = await veh('QA-R9-V3')
await must(admin.from('vehicles').update({ posto_id: S1 }).eq('id', V1))
await sql(`update slot_assignments set data_inicio = '${addDays(today, -10)}' where vehicle_id='${V1}'`)   // V1 la esta ha 10 dias (cenario)
await must(admin.from('vehicles').update({ posto_id: S1 }).eq('id', V2))   // substitui V1
await t('F6: atribuir V2 ao posto ocupado por V1 substitui-a (V1 fica sem posto; 1 ocupacao aberta)', async () => {
  const v1 = (await sql(`select posto_id::text p from vehicles where id='${V1}'`))[0].p
  eq(v1, null, 'V1 ' + V1 + ' posto_id')
  const h = await hist(S1); eq(h.filter((x) => x.df === null).map((x) => x.matricula), ['QA-R9-V2'], 'abertas no posto ' + S1)
})
await must(admin.from('vehicles').update({ posto_id: S1 }).eq('id', V3))   // substitui V2
await t('F6/F8: historico do posto ' + S1 + ' = V1 -> V2 -> V3, fim EXCLUSIVO (df da anterior == di da seguinte), sem buracos nem sobreposicao', async () => {
  const h = await hist(S1)
  eq(h.map((x) => x.matricula), ['QA-R9-V1', 'QA-R9-V2', 'QA-R9-V3'], 'sequencia ' + JSON.stringify(h))
  eq([h[0].di, h[0].df, h[1].di, h[1].df, h[2].di, h[2].df], [addDays(today, -10), today, today, today, today, null], 'datas ' + JSON.stringify(h))
  for (let i = 0; i + 1 < h.length; i++) eq(h[i].df, h[i + 1].di, `fronteira ${h[i].matricula}/${h[i + 1].matricula}`)
})
await t('F6: dois ocupantes abertos no mesmo posto impossiveis mesmo por escrita direta (indice unico) e utilizador nao escreve slot_assignments', async () => {
  let msg = null
  try { sql(`insert into slot_assignments (tenant_id, posto_id, vehicle_id, data_inicio) values ('${A}','${S1}','${V1}','${today}')`) } catch (e) { msg = e.message }
  ok(msg && /duplicate key|unique/i.test(msg), 'postgres inseriu 2.a ocupacao aberta no posto ' + S1 + ': ' + msg)
  const r = await admin.from('slot_assignments').insert({ tenant_id: A, posto_id: S1, vehicle_id: V1, data_inicio: today }).select()
  ok(r.error || !r.data?.length, 'Super Admin escreveu em slot_assignments')
})
const freeCase = async (nome, patch, expectFree) => {
  const s = await slot('QA-R9-Posto-' + nome); const v = await veh('QA-R9-F-' + nome, nome === 'dev' ? { tipo: 'alugada', aluguer_custo: 100, aluguer_periodicidade: 'mensal', aluguer_fornecedor: 'QA', aluguer_data_inicio: '2026-01-01' } : {})
  await must(admin.from('vehicles').update({ posto_id: s }).eq('id', v))
  const r = await admin.from('vehicles').update({ ...patch, ...(patch.deleted_at ? {} : {}) }).eq('id', v).select('posto_id')
  if (r.error) throw new Error(`update ${nome}: ${r.error.message}`)
  const now = (await sql(`select posto_id::text p from vehicles where id='${v}'`))[0].p
  const h = await hist(s)
  return { v, s, now, h, expectFree }
}
for (const [nome, patch, free, fid] of [['vendida', { estado: 'vendida' }, true, 'F7'], ['manut', { estado: 'em_manutencao' }, true, 'F7'], ['apag', { deleted_at: new Date().toISOString() }, true, 'F8'], ['dev', { estado: 'devolvida' }, false, 'decisao']]) {
  await t(`${fid}: viatura ${nome} ${free ? 'liberta o posto (posto_id nulo, ocupacao fechada, sem viatura fantasma)' : 'NAO liberta o posto (decisao de produto)'}`, async () => {
    const x = await freeCase(nome, patch, free)
    if (free) { eq(x.now, null, `viatura ${x.v} posto_id`); ok(x.h.length === 1 && x.h[0].df !== null, `ocupacao aberta no posto ${x.s}: ${JSON.stringify(x.h)}`) }
    else { eq(x.now, x.s, `viatura ${x.v} devia manter posto`); ok(x.h.length === 1 && x.h[0].df === null, `ocupacao devia estar aberta no posto ${x.s}`) }
  })
}
await t('F7: em_manutencao -> ativa NAO reatribui sozinha o posto (tem de ser atribuida de novo)', async () => {
  const s = await slot('QA-R9-Posto-back'); const v = await veh('QA-R9-F-back')
  await must(admin.from('vehicles').update({ posto_id: s }).eq('id', v)); await must(admin.from('vehicles').update({ estado: 'em_manutencao' }).eq('id', v)); await must(admin.from('vehicles').update({ estado: 'ativa' }).eq('id', v))
  eq((await sql(`select posto_id::text p from vehicles where id='${v}'`))[0].p, null, 'viatura ' + v)
  await must(admin.from('vehicles').update({ posto_id: s }).eq('id', v))
  eq((await hist(s)).filter((x) => x.df === null).length, 1, 'abertas no posto ' + s)
})
await t('F8: nenhum QA-R9 posto tem intervalos sobrepostos [di,df) nem mais de 1 aberta (SQL)', async () => {
  const bad = await sql(`select a.posto_id::text, a.id::text, b.id::text b from slot_assignments a join slot_assignments b on a.posto_id=b.posto_id and a.id<b.id join fleet_slots s on s.id=a.posto_id
    where s.nome like 'QA-R9-%' and daterange(a.data_inicio, coalesce(a.data_fim,'infinity'),'[)') && daterange(b.data_inicio, coalesce(b.data_fim,'infinity'),'[)') and a.data_inicio <> coalesce(a.data_fim, a.data_inicio + 1) and b.data_inicio <> coalesce(b.data_fim, b.data_inicio + 1)`)
  eq(bad.length, 0, 'sobreposicoes ' + JSON.stringify(bad))
})
await t('Estado global: nenhum posto do tenant tem mais de 1 ocupacao aberta; nenhuma viatura tem 2', async () => {
  const b1 = await sql(`select posto_id::text, count(*)::int n from slot_assignments where data_fim is null group by 1 having count(*)>1`)
  const b2 = await sql(`select vehicle_id::text, count(*)::int n from slot_assignments where data_fim is null group by 1 having count(*)>1`)
  eq([b1.length, b2.length], [0, 0], JSON.stringify([b1, b2]))
})

// ===================================================================
setArea('F9 apagar registos diarios: so Gestor/Super Admin')
const mkRec = (sb, route, d) => must(sb.from('daily_records').insert({ route_id: route, data: d }).select('id').single()).then((r) => r.id)
const opRoute = (await must(oper.from('route_options').select('id,nome').eq('operation_id', opLN))).find((r) => r.nome === 'QA-R9-LN').id
const softDel = (sb, id) => sb.from('daily_records').update({ deleted_at: new Date().toISOString() }).eq('id', id).select('id,deleted_at')
const D1 = await mkRec(oper, opRoute, addDays(today, -300)); const D2 = await mkRec(mot, opRoute, addDays(today, -301))
const D3 = await mkRec(oper, opRoute, addDays(today, -302)); const D4 = await mkRec(oper, opRoute, addDays(today, -303))
await t('F9: Operador NAO apaga o registo que criou (' + D1 + ')', async () => { return await refused(softDel(oper, D1), /apenas Gestor/, 'operador soft delete') })
await t('F9: Motorista NAO apaga o seu registo (' + D2 + ')', async () => { return await refused(softDel(mot, D2), /apenas Gestor|row-level|permission/, 'motorista soft delete') })
await t('F9: Operador NAO restaura/limpa deleted_at nem apaga fisicamente', async () => {
  const r = await oper.from('daily_records').delete().eq('id', D1).select(); ok(r.error || !r.data?.length, 'DELETE fisico aceite ' + D1)
  eq((await sql(`select deleted_at is null a from daily_records where id='${D1}'`))[0].a, true, 'registo ' + D1)
})
await t('F9: Gestor LN apaga (soft) o registo ' + D3 + ' com audit SOFT_DELETE (quem/quando/antes/depois)', async () => {
  const r = await must(softDel(gest, D3)); ok(r[0].deleted_at, 'sem deleted_at')
  const a = (await sql(`select acao, user_id::text u, antes->>'deleted_at' a, depois->>'deleted_at' d from audit_log where tabela='daily_records' and registo_id='${D3}' order by id desc limit 1`))[0]
  eq([a.acao, a.u, a.a === null, a.d !== null], ['SOFT_DELETE', gest.uid, true, true], 'audit ' + D3)
})
await t('F9: Super Admin apaga (soft) o registo ' + D4, async () => { ok((await must(softDel(admin, D4)))[0].deleted_at, 'nao apagou') })
await t('F9: Gestor de outra operacao (PC) nao consegue apagar registo da LN (' + D1 + ')', async () => {
  const gPC = await login('qa.gestor.porto@example.test'); const r = await softDel(gPC, D1); ok(r.error || !r.data?.length, 'gestor PC apagou ' + D1)
})

// ===================================================================
setArea('F10 origem decidida pelo servidor')
for (const [nome, sb] of [['Contabilista', cont], ['Super Admin', admin]]) {
  await t(`F10: ${nome} NAO consegue enviar origem (automatico / manual_geral / manual_rota) no INSERT`, async () => {
    for (const o of ['automatico', 'manual_geral', 'manual_rota']) await refused(ins(sb, { origem: o, descricao: 'QA-R9-origem-' + o }), /origem/, `${nome} origem=${o}`)
    await refused(ins(sb, { origem: 'manual_rota', operation_id: opLN, descricao: 'QA-R9-origem-certa' }), /origem/, `${nome} origem certa`)
  })
}
await t('F10: sem origem, o servidor deriva Manual-Geral (sem operacao) e Manual-Rota (com operacao)', async () => {
  const g = await must(ins(cont, { descricao: 'QA-R9-geral' }).single()); const r = await must(ins(admin, { descricao: 'QA-R9-rota', operation_id: opLN }).single())
  eq([g.origem, r.origem], ['manual_geral', 'manual_rota'], `movs ${g.id} / ${r.id}`); ids.mG = g.id; ids.mR = r.id
})
await t('F10: UPDATE de origem para um valor DIFERENTE recusado (Contabilista e Super Admin); igual ao atual e no-op', async () => {
  for (const [n, sb] of [['cont', cont], ['admin', admin]]) for (const o of ['automatico', 'manual_rota']) await refused(sb.from('movements').update({ origem: o }).eq('id', ids.mG).select(), /origem/, `${n} update origem=${o} mov ${ids.mG}`)
  eq((await mv(ids.mG)).origem, 'manual_geral', 'origem mov ' + ids.mG)
})
await t('F10: reclassificar (operacao) num manual acompanha a origem (Geral <-> Rota)', async () => {
  const a = await must(cont.from('movements').update({ operation_id: opLN }).eq('id', ids.mG).select('origem').single()); eq(a.origem, 'manual_rota', 'mov ' + ids.mG)
  const b = await must(cont.from('movements').update({ operation_id: null, rota_id: null }).eq('id', ids.mG).select('origem').single()); eq(b.origem, 'manual_geral', 'mov ' + ids.mG)
})

// ===================================================================
setArea('Novos: registo_id, custo_tipo, versao_anterior_id, validado_por, validado_em so o servidor escreve')
const recForged = await mkRec(admin, rLN, addDays(today, -400))
const forged = { registo_id: recForged, custo_tipo: 'combustivel', versao_anterior_id: ids.mG, validado_por: cont.uid, validado_em: new Date().toISOString() }
for (const [nome, sb] of [['Contabilista', cont], ['Super Admin', admin]]) {
  await t(`${nome}: INSERT com cada campo gerido pelo servidor recusado (5 campos)`, async () => {
    for (const [k, v] of Object.entries(forged)) await refused(ins(sb, { descricao: 'QA-R9-forjado-' + k, [k]: v }), /geridos pelo sistema/, `${nome} insert ${k}`)
  })
  await t(`${nome}: UPDATE de cada campo gerido pelo servidor recusado (mov ${ids.mG})`, async () => {
    for (const [k, v] of Object.entries(forged)) await refused(sb.from('movements').update({ [k]: v }).eq('id', ids.mG).select(), /geridos pelo sistema/, `${nome} update ${k}`)
    const m = await mv(ids.mG); eq([m.registo_id, m.custo_tipo, m.versao_anterior_id, m.validado_por, m.validado_em], [null, null, null, null, null], 'mov ' + ids.mG)
  })
}
// transferencia + alocacoes (sempre Pendente)
const T = await must(ins(cont, { valor: 100, subcategoria: 'transferencia_distribuicao', pessoa_responsavel: 'QA-R9-Joao', data: '2026-04-20', descricao: 'QA-R9-transferencia' }).single()); ids.T = T.id
const alloc = (sb, o) => ins(sb, { valor: 40, pessoa_responsavel: 'QA-R9-Joao', operation_id: opLN, rota_id: rLN, lancamento_referencia_id: T.id, data: '2026-04-20', ...o })
const al1 = await must(alloc(cont, { descricao: 'QA-R9-alloc-1' }).single()); ids.al1 = al1.id
const al2 = await must(alloc(admin, { descricao: 'QA-R9-alloc-2' }).single()); ids.al2 = al2.id
await t('Forjar validado_por/validado_em num UPDATE de estado recusado (Contabilista -> alocacao ' + al1.id + ' segue Pendente)', async () => {
  await refused(cont.from('movements').update({ estado: 'confirmado', validado_por: admin.uid }).eq('id', al1.id).select(), /geridos pelo sistema/, 'estado + validado_por outro')
  await refused(cont.from('movements').update({ estado: 'confirmado', validado_por: cont.uid, validado_em: '2020-01-01T00:00:00Z' }).eq('id', al1.id).select(), /geridos pelo sistema/, 'estado + validado_por/em proprios')
  const m = await mv(al1.id); eq([m.estado, m.validado_por, m.validado_em], ['pendente', null, null], 'alocacao ' + al1.id)
})
await t('Forjar validado_por num UPDATE de estado recusado tambem para Super Admin (alocacao ' + al2.id + ')', async () => {
  await refused(admin.from('movements').update({ estado: 'confirmado', validado_por: cont.uid }).eq('id', al2.id).select(), /geridos pelo sistema/, 'SA estado + validado_por')
  eq((await mv(al2.id)).estado, 'pendente', 'alocacao ' + al2.id)
})

// ===================================================================
setArea('Fluxos legitimos')
await t('Validar (Contabilista): alocacao ' + al1.id + ' -> Confirmado com validado_por = quem validou, validado_em e audit', async () => {
  const v = await must(cont.from('movements').update({ estado: 'confirmado' }).eq('id', al1.id).select('estado,validado_por,validado_em').single())
  eq([v.estado, v.validado_por, !!v.validado_em], ['confirmado', cont.uid, true], 'alocacao ' + al1.id)
  const a = (await sql(`select user_id::text u, antes->>'estado' a, depois->>'estado' d from audit_log where tabela='movements' and registo_id='${al1.id}' order by id desc limit 1`))[0]
  eq([a.u, a.a, a.d], [cont.uid, 'pendente', 'confirmado'], 'audit ' + al1.id)
})
await t('Validar (Super Admin): alocacao ' + al2.id + ' -> Confirmado e reverter -> Pendente limpa validado_por', async () => {
  const v = await must(admin.from('movements').update({ estado: 'confirmado' }).eq('id', al2.id).select('validado_por').single()); eq(v.validado_por, admin.uid, 'validar ' + al2.id)
  const r = await must(admin.from('movements').update({ estado: 'pendente' }).eq('id', al2.id).select('validado_por,validado_em').single()); eq([r.validado_por, r.validado_em], [null, null], 'reverter ' + al2.id)
})
await t('Reclassificar (rota) alocacao validada mantem validacao; mudar valor tira-a (alocacao ' + al1.id + ')', async () => {
  const rLN2 = await mkRoute(opLN, 'QA-R9-LN2')
  const a = await must(cont.from('movements').update({ rota_id: rLN2 }).eq('id', al1.id).select('estado,validado_por').single()); eq([a.estado, a.validado_por], ['confirmado', cont.uid], 'reclassificar ' + al1.id)
  const b = await must(cont.from('movements').update({ valor: 41 }).eq('id', al1.id).select('estado,validado_por').single()); eq([b.estado, b.validado_por], ['pendente', null], 'mudar valor ' + al1.id)
})
await t('Registo diario: Gestor valida (validado_por = gestor) e Operador nao valida', async () => {
  const id = await mkRec(oper, opRoute, addDays(today, -410))
  await refused(oper.from('daily_records').update({ status: 'validado' }).eq('id', id).select(), /apenas Gestor/, 'operador valida ' + id)
  const v = await must(gest.from('daily_records').update({ status: 'validado' }).eq('id', id).select('status,validado_por').single()); eq([v.status, v.validado_por], ['validado', gest.uid], 'registo ' + id)
})
await t('Versionamento de automaticos continua: submeter -> gera; editar custo -> nova versao ligada por versao_anterior_id (servidor), antiga soft-deleted', async () => {
  const id = await mkRec(admin, rLN, addDays(today, -420)); await must(admin.from('daily_records').update({ comb_valor: 30 }).eq('id', id))
  eq((await sql(`select count(*)::int n from movements where registo_id='${id}'`))[0].n, 0, 'rascunho gerou lancamento ' + id)
  await must(admin.from('daily_records').update({ status: 'submetido' }).eq('id', id))
  await must(admin.from('daily_records').update({ comb_valor: 150 }).eq('id', id))
  const all = await sql(`select id::text, valor::float v, estado::text e, origem::text o, custo_tipo::text ct, versao_anterior_id::text va, deleted_at is not null del, motivo_apagado from movements where registo_id='${id}' order by created_at, id`)
  eq(all.length, 2, 'versoes do registo ' + id + ' ' + JSON.stringify(all))
  eq([all[0].del, all[0].motivo_apagado, all[1].va, all[1].e, all[1].o, all[1].ct, all[1].del], [true, 'substituído por edição', all[0].id, 'pendente', 'automatico', 'combustivel', false], 'versoes ' + JSON.stringify(all))
  // e o Contabilista continua sem poder mexer nos campos do automatico, mas pode validar/reclassificar
  await refused(cont.from('movements').update({ valor: 1 }).eq('id', all[1].id).select(), /automatico so pode ser alterado/, 'contabilista valor automatico')
  await refused(cont.from('movements').update({ custo_tipo: 'portagens' }).eq('id', all[1].id).select(), /geridos pelo sistema/, 'contabilista custo_tipo automatico')
  const v = await must(cont.from('movements').update({ estado: 'confirmado' }).eq('id', all[1].id).select('validado_por').single()); eq(v.validado_por, cont.uid, 'validar automatico ' + all[1].id)
})
await t('Propagacao de alocacoes continua (servidor escreve registo_id): registo existente -> registo_id + linha de custo; sem registo -> por ligar e anexa quando o registo nasce', async () => {
  const d1 = '2026-04-21'; const d2 = '2026-04-22'
  const recA = await mkRec(admin, rLN, d1)
  const T2 = await must(ins(cont, { valor: 100, subcategoria: 'transferencia_distribuicao', pessoa_responsavel: 'QA-R9-Maria', data: d1, descricao: 'QA-R9-T2' }).single())
  const x1 = await must(ins(cont, { valor: 30, pessoa_responsavel: 'QA-R9-Maria', operation_id: opLN, rota_id: rLN, lancamento_referencia_id: T2.id, data: d1, descricao: 'QA-R9-p1' }).single())
  const x2 = await must(ins(cont, { valor: 20, pessoa_responsavel: 'QA-R9-Maria', operation_id: opLN, rota_id: rLN, lancamento_referencia_id: T2.id, data: d2, descricao: 'QA-R9-p2' }).single())
  const m1 = await mv(x1.id), m2 = await mv(x2.id)
  eq([m1.estado, m1.registo_id, m2.estado, m2.registo_id], ['pendente', recA, 'pendente', null], `alocacoes ${x1.id} / ${x2.id}`)
  eq((await sql(`select count(*)::int n from daily_records where route_id='${rLN}' and data='${d2}'`))[0].n, 0, 'criou registo indevidamente')
  const recB = await mkRec(admin, rLN, d2)
  eq((await mv(x2.id)).registo_id, recB, 'anexar ' + x2.id)
  eq((await sql(`select count(*)::int n from daily_record_costs where movimento_id in ('${x1.id}','${x2.id}') and deleted_at is null`))[0].n, 2, 'linhas de custo')
})

// ===================================================================
setArea('Sobre-alocacao (sinalizada no servidor, nao bloqueada)')
const alloc3 = await must(alloc(cont, { valor: 50, descricao: 'QA-R9-alloc-3' }).single()); ids.al3 = alloc3.id   // 41 + 40 + 50 = 131 > 100 (al1 41, al2 40, al3 50)
await t('Sobre-alocacao aceite (nao bloqueada) e visivel na vista fund_transfer_status como "over" (Contabilista, Super Admin e Gestor sem acesso)', async () => {
  const v = await must(cont.from('fund_transfer_status').select('*').eq('id', T.id).single())
  eq([Number(v.valor), Number(v.alocado), Number(v.diferenca), v.estado], [100, 131, -31, 'over'], 'transferencia ' + T.id)
  const va = await must(admin.from('fund_transfer_status').select('estado').eq('id', T.id).single()); eq(va.estado, 'over', 'SA')
  const vg = await gest.from('fund_transfer_status').select('id').eq('id', T.id); ok(vg.error || !vg.data?.length, 'Gestor le fund_transfer_status ' + T.id)
})
await t('Notificacao fund_over_allocated enviada a TODOS os Super Admin e Contabilistas (e mais ninguem) da transferencia ' + T.id, async () => {
  const n = await sql(`select p.email from notifications n join profiles p on p.id=n.user_id where n.tipo='fund_over_allocated' and n.payload->>'movement_id'='${T.id}' order by 1`)
  const exp = await sql(`select p.email from profiles p join user_roles r on r.user_id=p.id where p.tenant_id='${A}' and r.role in ('super_admin','contabilista') and p.deleted_at is null group by 1 order by 1`)
  eq(n.map((x) => x.email), exp.map((x) => x.email), 'destinatarios')
  const pl = (await sql(`select payload from notifications where tipo='fund_over_allocated' and payload->>'movement_id'='${T.id}' limit 1`))[0].payload
  eq([Number(pl.valor), Number(pl.alocado), Number(pl.excesso)], [100, 131, 31], 'payload')
})
await t('Corrigir/diminuir a alocacao nao gera novo alerta (so agrava); a vista deixa de estar "over" quando o total cabe', async () => {
  const before = (await sql(`select count(*)::int n from notifications where tipo='fund_over_allocated' and payload->>'movement_id'='${T.id}'`))[0].n
  await must(cont.from('movements').update({ valor: 10 }).eq('id', ids.al3).select('id'))   // 41+40+10=91
  eq((await sql(`select count(*)::int n from notifications where tipo='fund_over_allocated' and payload->>'movement_id'='${T.id}'`))[0].n, before, 'notificacoes novas')
  eq((await must(cont.from('fund_transfer_status').select('estado').eq('id', T.id).single())).estado, 'under', 'estado apos corrigir')
})

save('./results-09.json')
console.log('\nIDs:', JSON.stringify({ ...ids, opLN, opPC, rLN, rPC, rT, S1, V1, V2, V3, bRoute, bVeh, bDrv, bMov, bRec, D1, D2, D3, D4, recOK: recOK.id, recForged, T: T.id, al1: al1.id, al2: al2.id }))
