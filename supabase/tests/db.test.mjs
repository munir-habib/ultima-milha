// Testes das migracoes (RLS, tarifario, workflow, audit) em Postgres real (PGlite).
// Correr: npm run test:db
import { PGlite } from '@electric-sql/pglite'
import { readFileSync, readdirSync } from 'node:fs'
import { test, before } from 'node:test'
import assert from 'node:assert/strict'

const dir = new URL('../migrations/', import.meta.url)
const db = new PGlite()

// Stubs do Supabase (auth schema, roles, auth.uid())
const STUB = `
create schema auth;
create table auth.users (id uuid primary key default gen_random_uuid(), email text, raw_user_meta_data jsonb default '{}');
create function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create role anon nologin; create role authenticated nologin;
grant usage on schema public, auth to anon, authenticated;
alter default privileges in schema public grant all on tables to anon, authenticated;
`

const ids = {}
async function signup(key, email, meta = {}) {
  const r = await db.query(`insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id`, [email, meta])
  ids[key] = r.rows[0].id
}
// Corre fn como utilizador autenticado (RLS ativo)
async function as(key, fn) {
  await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '${ids[key]}', false)`)
  try { return await fn() } finally { await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false)`) }
}
const q = (sql, params) => db.query(sql, params).then((r) => r.rows)
async function rejects(fn, re) {
  await assert.rejects(fn, (e) => { if (re) assert.match(String(e.message), re); return true })
}

before(async () => {
  await db.exec(STUB)
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    try { await db.exec(readFileSync(new URL(f, dir), 'utf8')) }
    catch (e) { throw new Error(`migration ${f}: ${e.message}`) }
  }
  await db.exec(`alter default privileges in schema public grant all on tables to anon, authenticated`)

  // Tenant A
  await signup('admin', 'admin@a.pt', { full_name: 'Admin A', tenant_name: 'Empresa A' })
  const tenantA = (await q(`select tenant_id from profiles where id=$1`, [ids.admin]))[0].tenant_id
  ids.tenantA = tenantA

  await as('admin', async () => {
    ids.op1 = (await q(`insert into operations (tenant_id, nome, valores_estado) values ($1,'Op 1',
      '{"entregues":2,"devolucoes":1,"recolhas":1.5,"canceladas":0,"transitadas":0,"pendentes_entrega":0,"pendentes_recolha":0}') returning id`, [tenantA]))[0].id
    ids.op2 = (await q(`insert into operations (tenant_id, nome) values ($1,'Op 2') returning id`, [tenantA]))[0].id
    ids.zonaNorte = (await q(`insert into postal_zones (operation_id, nome, prefixos, valor_por_entrega) values ($1,'Norte','{4000,4100}',3) returning id`, [ids.op1]))[0].id
    ids.rota1 = (await q(`insert into routes (operation_id, nome, tarifa_por_estado, tarifa_valor_fixo, tarifa_por_zona, tarifa_por_distancia,
      valor_fixo_default, taxa_km) values ($1,'Rota 1', true, true, true, true, 40, 0.5) returning id`, [ids.op1]))[0].id
    ids.rota2 = (await q(`insert into routes (operation_id, nome) values ($1,'Rota 2') returning id`, [ids.op2]))[0].id
    ids.bank = (await q(`insert into bank_accounts (tenant_id, nome) values ($1,'Conta 1') returning id`, [tenantA]))[0].id
    await q(`select create_invitation('gestor@a.pt', '{gestor}', $1)`, [[ids.op1]])
    await q(`select create_invitation('oper@a.pt', '{operador}', $1)`, [[ids.op1]])
    await q(`select create_invitation('mot@a.pt', '{motorista}', $1)`, [[ids.op1]])
    await q(`select create_invitation('conta@a.pt', '{contabilista}')`)
    await q(`select create_invitation('aud@a.pt', '{auditor}', $1)`, [[ids.op1]])
  })
  await signup('gestor', 'gestor@a.pt'); await signup('oper', 'oper@a.pt'); await signup('mot', 'mot@a.pt')
  await signup('conta', 'conta@a.pt'); await signup('aud', 'aud@a.pt')
  // Tenant B (isolamento)
  await signup('adminB', 'admin@b.pt', { tenant_name: 'Empresa B' })
})

test('primeiro utilizador e Super Admin de um novo tenant; convidados herdam papel e operacoes', async () => {
  assert.deepEqual((await q(`select role from user_roles where user_id=$1`, [ids.admin])).map((r) => r.role), ['super_admin'])
  assert.deepEqual((await q(`select role from user_roles where user_id=$1`, [ids.gestor])).map((r) => r.role), ['gestor'])
  assert.equal((await q(`select tenant_id from profiles where id=$1`, [ids.gestor]))[0].tenant_id, ids.tenantA)
  assert.equal((await q(`select count(*)::int n from user_operations where user_id=$1`, [ids.gestor]))[0].n, 1)
  assert.equal((await q(`select count(*)::int n from drivers where user_id=$1`, [ids.mot]))[0].n, 1)
})

test('receita = soma dos componentes ativos, calculada no servidor', async () => {
  const r = await as('oper', () => q(`insert into daily_records (route_id, data, km, enc_entregues, enc_devolucoes, enc_recolhas,
      valor_fixo_do_dia, entregas_por_zona, receita_total)
      values ($1, '2026-09-01', 100, 10, 4, 2, 40, $2, 999999) returning receita_total, receita_breakdown`,
    [ids.rota1, { [ids.zonaNorte]: 5 }]))
  // estado: 10*2 + 4*1 + 2*1.5 = 27 ; fixo 40 ; zona 5*3 = 15 ; km 100*0.5 = 50 -> 132 (cliente nao consegue forcar 999999)
  assert.equal(Number(r[0].receita_total), 132)
  assert.deepEqual(r[0].receita_breakdown, { por_estado: 27, valor_fixo: 40, por_zona: 15, por_distancia: 50, total: 132 })
})

test('escaloes de km progressivos', async () => {
  await as('admin', () => q(`update routes set taxa_km=null, escaloes_km='[{"de":0,"ate":50,"valor":1},{"de":50,"ate":null,"valor":0.5}]' where id=$1`, [ids.rota1]))
  const today = (await q(`select app.today()::text d`))[0].d
  const r = await as('admin', () => q(`insert into daily_records (route_id, data, km) values ($1,$2,80) returning receita_breakdown`, [ids.rota1, today]))
  assert.equal(Number(r[0].receita_breakdown.por_distancia), 65) // 50*1 + 30*0.5
})

test('integridade historica: mudar o tarifario nunca recalcula registos antigos', async () => {
  const before = await q(`select receita_total from daily_records where route_id=$1 and data='2026-09-01'`, [ids.rota1])
  await as('admin', () => q(`update operations set valores_estado = jsonb_set(valores_estado, '{entregues}', '10') where id=$1`, [ids.op1]))
  // o registo antigo mantem-se, mesmo depois de editar um campo nao-tarifario
  await as('oper', () => q(`update daily_records set comb_valor=30, comb_litros=20 where route_id=$1 and data='2026-09-01'`, [ids.rota1]))
  const after = await q(`select receita_total from daily_records where route_id=$1 and data='2026-09-01'`, [ids.rota1])
  assert.equal(after[0].receita_total, before[0].receita_total)
  // registo retroativo (data anterior a mudanca) usa a versao em vigor nessa data: 1 entrega * 2
  const retro = await as('oper', () => q(`insert into daily_records (route_id, data, enc_entregues) values ($1,'2026-09-03',1) returning receita_breakdown`, [ids.rota1]))
  assert.equal(Number(retro[0].receita_breakdown.por_estado), 2)
  // registo futuro usa o valor novo: 1 entrega * 10
  const fut = await as('oper', () => q(`insert into daily_records (route_id, data, enc_entregues) values ($1, app.today() + 1, 1) returning receita_breakdown`, [ids.rota1]))
  assert.equal(Number(fut[0].receita_breakdown.por_estado), 10)
})

test('motorista: so o proprio registo, sem menus/definicoes, nao valida', async () => {
  const rec = await as('mot', () => q(`insert into daily_records (route_id, data, km) values ($1,'2026-09-05',10) returning id, created_by, status`, [ids.rota1]))
  assert.equal(rec[0].created_by, ids.mot)
  ids.recMot = rec[0].id
  // so ve o seu
  assert.equal((await as('mot', () => q(`select count(*)::int n from daily_records`)))[0].n, 1)
  // nao ve definicoes nem tarifario, mas ve as opcoes para registar
  assert.equal((await as('mot', () => q(`select count(*)::int n from operations`)))[0].n, 0)
  assert.equal((await as('mot', () => q(`select count(*)::int n from routes`)))[0].n, 0)
  assert.ok((await as('mot', () => q(`select count(*)::int n from route_options`)))[0].n >= 1)
  // nao valida
  await rejects(() => as('mot', () => q(`update daily_records set status='validado' where id=$1`, [ids.recMot])), /validar|row-level/)
  // pode editar enquanto nao validado, incluindo submeter
  await as('mot', () => q(`update daily_records set status='submetido', enc_entregues=3 where id=$1`, [ids.recMot]))
  // contabilidade invisivel
  assert.equal((await as('mot', () => q(`select count(*)::int n from movements`)))[0].n, 0)
})

test('operador nao valida nem ve definicoes; gestor valida; editar validado reabre e notifica', async () => {
  await rejects(() => as('oper', () => q(`update daily_records set status='validado' where id=$1`, [ids.recMot])), /validar|row-level/)
  assert.equal((await as('oper', () => q(`select count(*)::int n from operations`)))[0].n, 0)
  await as('gestor', () => q(`update daily_records set status='validado' where id=$1`, [ids.recMot]))
  assert.equal((await q(`select status, validado_por from daily_records where id=$1`, [ids.recMot]))[0].validado_por, ids.gestor)
  // motorista ja nao edita
  const n = await as('mot', () => q(`update daily_records set km=99 where id=$1 returning id`, [ids.recMot]))
  assert.equal(n.length, 0)
  // admin edita registo validado -> volta a Submetido e avisa o gestor
  await as('admin', () => q(`update daily_records set km=55 where id=$1`, [ids.recMot]))
  const rec = (await q(`select status from daily_records where id=$1`, [ids.recMot]))[0]
  assert.equal(rec.status, 'submetido')
  assert.equal((await q(`select count(*)::int n from notifications where user_id=$1 and tipo='record_reopened'`, [ids.gestor]))[0].n, 1)
})

test('isolamento por operacao e por tenant', async () => {
  // gestor/operador nao veem a Op 2
  assert.equal((await as('gestor', () => q(`select count(*)::int n from routes where id=$1`, [ids.rota2])))[0].n, 0)
  await rejects(() => as('oper', () => q(`insert into daily_records (route_id, data) values ($1,'2026-09-01')`, [ids.rota2])), /row-level/)
  // Tenant B nao ve nada do A
  for (const t of ['operations', 'routes', 'daily_records', 'vehicles', 'movements', 'tenants', 'profiles'])
    assert.equal((await as('adminB', () => q(`select count(*)::int n from ${t}`)))[0].n, t === 'profiles' || t === 'tenants' ? 1 : 0, t)
  assert.equal((await as('adminB', () => q(`select count(*)::int n from audit_log where tenant_id = $1`, [ids.tenantA])))[0].n, 0)
})

test('auditor: leitura apenas', async () => {
  assert.ok((await as('aud', () => q(`select count(*)::int n from daily_records`)))[0].n >= 1)
  await rejects(() => as('aud', () => q(`insert into daily_records (route_id, data) values ($1,'2026-09-10')`, [ids.rota1])), /row-level/)
  assert.equal((await as('aud', () => q(`select count(*)::int n from movements`)))[0].n, 0) // sem accounting_read
})

test('contabilista: so contabilidade; nao apaga; super admin faz soft delete', async () => {
  assert.equal((await as('conta', () => q(`select count(*)::int n from daily_records`)))[0].n, 0)
  assert.equal((await as('conta', () => q(`select count(*)::int n from routes`)))[0].n, 0)
  assert.ok((await as('conta', () => q(`select count(*)::int n from route_options`)))[0].n >= 1) // nomes para alocacoes
  const m = await as('conta', () => q(`insert into movements (tenant_id, data, conta_id, tipo, valor, subcategoria, descricao)
      values ($1,'2026-09-10',$2,'debito',50,'manutencao','Oficina') returning id, created_by, origem`, [ids.tenantA, ids.bank]))
  assert.equal(m[0].created_by, ids.conta)
  assert.equal(m[0].origem, 'manual_geral') // decidida pelo servidor (sem operacao)
  await rejects(() => as('conta', () => q(`update movements set deleted_at=now(), motivo_apagado='teste' where id=$1`, [m[0].id])), /Super Admin/)
  await rejects(() => as('admin', () => q(`update movements set deleted_at=now() where id=$1`, [m[0].id])), /motivo obrigatorio/)
  await as('admin', () => q(`update movements set deleted_at=now(), motivo_apagado='lancamento duplicado' where id=$1`, [m[0].id]))
  await rejects(() => q(`delete from movements where id=$1`, [m[0].id]), /apagar fisicamente/)
  await rejects(() => as('admin', () => q(`delete from movements where id=$1`, [m[0].id])), /permission|apagar/)
  // rota sem operacao e recusada (a origem ja nao e escolhida pelo cliente: ver teste de F10)
  await rejects(() => as('conta', () => q(`insert into movements (tenant_id, data, conta_id, tipo, valor, subcategoria, rota_id)
      values ($1,'2026-09-10',$2,'debito',5,'outro',$3)`, [ids.tenantA, ids.bank, ids.rota1])), /rota nao pertence|check/)
})

