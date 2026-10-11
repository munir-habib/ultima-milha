// Cenario: modelo de frota (postos, historico, custos independentes, partilha entre operacoes).
import { readFileSync, writeFileSync } from 'node:fs'
import { login, ADMIN, sql, t, setArea, eq, ok, must, denied, save } from './lib.mjs'

const ctx = JSON.parse(readFileSync(new URL('./ctx.json', import.meta.url), 'utf8'))
const admin = await login(...ADMIN)
const [gest, gestPC, oper, mot, cont, aud] = await Promise.all(['qa.gestor', 'qa.gestor.porto', 'qa.operador', 'qa.motorista', 'qa.contabilista', 'qa.auditor'].map((n) => login(n + '@example.test')))
const tenant_id = (await must(admin.from('profiles').select('tenant_id').eq('id', admin.uid).single())).tenant_id
const today = ctx.today
await sql("update vehicles set deleted_at=now() where matricula like 'QA-%' and deleted_at is null; update fleet_slots set deleted_at=now() where nome like 'QA-%' and deleted_at is null")

const slot = (nome) => must(admin.from('fleet_slots').insert({ tenant_id, nome }).select('id').single()).then((x) => x.id)
const veh = (o) => must(admin.from('vehicles').insert({ tenant_id, tipo: 'propria', ...o }).select('*').single())
const S1 = await slot('QA-Posto-1'); const S2 = await slot('QA-Posto-2'); ctx.S1 = S1; ctx.S2 = S2

setArea('Frota - custos independentes e aluguer')
const V = {}
await t('Propria com custos em qualquer combinacao (iuc off, seguro on, manutencao off) e guardada como escrita', async () => {
  V.p1 = await veh({ matricula: 'QA-01-AA', iuc_ativo: false, iuc_valor: 90, seguro_ativo: true, seguro_valor: 300, manutencao_ativo: false, manutencao_valor: 0 })
  eq([V.p1.iuc_ativo, V.p1.seguro_ativo, V.p1.manutencao_ativo], [false, true, false], 'flags ' + V.p1.id)
})
await t('Propria com TODOS inativos e Propria com TODOS ativos (nao ha "Propria = todos ativos")', async () => {
  V.p2 = await veh({ matricula: 'QA-02-AA' }); V.p3 = await veh({ matricula: 'QA-03-AA', iuc_ativo: true, iuc_valor: 90, seguro_ativo: true, seguro_valor: 300, manutencao_ativo: true, manutencao_valor: 50 })
  eq([V.p2.iuc_ativo, V.p2.seguro_ativo, V.p2.manutencao_ativo], [false, false, false], 'p2 ' + V.p2.id); eq([V.p3.iuc_ativo, V.p3.seguro_ativo, V.p3.manutencao_ativo], [true, true, true], 'p3 ' + V.p3.id)
})
await t('Alugada com IUC ativo/seguro inativo/manutencao ativo (nao ha "Alugada = todos inativos")', async () => {
  V.a1 = await veh({ matricula: 'QA-04-AA', tipo: 'alugada', aluguer_fornecedor: 'QA-Rent', aluguer_custo: 600, aluguer_periodicidade: 'mensal', aluguer_data_inicio: '2026-01-01', iuc_ativo: true, iuc_valor: 40, seguro_ativo: false, manutencao_ativo: true, manutencao_valor: 25 })
  eq([V.a1.iuc_ativo, V.a1.seguro_ativo, V.a1.manutencao_ativo], [true, false, true], 'a1 ' + V.a1.id)
})
await t('Editar um custo nao altera os outros dois (independencia)', async () => {
  const r = await must(admin.from('vehicles').update({ seguro_ativo: false }).eq('id', V.p3.id).select('iuc_ativo,seguro_ativo,manutencao_ativo,iuc_valor,manutencao_valor').single())
  eq([r.iuc_ativo, r.seguro_ativo, r.manutencao_ativo], [true, false, true], 'p3 ' + V.p3.id)
})
await t('Dados de aluguer so existem em viaturas Alugadas (Propria com aluguer_custo e recusada)', async () => {
  await denied(admin.from('vehicles').insert({ tenant_id, matricula: 'QA-05-AA', tipo: 'propria', aluguer_custo: 100 }).select(), 'propria com aluguer')
  await denied(admin.from('vehicles').update({ tipo: 'propria' }).eq('id', V.a1.id).select(), 'alugada->propria mantendo aluguer')
})
await t('Matricula duplicada no tenant e recusada (case-insensitive)', async () => { await denied(admin.from('vehicles').insert({ tenant_id, matricula: 'qa-01-aa' }).select(), 'matricula dup') })

