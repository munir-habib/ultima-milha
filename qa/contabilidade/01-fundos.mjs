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

// ---------------- CASO 1 ----------------
setArea('Distribuicao de fundos'); setCaso('CASO 1')
await t('800 em 3 partes (266.67+266.67+266.66): por alocar = 0.00, estado ok (servidor)', async () => {
  const tr = await transfer({ valor: 800, pessoa_responsavel: 'QA-Ana', data: '2026-03-01', descricao: 'c1-800' }); ids.c1 = tr.id
  for (const v of [266.67, 266.67, 266.66]) await alloc(tr, { valor: v, data: '2026-03-02' })
  const s = await status(tr.id); eq([s.estado, Number(s.alocado), Number(s.diferenca)], ['ok', 800, 0], 'fund_transfer_status ' + tr.id)
  eq((await sql(`select count(*)::int n from notifications where tipo='fund_over_allocated' and payload->>'movement_id'='${tr.id}'`))[0].n, 0, 'notificacao indevida de sobre-alocacao ' + tr.id)
})
await t('Cliente (funcao real allocationStatus de src/lib/accounting.ts) coincide com o servidor em 20000 combinacoes aleatorias de centimos (sem erro de float)', async () => {
  let bad = 0, sample = null
  for (let i = 0; i < 20000; i++) {
    const n = 1 + Math.floor(Math.random() * 7), cents = Array.from({ length: n }, () => 1 + Math.floor(Math.random() * 100000))
    const extra = [0, 0, 1, -1][Math.floor(Math.random() * 4)] // ok / +-1 centimo
    const total = cents.reduce((a, b) => a + b, 0) + extra
    if (total <= 0) continue
    const st = allocationStatus({ valor: total / 100 }, cents.map((c) => ({ valor: c / 100, tipo: 'debito', deleted_at: null })))
    const exact = extra === 0 ? 'ok' : extra > 0 ? 'under' : 'over'
    if (st.state !== exact || Math.abs(st.diff * 100 - extra) > 1e-6) { bad++; sample ??= { cents, total, st, exact } }
  }
  if (bad) throw new Error(`${bad} combinacoes erradas, ex.: ${JSON.stringify(sample)}`)
  for (const [tot, parts] of [[0.3, [0.1, 0.2]], [100, [33.33, 33.33, 33.34]], [1000, [142.86, 142.86, 142.86, 142.86, 142.86, 142.86, 142.84]], [0.07, [0.01, 0.02, 0.04]]]) {
    const st = allocationStatus({ valor: tot }, parts.map((v) => ({ valor: v, tipo: 'debito', deleted_at: null }))); eq(st.state, 'ok', `${tot} = ${parts}`)
  }
})
await t('Servidor: 100 em 3 partes 33.33+33.33+33.34 e 0.30 = 0.10+0.20 -> ok, diferenca 0.00 (numeric exato)', async () => {
  const a = await transfer({ valor: 100, pessoa_responsavel: 'QA-Ana', data: '2026-03-01', descricao: 'c1-100' })
  for (const v of [33.33, 33.33, 33.34]) await alloc(a, { valor: v })
  const b = await transfer({ valor: 0.3, pessoa_responsavel: 'QA-Ana', data: '2026-03-01', descricao: 'c1-030' })
  for (const v of [0.1, 0.2]) await alloc(b, { valor: v })
  const [sa, sb] = [await status(a.id), await status(b.id)]
  eq([sa.estado, Number(sa.diferenca), sb.estado, Number(sb.diferenca)], ['ok', 0, 'ok', 0], `transferencias ${a.id} / ${b.id}`)
})