test('distribuicao de fundos: alocacao nasce Pendente, fica por ligar e anexa-se quando o registo diario nasce', async () => {
  await q(`delete from notifications`)
  const t = await as('conta', () => q(`insert into movements (tenant_id, data, conta_id, tipo, valor, subcategoria, pessoa_responsavel)
      values ($1,'2026-09-12',$2,'debito',300,'transferencia_distribuicao','Joao') returning id, estado`, [ids.tenantA, ids.bank]))
  assert.equal(t[0].estado, 'confirmado') // transferencia manual: ja revista pelo Contabilista
  const alloc = await as('conta', () => q(`insert into movements (tenant_id, data, conta_id, tipo, valor, subcategoria, pessoa_responsavel,
      lancamento_referencia_id, operation_id, rota_id, estado) values ($1,'2026-09-12',$2,'debito',120,'outro','Joao',$3,$4,$5,'confirmado') returning id, estado, registo_id`,
    [ids.tenantA, ids.bank, t[0].id, ids.op1, ids.rota1]))
  // o cliente nao consegue forcar Confirmado: alocacao nasce SEMPRE Pendente
  assert.equal(alloc[0].estado, 'pendente')
  // sem registo diario: NAO se cria nenhum registo; fica "por ligar"
  assert.equal(alloc[0].registo_id, null)
  assert.equal((await q(`select count(*)::int n from daily_records where route_id=$1 and data='2026-09-12'`, [ids.rota1]))[0].n, 0)
  // notifica TODOS os Super Admin E Contabilistas
  const dest = (await q(`select user_id from notifications where tipo='movement_pending' and (payload->>'movement_id')=$1`, [alloc[0].id])).map((r) => r.user_id).sort()
  assert.deepEqual(dest, [ids.admin, ids.conta].sort())
  // o registo diario e criado mais tarde -> a alocacao e anexada (linha de custo + registo_id)
  const rec = await as('oper', () => q(`insert into daily_records (route_id, data, enc_entregues) values ($1,'2026-09-12',5) returning id`, [ids.rota1]))
  const c = await q(`select c.categoria, c.valor from daily_record_costs c where c.record_id=$1`, [rec[0].id])
  assert.equal(c.length, 1); assert.match(c[0].categoria, /Pagamento distribuído — Joao/); assert.equal(Number(c[0].valor), 120)
  assert.equal((await q(`select registo_id from movements where id=$1`, [alloc[0].id]))[0].registo_id, rec[0].id)
  // copia inicial: editar a linha de custo nao altera a alocacao (e vice-versa)
  await as('oper', () => q(`update daily_record_costs set valor=99 where record_id=$1`, [rec[0].id]))
  assert.equal(Number((await q(`select valor from movements where id=$1`, [alloc[0].id]))[0].valor), 120)
  // valida (so Contabilista/Super Admin): fica registado quem e quando
  await as('conta', () => q(`update movements set estado='confirmado' where id=$1`, [alloc[0].id]))
  const v = (await q(`select estado, validado_por, validado_em from movements where id=$1`, [alloc[0].id]))[0]
  assert.equal(v.estado, 'confirmado'); assert.equal(v.validado_por, ids.conta); assert.ok(v.validado_em)
  // reclassificar (rota/operacao) uma alocacao validada NAO lhe tira a validacao
  const rotaX = (await q(`select id from routes where operation_id=$1 and nome='Rota 2' limit 1`, [ids.op2]))[0]?.id ?? ids.rota2
  await as('conta', () => q(`update movements set rota_id=$2, operation_id=$3 where id=$1`, [alloc[0].id, rotaX, ids.op2]))
  assert.equal((await q(`select estado from movements where id=$1`, [alloc[0].id]))[0].estado, 'confirmado')
  await as('conta', () => q(`update movements set rota_id=$2, operation_id=$3 where id=$1`, [alloc[0].id, ids.rota1, ids.op1]))
  // ...mas mudar o que foi validado (valor) volta a exigir validacao e a notificar
  await q(`delete from notifications`)
  await as('conta', () => q(`update movements set valor=130 where id=$1`, [alloc[0].id]))
  assert.equal((await q(`select estado from movements where id=$1`, [alloc[0].id]))[0].estado, 'pendente')
  assert.equal((await q(`select count(*)::int n from notifications where tipo='movement_pending'`))[0].n, 2)
})

test('viaturas: custos independentes, aluguer so em Alugadas, historico do posto', async () => {
  await rejects(() => as('gestor', () => q(`insert into vehicles (tenant_id, matricula, tipo, aluguer_custo) values ($1,'AA-00-AA','propria',100)`, [ids.tenantA])), /check/)
  const slot = await as('gestor', () => q(`insert into fleet_slots (tenant_id, nome) values ($1,'Carro 2') returning id`, [ids.tenantA]))
  const v1 = await as('gestor', () => q(`insert into vehicles (tenant_id, matricula, posto_id, iuc_ativo, iuc_valor) values ($1,'11-AA-22',$2,true,100) returning id`, [ids.tenantA, slot[0].id]))
  const v2 = await as('gestor', () => q(`insert into vehicles (tenant_id, matricula, tipo, aluguer_custo, aluguer_periodicidade) values ($1,'33-BB-44','alugada',20,'diario') returning id`, [ids.tenantA]))
  await as('gestor', () => q(`update vehicles set posto_id=null where id=$1`, [v1[0].id]))
  await as('gestor', () => q(`update vehicles set posto_id=$2 where id=$1`, [v2[0].id, slot[0].id]))
  assert.equal((await q(`select count(*)::int n from slot_assignments where posto_id=$1`, [slot[0].id]))[0].n, 2)
  // operador ve viaturas mas nao edita; motorista nao ve custos (so via view)
  assert.equal((await as('mot', () => q(`select count(*)::int n from vehicles`)))[0].n, 0)
  assert.equal((await as('mot', () => q(`select count(*)::int n from vehicle_options`)))[0].n, 2)
  await rejects(() => as('oper', () => q(`insert into vehicles (tenant_id, matricula) values ($1,'ZZ-00-ZZ')`, [ids.tenantA])), /row-level/)
})

test('duplicar operacao copia estrutura sem dados', async () => {
  const n = await as('admin', () => q(`select duplicate_operation($1, 'Op 1 (copia)') id`, [ids.op1]))
  const id = n[0].id
  assert.equal((await q(`select count(*)::int n from routes where operation_id=$1`, [id]))[0].n, 1)
  assert.equal((await q(`select count(*)::int n from postal_zones where operation_id=$1`, [id]))[0].n, 1)
  assert.equal((await q(`select count(*)::int n from daily_records r join routes ro on ro.id=r.route_id where ro.operation_id=$1`, [id]))[0].n, 0)
  // a nova rota ja tem tarifario completo (zonas incluidas)
  const snap = await q(`select config from tariff_snapshots s join routes r on r.id=s.route_id where r.operation_id=$1`, [id])
  assert.equal(Object.keys(snap[0].config.zonas).length, 1)
  await rejects(() => as('gestor', () => q(`select duplicate_operation($1, 'x')`, [ids.op1])), /permissao/)
})

test('convites: gestor so convida operador/motorista nas suas operacoes', async () => {
  await rejects(() => as('gestor', () => q(`select create_invitation('x@a.pt','{contabilista}')`)), /Gestor so pode/)
  await rejects(() => as('gestor', () => q(`select create_invitation('x@a.pt','{operador}', $1)`, [[ids.op2]])), /ambito/)
  await as('gestor', () => q(`select create_invitation('x@a.pt','{operador}', $1)`, [[ids.op1]]))
  await rejects(() => as('oper', () => q(`select create_invitation('y@a.pt','{operador}', $1)`, [[ids.op1]])), /permissao/)
})

test('audit trail regista quem/quando/antes/depois e e imutavel', async () => {
  const a = await q(`select acao, user_id, antes, depois from audit_log where tabela='daily_records' and registo_id=$1 order by id`, [ids.recMot])
  assert.ok(a.length >= 3)
  const upd = a.find((x) => x.acao === 'UPDATE' && x.user_id === ids.admin)
  assert.ok(upd); assert.equal(Number(upd.antes.km), 10); assert.equal(Number(upd.depois.km), 55)
  await rejects(() => q(`update audit_log set acao='x'`), /imutavel/)
  assert.equal((await as('gestor', () => q(`select count(*)::int n from audit_log`)))[0].n, 0) // so super admin
})

test('alertas: registo em falta, fundo por reconciliar, vencimentos e margem negativa (sem duplicados)', async () => {
  const today = (await q(`select app.today()::text d`))[0].d
  const lastMonthStart = (await q(`select (date_trunc('month', app.today() - interval '1 month'))::date::text d`))[0].d
  await q(`delete from notifications`)

  // rota ativa (registos recentes) mas sem registo hoje
  const rota3 = await as('admin', () => q(`insert into routes (operation_id, nome) values ($1,'Rota 3') returning id`, [ids.op1]))
  await q(`update routes set created_at = now() - interval '10 days' where id = $1`, [rota3[0].id])
  await as('admin', () => q(`insert into daily_records (route_id, data, enc_entregues) values ($1, app.today() - 3, 10)`, [rota3[0].id]))
  // margem negativa no mes anterior: custos fixos altos + receita pequena
  await as('admin', () => q(`update operations set salario_fixo_mensal = 5000 where id = $1`, [ids.op1]))
  await as('admin', () => q(`insert into daily_records (route_id, data, enc_entregues) values ($1, $2, 10)`, [rota3[0].id, lastMonthStart]))
  // IUC a vencer em 5 dias
  const v = await as('gestor', () => q(`insert into vehicles (tenant_id, matricula, iuc_ativo, iuc_valor, iuc_vencimento) values ($1,'77-ZZ-77',true,100, app.today() + 5) returning id`, [ids.tenantA]))

  const n1 = (await q(`select app.run_alerts(true) n`))[0].n
  assert.ok(n1 >= 4, `esperava >= 4 alertas, obtive ${n1}`)
  const tipos = (await q(`select distinct tipo from notifications`)).map((r) => r.tipo)
  for (const t of ['record_missing', 'fund_unreconciled', 'cost_due', 'margin_negative']) assert.ok(tipos.includes(t), `falta ${t}`)
  // destinatarios certos
  assert.equal((await q(`select count(*)::int n from notifications where tipo='fund_unreconciled' and user_id = $1`, [ids.conta]))[0].n, 1)
  assert.equal((await q(`select count(*)::int n from notifications where tipo='record_missing' and user_id = $1`, [ids.gestor]))[0].n >= 1, true)
  assert.equal((await q(`select count(*)::int n from notifications where tipo='cost_due' and user_id = $1`, [ids.oper]))[0].n, 0)
  // idempotente: uma segunda execucao no mesmo dia nao duplica
  assert.equal((await q(`select app.run_alerts(true) n`))[0].n, 0)
  // sem forcar a noite, "registo em falta" nao dispara (depende da hora); os outros sao deduplicados
  assert.ok(v[0].id && today)
  // o utilizador so ve as suas notificacoes e nao consegue criar
  assert.ok((await as('gestor', () => q(`select count(*)::int n from notifications`)))[0].n >= 1)
  assert.equal((await as('oper', () => q(`select count(*)::int n from notifications where tipo='cost_due'`)))[0].n, 0)
  await rejects(() => as('gestor', () => q(`insert into notifications (tenant_id, user_id, tipo) values ($1,$2,'x')`, [ids.tenantA, ids.gestor])), /permission|row-level/)
})

