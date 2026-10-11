// Casos 12-19: lancamentos automaticos (limiar, so a partir de Submetido), versionamento, validacao seletiva, totais oficiais.
import { ctx, T, loginAll, users, t, setCaso, setArea, eq, ok, must, denied, sql, mvIns, mv, mkRec, autos, dump, savectx } from './h.mjs'
import { sums } from './acc.bundle.mjs'
await loginAll()
const { admin, cont, oper, gest, mot, aud, audacc } = users
const ids = (ctx.c2 = ctx.c2 ?? {})
const setSettings = (p) => must(admin.from('accounting_settings').update(p).eq('tenant_id', T).select())
const active = (rows) => rows.filter((r) => !r.deleted_at)
const notifPend = (mid) => sql(`select p.email from notifications n join profiles p on p.id=n.user_id where n.tipo='movement_pending' and n.payload->>'movement_id'='${mid}' order by 1`)
const expected = () => sql(`select distinct p.email from profiles p join user_roles r on r.user_id=p.id where p.tenant_id='${T}' and r.role in ('super_admin','contabilista') and p.deleted_at is null order by 1`)
const editComb = (rid, v, sb = oper) => must(sb.from('daily_records').update({ comb_valor: v }).eq('id', rid).select('id'))
await setSettings({ validation_threshold: 100, default_account_id: ctx.contaA }) // conta por defeito = QA-C-ContaA (para o saldo por conta)

// ---------------- CASO 12 ----------------
setArea('Versionamento e validacao seletiva'); setCaso('CASO 12')
await t('Registo Submetido com combustivel 30 (< limiar 100): automatico nasce Confirmado, origem Automatico, na conta por defeito', async () => {
  const rec = await mkRec(oper, ctx.R1, '2026-04-01', { comb_valor: 30, status: 'submetido' }); ids.r12 = rec
  const a = await autos(rec, 'combustivel'); eq(a.length, 1, 'lancamentos do registo ' + rec)
  const m = await mv(a[0].id); eq([m.origem, m.estado, m.conta_id, Number(m.valor), m.operation_id, m.rota_id, m.validado_por], ['automatico', 'confirmado', ctx.contaA, 30, ctx.opLN, ctx.R1, null], 'lancamento ' + m.id)
})
await t('Tambem para registo criado ja Validado (30 -> Confirmado)', async () => {
  const rec = await mkRec(admin, ctx.R2, '2026-04-01', { comb_valor: 30, portagens_valor: 5, status: 'validado' })
  const a = await autos(rec, 'combustivel'), p = await autos(rec, 'portagens'); eq([a.length, a[0].estado, p.length, p[0].estado], [1, 'confirmado', 1, 'confirmado'], 'registo ' + rec)
})

