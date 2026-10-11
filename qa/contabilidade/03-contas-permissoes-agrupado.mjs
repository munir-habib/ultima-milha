// Casos 20-26 (parte de dados/RLS): despesas soltas, contas, permissoes, cenario do Agrupado.
import { ctx, T, loginAll, users, t, setCaso, setArea, eq, ok, must, denied, sql, mvIns, mv, mkRec, dump, savectx } from './h.mjs'
import { sums, groupByDay } from './acc.bundle.mjs'
await loginAll()
const { admin, cont, oper, gest, mot, aud, audacc, tb } = users
const ids = (ctx.c3 = ctx.c3 ?? {})
const cents = (n) => Math.round(Number(n) * 100)
const acctSnap = async (conta) => sums(await must(cont.from('movements').select('*').eq('conta_id', conta).is('deleted_at', null)))

// ---------------- CASO 20 ----------------
setArea('Despesas soltas e contas'); setCaso('CASO 20')
await t('Despesa solta (Manutencao e Deslocacao equipa) sem operacao: aceite Manual-Geral/Confirmado, conta nos totais gerais; nunca no que pertence a uma Operacao', async () => {
  const opQ = async () => (await sql(`select coalesce(sum(valor),0)::float v, count(*)::int n from movements where operation_id='${ctx.opLN}' and deleted_at is null`))[0]
  const costsQ = async () => (await sql(`select coalesce(sum(c.valor),0)::float v, count(*)::int n from daily_record_costs c join daily_records d on d.id=c.record_id join routes r on r.id=d.route_id where r.operation_id='${ctx.opLN}' and c.deleted_at is null and d.deleted_at is null`))[0]
  const revQ = async () => (await sql(`select coalesce(sum(receita_total),0)::float v from daily_records d join routes r on r.id=d.route_id where r.operation_id='${ctx.opLN}' and d.deleted_at is null`))[0].v
  const [op0, co0, rv0, g0] = [await opQ(), await costsQ(), await revQ(), await acctSnap(ctx.contaA)]
  const a = await must(mvIns(cont, { subcategoria: 'manutencao', valor: 250, data: '2026-04-20', descricao: 'QA-C-c20-manut' }).single())
  const b = await must(mvIns(cont, { subcategoria: 'deslocacao_equipa', valor: 80.5, data: '2026-04-20', descricao: 'QA-C-c20-desloc' }).single())
  eq([a.origem, a.estado, a.operation_id, a.rota_id, b.origem, b.estado, b.operation_id], ['manual_geral', 'confirmado', null, null, 'manual_geral', 'confirmado', null], `despesas ${a.id} / ${b.id}`)
  const [op1, co1, rv1, g1] = [await opQ(), await costsQ(), await revQ(), await acctSnap(ctx.contaA)]
  eq(g1.debit - g0.debit, 330.5, 'totais gerais da Contabilidade (conta A)')
  eq([op1, co1, rv1], [op0, co0, rv0], 'agregados da Operacao Lisboa Norte (movimentos com operacao, linhas de custo dos registos, receita) mudaram com uma despesa solta')
  eq((await sql(`select count(*)::int n from daily_record_costs where movimento_id in ('${a.id}','${b.id}')`))[0].n, 0, 'linha de custo criada para despesa solta')
  ids.c20 = [a.id, b.id]
})
await t('Controlo: a mesma despesa COM operacao (Lisboa Norte) e uma despesa solta com rota (sem operacao) — a 1a conta na operacao, a 2a e recusada', async () => {
  const before = (await sql(`select coalesce(sum(valor),0)::float v from movements where operation_id='${ctx.opLN}' and deleted_at is null`))[0].v
  const m = await must(mvIns(cont, { subcategoria: 'manutencao', valor: 10, operation_id: ctx.opLN, data: '2026-04-20', descricao: 'QA-C-c20-comop' }).single())
  eq([m.origem], ['manual_rota'], 'origem ' + m.id)
  const after = (await sql(`select coalesce(sum(valor),0)::float v from movements where operation_id='${ctx.opLN}' and deleted_at is null`))[0].v; eq(after - before, 10, 'operacao')
  await denied(mvIns(cont, { subcategoria: 'manutencao', valor: 10, rota_id: ctx.R1, descricao: 'QA-C-c20-rotasemop' }), 'rota sem operacao')
})
await t('Nota de codigo: o dashboard (src/lib/dashData.ts) so le daily_records/vehicles/operations; a Contabilidade nao entra no dashboard de operacao', async () => {
  const fs = await import('node:fs'); const src = fs.readFileSync(new URL('../../src/lib/dashData.ts', import.meta.url), 'utf8')
  ok(!/movements/.test(src), 'dashData.ts referencia movements')
})