test('contabilidade: lancamentos automaticos, limite configuravel e versionamento', async () => {
  await q(`delete from notifications`)
  const auto = (recId) => q(`select id, valor, estado, custo_tipo, origem, conta_id, versao_anterior_id, deleted_at, motivo_apagado, motorista_id from movements
                             where registo_id=$1 and origem='automatico' order by created_at, id`, [recId])
  const rota = await as('admin', () => q(`insert into routes (operation_id, nome) values ($1,'Rota Auto') returning id`, [ids.op1]))
  // rascunho nao gera lancamentos
  const drv = (await q(`select id from drivers where user_id=$1`, [ids.mot]))[0].id
  const rec = await as('oper', () => q(`insert into daily_records (route_id, data, comb_valor, portagens_valor, motorista_ids) values ($1,'2026-08-10',40,8,$2) returning id`, [rota[0].id, [drv]]))
  assert.equal((await auto(rec[0].id)).length, 0)
  // ao submeter: combustivel + portagens, abaixo do limite (100) -> nascem Confirmado, sem alerta
  await as('oper', () => q(`update daily_records set status='submetido' where id=$1`, [rec[0].id]))
  let l = await auto(rec[0].id)
  assert.equal(l.length, 2)
  assert.ok(l.every((x) => x.estado === 'confirmado' && x.origem === 'automatico' && x.deleted_at === null))
  assert.ok(l.every((x) => x.conta_id === null)) // sem conta por defeito configurada
  assert.equal(l.find((x) => x.custo_tipo === 'combustivel').valor, '40.00')
  assert.equal((await q(`select count(*)::int n from notifications where tipo='movement_pending'`))[0].n, 0)
  // editar o custo ACIMA do limite: novo lancamento Pendente; o antigo fica soft-deleted e ligado
  await as('oper', () => q(`update daily_records set comb_valor=150 where id=$1`, [rec[0].id]))
  l = (await auto(rec[0].id)).filter((x) => x.custo_tipo === 'combustivel')
  assert.equal(l.length, 2)
  const [old, cur] = l
  assert.ok(old.deleted_at); assert.equal(old.motivo_apagado, 'substituído por edição')
  assert.equal(cur.versao_anterior_id, old.id); assert.equal(cur.estado, 'pendente'); assert.equal(cur.valor, '150.00'); assert.equal(cur.deleted_at, null)
  // notifica Super Admin E Contabilista
  const n1 = (await q(`select user_id from notifications where tipo='movement_pending'`)).map((r) => r.user_id).sort()
  assert.deepEqual(n1, [ids.admin, ids.conta].sort())
  // so o lancamento ativo mais recente conta nos totais
  assert.equal((await q(`select sum(valor) s from movements where registo_id=$1 and custo_tipo='combustivel' and deleted_at is null`, [rec[0].id]))[0].s, '150.00')
  // validar (Contabilista) e depois editar outra vez, agora abaixo do limite: nova versao NAO herda a validacao
  await as('conta', () => q(`update movements set estado='confirmado' where id=$1`, [cur.id]))
  await as('oper', () => q(`update daily_records set comb_valor=90 where id=$1`, [rec[0].id]))
  const chain = await q(`select id, estado, versao_anterior_id, deleted_at is not null as apagado from movements where registo_id=$1 and custo_tipo='combustivel' order by created_at, id`, [rec[0].id])
  assert.equal(chain.length, 3)
  assert.equal(chain[2].versao_anterior_id, chain[1].id)
  assert.equal(chain[2].estado, 'confirmado') // 90 < limite: rotina
  // limite configuravel pelo admin (so Super Admin): com limite 30, 90 passa a exigir validacao
  await rejects(() => as('conta', () => q(`insert into accounting_settings (tenant_id, validation_threshold) values ($1, 30)`, [ids.tenantA])), /row-level/)
  await as('admin', () => q(`insert into accounting_settings (tenant_id, validation_threshold, default_account_id) values ($1, 30, $2)`, [ids.tenantA, ids.bank]))
  await as('oper', () => q(`update daily_records set comb_valor=91 where id=$1`, [rec[0].id]))
  const last = (await auto(rec[0].id)).filter((x) => x.custo_tipo === 'combustivel').at(-1)
  assert.equal(last.estado, 'pendente'); assert.equal(last.conta_id, ids.bank)
  assert.equal(last.motorista_id, drv)
  // remover o custo no registo diario apaga (soft) o lancamento, com motivo
  await as('oper', () => q(`update daily_records set portagens_valor=null where id=$1`, [rec[0].id]))
  const p = (await auto(rec[0].id)).filter((x) => x.custo_tipo === 'portagens')
  assert.equal(p.length, 1); assert.ok(p[0].deleted_at); assert.match(p[0].motivo_apagado, /removido/)
  await q(`update accounting_settings set validation_threshold = 100, default_account_id = null`) // (nunca se apaga fisicamente)
})

test('contabilidade: lancamento automatico so muda no registo diario; quadro (estado + rota) e um unico audit', async () => {
  const mv = (await q(`select id, rota_id from movements where origem='automatico' and deleted_at is null and custo_tipo='combustivel' limit 1`))[0]
  await rejects(() => as('conta', () => q(`update movements set valor=1 where id=$1`, [mv.id])), /so pode ser alterado no registo diario/)
  // arrastar na diagonal do quadro = UMA atualizacao (estado + rota) = UMA entrada de audit
  const rota2 = (await q(`select id from routes where nome='Rota 3' limit 1`))[0].id
  const before = (await q(`select count(*)::int n from audit_log where tabela='movements' and registo_id=$1`, [mv.id]))[0].n
  await as('conta', () => q(`update movements set estado='confirmado', rota_id=$2 where id=$1`, [mv.id, rota2]))
  const after = await q(`select acao, user_id, antes, depois from audit_log where tabela='movements' and registo_id=$1 order by id desc`, [mv.id])
  assert.equal(after.length, before + 1)
  assert.equal(after[0].user_id, ids.conta)
  assert.equal(after[0].depois.rota_id, rota2); assert.equal(after[0].depois.estado, 'confirmado'); assert.equal(after[0].antes.rota_id, mv.rota_id)
  // permissoes: Operador/Motorista/Gestor nao veem nada; Auditor (com acesso) le tudo mas nao escreve
  for (const u of ['oper', 'mot', 'gestor']) assert.equal((await as(u, () => q(`select count(*)::int n from movements`)))[0].n, 0, u)
  await q(`update profiles set accounting_read=true where id=$1`, [ids.aud])
  assert.ok((await as('aud', () => q(`select count(*)::int n from movements where estado='pendente'`)))[0].n >= 1)
  assert.equal((await as('aud', () => q(`update movements set estado='confirmado' where estado='pendente' returning id`))).length, 0) // RLS: 0 linhas
  assert.equal((await as('aud', () => q(`update movements set estado='confirmado' where id=$1 returning id`, [mv.id]))).length, 0)
  await q(`update profiles set accounting_read=false where id=$1`, [ids.aud])
  // um lancamento apagado (historico) e imutavel
  const gone = (await q(`select id from movements where deleted_at is not null limit 1`))[0].id
  await rejects(() => as('admin', () => q(`update movements set descricao='x' where id=$1`, [gone])), /imutavel/)
})

// =====================================================================
// Endurecimento (migracoes 0011-0014): relatorio QA F1-F10 + sobre-alocacao
// =====================================================================

test('F1-F4: referencias de outro tenant ou incoerentes sao recusadas (movimentos e registos)', async () => {
  ids.tenantB = (await q(`select tenant_id from profiles where id=$1`, [ids.adminB]))[0].tenant_id
  const opB = (await as('adminB', () => q(`insert into operations (tenant_id, nome) values ($1,'Op B') returning id`, [ids.tenantB])))[0].id
  const bankB = (await as('adminB', () => q(`insert into bank_accounts (tenant_id, nome) values ($1,'Conta B') returning id`, [ids.tenantB])))[0].id
  const rotaB = (await as('adminB', () => q(`insert into routes (operation_id, nome) values ($1,'Rota B') returning id`, [opB])))[0].id
  const costs = async () => (await q(`select count(*)::int n from daily_record_costs`))[0].n
  const nCosts = await costs()

  // F1: o Tenant B nao aponta para a rota do Tenant A (nem propaga custos para registos do A)
  await rejects(() => as('adminB', () => q(`insert into movements (tenant_id, data, conta_id, tipo, valor, subcategoria, operation_id, rota_id)
      values ($1,'2026-09-12',$2,'debito',5,'outro',$3,$4)`, [ids.tenantB, bankB, opB, ids.rota1])), /rota nao pertence/)
  // F2: nem para a conta bancaria do Tenant A
  await rejects(() => as('adminB', () => q(`insert into movements (tenant_id, data, conta_id, tipo, valor, subcategoria)
      values ($1,'2026-09-12',$2,'debito',5,'outro')`, [ids.tenantB, ids.bank])), /conta_id nao pertence/)
  // o mesmo no UPDATE (a policy so validava a operacao)
  const mB = (await as('adminB', () => q(`insert into movements (tenant_id, data, conta_id, tipo, valor, subcategoria) values ($1,'2026-09-12',$2,'debito',5,'outro') returning id`, [ids.tenantB, bankB])))[0].id
  await rejects(() => as('adminB', () => q(`update movements set conta_id=$2 where id=$1`, [mB, ids.bank])), /conta_id nao pertence/)
  await rejects(() => as('adminB', () => q(`update movements set operation_id=$2 where id=$1`, [mB, ids.op1])), /operation_id nao pertence/)
  // referencias a lancamentos / motoristas de outro tenant
  const mA = (await q(`select id from movements where tenant_id=$1 limit 1`, [ids.tenantA]))[0].id
  await rejects(() => as('adminB', () => q(`update movements set lancamento_referencia_id=$2 where id=$1`, [mB, mA])), /lancamento_referencia_id nao pertence/)
  const drvA = (await q(`select id from drivers where tenant_id=$1 limit 1`, [ids.tenantA]))[0].id
  await rejects(() => as('adminB', () => q(`update movements set motorista_id=$2 where id=$1`, [mB, drvA])), /motorista_id nao pertence/)
  assert.equal(await costs(), nCosts) // nada foi propagado

  // F3: a rota de uma alocacao tem de pertencer a operacao da alocacao (rota1 e da Op 1)
  await rejects(() => as('conta', () => q(`insert into movements (tenant_id, data, conta_id, tipo, valor, subcategoria, operation_id, rota_id)
      values ($1,'2026-01-05',$2,'debito',5,'outro',$3,$4)`, [ids.tenantA, ids.bank, ids.op2, ids.rota1])), /rota nao pertence/)
  const ok = await as('conta', () => q(`insert into movements (tenant_id, data, conta_id, tipo, valor, subcategoria, operation_id, rota_id)
      values ($1,'2026-01-05',$2,'debito',5,'outro',$3,$4) returning origem`, [ids.tenantA, ids.bank, ids.op1, ids.rota1]))
  assert.equal(ok[0].origem, 'manual_rota')

  // F4: registo diario do Tenant B com viatura/motorista do Tenant A
  const vehA = (await q(`select id from vehicles where tenant_id=$1 limit 1`, [ids.tenantA]))[0].id
  await rejects(() => as('adminB', () => q(`insert into daily_records (route_id, data, viatura_id) values ($1,'2026-09-01',$2)`, [rotaB, vehA])), /viatura_id nao pertence/)
  await rejects(() => as('adminB', () => q(`insert into daily_records (route_id, data, motorista_ids) values ($1,'2026-09-01',$2)`, [rotaB, [drvA]])), /motorista_ids nao pertencem/)
  await as('adminB', () => q(`insert into daily_records (route_id, data) values ($1,'2026-09-01')`, [rotaB])) // o legitimo continua a funcionar
  // dentro do mesmo tenant continua a ser possivel
  const rec = await as('oper', () => q(`insert into daily_records (route_id, data, viatura_id, motorista_ids) values ($1,'2026-05-20',$2,$3) returning id`, [ids.rota1, vehA, [drvA]]))
  assert.ok(rec[0].id)
})

test('F9: so Gestor/Super Admin apagam (soft delete) registos diarios; Operador e Motorista nao', async () => {
  const r1 = (await as('oper', () => q(`insert into daily_records (route_id, data) values ($1,'2026-05-01') returning id`, [ids.rota1])))[0].id
  const r2 = (await as('mot', () => q(`insert into daily_records (route_id, data) values ($1,'2026-05-02') returning id`, [ids.rota1])))[0].id
  await rejects(() => as('oper', () => q(`update daily_records set deleted_at=now() where id=$1`, [r1])), /apenas Gestor/)
  await rejects(() => as('mot', () => q(`update daily_records set deleted_at=now() where id=$1`, [r2])), /apenas Gestor/)
  assert.equal((await q(`select count(*)::int n from daily_records where id in ($1,$2) and deleted_at is not null`, [r1, r2]))[0].n, 0)
  // continuam a poder editar (sem apagar)
  await as('oper', () => q(`update daily_records set km=7 where id=$1`, [r1]))
  await as('mot', () => q(`update daily_records set km=8 where id=$1`, [r2]))
  // Gestor apaga; o Operador nao consegue restaurar; Super Admin restaura
  await as('gestor', () => q(`update daily_records set deleted_at=now() where id=$1`, [r1]))
  await rejects(() => as('oper', () => q(`update daily_records set deleted_at=null where id=$1`, [r1])), /apenas Gestor/)
  await as('admin', () => q(`update daily_records set deleted_at=null where id=$1`, [r1]))
  await as('admin', () => q(`update daily_records set deleted_at=now() where id=$1`, [r2]))
  assert.equal((await q(`select count(*)::int n from audit_log where tabela='daily_records' and acao='SOFT_DELETE' and registo_id in ($1,$2)`, [r1, r2]))[0].n, 2)
})