// ---------------- CASO 2 ----------------
setCaso('CASO 2')
await t('Sub-alocacao: 800 com 300+200 -> under, por alocar 300.00, visivel na vista do servidor', async () => {
  const tr = await transfer({ valor: 800, pessoa_responsavel: 'QA-Bruno', data: '2026-03-01', descricao: 'c2' }); ids.c2 = tr.id
  await alloc(tr, { valor: 300 }); await alloc(tr, { valor: 200 })
  const s = await status(tr.id); eq([s.estado, Number(s.alocado), Number(s.diferenca)], ['under', 500, 300], 'transferencia ' + tr.id)
  const c = allocationStatus({ valor: 800 }, [{ valor: 300, tipo: 'debito' }, { valor: 200, tipo: 'debito' }]); eq([c.state, c.diff], ['under', 300], 'funcao cliente')
})
await t('Sub-alocacao de 1 centimo (800.00 vs 799.99) tambem nao se esconde', async () => {
  const tr = await transfer({ valor: 800, pessoa_responsavel: 'QA-Bruno', data: '2026-03-01', descricao: 'c2-cent' })
  await alloc(tr, { valor: 799.99 }); const s = await status(tr.id); eq([s.estado, Number(s.diferenca)], ['under', 0.01], 'transferencia ' + tr.id)
})
await t('Transferencia sem qualquer alocacao: under com alocado 0 (nao desaparece da vista)', async () => {
  const tr = await transfer({ valor: 50, pessoa_responsavel: 'QA-Bruno', data: '2026-03-01', descricao: 'c2-zero' }); const s = await status(tr.id); eq([s.estado, Number(s.alocado), Number(s.diferenca)], ['under', 0, 50], 'transferencia ' + tr.id)
})

// ---------------- CASO 3 ----------------
setCaso('CASO 3')
let over
await t('Sobre-alocacao 500+400 > 800: servidor ACEITA, vista = over (-100), notificacao fund_over_allocated a TODOS os Super Admin e Contabilistas', async () => {
  over = await transfer({ valor: 800, pessoa_responsavel: 'QA-Carla', data: '2026-03-01', descricao: 'c3' }); ids.c3 = over.id
  await alloc(over, { valor: 500 })
  eq((await notifs(over.id)).length, 0, 'notificacao antes do excesso')
  const a2 = await alloc(over, { valor: 400 }); ids.c3a2 = a2.id
  const s = await status(over.id); eq([s.estado, Number(s.alocado), Number(s.diferenca)], ['over', 900, -100], 'transferencia ' + over.id)
  const n = await notifs(over.id), exp = await expectedRecipients()
  eq(n.map((x) => x.email), exp.map((x) => x.email), 'destinatarios de fund_over_allocated ' + over.id)
  eq([Number(n[0].payload.excesso), Number(n[0].payload.alocado)], [100, 900], 'payload')
})
await t('So notifica quando o excesso AGRAVA: agravar +50 gera nova notificacao; reduzir/corrigir nao', async () => {
  const before = (await notifs(over.id)).length
  const a3 = await alloc(over, { valor: 50 }) // excesso 100 -> 150
  const after = (await notifs(over.id)).length; ok(after > before, `agravar nao notificou (transferencia ${over.id}: ${before} -> ${after})`)
  await must(cont.from('movements').update({ valor: 10 }).eq('id', a3.id).select())
  eq((await notifs(over.id)).length, after, 'reduzir gerou notificacao')
  eq(Number((await status(over.id)).diferenca), -110, 'diferenca depois de reduzir')
})
await t('Sobre-alocacao por soma exata de 1 centimo (800.01 vs 800) tambem e "over" e notifica', async () => {
  const tr = await transfer({ valor: 800, pessoa_responsavel: 'QA-Carla', data: '2026-03-01', descricao: 'c3-cent' })
  await alloc(tr, { valor: 800 }); await alloc(tr, { valor: 0.01 })
  const s = await status(tr.id); eq([s.estado, Number(s.diferenca)], ['over', -0.01], 'transferencia ' + tr.id)
  ok((await notifs(tr.id)).length >= 2, 'sem notificacao para ' + tr.id)
})
await t('Sinalizacao nao depende do frontend: feito so por API; Super Admin ve a vista; Gestor/Operador nao veem a vista (RLS)', async () => {
  const s = await must(admin.from('fund_transfer_status').select('estado').eq('id', over.id)); eq(s[0].estado, 'over', 'admin')
  for (const [n, sb] of [['operador', oper], ['gestor', users.gest]]) eq((await must(sb.from('fund_transfer_status').select('id').eq('id', over.id))).length, 0, n + ' ve a vista')
})
await t('Notificacao nao vai para Gestor/Operador/Auditor', async () => {
  const bad = await sql(`select p.email, r.role from notifications n join profiles p on p.id=n.user_id join user_roles r on r.user_id=p.id where n.tipo in ('fund_over_allocated','movement_pending') and n.payload->>'movement_id'='${over.id}' and r.role not in ('super_admin','contabilista')`); eq(bad.length, 0, 'destinatarios indevidos ' + JSON.stringify(bad))
})