// ---------------- CASO 21 ----------------
setCaso('CASO 21')
await t('Duas contas: um debito na Conta A nunca mexe no saldo da Conta B (e vice-versa); sem conta e balde a parte', async () => {
  const [a0, b0] = [await acctSnap(ctx.contaA), await acctSnap(ctx.contaB)]
  await must(mvIns(cont, { conta_id: ctx.contaA, tipo: 'credito', valor: 1000, data: '2026-04-21', descricao: 'QA-C-c21-A+' }))
  const a1 = await acctSnap(ctx.contaA), b1 = await acctSnap(ctx.contaB)
  eq([a1.net - a0.net, b1.net - b0.net], [1000, 0], 'credito em A')
  await must(mvIns(cont, { conta_id: ctx.contaA, tipo: 'debito', valor: 300, data: '2026-04-21', descricao: 'QA-C-c21-A-' }))
  const a2 = await acctSnap(ctx.contaA), b2 = await acctSnap(ctx.contaB)
  eq([a2.net - a1.net, b2.net - b1.net], [-300, 0], 'debito em A')
  await must(mvIns(cont, { conta_id: ctx.contaB, tipo: 'debito', valor: 50, data: '2026-04-21', descricao: 'QA-C-c21-B-' }))
  await must(mvIns(cont, { conta_id: ctx.contaB, tipo: 'credito', valor: 200, data: '2026-04-21', descricao: 'QA-C-c21-B+' }))
  const a3 = await acctSnap(ctx.contaA), b3 = await acctSnap(ctx.contaB)
  eq([a3.net - a2.net, b3.net - b2.net], [0, 150], 'movimentos em B')
  eq([a3.net - a0.net, b3.net - b0.net], [700, 150], 'saldos acumulados')
  const sqlA = (await sql(`select coalesce(sum(case when tipo='credito' then valor else -valor end),0)::float v from movements where conta_id='${ctx.contaA}' and deleted_at is null and estado='confirmado'`))[0].v
  ok(Math.abs(sqlA - a3.net) < 0.005, 'saldo SQL vs cliente conta A: ' + sqlA + ' vs ' + a3.net)
  const none = await sql(`select count(*)::int n from movements where conta_id is null and deleted_at is null`); return `movimentos sem conta (automaticos sem conta por defeito): ${none[0].n} (balde "Sem conta", fora de A e B)`
})
await t('Movimento com conta de outro tenant recusado (referencia coerente)', async () => {
  const acc = await must(tb.from('bank_accounts').insert({ tenant_id: (await must(tb.from('profiles').select('tenant_id').eq('id', tb.uid).single())).tenant_id, nome: 'QA-C-B-Conta' }).select('id').single())
  const r = await mvIns(cont, { conta_id: acc.id, descricao: 'QA-C-c21-xtenant' }); ok(r.error, 'aceite: movimento com conta do tenant B ' + acc.id); ctx.bAcc = acc.id
})

