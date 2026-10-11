// Cenario: permissoes por papel (como utilizador real, RLS) e isolamento entre operacoes e tenants.
// Pre-requisito: node qa/01-precos.mjs (cria ctx.json com rotas/operacoes QA-).
import { readFileSync, writeFileSync } from 'node:fs'
import { login, anonClient, ADMIN, PW, sql, t, setArea, eq, ok, must, denied, save } from './lib.mjs'

const ctx = JSON.parse(readFileSync(new URL('./ctx.json', import.meta.url), 'utf8'))
const admin = await login(...ADMIN)
const [oper, operPC, gest, gestPC, mot, mot2, cont, aud, audAcc, tb] = await Promise.all(
  ['qa.operador', 'qa.operador.porto', 'qa.gestor', 'qa.gestor.porto', 'qa.motorista', 'qa.motorista2', 'qa.contabilista', 'qa.auditor', 'qa.auditor.acc'].map((n) => login(n + '@example.test')).concat([login('qa.tenantb@example.test', PW)]),
)
const rows = async (sb, table, f) => { let q = sb.from(table).select('*'); if (f) q = f(q); const { data, error } = await q; if (error) return { error: error.message, n: -1, data: [] }; return { n: data.length, data } }
const zero = async (sb, tables, who) => { for (const tb_ of tables) { const r = await rows(sb, tb_); if (r.n > 0) throw new Error(`${who} le ${r.n} linhas de ${tb_} (ex.: ${r.data[0].id ?? JSON.stringify(r.data[0]).slice(0, 80)})`) } }
const iso = () => new Date().toISOString()

// registo do admin numa rota de Porto Centro (para tentar mexer com utilizadores de Lisboa)
const PCREC = (await must(admin.from('daily_records').insert({ route_id: ctx.routePC, data: '2026-06-01', km: 10, valor_fixo_do_dia: 40 }).select('id').single())).id
ctx.PCREC = PCREC

