import { loginAll, users, must, sql, T } from './h.mjs'
await loginAll(['cont']); const { cont } = users
const n = (await sql(`select count(*)::int n from movements where tenant_id='${T}' and deleted_at is null`))[0].n
const r = await cont.from('movements').select('id').is('deleted_at', null).order('data', { ascending: false }).limit(3000)
const r2 = await cont.from('movements').select('id', { count: 'exact', head: true }).is('deleted_at', null)
console.log(JSON.stringify({ ativos_bd: n, devolvidos_com_limit_3000: r.data?.length, error: r.error?.message, count_exact: r2.count }))