// ---------------- CASO 22 ----------------
setArea('Permissoes'); setCaso('CASO 22')
let del
await t('Contabilista NAO apaga (soft delete) nenhum tipo de lancamento: manual, alocacao, transferencia, automatico', async () => {
  const man = await must(mvIns(cont, { descricao: 'QA-C-c22-manual' }).single()); del = man
  const tr = await must(mvIns(cont, { subcategoria: 'transferencia_distribuicao', valor: 20, pessoa_responsavel: 'QA-Jo', descricao: 'QA-C-c22-tr' }).single())
  const al = await must(mvIns(cont, { subcategoria: 'outro', valor: 5, pessoa_responsavel: 'QA-Jo', lancamento_referencia_id: tr.id, descricao: 'QA-C-c22-al' }).single())
  const au = (await sql(`select id from movements where registo_id='${ctx.c2.r15}' and deleted_at is null limit 1`))[0].id
  for (const [n, id] of [['manual', man.id], ['transferencia', tr.id], ['alocacao', al.id], ['automatico', au]]) {
    const r = await cont.from('movements').update({ deleted_at: new Date().toISOString(), motivo_apagado: 'QA teste' }).eq('id', id).select('id')
    if (!r.error && r.data?.length) throw new Error(`Contabilista apagou o movimento ${n} ${id}`)
    eq((await mv(id)).deleted_at, null, `${n} ${id} continua ativo`)
  }
  ids.c22 = { man: man.id, tr: tr.id, al: al.id }
})
await t('Super Admin SEM motivo (ausente, null, vazio, so espacos) recusado; com motivo funciona', async () => {
  for (const patch of [{}, { motivo_apagado: null }, { motivo_apagado: '' }, { motivo_apagado: '   ' }]) {
    const r = await admin.from('movements').update({ deleted_at: new Date().toISOString(), ...patch }).eq('id', del.id).select('id')
    if (!r.error && r.data?.length) throw new Error(`apagado sem motivo valido (${JSON.stringify(patch)}) movimento ${del.id}`)
  }
  eq((await mv(del.id)).deleted_at, null, 'continua ativo ' + del.id)
  const ok1 = await must(admin.from('movements').update({ deleted_at: new Date().toISOString(), motivo_apagado: 'QA-C caso 22' }).eq('id', del.id).select('id,deleted_at,motivo_apagado').single()); ok(ok1.deleted_at && ok1.motivo_apagado === 'QA-C caso 22', 'nao apagou')
})
await t('DELETE fisico recusado (Contabilista, Super Admin, Auditor) e o registo continua a existir', async () => {
  for (const [n, sb] of [['contabilista', cont], ['admin', admin], ['auditor.acc', audacc]]) {
    const r = await sb.from('movements').delete().eq('id', ids.c22.al).select('id'); if (!r.error && r.data?.length) throw new Error(`${n} apagou fisicamente ${ids.c22.al}`)
  }
  eq((await sql(`select count(*)::int n from movements where id='${ids.c22.al}'`))[0].n, 1, 'linha existe')
})
await t('Audit do soft delete: quem, quando, antes/depois; audit_log imutavel (nem Super Admin o altera/apaga)', async () => {
  const a = await must(admin.from('audit_log').select('*').eq('tabela', 'movements').eq('registo_id', del.id).eq('acao', 'SOFT_DELETE').single())
  ok(a.user_id === admin.uid && a.em && a.antes.deleted_at === null && a.depois.deleted_at && a.depois.motivo_apagado === 'QA-C caso 22', 'audit ' + a.id)
  const r1 = await admin.from('audit_log').update({ acao: 'X' }).eq('id', a.id).select(); ok(r1.error || !r1.data?.length, 'audit alteravel')
  const r2 = await admin.from('audit_log').delete().eq('id', a.id).select(); ok(r2.error || !r2.data?.length, 'audit apagavel')
})
await t('Contabilista nao escreve motivo_apagado num lancamento ativo nem reativa um apagado', async () => {
  const r = await cont.from('movements').update({ motivo_apagado: 'sorrateiro' }).eq('id', ids.c22.man).select('id')
  const r2 = await cont.from('movements').update({ deleted_at: null }).eq('id', del.id).select('id'); ok(r2.error || !r2.data?.length, 'reativou ' + del.id)
  if (!r.error && r.data?.length) throw new Error(`0017: Contabilista gravou motivo_apagado (${ids.c22.man}) num lancamento ATIVO`)
  const r3 = await admin.from('movements').update({ motivo_apagado: 'sorrateiro-admin' }).eq('id', ids.c22.man).select('id'); if (!r3.error && r3.data?.length) throw new Error(`0017: Super Admin gravou motivo_apagado (${ids.c22.man}) num lancamento ATIVO`)
})