// ================= OPERADOR =================
setArea('Permissoes - Operador (qa.operador, Lisboa Norte)')
let O1, O1b
await t('cria registo na rota da sua operacao', async () => { O1 = (await must(oper.from('daily_records').insert({ route_id: ctx.routeLN, data: '2026-06-01', km: 20, valor_fixo_do_dia: 40, status: 'submetido' }).select('id,created_by').single())).id; ctx.O1 = O1 })
await t('edita o registo que criou', async () => { await must(oper.from('daily_records').update({ km: 30 }).eq('id', O1).select().single()) })
await t('RECUSADO: criar registo numa rota de outra operacao (Porto Centro)', async () => { await denied(oper.from('daily_records').insert({ route_id: ctx.routePC, data: '2026-06-02' }).select(), 'insert PC') })
await t('RECUSADO: ler/editar registos de outra operacao', async () => {
  eq((await rows(oper, 'daily_records', (q) => q.eq('route_id', ctx.routePC))).n, 0, 'le registos PC')
  await denied(oper.from('daily_records').update({ km: 99 }).eq('id', PCREC).select(), 'update PC')
})
await t('RECUSADO: criar registo ja como Validado (validar e so Gestor/SA)', async () => { await denied(oper.from('daily_records').insert({ route_id: ctx.routeLN, data: '2026-06-03', status: 'validado' }).select(), 'insert validado') })
await t('RECUSADO: validar um registo existente', async () => { await denied(oper.from('daily_records').update({ status: 'validado' }).eq('id', O1).select(), 'validar') })
await t('RECUSADO: DELETE fisico de registo', async () => { await denied(oper.from('daily_records').delete().eq('id', O1).select(), 'delete fisico') })
await t('RECUSADO: apagar (soft delete via deleted_at) um registo diario', async () => {
  const r = await oper.from('daily_records').update({ deleted_at: iso() }).eq('id', O1).select('id,deleted_at')
  if (r.data?.length) { await sql(`update daily_records set deleted_at=null where id='${O1}'`); throw new Error(`Operador (qa.operador) conseguiu soft-delete do registo ${O1}: daily_records.deleted_at ficou preenchido. Politica records_update (supabase/migrations/20260919000005_rls.sql) so exige status<>'validado' e can_write_op; nao ha guarda para deleted_at em app.records_before.`) }
})
await t('RECUSADO: apagar (soft delete) uma linha de custo do registo (daily_record_costs)', async () => {
  const c = await must(oper.from('daily_record_costs').insert({ record_id: O1, categoria: 'QA-custo', valor: 5 }).select('id').single())
  const r = await oper.from('daily_record_costs').update({ deleted_at: iso() }).eq('id', c.id).select('id')
  if (r.data?.length) return `NOTA: Operador consegue remover (soft) linha de custo ${c.id} do registo ${O1} - equivale a "remover linha" no ecra do registo; reportado como observacao`
})
await t('RECUSADO: ler tarifario/definicoes (routes, tariff_snapshots, operations, goals, postal_zones)', async () => { await zero(oper, ['routes', 'tariff_snapshots', 'operations', 'postal_zones'], 'operador') })
await t('Operador le as metas (goals) so da sua operacao (usadas no Dashboard) e nao as escreve', async () => {
  const g = await rows(oper, 'goals'); ok(g.data.every((x) => x.operation_id === ctx.opLN), 'operador le metas de outra operacao: ' + g.data.find((x) => x.operation_id !== ctx.opLN)?.id)
  await denied(oper.from('goals').insert({ operation_id: ctx.opLN, metrica: 'receita', alvo: 1 }).select(), 'insert goal')
})
await t('RECUSADO: alterar tarifario e definicoes', async () => {
  await denied(oper.from('routes').update({ taxa_km: 9 }).eq('id', ctx.routeLN).select(), 'update route')
  await denied(oper.from('operations').update({ salario_fixo_mensal: 1 }).eq('id', ctx.opLN).select(), 'update op')
  await denied(oper.from('routes').insert({ operation_id: ctx.opLN, nome: 'QA-x' }).select(), 'insert route')
})
await t('RECUSADO: contabilidade (movements, bank_accounts, accounting_settings) e audit_log', async () => { await zero(oper, ['movements', 'bank_accounts', 'accounting_settings', 'audit_log'], 'operador') })
await t('RECUSADO: criar movimento', async () => { await denied(oper.from('movements').insert({ tenant_id: (await must(oper.from('profiles').select('tenant_id').single())).tenant_id, data: '2026-06-01', tipo: 'debito', valor: 5, subcategoria: 'outro', conta_id: '51975d3c-aed8-4524-be86-ca02daceaf36' }).select(), 'insert movement') })
await t('RECUSADO: convidar utilizadores / mudar acessos (RPC)', async () => {
  ok((await oper.rpc('create_invitation', { p_email: 'qa.nope@example.test', p_roles: ['operador'], p_operation_ids: [ctx.opLN] })).error, 'create_invitation devia falhar')
  ok((await oper.rpc('set_user_access', { p_user: oper.uid, p_roles: ['super_admin'], p_operation_ids: [], p_accounting_read: true })).error, 'set_user_access (auto-promocao) devia falhar')
  ok((await oper.rpc('duplicate_operation', { p_source: ctx.opLN, p_nome: 'QA-dup' })).error, 'duplicate_operation devia falhar')
})
await t('RECUSADO: auto-promover-se editando profile/user_roles', async () => {
  await denied(oper.from('user_roles').insert({ user_id: oper.uid, role: 'super_admin' }).select(), 'insert user_roles')
  const r = await oper.from('profiles').update({ accounting_read: true }).eq('id', oper.uid).select()
  ok(r.error || !r.data?.length, 'operador alterou accounting_read no proprio perfil')
})
await t('RECUSADO: gerir frota (insert/update vehicles)', async () => {
  await denied(oper.from('vehicles').insert({ tenant_id: (await must(oper.from('profiles').select('tenant_id').single())).tenant_id, matricula: 'QA-00-OP', tipo: 'propria' }).select(), 'insert vehicle')
})
await t('Operador de Porto Centro nao ve o registo de Lisboa (isolamento)', async () => {
  eq((await rows(operPC, 'daily_records', (q) => q.eq('id', O1))).n, 0, 'operPC le O1 ' + O1)
})

