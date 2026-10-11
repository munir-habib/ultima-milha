// Helpers comuns dos cenarios QA da Contabilidade.
import { readFileSync, writeFileSync } from 'node:fs'
import { login, ADMIN, sql, t as t0, setArea, eq, ok, must, denied, results } from '../lib.mjs'
export { sql, setArea, eq, ok, must, denied, results }
export const ctx = JSON.parse(readFileSync(new URL('./ctx.json', import.meta.url), 'utf8'))
export const users = {}
export async function loginAll(names = ['admin', 'cont', 'gest', 'oper', 'mot', 'aud', 'audacc', 'tb']) {
  const map = { cont: 'qa.contabilista', gest: 'qa.gestor', oper: 'qa.operador', mot: 'qa.motorista', aud: 'qa.auditor', audacc: 'qa.auditor.acc', tb: 'qa.tenantb' }
  for (const n of names) users[n] = n === 'admin' ? await login(...ADMIN) : await login(map[n] + '@example.test')
  return users
}
export const T = ctx.tenant
// caso: cada verificacao regista "CASO NN | descricao"
let caso = ''
export const setCaso = (c) => { caso = c }
export const t = (name, fn) => t0(`[${caso}] ${name}`, fn)
export const mvIns = (sb, o) => sb.from('movements').insert({ tenant_id: T, data: '2026-03-10', conta_id: ctx.contaA, tipo: 'debito', valor: 10, subcategoria: 'outro', ...o }).select('*')
export const mv = async (id) => (await sql(`select * from movements where id='${id}'`))[0]
export const mkRec = (sb, route_id, data, extra = {}) => must(sb.from('daily_records').insert({ route_id, data, ...extra }).select('id').single()).then((r) => r.id)
export const autos = (rid, tipo) => sql(`select id, valor::float v, estado, deleted_at, motivo_apagado, versao_anterior_id, conta_id, validado_por from movements where registo_id='${rid}' and custo_tipo='${tipo}' and origem='automatico' order by created_at, id`)
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
export function dump(file) { writeFileSync(new URL(file, import.meta.url), JSON.stringify(results.filter((r) => r.name.startsWith('[')), null, 2)) }
export const savectx = () => writeFileSync(new URL('./ctx.json', import.meta.url), JSON.stringify(ctx, null, 2))