// ---------------- CASO 23 ----------------
setCaso('CASO 23')
await t('Gestor (operacao com automaticos) e Operador/Motorista: 0 linhas em movements, bank_accounts, accounting_settings, fund_transfer_status; escrita recusada', async () => {
  const autosLN = (await sql(`select count(*)::int n from movements where operation_id='${ctx.opLN}' and origem='automatico' and deleted_at is null`))[0].n; ok(autosLN > 0, 'precondicao: existem automaticos na operacao do gestor')
  for (const [n, sb] of [['gestor', gest], ['operador', oper], ['motorista', mot]]) {
    for (const tb_ of ['movements', 'bank_accounts', 'accounting_settings', 'fund_transfer_status']) eq((await must(sb.from(tb_).select('*'))).length, 0, `${n} ve ${tb_}`)
    const ins = await sb.from('movements').insert({ tenant_id: T, data: '2026-04-22', conta_id: ctx.contaA, tipo: 'debito', valor: 1, subcategoria: 'outro', descricao: 'QA-C-c23-' + n }).select(); ok(ins.error || !ins.data?.length, n + ' inseriu movimento')
    const upd = await sb.from('movements').update({ valor: 1 }).eq('operation_id', ctx.opLN).select('id'); ok(upd.error || !upd.data?.length, n + ' alterou movimentos')
    const b = await sb.from('bank_accounts').insert({ tenant_id: T, nome: 'QA-C-x' }).select(); ok(b.error || !b.data?.length, n + ' criou conta')
    const s = await sb.from('accounting_settings').update({ validation_threshold: 9999 }).eq('tenant_id', T).select(); ok(s.error || !s.data?.length, n + ' alterou limiar')
  }
  eq((await sql(`select validation_threshold::float t from accounting_settings where tenant_id='${T}'`))[0].t, 100, 'limiar')
})
await t('Gestor nao recebe notificacoes de Contabilidade (movement_pending / fund_over_allocated)', async () => {
  const n = await must(gest.from('notifications').select('tipo').in('tipo', ['movement_pending', 'fund_over_allocated'])); eq(n.length, 0, 'notificacoes de contabilidade do gestor')
})