await t('F6: alocacao a CREDITO nao conta como alocado: transferencia 100 + credito 100 -> under, alocado 0; sem notificacao; cliente coincide', async () => {
  const tr = await transfer({ valor: 100, pessoa_responsavel: 'QA-Carla', data: '2026-03-01', descricao: 'c3-f6a' })
  const a = await alloc(tr, { valor: 100, tipo: 'credito', rota_id: null, operation_id: null, descricao: 'c3-f6-cred' })
  const s = await status(tr.id); eq([s.estado, Number(s.alocado), Number(s.diferenca)], ['under', 0, 100], 'transferencia ' + tr.id + ' (credito ' + a.id + ')')
  const c = allocationStatus({ valor: 100 }, [{ valor: 100, tipo: 'credito', deleted_at: null }]); eq([c.state, c.allocated], ['under', 0], 'allocationStatus cliente')
  eq((await notifs(tr.id)).length, 0, 'notificacao indevida')
})
await t('F6: debito 100 + credito 50 numa transferencia de 100 -> ok (alocado 100), sem sobre-alocacao nem notificacao; +debito 1 -> over 1', async () => {
  const tr = await transfer({ valor: 100, pessoa_responsavel: 'QA-Carla', data: '2026-03-01', descricao: 'c3-f6b' })
  await alloc(tr, { valor: 100, rota_id: null, operation_id: null }); await alloc(tr, { valor: 50, tipo: 'credito', rota_id: null, operation_id: null })
  let s = await status(tr.id); eq([s.estado, Number(s.alocado)], ['ok', 100], 'transferencia ' + tr.id); eq((await notifs(tr.id)).length, 0, 'notificacao indevida com credito')
  await alloc(tr, { valor: 1, rota_id: null, operation_id: null }); s = await status(tr.id); eq([s.estado, Number(s.diferenca)], ['over', -1], 'depois de +debito ' + tr.id)
  ok((await notifs(tr.id)).length >= 1, 'debito em excesso nao notificou')
})
await t('F6: mudar o tipo de uma alocacao (debito <-> credito) recalcula a vista e so notifica quando o excesso agrava', async () => {
  const tr = await transfer({ valor: 100, pessoa_responsavel: 'QA-Carla', data: '2026-03-01', descricao: 'c3-f6c' })
  const a = await alloc(tr, { valor: 100, rota_id: null, operation_id: null }); const b = await alloc(tr, { valor: 30, tipo: 'credito', rota_id: null, operation_id: null })
  eq((await status(tr.id)).estado, 'ok', 'inicio ' + tr.id); const n0 = (await notifs(tr.id)).length
  await must(cont.from('movements').update({ tipo: 'debito' }).eq('id', b.id).select()); const s = await status(tr.id); eq([s.estado, Number(s.diferenca)], ['over', -30], 'credito->debito ' + b.id)
  ok((await notifs(tr.id)).length > n0, 'credito->debito que agrava nao notificou')
  await must(cont.from('movements').update({ tipo: 'credito' }).eq('id', a.id).select()); eq(Number((await status(tr.id)).alocado), 30, 'debito->credito da ' + a.id)
})

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

// ---------------- CASO 5 ----------------
setCaso('CASO 5')
await t('Duas transferencias com a mesma pessoa responsavel: filtro por pessoa mostra as duas; totais de cada uma sem mistura', async () => {
  const t1 = await transfer({ valor: 500, pessoa_responsavel: 'QA-Elisa', data: '2026-03-05', descricao: 'c5-1' }), t2 = await transfer({ valor: 300, pessoa_responsavel: 'QA-Elisa', data: '2026-03-06', descricao: 'c5-2' })
  await alloc(t1, { valor: 200 }); await alloc(t1, { valor: 100 }); await alloc(t2, { valor: 300 })
  const rows = await must(cont.from('fund_transfer_status').select('*').eq('pessoa_responsavel', 'QA-Elisa').order('data'))
  eq(rows.map((r) => [r.id, Number(r.valor), Number(r.alocado), Number(r.diferenca), r.estado]), [[t1.id, 500, 300, 200, 'under'], [t2.id, 300, 300, 0, 'ok']], 'transferencias QA-Elisa ' + t1.id + ' / ' + t2.id)
  ids.c5 = [t1.id, t2.id]
})

