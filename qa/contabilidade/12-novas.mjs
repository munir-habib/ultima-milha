// Funcionalidades novas (0017/0018) ao nivel do servidor, sempre como utilizadores reais (RLS):
//  A2 reclassificar alocacao propagada (relink) | A3 movement_pending dedupe | A4 alertas (run_alerts) | A5 request_cost_correction
//  B  (parte de dados) guard deixa mudar conta_id num automatico; PATCH em lote (blocos de 100).
import { ctx, T, loginAll, users, t, setCaso, setArea, eq, ok, must, denied, sql, mvIns, mv, mkRec, autos, dump, savectx } from './h.mjs'
import { anonClient } from '../lib.mjs'
import { chunk } from './acc.bundle.mjs'
await loginAll()
const { admin, cont, gest, oper, mot, aud, audacc, tb } = users
const ids = (ctx.c12 = ctx.c12 ?? {})
const transfer = (o) => must(mvIns(cont, { subcategoria: 'transferencia_distribuicao', pessoa_responsavel: 'QA-C-Nova', data: '2026-07-01', valor: 5000, ...o, descricao: 'QA-C-n-' + (o.descricao ?? 'tr') }).single())
const alloc = (tr, o) => must(mvIns(cont, { subcategoria: 'outro', pessoa_responsavel: 'QA-C-Nova', lancamento_referencia_id: tr.id, data: tr.data, operation_id: ctx.opLN, rota_id: ctx.R1, ...o, descricao: 'QA-C-n-' + (o.descricao ?? 'al') }).single())
const lines = (mid) => sql(`select id, record_id, valor::float v, categoria, deleted_at from daily_record_costs where movimento_id='${mid}' order by created_at, id`)
const rec = async (id) => (await sql(`select status, validado_por, deleted_at from daily_records where id='${id}'`))[0]
const reopened = (r) => sql(`select user_id from notifications where tipo='record_reopened' and payload->>'record_id'='${r}' order by 1`)
const nRecords = async (route, d) => (await sql(`select count(*)::int n from daily_records where route_id='${route}' and data='${d}' and deleted_at is null`))[0].n
const auditN = async (tab, id) => (await sql(`select count(*)::int n from audit_log where tabela='${tab}' and registo_id='${id}'`))[0].n
const recipients = (sqlRoles, opId) => sql(`select distinct p.id, p.email from profiles p join user_roles r on r.user_id=p.id where p.tenant_id='${T}' and p.deleted_at is null and (r.role in (${sqlRoles.map((x) => `'${x}'`).join(',')})${opId ? ` or (r.role='gestor' and exists (select 1 from user_operations uo where uo.user_id=p.id and uo.operation_id='${opId}'))` : ''}) order by 2`)
const today = (await sql('select app.today()::text d'))[0].d
const dayOff = async (n) => (await sql(`select (app.today() + (${n}))::text d`))[0].d

