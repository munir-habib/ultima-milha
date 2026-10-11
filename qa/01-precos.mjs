// Cenario: integridade historica de precos + campos obrigatorios do registo diario.
// Usa SO dados QA- (rotas/operacao/registos). Guarda IDs em qa/ctx.json.
import { writeFileSync } from 'node:fs'
import { login, ADMIN, sql, t, setArea, eq, ok, must, denied, results, save } from './lib.mjs'

const admin = await login(...ADMIN)
const today = (await sql(`select (now() at time zone 'Europe/Lisbon')::date d`))[0].d
const ctx = { today }
await sql("update routes set deleted_at=now() where nome like 'QA-%' and deleted_at is null; update operations set deleted_at=now() where nome like 'QA-%' and deleted_at is null")
const ops = await must(admin.from('operation_options').select('id,nome'))
ctx.opLN = ops.find((o) => o.nome === 'Lisboa Norte').id
ctx.opPC = ops.find((o) => o.nome === 'Porto Centro').id

// ---- montar cenario ----
const mkRoute = (operation_id, nome, extra) => must(admin.from('routes').insert({ operation_id, nome, ...extra }).select('id').single()).then((r) => r.id)
ctx.routeLN = await mkRoute(ctx.opLN, 'QA-R-LN', { tarifa_por_estado: false, tarifa_valor_fixo: true, tarifa_por_distancia: true, taxa_km: 0.5, valor_fixo_default: 40 })
ctx.routePC = await mkRoute(ctx.opPC, 'QA-R-PC', { tarifa_por_estado: false, tarifa_valor_fixo: true, tarifa_por_distancia: true, taxa_km: 0.5, valor_fixo_default: 40 })
const tenant_id = (await must(admin.from('profiles').select('tenant_id').eq('id', admin.uid).single())).tenant_id
const opT = await must(admin.from('operations').insert({ tenant_id, nome: 'QA-Op Tarifa', valores_estado: { entregues: 1, devolucoes: 0, recolhas: 0, canceladas: 0, transitadas: 0, pendentes_entrega: 0, pendentes_recolha: 0 } }).select('id').single())
ctx.opT = opT.id
ctx.routeT = await mkRoute(ctx.opT, 'QA-R-Estados', { tarifa_por_estado: true })

setArea('Precos historicos')
const rec = (route_id, data, extra = {}) => must(admin.from('daily_records').insert({ route_id, data, ...extra }).select('*').single())
const snaps = (rid) => must(admin.from('tariff_snapshots').select('valid_from,versao,config').eq('route_id', rid).order('valid_from').order('versao'))

const R1 = await rec(ctx.routeLN, '2026-03-01', { valor_fixo_do_dia: 40, km: 100 })
ctx.R1 = R1.id
await t('registo antes da mudanca: receita = fixo 40 + 100km*0.50 = 90 (snapshot inicial)', async () => {
  eq(Number(R1.receita_total), 90, 'receita R1 ' + R1.id)
  eq(R1.tarifa_valid_from, '1900-01-01', 'tarifa_valid_from')
})

// mudar tarifario (taxa_km 0.5 -> 0.8)
await must(admin.from('routes').update({ taxa_km: 0.8 }).eq('id', ctx.routeLN))
await t('mudanca de tarifario cria nova versao com valid_from = hoje', async () => {
  const s = await snaps(ctx.routeLN)
  eq(s.length, 2, 'n.o de snapshots da rota ' + ctx.routeLN)
  eq(s[1].valid_from, today, 'valid_from da v2')
  eq(Number(s[1].config.taxa_km), 0.8, 'taxa v2')
})
await t('registo existente NAO e recalculado apos mudanca de tarifario', async () => {
  const r = await must(admin.from('daily_records').select('receita_total,tarifa_valid_from').eq('id', R1.id).single())
  eq(Number(r.receita_total), 90, 'receita R1 ' + R1.id)
})
const R2 = await rec(ctx.routeLN, '2026-03-02', { valor_fixo_do_dia: 40, km: 100 })
ctx.R2 = R2.id
await t('registo retroativo (data < mudanca) criado DEPOIS da mudanca usa tarifario antigo (90)', async () => {
  eq(Number(R2.receita_total), 90, 'receita R2 ' + R2.id)
  eq(R2.tarifa_valid_from, '1900-01-01', 'tarifa_valid_from R2')
})
const R3 = await rec(ctx.routeLN, '2026-12-01', { valor_fixo_do_dia: 40, km: 100 })
ctx.R3 = R3.id
await t('registo com data >= mudanca usa tarifario novo (40 + 80 = 120)', async () => {
  eq(Number(R3.receita_total), 120, 'receita R3 ' + R3.id)
  eq(R3.tarifa_valid_from, today, 'tarifa_valid_from R3')
})
await t('editar campo que nao e input de receita (combustivel) nao recalcula', async () => {
  const r = await must(admin.from('daily_records').update({ comb_valor: 10 }).eq('id', R1.id).select('receita_total').single())
  eq(Number(r.receita_total), 90, 'R1')
})
await t('editar input (km) num registo antigo recalcula com o tarifario DA SUA DATA (40 + 200*0.5 = 140)', async () => {
  const r = await must(admin.from('daily_records').update({ km: 200 }).eq('id', R1.id).select('receita_total,tarifa_valid_from').single())
  eq(Number(r.receita_total), 140, 'R1 ' + R1.id)
  eq(r.tarifa_valid_from, '1900-01-01', 'tarifa_valid_from')
})