// ================= GESTOR =================
setArea('Permissoes - Gestor (qa.gestor, Lisboa Norte)')
await t('ve so registos/rotas da sua operacao (nenhum de Porto Centro)', async () => {
  const recs = await rows(gest, 'daily_records'); const rts = await rows(gest, 'routes')
  ok(recs.n > 0, 'gestor nao ve nada')
  const bad = recs.data.filter((r) => [ctx.routePC, '3762bd41-cb04-4a72-866f-150d9a32f763'].includes(r.route_id))
  ok(bad.length === 0, `gestor LN ve ${bad.length} registos de rotas de Porto Centro (ex. ${bad[0]?.id})`)
  ok(rts.data.every((r) => r.operation_id === ctx.opLN), 'gestor LN ve rotas de outra operacao: ' + rts.data.filter((r) => r.operation_id !== ctx.opLN).map((r) => r.id))
})
await t('valida registo da sua operacao (fica validado_por/validado_em)', async () => {
  const r = await must(gest.from('daily_records').update({ status: 'validado' }).eq('id', O1).select('status,validado_por,validado_em').single())
  eq([r.status, r.validado_por, !!r.validado_em], ['validado', gest.uid, true], 'validacao ' + O1)
})
await t('RECUSADO: validar/editar registo de outra operacao', async () => {
  await denied(gest.from('daily_records').update({ status: 'validado' }).eq('id', PCREC).select(), 'validar PC ' + PCREC)
})
await t('edita tarifario da sua operacao mas RECUSADO na de outra', async () => {
  await must(gest.from('routes').update({ nome: 'QA-R-LN' }).eq('id', ctx.routeLN).select().single())
  await denied(gest.from('routes').update({ taxa_km: 9 }).eq('id', ctx.routePC).select(), 'route PC')
  await denied(gest.from('operations').update({ salario_fixo_mensal: 5 }).eq('id', ctx.opPC).select(), 'op PC')
  await denied(gest.from('routes').insert({ operation_id: ctx.opPC, nome: 'QA-gest-x' }).select(), 'criar rota em PC')
})
await t('RECUSADO: mover uma rota sua para outra operacao (nao atribuida)', async () => { await denied(gest.from('routes').update({ operation_id: ctx.opPC }).eq('id', ctx.routeLN).select(), 'mover rota') })
await t('RECUSADO: qualquer acesso a Contabilidade (movements, bank_accounts, accounting_settings) e audit_log', async () => { await zero(gest, ['movements', 'bank_accounts', 'accounting_settings', 'audit_log'], 'gestor') })
await t('RECUSADO: criar movimento / conta bancaria', async () => {
  await denied(gest.from('bank_accounts').insert({ tenant_id: (await must(gest.from('profiles').select('tenant_id').single())).tenant_id, nome: 'QA-x' }).select(), 'bank_accounts')
})
await t('RECUSADO: gestor nao pode duplicar operacao, mudar acessos, criar operacao', async () => {
  ok((await gest.rpc('duplicate_operation', { p_source: ctx.opLN, p_nome: 'QA-dup' })).error, 'duplicate')
  ok((await gest.rpc('set_user_access', { p_user: gest.uid, p_roles: ['super_admin'], p_operation_ids: [], p_accounting_read: true })).error, 'set_user_access')
  await denied(gest.from('operations').insert({ tenant_id: (await must(gest.from('profiles').select('tenant_id').single())).tenant_id, nome: 'QA-gop' }).select(), 'insert op')
})
await t('convites: Gestor convida Operador na sua operacao', async () => { const r = await gest.rpc('create_invitation', { p_email: `qa.invite.${Date.now()}@example.test`, p_roles: ['operador'], p_operation_ids: [ctx.opLN] }); ok(!r.error, r.error?.message) })
await t('RECUSADO: gestor convida Gestor / Contabilista / fora das suas operacoes / accounting_read', async () => {
  for (const [roles, ops_, acc] of [[['gestor'], [ctx.opLN], false], [['contabilista'], [], false], [['operador'], [ctx.opPC], false], [['operador'], [ctx.opLN], true], [['auditor'], [ctx.opLN], false]]) {
    const r = await gest.rpc('create_invitation', { p_email: `qa.invite.${Math.random().toString(36).slice(2, 7)}@example.test`, p_roles: roles, p_operation_ids: ops_, p_accounting_read: acc })
    ok(r.error, `convite ${roles}/${ops_.length}/${acc} foi ACEITE`)
  }
})
await t('Gestor de Porto Centro nao ve LN e so ve os seus (isolamento entre gestores)', async () => {
  const recs = await rows(gestPC, 'daily_records')
  ok(recs.n > 0, 'gestor PC sem dados')
  ok(!recs.data.some((r) => r.id === O1 || r.route_id === ctx.routeLN), 'gestor PC ve registos de LN')
})