// =========================== A2: reclassificar uma alocacao JA propagada ===========================
setArea('A2 - reclassificar alocacao propagada'); setCaso('A2')
const tr = await transfer({ valor: 9000, descricao: 'a2' })
await t('A2.1 rota -> outra rota COM registo: linha antiga soft-deleted (audit: quem = Contabilista), alocacao liga-se ao registo da nova rota+data e ganha nova linha; registo antigo Submetido intacto', async () => {
  const D = '2026-07-01'; const r1 = await mkRec(oper, ctx.R1, D), r2 = await mkRec(oper, ctx.R2, D)
  const a = await alloc(tr, { valor: 25, data: D, descricao: 'a21' }); ids.a21 = a.id
  eq((await mv(a.id)).registo_id, r1, 'propagacao inicial ' + a.id); const L1 = (await lines(a.id))[0]
  const am0 = await auditN('movements', a.id)
  await must(cont.from('movements').update({ rota_id: ctx.R2 }).eq('id', a.id).select())
  const m = await mv(a.id); eq([m.registo_id, m.rota_id, m.estado], [r2, ctx.R2, 'pendente'], 'alocacao ' + a.id)
  const ls = await lines(a.id); eq(ls.length, 2, 'linhas de custo ' + a.id)
  eq([!!ls[0].deleted_at, ls[0].record_id, !ls[1].deleted_at, ls[1].record_id, ls[1].v, ls[1].categoria], [true, r1, true, r2, 25, 'Pagamento distribuído — QA-C-Nova'], 'linhas ' + JSON.stringify(ls))
  const au = await must(admin.from('audit_log').select('acao,user_id,em,antes,depois').eq('tabela', 'daily_record_costs').eq('registo_id', L1.id).eq('acao', 'SOFT_DELETE'))
  eq([au.length, au[0]?.user_id, !!au[0]?.em, au[0]?.antes?.deleted_at, !!au[0]?.depois?.deleted_at], [1, cont.uid, true, null, true], 'audit da linha antiga ' + L1.id)
  eq((await rec(r1)).status, 'rascunho', 'registo antigo ' + r1 + ' (criado como rascunho: a reclassificacao nao lhe muda o estado)')
  return `entradas de audit do movimento ${a.id} geradas por esta reclassificacao (a do utilizador + as do sistema: desligar/ligar): ${(await auditN('movements', a.id)) - am0}`
})
await t('A2.2 registo antigo VALIDADO: volta a Submetido (validado_por limpo), o validador (Gestor) recebe record_reopened e quem alterou NAO; alocacao fica por ligar (registo_id nulo) e o registo da nova rota+data NAO e criado', async () => {
  const D = '2026-07-02'; const r3 = await mkRec(oper, ctx.R1, D); const a = await alloc(tr, { valor: 26, data: D, descricao: 'a22' }); ids.a22 = a.id
  eq((await mv(a.id)).registo_id, r3, 'propagada'); await must(gest.from('daily_records').update({ status: 'validado' }).eq('id', r3).select('id'))
  eq([(await rec(r3)).status, (await rec(r3)).validado_por], ['validado', gest.uid], 'registo validado ' + r3)
  await must(cont.from('movements').update({ rota_id: ctx.R2 }).eq('id', a.id).select())
  const r = await rec(r3); eq([r.status, r.validado_por], ['submetido', null], 'registo ' + r3)
  eq((await reopened(r3)).map((x) => x.user_id), [gest.uid], 'record_reopened de ' + r3)
  const m = await mv(a.id); eq([m.registo_id, m.rota_id], [null, ctx.R2], 'alocacao por ligar ' + a.id)
  eq(await nRecords(ctx.R2, D), 0, 'registo R2/' + D + ' NAO deve ser criado'); const ls = await lines(a.id); eq([ls.length, !!ls[0].deleted_at], [1, true], 'linha antiga apagada')
})
await t('A2.3 ... e quando o registo da nova rota+data nasce depois, a alocacao anexa-se sozinha (nunca o cria antes)', async () => {
  const r = await mkRec(oper, ctx.R2, '2026-07-02'); const m = await mv(ids.a22); eq(m.registo_id, r, 'alocacao ' + ids.a22)
  const ls = (await lines(ids.a22)).filter((l) => !l.deleted_at); eq([ls.length, ls[0].record_id], [1, r], 'linha ativa')
})
await t('A2.4 mover para "Geral" (rota nula, operacao mantida): linha antiga apagada, fica sem registo e NAO se liga; o mesmo com operacao+rota nulas', async () => {
  const D = '2026-07-03'; const r1 = await mkRec(oper, ctx.R1, D); const r2 = await mkRec(oper, ctx.R2, D)
  const a = await alloc(tr, { valor: 27, data: D, descricao: 'a24a' }), b = await alloc(tr, { valor: 28, data: D, rota_id: ctx.R2, descricao: 'a24b' })
  eq([(await mv(a.id)).registo_id, (await mv(b.id)).registo_id], [r1, r2], 'propagadas')
  await must(cont.from('movements').update({ rota_id: null }).eq('id', a.id).select()); await must(cont.from('movements').update({ rota_id: null, operation_id: null }).eq('id', b.id).select())
  const [ma, mb] = [await mv(a.id), await mv(b.id)]
  eq([ma.registo_id, ma.rota_id, ma.operation_id, ma.origem, mb.registo_id, mb.operation_id, mb.origem], [null, null, ctx.opLN, 'manual_rota', null, null, 'manual_geral'], `Geral ${a.id} / ${b.id}`)
  eq([(await lines(a.id)).filter((l) => !l.deleted_at).length, (await lines(b.id)).filter((l) => !l.deleted_at).length], [0, 0], 'linhas ativas')
})
await t('A2.5 mudar so a DATA: linha antiga apagada e liga ao registo dessa data (se existir); mudar so a OPERACAO+rota (LN/R1 -> Porto/RP): idem com o registo do Porto', async () => {
  const r1 = await mkRec(oper, ctx.R1, '2026-07-04'), r1b = await mkRec(oper, ctx.R1, '2026-07-05'); const a = await alloc(tr, { valor: 29, data: '2026-07-04', descricao: 'a25a' })
  eq((await mv(a.id)).registo_id, r1, 'propagada'); await must(cont.from('movements').update({ data: '2026-07-05' }).eq('id', a.id).select())
  eq([(await mv(a.id)).registo_id, (await lines(a.id)).filter((l) => !l.deleted_at).map((l) => l.record_id)], [r1b, [r1b]], 'mudanca de data ' + a.id)
  const rp = await mkRec(users.admin, ctx.RP, '2026-07-05'); await must(cont.from('movements').update({ operation_id: ctx.opPC, rota_id: ctx.RP }).eq('id', a.id).select())
  eq([(await mv(a.id)).registo_id, (await lines(a.id)).filter((l) => !l.deleted_at).map((l) => l.record_id)], [rp, [rp]], 'mudanca de operacao ' + a.id)
})
await t('A2.6 alocacao "por ligar" reclassificada para rota+data com registo: liga-se (sem apagar nada); credito nao se liga; alocacao validada mantem a validacao ao reclassificar, e perde-a ao mudar o valor', async () => {
  const D = '2026-07-06'; const r1 = await mkRec(oper, ctx.R1, D); const a = await alloc(tr, { valor: 30, data: D, rota_id: ctx.R2, descricao: 'a26a' })
  eq((await mv(a.id)).registo_id, null, 'por ligar'); await must(cont.from('movements').update({ rota_id: ctx.R1 }).eq('id', a.id).select())
  eq((await mv(a.id)).registo_id, r1, 'ligou ' + a.id); eq((await lines(a.id)).filter((l) => l.deleted_at).length, 0, 'nada apagado')
  const c = await alloc(tr, { valor: 31, data: D, tipo: 'credito', rota_id: ctx.R2, descricao: 'a26c' }); await must(cont.from('movements').update({ rota_id: ctx.R1 }).eq('id', c.id).select()); eq((await mv(c.id)).registo_id, null, 'credito ' + c.id)
  await must(cont.from('movements').update({ estado: 'confirmado' }).eq('id', a.id).select()); await must(cont.from('movements').update({ rota_id: ctx.R2 }).eq('id', a.id).select())
  const m = await mv(a.id); eq([m.estado, m.validado_por, m.registo_id], ['confirmado', cont.uid, null], 'validacao mantida ' + a.id)
  await must(cont.from('movements').update({ valor: 32 }).eq('id', a.id).select()); const m2 = await mv(a.id); eq([m2.estado, m2.validado_por], ['pendente', null], 'valor mudou -> tira a validacao ' + a.id)
})
await t('A2.7 dois registos Validados (validador = quem reclassifica; e o do registo de destino = Gestor): antigo reverte sem auto-aviso; destino reverte ao anexar e avisa o Gestor', async () => {
  const D = '2026-07-07'; const rOld = await mkRec(oper, ctx.R1, D); const a = await alloc(tr, { valor: 33, data: D, descricao: 'a27' })
  await must(admin.from('daily_records').update({ status: 'validado' }).eq('id', rOld).select('id'))
  const rNew = await mkRec(gest, ctx.R2, D, { status: 'validado' }); eq([(await rec(rNew)).status, (await rec(rOld)).status], ['validado', 'validado'], 'antes')
  await must(admin.from('movements').update({ rota_id: ctx.R2 }).eq('id', a.id).select())
  eq([(await rec(rOld)).status, (await rec(rNew)).status, (await mv(a.id)).registo_id], ['submetido', 'submetido', rNew], `registos ${rOld}/${rNew}`)
  eq((await reopened(rOld)).length, 0, 'auto-notificacao de ' + rOld); eq((await reopened(rNew)).map((x) => x.user_id), [gest.uid], 'aviso do registo destino ' + rNew)
})
await t('A2.8 so a linha DESTA alocacao e apagada (outra alocacao do mesmo registo mantem a sua); editar so valor/descricao nao mexe na linha', async () => {
  const D = '2026-07-08'; const r1 = await mkRec(oper, ctx.R1, D); const a = await alloc(tr, { valor: 34, data: D, descricao: 'a28a' }), b = await alloc(tr, { valor: 35, data: D, descricao: 'a28b' })
  const lb0 = await lines(b.id); await must(cont.from('movements').update({ valor: 36, descricao: 'QA-C-n-a28b-ed' }).eq('id', b.id).select()); eq(await lines(b.id), lb0, 'linha de ' + b.id + ' alterada por editar valor/descricao')
  await must(cont.from('movements').update({ rota_id: ctx.R2 }).eq('id', a.id).select())
  eq([(await lines(a.id)).filter((l) => !l.deleted_at).length, (await lines(b.id)).filter((l) => !l.deleted_at).length, (await mv(b.id)).registo_id], [0, 1, r1], 'alocacoes ' + a.id + '/' + b.id)
})
await t('A2 (observacao) soft delete (Super Admin) de uma alocacao propagada: o que acontece a linha de custo no registo?', async () => {
  const D = '2026-07-09'; const r1 = await mkRec(oper, ctx.R1, D); const a = await alloc(tr, { valor: 37, data: D, descricao: 'a29' })
  await must(admin.from('movements').update({ deleted_at: new Date().toISOString(), motivo_apagado: 'QA-C teste' }).eq('id', a.id).select())
  const ls = await lines(a.id); const active = ls.filter((l) => !l.deleted_at).length
  return active ? `NOTA: apagar (soft) a alocacao ${a.id} NAO remove a linha de custo do registo ${r1} (${active} linha(s) ativa(s), continua a contar no registo). A regra so define apagar o registo/custo->0 para automaticos.` : 'linha removida junto'
})

