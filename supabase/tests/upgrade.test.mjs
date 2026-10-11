// Teste de ATUALIZACAO: aplica as migracoes ate 0010 (estado do projeto real antes do endurecimento),
// cria dados "sujos" que as regras antigas permitiam (2 viaturas no mesmo posto, viaturas vendidas/apagadas
// com posto...) e aplica 0011+ — a migracao tem de reparar os dados antes de criar os indices unicos.
// Correr: npm run test:db
import { PGlite } from '@electric-sql/pglite'
import { readFileSync, readdirSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const dir = new URL('../migrations/', import.meta.url)
const STUB = `
create schema auth;
create table auth.users (id uuid primary key default gen_random_uuid(), email text, raw_user_meta_data jsonb default '{}');
create function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create role anon nologin; create role authenticated nologin;
grant usage on schema public, auth to anon, authenticated;
alter default privileges in schema public grant all on tables to anon, authenticated;
`
const num = (f) => Number(f.match(/^\d{8}(\d{6})_/)[1])

test('upgrade 0010 -> 0023: repara postos/viaturas sujos e cria os indices unicos', async () => {
  const db = new PGlite()
  const q = (sql, p) => db.query(sql, p).then((r) => r.rows)
  await db.exec(STUB)
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
  const apply = async (fs) => { for (const f of fs) { try { await db.exec(readFileSync(new URL(f, dir), 'utf8')) } catch (e) { throw new Error(`migration ${f}: ${e.message}`) } } }
  await apply(files.filter((f) => num(f) <= 10))

  await q(`insert into auth.users (email, raw_user_meta_data) values ('a@x.pt', '{"full_name":"A","tenant_name":"T"}')`)
  const tenant = (await q(`select tenant_id from profiles limit 1`))[0].tenant_id
  const slot = async (n) => (await q(`insert into fleet_slots (tenant_id, nome) values ($1,$2) returning id`, [tenant, n]))[0].id
  const veh = async (plate, posto) => (await q(`insert into vehicles (tenant_id, matricula, posto_id) values ($1,$2,$3) returning id`, [tenant, plate, posto]))[0].id
  const [p1, p2, p3, p4, p5] = [await slot('P1'), await slot('P2'), await slot('P3'), await slot('P4'), await slot('P5')]

  // estado sujo permitido pelas regras antigas
  const a = await veh('U-01', p1)
  const b = await veh('U-02', p1)                      // 2 viaturas no mesmo posto (F6): 2 ocupacoes abertas
  const c = await veh('U-03', p2)
  await q(`update vehicles set estado='vendida' where id=$1`, [c])          // vendida continua no posto (F8)
  const d = await veh('U-04', p3)
  await q(`update vehicles set deleted_at=now() where id=$1`, [d])           // apagada continua no posto (F7)
  const e = await veh('U-05', p4)
  await q(`update vehicles set estado='em_manutencao' where id=$1`, [e])
  const f = await veh('U-06', p5)                                            // saudavel: nao pode ser tocada
  assert.equal((await q(`select count(*)::int n from slot_assignments where posto_id=$1 and data_fim is null`, [p1]))[0].n, 2)

  // linha de custo com a etiqueta antiga (hifen): a 0016 passa-a para travessao
  const op = (await q(`insert into operations (tenant_id, nome) values ($1,'Op U') returning id`, [tenant]))[0].id
  const rota = (await q(`insert into routes (operation_id, nome) values ($1,'Rota U') returning id`, [op]))[0].id
  const rec = (await q(`insert into daily_records (route_id, data) values ($1,'2026-01-10') returning id`, [rota]))[0].id
  await q(`insert into daily_record_costs (record_id, categoria, valor) values ($1,'Pagamento distribuído - Ana',10), ($1,'Combustivel - extra',5)`, [rec])

  // movimento antigo com dados que as regras novas recusariam se fossem escritos hoje: a migracao nao pode falhar por isso
  await apply(files.filter((f) => num(f) >= 11))

  const open = async (p) => (await q(`select vehicle_id from slot_assignments where posto_id=$1 and data_fim is null`, [p])).map((r) => r.vehicle_id)
  assert.deepEqual(await open(p1), [b])               // fica a que entrou mais recentemente
  assert.equal((await q(`select posto_id from vehicles where id=$1`, [a]))[0].posto_id, null)
  for (const [v, p] of [[c, p2], [d, p3], [e, p4]]) {
    assert.equal((await q(`select posto_id from vehicles where id=$1`, [v]))[0].posto_id, null)
    assert.deepEqual(await open(p), [])
  }
  assert.deepEqual(await open(p5), [f])               // a saudavel ficou intacta
  assert.equal((await q(`select posto_id from vehicles where id=$1`, [f]))[0].posto_id, p5)
  assert.equal((await q(`select count(*)::int n from slot_assignments where data_fim < data_inicio`))[0].n, 0)

  assert.deepEqual((await q(`select categoria from daily_record_costs where record_id=$1 order by valor desc`, [rec])).map((r) => r.categoria), ['Pagamento distribuído — Ana', 'Combustivel - extra'])

  // os indices unicos ficaram ativos
  await assert.rejects(() => q(`insert into slot_assignments (tenant_id, posto_id, vehicle_id, data_inicio) values ($1,$2,$3, current_date)`, [tenant, p1, a]))
  // snapshots existentes ganharam a versao 1
  const cols = await q(`select column_name from information_schema.columns where table_name='tariff_snapshots' and column_name='versao'`)
  assert.equal(cols.length, 1)
  await db.close()
})