test('F10: a origem e decidida pelo servidor; nenhum utilizador a escolhe (nem Contabilista nem Super Admin)', async () => {
  const ins = (who, cols, vals) => as(who, () => q(`insert into movements (tenant_id, data, conta_id, tipo, valor, subcategoria${cols}) values ($1,'2026-09-14',$2,'debito',10,'outro'${vals}) returning id, origem, estado`, [ids.tenantA, ids.bank]))
  // enviar `origem` (qualquer valor, incluindo o "certo") e recusado
  for (const who of ['conta', 'admin']) {
    for (const o of ['automatico', 'manual_geral', 'manual_rota'])
      await rejects(() => ins(who, ', origem', `, '${o}'`), /origem do lancamento e definida pelo sistema/)
  }
  // sem origem: o servidor deriva-a da operacao
  const g = (await ins('conta', '', ''))[0]
  assert.equal(g.origem, 'manual_geral'); assert.equal(g.estado, 'confirmado')
  const r = (await as('conta', () => q(`insert into movements (tenant_id, data, conta_id, tipo, valor, subcategoria, operation_id) values ($1,'2026-09-14',$2,'debito',10,'outro',$3) returning id, origem`, [ids.tenantA, ids.bank, ids.op1])))[0]
  assert.equal(r.origem, 'manual_rota')
  // o "automatico" forjado de 10 EUR (nascia Confirmado sem validacao) ja nao existe: nem no INSERT nem no UPDATE
  await rejects(() => as('conta', () => q(`update movements set origem='automatico' where id=$1`, [g.id])), /origem do lancamento e definida pelo sistema/)
  await rejects(() => as('admin', () => q(`update movements set origem='manual_rota' where id=$1`, [g.id])), /origem do lancamento e definida pelo sistema/)
  // reclassificar: a origem manual acompanha a operacao (decisao do servidor)
  await as('conta', () => q(`update movements set operation_id=$2 where id=$1`, [g.id, ids.op1]))
  assert.equal((await q(`select origem from movements where id=$1`, [g.id]))[0].origem, 'manual_rota')
  await as('conta', () => q(`update movements set operation_id=null where id=$1`, [g.id]))
  assert.equal((await q(`select origem from movements where id=$1`, [g.id]))[0].origem, 'manual_geral')
  // o sistema continua a criar automaticos (sync_auto_movements sob app.system_write): coberto pelo teste de versionamento
  assert.ok((await q(`select count(*)::int n from movements where origem='automatico'`))[0].n >= 1)
  // ligacao direta a BD (sem utilizador; migracoes/manutencao) pode definir a origem
  const sys = await q(`insert into movements (tenant_id, data, conta_id, tipo, valor, subcategoria, origem) values ($1,'2026-09-14',$2,'debito',10,'custo_automatico','automatico') returning id, origem, estado`, [ids.tenantA, ids.bank])
  assert.equal(sys[0].origem, 'automatico'); assert.equal(sys[0].estado, 'confirmado')
  await q(`update movements set deleted_at=now(), motivo_apagado='teste' where id=$1`, [sys[0].id])
})

test('frota (F6-F8): um posto = uma viatura aberta; substituir; vendida/manutencao/apagada libertam; fim exclusivo', async () => {
  const today = (await q(`select app.today()::text d`))[0].d
  const slot = (await as('gestor', () => q(`insert into fleet_slots (tenant_id, nome) values ($1,'Posto F') returning id`, [ids.tenantA])))[0].id
  const mk = async (plate, posto) => (await as('gestor', () => q(`insert into vehicles (tenant_id, matricula, posto_id) values ($1,$2,$3) returning id`, [ids.tenantA, plate, posto])))[0].id
  const open = () => q(`select vehicle_id from slot_assignments where posto_id=$1 and data_fim is null`, [slot]).then((r) => r.map((x) => x.vehicle_id))
  const postoOf = async (v) => (await q(`select posto_id from vehicles where id=$1`, [v]))[0].posto_id

  // F6: atribuir a um posto ocupado substitui a viatura anterior (nunca 2 abertas)
  const a = await mk('F1-AA-01', slot)
  assert.deepEqual(await open(), [a])
  const b = await mk('F2-BB-02', slot)
  assert.deepEqual(await open(), [b])
  assert.equal(await postoOf(a), null)
  // fim EXCLUSIVO: A sai no dia em que B entra (mesma data): sem sobreposicao nem buracos
  const hist = await q(`select vehicle_id, data_inicio::text i, data_fim::text f from slot_assignments where posto_id=$1`, [slot])
  const ha = hist.find((h) => h.vehicle_id === a), hb = hist.find((h) => h.vehicle_id === b)
  assert.equal(ha.f, hb.i); assert.equal(hb.f, null); assert.equal(hb.i, today)
  // os indices unicos travam qualquer outro caminho (duas abertas no posto)
  await rejects(() => q(`insert into slot_assignments (tenant_id, posto_id, vehicle_id, data_inicio) values ($1,$2,$3,$4)`, [ids.tenantA, slot, a, today]), /unique|duplicate/)

  // F8: vendida liberta o posto (e nao o volta a ocupar se o posto for atribuido estando vendida)
  await as('gestor', () => q(`update vehicles set estado='vendida' where id=$1`, [b]))
  assert.equal(await postoOf(b), null); assert.deepEqual(await open(), [])
  await as('gestor', () => q(`update vehicles set posto_id=$2 where id=$1`, [b, slot]))
  assert.equal(await postoOf(b), null); assert.deepEqual(await open(), [])
  // em manutencao liberta o posto
  const c = await mk('F3-CC-03', slot)
  await as('gestor', () => q(`update vehicles set estado='em_manutencao' where id=$1`, [c]))
  assert.equal(await postoOf(c), null); assert.deepEqual(await open(), [])
  // F7: viatura apagada (soft delete) liberta o posto
  const d = await mk('F4-DD-04', slot)
  await as('gestor', () => q(`update vehicles set deleted_at=now() where id=$1`, [d]))
  assert.equal(await postoOf(d), null); assert.deepEqual(await open(), [])
  // viatura criada ja vendida nao ocupa posto
  const e = (await as('gestor', () => q(`insert into vehicles (tenant_id, matricula, posto_id, estado) values ($1,'F5-EE-05',$2,'vendida') returning id`, [ids.tenantA, slot])))[0].id
  assert.equal(await postoOf(e), null); assert.deepEqual(await open(), [])

  // invariante global: nenhum par de ocupacoes do mesmo posto se sobrepoe em [inicio, fim)
  const overlaps = await q(`select count(*)::int n from slot_assignments x join slot_assignments y on x.posto_id = y.posto_id and x.id < y.id
    where daterange(x.data_inicio, coalesce(x.data_fim, 'infinity'::date), '[)') && daterange(y.data_inicio, coalesce(y.data_fim, 'infinity'::date), '[)')`)
  assert.equal(overlaps[0].n, 0)
  assert.equal((await q(`select count(*)::int n from slot_assignments where data_fim < data_inicio`))[0].n, 0)
})

test('F5: varias mudancas de tarifario no mesmo dia = varios snapshots; o registo usa o ultimo; imutaveis', async () => {
  const today = (await q(`select app.today()::text d`))[0].d
  const rota = (await as('admin', () => q(`insert into routes (operation_id, nome, tarifa_por_estado, tarifa_por_distancia, taxa_km) values ($1,'Rota Snap', false, true, 0.5) returning id`, [ids.op1])))[0].id
  const snaps = () => q(`select valid_from::text f, versao, (config->>'taxa_km')::numeric k from tariff_snapshots where route_id=$1 order by valid_from, versao`, [rota])
  await as('admin', () => q(`update routes set taxa_km=0.6 where id=$1`, [rota]))
  // registo criado entre as duas mudancas do dia: gravado com a 1.a
  const mid = (await as('admin', () => q(`insert into daily_records (route_id, data, km) values ($1,$2,100) returning id, receita_total`, [rota, today])))[0]
  assert.equal(Number(mid.receita_total), 60)
  await as('admin', () => q(`update routes set taxa_km=0.7 where id=$1`, [rota]))
  await as('admin', () => q(`update routes set taxa_km=0.7 where id=$1`, [rota])) // config igual: nao cria snapshot
  const s = await snaps()
  assert.deepEqual(s.map((x) => [x.f, x.versao, Number(x.k)]), [['1900-01-01', 1, 0.5], [today, 1, 0.6], [today, 2, 0.7]]) // a 2.a NAO sobrescreve a 1.a
  // o registo do meio continua a valer 60 e a 1.a versao do dia continua consultavel
  assert.equal(Number((await q(`select receita_total from daily_records where id=$1`, [mid.id]))[0].receita_total), 60)
  // datas: antes da mudanca -> tarifario antigo; depois -> o ultimo do dia
  const past = await as('admin', () => q(`insert into daily_records (route_id, data, km) values ($1, app.today() - 1, 100) returning receita_total`, [rota]))
  const fut = await as('admin', () => q(`insert into daily_records (route_id, data, km) values ($1, app.today() + 1, 100) returning receita_total, tarifa_valid_from::text f`, [rota]))
  assert.equal(Number(past[0].receita_total), 50); assert.equal(Number(fut[0].receita_total), 70); assert.equal(fut[0].f, today)
  // reeditar os inputs do registo do meio recalcula com o ultimo snapshot em vigor nessa data
  await as('admin', () => q(`update daily_records set km=200 where id=$1`, [mid.id]))
  assert.equal(Number((await q(`select receita_total from daily_records where id=$1`, [mid.id]))[0].receita_total), 140)
  // snapshots so se acrescentam
  await rejects(() => q(`update tariff_snapshots set config='{}' where route_id=$1`, [rota]), /imutavel/)
  await rejects(() => q(`delete from tariff_snapshots where route_id=$1`, [rota]), /apagar fisicamente/)
})

test('sobre-alocacao: sinalizada no servidor (vista + notificacao), nunca bloqueada nem escondida', async () => {
  await q(`delete from notifications`)
  const mk = (cols, vals, params) => as('conta', () => q(`insert into movements (tenant_id, data, conta_id, tipo, valor, subcategoria${cols}) values ($1,'2026-09-15',$2,'debito'${vals}) returning id`, [ids.tenantA, ids.bank, ...params]))
  const tr = (await mk(', pessoa_responsavel', ", 100, 'transferencia_distribuicao', 'Joana Over'", []))[0].id
  const alloc = async (v) => (await mk(', lancamento_referencia_id, pessoa_responsavel', `, ${v}, 'outro', $3, 'Joana Over'`, [tr]))[0].id
  const over = () => q(`select user_id, payload from notifications where tipo='fund_over_allocated' order by created_at, id`)
  const status = async () => (await as('conta', () => q(`select alocado, diferenca, estado from fund_transfer_status where id=$1`, [tr])))[0]

  await alloc(60)
  assert.deepEqual(await status(), { alocado: '60.00', diferenca: '40.00', estado: 'under' })   // sub-alocacao visivel
  await alloc(40)
  assert.equal((await status()).estado, 'ok'); assert.equal((await over()).length, 0)
  // sobre-alocacao: ACEITE (nao bloqueada) mas sinalizada a Super Admin E Contabilistas
  const a3 = await alloc(10)
  assert.deepEqual(await status(), { alocado: '110.00', diferenca: '-10.00', estado: 'over' })
  const n = await over()
  assert.deepEqual(n.map((x) => x.user_id).sort(), [ids.admin, ids.conta].sort())
  assert.equal(Number(n[0].payload.excesso), 10); assert.equal(n[0].payload.pessoa, 'Joana Over')
  // agravar o excesso volta a sinalizar; corrigir/diminuir nao
  const a4 = await alloc(5)
  assert.equal((await over()).length, 4)
  await as('conta', () => q(`update movements set valor=5 where id=$1`, [a3]))
  await as('admin', () => q(`update movements set deleted_at=now(), motivo_apagado='teste' where id=$1`, [a4]))
  assert.equal((await over()).length, 4)
  assert.equal((await status()).diferenca, '-5.00')
  // baixar o valor da transferencia tambem agrava o excesso
  await as('conta', () => q(`update movements set valor=80 where id=$1`, [tr]))
  assert.equal((await over()).length, 6)
  assert.equal(Number((await over()).at(-1).payload.excesso), 25)
  // a vista respeita RLS: quem nao le a Contabilidade nao ve nada
  assert.equal((await as('oper', () => q(`select count(*)::int n from fund_transfer_status`)))[0].n, 0)
  assert.ok((await as('conta', () => q(`select count(*)::int n from fund_transfer_status`)))[0].n >= 1)
})