// =========================== A3: movement_pending dedupe ===========================
setArea('A3 - notificacoes movement_pending'); setCaso('A3')
await t('A3 alocacao nasce Pendente: TODOS os Super Admin e Contabilistas avisados 1x; validar e reverter NO MESMO DIA nao repete; noutro dia (dedupe_key antigo) volta a avisar', async () => {
  const exp = await recipients(['super_admin', 'contabilista']); const a = await alloc(tr, { valor: 40, rota_id: null, operation_id: null, descricao: 'a3' }); ids.a3 = a.id
  const cnt = async () => (await sql(`select count(*)::int n, count(distinct user_id)::int u from notifications where tipo='movement_pending' and payload->>'movement_id'='${a.id}'`))[0]
  const c0 = await cnt(); eq([c0.n, c0.u], [exp.length, exp.length], 'apos criar ' + a.id)
  await must(cont.from('movements').update({ estado: 'confirmado' }).eq('id', a.id).select()); await must(cont.from('movements').update({ estado: 'pendente' }).eq('id', a.id).select())
  await must(admin.from('movements').update({ estado: 'confirmado' }).eq('id', a.id).select()); await must(admin.from('movements').update({ estado: 'pendente' }).eq('id', a.id).select())
  const c1 = await cnt(); eq([c1.n, c1.u], [exp.length, exp.length], 'validar/reverter 2x no mesmo dia (movimento ' + a.id + ')')
  await sql(`update notifications set dedupe_key = 'pending:${a.id}:2000-01-01' where tipo='movement_pending' and payload->>'movement_id'='${a.id}'`)
  await must(cont.from('movements').update({ estado: 'confirmado' }).eq('id', a.id).select()); await must(cont.from('movements').update({ estado: 'pendente' }).eq('id', a.id).select())
  const c2 = await cnt(); eq([c2.n, c2.u], [exp.length * 2, exp.length], 'noutro dia volta a avisar (movimento ' + a.id + ')')
  const bad = await sql(`select p.email from notifications n join profiles p on p.id=n.user_id join user_roles r on r.user_id=p.id where n.tipo='movement_pending' and n.payload->>'movement_id'='${a.id}' and r.role not in ('super_admin','contabilista')`); eq(bad.length, 0, 'destinatarios indevidos')
})
await t('A3 automatico acima do limiar: 1 aviso por destinatario; revalidar/reverter no mesmo dia nao repete', async () => {
  const r = await mkRec(oper, ctx.R1, '2026-07-10', { comb_valor: 150, status: 'submetido' }); const a = (await autos(r, 'combustivel'))[0]; const exp = await recipients(['super_admin', 'contabilista'])
  const cnt = async () => (await sql(`select count(*)::int n from notifications where tipo='movement_pending' and payload->>'movement_id'='${a.id}'`))[0].n
  eq(await cnt(), exp.length, 'criar ' + a.id); await must(cont.from('movements').update({ estado: 'confirmado' }).eq('id', a.id).select()); await must(cont.from('movements').update({ estado: 'pendente' }).eq('id', a.id).select()); eq(await cnt(), exp.length, 'reverter ' + a.id)
})