// ================= MOTORISTA =================
setArea('Permissoes - Motorista (qa.motorista, Lisboa Norte)')
let MO1
await t('cria o seu registo na sua operacao e edita-o enquanto Rascunho/Submetido', async () => {
  MO1 = (await must(mot.from('daily_records').insert({ route_id: ctx.routeLN, data: '2026-06-10', km: 5 }).select('id').single())).id; ctx.MO1 = MO1
  await must(mot.from('daily_records').update({ km: 6 }).eq('id', MO1).select().single())
  await must(mot.from('daily_records').update({ status: 'submetido' }).eq('id', MO1).select().single())
})
await t('ve APENAS os seus registos (nao ve os do Operador nem de outros)', async () => {
  const r = await rows(mot, 'daily_records')
  ok(r.n >= 1 && r.data.every((x) => x.created_by === mot.uid), 'motorista ve registos de terceiros: ' + r.data.filter((x) => x.created_by !== mot.uid).map((x) => x.id))
})
await t('RECUSADO: Motorista 2 ve/edita o registo do Motorista 1', async () => {
  eq((await rows(mot2, 'daily_records', (q) => q.eq('id', MO1))).n, 0, 'mot2 le MO1 ' + MO1)
  await denied(mot2.from('daily_records').update({ km: 77 }).eq('id', MO1).select(), 'mot2 update MO1')
})
await t('RECUSADO: motorista edita registo do Operador / de outra operacao', async () => {
  await denied(mot.from('daily_records').update({ km: 1 }).eq('id', ctx.O1).select(), 'mot edita O1')
  await denied(mot.from('daily_records').insert({ route_id: ctx.routePC, data: '2026-06-11' }).select(), 'mot cria em PC')
})
await t('RECUSADO: motorista valida o seu proprio registo', async () => { await denied(mot.from('daily_records').update({ status: 'validado' }).eq('id', MO1).select(), 'mot valida') })
await t('RECUSADO: motorista apaga (soft delete / fisico) o seu registo', async () => {
  await denied(mot.from('daily_records').delete().eq('id', MO1).select(), 'delete fisico')
  const r = await mot.from('daily_records').update({ deleted_at: iso() }).eq('id', MO1).select('id')
  if (r.data?.length) { await sql(`update daily_records set deleted_at=null where id='${MO1}'`); throw new Error(`Motorista (qa.motorista) conseguiu soft-delete do proprio registo ${MO1} (mesma causa do Operador: RLS/trigger sem guarda em deleted_at)`) }
})
await t('RECUSADO: depois de Validado o motorista ja nao edita', async () => {
  await must(admin.from('daily_records').update({ status: 'validado' }).eq('id', MO1).select().single())
  await denied(mot.from('daily_records').update({ km: 50 }).eq('id', MO1).select(), 'mot edita validado')
  await denied(mot.from('daily_record_costs').insert({ record_id: MO1, categoria: 'x', valor: 1 }).select(), 'mot custo em validado')
})
await t('RECUSADO: nenhum outro menu/dado (operations, routes, tariff, goals, vehicles, movements, bank, audit, fleet, invitations)', async () => {
  await zero(mot, ['operations', 'routes', 'tariff_snapshots', 'goals', 'postal_zones', 'vehicles', 'fleet_slots', 'slot_assignments', 'movements', 'bank_accounts', 'accounting_settings', 'audit_log', 'invitations'], 'motorista')
})
await t('RECUSADO: ve so o seu profile/driver/roles (nao os de colegas)', async () => {
  eq((await rows(mot, 'profiles')).data.map((x) => x.id), [mot.uid], 'profiles')
  const d = await rows(mot, 'drivers'); ok(d.data.every((x) => x.user_id === mot.uid), 'motorista le drivers de terceiros')
  eq((await rows(mot, 'user_roles')).data.map((x) => x.user_id), [mot.uid], 'user_roles')
})
await t('vistas de opcoes: so a sua operacao, sem custos de viatura, so ele proprio como motorista', async () => {
  const ro = await rows(mot, 'route_options'); ok(ro.data.every((x) => x.operation_id === ctx.opLN), 'route_options de outra operacao')
  const vo = await rows(mot, 'vehicle_options'); ok(!vo.data.some((x) => 'iuc_valor' in x || 'seguro_valor' in x || 'aluguer_custo' in x), 'vehicle_options expoe custos')
  const dop = await rows(mot, 'driver_options'); ok(dop.data.every((x) => x.user_id === mot.uid), 'driver_options mostra outros motoristas')
})
await t('RECUSADO: notificacoes e RPC de gestao', async () => {
  ok((await mot.rpc('create_invitation', { p_email: 'qa.nope2@example.test', p_roles: ['motorista'], p_operation_ids: [ctx.opLN] })).error, 'invite')
})