// ---------------- CASO 6 ----------------
setCaso('CASO 6')
await t('Alocacao sem rota nem operacao: aceite, Manual-Geral, Pendente, registo_id nulo, sem linha de custo, mesmo havendo registos nesse dia', async () => {
  const rec = await mkRec(oper, ctx.R1, '2026-03-07', { status: 'submetido' })
  const tr = await transfer({ valor: 200, pessoa_responsavel: 'QA-Fabio', data: '2026-03-07', descricao: 'c6' })
  const a = await alloc(tr, { valor: 70, operation_id: null, rota_id: null, descricao: 'c6-geral' })
  const b = await alloc(tr, { valor: 30, rota_id: null, descricao: 'c6-so-op' })
  const rows = await sql(`select id, origem, estado, registo_id, operation_id, rota_id from movements where id in ('${a.id}','${b.id}') order by valor`)
  eq([rows[1].origem, rows[1].estado, rows[1].registo_id, rows[1].operation_id], ['manual_geral', 'pendente', null, null], 'alocacao geral ' + a.id)
  eq([rows[0].origem, rows[0].registo_id], ['manual_rota', null], 'alocacao so com operacao ' + b.id)
  eq((await sql(`select count(*)::int n from daily_record_costs where movimento_id in ('${a.id}','${b.id}') or (record_id='${rec}' and categoria like 'Pagamento%')`))[0].n, 0, 'linhas de custo indevidas no registo ' + rec)
})
await t('Alocacao a CREDITO com rota+operacao tambem nao se propaga (so debitos)', async () => {
  const rec = await mkRec(oper, ctx.R2, '2026-03-08', { status: 'submetido' })
  const tr = await transfer({ valor: 200, pessoa_responsavel: 'QA-Fabio', data: '2026-03-08', descricao: 'c6b' })
  const a = await alloc(tr, { valor: 40, tipo: 'credito', rota_id: ctx.R2, descricao: 'c6-credito' })
  eq((await mv(a.id)).registo_id, null, 'registo_id da alocacao a credito ' + a.id); eq((await sql(`select count(*)::int n from daily_record_costs where record_id='${rec}'`))[0].n, 0, 'linhas no registo ' + rec)
})