// ---------------- CASO 13 ----------------
setCaso('CASO 13')
let r13
await t('Criacao + 2 edicoes = 3 lancamentos; exatamente 1 ativo, 2 soft-deleted "substituído por edição", cadeia por versao_anterior_id', async () => {
  r13 = await mkRec(oper, ctx.R1, '2026-04-02', { comb_valor: 10, status: 'submetido' }); ids.r13 = r13
  await editComb(r13, 20); await editComb(r13, 35)
  const a = await autos(r13, 'combustivel'); eq(a.length, 3, 'versoes do registo ' + r13)
  eq(active(a).length, 1, 'ativos ' + JSON.stringify(a.map((x) => x.id)))
  eq(a.slice(0, 2).map((x) => x.motivo_apagado), ['substituído por edição', 'substituído por edição'], 'motivo')
  eq([a[0].versao_anterior_id, a[1].versao_anterior_id, a[2].versao_anterior_id], [null, a[0].id, a[1].id], 'cadeia')
  eq([a[2].v, a[2].deleted_at], [35, null], 'ativo')
})
await t('Escala: +12 edicoes (15 versoes): 1 ativo, 14 substituidas, cadeia linear sem buracos; editar para o mesmo valor NAO cria versao', async () => {
  for (let i = 0; i < 12; i++) await editComb(r13, 40 + i)
  await editComb(r13, 51) // igual ao ultimo
  const a = await autos(r13, 'combustivel'); eq(a.length, 15, 'versoes do registo ' + r13); eq(active(a).length, 1, 'ativos')
  ok(a.slice(0, 14).every((x) => x.deleted_at && x.motivo_apagado === 'substituído por edição'), 'motivos das substituidas')
  for (let i = 1; i < a.length; i++) eq(a[i].versao_anterior_id, a[i - 1].id, 'cadeia posicao ' + i)
  eq(a.at(-1).v, 51, 'ativo final')
})
await t('Saldo da conta so conta o ativo (nao soma as 15 versoes): funcao sums() do cliente sobre os dados que a UI le vs soma ingenua', async () => {
  const all = await must(cont.from('movements').select('*').eq('registo_id', r13).eq('custo_tipo', 'combustivel'))
  const uiRows = all.filter((m) => !m.deleted_at) // a UI faz .is('deleted_at', null)
  eq(sums(uiRows).debit, 51, 'debitos oficiais do registo ' + r13)
  eq(sums(all).debit, 51, 'sums() sobre linhas incluindo apagadas (defesa em profundidade)')
  const naive = all.reduce((s, m) => s + Number(m.valor), 0); ok(naive > 51, 'controlo: soma ingenua deveria ser maior (' + naive + ')')
  const db = (await sql(`select coalesce(sum(valor),0)::float v from movements where registo_id='${r13}' and custo_tipo='combustivel' and deleted_at is null and estado='confirmado'`))[0].v; eq(db, 51, 'soma SQL dos ativos')
})
await t('Registo Validado editado (combustivel muda): reabre para Submetido e a nova versao e criada', async () => {
  const rec = await mkRec(admin, ctx.R2, '2026-04-03', { comb_valor: 20, status: 'validado' })
  await editComb(rec, 25, admin)
  const s = (await sql(`select status from daily_records where id='${rec}'`))[0].status; const a = await autos(rec, 'combustivel')
  eq([s, a.length, active(a)[0].v], ['submetido', 2, 25], 'registo ' + rec)
})
await t('Apagar o registo (soft) apaga o ativo com motivo; historico mantem-se', async () => {
  const rec = await mkRec(oper, ctx.R2, '2026-04-04', { comb_valor: 20, status: 'submetido' }); await editComb(rec, 22)
  await must(admin.from('daily_records').update({ deleted_at: new Date().toISOString() }).eq('id', rec)) // Operador nao apaga registos
  const a = await autos(rec, 'combustivel'); eq(active(a).length, 0, 'ativos'); eq(a.map((x) => x.motivo_apagado), ['substituído por edição', 'registo diário apagado'], 'motivos do registo ' + rec)
})
await t('Custo passado a vazio/0 num registo Submetido apaga o ativo; repor cria nova cadeia', async () => {
  const rec = await mkRec(oper, ctx.R2, '2026-04-05', { comb_valor: 20, status: 'submetido' })
  await must(oper.from('daily_records').update({ comb_valor: null }).eq('id', rec).select('id'))
  let a = await autos(rec, 'combustivel'); eq([active(a).length, a[0].motivo_apagado], [0, 'custo removido no registo diário'], 'registo ' + rec)
  await editComb(rec, 33); a = await autos(rec, 'combustivel'); eq([a.length, active(a).length, active(a)[0].v], [2, 1, 33], 'repor')
})