// ================= CONTABILISTA =================
setArea('Permissoes - Contabilista (qa.contabilista)')
await t('RECUSADO: nenhum dado operacional (daily_records, routes, operations, vehicles, tariff, goals, fleet)', async () => { await zero(cont, ['daily_records', 'daily_record_costs', 'routes', 'operations', 'tariff_snapshots', 'goals', 'postal_zones', 'vehicles', 'fleet_slots', 'slot_assignments', 'audit_log'], 'contabilista') })
await t('RECUSADO: criar/editar registo diario, rota, viatura', async () => {
  await denied(cont.from('daily_records').insert({ route_id: ctx.routeLN, data: '2026-06-20' }).select(), 'insert record')
  await denied(cont.from('daily_records').update({ km: 1 }).eq('id', ctx.O1).select(), 'update record')
  await denied(cont.from('routes').update({ taxa_km: 1 }).eq('id', ctx.routeLN).select(), 'update route')
})
await t('acede a Contabilidade do tenant (movements, bank_accounts)', async () => { ok((await rows(cont, 'movements')).n > 0, 'sem movimentos'); ok((await rows(cont, 'bank_accounts')).n > 0, 'sem contas') })
await t('RECUSADO: alterar limite de validacao (so Super Admin)', async () => { await denied(cont.from('accounting_settings').update({ validation_threshold: 1 }).neq('tenant_id', '00000000-0000-0000-0000-000000000000').select(), 'threshold') })
await t('NOTA: o Contabilista le a lista de motoristas (drivers) e nomes de operacoes/rotas via *_options (necessario para lancamentos)', async () => {
  const d = await rows(cont, 'drivers'); const ro = await rows(cont, 'route_options'); return `drivers=${d.n}, route_options=${ro.n} (decisao de desenho: drivers_select inclui contabilista; route_options expoe valor_fixo_default)`
})

// ================= AUDITOR =================
setArea('Permissoes - Auditor (sem/com accounting_read)')
await t('Auditor le registos da sua operacao e nada de outras', async () => {
  const r = await rows(aud, 'daily_records'); ok(r.n > 0, 'auditor sem dados')
  ok(!r.data.some((x) => x.route_id === ctx.routePC), 'auditor LN ve registo PC')
  const ops_ = await rows(aud, 'operations'); ok(ops_.data.every((o) => o.id === ctx.opLN), 'auditor ve outras operacoes')
})
await t('RECUSADO: auditor escreve (insert/update registo, rota, operacao, viatura, movimento, meta)', async () => {
  await denied(aud.from('daily_records').insert({ route_id: ctx.routeLN, data: '2026-06-25' }).select(), 'insert record')
  await denied(aud.from('daily_records').update({ km: 1 }).eq('id', ctx.MO1).select(), 'update record')
  await denied(aud.from('daily_records').update({ status: 'validado' }).eq('id', ctx.O1).select(), 'validar')
  await denied(aud.from('routes').update({ taxa_km: 1 }).eq('id', ctx.routeLN).select(), 'update route')
  await denied(aud.from('operations').update({ salario_fixo_mensal: 1 }).eq('id', ctx.opLN).select(), 'update op')
  await denied(aud.from('goals').insert({ operation_id: ctx.opLN, metrica: 'receita', alvo: 1 }).select(), 'insert goal')
  await denied(aud.from('daily_record_costs').insert({ record_id: ctx.O1, categoria: 'x', valor: 1 }).select(), 'insert custo')
})
await t('RECUSADO: auditor sem accounting_read nao ve Contabilidade', async () => { await zero(aud, ['movements', 'bank_accounts', 'accounting_settings', 'audit_log'], 'auditor') })
await t('auditor com accounting_read le Contabilidade mas RECUSADO escrever', async () => {
  const m = await rows(audAcc, 'movements'); ok(m.n > 0, 'auditor(acc) nao le movimentos')
  const tid = (await must(audAcc.from('profiles').select('tenant_id').single())).tenant_id
  await denied(audAcc.from('movements').insert({ tenant_id: tid, data: '2026-06-01', tipo: 'debito', valor: 5, subcategoria: 'outro', conta_id: '51975d3c-aed8-4524-be86-ca02daceaf36' }).select(), 'insert movement')
  await denied(audAcc.from('movements').update({ estado: 'confirmado' }).eq('id', m.data[0].id).select(), 'validar movimento')
  await denied(audAcc.from('accounting_settings').update({ validation_threshold: 1 }).neq('tenant_id', tid).select(), 'threshold')
  await denied(audAcc.from('bank_accounts').update({ nome: 'QA-hack' }).eq('id', '51975d3c-aed8-4524-be86-ca02daceaf36').select(), 'bank update')
})
await t('RECUSADO: auditor com accounting_read continua sem operacional fora das suas operacoes', async () => { eq((await rows(audAcc, 'daily_records', (q) => q.eq('route_id', ctx.routePC))).n, 0, 'auditor(acc) le PC') })