// =========================== A4: alertas ===========================
setArea('A4 - alertas diarios'); setCaso('A4')
const al = {}
await t('A4 allocation_unlinked: alocacao a debito com operacao+rota SEM registo ha 3+ dias -> Gestor da operacao, Super Admin e Contabilista (nunca Operador/Motorista/Auditor/Gestor de outra operacao); nao alerta se < 3 dias, ligada, credito ou Geral; 1 por semana (dedupe)', async () => {
  const d3 = await dayOff(-3), d2 = await dayOff(-2), d5 = await dayOff(-5)
  const trA = await transfer({ valor: 9000, data: d5, descricao: 'a4', pessoa_responsavel: 'QA-C-Alerta' }); ids.a4tr = trA.id
  const mk = async (k, o) => { al[k] = (await alloc(trA, { valor: 11, pessoa_responsavel: 'QA-C-Alerta', descricao: 'a4-' + k, ...o })).id }
  await mk('old', { data: d5 }); await mk('d3', { data: d3, rota_id: ctx.R2 }); await mk('d2', { data: d2 })
  const recLinked = await mkRec(oper, ctx.R2, d5); await mk('linked', { data: d5, rota_id: ctx.R2 }); eq((await mv(al.linked)).registo_id, recLinked, 'alocacao ligada')
  await mk('credit', { data: d5, tipo: 'credito', rota_id: ctx.R1 }); await mk('geral', { data: d5, rota_id: null, operation_id: null })
  const n1 = (await sql('select app.run_alerts(false) n'))[0].n
  const got = await sql(`select n.payload->>'movement_id' mid, p.email, r.role from notifications n join profiles p on p.id=n.user_id join user_roles r on r.user_id=p.id where n.tipo='allocation_unlinked' and n.payload->>'movement_id' in (${Object.values(al).map((x) => `'${x}'`).join(',')})`)
  const byMov = (id) => [...new Set(got.filter((g) => g.mid === id).map((g) => g.email))].sort()
  const exp = (await recipients(['super_admin', 'contabilista'], ctx.opLN)).map((x) => x.email).sort(); ok(exp.includes('qa.gestor@example.test') && exp.includes('qa.contabilista@example.test'), 'destinatarios esperados: ' + exp)
  eq(byMov(al.old), exp, 'destinatarios de allocation_unlinked ' + al.old); eq(byMov(al.d3), exp, 'exatamente 3 dias tambem alerta ' + al.d3)
  for (const k of ['d2', 'linked', 'credit', 'geral']) eq(byMov(al[k]).length, 0, `alerta indevido (${k}) ${al[k]}`)
  const wrong = got.filter((g) => !exp.includes(g.email)); eq(wrong.length, 0, 'destinatarios indevidos ' + JSON.stringify(wrong))
  const p = (await sql(`select payload from notifications where tipo='allocation_unlinked' and payload->>'movement_id'='${al.old}' limit 1`))[0].payload; eq([p.route_id, p.data], [ctx.R1, d5], 'payload (rota e data para o sino) ' + al.old)
  const before = (await sql(`select count(*)::int n from notifications where tipo='allocation_unlinked' and payload->>'movement_id' in (${Object.values(al).map((x) => `'${x}'`).join(',')})`))[0].n
  await sql('select app.run_alerts(false)'); const after = (await sql(`select count(*)::int n from notifications where tipo='allocation_unlinked' and payload->>'movement_id' in (${Object.values(al).map((x) => `'${x}'`).join(',')})`))[0].n
  eq(after, before, '2.a execucao no mesmo dia/semana nao repete'); return `run_alerts devolveu ${n1}; ${before} notificacoes; destinatarios: ${exp.join(', ')}`
})
await t('A4 fund_unreconciled: so alocacoes a DEBITO contam (transferencia 100 + credito 100 = por alocar 100 -> alerta; 100 + debito 100 -> sem alerta; 100 + debito 40 -> alerta de 60)', async () => {
  const d8 = await dayOff(-8); const mkT = (k) => transfer({ valor: 100, data: d8, descricao: 'a4f' + k, pessoa_responsavel: 'QA-C-Alerta-F' + k })
  const tA = await mkT('A'), tB = await mkT('B'), tC = await mkT('C')
  await alloc(tA, { valor: 100, tipo: 'credito', rota_id: null, operation_id: null, data: d8 }); await alloc(tB, { valor: 100, rota_id: null, operation_id: null, data: d8 }); await alloc(tC, { valor: 40, rota_id: null, operation_id: null, data: d8 })
  await sql('select app.run_alerts(false)')
  const got = async (id) => await sql(`select distinct n.payload->>'valor' v from notifications n where n.tipo='fund_unreconciled' and n.payload->>'movement_id'='${id}'`)
  const exp = (await recipients(['super_admin', 'contabilista'])).length
  eq((await got(tA.id)).map((x) => Number(x.v)), [100], 'transferencia com credito ' + tA.id); eq((await got(tB.id)).length, 0, 'totalmente alocada a debito ' + tB.id); eq((await got(tC.id)).map((x) => Number(x.v)), [60], 'sub-alocada ' + tC.id)
  eq((await sql(`select count(*)::int n from notifications where tipo='fund_unreconciled' and payload->>'movement_id'='${tA.id}'`))[0].n, exp, 'todos os Super Admin e Contabilistas')
})