// ---------------- CASO 14 ----------------
setCaso('CASO 14')
await t('Historico das versoes consultavel apos o soft delete: Contabilista e Auditor(accounting_read) leem as 15 versoes com valor/estado/motivo (mesma consulta do detalhe da UI)', async () => {
  for (const [n, sb] of [['contabilista', cont], ['auditor.acc', audacc], ['admin', admin]]) {
    const h = await must(sb.from('movements').select('id,valor,estado,deleted_at,motivo_apagado,created_at').eq('registo_id', r13).eq('custo_tipo', 'combustivel').eq('origem', 'automatico').order('created_at'))
    eq(h.length, 15, `historico visto por ${n} (registo ${r13})`)
    eq(h.filter((x) => x.deleted_at).every((x) => x.motivo_apagado === 'substituído por edição'), true, 'motivos')
  }
})
await t('Historico nao e legivel por quem nao tem Contabilidade (Operador/Gestor do mesmo registo)', async () => {
  for (const [n, sb] of [['operador', oper], ['gestor', gest]]) eq((await must(sb.from('movements').select('id').eq('registo_id', r13))).length, 0, n)
})
await t('Versoes soft-deleted sao imutaveis (nem Super Admin as reativa/edita)', async () => {
  const old = (await autos(r13, 'combustivel'))[0]
  await denied(admin.from('movements').update({ deleted_at: null }).eq('id', old.id).select(), 'reativar versao ' + old.id)
  await denied(admin.from('movements').update({ valor: 1 }).eq('id', old.id).select(), 'editar versao ' + old.id)
})

