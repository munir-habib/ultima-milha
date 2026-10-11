// 3.a ronda (0019/0020) ao nivel do servidor, sempre como utilizadores reais (RLS); sql = so montagem/verificacao.
//  R1 apagar alocacao propagada | R2 relink so por rota/data | R3 sem_registo_previsto | R4 alertas (sem timeout)
//  R5 request_cost_correction (-1/0, registo de origem) + RPC | R6 movement_pending (dedupe por valor) | R7 RLS apos 0020
import { ctx, T, loginAll, users, t, setCaso, setArea, eq, ok, must, denied, sql, mvIns, mv, mkRec, autos, dump, savectx } from './h.mjs'
import { anonClient } from '../lib.mjs'
await loginAll()
const { admin, cont, gest, oper, mot, aud, audacc, tb } = users
const ids = (ctx.c21 = ctx.c21 ?? {})
const transfer = (o) => must(mvIns(cont, { subcategoria: 'transferencia_distribuicao', pessoa_responsavel: 'QA-C-R3', data: '2026-05-01', valor: 9000, ...o, descricao: 'QA-C-r3-' + (o.descricao ?? 'tr') }).single())
const alloc = (tr, o) => must(mvIns(cont, { subcategoria: 'outro', pessoa_responsavel: 'QA-C-R3', lancamento_referencia_id: tr.id, data: tr.data, operation_id: ctx.opLN, rota_id: ctx.R1, ...o, descricao: 'QA-C-r3-' + (o.descricao ?? 'al') }).single())
const lines = (mid) => sql(`select id, record_id, valor::float v, categoria, deleted_at from daily_record_costs where movimento_id='${mid}' order by created_at, id`)
const rec = async (id) => (await sql(`select status, validado_por, deleted_at from daily_records where id='${id}'`))[0]
const reopened = (r) => sql(`select user_id from notifications where tipo='record_reopened' and payload->>'record_id'='${r}' order by 1`)
const nRecords = async (route, d) => (await sql(`select count(*)::int n from daily_records where route_id='${route}' and data='${d}' and deleted_at is null`))[0].n
const dayOff = async (n) => (await sql(`select (app.today() + (${n}))::text d`))[0].d
const del = (sb, id, motivo = 'QA-C r3') => sb.from('movements').update({ deleted_at: new Date().toISOString(), motivo_apagado: motivo }).eq('id', id).select()
const flag = (sb, id, v) => sb.from('movements').update({ sem_registo_previsto: v }).eq('id', id).select('id,sem_registo_previsto,registo_id')
const recipients = (roles) => sql(`select distinct p.id, p.email from profiles p join user_roles r on r.user_id=p.id where p.tenant_id='${T}' and p.deleted_at is null and r.role in (${roles.map((x) => `'${x}'`).join(',')})`)
const tr = await transfer({ descricao: 'base' })

