// RLS de movements apos a 0020, com >10 000 movimentos: contagem exata e tempo por papel.
import { ctx, T, loginAll, users, sql } from './h.mjs'
import { anonClient } from '../lib.mjs'
await loginAll()
const tot = (await sql(`select count(*)::int n from movements where tenant_id='${T}'`))[0].n
const act = (await sql(`select count(*)::int n from movements where tenant_id='${T}' and deleted_at is null`))[0].n
const sample = (await sql(`select id from movements where tenant_id='${T}' and deleted_at is null limit 1`))[0].id
console.log(`tenant A: ${tot} linhas (${act} ativas)`)
let bad = 0
for (const [n, sb, exp] of [['admin', users.admin, tot], ['contabilista', users.cont, tot], ['auditor.acc', users.audacc, tot], ['gestor', users.gest, 0], ['operador', users.oper, 0], ['motorista', users.mot, 0], ['auditor sem acc', users.aud, 0], ['tenantB (ve o seu, nada do A)', users.tb, null]]) {
  const t0 = Date.now(); const r = await sb.from('movements').select('id', { count: 'exact', head: true }); const ms = Date.now() - t0
  const one = await sb.from('movements').select('id').eq('id', sample)
  const okc = exp === null ? (r.count < tot && (one.data ?? []).length === 0) : (r.count === exp)
  if (!okc) bad++
  console.log(okc ? 'PASSOU ' : 'FALHOU ', n, 'count=', r.count, r.error?.message ?? '', `${ms} ms`, exp === null ? `(le movimento do A: ${(one.data ?? []).length})` : '')
}
const an = await anonClient().from('movements').select('id').limit(1); console.log((an.data ?? []).length === 0 ? 'PASSOU ' : 'FALHOU ', 'anon', (an.data ?? []).length)
// pagina 2..10 como Contabilista (a que falhava com statement timeout antes da 0020)
const t0 = Date.now(); const r = await users.cont.from('movements').select('id,data').is('deleted_at', null).order('data', { ascending: false }).order('created_at', { ascending: false }).order('id', { ascending: false }).range(9000, 9999); console.log('pagina 10 (9000-9999):', r.error?.message ?? r.data.length, `${Date.now() - t0} ms`)
process.exit(bad ? 1 : 0)
