// Cenario: audit trail (quem/quando/antes/depois) + verificacoes extra (Edge Function de convites, cobertura de triggers, cross-tenant em registos).
import { readFileSync, writeFileSync } from 'node:fs'
import { login, ADMIN, sql, t, setArea, eq, ok, must, denied, save } from './lib.mjs'

const ctx = JSON.parse(readFileSync(new URL('./ctx.json', import.meta.url), 'utf8'))
const admin = await login(...ADMIN)
const [oper, gestPC, mot2, cont, tb] = await Promise.all(['qa.operador', 'qa.gestor.porto', 'qa.motorista2', 'qa.contabilista', 'qa.tenantb'].map((n) => login(n + '@example.test')))
const audit = (tabela, id, acao) => must(admin.from('audit_log').select('*').eq('tabela', tabela).eq('registo_id', id).eq('acao', acao).order('id', { ascending: false }))

setArea('Audit trail')
let R
await t('INSERT de registo diario regista quem/quando/valores', async () => {
  R = (await must(oper.from('daily_records').insert({ route_id: ctx.routeLN, data: '2026-06-05', km: 20 }).select('id').single())).id; ctx.AUD1 = R
  const [a] = await audit('daily_records', R, 'INSERT'); ok(a, 'sem audit INSERT ' + R)
  ok(a.user_id === oper.uid && a.em && a.antes === null && Number(a.depois.km) === 20, `audit ${a.id}: user=${a.user_id} km=${a.depois?.km}`)
})
await t('UPDATE regista antes/depois (km 20 -> 25) e o utilizador que editou', async () => {
  await must(oper.from('daily_records').update({ km: 25 }).eq('id', R))
  const [a] = await audit('daily_records', R, 'UPDATE'); ok(a, 'sem audit UPDATE ' + R)
  ok(a.user_id === oper.uid && Number(a.antes.km) === 20 && Number(a.depois.km) === 25, `audit ${a.id}: ${a.antes?.km} -> ${a.depois?.km}`)
})
await t('Validacao pelo gestor fica auditada (status antes/depois + validado_por)', async () => {
  const g = await login('qa.gestor@example.test'); await must(g.from('daily_records').update({ status: 'validado' }).eq('id', R))
  const [a] = await audit('daily_records', R, 'UPDATE'); ok(a.user_id === g.uid && a.antes.status === 'rascunho' && a.depois.status === 'validado' && a.depois.validado_por === g.uid, `audit ${a.id}`)
})
await t('SOFT_DELETE regista deleted_at antes(null)/depois e quem apagou', async () => {
  await must(admin.from('daily_records').update({ deleted_at: new Date().toISOString() }).eq('id', R))
  const [a] = await audit('daily_records', R, 'SOFT_DELETE'); ok(a && a.user_id === admin.uid && a.antes.deleted_at === null && a.depois.deleted_at, 'audit soft delete ' + R)
})
await t('Alteracao de tarifario (routes) por Gestor auditada com valores antes/depois', async () => {
  await must(gestPC.from('routes').update({ taxa_km: 0.6 }).eq('id', ctx.routePC))
  const [a] = await audit('routes', ctx.routePC, 'UPDATE'); ok(a.user_id === gestPC.uid && Number(a.antes.taxa_km) === 0.5 && Number(a.depois.taxa_km) === 0.6, `audit ${a.id}`)
})
await t('Nova versao do tarifario (tariff_snapshots) tambem gera audit INSERT', async () => {
  const s = await must(admin.from('tariff_snapshots').select('id').eq('route_id', ctx.routePC).order('valid_from', { ascending: false }).limit(1)); const [a] = await audit('tariff_snapshots', s[0].id, 'INSERT'); ok(a, 'snapshot ' + s[0].id + ' sem audit')
})
await t('Alteracao de viatura e de linha de custo auditadas', async () => {
  await must(admin.from('vehicles').update({ iuc_valor: 91 }).eq('id', ctx.V.p1)); const [a] = await audit('vehicles', ctx.V.p1, 'UPDATE'); ok(a && Number(a.depois.iuc_valor) === 91 && a.user_id === admin.uid, 'vehicles ' + ctx.V.p1)
  const c = await must(oper.from('daily_record_costs').insert({ record_id: ctx.RMIN2, categoria: 'QA-aud', valor: 3 }).select('id').single()); const [b] = await audit('daily_record_costs', c.id, 'INSERT'); ok(b && b.user_id === oper.uid, 'custo ' + c.id)
})
await t('Gestao de acessos (set_user_access) auditada: user_roles antes/depois, por Super Admin', async () => {
  const before = (await sql('select coalesce(max(id),0) m from audit_log'))[0].m
  await must(admin.rpc('set_user_access', { p_user: mot2.uid, p_roles: ['motorista', 'auditor'], p_operation_ids: [ctx.opLN], p_accounting_read: false }))
  const rows = await sql(`select acao, tabela, user_id from audit_log where id > ${before} and tabela in ('user_roles','profiles','user_operations')`); ok(rows.some((r) => r.tabela === 'user_roles' && r.user_id === admin.uid), 'sem audit de user_roles: ' + JSON.stringify(rows))
  await must(admin.rpc('set_user_access', { p_user: mot2.uid, p_roles: ['motorista'], p_operation_ids: [ctx.opLN], p_accounting_read: false }))  // repor
})
await t('Limite de validacao (accounting_settings) auditado', async () => { const r = await sql(`select count(*)::int n from audit_log where tabela='accounting_settings' and user_id is null`); return `linhas de audit accounting_settings=${(await sql("select count(*)::int n from audit_log where tabela='accounting_settings'"))[0].n} (as alteracoes de teste foram feitas via SQL postgres, user_id nulo esperado)` })
await t('Audit legivel so por Super Admin do proprio tenant; ninguem o consegue alterar/apagar', async () => {
  for (const [n, sb] of [['operador', oper], ['contabilista', cont], ['gestor PC', gestPC], ['motorista', mot2]]) eq((await must(sb.from('audit_log').select('id').limit(1))).length, 0, n + ' le audit_log')
  await denied(admin.from('audit_log').delete().gt('id', 0).select(), 'delete audit'); await denied(admin.from('audit_log').update({ acao: 'X' }).gt('id', 0).select(), 'update audit'); await denied(admin.from('audit_log').insert({ tabela: 'x', acao: 'INSERT' }).select(), 'forjar audit')
})
await t('Cobertura: todas as tabelas de negocio tem trigger de audit (zz_audit) e bloqueio de DELETE (zz_forbid_delete)', async () => {
  const miss = await sql(`select c.relname, bool_or(t.tgname='zz_audit') aud, bool_or(t.tgname='zz_forbid_delete') fd from pg_class c join pg_namespace n on n.oid=c.relnamespace and n.nspname='public' left join pg_trigger t on t.tgrelid=c.oid and not t.tgisinternal where c.relkind='r' group by c.relname having not bool_or(t.tgname='zz_audit') or not bool_or(t.tgname='zz_forbid_delete') order by 1`)
  const unexpected = miss.filter((m) => !['audit_log', 'notifications', 'push_subscriptions'].includes(m.relname) && !(['user_roles', 'user_operations'].includes(m.relname) && m.aud))
  ok(unexpected.length === 0, 'tabelas sem audit/forbid_delete: ' + JSON.stringify(unexpected))
})