setArea('Frota - historico de postos')
const hist = (posto) => sql(`select a.id, v.matricula, a.data_inicio::text di, a.data_fim::text df, v.deleted_at is not null vdel, v.estado::text estado from slot_assignments a join vehicles v on v.id=a.vehicle_id where a.posto_id='${posto}' order by a.created_at nulls first, a.data_inicio, a.id`.replace(' a.created_at nulls first,', ''))
await must(admin.from('vehicles').update({ posto_id: S1 }).eq('id', V.p1.id))
await must(admin.from('vehicles').update({ posto_id: S2 }).eq('id', V.p1.id))   // V p1 sai do posto 1 para o 2
await must(admin.from('vehicles').update({ posto_id: S1 }).eq('id', V.p2.id))   // p2 entra no posto 1
await t('Posto 1: sequencia p1 -> p2 registada, p1 fechado e p2 aberto', async () => {
  const h = await hist(S1)
  eq(h.map((x) => x.matricula).sort(), ['QA-01-AA', 'QA-02-AA'], 'viaturas do posto ' + S1)
  ok(h.filter((x) => x.df === null).length === 1, 'deve haver exatamente 1 ocupacao aberta no posto ' + S1)
})
await t('Posto 1: intervalos com fim EXCLUSIVO: data_fim da anterior == data_inicio da seguinte (sem sobreposicao nem buracos)', async () => {
  const h = (await hist(S1)).sort((a, b) => (a.di + (a.df ?? '9999')).localeCompare(b.di + (b.df ?? '9999')))
  for (let i = 0; i + 1 < h.length; i++) {
    ok(h[i].df !== null, 'ocupacao ' + h[i].id + ' ainda aberta antes da seguinte')
    eq(h[i].df, h[i + 1].di, 'fronteira exclusiva entre ' + h[i].matricula + ' e ' + h[i + 1].matricula + ' no posto ' + S1)
  }
})

// dois veiculos fisicos no mesmo posto ao mesmo tempo
await t('Um posto nao pode ter 2 viaturas ativas em simultaneo (atribuir p3 ao posto 1 enquanto p2 la esta)', async () => {
  await must(admin.from('vehicles').update({ posto_id: S1 }).eq('id', V.p3.id))
  const open = (await hist(S1)).filter((x) => x.df === null)
  ok(open.length === 1, `posto ${S1} (QA-Posto-1) ficou com ${open.length} ocupacoes abertas em simultaneo: ${open.map((x) => x.matricula + ' (' + x.id + ')').join(', ')}. Atribuir uma viatura a um posto ja ocupado nao fecha a ocupacao anterior nem e recusado (app.vehicle_slot_history so fecha as ocupacoes DA PROPRIA viatura; sem unique parcial em slot_assignments(posto_id) where data_fim is null nem em vehicles(posto_id)). Sobreposicao no historico.`)
})
await t('Viatura apagada (soft delete) que estava num posto fecha a ocupacao (historico sem viatura "fantasma")', async () => {
  await must(admin.from('vehicles').update({ deleted_at: new Date().toISOString() }).eq('id', V.p3.id))
  const open = (await hist(S1)).filter((x) => x.df === null && x.vdel)
  ok(open.length === 0, `slot_assignments ${open.map((x) => x.id)} do posto ${S1} continua ABERTA para a viatura ${V.p3.id} (${open[0]?.matricula}) apagada (deleted_at preenchido); vehicle_slot_history so reage a mudancas de posto_id, nao a deleted_at/estado`)
})
await t('Viatura marcada como vendida/devolvida deixa de ocupar o posto no historico', async () => {
  await must(admin.from('vehicles').update({ estado: 'vendida' }).eq('id', V.p2.id))
  const h = (await hist(S1)).filter((x) => x.df === null && x.estado === 'vendida')
  ok(h.length === 0, `viatura ${V.p2.id} (QA-02-AA) esta 'vendida' mas a sua ocupacao ${h[0]?.id} do posto ${S1} continua aberta (data_fim nulo)`)
})
await t('Posto 2: p1 aparece com data_inicio de hoje (sem buracos: p1 saiu do posto 1 no mesmo dia)', async () => {
  const h = await hist(S2); eq(h.map((x) => [x.matricula, x.di]), [['QA-01-AA', today]], 'posto 2')
  const h1 = (await hist(S1)).find((x) => x.matricula === 'QA-01-AA'); eq(h1.df, today, 'fim de p1 no posto 1')
})
await t('Sair de um posto (posto_id = null) fecha a ocupacao', async () => {
  await must(admin.from('vehicles').update({ posto_id: null }).eq('id', V.p1.id))
  const h = await hist(S2); ok(h[0].df === today, 'ocupacao ' + h[0].id + ' ficou aberta')
})
await t('slot_assignments so e escrito por triggers (utilizador nao consegue forjar/alterar historico)', async () => {
  await denied(admin.from('slot_assignments').insert({ tenant_id, posto_id: S1, vehicle_id: V.p1.id, data_inicio: '2020-01-01' }).select(), 'insert forjado')
  const a = await must(admin.from('slot_assignments').select('id').eq('posto_id', S1).limit(1)); await denied(admin.from('slot_assignments').update({ data_fim: '2020-01-01' }).eq('id', a[0].id).select(), 'update historico')
})