// ---------------- CASO 15 ----------------
setCaso('CASO 15')
let r15, pend
await t('Custo ACIMA do limiar (150 > 100) nasce Pendente, sem validado_por; notifica todos os Super Admin e Contabilistas', async () => {
  r15 = await mkRec(oper, ctx.R1, '2026-04-06', { comb_valor: 150, status: 'submetido' }); ids.r15 = r15
  const a = await autos(r15, 'combustivel'); pend = a[0]; eq([a.length, a[0].estado, a[0].validado_por], [1, 'pendente', null], 'registo ' + r15)
  eq((await notifPend(pend.id)).map((x) => x.email), (await expected()).map((x) => x.email), 'destinatarios de ' + pend.id)
})
await t('Validar (Contabilista) -> Confirmado; editar o custo de origem outra vez (160) -> nova versao nasce Pendente (nao herda) e a anterior fica substituida', async () => {
  const v = await must(cont.from('movements').update({ estado: 'confirmado' }).eq('id', pend.id).select('estado,validado_por,validado_em').single()); eq([v.estado, v.validado_por, !!v.validado_em], ['confirmado', cont.uid, true], 'validar ' + pend.id)
  await editComb(r15, 160)
  const a = await autos(r15, 'combustivel'); eq(a.length, 2, 'versoes ' + r15); const n = active(a)[0]
  eq([n.estado, n.validado_por, n.v, n.versao_anterior_id], ['pendente', null, 160, pend.id], 'nova versao ' + n.id)
  eq((await notifPend(n.id)).length, (await expected()).length, 'notificacao da nova versao pendente ' + n.id)
  ids.p15 = n.id
})
await t('Sem alteracao de valor nao ha nova versao: mudar so o estado do registo (Submetido->Validado) mantem 1 ativo Pendente', async () => {
  await must(admin.from('daily_records').update({ status: 'validado' }).eq('id', r15).select('id'))
  const a = await autos(r15, 'combustivel'); eq([a.length, active(a).length, active(a)[0].estado], [2, 1, 'pendente'], 'registo ' + r15)
})
await t('Limiar: exatamente 100.00 -> Confirmado; 100.01 -> Pendente (portagens e combustivel)', async () => {
  const rec = await mkRec(oper, ctx.R1, '2026-04-07', { comb_valor: 100, portagens_valor: 100.01, status: 'submetido' })
  const c = await autos(rec, 'combustivel'), p = await autos(rec, 'portagens'); eq([c[0].estado, p[0].estado], ['confirmado', 'pendente'], `registo ${rec}: combustivel 100.00 / portagens 100.01`)
  const rec2 = await mkRec(oper, ctx.R1, '2026-04-08', { comb_valor: 99.99, status: 'submetido' }); eq((await autos(rec2, 'combustivel'))[0].estado, 'confirmado', '99.99 registo ' + rec2)
})
await t('Baixar um pendente acima do limiar para abaixo (150 -> 90): nova versao nasce Confirmado (a regra aplica-se a cada versao)', async () => {
  const rec = await mkRec(oper, ctx.R2, '2026-04-09', { comb_valor: 150, status: 'submetido' }); await editComb(rec, 90)
  const a = await autos(rec, 'combustivel'); eq([a[0].estado, active(a)[0].estado], ['pendente', 'confirmado'], 'registo ' + rec)
})
await t('Registo em RASCUNHO (mesmo 500 e varias edicoes) NAO gera lancamento; so ao Submeter nasce 1', async () => {
  const rec = await mkRec(oper, ctx.R2, '2026-04-10', { comb_valor: 500, portagens_valor: 9 }); ids.r15r = rec
  await editComb(rec, 510); await editComb(rec, 520)
  eq((await autos(rec, 'combustivel')).length + (await autos(rec, 'portagens')).length, 0, 'lancamentos em rascunho ' + rec)
  await must(oper.from('daily_records').update({ status: 'submetido' }).eq('id', rec).select('id'))
  const a = await autos(rec, 'combustivel'); eq([a.length, a[0].v, a[0].estado], [1, 520, 'pendente'], 'apos submeter ' + rec)
})
await t('Submetido/Validado NAO volta a Rascunho (transicao invalida): recusado, e por isso o Rascunho nunca gera versoes por gravacao', async () => {
  const rec = await mkRec(oper, ctx.R2, '2026-04-11', { comb_valor: 20, status: 'submetido' })
  await denied(oper.from('daily_records').update({ status: 'rascunho' }).eq('id', rec).select('id'), 'submetido -> rascunho ' + rec)
  await denied(admin.from('daily_records').update({ status: 'rascunho' }).eq('id', rec).select('id'), 'super admin submetido -> rascunho ' + rec)
  const a = await autos(rec, 'combustivel')
  if (a.length !== 1) throw new Error(`registo ${rec}: esperava 1 lancamento (o do Submetido), obtive ${a.length}`)
})
await t('Limiar configuravel: Contabilista nao o altera; Super Admin altera para 50 e 60 passa a Pendente; nao e retroativo', async () => {
  await denied(cont.from('accounting_settings').update({ validation_threshold: 1 }).eq('tenant_id', T).select(), 'contabilista altera limiar')
  const before = (await autos(ids.r12, 'combustivel'))[0].estado
  await setSettings({ validation_threshold: 50 })
  const rec = await mkRec(oper, ctx.R1, '2026-04-12', { comb_valor: 60, status: 'submetido' }); ids.r1204 = rec; const a = await autos(rec, 'combustivel')
  await setSettings({ validation_threshold: 100 })
  eq([a[0].estado, (await autos(ids.r12, 'combustivel'))[0].estado, before], ['pendente', 'confirmado', 'confirmado'], `registo ${rec}; nao retroativo`)
})

