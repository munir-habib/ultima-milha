// Dados de exemplo para o tenant demo (30 registos diarios + configuracao + contabilidade).
// Corre como o utilizador demo (RLS e triggers reais, nada e contornado).
//   node scripts/seed-demo.mjs [email] [password]
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'

const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8').split(/\r?\n/).filter((l) => l.includes('=')).map((l) => [l.split('=')[0], l.slice(l.indexOf('=') + 1).trim()]),
)
const [email = 'demo.admin@example.test', password = process.env.DEMO_PASSWORD] = process.argv.slice(2)
const sb = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY, { auth: { persistSession: false } })

const ok = ({ data, error }, what) => {
  if (error) throw new Error(`${what}: ${error.message}`)
  return data
}

// PRNG determinista: o mesmo seed gera sempre os mesmos numeros
let s = 20260919
const rnd = () => {
  s = (s + 0x6d2b79f5) | 0
  let t = Math.imul(s ^ (s >>> 15), 1 | s)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const between = (a, b) => Math.round(a + rnd() * (b - a))
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const daysAgo = (n) => iso(new Date(Date.now() - n * 86400000))

await sb.auth.signInWithPassword({ email, password }).then((r) => ok(r, 'login'))
const me = (await sb.auth.getUser()).data.user
const profile = ok(await sb.from('profiles').select('tenant_id').eq('id', me.id).single(), 'profile')
const tenant = profile.tenant_id

if (ok(await sb.from('daily_records').select('id', { count: 'exact', head: false }).limit(1), 'check').length) {
  console.log('Dados de exemplo ja existem - nada a fazer.')
  process.exit(0)
}

// Retomavel: reutiliza por nome o que ja foi criado (nada e apagado fisicamente)
const one = async (table, match, row, what) => {
  let q = sb.from(table).select('id')
  for (const [k, v] of Object.entries(match)) q = q.eq(k, v)
  const found = ok(await q.limit(1), what)
  if (found.length) return found[0].id
  return ok(await sb.from(table).insert(row).select('id').single(), what).id
}

// ---------- operacoes, zonas, rotas ----------
const mkOp = (nome, valores, sal) => one('operations', { nome }, { tenant_id: tenant, nome, valores_estado: valores, ...sal }, `op ${nome}`)

const lisboa = await mkOp(
  'Lisboa Norte',
  { entregues: 1.8, devolucoes: 0.9, recolhas: 1.2, canceladas: 0, transitadas: 0, pendentes_entrega: 0, pendentes_recolha: 0 },
  { salario_fixo_mensal: 2400, salario_var_por_entrega: 0.1, salario_var_pct_receita: 0, outros_custos_mensais: 180 },
)
const porto = await mkOp(
  'Porto Centro',
  { entregues: 2.1, devolucoes: 1, recolhas: 1.4, canceladas: 0, transitadas: 0, pendentes_entrega: 0, pendentes_recolha: 0 },
  { salario_fixo_mensal: 1800, salario_var_por_entrega: 0, salario_var_pct_receita: 8, outros_custos_mensais: 120 },
)

const zones = {}
for (const [nome, prefixos, valor] of [['Norte', ['1600', '1700'], 2.4], ['Centro', ['1000', '1100', '1200'], 2.9], ['Periferia', ['2600', '2700'], 3.6]]) {
  zones[nome] = await one('postal_zones', { operation_id: lisboa, nome }, { operation_id: lisboa, nome, prefixos, valor_por_entrega: valor }, `zona ${nome}`)
}

const mkRoute = (operation_id, nome, extra) => one('routes', { operation_id, nome }, { operation_id, nome, ...extra }, `rota ${nome}`)
const rotaA = await mkRoute(lisboa, 'Rota A - Fixo', { tarifa_por_estado: true, tarifa_valor_fixo: true, valor_fixo_default: 35 })
const rotaB = await mkRoute(lisboa, 'Rota B - Zonas e km', { tarifa_por_estado: true, tarifa_por_zona: true, tarifa_por_distancia: true, taxa_km: 0.35 })
const rotaP = await mkRoute(porto, 'Rota P - Escaloes', {
  tarifa_por_estado: true,
  tarifa_por_distancia: true,
  escaloes_km: [{ de: 0, ate: 60, valor: 0.4 }, { de: 60, ate: null, valor: 0.25 }],
})

// ---------- frota e motoristas ----------
const slot1 = await one('fleet_slots', { nome: 'Carro 1' }, { tenant_id: tenant, nome: 'Carro 1' }, 'posto')
const slot2 = await one('fleet_slots', { nome: 'Carro 2' }, { tenant_id: tenant, nome: 'Carro 2' }, 'posto')
const mkVeh = (v) => one('vehicles', { matricula: v.matricula }, { tenant_id: tenant, ...v }, `viatura ${v.matricula}`)
const vehicles = [
  await mkVeh({ matricula: '12-AB-34', posto_id: slot1, iuc_ativo: true, iuc_valor: 25, seguro_ativo: true, seguro_valor: 90, manutencao_ativo: true, manutencao_valor: 60 }),
  await mkVeh({ matricula: '56-CD-78', posto_id: slot2, seguro_ativo: true, seguro_valor: 85 }),
  await mkVeh({ matricula: '90-EF-12', tipo: 'alugada', aluguer_fornecedor: 'Rent-a-Van', aluguer_custo: 45, aluguer_periodicidade: 'diario', aluguer_data_inicio: daysAgo(30) }),
]
const drivers = []
for (const nome of ['Miguel Santos', 'Ana Ferreira', 'Rui Costa']) {
  drivers.push(await one('drivers', { nome }, { tenant_id: tenant, nome, contacto: '9' + between(10000000, 39999999) }, `motorista ${nome}`))
}

// ---------- 30 registos diarios: 10 dias x 3 rotas ----------
const plan = [
  { route: rotaA, vol: [55, 90], km: [70, 110], zones: false },
  { route: rotaB, vol: [70, 120], km: [90, 150], zones: true },
  { route: rotaP, vol: [45, 85], km: [60, 100], zones: false },
]
const zoneIds = Object.values(zones)
const records = []
for (let d = 1; d <= 10; d++) {
  for (const p of plan) {
    const entregues = between(...p.vol)
    const total = entregues + between(2, 9)
    const status = d > 6 ? 'validado' : d > 2 ? 'submetido' : 'rascunho'
    const rec = {
      route_id: p.route,
      data: daysAgo(d),
      status,
      viatura_id: vehicles[between(0, 2)],
      motorista_ids: [drivers[between(0, 2)]],
      km: between(...p.km),
      enc_entregues: entregues,
      enc_devolucoes: between(1, 8),
      enc_recolhas: between(0, 12),
      enc_canceladas: between(0, 3),
      enc_transitadas: between(0, 4),
      enc_pendentes_entrega: between(0, 6),
      enc_pendentes_recolha: between(0, 3),
      comb_litros: between(14, 30),
      comb_tipo: 'Gasoleo',
      portagens_valor: rnd() > 0.5 ? between(2, 9) : null,
      valor_fixo_do_dia: p.route === rotaA ? 35 : null,
      entregas_por_zona: {},
    }
    rec.comb_valor = Math.round(rec.comb_litros * 1.62 * 100) / 100
    if (p.zones) {
      const split = zoneIds.map((_, i) => (i < 2 ? between(10, Math.floor(total / 3)) : 0))
      split[2] = Math.max(0, entregues - split[0] - split[1])
      rec.entregas_por_zona = Object.fromEntries(zoneIds.map((z, i) => [z, split[i]]))
    }
    records.push(rec)
  }
}
const inserted = ok(await sb.from('daily_records').insert(records).select('id,route_id,data,status,receita_total'), 'registos')

// ---------- contabilidade ----------
const bank = await one('bank_accounts', { nome: 'Conta Principal' }, { tenant_id: tenant, nome: 'Conta Principal', banco: 'Banco Exemplo' }, 'conta')
// o estado inicial (e a origem) sao decididos pelo servidor: o seed nao os envia (manual = Confirmado; alocacao = Pendente)
const mov = (o) => ({ tenant_id: tenant, conta_id: bank, ...o })
const transfer = ok(
  await sb.from('movements').insert(mov({ data: daysAgo(6), tipo: 'debito', valor: 300, subcategoria: 'transferencia_distribuicao', pessoa_responsavel: 'Miguel Santos', descricao: 'Fundo semanal' })).select('id').single(),
  'transferencia',
).id
await sb.from('movements').insert([
  mov({ data: daysAgo(5), tipo: 'debito', valor: 120, subcategoria: 'outro', operation_id: lisboa, rota_id: rotaA, pessoa_responsavel: 'Miguel Santos', lancamento_referencia_id: transfer, descricao: 'Combustivel e portagens' }),
  mov({ data: daysAgo(9), tipo: 'credito', valor: 4200, subcategoria: 'outro', descricao: 'Recebimento cliente' }),
  mov({ data: daysAgo(8), tipo: 'debito', valor: 210, subcategoria: 'manutencao', descricao: 'Revisao 12-AB-34' }),
  mov({ data: daysAgo(3), tipo: 'debito', valor: 85, subcategoria: 'deslocacao_equipa', operation_id: porto, descricao: 'Deslocacao equipa Porto' }),
]).then((r) => ok(r, 'movimentos'))

// ---------- metas ----------
await sb.from('goals').insert([
  { operation_id: lisboa, metrica: 'receita', alvo: 4000 },
  { operation_id: lisboa, route_id: rotaB, metrica: 'encomendas', alvo: 1500 },
  { operation_id: porto, metrica: 'margem', alvo: 1200 },
]).then((r) => ok(r, 'metas'))

const total = inserted.reduce((a, r) => a + Number(r.receita_total), 0)
console.log(`OK: ${inserted.length} registos (receita total ${total.toFixed(2)} EUR), 2 operacoes, 3 rotas, 3 viaturas, 3 motoristas, 5 movimentos, 3 metas.`)
console.log('Estado dos registos:', inserted.reduce((a, r) => ((a[r.status] = (a[r.status] ?? 0) + 1), a), {}))