test('F10b: registo_id, custo_tipo, versao_anterior_id, validado_por e validado_em so o servidor escreve', async () => {
  const rec = (await q(`select registo_id from movements where registo_id is not null and origem='automatico' limit 1`))[0].registo_id
  const prev = (await q(`select id from movements where tenant_id=$1 limit 1`, [ids.tenantA]))[0].id
  const cols = { registo_id: `'${rec}'`, custo_tipo: `'combustivel'`, versao_anterior_id: `'${prev}'`, validado_por: `'${ids.conta}'`, validado_em: 'now()' }
  // INSERT: qualquer um deles enviado pelo cliente e recusado (Contabilista e Super Admin)
  for (const who of ['conta', 'admin'])
    for (const [c, v] of Object.entries(cols))
      await rejects(() => as(who, () => q(`insert into movements (tenant_id, data, conta_id, tipo, valor, subcategoria, ${c}) values ($1,'2026-09-16',$2,'debito',10,'outro',${v})`, [ids.tenantA, ids.bank])), /geridos pelo sistema/)
  // UPDATE: idem, incluindo forjar quem validou
  const m = (await as('conta', () => q(`insert into movements (tenant_id, data, conta_id, tipo, valor, subcategoria) values ($1,'2026-09-16',$2,'debito',10,'outro') returning id`, [ids.tenantA, ids.bank])))[0].id
  for (const who of ['conta', 'admin'])
    for (const [c, v] of Object.entries(cols))
      await rejects(() => as(who, () => q(`update movements set ${c}=${v} where id=$1`, [m])), /geridos pelo sistema/)
  // a validacao continua a funcionar e e o servidor que regista quem/quando (nunca o cliente)
  const alloc = (await as('conta', () => q(`insert into movements (tenant_id, data, conta_id, tipo, valor, subcategoria, lancamento_referencia_id) values ($1,'2026-09-16',$2,'debito',10,'outro',$3) returning id`, [ids.tenantA, ids.bank, m])))[0].id
  await as('conta', () => q(`update movements set estado='confirmado' where id=$1`, [alloc]))
  const v = (await q(`select validado_por, validado_em from movements where id=$1`, [alloc]))[0]
  assert.equal(v.validado_por, ids.conta); assert.ok(v.validado_em)
  await rejects(() => as('conta', () => q(`update movements set estado='confirmado', validado_por=$2 where id=$1`, [alloc, ids.admin])), /geridos pelo sistema/)
  assert.equal((await q(`select validado_por from movements where id=$1`, [alloc]))[0].validado_por, ids.conta)
  // os caminhos internos continuam a escrever esses campos (automaticos, propagacao): cobertos pelos testes de versionamento/propagacao
})

test('N1: num registo Validado ninguem reescreve validado_por/validado_em (so o servidor)', async () => {
  const r = (await as('oper', () => q(`insert into daily_records (route_id, data, km) values ($1,'2026-04-10',5) returning id`, [ids.rota1])))[0].id
  await as('gestor', () => q(`update daily_records set status='validado' where id=$1`, [r]))
  const v = (await q(`select validado_por, validado_em from daily_records where id=$1`, [r]))[0]
  assert.equal(v.validado_por, ids.gestor); assert.ok(v.validado_em)
  // Gestor e Super Admin tentam forjar quem/quando validou, mantendo status='validado'
  for (const who of ['gestor', 'admin']) {
    await as(who, () => q(`update daily_records set validado_por=$2, validado_em='2020-01-01', status='validado' where id=$1`, [r, ids.admin]))
    const now = (await q(`select validado_por, validado_em from daily_records where id=$1`, [r]))[0]
    assert.equal(now.validado_por, ids.gestor, who); assert.equal(String(now.validado_em), String(v.validado_em), who)
  }
  // o fluxo legitimo continua: editar reabre (Submetido, limpa) e nova validacao regista o novo validador
  await as('admin', () => q(`update daily_records set km=6 where id=$1`, [r]))
  const re = (await q(`select status, validado_por, validado_em from daily_records where id=$1`, [r]))[0]
  assert.equal(re.status, 'submetido'); assert.equal(re.validado_por, null); assert.equal(re.validado_em, null)
  await as('admin', () => q(`update daily_records set status='validado' where id=$1`, [r]))
  assert.equal((await q(`select validado_por from daily_records where id=$1`, [r]))[0].validado_por, ids.admin)
})

// =====================================================================
// Migracao 0016: 2.o relatorio do tester (F3-F6) e regras novas
// =====================================================================

test('F5: um lancamento automatico so muda no registo diario (validar/reclassificar/conta/descricao sim; o resto nao)', async () => {
  const auto = (await q(`select id, rota_id from movements where origem='automatico' and deleted_at is null and custo_tipo='combustivel' limit 1`))[0]
  const tr = (await as('conta', () => q(`insert into movements (tenant_id, data, conta_id, tipo, valor, subcategoria, pessoa_responsavel) values ($1,'2026-09-17',$2,'debito',100,'transferencia_distribuicao','QA-F5') returning id`, [ids.tenantA, ids.bank])))[0].id
  const bad = [
    [`lancamento_referencia_id='${tr}'`, 'passar a alocacao'], [`subcategoria='transferencia_distribuicao'`, 'subcategoria'], [`pessoa_responsavel='QA-F5'`, 'pessoa'],
    [`valor=1`, 'valor'], [`data='2001-01-01'`, 'data'], [`tipo='credito'`, 'tipo'],
  ]
  for (const [set, what] of bad)
    for (const who of ['conta', 'admin'])
      await rejects(() => as(who, () => q(`update movements set ${set} where id=$1`, [auto.id])), /so pode ser alterado no registo diario/, `${who} ${what}`)
  // o que continua permitido na Contabilidade: validar/reverter, reclassificar, atribuir conta, descricao
  await as('conta', () => q(`update movements set estado='pendente', descricao='QA-F5 desc', conta_id=$2 where id=$1`, [auto.id, ids.bank]))
  await as('conta', () => q(`update movements set estado='confirmado', rota_id=$2 where id=$1`, [auto.id, ids.rota1]))
  const now = (await q(`select estado, descricao, conta_id, validado_por from movements where id=$1`, [auto.id]))[0]
  assert.deepEqual([now.estado, now.descricao, now.conta_id, now.validado_por], ['confirmado', 'QA-F5 desc', ids.bank, ids.conta])
  await as('conta', () => q(`update movements set rota_id=$2 where id=$1`, [auto.id, auto.rota_id])) // repoe
})

test('F4: created_by/created_at do lancamento so o servidor define', async () => {
  const m = (await as('conta', () => q(`insert into movements (tenant_id, data, conta_id, tipo, valor, subcategoria, created_at) values ($1,'2026-09-17',$2,'debito',5,'outro','2001-01-01') returning id, created_at, created_by`, [ids.tenantA, ids.bank])))[0]
  assert.ok(new Date(m.created_at).getFullYear() >= 2026, 'created_at do INSERT tem de ser do servidor: ' + m.created_at)
  assert.equal(m.created_by, ids.conta)
  for (const who of ['conta', 'admin']) {
    await rejects(() => as(who, () => q(`update movements set created_at='2001-01-01' where id=$1`, [m.id])), /imutaveis/)
    await rejects(() => as(who, () => q(`update movements set created_by=$2 where id=$1`, [m.id, ids.admin])), /imutaveis/)
  }
  const now = (await q(`select created_at, created_by from movements where id=$1`, [m.id]))[0]
  assert.equal(String(now.created_at), String(m.created_at)); assert.equal(now.created_by, ids.conta)
})

test('F6: so alocacoes a DEBITO contam para alocado e sobre-alocacao', async () => {
  await q(`delete from notifications`)
  const tr = (await as('conta', () => q(`insert into movements (tenant_id, data, conta_id, tipo, valor, subcategoria, pessoa_responsavel) values ($1,'2026-09-18',$2,'debito',100,'transferencia_distribuicao','QA-F6') returning id`, [ids.tenantA, ids.bank])))[0].id
  const child = (tipo, v) => as('conta', () => q(`insert into movements (tenant_id, data, conta_id, tipo, valor, subcategoria, pessoa_responsavel, lancamento_referencia_id) values ($1,'2026-09-18',$2,'${tipo}',${v},'outro','QA-F6',$3) returning id`, [ids.tenantA, ids.bank, tr]))
  const st = async () => (await as('conta', () => q(`select alocado, estado from fund_transfer_status where id=$1`, [tr])))[0]
  await child('credito', 500)
  assert.deepEqual(await st(), { alocado: '0.00', estado: 'under' })
  assert.equal((await q(`select count(*)::int n from notifications where tipo='fund_over_allocated'`))[0].n, 0)
  await child('debito', 100)
  assert.deepEqual(await st(), { alocado: '100.00', estado: 'ok' })
})

test('F3: um registo Submetido/Validado nao volta a Rascunho', async () => {
  const r = (await as('oper', () => q(`insert into daily_records (route_id, data, comb_valor) values ($1,'2026-03-01',20) returning id`, [ids.rota1])))[0].id
  await as('oper', () => q(`update daily_records set status='submetido' where id=$1`, [r]))
  for (const who of ['oper', 'gestor', 'admin'])
    await rejects(() => as(who, () => q(`update daily_records set status='rascunho' where id=$1`, [r])), /nao pode voltar a rascunho/, who)
  await as('gestor', () => q(`update daily_records set status='validado' where id=$1`, [r]))
  await rejects(() => as('admin', () => q(`update daily_records set status='rascunho' where id=$1`, [r])), /nao pode voltar a rascunho/)
  // escrever num rascunho continua livre e (agora) nunca gera versoes
  const d = (await as('oper', () => q(`insert into daily_records (route_id, data, comb_valor) values ($1,'2026-03-02',20) returning id`, [ids.rota1])))[0].id
  for (const v of [21, 22, 23]) await as('oper', () => q(`update daily_records set comb_valor=$2 where id=$1`, [d, v]))
  assert.equal((await q(`select count(*)::int n from movements where registo_id=$1`, [d]))[0].n, 0)
  // o fluxo normal Rascunho -> Submetido -> Validado -> (editar) Submetido mantem-se
  await as('admin', () => q(`update daily_records set km=3 where id=$1`, [r]))
  assert.equal((await q(`select status from daily_records where id=$1`, [r]))[0].status, 'submetido')
})

test('alocacao anexada a um registo Validado reverte-o para Submetido e notifica quem validou; etiqueta com travessao', async () => {
  const rec = (await as('oper', () => q(`insert into daily_records (route_id, data, km) values ($1,'2026-03-03',5) returning id`, [ids.rota1])))[0].id
  await as('gestor', () => q(`update daily_records set status='validado' where id=$1`, [rec]))
  await q(`delete from notifications`)
  const tr = (await as('conta', () => q(`insert into movements (tenant_id, data, conta_id, tipo, valor, subcategoria, pessoa_responsavel) values ($1,'2026-03-03',$2,'debito',300,'transferencia_distribuicao','QA-Val') returning id`, [ids.tenantA, ids.bank])))[0].id
  const alloc = (v) => as('conta', () => q(`insert into movements (tenant_id, data, conta_id, tipo, valor, subcategoria, pessoa_responsavel, lancamento_referencia_id, operation_id, rota_id) values ($1,'2026-03-03',$2,'debito',${v},'outro','QA-Val',$3,$4,$5) returning id`, [ids.tenantA, ids.bank, tr, ids.op1, ids.rota1]))
  await alloc(100)
  const r = (await q(`select status, validado_por, validado_em from daily_records where id=$1`, [rec]))[0]
  assert.deepEqual([r.status, r.validado_por, r.validado_em], ['submetido', null, null])
  const cost = await q(`select categoria, valor from daily_record_costs where record_id=$1`, [rec])
  assert.equal(cost.length, 1); assert.match(cost[0].categoria, /^Pagamento distribuído — QA-Val$/)
  // o Gestor que validou e avisado (mesma regra das edicoes diretas); quem alocou nao
  const n = await q(`select user_id, payload from notifications where tipo='record_reopened'`)
  assert.deepEqual(n.map((x) => x.user_id), [ids.gestor]); assert.equal(n[0].payload.record_id, rec); assert.equal(n[0].payload.by, ids.conta)
  // ja Submetido: mais alocacoes anexam sem novo aviso
  await alloc(50)
  assert.equal((await q(`select count(*)::int n from notifications where tipo='record_reopened'`))[0].n, 1)
  // registo Validado + alocacao noutro dia (sem registo) nao reverte nada; ao nascer o registo valido a regra nao se aplica (nasce Rascunho)
  assert.equal((await q(`select count(*)::int n from daily_record_costs where record_id=$1`, [rec]))[0].n, 2)
})