// =================== R1: apagar (soft delete) uma alocacao propagada ===================
setArea('R1 - apagar alocacao propagada'); setCaso('R1')
await t('R1.1 Super Admin apaga alocacao propagada: a linha de custo que gerou fica soft-deleted (audit); a linha de OUTRA alocacao do mesmo registo mantem-se; o registo Rascunho nao muda', async () => {
  const D = '2026-05-10'; const r = await mkRec(oper, ctx.R1, D)
  const a = await alloc(tr, { valor: 61, data: D, descricao: 'r11a' }), b = await alloc(tr, { valor: 62, data: D, descricao: 'r11b' }); ids.r11 = [a.id, b.id]
  eq([(await mv(a.id)).registo_id, (await mv(b.id)).registo_id], [r, r], 'propagacao'); const La = (await lines(a.id))[0]
  await denied(del(cont, a.id), 'Contabilista apaga alocacao')
  await must(del(admin, a.id))
  const ma = await mv(a.id); ok(ma.deleted_at && ma.motivo_apagado === 'QA-C r3', 'alocacao nao apagada ' + a.id)
  const la = await lines(a.id); eq([la.length, !!la[0].deleted_at], [1, true], 'linha da alocacao apagada ' + a.id)
  eq((await lines(b.id)).filter((l) => !l.deleted_at).length, 1, 'linha da outra alocacao ' + b.id)
  const act = (await sql(`select coalesce(sum(valor),0)::float s from daily_record_costs where record_id='${r}' and deleted_at is null`))[0].s; eq(act, 62, 'custos ativos do registo ' + r)
  const au = await must(admin.from('audit_log').select('user_id,acao').eq('tabela', 'daily_record_costs').eq('registo_id', La.id).eq('acao', 'SOFT_DELETE')); eq([au.length, au[0]?.user_id], [1, admin.uid], 'audit da linha ' + La.id)
  eq((await rec(r)).status, 'rascunho', 'registo ' + r); eq(await nRecords(ctx.R1, D), 1, 'registos R1/' + D)
})
await t('R1.2 registo VALIDADO pelo Gestor: apagar a alocacao (Super Admin) reverte para Submetido (validado_por limpo) e o Gestor recebe record_reopened; quem apagou nao', async () => {
  const D = '2026-05-11'; const r = await mkRec(oper, ctx.R1, D); const a = await alloc(tr, { valor: 63, data: D, descricao: 'r12' }); ids.r12 = a.id
  await must(gest.from('daily_records').update({ status: 'validado' }).eq('id', r).select('id')); eq((await rec(r)).validado_por, gest.uid, 'validado por gestor ' + r)
  await must(del(admin, a.id))
  const x = await rec(r); eq([x.status, x.validado_por], ['submetido', null], 'registo ' + r); eq((await reopened(r)).map((y) => y.user_id), [gest.uid], 'record_reopened ' + r)
  eq((await lines(a.id)).filter((l) => !l.deleted_at).length, 0, 'linha ativa ' + a.id)
})
await t('R1.3 validador = quem apaga (Super Admin): reverte mas nao se auto-notifica', async () => {
  const D = '2026-05-12'; const r = await mkRec(oper, ctx.R1, D); const a = await alloc(tr, { valor: 64, data: D, descricao: 'r13' })
  await must(admin.from('daily_records').update({ status: 'validado' }).eq('id', r).select('id')); await must(del(admin, a.id))
  eq([(await rec(r)).status, (await reopened(r)).length], ['submetido', 0], 'registo ' + r)
})
await t('R1.4 alocacao "por ligar" apagada: nada a limpar (sem erro, sem registo criado, sem linhas)', async () => {
  const D = '2026-05-13'; const a = await alloc(tr, { valor: 65, data: D, rota_id: ctx.R2, descricao: 'r14' }); eq((await mv(a.id)).registo_id, null, 'por ligar ' + a.id)
  await must(del(admin, a.id)); eq([await nRecords(ctx.R2, D), (await lines(a.id)).length, !!(await mv(a.id)).deleted_at], [0, 0, true], 'estado ' + a.id)
})
await t('R1.5 apagar a alocacao e depois criar o registo dessa rota+data: a alocacao apagada NAO se anexa', async () => {
  const D = '2026-05-15'; const a = await alloc(tr, { valor: 66, data: D, descricao: 'r15' }); await must(del(admin, a.id))
  const r = await mkRec(oper, ctx.R1, D); eq([(await lines(a.id)).length, (await sql(`select count(*)::int n from daily_record_costs where record_id='${r}' and deleted_at is null`))[0].n], [0, 0], 'anexou alocacao apagada ' + a.id)
})

// =================== R2: o relink so age se a ROTA ou a DATA mudam ===================
setArea('R2 - relink so por rota/data'); setCaso('R2')
await t('R2.1 mudar so a OPERACAO (rota e data iguais) nao desliga a linha nem desvalida o registo Validado', async () => {
  const D = '2026-05-16'; const r = await mkRec(oper, ctx.R1, D); const a = await alloc(tr, { valor: 67, data: D, descricao: 'r21' }); ids.r21 = a.id
  await must(gest.from('daily_records').update({ status: 'validado' }).eq('id', r).select('id'))
  const before = await lines(a.id); const res = await cont.from('movements').update({ operation_id: null }).eq('id', a.id).select('id,operation_id,rota_id,registo_id')
  if (res.error) return `operacao->nula com rota mantida e recusada pelo servidor (${res.error.message}); relink nao testavel por este caminho`
  const m = await mv(a.id); const x = await rec(r)
  eq([m.registo_id, x.status, (await lines(a.id)).filter((l) => !l.deleted_at).length, (await reopened(r)).length], [r, 'validado', 1, 0], `alocacao ${a.id} registo ${r}: mudar so a operacao nao pode desligar/desvalidar`)
})
await t('R2.2 controlo: mudar a DATA de uma alocacao propagada a registo Validado desliga a linha, reverte o registo e avisa o validador', async () => {
  const D = '2026-05-17'; const r = await mkRec(oper, ctx.R1, D); const a = await alloc(tr, { valor: 68, data: D, descricao: 'r22' })
  await must(gest.from('daily_records').update({ status: 'validado' }).eq('id', r).select('id')); await must(cont.from('movements').update({ data: '2026-05-18' }).eq('id', a.id).select())
  eq([(await rec(r)).status, (await reopened(r)).map((y) => y.user_id), (await mv(a.id)).registo_id], ['submetido', [gest.uid], null], `registo ${r} alocacao ${a.id}`)
})