// ================= SUPER ADMIN =================
setArea('Permissoes - Super Admin')
await t('Super Admin ve ambas as operacoes', async () => { const r = await rows(admin, 'routes'); ok(r.data.some((x) => x.operation_id === ctx.opLN) && r.data.some((x) => x.operation_id === ctx.opPC), 'nao ve as 2 operacoes') })
await t('Super Admin faz soft delete de um registo (QA) com audit', async () => {
  const r = await must(admin.from('daily_records').update({ deleted_at: iso() }).eq('id', PCREC).select('id,deleted_at').single()); ok(r.deleted_at, 'sem deleted_at')
})
await t('RECUSADO ate para Super Admin: DELETE fisico (varias tabelas) e alterar audit_log', async () => {
  for (const tb_ of ['daily_records', 'routes', 'operations', 'movements', 'vehicles', 'drivers', 'bank_accounts', 'profiles', 'audit_log', 'tariff_snapshots']) {
    const r = await admin.from(tb_).delete().not('id', 'is', null).select(); ok(r.error || !r.data?.length, `DELETE fisico em ${tb_} devolveu linhas`)
  }
  const a = await must(admin.from('audit_log').select('id').limit(1))
  ok((await admin.from('audit_log').update({ acao: 'X' }).eq('id', a[0].id).select()).error || true, '')
  const u = await admin.from('audit_log').update({ acao: 'X' }).eq('id', a[0].id).select(); ok(u.error || !u.data?.length, 'audit_log editavel')
})
await t('anonimo (sem login) nao le nada', async () => {
  const an = anonClient(); for (const tb_ of ['daily_records', 'routes', 'operations', 'movements', 'vehicles', 'drivers', 'profiles', 'audit_log', 'route_options', 'vehicle_options', 'tariff_snapshots']) { const r = await rows(an, tb_); ok(r.n <= 0, `anon le ${tb_}`) }
})