// ---------------- CASO 24 ----------------
setCaso('CASO 24')
await t('Auditor com accounting_read ve TUDO (mesma contagem que o Super Admin, incluindo Pendentes e versoes apagadas) mas nao cria/edita/valida/apaga', async () => {
  const cnt = async (sb) => (await must(sb.from('movements').select('id,estado,deleted_at'))).length
  const [na, nb] = [await cnt(audacc), await cnt(admin)]; eq(na, nb, 'linhas visiveis auditor.acc vs admin')
  const pend = await must(audacc.from('movements').select('id').eq('estado', 'pendente').is('deleted_at', null)); ok(pend.length > 0, 'auditor nao ve pendentes')
  for (const [k, v] of [['bank', (await must(audacc.from('bank_accounts').select('id'))).length], ['settings', (await must(audacc.from('accounting_settings').select('tenant_id'))).length], ['status', (await must(audacc.from('fund_transfer_status').select('id'))).length]]) ok(v > 0, 'auditor nao ve ' + k)
  const pid = pend[0].id, mid = ids.c22.man
  const tryw = async (label, p) => { const r = await p; if (!r.error && r.data?.length) throw new Error(`auditor.acc: ${label} aceite`) }
  await tryw('inserir', audacc.from('movements').insert({ tenant_id: T, data: '2026-04-22', conta_id: ctx.contaA, tipo: 'debito', valor: 1, subcategoria: 'outro', descricao: 'QA-C-c24' }).select())
  await tryw('validar ' + pid, audacc.from('movements').update({ estado: 'confirmado' }).eq('id', pid).select('id'))
  await tryw('editar ' + mid, audacc.from('movements').update({ valor: 2 }).eq('id', mid).select('id'))
  await tryw('apagar ' + mid, audacc.from('movements').update({ deleted_at: new Date().toISOString(), motivo_apagado: 'x' }).eq('id', mid).select('id'))
  await tryw('delete fisico', audacc.from('movements').delete().eq('id', mid).select('id'))
  await tryw('criar conta', audacc.from('bank_accounts').insert({ tenant_id: T, nome: 'QA-C-aud' }).select())
  await tryw('limiar', audacc.from('accounting_settings').update({ validation_threshold: 1 }).eq('tenant_id', T).select())
  eq((await mv(pid)).estado, 'pendente', 'pendente ' + pid)
})
await t('Auditor SEM accounting_read: 0 linhas em movements, bank_accounts, accounting_settings, fund_transfer_status; nao escreve', async () => {
  for (const tb_ of ['movements', 'bank_accounts', 'accounting_settings', 'fund_transfer_status']) eq((await must(aud.from(tb_).select('*'))).length, 0, 'auditor sem accounting_read ve ' + tb_)
  const r = await aud.from('movements').insert({ tenant_id: T, data: '2026-04-22', conta_id: ctx.contaA, tipo: 'debito', valor: 1, subcategoria: 'outro', descricao: 'QA-C-c24b' }).select(); ok(r.error || !r.data?.length, 'inseriu')
})
await t('Escalada de privilegio: Auditor nao se auto-atribui accounting_read nem papeis', async () => {
  const before = (await sql(`select accounting_read from profiles where id='${aud.uid}'`))[0].accounting_read
  const r = await aud.from('profiles').update({ accounting_read: true }).eq('id', aud.uid).select('accounting_read')
  const after = (await sql(`select accounting_read from profiles where id='${aud.uid}'`))[0].accounting_read
  if (after !== before) { await sql(`update profiles set accounting_read=false where id='${aud.uid}'`); throw new Error(`Auditor ${aud.uid} auto-atribuiu accounting_read (${before} -> ${after}) e passou a ler a Contabilidade`) }
  const rr = await aud.from('user_roles').insert({ user_id: aud.uid, role: 'super_admin' }).select(); ok(rr.error || !rr.data?.length, 'auditor inseriu papel')
  eq((await sql(`select count(*)::int n from user_roles where user_id='${aud.uid}' and role='super_admin'`))[0].n, 0, 'papel super_admin do auditor')
})

