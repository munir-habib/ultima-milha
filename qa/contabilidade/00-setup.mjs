// Monta o cenario base da Contabilidade (dados fictícios QA-C-*): rotas, 2 contas bancarias. Escreve ctx.json.
import { writeFileSync } from 'node:fs'
import { login, ADMIN, must, sql } from '../lib.mjs'
const admin = await login(...ADMIN)
const cont = await login('qa.contabilista@example.test')
const tenant = (await must(admin.from('profiles').select('tenant_id').eq('id', admin.uid).single())).tenant_id
const ops = await must(admin.from('operation_options').select('id,nome'))
const opLN = ops.find((o) => o.nome === 'Lisboa Norte').id, opPC = ops.find((o) => o.nome === 'Porto Centro').id
const mkRoute = (operation_id, nome) => must(admin.from('routes').insert({ operation_id, nome, tarifa_por_estado: false, tarifa_valor_fixo: true, tarifa_por_distancia: false, valor_fixo_default: 40 }).select('id').single()).then((r) => r.id)
const R1 = await mkRoute(opLN, 'QA-C-R1'), R2 = await mkRoute(opLN, 'QA-C-R2'), RP = await mkRoute(opPC, 'QA-C-RP')
const mkAcc = (nome) => must(cont.from('bank_accounts').insert({ tenant_id: tenant, nome }).select('id').single()).then((r) => r.id)
const ctxA = await mkAcc('QA-C-ContaA'), ctxB = await mkAcc('QA-C-ContaB')
const main = (await sql(`select id from bank_accounts where nome='Conta Principal' and deleted_at is null`))[0]?.id
const thr = (await sql(`select validation_threshold::float t, default_account_id from accounting_settings where tenant_id='${tenant}'`))[0]
const ctx = { tenant, opLN, opPC, R1, R2, RP, contaA: ctxA, contaB: ctxB, contaMain: main, thr }
writeFileSync(new URL('./ctx.json', import.meta.url), JSON.stringify(ctx, null, 2))
console.log(JSON.stringify(ctx))