// ---------------- CASOS 7-11 ----------------
setArea('Propagacao para o registo diario'); setCaso('CASO 7')
let c7
await t('Alocacao a rota+data com registo existente: linha de custo "Pagamento distribuido - pessoa" com valor/movimento; nasce Pendente', async () => {
  const rec = await mkRec(oper, ctx.R1, '2026-03-11'); ids.c7rec = rec
  const tr = await transfer({ valor: 400, pessoa_responsavel: 'QA-Gil', data: '2026-03-11', descricao: 'c7' })
  c7 = await alloc(tr, { valor: 123.45, data: '2026-03-11', descricao: 'c7-alloc' }); ids.c7 = c7.id
  const m = await mv(c7.id); eq([m.estado, m.registo_id], ['pendente', rec], 'alocacao ' + c7.id)
  const c = await sql(`select id, categoria, valor::float v, movimento_id, deleted_at from daily_record_costs where record_id='${rec}'`)
  eq(c.length, 1, 'linhas de custo do registo ' + rec); eq([c[0].categoria, c[0].v, c[0].movimento_id], ['Pagamento distribuído — QA-Gil', 123.45, c7.id], 'linha')
  ids.c7cost = c[0].id
  const vis = await must(oper.from('daily_record_costs').select('categoria,valor').eq('record_id', rec)); eq(vis.length, 1, 'operador ve a linha')
})
await t('Etiqueta com TRAVESSAO ("Pagamento distribuído — X"), nunca hifen', async () => { const r = await sql(`select count(*)::int n from daily_record_costs where categoria like 'Pagamento distribuído - %'`); eq(r[0].n, 0, 'linhas com hifen') })
await t('NOVO: alocacao (Contabilista) a registo VALIDADO pelo admin: liga-se, o registo reverte para Submetido (validado_por/em limpos) e o validador recebe record_reopened; quem alocou nao', async () => {
  const rec = await mkRec(admin, ctx.R2, '2026-03-12', { status: 'validado', comb_valor: 20 }); ids.c7val = rec
  const b = (await sql(`select status, validado_por, validado_em from daily_records where id='${rec}'`))[0]; eq([b.status, b.validado_por], ['validado', admin.uid], 'registo antes ' + rec)
  const tr = await transfer({ valor: 100, pessoa_responsavel: 'QA-Gil', data: '2026-03-12', descricao: 'c7v' })
  const a = await alloc(tr, { valor: 20, rota_id: ctx.R2, data: '2026-03-12', descricao: 'c7-validado' })
  const m = await mv(a.id); eq(m.registo_id, rec, 'alocacao ' + a.id + ' ligada ao registo')
  const r = (await sql(`select status, validado_por, validado_em from daily_records where id='${rec}'`))[0]; eq([r.status, r.validado_por, r.validado_em], ['submetido', null, null], 'registo ' + rec + ' depois da alocacao')
  const n = await sql(`select p.email, n.user_id from notifications n join profiles p on p.id=n.user_id where n.tipo='record_reopened' and n.payload->>'record_id'='${rec}'`)
  eq(n.map((x) => x.user_id), [admin.uid], 'destinatarios de record_reopened (validador=admin, alocador=contabilista) do registo ' + rec)
  ok(!n.some((x) => x.user_id === cont.uid), 'notificou quem alocou')
  eq((await autos(rec, 'combustivel')).filter((x) => !x.deleted_at).length, 1, 'reabrir nao deve criar versoes do combustivel do registo ' + rec)
  eq((await autos(rec, 'combustivel')).length, 1, 'versoes do combustivel do registo ' + rec)
  eq((await sql(`select count(*)::int n from daily_record_costs where record_id='${rec}' and movimento_id='${a.id}' and categoria='Pagamento distribuído — QA-Gil'`))[0].n, 1, 'linha de custo')
})
await t('NOVO: registo ja Submetido: nova alocacao anexa sem novo aviso record_reopened', async () => {
  const rec = ids.c7val; const before = (await sql(`select count(*)::int n from notifications where tipo='record_reopened' and payload->>'record_id'='${rec}'`))[0].n
  const tr = await transfer({ valor: 100, pessoa_responsavel: 'QA-Gil', data: '2026-03-12', descricao: 'c7v2' })
  const a = await alloc(tr, { valor: 21, rota_id: ctx.R2, data: '2026-03-12', descricao: 'c7-submetido' })
  eq((await mv(a.id)).registo_id, rec, 'anexou ' + a.id)
  eq((await sql(`select count(*)::int n from notifications where tipo='record_reopened' and payload->>'record_id'='${rec}'`))[0].n, before, 'novo aviso indevido')
  eq((await sql(`select status from daily_records where id='${rec}'`))[0].status, 'submetido', 'estado')
})
await t('NOVO: quem alocou E validou (Super Admin aloca no registo que ele proprio validou): reverte mas nao se auto-notifica', async () => {
  const rec = await mkRec(admin, ctx.R1, '2026-03-14', { status: 'validado' })
  const tr = await must(mvIns(admin, { subcategoria: 'transferencia_distribuicao', valor: 50, pessoa_responsavel: 'QA-Gil', data: '2026-03-14', descricao: 'QA-C-c7self' }).single())
  const a = await must(mvIns(admin, { subcategoria: 'outro', valor: 10, pessoa_responsavel: 'QA-Gil', lancamento_referencia_id: tr.id, data: '2026-03-14', operation_id: ctx.opLN, rota_id: ctx.R1, descricao: 'QA-C-c7self-a' }).single())
  eq([(await mv(a.id)).registo_id, (await sql(`select status from daily_records where id='${rec}'`))[0].status], [rec, 'submetido'], 'registo ' + rec)
  eq((await sql(`select count(*)::int n from notifications where tipo='record_reopened' and payload->>'record_id'='${rec}'`))[0].n, 0, 'auto-notificacao')
})
await t('NOVO: registo criado JA Validado (Gestor) com alocacao pendente da rota+data: ao nascer anexa e reverte para Submetido', async () => {
  const gest = users.gest
  const tr = await transfer({ valor: 80, pessoa_responsavel: 'QA-Gil', data: '2026-03-19', descricao: 'c7birth' })
  const a = await alloc(tr, { valor: 33, data: '2026-03-19', descricao: 'c7birth-a' }); eq((await mv(a.id)).registo_id, null, 'antes do registo')
  const rec = await mkRec(gest, ctx.R1, '2026-03-19', { status: 'validado' })
  eq((await mv(a.id)).registo_id, rec, 'anexou ' + a.id); const r = (await sql(`select status, validado_por from daily_records where id='${rec}'`))[0]; eq([r.status, r.validado_por], ['submetido', null], 'registo ' + rec)
})
await t('Fluxo normal: Rascunho -> Submetido -> Validado e editar Validado reabre para Submetido (com aviso ao validador)', async () => {
  const rec = await mkRec(oper, ctx.R2, '2026-03-20', { comb_valor: 10 })
  await must(oper.from('daily_records').update({ status: 'submetido' }).eq('id', rec).select('id'))
  await must(users.gest.from('daily_records').update({ status: 'validado' }).eq('id', rec).select('id'))
  let r = (await sql(`select status, validado_por from daily_records where id='${rec}'`))[0]; eq([r.status, r.validado_por], ['validado', users.gest.uid], 'validado ' + rec)
  await denied(oper.from('daily_records').update({ comb_valor: 11 }).eq('id', rec).select('id'), 'operador edita registo validado (RLS: so Gestor/Super Admin) ' + rec)
  await must(admin.from('daily_records').update({ comb_valor: 12 }).eq('id', rec).select('id'))
  r = (await sql(`select status, validado_por from daily_records where id='${rec}'`))[0]; eq([r.status, r.validado_por], ['submetido', null], 'reaberto ' + rec)
  eq((await sql(`select count(*)::int n from notifications where tipo='record_reopened' and payload->>'record_id'='${rec}' and user_id='${users.gest.uid}'`))[0].n, 1, 'aviso ao validador')
})
await t('Alocacao a registo apagado (soft) nao se liga e nao o ressuscita', async () => {
  const rec = await mkRec(oper, ctx.R2, '2026-03-13'); await must(admin.from('daily_records').update({ deleted_at: new Date().toISOString() }).eq('id', rec))
  const tr = await transfer({ valor: 100, pessoa_responsavel: 'QA-Gil', data: '2026-03-13', descricao: 'c7d' })
  const a = await alloc(tr, { valor: 20, rota_id: ctx.R2, data: '2026-03-13', descricao: 'c7-regapagado' })
  eq((await mv(a.id)).registo_id, null, 'alocacao a registo apagado ' + a.id)
})