// ---------------- CASOS 25/26 (dados) ----------------
setArea('Agrupado por dia'); setCaso('CASO 25')
const D1 = '2026-05-04', D2 = '2026-05-05', D3 = '2026-05-06'
const g = {}
await t('Cenario: transferencia (Geral) + alocacoes noutros dias/rotas + manuais; groupByDay real: cada movimento UMA vez no dia+grupo pelos seus campos', async () => {
  const mk = async (k, o) => { const r = await mvIns(cont, { conta_id: ctx.contaA, ...o, descricao: 'QA-C-c25-' + k }); if (r.error) throw new Error(k + ': ' + r.error.message); g[k] = r.data[0].id; return r.data[0] }
  const tr = await mk('tr', { subcategoria: 'transferencia_distribuicao', valor: 900, pessoa_responsavel: 'QA-Rui', data: D1 })
  const al = (k, o) => mk(k, { subcategoria: 'outro', pessoa_responsavel: 'QA-Rui', lancamento_referencia_id: tr.id, ...o })
  await mk('solta1', { subcategoria: 'manutencao', valor: 30, data: D1 })
  await mk('manR1d1', { valor: 40, data: D1, operation_id: ctx.opLN, rota_id: ctx.R1 })
  await al('alR1d1', { valor: 100, data: D1, operation_id: ctx.opLN, rota_id: ctx.R1 })
  await al('alR1d2', { valor: 200, data: D2, operation_id: ctx.opLN, rota_id: ctx.R1 })
  await al('alR2d2', { valor: 250, data: D2, operation_id: ctx.opLN, rota_id: ctx.R2 })
  await al('alGd2', { valor: 50, data: D2, operation_id: null, rota_id: null })
  await mk('manR2d2', { valor: 60, data: D2, operation_id: ctx.opLN, rota_id: ctx.R2 })
  await mk('credGd2', { tipo: 'credito', valor: 500, data: D2 })
  await mk('alR1d3', { subcategoria: 'outro', valor: 300, data: D3, operation_id: ctx.opLN, rota_id: ctx.R1, pessoa_responsavel: 'QA-Rui', lancamento_referencia_id: tr.id })
  ids.g = g
  const rows = await must(cont.from('movements').select('*').like('descricao', 'QA-C-c25-%').is('deleted_at', null))
  eq(rows.length, 10, 'movimentos criados')
  const days = groupByDay(rows, (id) => ({ [ctx.R1]: 'QA-C-R1', [ctx.R2]: 'QA-C-R2' })[id] ?? '?', 'Geral')
  const seen = {}
  for (const d of days) for (const gr of d.groups) for (const m of gr.items) { (seen[m.id] ??= []).push([d.date, gr.key]) }
  const wrongCount = Object.entries(seen).filter(([, v]) => v.length !== 1)
  eq([Object.keys(seen).length, wrongCount.length], [10, 0], 'cada movimento uma so vez: ' + JSON.stringify(wrongCount))
  for (const m of rows) eq(seen[m.id][0], [m.data, m.rota_id ?? '__geral'], `posicao do movimento ${m.id} (${m.descricao})`)
  // a transferencia nao se junta as suas alocacoes: esta em (D1, Geral) sozinha com as outras Geral desse dia; as alocacoes estao em (dia, rota) proprios
  eq(seen[g.tr][0], [D1, '__geral'], 'transferencia'); eq(seen[g.alR1d2][0], [D2, ctx.R1], 'alocacao noutro dia'); eq(seen[g.alGd2][0], [D2, '__geral'], 'alocacao geral')
})
setCaso('CASO 26')
await t('Subtotal de cada grupo e total do dia = soma dos grupos (recalculado em centimos a partir das linhas SQL; so Confirmado no oficial, pendente a parte)', async () => {
  const rows = await sql(`select id, data::text d, coalesce(rota_id::text,'__geral') g, tipo, valor::float v, estado from movements where descricao like 'QA-C-c25-%' and deleted_at is null`)
  const exp = {}
  for (const r of rows) { const k = r.d + '|' + r.g; const e = (exp[k] ??= { net: 0, pend: 0 }); if (r.estado === 'confirmado') e.net += (r.tipo === 'credito' ? 1 : -1) * cents(r.v); else e.pend += cents(r.v) }
  const all = await must(cont.from('movements').select('*').like('descricao', 'QA-C-c25-%').is('deleted_at', null))
  const days = groupByDay(all, () => 'r', 'Geral')
  for (const d of days) {
    let dn = 0, dp = 0
    for (const gr of d.groups) { const e = exp[d.date + '|' + gr.key]; eq([cents(gr.sums.net), cents(gr.sums.pendingAmount)], [e.net, e.pend], `subtotal ${d.date} ${gr.key}`); dn += cents(gr.sums.net); dp += cents(gr.sums.pendingAmount) }
    eq([cents(d.sums.net), cents(d.sums.pendingAmount)], [dn, dp], 'total do dia ' + d.date)
    const expDay = Object.entries(exp).filter(([k]) => k.startsWith(d.date)).reduce((s, [, e]) => [s[0] + e.net, s[1] + e.pend], [0, 0])
    eq([dn, dp], expDay, 'soma de grupos vs soma SQL do dia ' + d.date)
  }
  eq(days.map((d) => d.date), [D3, D2, D1], 'ordem dos dias')
})

savectx(); dump('results-03.json')
