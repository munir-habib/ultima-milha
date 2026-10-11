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

dump('results-21b.json'); process.exit(0)