test('motivo_apagado so se define ao apagar (nunca numa linha ativa, manual ou automatica)', async () => {
  const manual = (await as('conta', () => q(`insert into movements (tenant_id, data, conta_id, tipo, valor, subcategoria) values ($1,'2026-09-19',$2,'debito',7,'outro') returning id`, [ids.tenantA, ids.bank])))[0].id
  const auto = (await q(`insert into movements (tenant_id, data, conta_id, tipo, valor, subcategoria, origem) values ($1,'2026-09-19',$2,'debito',7,'custo_automatico','automatico') returning id`, [ids.tenantA, ids.bank]))[0].id
  for (const id of [manual, auto])
    for (const who of ['conta', 'admin'])
      await rejects(() => as(who, () => q(`update movements set motivo_apagado='sujo' where id=$1`, [id])), /motivo_apagado so pode ser definido ao apagar/, `${who} ${id}`)
  assert.equal((await q(`select count(*)::int n from movements where id in ($1,$2) and motivo_apagado is not null`, [manual, auto]))[0].n, 0)
  // continua a ser possivel apagar (soft delete) com motivo, so pelo Super Admin; o Contabilista nao
  await rejects(() => as('conta', () => q(`update movements set deleted_at=now(), motivo_apagado='x' where id=$1`, [manual])), /Super Admin/)
  await rejects(() => as('admin', () => q(`update movements set deleted_at=now() where id=$1`, [manual])), /motivo obrigatorio/)
  await as('admin', () => q(`update movements set deleted_at=now(), motivo_apagado='duplicado' where id=$1`, [manual]))
  await as('admin', () => q(`update movements set deleted_at=now(), motivo_apagado='custo errado' where id=$1`, [auto])) // tambem um automatico
  const r = await q(`select id, motivo_apagado from movements where id in ($1,$2)`, [manual, auto])
  assert.deepEqual(r.map((x) => x.motivo_apagado).sort(), ['custo errado', 'duplicado'])
  // depois de apagado e imutavel (mesmo o motivo)
  await rejects(() => as('admin', () => q(`update movements set motivo_apagado='outro' where id=$1`, [manual])), /imutavel|motivo_apagado/)
  // ligacao direta a BD (sem utilizador) pode corrigir dados
  const ativo = (await q(`insert into movements (tenant_id, data, conta_id, tipo, valor, subcategoria) values ($1,'2026-09-19',$2,'debito',7,'outro') returning id`, [ids.tenantA, ids.bank]))[0].id
  await q(`update movements set motivo_apagado='corrigido' where id=$1`, [ativo])
})

// =====================================================================
// Migracao 0018: achados da analise de simplificacao (13a, 4, 5, 6, dedupe do 7)
// =====================================================================

test('alertas: fund_unreconciled so conta debitos (13a); allocation_unlinked 3+ dias e semanal (4); movement_pending sem repeticao no dia (7)', async () => {
  await q(`delete from notifications`)
  const today = (await q(`select app.today()::text d`))[0].d
  const mkT = (daysAgo) => as('conta', () => q(`insert into movements (tenant_id, data, conta_id, tipo, valor, subcategoria, pessoa_responsavel) values ($1, app.today() - ${daysAgo}, $2,'debito',100,'transferencia_distribuicao','QA-Alert') returning id`, [ids.tenantA, ids.bank]))
  const T = (await mkT(8))[0].id
  // 13a: uma alocacao a CREDITO nao conta como alocado: o fundo continua por reconciliar (100)
  await as('conta', () => q(`insert into movements (tenant_id, data, conta_id, tipo, valor, subcategoria, pessoa_responsavel, lancamento_referencia_id) values ($1, app.today() - 8, $2,'credito',100,'outro','QA-Alert',$3)`, [ids.tenantA, ids.bank, T]))
  // 4: alocacao com operacao+rota ha 5 dias sem registo diario
  const rota = (await as('admin', () => q(`insert into routes (operation_id, nome) values ($1,'Rota Unl') returning id`, [ids.op1])))[0].id
  const alloc = (await as('conta', () => q(`insert into movements (tenant_id, data, conta_id, tipo, valor, subcategoria, pessoa_responsavel, lancamento_referencia_id, operation_id, rota_id) values ($1, app.today() - 5, $2,'debito',20,'outro','QA-Alert',$3,$4,$5) returning id`, [ids.tenantA, ids.bank, T, ids.op1, rota])))[0].id
  // ja ligada (registo existe): nao alerta
  await as('oper', () => q(`insert into daily_records (route_id, data) values ($1, app.today() - 6)`, [rota]))
  const linked = (await as('conta', () => q(`insert into movements (tenant_id, data, conta_id, tipo, valor, subcategoria, pessoa_responsavel, lancamento_referencia_id, operation_id, rota_id) values ($1, app.today() - 6, $2,'debito',10,'outro','QA-Alert',$3,$4,$5) returning id`, [ids.tenantA, ids.bank, T, ids.op1, rota])))[0].id
  // recente (< 3 dias): nao alerta
  const recent = (await as('conta', () => q(`insert into movements (tenant_id, data, conta_id, tipo, valor, subcategoria, pessoa_responsavel, lancamento_referencia_id, operation_id, rota_id) values ($1, app.today() - 1, $2,'debito',5,'outro','QA-Alert',$3,$4,$5) returning id`, [ids.tenantA, ids.bank, T, ids.op1, rota])))[0].id

  // (7) movement_pending: uma notificacao por movimento e por destinatario; reverter/revalidar no mesmo dia nao repete
  const pend = (id) => q(`select count(*)::int n from notifications where tipo='movement_pending' and payload->>'movement_id'=$1`, [id]).then((r) => r[0].n)
  assert.equal(await pend(alloc), 2)                                    // Super Admin + Contabilista
  await as('conta', () => q(`update movements set estado='confirmado' where id=$1`, [alloc]))
  await as('conta', () => q(`update movements set valor=21 where id=$1`, [alloc]))   // volta a Pendente (o que foi validado mudou)
  assert.equal((await q(`select estado from movements where id=$1`, [alloc]))[0].estado, 'pendente')
  assert.equal(await pend(alloc), 4)                                    // corrigir o VALOR depois de validado avisa de novo (chave inclui o valor)
  await as('conta', () => q(`update movements set valor=20 where id=$1`, [alloc]))
  // reverter/revalidar o MESMO valor no mesmo dia nao repete o aviso
  await as('conta', () => q(`update movements set estado='confirmado' where id=$1`, [alloc]))
  await as('conta', () => q(`update movements set estado='pendente' where id=$1`, [alloc]))
  assert.equal(await pend(alloc), 4)

  await q(`select app.run_alerts(true)`)
  const of = async (tipo, id) => (await q(`select user_id from notifications where tipo=$1 and payload->>'movement_id'=$2`, [tipo, id])).map((r) => r.user_id).sort()
  // 13a: o fundo continua "por reconciliar" (100), porque so o debito conta
  const fu = await q(`select user_id, payload from notifications where tipo='fund_unreconciled' and payload->>'movement_id'=$1`, [T])
  assert.deepEqual(fu.map((r) => r.user_id).sort(), [ids.admin, ids.conta].sort()); assert.equal(Number(fu[0].payload.valor), 100 - 20 - 10 - 5)
  // 4: alerta "por ligar" ao Gestor da operacao, ao Super Admin e ao Contabilista (nunca ao Operador); so a alocacao antiga e sem registo
  assert.deepEqual(await of('allocation_unlinked', alloc), [ids.admin, ids.conta, ids.gestor].sort())
  assert.deepEqual(await of('allocation_unlinked', linked), []); assert.deepEqual(await of('allocation_unlinked', recent), [])
  const p = (await q(`select payload from notifications where tipo='allocation_unlinked' and payload->>'movement_id'=$1 limit 1`, [alloc]))[0].payload
  assert.equal(p.route, 'Rota Unl'); assert.equal(p.data, (await q(`select (app.today() - 5)::text d`))[0].d)
  // semanal: uma 2.a execucao na mesma semana nao repete
  const before = (await q(`select count(*)::int n from notifications where tipo='allocation_unlinked'`))[0].n
  await q(`select app.run_alerts(true)`)
  assert.equal((await q(`select count(*)::int n from notifications where tipo='allocation_unlinked'`))[0].n, before)
  assert.ok(today)
})

test('reclassificar uma alocacao ja propagada: apaga a linha antiga, reverte o registo Validado, avisa o validador e religa (5)', async () => {
  const rB = (await as('admin', () => q(`insert into routes (operation_id, nome) values ($1,'Rota Relink') returning id`, [ids.op1])))[0].id
  const rec = (route, d) => as('oper', () => q(`insert into daily_records (route_id, data) values ($1,$2) returning id`, [route, d])).then((r) => r[0].id)
  const R1 = await rec(ids.rota1, '2026-02-10'), R2 = await rec(rB, '2026-02-10')
  const T = (await as('conta', () => q(`insert into movements (tenant_id, data, conta_id, tipo, valor, subcategoria, pessoa_responsavel) values ($1,'2026-02-10',$2,'debito',500,'transferencia_distribuicao','QA-Relink') returning id`, [ids.tenantA, ids.bank])))[0].id
  const A = (await as('conta', () => q(`insert into movements (tenant_id, data, conta_id, tipo, valor, subcategoria, pessoa_responsavel, lancamento_referencia_id, operation_id, rota_id) values ($1,'2026-02-10',$2,'debito',50,'outro','QA-Relink',$3,$4,$5) returning id`, [ids.tenantA, ids.bank, T, ids.op1, ids.rota1])))[0].id
  const reg = async () => (await q(`select registo_id from movements where id=$1`, [A]))[0].registo_id
  const lines = (r) => q(`select id, categoria, deleted_at is not null as apagada from daily_record_costs where record_id=$1 and movimento_id=$2 order by created_at`, [r, A])
  assert.equal(await reg(), R1); assert.equal((await lines(R1)).length, 1)
  await as('gestor', () => q(`update daily_records set status='validado' where id=$1`, [R1]))
  await q(`delete from notifications`)

  // -> outra rota, mesma data, onde ja existe registo (Rascunho): a linha antiga sai, a nova entra, o registo antigo volta a Submetido
  await as('conta', () => q(`update movements set rota_id=$2 where id=$1`, [A, rB]))
  assert.equal(await reg(), R2)
  assert.deepEqual((await lines(R1)).map((l) => l.apagada), [true])
  assert.deepEqual((await lines(R2)).map((l) => [l.apagada, l.categoria]), [[false, 'Pagamento distribuído — QA-Relink']])
  const r1 = (await q(`select status, validado_por from daily_records where id=$1`, [R1]))[0]
  assert.deepEqual([r1.status, r1.validado_por], ['submetido', null])
  assert.deepEqual((await q(`select user_id from notifications where tipo='record_reopened' and payload->>'record_id'=$1`, [R1])).map((n) => n.user_id), [ids.gestor])
  assert.equal((await q(`select status from daily_records where id=$1`, [R2]))[0].status, 'rascunho')
  // a remocao da linha fica no audit (quem e quando)
  const au = await q(`select user_id from audit_log where tabela='daily_record_costs' and acao='SOFT_DELETE' and antes->>'movimento_id'=$1`, [A])
  assert.equal(au.length, 1); assert.equal(au[0].user_id, ids.conta)

  // -> data sem registo: a alocacao volta a "por ligar" e a linha de R2 sai
  await as('conta', () => q(`update movements set data='2026-02-11' where id=$1`, [A]))
  assert.equal(await reg(), null); assert.deepEqual((await lines(R2)).map((l) => l.apagada), [true])
  assert.equal((await q(`select count(*)::int n from daily_records where route_id=$1 and data='2026-02-11'`, [rB]))[0].n, 0) // nunca cria o registo
  // quando o registo nascer, anexa-se (regra existente)
  const R3 = await rec(rB, '2026-02-11')
  assert.equal(await reg(), R3); assert.equal((await lines(R3)).length, 1)
  // -> "Geral" (sem rota): sai da linha e nao tenta ligar
  await as('conta', () => q(`update movements set rota_id=null where id=$1`, [A]))
  assert.equal(await reg(), null); assert.deepEqual((await lines(R3)).map((l) => l.apagada), [true])
  // editar so o valor NAO mexe em nada (copia independente para tudo o resto)
  const B = (await as('conta', () => q(`insert into movements (tenant_id, data, conta_id, tipo, valor, subcategoria, pessoa_responsavel, lancamento_referencia_id, operation_id, rota_id) values ($1,'2026-02-10',$2,'debito',30,'outro','QA-Relink',$3,$4,$5) returning id`, [ids.tenantA, ids.bank, T, ids.op1, ids.rota1])))[0].id
  await as('conta', () => q(`update movements set valor=31, descricao='x' where id=$1`, [B]))
  assert.equal((await q(`select registo_id from movements where id=$1`, [B]))[0].registo_id, R1)
  assert.equal((await q(`select count(*)::int n from daily_record_costs where record_id=$1 and movimento_id=$2 and deleted_at is null`, [R1, B]))[0].n, 1)
})

