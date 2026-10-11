// Registo diario: quem/quando validou so o servidor escreve (relatorio QA N1, migracao 0015).
// Pre-requisito: node qa/01-precos.mjs (cria ctx.json com a rota QA-). Dados criados: registos QA em ctx.routeLN (limpeza: qa/cleanup.sql).
import { readFileSync } from 'node:fs'
import { login, ADMIN, sql, t, setArea, eq, ok, must, save } from './lib.mjs'

const ctx = JSON.parse(readFileSync(new URL('./ctx.json', import.meta.url), 'utf8'))
const admin = await login(...ADMIN); const gest = await login('qa.gestor@example.test'); const oper = await login('qa.operador@example.test')
const mk = (d, o = {}) => must(admin.from('daily_records').insert({ route_id: ctx.routeLN, data: d, ...o }).select('id').single()).then((r) => r.id)
const row = async (id) => (await sql(`select status::text s, validado_por::text vp, validado_em::text ve from daily_records where id='${id}'`))[0]
const FORGED = { validado_por: admin.uid, validado_em: '2020-01-01T00:00:00Z' }

setArea('Registo diario - validado_por/validado_em so o servidor escreve')
await t('INSERT como Submetido com validado_por/validado_em forjados: o servidor limpa', async () => {
  const id = await mk('2026-01-05', { status: 'submetido', ...FORGED }); const r = await row(id); eq([r.s, r.vp, r.ve], ['submetido', null, null], 'registo ' + id)
})
let id2
await t('Gestor valida; UPDATE mantendo Validado com validado_por/validado_em forjados nao muda quem/quando validou', async () => {
  id2 = await mk('2026-01-06'); await must(gest.from('daily_records').update({ status: 'validado' }).eq('id', id2))
  const before = await row(id2); eq(before.vp, gest.uid, 'validado por ' + id2)
  for (const [n, sb] of [['gestor', gest], ['super admin', admin]]) {
    const r = await sb.from('daily_records').update({ ...FORGED, status: 'validado' }).eq('id', id2).select('validado_por')
    const after = await row(id2)
    ok(after.vp === gest.uid && after.ve === before.ve, `${n}: registo ${id2}: validado_por ${before.vp} -> ${after.vp}, validado_em ${before.ve} -> ${after.ve} (erro=${r.error?.message})`)
  }
})
await t('Operador e Motorista: nao conseguem forjar validado_por/validado_em (nem num registo Validado)', async () => {
  const id = await mk('2026-01-07', { status: 'submetido' })
  await oper.from('daily_records').update(FORGED).eq('id', id).select('validado_por')
  ok((await row(id)).vp === null, `registo ${id} submetido: validado_por forjado`)
  const r = await oper.from('daily_records').update(FORGED).eq('id', id2).select('id')
  const a = await row(id2); ok(a.vp === gest.uid && !(r.data?.length), `registo validado ${id2}: validado_por=${a.vp}, linhas=${r.data?.length}`)
})
await t('Fluxo legitimo intacto: editar um Validado reabre (limpa) e a nova validacao regista o novo validador', async () => {
  await must(admin.from('daily_records').update({ km: 11 }).eq('id', id2))
  const re = await row(id2); eq([re.s, re.vp, re.ve], ['submetido', null, null], 'reaberto ' + id2)
  await must(admin.from('daily_records').update({ status: 'validado' }).eq('id', id2))
  eq((await row(id2)).vp, admin.uid, 'nova validacao ' + id2)
})
save('./results-11.json')