// ---- 8 / 9 ----
setCaso('CASO 8')
let c8, c8b, c8other, c8tr
await t('Alocacao a rota+data SEM registo: NAO cria registo, fica registo_id nulo (por ligar) e visivel na Contabilidade', async () => {
  c8tr = await transfer({ valor: 400, pessoa_responsavel: 'QA-Helena', data: '2026-03-15', descricao: 'c8' })
  c8 = await alloc(c8tr, { valor: 60, data: '2026-03-15', descricao: 'c8-a' }); c8b = await alloc(c8tr, { valor: 40, data: '2026-03-15', descricao: 'c8-b' })
  c8other = await alloc(c8tr, { valor: 10, data: '2026-03-16', descricao: 'c8-outrodia' }); ids.c8 = [c8.id, c8b.id, c8other.id]
  eq((await sql(`select count(*)::int n from daily_records where route_id='${ctx.R1}' and data in ('2026-03-15','2026-03-16')`))[0].n, 0, 'registos criados indevidamente')
  const rows = await must(cont.from('movements').select('id,registo_id,estado').in('id', ids.c8)); eq(rows.map((r) => r.registo_id), [null, null, null], 'registo_id')
})
setCaso('CASO 9')
await t('Criar o registo (Operador, RLS) para essa rota+data: as alocacoes pendentes desse dia anexam-se; as de outro dia/rota/apagadas nao', async () => {
  const c8soft = await alloc(c8tr, { valor: 5, data: '2026-03-15', descricao: 'c9-vaiserapagada' })
  await must(admin.from('movements').update({ deleted_at: new Date().toISOString(), motivo_apagado: 'QA-C caso 9' }).eq('id', c8soft.id).select())
  const outraRota = await alloc(c8tr, { valor: 7, data: '2026-03-15', rota_id: ctx.R2, descricao: 'c9-outrarota' })
  const rec = await mkRec(oper, ctx.R1, '2026-03-15'); ids.c9rec = rec
  const rows = await sql(`select id, valor::float v, registo_id from movements where id in ('${c8.id}','${c8b.id}','${c8other.id}','${c8soft.id}','${outraRota.id}') order by valor`)
  const by = Object.fromEntries(rows.map((r) => [r.id, r.registo_id]))
  eq([by[c8.id], by[c8b.id]], [rec, rec], 'alocacoes 60/40 do dia ' + rec); eq([by[c8other.id], by[c8soft.id], by[outraRota.id]], [null, null, null], 'outro dia / apagada / outra rota nao devem anexar')
  const costs = await sql(`select valor::float v, categoria, movimento_id from daily_record_costs where record_id='${rec}' order by valor`)
  eq(costs.map((c) => [c.v, c.categoria]), [[40, 'Pagamento distribuído — QA-Helena'], [60, 'Pagamento distribuído — QA-Helena']], 'linhas do registo ' + rec)
  ids.c9costs = costs
})
await t('Criar o registo como Rascunho anexa as pendentes', async () => {
  const tr = await transfer({ valor: 100, pessoa_responsavel: 'QA-Helena', data: '2026-03-17', descricao: 'c9b' })
  const a = await alloc(tr, { valor: 33, data: '2026-03-17', descricao: 'c9b-a' }); eq((await mv(a.id)).registo_id, null, 'antes')
  const rec = await mkRec(oper, ctx.R1, '2026-03-17', { status: 'rascunho' }); eq((await mv(a.id)).registo_id, rec, 'alocacao ' + a.id + ' registo ' + rec)
})