// =================== R3: "sem registo previsto" ===================
setArea('R3 - sem registo previsto'); setCaso('R3')
const dNo = '2026-05-20'
let un
await t('R3.1 Contabilista marca uma alocacao realmente "por ligar" (debito, operacao+rota, sem registo); marca-se e desmarca-se (reversivel); Super Admin tambem; audit', async () => {
  un = await alloc(tr, { valor: 70, data: dNo, descricao: 'r31' }); ids.r31 = un.id; eq((await mv(un.id)).registo_id, null, 'por ligar')
  const a0 = (await sql(`select count(*)::int n from audit_log where tabela='movements' and registo_id='${un.id}'`))[0].n
  let r = await must(flag(cont, un.id, true)); eq(r[0].sem_registo_previsto, true, 'marcada ' + un.id)
  r = await must(flag(cont, un.id, false)); eq(r[0].sem_registo_previsto, false, 'desmarcada ' + un.id)
  r = await must(flag(admin, un.id, true)); eq(r[0].sem_registo_previsto, true, 'marcada por Super Admin'); await must(flag(admin, un.id, false))
  const a1 = (await sql(`select count(*)::int n from audit_log where tabela='movements' and registo_id='${un.id}'`))[0].n; eq(a1 - a0, 4, 'entradas de audit das 4 mudancas ' + un.id)
  const m = await mv(un.id); eq([m.estado, m.sem_registo_previsto], ['pendente', false], 'estado nao mexe')
})
await t('R3.2 recusado noutros casos: credito, sem rota (Geral), ja ligada, manual, automatico, transferencia; e o cliente nao cria uma nova ja marcada', async () => {
  const cr = await alloc(tr, { valor: 71, data: dNo, tipo: 'credito', descricao: 'r32cr' }); const ge = await alloc(tr, { valor: 72, data: dNo, rota_id: null, operation_id: null, descricao: 'r32ge' })
  const D2 = '2026-05-21'; const r = await mkRec(oper, ctx.R1, D2); const li = await alloc(tr, { valor: 73, data: D2, descricao: 'r32li' }); eq((await mv(li.id)).registo_id, r, 'ligada')
  const man = await must(mvIns(cont, { descricao: 'QA-C-r3-r32man' }).single()); const rA = await mkRec(oper, ctx.R2, D2, { comb_valor: 30, status: 'submetido' }); const au = (await autos(rA, 'combustivel'))[0]
  for (const [n, id] of [['credito', cr.id], ['Geral', ge.id], ['ligada', li.id], ['manual', man.id], ['automatico', au.id], ['transferencia', tr.id]]) {
    const x = await flag(cont, id, true); ok(x.error, `${n} (${id}) aceitou sem_registo_previsto`); eq((await mv(id)).sem_registo_previsto, false, `flag ficou ${n} ${id}`)
  }
  const ins = await mvIns(cont, { subcategoria: 'outro', lancamento_referencia_id: tr.id, operation_id: ctx.opLN, rota_id: ctx.R2, data: '2026-05-22', sem_registo_previsto: true, descricao: 'QA-C-r3-r32ins' }); ok(ins.error, 'INSERT ja marcada aceite ' + JSON.stringify(ins.data?.[0]?.id))
  const ins2 = await mvIns(admin, { subcategoria: 'outro', lancamento_referencia_id: tr.id, operation_id: ctx.opLN, rota_id: ctx.R2, data: '2026-05-22', sem_registo_previsto: true, descricao: 'QA-C-r3-r32ins2' }); ok(ins2.error, 'INSERT ja marcada (Super Admin) aceite ' + JSON.stringify(ins2.data?.[0]?.id))
  return 'mensagem: ' + (await flag(cont, cr.id, true)).error.message.slice(0, 120)
})
await t('R3.3 so Contabilista/Super Admin marcam: Operador, Gestor, Motorista, Auditor (com e sem accounting_read) recusados (0 linhas/erro); Super Admin de outro tenant recusado', async () => {
  for (const [n, sb] of [['operador', oper], ['gestor', gest], ['motorista', mot], ['auditor', aud], ['auditor.acc', audacc], ['tenantB', tb]]) await denied(flag(sb, un.id, true), n + ' marcou ' + un.id)
  eq((await mv(un.id)).sem_registo_previsto, false, 'flag ' + un.id)
})
await t('R3.4 mudar a ROTA ou a DATA de uma marcada limpa a marca (volta a "por ligar"); mudar so valor/descricao nao', async () => {
  await must(flag(cont, un.id, true)); await must(cont.from('movements').update({ valor: 74, descricao: 'QA-C-r3-r34' }).eq('id', un.id).select())
  eq((await mv(un.id)).sem_registo_previsto, true, 'valor/descricao nao limpam ' + un.id)
  await must(cont.from('movements').update({ data: '2026-05-23' }).eq('id', un.id).select()); eq((await mv(un.id)).sem_registo_previsto, false, 'data limpa a marca ' + un.id)
  await must(flag(cont, un.id, true)); await must(cont.from('movements').update({ rota_id: ctx.R2 }).eq('id', un.id).select()); const m = await mv(un.id); eq([m.sem_registo_previsto, m.registo_id], [false, null], 'rota limpa a marca ' + un.id)
})
await t('R3.5 (observacao) alocacao marcada e depois o registo da rota+data e criado: o que acontece?', async () => {
  const D = '2026-05-24'; const a = await alloc(tr, { valor: 75, data: D, descricao: 'r35' }); await must(flag(cont, a.id, true)); const r = await mkRec(oper, ctx.R1, D); const m = await mv(a.id)
  return `alocacao ${a.id} marcada; apos criar registo ${r}: registo_id=${m.registo_id}, sem_registo_previsto=${m.sem_registo_previsto}, linhas ativas=${(await lines(a.id)).filter((l) => !l.deleted_at).length}`
})

