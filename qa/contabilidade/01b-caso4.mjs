// Casos 1-11: distribuicao de fundos e propagacao para o registo diario. Utilizadores reais (RLS); sql = so montagem/verificacao.
import { ctx, T, loginAll, users, t, setCaso, setArea, eq, ok, must, denied, sql, mvIns, mv, mkRec, autos, dump, savectx } from './h.mjs'
import { allocationStatus } from './acc.bundle.mjs'
await loginAll()
const { admin, cont, oper } = users
const status = async (id) => (await must(cont.from('fund_transfer_status').select('*').eq('id', id)))[0]
const transfer = (o) => mvIns(cont, { subcategoria: 'transferencia_distribuicao', ...o, descricao: 'QA-C-' + (o.descricao ?? 'transf') }).then((r) => { if (r.error) throw new Error(r.error.message); return r.data[0] })
const alloc = (tr, o) => mvIns(cont, { subcategoria: 'outro', pessoa_responsavel: tr.pessoa_responsavel, lancamento_referencia_id: tr.id, data: tr.data, operation_id: ctx.opLN, rota_id: ctx.R1, ...o, descricao: 'QA-C-' + (o.descricao ?? 'alloc') }).then((r) => { if (r.error) throw new Error(r.error.message); return r.data[0] })
const notifs = (tid) => sql(`select p.email, n.payload from notifications n join profiles p on p.id=n.user_id where n.tipo='fund_over_allocated' and n.payload->>'movement_id'='${tid}' order by 1`)
const expectedRecipients = () => sql(`select distinct p.email from profiles p join user_roles r on r.user_id=p.id where p.tenant_id='${T}' and r.role in ('super_admin','contabilista') and p.deleted_at is null order by 1`)
const ids = (ctx.c = ctx.c ?? {})

// ---------------- CASO 4 ----------------
setCaso('CASO 4')
await t('Soft delete da transferencia (so Super Admin, com motivo): alocacoes filhas continuam ativas com valor e ligacao; Contabilista nao consegue apagar', async () => {
  const tr = await transfer({ valor: 300, pessoa_responsavel: 'QA-Diogo', data: '2026-03-01', descricao: 'c4' }); ids.c4 = tr.id
  const a = await alloc(tr, { valor: 100, data: '2026-03-03' }), b = await alloc(tr, { valor: 150, data: '2026-03-04', rota_id: ctx.R2 }); ids.c4a = a.id; ids.c4b = b.id
  await denied(cont.from('movements').update({ deleted_at: new Date().toISOString(), motivo_apagado: 'QA' }).eq('id', tr.id).select(), 'contabilista apaga transferencia')
  await must(admin.from('movements').update({ deleted_at: new Date().toISOString(), motivo_apagado: 'QA-C teste caso 4' }).eq('id', tr.id).select())
  const rows = await sql(`select id, valor::float v, deleted_at, lancamento_referencia_id ref, estado from movements where id in ('${a.id}','${b.id}') order by valor`)
  eq(rows.map((r) => [r.v, r.deleted_at, r.ref]), [[100, null, tr.id], [150, null, tr.id]], `alocacoes da transferencia removida ${tr.id}`)
  eq((await must(cont.from('fund_transfer_status').select('id').eq('id', tr.id))).length, 0, 'vista deve deixar de listar a transferencia removida')
  const listed = await must(cont.from('movements').select('id,valor').in('id', [a.id, b.id]).is('deleted_at', null)); eq(listed.length, 2, 'alocacoes visiveis na lista da Contabilidade')
})
await t('Editar alocacao com pai apagado nao dispara erro (trigger overalloc)', async () => {
  const r = await cont.from('movements').update({ valor: 120 }).eq('id', ids.c4a).select('valor'); ok(!r.error, 'editar alocacao com pai apagado falhou: ' + r.error?.message)
})

dump('results-01b.json'); process.exit(0)