// ================= ISOLAMENTO ENTRE TENANTS =================
setArea('Isolamento - entre Tenants (qa.tenantb vs Empresa Demo)')
const tenantB = (await must(tb.from('profiles').select('tenant_id').single())).tenant_id
await t('Tenant B nao le NENHUM dado do Tenant A (todas as tabelas)', async () => {
  const A = (await must(admin.from('profiles').select('tenant_id').eq('id', admin.uid).single())).tenant_id
  // varias tabelas nao tem coluna tenant_id: o tenant de cada linha resolve-se por SQL
  const O = '(select o.tenant_id from operations o where o.id=x.operation_id)', RT = '(select o.tenant_id from routes r join operations o on o.id=r.operation_id where r.id=x.route_id)'
  const tenantOf = { operations: 'x.tenant_id', routes: O, daily_records: RT, daily_record_costs: '(select o.tenant_id from daily_records d join routes r on r.id=d.route_id join operations o on o.id=r.operation_id where d.id=x.record_id)', vehicles: 'x.tenant_id', drivers: 'x.tenant_id', fleet_slots: 'x.tenant_id', slot_assignments: 'x.tenant_id', movements: 'x.tenant_id', bank_accounts: 'x.tenant_id', tariff_snapshots: RT, goals: O, postal_zones: O, accounting_settings: 'x.tenant_id', invitations: 'x.tenant_id' }
  for (const [tb_, expr] of Object.entries(tenantOf)) {
    const idcol = tb_ === 'accounting_settings' ? 'tenant_id' : 'id'
    const r = await rows(tb, tb_); if (!r.data.length) continue
    const bad = await sql(`select x.${idcol}::text id from ${tb_} x where x.${idcol}::text in (${r.data.map((y) => `'${y[idcol]}'`).join(',')}) and ${expr} = '${A}'`)
    eq(bad.length, 0, `Tenant B le ${bad.length} linhas do tenant A em ${tb_} (ex.: ${bad[0]?.id})`)
  }
  const p = await rows(tb, 'profiles'); eq(p.data.map((x) => x.tenant_id), [tenantB], 'profiles')
  const al = await rows(tb, 'audit_log'); ok(al.data.every((x) => x.tenant_id === tenantB), 'audit_log de outro tenant: ' + al.data.find((x) => x.tenant_id !== tenantB)?.id)
  const nt = await rows(tb, 'notifications'); ok(nt.data.every((x) => x.user_id === tb.uid), 'notificacoes de outros')
  // o Tenant B pode ter os seus proprios motoristas/operacoes: o que nao pode e ver os do A (resolve-se o tenant por SQL)
  const Aid = (await must(admin.from('profiles').select('tenant_id').eq('id', admin.uid).single())).tenant_id
  const VT = { operation_options: 'operations', route_options: 'routes', vehicle_options: 'vehicles', driver_options: 'drivers' }
  const OWNER = { operations: 'x.tenant_id', routes: '(select o.tenant_id from operations o where o.id=x.operation_id)', vehicles: 'x.tenant_id', drivers: 'x.tenant_id' }
  for (const [v, tbl] of Object.entries(VT)) {
    const r = await rows(tb, v); if (!r.data.length) continue
    const bad = await sql(`select x.id::text id from ${tbl} x where x.id::text in (${r.data.map((y) => `'${y.id}'`).join(',')}) and ${OWNER[tbl]} = '${Aid}'`)
    eq(bad.length, 0, `Tenant B le ${bad.length} linhas de ${v} do tenant A (ex.: ${bad[0]?.id})`)
  }
})
await t('RECUSADO: Tenant B escreve em registos/rotas/operacoes/movimentos do Tenant A', async () => {
  await denied(tb.from('daily_records').insert({ route_id: ctx.routeLN, data: '2026-07-01' }).select(), 'insert record em rota de A')
  await denied(tb.from('daily_records').update({ km: 1 }).eq('id', ctx.O1).select(), 'update record A')
  await denied(tb.from('routes').update({ taxa_km: 1 }).eq('id', ctx.routeLN).select(), 'update route A')
  await denied(tb.from('operations').update({ nome: 'hack' }).eq('id', ctx.opLN).select(), 'update op A')
  await denied(tb.from('routes').insert({ operation_id: ctx.opLN, nome: 'QA-hackB' }).select(), 'insert route em op A')
  const tid = (await must(admin.from('profiles').select('tenant_id').eq('id', admin.uid).single())).tenant_id
  await denied(tb.from('movements').insert({ tenant_id: tid, data: '2026-07-01', tipo: 'debito', valor: 5, subcategoria: 'outro', conta_id: '51975d3c-aed8-4524-be86-ca02daceaf36' }).select(), 'movimento em tenant A')
  await denied(tb.from('movements').insert({ tenant_id: tenantB, data: '2026-07-01', tipo: 'debito', valor: 5, subcategoria: 'outro', operation_id: ctx.opLN, conta_id: '51975d3c-aed8-4524-be86-ca02daceaf36' }).select(), 'movimento B com operation_id de A / conta de A')
})
await t('RECUSADO: convidar para operacoes do Tenant A / RPC cross-tenant', async () => {
  ok((await tb.rpc('create_invitation', { p_email: 'qa.invite.b@example.test', p_roles: ['operador'], p_operation_ids: [ctx.opLN] })).error, 'convite B->op A aceite')
  ok((await tb.rpc('set_user_access', { p_user: oper.uid, p_roles: ['super_admin'], p_operation_ids: [], p_accounting_read: true })).error, 'set_user_access cross-tenant')
  ok((await tb.rpc('duplicate_operation', { p_source: ctx.opLN, p_nome: 'QA-dupB' })).error, 'duplicate cross-tenant')
  const r = await tb.rpc('set_user_active', { p_user: oper.uid, p_active: false }); const still = await sql(`select deleted_at from profiles where id='${oper.uid}'`); ok(still[0].deleted_at === null, 'set_user_active cross-tenant DESATIVOU qa.operador ' + oper.uid)
})