test('pedir correcao de um automatico ao Gestor (6): so o Contabilista/Super Admin, so automaticos, um pedido por dia', async () => {
  await q(`delete from notifications`)
  const auto = (await q(`select id, registo_id from movements where origem='automatico' and deleted_at is null and operation_id=$1 and registo_id is not null limit 1`, [ids.op1]))[0]
  const call = (who, id, note) => as(who, () => q(`select request_cost_correction($1,$2) n`, [id, note]))
  assert.equal((await call('conta', auto.id, 'litros a mais'))[0].n, 2)          // Super Admin + Gestor da operacao (nunca o proprio)
  const n = await q(`select user_id, payload from notifications where tipo='auto_cost_disputed'`)
  assert.deepEqual(n.map((x) => x.user_id).sort(), [ids.admin, ids.gestor].sort())
  assert.equal(n[0].payload.note, 'litros a mais'); assert.equal(n[0].payload.movement_id, auto.id); assert.equal(n[0].payload.registo_id, auto.registo_id)
  assert.equal((await call('conta', auto.id, 'outra vez'))[0].n, 0)               // ja pedido hoje
  assert.equal((await q(`select count(*)::int n from notifications where tipo='auto_cost_disputed'`))[0].n, 2)
  // quem nao escreve na Contabilidade nao pede; manuais nao se disputam
  for (const who of ['oper', 'gestor', 'mot', 'aud']) await rejects(() => call(who, auto.id, 'x'), /sem permissao/, who)
  const manual = (await as('conta', () => q(`insert into movements (tenant_id, data, conta_id, tipo, valor, subcategoria, operation_id) values ($1,'2026-09-19',$2,'debito',5,'outro',$3) returning id`, [ids.tenantA, ids.bank, ids.op1])))[0].id
  await rejects(() => call('conta', manual, 'x'), /so se pede correcao/)
  await rejects(() => call('adminB', auto.id, 'x'), /sem permissao|nao encontrado/)
  // anonimo nao tem execute
  await db.exec(`set role anon`)
  try { await rejects(() => q(`select request_cost_correction('${auto.id}', 'x')`), /permission denied/) } finally { await db.exec(`reset role`) }
})

// =====================================================================
// Migracao 0019: 3.a ronda (tester + analista)
// =====================================================================

test('apagar (soft delete) uma alocacao propagada apaga tambem a linha de custo; registo Validado volta a Submetido e o validador e avisado', async () => {
  const rec = (await as('oper', () => q(`insert into daily_records (route_id, data) values ($1,'2026-01-20') returning id`, [ids.rota1])))[0].id
  const T = (await as('conta', () => q(`insert into movements (tenant_id, data, conta_id, tipo, valor, subcategoria, pessoa_responsavel) values ($1,'2026-01-20',$2,'debito',300,'transferencia_distribuicao','QA-Del') returning id`, [ids.tenantA, ids.bank])))[0].id
  const mkA = (v) => as('conta', () => q(`insert into movements (tenant_id, data, conta_id, tipo, valor, subcategoria, pessoa_responsavel, lancamento_referencia_id, operation_id, rota_id) values ($1,'2026-01-20',$2,'debito',${v},'outro','QA-Del',$3,$4,$5) returning id`, [ids.tenantA, ids.bank, T, ids.op1, ids.rota1])).then((r) => r[0].id)
  const A = await mkA(40), B = await mkA(25)
  const lines = (m) => q(`select deleted_at is not null as apagada from daily_record_costs where record_id=$1 and movimento_id=$2`, [rec, m])
  assert.deepEqual((await lines(A)).map((l) => l.apagada), [false])
  await as('gestor', () => q(`update daily_records set status='validado' where id=$1`, [rec]))
  await q(`delete from notifications`)
  await as('admin', () => q(`update movements set deleted_at=now(), motivo_apagado='enganei-me' where id=$1`, [A]))
  assert.deepEqual((await lines(A)).map((l) => l.apagada), [true])          // a linha do custo sai do registo
  assert.deepEqual((await lines(B)).map((l) => l.apagada), [false])         // a da OUTRA alocacao fica
  const r = (await q(`select status, validado_por from daily_records where id=$1`, [rec]))[0]
  assert.deepEqual([r.status, r.validado_por], ['submetido', null])
  assert.deepEqual((await q(`select user_id from notifications where tipo='record_reopened' and payload->>'record_id'=$1`, [rec])).map((n) => n.user_id), [ids.gestor])
  assert.equal((await q(`select count(*)::int n from audit_log where tabela='daily_record_costs' and acao='SOFT_DELETE' and antes->>'movimento_id'=$1 and user_id=$2`, [A, ids.admin]))[0].n, 1)
  // alocacao ainda "por ligar" (sem registo): apagar nao mexe em nada
  const C = (await as('conta', () => q(`insert into movements (tenant_id, data, conta_id, tipo, valor, subcategoria, pessoa_responsavel, lancamento_referencia_id, operation_id, rota_id) values ($1,'2026-01-21',$2,'debito',5,'outro','QA-Del',$3,$4,$5) returning id`, [ids.tenantA, ids.bank, T, ids.op1, ids.rota1])))[0].id
  await as('admin', () => q(`update movements set deleted_at=now(), motivo_apagado='x' where id=$1`, [C]))
  assert.equal((await q(`select deleted_at is not null d from movements where id=$1`, [C]))[0].d, true)
})

test('"Sem registo previsto": so numa alocacao por ligar; fora do alerta; reversivel; volta a por ligar se a rota/data mudarem; rotas apagadas nao alertam', async () => {
  await q(`delete from notifications`)
  const rota = (await as('admin', () => q(`insert into routes (operation_id, nome) values ($1,'Rota SRP') returning id`, [ids.op1])))[0].id
  const T = (await as('conta', () => q(`insert into movements (tenant_id, data, conta_id, tipo, valor, subcategoria, pessoa_responsavel) values ($1, app.today() - 9, $2,'debito',100,'transferencia_distribuicao','QA-SRP') returning id`, [ids.tenantA, ids.bank])))[0].id
  const mkA = (extra = '', p = []) => as('conta', () => q(`insert into movements (tenant_id, data, conta_id, tipo, valor, subcategoria, pessoa_responsavel, lancamento_referencia_id, operation_id, rota_id) values ($1, app.today() - 6, $2,'debito',10,'outro','QA-SRP',$3,$4,$5) returning id`, [ids.tenantA, ids.bank, T, ids.op1, rota, ...p])).then((r) => r[0].id)
  const A = await mkA(), B = await mkA()
  const flag = (id, v, who = 'conta') => as(who, () => q(`update movements set sem_registo_previsto=${v} where id=$1 returning sem_registo_previsto s`, [id]))
  // o cliente nao cria ja marcado
  await rejects(() => as('conta', () => q(`insert into movements (tenant_id, data, conta_id, tipo, valor, subcategoria, sem_registo_previsto) values ($1,'2026-09-19',$2,'debito',5,'outro',true)`, [ids.tenantA, ids.bank])), /sem_registo_previsto so se marca/)
  // so uma alocacao realmente por ligar: uma despesa solta, um credito ou uma alocacao sem rota nao
  const manual = (await as('conta', () => q(`insert into movements (tenant_id, data, conta_id, tipo, valor, subcategoria) values ($1,'2026-09-19',$2,'debito',5,'outro') returning id`, [ids.tenantA, ids.bank])))[0].id
  await rejects(() => flag(manual, true), /so uma alocacao "por ligar"/)
  const noRota = (await as('conta', () => q(`insert into movements (tenant_id, data, conta_id, tipo, valor, subcategoria, lancamento_referencia_id) values ($1,'2026-09-19',$2,'debito',5,'outro',$3) returning id`, [ids.tenantA, ids.bank, T])))[0].id
  await rejects(() => flag(noRota, true), /so uma alocacao "por ligar"/)
  // quem nao escreve na Contabilidade nao marca
  assert.equal((await flag(A, true, 'oper')).length, 0)
  assert.equal((await flag(A, true))[0].s, true)                                   // Contabilista marca A
  await q(`select app.run_alerts(true)`)
  const of = async (id) => (await q(`select user_id from notifications where tipo='allocation_unlinked' and payload->>'movement_id'=$1`, [id])).length
  assert.equal(await of(A), 0)                                                    // marcada: fora do alerta
  assert.ok((await of(B)) >= 3)                                                   // a outra alerta (Gestor + Super Admin + Contabilista)
  // reversivel
  assert.equal((await flag(A, false))[0].s, false)
  await q(`select app.run_alerts(true)`)
  assert.ok((await of(A)) >= 3)
  // marcada e depois a rota (ou a data) muda: volta a "por ligar" (o destino e outro)
  await flag(A, true)
  await as('conta', () => q(`update movements set data = app.today() - 7 where id=$1`, [A]))
  assert.equal((await q(`select sem_registo_previsto s from movements where id=$1`, [A]))[0].s, false)
  // rotas apagadas nao alertam
  await q(`delete from notifications`)
  await as('admin', () => q(`update routes set deleted_at=now() where id=$1`, [rota]))
  await q(`select app.run_alerts(true)`)
  assert.equal((await of(A)) + (await of(B)), 0)
})

test('pedir correcao: -1 = ninguem a avisar; payload leva a rota/data do REGISTO de origem; RPC do registo de origem e do estado', async () => {
  await q(`delete from notifications`)
  const rB = (await as('admin', () => q(`insert into routes (operation_id, nome) values ($1,'Rota Origem') returning id`, [ids.op1])))[0].id
  const rec = (await as('oper', () => q(`insert into daily_records (route_id, data, comb_valor, status) values ($1,'2026-01-25',30,'submetido') returning id`, [rB])))[0].id
  const auto = (await q(`select id, rota_id, data::text d from movements where registo_id=$1 and origem='automatico' and deleted_at is null`, [rec]))[0]
  // o Contabilista reclassifica o automatico para OUTRA rota: o registo a corrigir continua a ser o de origem
  await as('conta', () => q(`update movements set rota_id=$2 where id=$1`, [auto.id, ids.rota1]))
  assert.equal((await as('conta', () => q(`select request_cost_correction($1,'errado') n`, [auto.id])))[0].n, 2)
  const n = await q(`select payload from notifications where tipo='auto_cost_disputed'`)
  assert.equal(n[0].payload.route_id, rB); assert.equal(n[0].payload.route, 'Rota Origem'); assert.equal(n[0].payload.data, '2026-01-25'); assert.equal(n[0].payload.registo_id, rec)
  assert.equal((await as('conta', () => q(`select request_cost_correction($1,'outra vez') n`, [auto.id])))[0].n, 0)     // ja pedido hoje
  // nenhum destinatario alem do proprio (Super Admin a pedir, sem Gestor atribuido): -1
  await q(`delete from user_operations where user_id=$1 and operation_id=$2`, [ids.gestor, ids.op1])
  try {
    await q(`delete from notifications`)
    assert.equal((await as('admin', () => q(`select request_cost_correction($1,'x') n`, [auto.id])))[0].n, -1)
  } finally { await q(`insert into user_operations (user_id, operation_id) values ($1,$2)`, [ids.gestor, ids.op1]) }
  // RPC do registo de origem: rota e data do REGISTO (nao do movimento reclassificado); so quem le a Contabilidade
  const o = (await as('conta', () => q(`select route, data::text d, status from movement_origin_record($1)`, [auto.id])))[0]
  assert.deepEqual([o.route, o.d, o.status], ['Rota Origem', '2026-01-25', 'submetido'])
  assert.equal((await as('oper', () => q(`select * from movement_origin_record($1)`, [auto.id]))).length, 0)
  assert.equal((await as('adminB', () => q(`select * from movement_origin_record($1)`, [auto.id]))).length, 0)
  // estado do registo de uma rota+data (para avisar antes de ligar uma alocacao a um registo Validado)
  const st = (r, d, who = 'conta') => as(who, () => q(`select record_status($1,$2) s`, [r, d])).then((x) => x[0].s)
  assert.equal(await st(rB, '2026-01-25'), 'submetido')
  await as('gestor', () => q(`update daily_records set status='validado' where id=$1`, [rec]))
  assert.equal(await st(rB, '2026-01-25'), 'validado')
  assert.equal(await st(rB, '2026-01-26'), null)
  assert.equal(await st(rB, '2026-01-25', 'oper'), null)     // quem nao le a Contabilidade nao ve
})