// =================== R4: alertas (sem timeout automatico) ===================
setArea('R4 - allocation_unlinked'); setCaso('R4')
const al = {}
await t('R4.1 allocation_unlinked: por ligar 3+ dias e NAO marcada alerta; marcada nao; rota apagada nao; 100 dias antiga (sem timeout) continua a alertar; semana seguinte repete; desmarcar volta a alertar', async () => {
  const d10 = await dayOff(-10), d100 = await dayOff(-100)
  const trA = await transfer({ valor: 9000, data: d100, descricao: 'r4', pessoa_responsavel: 'QA-C-R4' })
  const rz = (await must(admin.from('routes').insert({ operation_id: ctx.opLN, nome: 'QA-C-RD', tarifa_por_estado: false, tarifa_valor_fixo: true, tarifa_por_distancia: false, valor_fixo_default: 40 }).select('id').single())).id
  const mk = async (k, o) => { al[k] = (await alloc(trA, { valor: 12, pessoa_responsavel: 'QA-C-R4', descricao: 'r4-' + k, ...o })).id }
  await mk('open', { data: d10 }); await mk('marked', { data: d10, rota_id: ctx.R2 }); await mk('delroute', { data: d10, rota_id: rz }); await mk('old100', { data: d100 })
  await must(flag(cont, al.marked, true)); await must(admin.from('routes').update({ deleted_at: new Date().toISOString() }).eq('id', rz).select('id'))
  const cnt = async (k) => (await sql(`select count(*)::int n from notifications where tipo='allocation_unlinked' and payload->>'movement_id'='${al[k]}'`))[0].n
  const exp = (await sql(`select count(distinct u)::int n from (select o u from app.op_managers('${ctx.opLN}') o union select c from app.tenant_users('${T}', array['super_admin','contabilista']::app_role[]) c) x`))[0].n
  await sql('select app.run_alerts(false)')
  eq([await cnt('open'), await cnt('marked'), await cnt('delroute'), await cnt('old100')], [exp, 0, 0, exp], `notificacoes por alocacao (open=${al.open} marked=${al.marked} delroute=${al.delroute} old100=${al.old100})`)
  await sql('select app.run_alerts(false)'); eq(await cnt('open'), exp, 'mesma semana nao repete ' + al.open)
  let wk = 0; const oldkeys = () => sql(`update notifications set dedupe_key = 'unlinked:' || (payload->>'movement_id') || ':2000-' || '${++wk}' where tipo='allocation_unlinked' and dedupe_key not like '%:2000-%' and payload->>'movement_id' in (${Object.values(al).map((x) => `'${x}'`).join(',')})`)
  await oldkeys(); await sql('select app.run_alerts(false)'); eq([await cnt('open'), await cnt('old100'), await cnt('marked')], [exp * 2, exp * 2, 0], 'semana seguinte volta a alertar (sem timeout) / marcada continua calada')
  await must(flag(cont, al.open, true)); await oldkeys(); await sql('select app.run_alerts(false)'); eq([await cnt('open'), await cnt('old100')], [exp * 2, exp * 3], 'marcar a open cala-a; old100 continua ' + al.open)
  await must(flag(cont, al.open, false)); await oldkeys(); await sql('select app.run_alerts(false)'); eq(await cnt('open'), exp * 3, 'desmarcada volta a alertar ' + al.open)
  return `destinatarios por alerta: ${exp}`
})