// escaloes progressivos (2.a mudanca no MESMO dia)
await must(admin.from('routes').update({ escaloes_km: [{ de: 0, ate: 50, valor: 0.3 }, { de: 50, ate: null, valor: 0.2 }] }).eq('id', ctx.routeLN))
const R4 = await rec(ctx.routeLN, '2026-12-02', { valor_fixo_do_dia: 0, km: 120 })
ctx.R4 = R4.id
await t('escaloes progressivos: 120km = 50*0.30 + 70*0.20 = 29', async () => { eq(Number(R4.receita_total), 29, 'R4 ' + R4.id) })
await t('2.a mudanca no mesmo dia: R3 (calculado com v2 taxa 0.8) mantem receita gravada', async () => {
  const r = await must(admin.from('daily_records').select('receita_total').eq('id', R3.id).single())
  eq(Number(r.receita_total), 120, 'R3 ' + R3.id)
})
await t('reprodutibilidade: cada mudanca do dia e o seu proprio snapshot; a 1.a (taxa_km 0.8, sem escaloes) continua a reproduzir a receita 120 de R3', async () => {
  const hoje = (await snaps(ctx.routeLN)).filter((x) => x.valid_from === today)
  ok(hoje.length >= 2, 'esperava >= 2 snapshots de ' + today + ' (um por mudanca), obtive ' + hoje.length + ' (rota ' + ctx.routeLN + ')')
  const v1 = hoje.find((x) => x.versao === 1), v2 = hoje.find((x) => x.versao === 2)
  ok(v1 && v1.config.escaloes_km == null && Number(v1.config.taxa_km) === 0.8, 'snapshot ' + ctx.routeLN + '@' + today + ' v1 nao reproduz R3 (' + R3.id + '): ' + JSON.stringify(v1?.config))
  ok(v2 && Array.isArray(v2.config.escaloes_km), 'a 2.a mudanca do dia (escaloes) devia ser o snapshot v2 de ' + today)
})

// valores por estado ao nivel da operacao
const RE1 = await rec(ctx.routeT, '2026-04-01', { enc_entregues: 10 })
await must(admin.from('operations').update({ valores_estado: { entregues: 2, devolucoes: 0, recolhas: 0, canceladas: 0, transitadas: 0, pendentes_entrega: 0, pendentes_recolha: 0 } }).eq('id', ctx.opT))
const RE2 = await rec(ctx.routeT, '2026-04-02', { enc_entregues: 10 })
const RE3 = await rec(ctx.routeT, '2026-12-05', { enc_entregues: 10 })
ctx.RE1 = RE1.id; ctx.RE2 = RE2.id; ctx.RE3 = RE3.id
await t('valores por estado (operacao): registo antigo 10, retroativo criado depois 10, futuro 20', async () => {
  const r1 = await must(admin.from('daily_records').select('receita_total').eq('id', RE1.id).single())
  eq([Number(r1.receita_total), Number(RE2.receita_total), Number(RE3.receita_total)], [10, 10, 20], `RE1 ${RE1.id} RE2 ${RE2.id} RE3 ${RE3.id}`)
})

setArea('Campos obrigatorios (registo diario)')
await t('registo so com rota+data (tudo o resto vazio) e aceite como Rascunho', async () => {
  const r = await rec(ctx.routeLN, '2026-05-01')
  ctx.RMIN = r.id
  eq(r.status, 'rascunho', 'estado'); eq(Number(r.receita_total), 0, 'receita')
})
await t('registo sem data e recusado (identificacao obrigatoria)', async () => { await denied(admin.from('daily_records').insert({ route_id: ctx.routeLN }).select(), 'sem data') })
await t('registo sem rota e recusado', async () => { await denied(admin.from('daily_records').insert({ data: '2026-05-02' }).select(), 'sem rota') })
await t('registo Submetido totalmente vazio (sem viatura/motorista/km/custos) e aceite', async () => {
  const r = await rec(ctx.routeLN, '2026-05-03', { status: 'submetido' })
  ctx.RMIN2 = r.id
})
await t('2.o registo para a mesma rota+data e recusado (unicidade)', async () => { await denied(admin.from('daily_records').insert({ route_id: ctx.routeLN, data: '2026-05-01' }).select(), 'duplicado') })
await t('rota+data imutaveis apos criacao', async () => { await denied(admin.from('daily_records').update({ data: '2026-05-09' }).eq('id', ctx.RMIN).select(), 'mudar data') })
await t('valores negativos recusados (check)', async () => { await denied(admin.from('daily_records').insert({ route_id: ctx.routeLN, data: '2026-05-04', km: -1 }).select(), 'km negativo') })

writeFileSync(new URL('./ctx.json', import.meta.url), JSON.stringify(ctx, null, 2))
save('./results-01.json')