// =====================================================================
// Migracao 0021: pacote B da 4.a ronda (P3, P8, P9, P12)
// =====================================================================

test('P3: mudar o TIPO de uma alocacao ja propagada apaga a linha de custo; Credito -> Debito liga-a de novo', async () => {
  const rec = (await as('oper', () => q(`insert into daily_records (route_id, data) values ($1,'2026-01-30') returning id`, [ids.rota1])))[0].id
  const T = (await as('conta', () => q(`insert into movements (tenant_id, data, conta_id, tipo, valor, subcategoria, pessoa_responsavel) values ($1,'2026-01-30',$2,'debito',300,'transferencia_distribuicao','QA-Tipo') returning id`, [ids.tenantA, ids.bank])))[0].id
  const A = (await as('conta', () => q(`insert into movements (tenant_id, data, conta_id, tipo, valor, subcategoria, pessoa_responsavel, lancamento_referencia_id, operation_id, rota_id) values ($1,'2026-01-30',$2,'debito',40,'outro','QA-Tipo',$3,$4,$5) returning id`, [ids.tenantA, ids.bank, T, ids.op1, ids.rota1])))[0].id
  const active = () => q(`select count(*)::int n from daily_record_costs where record_id=$1 and movimento_id=$2 and deleted_at is null`, [rec, A]).then((r) => r[0].n)
  const registo = async () => (await q(`select registo_id from movements where id=$1`, [A]))[0].registo_id
  assert.equal(await active(), 1); assert.equal(await registo(), rec)
  await as('gestor', () => q(`update daily_records set status='validado' where id=$1`, [rec]))
  await q(`delete from notifications`)
  // Debito -> Credito: deixa de ser um custo
  await as('conta', () => q(`update movements set tipo='credito' where id=$1`, [A]))
  assert.equal(await active(), 0); assert.equal(await registo(), null)
  assert.deepEqual((await q(`select status, validado_por from daily_records where id=$1`, [rec]))[0], { status: 'submetido', validado_por: null })
  assert.deepEqual((await q(`select user_id from notifications where tipo='record_reopened' and payload->>'record_id'=$1`, [rec])).map((n) => n.user_id), [ids.gestor])
  // Credito -> Debito: volta a ligar-se ao registo (existe), com UMA linha ativa
  await as('conta', () => q(`update movements set tipo='debito' where id=$1`, [A]))
  assert.equal(await active(), 1); assert.equal(await registo(), rec)
  // editar so o valor continua a nao mexer na linha
  await as('conta', () => q(`update movements set valor=41 where id=$1`, [A]))
  assert.equal(await active(), 1)
})

test('P8: "Sem registo previsto" — quando o registo aparece e a alocacao se liga, a marca e limpa (estado coerente)', async () => {
  const rota = (await as('admin', () => q(`insert into routes (operation_id, nome) values ($1,'Rota P8') returning id`, [ids.op1])))[0].id
  const T = (await as('conta', () => q(`insert into movements (tenant_id, data, conta_id, tipo, valor, subcategoria, pessoa_responsavel) values ($1,'2026-02-15',$2,'debito',100,'transferencia_distribuicao','QA-P8') returning id`, [ids.tenantA, ids.bank])))[0].id
  const A = (await as('conta', () => q(`insert into movements (tenant_id, data, conta_id, tipo, valor, subcategoria, pessoa_responsavel, lancamento_referencia_id, operation_id, rota_id) values ($1,'2026-02-15',$2,'debito',10,'outro','QA-P8',$3,$4,$5) returning id`, [ids.tenantA, ids.bank, T, ids.op1, rota])))[0].id
  await as('conta', () => q(`update movements set sem_registo_previsto=true where id=$1`, [A]))
  const rec = (await as('oper', () => q(`insert into daily_records (route_id, data) values ($1,'2026-02-15') returning id`, [rota])))[0].id
  const m = (await q(`select registo_id, sem_registo_previsto s from movements where id=$1`, [A]))[0]
  assert.equal(m.registo_id, rec); assert.equal(m.s, false)                       // ligada => a marca deixa de existir
  assert.equal((await q(`select count(*)::int n from movements where registo_id is not null and sem_registo_previsto`))[0].n, 0)   // nunca coexistem
})

test('P9: app.system_write repoe o valor ANTERIOR (attach_allocations, sync_auto_movements, drop_allocation_line, relink)', async () => {
  const rota = (await as('admin', () => q(`insert into routes (operation_id, nome) values ($1,'Rota P9') returning id`, [ids.op1])))[0].id
  const rec = (await as('oper', () => q(`insert into daily_records (route_id, data, comb_valor, status) values ($1,'2026-02-16',20,'submetido') returning id`, [rota])))[0].id
  const cur = async () => (await q(`select coalesce(current_setting('app.system_write', true), '') v`))[0].v
  await db.exec('begin')
  try {
    await q(`select set_config('app.system_write', '1', true)`)                   // contexto de sistema a chamar
    await q(`select app.attach_allocations($1)`, [rec]); assert.equal(await cur(), '1')
    await q(`select app.sync_auto_movements($1)`, [rec]); assert.equal(await cur(), '1')
    await q(`select app.drop_allocation_line(gen_random_uuid(), $1)`, [rec]); assert.equal(await cur(), '1')
    await q(`select set_config('app.system_write', '0', true)`)
    await q(`select app.attach_allocations($1)`, [rec]); assert.equal(await cur(), '0')
    await q(`select app.sync_auto_movements($1)`, [rec]); assert.equal(await cur(), '0')
  } finally { await db.exec('rollback') }
})

test('P12: uma alocacao = uma linha de custo ativa (indice unico + on conflict); ligacao concorrente nao duplica', async () => {
  const rota = (await as('admin', () => q(`insert into routes (operation_id, nome) values ($1,'Rota P12') returning id`, [ids.op1])))[0].id
  const T = (await as('conta', () => q(`insert into movements (tenant_id, data, conta_id, tipo, valor, subcategoria, pessoa_responsavel) values ($1,'2026-02-17',$2,'debito',100,'transferencia_distribuicao','QA-P12') returning id`, [ids.tenantA, ids.bank])))[0].id
  const A = (await as('conta', () => q(`insert into movements (tenant_id, data, conta_id, tipo, valor, subcategoria, pessoa_responsavel, lancamento_referencia_id, operation_id, rota_id) values ($1,'2026-02-17',$2,'debito',10,'outro','QA-P12',$3,$4,$5) returning id`, [ids.tenantA, ids.bank, T, ids.op1, rota])))[0].id
  const rec = (await as('oper', () => q(`insert into daily_records (route_id, data) values ($1,'2026-02-17') returning id`, [rota])))[0].id
  const lines = () => q(`select count(*)::int n from daily_record_costs where movimento_id=$1 and deleted_at is null`, [A]).then((r) => r[0].n)
  assert.equal(await lines(), 1)
  // um 2.o custo ativo para a mesma alocacao e impossivel
  await rejects(() => q(`insert into daily_record_costs (record_id, categoria, valor, movimento_id) values ($1,'dup',10,$2)`, [rec, A]), /unique|duplicate/)
  // duas ligacoes concorrentes (a alocacao ainda parecia "por ligar" aos dois): a 2.a nao duplica nem falha
  await q(`select set_config('app.system_write', '1', false)`)
  await q(`update movements set registo_id = null where id=$1`, [A])
  await q(`select set_config('app.system_write', '0', false)`)
  await q(`select app.attach_allocations($1)`, [rec])
  assert.equal(await lines(), 1); assert.equal((await q(`select registo_id from movements where id=$1`, [A]))[0].registo_id, rec)
  // a linha apagada (soft) nao bloqueia uma nova (relink)
  await q(`update daily_record_costs set deleted_at = now() where movimento_id=$1`, [A])
  await q(`insert into daily_record_costs (record_id, categoria, valor, movimento_id) values ($1,'nova',10,$2)`, [rec, A])
  assert.equal(await lines(), 1)
})

// =====================================================================
// Migracao 0022: a visibilidade de registos diarios e custos por papel e EXATAMENTE a de antes (oraculo em SQL, sem policies)
// =====================================================================

test('0022: daily_records e daily_record_costs — cada papel ve exatamente o que as regras dizem (oraculo), incluindo o Motorista e o Tenant B', async () => {
  const idsOf = (rows) => rows.map((r) => r.id).sort()
  const ROUTES_OF_A = `select r.id from routes r join operations o on o.id = r.operation_id where o.tenant_id = '${ids.tenantA}'`
  const oracle = {
    // Super Admin: tudo do tenant; Gestor/Operador/Auditor: rotas das operacoes atribuidas; Motorista: so os seus; Contabilista: nada
    admin: `select d.id from daily_records d where d.route_id in (${ROUTES_OF_A})`,
    gestor: `select d.id from daily_records d join routes r on r.id = d.route_id where r.operation_id in (select operation_id from user_operations where user_id = '${ids.gestor}')`,
    oper: `select d.id from daily_records d join routes r on r.id = d.route_id where r.operation_id in (select operation_id from user_operations where user_id = '${ids.oper}')`,
    aud: `select d.id from daily_records d join routes r on r.id = d.route_id where r.operation_id in (select operation_id from user_operations where user_id = '${ids.aud}')`,
    mot: `select d.id from daily_records d where d.created_by = '${ids.mot}' and d.route_id in (${ROUTES_OF_A})`,
    conta: `select d.id from daily_records d where false`,
    adminB: `select d.id from daily_records d where d.route_id in (select r.id from routes r join operations o on o.id = r.operation_id where o.tenant_id = '${ids.tenantB ?? (await q(`select tenant_id from profiles where id=$1`, [ids.adminB]))[0].tenant_id}')`,
  }
  assert.ok((await q(oracle.admin)).length > 20, 'o teste precisa de dados suficientes')
  for (const [who, sql] of Object.entries(oracle)) {
    const want = idsOf(await q(sql))
    const got = idsOf(await as(who, () => q(`select id from daily_records`)))
    assert.deepEqual(got, want, `${who}: registos visiveis`)
    // custos: visiveis exatamente quando o registo o e
    const wantC = (await q(`select count(*)::int n from daily_record_costs where record_id = any($1::uuid[])`, [want]))[0].n
    const gotC = (await as(who, () => q(`select count(*)::int n from daily_record_costs`)))[0].n
    assert.equal(gotC, wantC, `${who}: linhas de custo visiveis`)
    // as consultas por chave (o que a UI faz) devolvem o mesmo
    if (want.length) assert.equal((await as(who, () => q(`select id from daily_records where id = $1`, [want[0]]))).length, 1, `${who}: consulta por id`)
  }
  // um registo de outro tenant nao se le mesmo conhecendo o id
  const anyA = (await q(`select id from daily_records limit 1`))[0].id
  assert.equal((await as('adminB', () => q(`select id from daily_records where id = $1`, [anyA]))).length, 0)
  // o Motorista continua a nao ver registos de outros
  const other = (await q(`select id from daily_records where created_by is distinct from $1 limit 1`, [ids.mot]))[0].id
  assert.equal((await as('mot', () => q(`select id from daily_records where id = $1`, [other]))).length, 0)
})

test('0023: audit_log so o Super Admin do PROPRIO tenant le (oraculo); os outros papeis e o Tenant B nao veem o do A', async () => {
  const tB = (await q(`select tenant_id from profiles where id=$1`, [ids.adminB]))[0].tenant_id
  const nA = (await q(`select count(*)::int n from audit_log where tenant_id=$1`, [ids.tenantA]))[0].n
  const nB = (await q(`select count(*)::int n from audit_log where tenant_id=$1`, [tB]))[0].n
  assert.ok(nA > 100 && nB > 0)
  const count = (who) => as(who, () => q(`select count(*)::int n from audit_log`)).then((r) => r[0].n)
  assert.equal(await count('admin'), nA)
  assert.equal(await count('adminB'), nB)
  for (const who of ['gestor', 'oper', 'mot', 'aud', 'conta']) assert.equal(await count(who), 0, who)
  // e nao consegue alterar/apagar
  await rejects(() => as('admin', () => q(`update audit_log set acao='x'`)), /permission|imutavel/)
})