// =================== R5: request_cost_correction ===================
setArea('R5 - pedir correcao'); setCaso('R5')
await t('R5.1 -1 = ninguem a avisar (Super Admin sem Gestor atribuido), >=1 quando avisa, 0 = ja pedido hoje', async () => {
  const tenant = T; const op = (await must(admin.from('operations').insert({ tenant_id: tenant, nome: 'QA-C-OpZ', valores_estado: { entregues: 1, devolucoes: 0, recolhas: 0, canceladas: 0, transitadas: 0, pendentes_entrega: 0, pendentes_recolha: 0 } }).select('id').single())).id
  const rz = (await must(admin.from('routes').insert({ operation_id: op, nome: 'QA-C-RZ', tarifa_por_estado: false, tarifa_valor_fixo: true, tarifa_por_distancia: false, valor_fixo_default: 40 }).select('id').single())).id
  const r = await mkRec(admin, rz, '2026-05-25', { comb_valor: 150, status: 'submetido' }); const a = (await autos(r, 'combustivel'))[0].id; ids.r51 = a
  const sa = (await sql(`select count(*)::int n from app.op_managers('${op}') o where o <> '${admin.uid}'`))[0].n; eq(sa, 0, 'a operacao QA-C-OpZ nao devia ter outros gestores/super admins')
  const r1 = await admin.rpc('request_cost_correction', { p_movement: a }); ok(!r1.error, r1.error?.message); eq(r1.data, -1, 'Super Admin sem ninguem a avisar ' + a)
  const r2 = await admin.rpc('request_cost_correction', { p_movement: a }); eq(r2.data, -1, 'repetir continua -1')
  eq((await sql(`select count(*)::int n from notifications where tipo='auto_cost_disputed' and payload->>'movement_id'='${a}'`))[0].n, 0, 'notificacoes ' + a)
  const c1 = await cont.rpc('request_cost_correction', { p_movement: a }); ok(!c1.error && c1.data >= 1, 'Contabilista devia avisar o Super Admin: ' + JSON.stringify(c1)); const c2 = await cont.rpc('request_cost_correction', { p_movement: a }); eq(c2.data, 0, '2.o pedido no mesmo dia = 0')
  ctx.opZ = op; ctx.RZ = rz; return `Contabilista: ${c1.data}, repetido: ${c2.data}`
})
await t('R5.2 automatico RECLASSIFICADO (outra rota da mesma operacao; e outra OPERACAO): payload leva rota/data do REGISTO; avisados = gestores da operacao do registo (nao da de destino)', async () => {
  const D = '2026-05-26'; const r = await mkRec(oper, ctx.R1, D, { comb_valor: 30, status: 'submetido' }); const a = (await autos(r, 'combustivel'))[0].id
  await must(cont.from('movements').update({ operation_id: ctx.opPC, rota_id: ctx.RP }).eq('id', a).select()); const n = await cont.rpc('request_cost_correction', { p_movement: a, p_note: 'QA-C' }); ok(!n.error && n.data >= 1, JSON.stringify(n))
  const got = await sql(`select p.email, n.payload from notifications n join profiles p on p.id=n.user_id where n.tipo='auto_cost_disputed' and n.payload->>'movement_id'='${a}' order by 1`)
  eq([got[0].payload.route_id, got[0].payload.data, got[0].payload.registo_id], [ctx.R1, D, r], 'payload ' + a); ok(got.some((g) => g.email === 'qa.gestor@example.test'), 'gestor LN em falta'); ok(!got.some((g) => g.email === 'qa.gestor.porto@example.test'), 'gestor Porto avisado indevidamente')
  const r2 = await cont.rpc('request_cost_correction', { p_movement: a }); eq(r2.data, 0, '2.o = 0')
  ids.r52 = { a, r, D }
})
await t('R5.3 RPC movement_origin_record: Contabilista/Super Admin/Auditor com accounting_read veem rota DO REGISTO, data e estado; manual sem registo = vazio; Gestor/Operador/Motorista/Auditor sem acc/tenant B/anon nada', async () => {
  const { a, r, D } = ids.r52; const exp = (await sql(`select ro.nome, d.status::text s from daily_records d join routes ro on ro.id=d.route_id where d.id='${r}'`))[0]
  for (const [n, sb] of [['cont', cont], ['admin', admin], ['audacc', audacc]]) { const x = await must(sb.rpc('movement_origin_record', { p_movement: a })); eq([x.length, x[0]?.route_id, x[0]?.route, x[0]?.data, x[0]?.status], [1, ctx.R1, exp.nome, D, exp.s], n + ' ' + a) }
  const man = await must(mvIns(cont, { descricao: 'QA-C-r3-r53man' }).single()); eq((await must(cont.rpc('movement_origin_record', { p_movement: man.id }))).length, 0, 'manual ' + man.id)
  for (const [n, sb] of [['gest', gest], ['oper', oper], ['mot', mot], ['aud', aud], ['tb', tb]]) { const x = await sb.rpc('movement_origin_record', { p_movement: a }); ok(x.error || (x.data ?? []).length === 0, `${n} obteve o registo de origem de ${a}: ${JSON.stringify(x.data)}`) }
  const an = await anonClient().rpc('movement_origin_record', { p_movement: a }); ok(an.error, 'anon executou')
})
await t('R5.4 RPC record_status: estado do registo (ou null) para Contabilista/Super Admin/Auditor com acc; null para o resto e para outro tenant; anon recusado', async () => {
  const D = '2026-05-27'; const r = await mkRec(oper, ctx.R1, D); await must(gest.from('daily_records').update({ status: 'validado' }).eq('id', r).select('id'))
  for (const [n, sb] of [['cont', cont], ['admin', admin], ['audacc', audacc]]) { eq((await sb.rpc('record_status', { p_route: ctx.R1, p_data: D })).data, 'validado', n + ' ' + r); eq((await sb.rpc('record_status', { p_route: ctx.R1, p_data: '2026-05-28' })).data, null, n + ' sem registo') }
  for (const [n, sb] of [['gest', gest], ['oper', oper], ['mot', mot], ['aud', aud], ['tb', tb]]) { const x = await sb.rpc('record_status', { p_route: ctx.R1, p_data: D }); ok(x.error || x.data === null, `${n} obteve o estado de ${r}: ${JSON.stringify(x.data)}`) }
  ok((await anonClient().rpc('record_status', { p_route: ctx.R1, p_data: D })).error, 'anon executou')
  await must(admin.from('daily_records').update({ deleted_at: new Date().toISOString() }).eq('id', r).select('id')); eq((await cont.rpc('record_status', { p_route: ctx.R1, p_data: D })).data, null, 'registo apagado ' + r)
})

