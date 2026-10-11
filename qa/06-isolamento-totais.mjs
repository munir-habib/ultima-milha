// Cenario: isolamento de totais entre operacoes (Gestores) + limite de validacao como Super Admin + motoristas partilhados.
import { readFileSync, writeFileSync } from 'node:fs'
import { login, ADMIN, sql, t, setArea, eq, ok, must, denied, save } from './lib.mjs'

const ctx = JSON.parse(readFileSync(new URL('./ctx.json', import.meta.url), 'utf8'))
const admin = await login(...ADMIN)
const [gest, gestPC, aud, oper, operPC] = await Promise.all(['qa.gestor', 'qa.gestor.porto', 'qa.auditor', 'qa.operador', 'qa.operador.porto'].map((n) => login(n + '@example.test')))
const tenant_id = (await must(admin.from('profiles').select('tenant_id').eq('id', admin.uid).single())).tenant_id
const sumOf = (rows) => Math.round(rows.reduce((s, r) => s + Number(r.receita_total), 0) * 100) / 100

setArea('Isolamento - totais/dashboard por Operacao')
// custo numa rota de Porto Centro (para ver se vaza para Lisboa)
const pcRec = await must(admin.from('daily_records').select('id').eq('route_id', ctx.routePC).is('deleted_at', null).limit(1).single())
await must(admin.from('daily_record_costs').insert({ record_id: pcRec.id, categoria: 'QA-custo-PC', valor: 777 }))
for (const [nome, sb, opId] of [['Gestor Lisboa Norte', gest, ctx.opLN], ['Gestor Porto Centro', gestPC, ctx.opPC], ['Auditor Lisboa Norte', aud, ctx.opLN]]) {
  await t(`${nome}: soma de receita, n.o de registos e custos = exatamente os da sua operacao (comparado com SQL por operacao)`, async () => {
    const mine = await must(sb.from('daily_records').select('id,route_id,receita_total,daily_record_costs(valor,deleted_at)').is('deleted_at', null))
    const exp = await sql(`select coalesce(sum(r.receita_total),0)::float s, count(*)::int n, coalesce((select sum(c.valor) from daily_record_costs c join daily_records d2 on d2.id=c.record_id join routes r2 on r2.id=d2.route_id where r2.operation_id='${opId}' and c.deleted_at is null and d2.deleted_at is null),0)::float cs from daily_records r join routes rt on rt.id=r.route_id where rt.operation_id='${opId}' and r.deleted_at is null`)
    const cs = Math.round(mine.flatMap((r) => r.daily_record_costs).filter((c) => !c.deleted_at).reduce((s, c) => s + Number(c.valor), 0) * 100) / 100
    eq([mine.length, sumOf(mine), cs], [exp[0].n, Math.round(exp[0].s * 100) / 100, Math.round(exp[0].cs * 100) / 100], `${nome} (n, receita, custos) vs SQL operacao ${opId}`)
  })
}
await t('Custo de 777 EUR lancado numa rota de Porto Centro nao aparece no Gestor/Operador/Auditor de Lisboa', async () => {
  for (const [n, sb] of [['gestor LN', gest], ['operador LN', oper], ['auditor LN', aud]]) {
    const c = await must(sb.from('daily_record_costs').select('id,valor').eq('valor', 777).is('deleted_at', null)); eq(c.length, 0, `${n} ve custo QA-custo-PC do registo ${pcRec.id}`)
  }
  eq((await must(operPC.from('daily_record_costs').select('id').eq('valor', 777).is('deleted_at', null))).length, 1, 'operador PC devia ver o custo do seu registo ' + pcRec.id)
})
await t('Operacao QA-Op Tarifa (nao atribuida) invisivel para Gestores/Operadores/Auditores de LN e PC', async () => {
  for (const [n, sb] of [['gestor LN', gest], ['gestor PC', gestPC], ['operador LN', oper], ['auditor', aud]]) {
    eq((await must(sb.from('operations').select('id').eq('id', ctx.opT))).length, 0, n + ' ve operacao ' + ctx.opT); eq((await must(sb.from('daily_records').select('id').eq('route_id', ctx.routeT))).length, 0, n + ' ve registos da rota ' + ctx.routeT)
    eq((await must(sb.from('route_options').select('id').eq('id', ctx.routeT))).length, 0, n + ' ve route_options ' + ctx.routeT)
  }
})
await t('Super Admin ve todas as operacoes e a soma total = soma das partes', async () => {
  const all = await must(admin.from('daily_records').select('receita_total').is('deleted_at', null)); const db = await sql(`select coalesce(sum(r.receita_total),0)::float s from daily_records r join routes rt on rt.id=r.route_id join operations o on o.id=rt.operation_id where r.deleted_at is null and o.tenant_id='${tenant_id}'`)
  eq(sumOf(all), Math.round(db[0].s * 100) / 100, 'total tenant')
})
await t('Motoristas sao do Tenant: os mesmos motoristas aparecem aos Gestores das 2 operacoes', async () => {
  const a = (await must(gest.from('driver_options').select('id'))).map((x) => x.id).sort(); const b = (await must(gestPC.from('driver_options').select('id'))).map((x) => x.id).sort(); eq(a, b, 'driver_options gestor LN vs PC'); ok(a.length > 0, 'sem motoristas')
})

setArea('Contabilidade - limite de validacao como Super Admin (audit)')
await t('Super Admin altera limite (100 -> 120 -> 100) e fica em audit_log com antes/depois', async () => {
  const u = await must(admin.from('accounting_settings').update({ validation_threshold: 120 }).eq('tenant_id', tenant_id).select('validation_threshold').single()); eq(Number(u.validation_threshold), 120, 'limite')
  const a = (await must(admin.from('audit_log').select('*').eq('tabela', 'accounting_settings').eq('tenant_id', tenant_id).order('id', { ascending: false }).limit(1)))[0]
  await must(admin.from('accounting_settings').update({ validation_threshold: 100 }).eq('tenant_id', tenant_id))
  ok(a && a.user_id === admin.uid && Number(a.antes.validation_threshold) === 100 && Number(a.depois.validation_threshold) === 120, 'audit ' + a?.id)
  if (a.registo_id === null) return 'NOTA: audit_log.registo_id fica NULL para accounting_settings (tabela sem coluna id/user_id; app.audit usa coalesce(id, user_id)) - rastreavel so por tenant_id+tabela; audit id ' + a.id
})
save('./results-06.json')
