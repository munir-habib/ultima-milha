// Verificacao real da migracao 0017: motivo_apagado so se define ao apagar (nunca numa linha ativa). Dados: QA-C-motivo (limpeza: qa/cleanup.sql).
import { login, ADMIN, sql, must, t, setArea, eq, ok, denied } from '../lib.mjs'

const cont = await login('qa.contabilista@example.test')
const admin = await login(...ADMIN)
const tenant = (await must(admin.from('profiles').select('tenant_id').eq('id', admin.uid).single())).tenant_id
const conta = (await must(admin.from('bank_accounts').select('id').is('deleted_at', null).limit(1)))[0].id

setArea('0017 - motivo_apagado so ao apagar')
const m = await must(cont.from('movements').insert({ tenant_id: tenant, conta_id: conta, data: '2026-09-19', tipo: 'debito', valor: 5, subcategoria: 'outro', descricao: 'QA-C-motivo' }).select('id').single())
await t('Contabilista e Super Admin nao escrevem motivo_apagado numa linha ativa', async () => {
  await denied(cont.from('movements').update({ motivo_apagado: 'sujo' }).eq('id', m.id).select(), 'contabilista')
  await denied(admin.from('movements').update({ motivo_apagado: 'sujo' }).eq('id', m.id).select(), 'super admin')
  eq((await sql(`select motivo_apagado from movements where id='${m.id}'`))[0].motivo_apagado, null, 'motivo_apagado de ' + m.id)
})
await t('Um lancamento automatico ativo tambem nao aceita motivo_apagado', async () => {
  const a = (await sql(`select id from movements where origem='automatico' and deleted_at is null limit 1`))[0]
  ok(a, 'sem automatico ativo')
  await denied(admin.from('movements').update({ motivo_apagado: 'sujo' }).eq('id', a.id).select(), 'automatico ' + a.id)
  eq((await sql(`select motivo_apagado from movements where id='${a.id}'`))[0].motivo_apagado, null, 'motivo_apagado do automatico ' + a.id)
})
await t('Soft delete continua: Contabilista recusado; Super Admin sem motivo recusado; com motivo funciona', async () => {
  await denied(cont.from('movements').update({ deleted_at: new Date().toISOString(), motivo_apagado: 'x' }).eq('id', m.id).select(), 'contabilista apaga')
  await denied(admin.from('movements').update({ deleted_at: new Date().toISOString() }).eq('id', m.id).select(), 'sem motivo')
  await must(admin.from('movements').update({ deleted_at: new Date().toISOString(), motivo_apagado: 'QA-C limpeza' }).eq('id', m.id).select('id'))
  eq((await sql(`select motivo_apagado from movements where id='${m.id}'`))[0].motivo_apagado, 'QA-C limpeza', 'motivo de ' + m.id)
})