// ---- escrita cruzada via campos de referencia dos movimentos (rota_id / conta_id de outro tenant ou operacao) ----
setArea('Isolamento - referencias cruzadas em movimentos (alocacoes)')
const bOp = await must(tb.from('operations').insert({ tenant_id: tenantB, nome: 'QA-B-Op' }).select('id').single())
const bAcc = await must(tb.from('bank_accounts').insert({ tenant_id: tenantB, nome: 'QA-B-Conta' }).select('id').single())
const bTr = await must(tb.from('movements').insert({ tenant_id: tenantB, data: '2026-05-01', conta_id: bAcc.id, tipo: 'debito', valor: 100, subcategoria: 'transferencia_distribuicao', pessoa_responsavel: 'QA-B' }).select('id').single())
ctx.bOp = bOp.id; ctx.bAcc = bAcc.id; ctx.bTr = bTr.id
await t('Tenant B: alocacao com rota_id de uma rota do Tenant A NAO pode gravar linha de custo no registo do Tenant A', async () => {
  // registo LN de 2026-05-01 existe (RMIN) no tenant A
  const r = await tb.from('movements').insert({ tenant_id: tenantB, data: '2026-05-01', conta_id: bAcc.id, tipo: 'debito', valor: 7.77, subcategoria: 'outro', pessoa_responsavel: 'QA-B', operation_id: bOp.id, rota_id: ctx.routeLN, lancamento_referencia_id: bTr.id, descricao: 'QA-cross-tenant' }).select('id')
  const leaked = await sql(`select c.id, c.record_id, c.valor from daily_record_costs c where c.valor = 7.77 and c.record_id = '${ctx.RMIN}'`)
  if (leaked.length || (!r.error && r.data?.length)) throw new Error(`Utilizador do Tenant B (qa.tenantb, tenant ${tenantB}) inseriu movimento ${r.data?.[0]?.id} com rota_id=${ctx.routeLN} (rota do Tenant A) e ${leaked.length ? `foi criada a daily_record_costs ${leaked[0].id} no registo ${leaked[0].record_id} do Tenant A` : 'a insercao foi aceite'}. mov_insert so valida operation_id (op_in_tenant); rota_id/conta_id/motorista_id/lancamento_referencia_id nao sao validados contra o tenant.`)
})
await t('Tenant B: movimento com conta_id de outro tenant (conta do Tenant A) e recusado', async () => {
  const r = await tb.from('movements').insert({ tenant_id: tenantB, data: '2026-05-01', conta_id: '51975d3c-aed8-4524-be86-ca02daceaf36', tipo: 'debito', valor: 3.33, subcategoria: 'outro', descricao: 'QA-cross-conta' }).select('id')
  if (!r.error && r.data?.length) throw new Error(`qa.tenantb criou movimento ${r.data[0].id} (tenant B) associado a bank_accounts ${'51975d3c-aed8-4524-be86-ca02daceaf36'} do Tenant A (FK sem validacao de tenant)`)
})
await t('Mesmo tenant: alocacao com operation_id = Porto Centro mas rota_id = rota de Lisboa Norte nao deve misturar operacoes', async () => {
  const before = await sql(`select count(*)::int n from daily_record_costs where record_id='${ctx.RMIN}'`)
  const tid = (await must(admin.from('profiles').select('tenant_id').eq('id', admin.uid).single())).tenant_id
  const tr = await must(admin.from('movements').insert({ tenant_id: tid, data: '2026-05-01', conta_id: '51975d3c-aed8-4524-be86-ca02daceaf36', tipo: 'debito', valor: 50, subcategoria: 'transferencia_distribuicao', pessoa_responsavel: 'QA-X', descricao: 'QA-transf-iso' }).select('id').single())
  ctx.isoTr = tr.id
  const r = await admin.from('movements').insert({ tenant_id: tid, data: '2026-05-01', conta_id: '51975d3c-aed8-4524-be86-ca02daceaf36', tipo: 'debito', valor: 8.88, subcategoria: 'outro', pessoa_responsavel: 'QA-X', operation_id: ctx.opPC, rota_id: ctx.routeLN, lancamento_referencia_id: tr.id, descricao: 'QA-alloc-op-rota-incoerente' }).select('id')
  const after = await sql(`select count(*)::int n from daily_record_costs where record_id='${ctx.RMIN}'`)
  if (!r.error && r.data?.length) { ctx.isoAlloc = r.data[0].id; throw new Error(`movimento ${r.data[0].id} aceite com operation_id=${ctx.opPC} (Porto Centro) e rota_id=${ctx.routeLN} (pertence a Lisboa Norte ${ctx.opLN}); linha de custo propagada para o registo LN ${ctx.RMIN}: ${after[0].n - before[0].n > 0 ? 'SIM' : 'nao'}. Falta CHECK/trigger rota pertence a operacao.`) }
})

writeFileSync(new URL('./ctx.json', import.meta.url), JSON.stringify(ctx, null, 2))
save('./results-02.json')