setArea('Frota - partilha entre operacoes (Tenant) e permissoes')
await must(admin.from('daily_records').insert({ route_id: ctx.routeLN, data: '2026-06-15', viatura_id: V.p1.id, km: 10 }))
await must(admin.from('daily_records').insert({ route_id: ctx.routePC, data: '2026-06-15', viatura_id: V.p1.id, km: 20 }))
await t('a mesma viatura (QA-01-AA) e usada nas 2 operacoes e ambos os Gestores a veem; cada um so ve o registo da sua operacao', async () => {
  for (const [g, nome, rota] of [[gest, 'gestor LN', ctx.routeLN], [gestPC, 'gestor PC', ctx.routePC]]) {
    ok((await must(g.from('vehicles').select('id').eq('id', V.p1.id))).length === 1, nome + ' nao ve a viatura partilhada ' + V.p1.id)
    const r = await must(g.from('daily_records').select('route_id,km').eq('viatura_id', V.p1.id))
    eq(r.map((x) => x.route_id), [rota], nome + ' registos da viatura partilhada')
  }
})
await t('Gestor gere frota (cria/edita); Operador/Auditor leem mas RECUSADO escrever; Motorista/Contabilista RECUSADO ler', async () => {
  const gv = await must(gest.from('vehicles').insert({ tenant_id, matricula: 'QA-06-AA', tipo: 'propria' }).select('id').single()); ctx.gv = gv.id
  await must(gest.from('vehicles').update({ iuc_ativo: true, iuc_valor: 10 }).eq('id', gv.id).select().single())
  ok((await must(oper.from('vehicles').select('id'))).length > 0, 'operador nao le frota'); ok((await must(aud.from('vehicles').select('id'))).length > 0, 'auditor nao le frota')
  await denied(oper.from('vehicles').update({ iuc_ativo: true }).eq('id', V.p1.id).select(), 'operador edita'); await denied(aud.from('vehicles').update({ iuc_ativo: true }).eq('id', V.p1.id).select(), 'auditor edita')
  await denied(oper.from('fleet_slots').insert({ tenant_id, nome: 'QA-x' }).select(), 'operador cria posto')
  eq((await must(mot.from('vehicles').select('id'))).length, 0, 'motorista le vehicles'); eq((await must(cont.from('vehicles').select('id'))).length, 0, 'contabilista le vehicles')
  eq((await must(mot.from('fleet_slots').select('id'))).length, 0, 'motorista le postos')
  const vo = await must(mot.from('vehicle_options').select('*')); ok(vo.length > 0 && !vo.some((x) => 'iuc_valor' in x), 'vehicle_options do motorista')
})
await t('Gestor de outra operacao/tenant B nao ve a viatura (isolamento por tenant)', async () => {
  const tb = await login('qa.tenantb@example.test'); eq((await must(tb.from('vehicles').select('id').eq('id', V.p1.id))).length, 0, 'tenant B le viatura ' + V.p1.id)
})
ctx.V = Object.fromEntries(Object.entries(V).map(([k, v]) => [k, v.id]))
writeFileSync(new URL('./ctx.json', import.meta.url), JSON.stringify(ctx, null, 2))
save('./results-03.json')