// =========================== A5: request_cost_correction ===========================
setArea('A5 - pedir correcao'); setCaso('A5')
let A5auto, A5rec
await t('A5 Contabilista pede correcao de um AUTOMATICO com operacao: notifica (auto_cost_disputed) Super Admin e Gestores da operacao (nunca o proprio); devolve o n.o de notificados; 2.o pedido no mesmo dia = 0', async () => {
  A5rec = await mkRec(oper, ctx.R1, '2026-07-11', { comb_valor: 30, status: 'submetido' }); A5auto = (await autos(A5rec, 'combustivel'))[0].id; ids.a5 = A5auto
  const exp = (await recipients(['super_admin'], ctx.opLN)).filter((x) => x.id !== cont.uid)
  const r = await cont.rpc('request_cost_correction', { p_movement: A5auto, p_note: 'QA-C nota de teste' }); ok(!r.error, 'rpc: ' + r.error?.message); eq(r.data, exp.length, 'n.o de notificados ' + A5auto)
  const got = await sql(`select p.email, n.payload from notifications n join profiles p on p.id=n.user_id where n.tipo='auto_cost_disputed' and n.payload->>'movement_id'='${A5auto}' order by 1`)
  eq(got.map((g) => g.email), exp.map((e) => e.email), 'destinatarios'); eq([got[0].payload.note, got[0].payload.route_id, got[0].payload.data, got[0].payload.registo_id], ['QA-C nota de teste', ctx.R1, '2026-07-11', A5rec], 'payload')
  ok(!got.some((g) => g.email === 'qa.contabilista@example.test'), 'notificou o proprio'); ok(got.some((g) => g.email === 'qa.gestor@example.test'), 'gestor da operacao em falta'); ok(!got.some((g) => /porto|operador|auditor|motorista/.test(g.email)), 'destinatario indevido')
  const r2 = await cont.rpc('request_cost_correction', { p_movement: A5auto, p_note: 'segundo' }); eq(r2.data, 0, '2.o pedido no mesmo dia')
  eq((await sql(`select count(*)::int n from notifications where tipo='auto_cost_disputed' and payload->>'movement_id'='${A5auto}'`))[0].n, exp.length, 'notificacoes duplicadas')
  const ra = await admin.rpc('request_cost_correction', { p_movement: A5auto, p_note: null }); const expA = (await recipients(['super_admin'], ctx.opLN)).filter((x) => x.id !== admin.uid); ok(!ra.error, 'admin: ' + ra.error?.message)
  const gotA = await sql(`select distinct p.email from notifications n join profiles p on p.id=n.user_id where n.tipo='auto_cost_disputed' and n.payload->>'movement_id'='${A5auto}'`); ok(!ra.error && ra.data >= 0, 'admin ok'); return `Super Admin como chamador: devolveu ${ra.data} (esperado <= ${expA.length}: os ja avisados hoje dedupam); destinatarios totais ${gotA.map((x) => x.email).join(',')}`
})
await t('A5 refusas: Operador, Gestor, Motorista, Auditor (com e sem accounting_read) -> "sem permissao"; anon sem execute; Super Admin de outro tenant -> nao encontrado; manual recusado; automatico sem operacao recusado', async () => {
  for (const [n, sb] of [['operador', oper], ['gestor', gest], ['motorista', mot], ['auditor', aud], ['auditor.acc', audacc]]) {
    const r = await sb.rpc('request_cost_correction', { p_movement: A5auto }); ok(r.error && /sem permissao/.test(r.error.message), `${n} nao foi recusado com "sem permissao": ${JSON.stringify(r.error ?? r.data)}`)
  }
  const anon = await anonClient().rpc('request_cost_correction', { p_movement: A5auto }); ok(anon.error, 'anon executou'); const tbr = await tb.rpc('request_cost_correction', { p_movement: A5auto }); ok(tbr.error, 'tenant B executou ' + JSON.stringify(tbr.data))
  const man = await must(mvIns(cont, { descricao: 'QA-C-n-a5-manual' }).single()); const rm = await cont.rpc('request_cost_correction', { p_movement: man.id }); ok(rm.error, 'manual aceite ' + man.id)
  const r2 = await mkRec(oper, ctx.R2, '2026-07-12', { comb_valor: 30, status: 'submetido' }); const a2 = (await autos(r2, 'combustivel'))[0].id
  await must(cont.from('movements').update({ operation_id: null, rota_id: null }).eq('id', a2).select()); const rn = await cont.rpc('request_cost_correction', { p_movement: a2 }); ok(rn.error, 'automatico sem operacao aceite ' + a2)
  const nx = await cont.rpc('request_cost_correction', { p_movement: '00000000-0000-0000-0000-000000000000' }); ok(nx.error, 'id inexistente')
  return `mensagens: anon="${anon.error.message.slice(0, 60)}"; outro tenant="${tbr.error.message}"; manual="${rm.error.message}"`
})
await t('A5 (achado a verificar) automatico RECLASSIFICADO para outra rota: o pedido/notificacao aponta ao registo de ORIGEM (route_id do registo), nao a rota reclassificada', async () => {
  const r = await mkRec(oper, ctx.R1, '2026-07-13', { comb_valor: 30, status: 'submetido' }); const a = (await autos(r, 'combustivel'))[0].id
  await must(cont.from('movements').update({ rota_id: ctx.R2 }).eq('id', a).select()); const n = await cont.rpc('request_cost_correction', { p_movement: a }); ok(!n.error, n.error?.message)
  const p = (await sql(`select payload from notifications where tipo='auto_cost_disputed' and payload->>'movement_id'='${a}' limit 1`))[0].payload
  eq([p.registo_id, p.route_id], [r, ctx.R1], `automatico ${a} (registo ${r}, origem R1) reclassificado para R2: payload.route_id=${p.route_id}`)
})