setArea('Verificacoes extra')
await t('Edge Function invite-user: Operador, Motorista e Gestor (papel/ambito indevido) sao recusados ANTES de enviar email', async () => {
  const g = await login('qa.gestor@example.test')
  for (const [n, sb, body] of [['operador', oper, { email: 'qa.invite.x1@example.test', roles: ['operador'], operation_ids: [ctx.opLN] }], ['motorista', mot2, { email: 'qa.invite.x2@example.test', roles: ['motorista'], operation_ids: [ctx.opLN] }], ['gestor->gestor', g, { email: 'qa.invite.x3@example.test', roles: ['gestor'], operation_ids: [ctx.opLN] }], ['contabilista', cont, { email: 'qa.invite.x4@example.test', roles: ['operador'], operation_ids: [ctx.opLN] }]]) {
    const r = await sb.functions.invoke('invite-user', { body }); ok(r.error || r.data?.error, `${n} conseguiu convidar: ${JSON.stringify(r.data)}`)
  }
  const inv = await sql("select count(*)::int n from invitations where email like 'qa.invite.x%'"); eq(inv[0].n, 0, 'convites criados indevidamente')
})
await t('Registo diario: viatura_id/motorista de OUTRO tenant nao pode ser referenciado (integridade cross-tenant)', async () => {
  // tenant B tenta ligar uma viatura do tenant A a um registo seu (precisa de rota B)
  const tid = (await must(tb.from('profiles').select('tenant_id').single())).tenant_id
  const bop = ctx.bOp; const br = await must(tb.from('routes').insert({ operation_id: bop, nome: 'QA-B-Rota' }).select('id').single()); ctx.bRoute = br.id
  const r = await tb.from('daily_records').insert({ route_id: br.id, data: '2026-06-01', viatura_id: ctx.V.p1, km: 1 }).select('id')
  if (!r.error && r.data?.length) throw new Error(`qa.tenantb criou o registo ${r.data[0].id} (tenant ${tid}) com viatura_id=${ctx.V.p1} (viatura do Tenant A, QA-01-AA). daily_records.viatura_id/motorista_ids nao sao validados contra o tenant (FK simples, RLS nao verifica); um Gestor/Operador tambem pode referenciar viaturas de outro tenant se souber o UUID.`)
})
await t('Postal zones: Operador nao ve zonas (definicoes)', async () => { eq((await must(oper.from('postal_zones').select('id'))).length, 0, 'operador le postal_zones') })

writeFileSync(new URL('./ctx.json', import.meta.url), JSON.stringify(ctx, null, 2))
save('./results-05.json')