// =================== R6: movement_pending (dedupe = movimento + dia + VALOR) ===================
setArea('R6 - movement_pending'); setCaso('R6')
await t('R6.1 corrigir o VALOR no mesmo dia (validado -> valor muda -> Pendente) volta a avisar TODOS os Super Admin e Contabilistas; reverter/revalidar o MESMO valor no mesmo dia nao repete', async () => {
  const exp = (await recipients(['super_admin', 'contabilista'])).length; const a = await alloc(tr, { valor: 40, rota_id: null, operation_id: null, descricao: 'r61' }); ids.r61 = a.id
  const cnt = async () => (await sql(`select count(*)::int n, count(distinct user_id)::int u from notifications where tipo='movement_pending' and payload->>'movement_id'='${a.id}'`))[0]
  let c = await cnt(); eq([c.n, c.u], [exp, exp], 'criar ' + a.id)
  await must(cont.from('movements').update({ estado: 'confirmado' }).eq('id', a.id).select()); await must(cont.from('movements').update({ estado: 'pendente' }).eq('id', a.id).select()); c = await cnt(); eq([c.n, c.u], [exp, exp], 'reverter o mesmo valor ' + a.id)
  await must(cont.from('movements').update({ estado: 'confirmado' }).eq('id', a.id).select()); await must(cont.from('movements').update({ valor: 45 }).eq('id', a.id).select())
  const m = await mv(a.id); eq([m.estado, Number(m.valor)], ['pendente', 45], 'valor mudado tira a validacao ' + a.id); c = await cnt(); eq([c.n, c.u], [exp * 2, exp], 'corrigir valor avisa de novo ' + a.id)
  await must(cont.from('movements').update({ estado: 'confirmado' }).eq('id', a.id).select()); await must(admin.from('movements').update({ estado: 'pendente' }).eq('id', a.id).select()); c = await cnt(); eq([c.n, c.u], [exp * 2, exp], 'revalidar/reverter o mesmo valor 45 nao repete ' + a.id)
  const keys = (await sql(`select distinct dedupe_key from notifications where tipo='movement_pending' and payload->>'movement_id'='${a.id}' order by 1`)).map((k) => k.dedupe_key); eq(keys.length, 2, 'chaves ' + keys.join(' | '))
})
await t('R6.2 (observacao) valor editado enquanto JA esta Pendente (sem transicao): notifica?', async () => {
  const a = await alloc(tr, { valor: 41, rota_id: null, operation_id: null, descricao: 'r62' }); const n0 = (await sql(`select count(*)::int n from notifications where tipo='movement_pending' and payload->>'movement_id'='${a.id}'`))[0].n
  await must(cont.from('movements').update({ valor: 42 }).eq('id', a.id).select()); const n1 = (await sql(`select count(*)::int n from notifications where tipo='movement_pending' and payload->>'movement_id'='${a.id}'`))[0].n
  return `movimento ${a.id}: ${n0} notificacoes ao criar, ${n1} depois de editar o valor 41 -> 42 ainda Pendente`
})

