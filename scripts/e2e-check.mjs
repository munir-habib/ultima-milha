// Verificacao ponta-a-ponta contra o projeto Supabase real, com as mesmas consultas que a app faz.
//   node scripts/e2e-check.mjs [email] [password]
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'

const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8').split(/\r?\n/).filter((l) => l.includes('=')).map((l) => [l.split('=')[0], l.slice(l.indexOf('=') + 1).trim()]),
)
const [email = 'demo.admin@example.test', password = process.env.DEMO_PASSWORD] = process.argv.slice(2)
const sb = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY, { auth: { persistSession: false } })
const anon = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY, { auth: { persistSession: false } })

let pass = 0
const check = async (name, fn) => {
  try {
    await fn()
    pass++
    console.log('  ok  ', name)
  } catch (e) {
    console.log('  FALHA', name, '-', e.message)
    process.exitCode = 1
  }
}
const q = async (p) => {
  const { data, error } = await p
  if (error) throw new Error(error.message)
  return data
}

const { error: loginErr } = await sb.auth.signInWithPassword({ email, password })
assert.ok(!loginErr, 'login: ' + loginErr?.message)
const uid = (await sb.auth.getUser()).data.user.id

await check('perfil, papel Super Admin e empresa', async () => {
  const p = await q(sb.from('profiles').select('nome,tenant_id').eq('id', uid).single())
  const r = await q(sb.from('user_roles').select('role').eq('user_id', uid))
  assert.deepEqual(r.map((x) => x.role), ['super_admin'])
  assert.ok(p.tenant_id)
})

await check('anonimo nao le nada (RLS)', async () => {
  for (const t of ['daily_records', 'operations', 'movements', 'profiles', 'vehicles']) {
    const { data } = await anon.from(t).select('id').limit(1)
    assert.equal((data ?? []).length, 0, t)
  }
})

await check('30 registos com receita calculada pelo servidor', async () => {
  const rows = await q(sb.from('daily_records').select('receita_total,receita_breakdown,status').is('deleted_at', null))
  assert.equal(rows.length, 30)
  assert.ok(rows.every((r) => Number(r.receita_total) > 0))
  const sumParts = rows.every((r) => Math.abs(['por_estado', 'valor_fixo', 'por_zona', 'por_distancia'].reduce((a, k) => a + Number(r.receita_breakdown[k]), 0) - Number(r.receita_total)) < 0.011)
  assert.ok(sumParts, 'componentes somam o total')
})

await check('consulta do Dashboard (registos + linhas de custo embutidas)', async () => {
  const rows = await q(sb.from('daily_records').select('id,route_id,data,status,viatura_id,motorista_ids,km,enc_entregues,comb_valor,portagens_valor,receita_breakdown,receita_total,daily_record_costs(valor,deleted_at)').limit(50))
  assert.ok(rows.length > 0)
  assert.ok(rows.some((r) => r.daily_record_costs.length > 0), 'propagacao da distribuicao chegou ao registo')
})

await check('vistas de opcoes (pickers) e custos de viatura', async () => {
  assert.equal((await q(sb.from('route_options').select('*'))).length, 3)
  assert.equal((await q(sb.from('operation_options').select('*'))).length, 2)
  assert.equal((await q(sb.from('zone_options').select('*'))).length, 3)
  assert.equal((await q(sb.from('vehicle_options').select('*'))).length, 3)
  assert.equal((await q(sb.from('driver_options').select('*').not('nome', 'ilike', 'qa%'))).length, 3) // ignora motoristas de teste (qa.*)
})

await check('tarifario versionado: as 3 rotas ativas tem snapshot (versionado por valid_from + versao)', async () => {
  const routes = (await q(sb.from('route_options').select('id'))).map((r) => r.id)  // so rotas ativas: ignora rotas de teste apagadas
  assert.equal(routes.length, 3)
  const s = await q(sb.from('tariff_snapshots').select('route_id,valid_from,versao,config').in('route_id', routes))
  for (const r of routes) assert.ok(s.some((x) => x.route_id === r), 'rota sem snapshot: ' + r)
  assert.ok(s.every((x) => Number.isInteger(x.versao) && x.versao >= 1))
})

await check('metas e contabilidade', async () => {
  assert.equal((await q(sb.from('goals').select('id').is('deleted_at', null))).length, 3)
  assert.ok((await q(sb.from('movements').select('id').is('deleted_at', null))).length >= 5)
  assert.equal((await q(sb.from('bank_accounts').select('id').is('deleted_at', null))).length, 1)
})

await check('editar registo validado reabre-o (Submetido) e regista audit antes/depois', async () => {
  const [rec] = await q(sb.from('daily_records').select('id,km,status').eq('status', 'validado').limit(1))
  const km = Number(rec.km) + 1
  const upd = await q(sb.from('daily_records').update({ km }).eq('id', rec.id).select('status,km').single())
  assert.equal(upd.status, 'submetido')
  const log = await q(sb.from('audit_log').select('acao,antes,depois,user_id').eq('registo_id', rec.id).eq('tabela', 'daily_records').order('id', { ascending: false }).limit(1))
  assert.equal(log[0].user_id, uid)
  assert.equal(Number(log[0].antes.km), Number(rec.km))
  assert.equal(Number(log[0].depois.km), km)
  // repor: validar de novo e devolver o km (deixa os dados de exemplo como estavam)
  await q(sb.from('daily_records').update({ km: rec.km, status: 'validado' }).eq('id', rec.id))
})

await check('nao e possivel apagar fisicamente', async () => {
  const { error } = await sb.from('daily_records').delete().eq('id', '00000000-0000-0000-0000-000000000000')
  assert.ok(error, 'DELETE devia falhar')
})

await check('notificacoes visiveis so ao proprio utilizador', async () => {
  const n = await q(sb.from('notifications').select('id,tipo,payload,lido_em').order('created_at', { ascending: false }).limit(10))
  assert.ok(n.length >= 1)
  assert.equal(((await anon.from('notifications').select('id')).data ?? []).length, 0)
})

await check('Edge Function invite-user publicada e a validar (nao envia email)', async () => {
  const { data, error } = await sb.functions.invoke('invite-user', { body: { email: '', roles: ['operador'], operation_ids: [] } })
  const msg = JSON.stringify(data ?? '') + (error?.message ?? '')
  assert.ok(/email invalido|non-2xx/i.test(msg) || data?.error, 'resposta inesperada: ' + msg)
})

console.log(`\n${pass} verificacoes passaram${process.exitCode ? ' (com falhas)' : ''}.`)