// ---------------- CASO 16 ----------------
setArea('Validacao seletiva'); setCaso('CASO 16')
const mkT = async (valor) => (await must(mvIns(cont, { subcategoria: 'transferencia_distribuicao', valor, pessoa_responsavel: 'QA-Hugo', data: '2026-04-15', descricao: 'QA-C-c16-transf' }).single()))
const mkA = (tr, o) => must(mvIns(cont, { subcategoria: 'outro', pessoa_responsavel: 'QA-Hugo', lancamento_referencia_id: tr.id, data: '2026-04-15', operation_id: ctx.opLN, rota_id: ctx.R1, descricao: 'QA-C-c16-alloc', ...o }).single())
await t('Alocacao nasce SEMPRE Pendente: 0.01, 1, 99.99, 100, 100.01, 5000 e mesmo pedindo estado=confirmado', async () => {
  const tr = await mkT(99999); const out = []
  for (const v of [0.01, 1, 99.99, 100, 100.01, 5000]) { const a = await mkA(tr, { valor: v, estado: 'confirmado', data: '2026-04-16', rota_id: null, operation_id: null }); out.push([v, (await mv(a.id)).estado]) }
  eq(out.map((x) => x[1]), Array(6).fill('pendente'), 'estados ' + JSON.stringify(out)); ids.c16tr = tr.id
})
await t('Com limiar 100000 (acima de tudo) e limiar 0, alocacao continua Pendente; automatico segue o limiar', async () => {
  const tr = await mkT(500)
  for (const th of [100000, 0]) {
    await setSettings({ validation_threshold: th }); const a = await mkA(tr, { valor: 1, rota_id: null, operation_id: null }); eq((await mv(a.id)).estado, 'pendente', `alocacao ${a.id} com limiar ${th}`)
  }
  await setSettings({ validation_threshold: 100 })
})
await t('Alocacao pendente notifica todos os Super Admin e Contabilistas; um movimento manual normal nao notifica', async () => {
  const tr = await mkT(50); const a = await mkA(tr, { valor: 5, rota_id: null, operation_id: null })
  eq((await notifPend(a.id)).map((x) => x.email), (await expected()).map((x) => x.email), 'alocacao ' + a.id)
  const m = await must(mvIns(cont, { valor: 5, descricao: 'QA-C-c16-manual' }).single()); eq((await notifPend(m.id)).length, 0, 'manual ' + m.id)
})

// ---------------- CASO 17 ----------------
setCaso('CASO 17')
await t('Alocacao de valor alto (5000) na Conta B: saldo oficial da conta NAO muda ate validar; pendente aparece a parte; ao validar entra no saldo', async () => {
  const snap = async () => { const r = await must(cont.from('movements').select('*').eq('conta_id', ctx.contaB).is('deleted_at', null)); return sums(r) }
  const base = await mv((await must(mvIns(cont, { conta_id: ctx.contaB, valor: 40, tipo: 'credito', descricao: 'QA-C-c17-base' }).single())).id)
  const before = await snap()
  const tr = await must(mvIns(cont, { conta_id: ctx.contaB, subcategoria: 'transferencia_distribuicao', valor: 6000, pessoa_responsavel: 'QA-Ines', data: '2026-04-17', tipo: 'debito', descricao: 'QA-C-c17-transf' }).single())
  const mid = await snap() // a transferencia (manual, confirmado) ja conta: 6000 debito
  const a = await must(mvIns(cont, { conta_id: ctx.contaB, subcategoria: 'outro', valor: 5000, pessoa_responsavel: 'QA-Ines', lancamento_referencia_id: tr.id, data: '2026-04-17', descricao: 'QA-C-c17-alloc' }).single())
  const after = await snap()
  eq([after.net, after.debit, after.credit], [mid.net, mid.debit, mid.credit], 'saldo oficial mudou com alocacao pendente ' + a.id)
  eq([after.pendingCount - mid.pendingCount, after.pendingAmount - mid.pendingAmount], [1, 5000], 'pendente a parte')
  await must(cont.from('movements').update({ estado: 'confirmado' }).eq('id', a.id).select())
  const fin = await snap(); eq([fin.debit - mid.debit, fin.pendingAmount - mid.pendingAmount], [5000, 0], 'depois de validar')
  ids.c17 = { tr: tr.id, a: a.id, base: base.id }
})