// =================== R7: RLS da leitura apos a 0020 ===================
setArea('R7 - RLS de movements apos 0020'); setCaso('R7')
await t('R7.1 contagens exatas por papel: Contabilista/Super Admin/Auditor com accounting_read veem todos os movimentos do tenant; Gestor/Operador/Motorista/Auditor sem acc veem 0; tenant B nao ve os do A', async () => {
  const tot = (await sql(`select count(*)::int n from movements where tenant_id='${T}'`))[0].n; const sample = (await sql(`select id from movements where tenant_id='${T}' and deleted_at is null limit 1`))[0].id
  const cnt = async (sb) => { const r = await sb.from('movements').select('id', { count: 'exact', head: true }); if (r.error) throw new Error(r.error.message); return r.count }
  eq([await cnt(cont), await cnt(admin), await cnt(audacc)], [tot, tot, tot], 'contagem de quem le')
  for (const [n, sb] of [['gest', gest], ['oper', oper], ['mot', mot], ['aud', aud]]) eq(await cnt(sb), 0, n + ' ve movimentos')
  const tbN = await cnt(tb); const tbSees = await must(tb.from('movements').select('id').eq('id', sample)); eq(tbSees.length, 0, 'tenant B le movimento do A ' + sample); ok(tbN < tot, 'tenant B conta ' + tbN)
  const ins = await tb.from('movements').select('id').eq('tenant_id', T).limit(1); eq((ins.data ?? []).length, 0, 'tenant B filtra por tenant A')
  const anon = await anonClient().from('movements').select('id').limit(1); eq((anon.data ?? []).length, 0, 'anon')
  return `total do tenant=${tot}; tenant B ve ${tbN}`
})
await t('R7.2 a policy usa (select ...) (InitPlan) e o indice movements_active_order existe', async () => {
  const p = (await sql(`select qual from pg_policies where tablename='movements' and policyname='mov_select'`))[0].qual; ok(/SELECT app\.tenant_id\(\)/i.test(p) && /SELECT app\.can_read_accounting\(\)/i.test(p), 'policy: ' + p)
  eq((await sql(`select count(*)::int n from pg_indexes where indexname='movements_active_order'`))[0].n, 1, 'indice')
})
dump('results-21.json'); savectx()
process.exit(0)