// ---- 10 / 11 ----
setCaso('CASO 10')
await t('Editar a linha de custo propagada no registo diario (valor/categoria) NAO altera o lancamento de origem; apagar a linha tambem nao', async () => {
  const before = await mv(c7.id)
  await must(oper.from('daily_record_costs').update({ valor: 77.7, categoria: 'QA-C editada' }).eq('id', ids.c7cost).select())
  let m = await mv(c7.id); eq([Number(m.valor), m.estado, m.registo_id, m.updated_at], [Number(before.valor), before.estado, before.registo_id, before.updated_at], 'lancamento ' + c7.id + ' alterado pela edicao da linha')
  await must(oper.from('daily_record_costs').update({ deleted_at: new Date().toISOString() }).eq('id', ids.c7cost).select())
  m = await mv(c7.id); eq([Number(m.valor), m.deleted_at, m.registo_id, m.updated_at], [Number(before.valor), null, before.registo_id, before.updated_at], 'lancamento ' + c7.id + ' alterado pela remocao da linha')
})
setCaso('CASO 11')
await t('Editar o lancamento na Contabilidade (so valor e descricao) NAO altera a linha de custo ja criada (0018: rota/operacao/data RECLASSIFICAM, ver 12-novas.mjs)', async () => {
  const c = ids.c9costs[1]
  const mvId = c.movimento_id; const beforeCost = (await sql(`select valor::float v, categoria, descricao, deleted_at from daily_record_costs where movimento_id='${mvId}' and deleted_at is null`))
  await must(cont.from('movements').update({ valor: 61.11, descricao: 'QA-C-c11 editado' }).eq('id', mvId).select())
  const afterCost = (await sql(`select valor::float v, categoria, descricao, deleted_at from daily_record_costs where movimento_id='${mvId}' and deleted_at is null`))
  eq(afterCost, beforeCost, 'linhas de custo do lancamento ' + mvId)
  const m = await mv(mvId); eq([Number(m.valor), m.registo_id], [61.11, ids.c9rec], 'lancamento (registo_id mantem-se)')
})
await t('0018: mudar a DATA do lancamento propagado (reclassificar) apaga a linha antiga e liga ao registo da nova data (R1 03-11): nunca duplica', async () => {
  const mvId = ids.c9costs[1].movimento_id
  await must(cont.from('movements').update({ data: '2026-03-11' }).eq('id', mvId).select())
  const rows = await sql(`select record_id, deleted_at from daily_record_costs where movimento_id='${mvId}' order by created_at`)
  eq([rows.length, rows.filter((r) => !r.deleted_at).length, rows.filter((r) => !r.deleted_at)[0]?.record_id], [2, 1, ids.c7rec], 'linhas de custo do lancamento ' + mvId)
  eq((await mv(mvId)).registo_id, ids.c7rec, 'registo_id ' + mvId)
})

savectx(); dump('results-01.json')