// ---------------- CASO 18 ----------------
setCaso('CASO 18')
await t('Pendentes ativos = SO alocacoes + automaticos acima do limiar (invariante no tenant inteiro); nenhum manual normal nem automatico <= limiar', async () => {
  const bad = await sql(`select id, origem, estado, valor::float v, lancamento_referencia_id ref, custo_tipo from movements m where tenant_id='${T}' and deleted_at is null and estado='pendente'
    and not (lancamento_referencia_id is not null or (origem='automatico' and valor > (select coalesce((select validation_threshold from accounting_settings where tenant_id=m.tenant_id),100))))
    and coalesce(descricao,'') <> 'Revisao 12-AB-34' /* linha legada do seed antigo (2026-09-19), fora do ambito */
    and registo_id is distinct from '${ids.r1204}' /* o teste do limiar (50) criou 1 automatico de 60 pendente de proposito */`)
  eq(bad.length, 0, 'pendentes indevidos: ' + JSON.stringify(bad.slice(0, 5)))
})
await t('Fila "Por validar" (mesma consulta/filtro da UI) contem as alocacoes e os automaticos > limiar e exclui manuais e automaticos <= limiar', async () => {
  const tr18 = await mkT(100); const a18 = await mkA(tr18, { valor: 12, rota_id: null, operation_id: null }); // (criada ANTES de ler a fila; a alocacao do caso 17 ja foi validada)
  const rows = await must(cont.from('movements').select('id,estado,origem,valor,lancamento_referencia_id,deleted_at').is('deleted_at', null))
  const queue = new Set(rows.filter((m) => m.estado === 'pendente').map((m) => m.id))
  const has = (id) => queue.has(id)
  const okIds = [ids.p15, a18.id], mustNot = [(await autos(ids.r12, 'combustivel'))[0].id, ids.c17.base, ids.c17.tr]
  ok(okIds.every(has), 'faltam na fila: ' + okIds.filter((i) => !has(i))); ok(mustNot.every((i) => !has(i)), 'na fila indevidamente: ' + mustNot.filter(has))
  // as versoes antigas (apagadas) nunca aparecem
  const old = await sql(`select id from movements where registo_id='${ids.r15}' and deleted_at is not null`); ok(old.every((o) => !has(o.id)), 'versao substituida na fila')
  ids.pendCount = queue.size
})

// ---------------- CASO 19 ----------------
setCaso('CASO 19')
await t('Sem papel de Contabilista nao se valida: Operador, Gestor, Motorista, Auditor(s) e Super Admin de OUTRO tenant recusados; estado mantem-se Pendente', async () => {
  const tr = await mkT(100); const a = await mkA(tr, { valor: 10, rota_id: null, operation_id: null }); ids.c19 = a.id
  for (const [n, sb] of [['operador', oper], ['gestor', gest], ['motorista', mot], ['auditor', aud], ['auditor.acc', audacc], ['super_admin tenant B', users.tb]]) {
    const r = await sb.from('movements').update({ estado: 'confirmado' }).eq('id', a.id).select('id')
    if (!r.error && r.data?.length) throw new Error(`${n} validou o movimento ${a.id}`)
  }
  const m = await mv(a.id); eq([m.estado, m.validado_por], ['pendente', null], 'movimento ' + a.id)
})
await t('Contabilista consegue validar e reverter para Pendente; a reversao volta a notificar; Super Admin tambem valida', async () => {
  const m = await must(cont.from('movements').update({ estado: 'confirmado' }).eq('id', ids.c19).select('estado,validado_por').single()); eq([m.estado, m.validado_por], ['confirmado', cont.uid], 'validar')
  const r = await must(cont.from('movements').update({ estado: 'pendente' }).eq('id', ids.c19).select('estado,validado_por').single()); eq([r.estado, r.validado_por], ['pendente', null], 'reverter')
  const s = await must(admin.from('movements').update({ estado: 'confirmado' }).eq('id', ids.c19).select('estado,validado_por').single()); eq([s.estado, s.validado_por], ['confirmado', admin.uid], 'super admin valida')
})

await setSettings({ default_account_id: null }) // repor: sem conta por defeito
savectx(); dump('results-02.json')