// =========================== B (dados): conta em automaticos e PATCH em lote ===========================
setArea('B - conta e lote (servidor)'); setCaso('B2')
await t('B2 o guard deixa mudar conta_id num automatico (Contabilista e Super Admin) e atribuir conta a manuais e alocacoes; um so PATCH em lote com ids mistos; validar em lote fica com validado_por = quem clicou e 1 entrada de audit por movimento', async () => {
  const r = await mkRec(oper, ctx.R1, '2026-07-14', { comb_valor: 120, status: 'submetido' }); const au = (await autos(r, 'combustivel'))[0]; eq(au.conta_id, null, 'automatico sem conta por defeito ' + au.id)
  const man = await must(mvIns(cont, { descricao: 'QA-C-n-b2m', conta_id: ctx.contaA }).single()), al2 = await alloc(tr, { valor: 41, rota_id: null, operation_id: null, descricao: 'b2a', conta_id: ctx.contaA })
  const idsAll = [au.id, man.id, al2.id]; const audBefore = await Promise.all(idsAll.map((i) => auditN('movements', i)))
  const p = await cont.from('movements').update({ conta_id: ctx.contaB }).in('id', idsAll).select('id,conta_id'); ok(!p.error, p.error?.message); eq([p.data.length, ...p.data.map((x) => x.conta_id)], [3, ctx.contaB, ctx.contaB, ctx.contaB], 'PATCH em lote conta')
  const pv = await cont.from('movements').update({ estado: 'confirmado' }).in('id', [au.id, al2.id]).select('id,estado,validado_por'); eq(pv.data.map((x) => [x.estado, x.validado_por]), [['confirmado', cont.uid], ['confirmado', cont.uid]], 'validar em lote ' + [au.id, al2.id])
  const audAfter = await Promise.all(idsAll.map((i) => auditN('movements', i))); eq(audAfter.map((n, i) => n - audBefore[i]), [2, 1, 2], 'entradas de audit novas (automatico: conta+validar; manual: so conta; alocacao: conta+validar)')
  const as = await admin.from('movements').update({ conta_id: null }).eq('id', au.id).select('conta_id'); ok(!as.error && as.data.length === 1 && as.data[0].conta_id === null, 'Super Admin tirar conta do automatico')
  ids.b2 = { au: au.id, man: man.id, al: al2.id }
  
})
await t('B2 PATCH em blocos de 100 (chunk do cliente): 250 movimentos QA-C-lote, atribuir conta em 3 pedidos; todos ficam com a conta; 1 entrada de audit UPDATE por movimento', async () => {
  const rows = Array.from({ length: 250 }, (_, i) => ({ tenant_id: T, data: '2026-07-15', conta_id: ctx.contaA, tipo: 'debito', valor: 1 + (i % 7), subcategoria: 'outro', descricao: 'QA-C-lote-' + i }))
  const idsL = []; for (const part of chunk(rows, 125)) idsL.push(...(await must(cont.from('movements').insert(part).select('id'))).map((x) => x.id)); eq(idsL.length, 250, 'inseridos')
  const parts = chunk(idsL, 100); eq(parts.map((p) => p.length), [100, 100, 50], 'blocos'); for (const part of parts) await must(cont.from('movements').update({ conta_id: ctx.contaB }).in('id', part).select('id'))
  const r = (await sql(`select count(*)::int n, count(*) filter (where conta_id='${ctx.contaB}')::int b from movements where id in (${idsL.map((x) => `'${x}'`).join(',')})`))[0]; eq([r.n, r.b], [250, 250], 'contas')
  const a = (await sql(`select count(*)::int n, count(distinct registo_id)::int d from audit_log where tabela='movements' and acao='UPDATE' and registo_id in (${idsL.map((x) => `'${x}'`).join(',')})`))[0]; eq([a.n, a.d], [250, 250], '1 UPDATE por movimento')
})

savectx(); dump('results-12.json')
