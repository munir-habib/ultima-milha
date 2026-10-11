// Ronda 2: regressao das correcoes F5 (automatico so muda no registo), F4 (created_by/created_at), F3 (registo nao volta a Rascunho).
import { ctx, T, loginAll, users, t, setCaso, setArea, eq, ok, must, denied, sql, mvIns, mv, mkRec, autos, dump, savectx } from './h.mjs'
await loginAll(); const { admin, cont, oper, gest } = users
const strip = (r) => { const { updated_at, ...x } = r; return x }
const same = async (id, snap, msg) => eq(strip(await mv(id)), strip(snap), msg)

// ---------------- F5 (caso 22/base: automatico so muda no registo) ----------------
setArea('F5 - automatico so muda no registo diario'); setCaso('F5')
let A, rec, snap
const other = admin.uid // distinto do created_by do automatico (= Operador que criou o registo)
const driver = (await sql(`select id from drivers where tenant_id='${T}' and deleted_at is null limit 1`))[0]?.id
await t('Preparacao: registo Submetido com combustivel 30 -> automatico Confirmado', async () => {
  rec = await mkRec(oper, ctx.R1, '2026-08-01', { comb_valor: 30, portagens_valor: 8, status: 'submetido' })
  A = (await autos(rec, 'combustivel'))[0]; snap = await mv(A.id); eq(snap.origem, 'automatico', 'origem ' + A.id)
})
const tr = await must(mvIns(cont, { subcategoria: 'transferencia_distribuicao', valor: 500, pessoa_responsavel: 'QA-F5', data: '2026-08-01', descricao: 'QA-C-f5-transf' }).single())
const other2 = (await autos(rec, 'portagens'))[0]
const forb = {
  valor: { valor: 31 }, data: { data: '2026-08-02' }, tipo: { tipo: 'credito' }, subcategoria: { subcategoria: 'manutencao' },
  'subcategoria=transferencia_distribuicao': { subcategoria: 'transferencia_distribuicao' },
  pessoa_responsavel: { pessoa_responsavel: 'QA-forjada' }, lancamento_referencia_id: { lancamento_referencia_id: tr.id },
  'transformar em alocacao (ronda 1)': { lancamento_referencia_id: tr.id, subcategoria: 'outro', pessoa_responsavel: 'QA-forjada' },
  'transformar em transferencia (ronda 1)': { lancamento_referencia_id: null, subcategoria: 'transferencia_distribuicao', pessoa_responsavel: 'QA-forjada' },
  registo_id: { registo_id: null }, 'registo_id outro': { registo_id: (await autos(rec, 'portagens'))[0] ? (await mkRec(oper, ctx.R2, '2026-08-02')) : null },
  custo_tipo: { custo_tipo: 'portagens' }, versao_anterior_id: { versao_anterior_id: other2.id }, origem: { origem: 'manual_geral' },
  'origem manual_rota': { origem: 'manual_rota' }, created_by: { created_by: other }, created_at: { created_at: '2001-01-01T00:00:00Z' },
  tenant_id: { tenant_id: '00000000-0000-0000-0000-000000000000' },
  ...(driver ? { motorista_id: { motorista_id: driver } } : {}),
}
for (const [who, sb] of [['Contabilista', cont], ['Super Admin', admin]]) {
  await t(`${who}: QUALQUER campo que nao seja estado/rota/operacao/conta/descricao e recusado no automatico ${'(' + Object.keys(forb).length} tentativas; linha fica intacta)`, async () => {
    const fails = []
    for (const [k, patch] of Object.entries(forb)) {
      const r = await sb.from('movements').update(patch).eq('id', A.id).select('id')
      const accepted = !r.error && r.data?.length
      const now = await mv(A.id)
      if (accepted || JSON.stringify(strip(now)) !== JSON.stringify(strip(snap))) fails.push(k + (accepted ? ' ACEITE' : ' alterou linha'))
    }
    if (fails.length) throw new Error(`automatico ${A.id} (registo ${rec}) alterado por ${who}: ${fails.join(', ')}`)
  })
}
await t('motivo_apagado numa linha ATIVA (deleted_at nulo): automatico e manual (Contabilista/Super Admin) - dado inerte mas "sujo"', async () => {
  const man = await must(mvIns(cont, { descricao: 'QA-C-f5-motivo' }).single()); const bad = []
  for (const [who, sb] of [['contabilista', cont], ['admin', admin]]) for (const [k, id] of [['automatico', A.id], ['manual', man.id]]) {
    const r = await sb.from('movements').update({ motivo_apagado: 'sorrateiro-' + who }).eq('id', id).select('id,motivo_apagado,deleted_at')
    if (!r.error && r.data?.length) bad.push(who + ' gravou motivo_apagado em ' + k + ' ativo ' + id)
    await sql(`update movements set motivo_apagado=null where id='${id}'`) // repor (postgres) para nao sujar os testes seguintes
  }
  if (bad.length) throw new Error(bad.join('; ') + ' (deleted_at continua nulo)')
})
await t('Atomicidade: patch misto (descricao permitida + valor proibido) e recusado por inteiro, mesmo para Super Admin', async () => {
  for (const sb of [cont, admin]) {
    const r = await sb.from('movements').update({ descricao: 'QA-C-f5-misto', valor: 99 }).eq('id', A.id).select('id'); ok(r.error || !r.data?.length, 'aceite')
  }
  await same(A.id, snap, 'linha ' + A.id)
})
await t('O que SE pode alterar na Contabilidade: descricao, conta, estado (validar/reverter), reclassificar rota/operacao; origem mantem-se Automatico', async () => {
  const r1 = await must(cont.from('movements').update({ descricao: 'QA-C-f5-descr editada', conta_id: ctx.contaB }).eq('id', A.id).select('descricao,conta_id,origem').single()); eq([r1.descricao, r1.conta_id, r1.origem], ['QA-C-f5-descr editada', ctx.contaB, 'automatico'], 'descricao+conta ' + A.id)
  const r2 = await must(cont.from('movements').update({ estado: 'pendente' }).eq('id', A.id).select('estado,validado_por').single()); eq([r2.estado, r2.validado_por], ['pendente', null], 'reverter ' + A.id)
  const r3 = await must(cont.from('movements').update({ estado: 'confirmado' }).eq('id', A.id).select('estado,validado_por,validado_em').single()); eq([r3.estado, r3.validado_por, !!r3.validado_em], ['confirmado', cont.uid, true], 'validar ' + A.id)
  const r4 = await must(cont.from('movements').update({ rota_id: ctx.R2 }).eq('id', A.id).select('rota_id,operation_id,origem').single()); eq([r4.rota_id, r4.operation_id, r4.origem], [ctx.R2, ctx.opLN, 'automatico'], 'reclassificar rota ' + A.id)
  const r5 = await must(cont.from('movements').update({ operation_id: ctx.opPC, rota_id: ctx.RP }).eq('id', A.id).select('rota_id,operation_id,origem').single()); eq([r5.rota_id, r5.operation_id, r5.origem], [ctx.RP, ctx.opPC, 'automatico'], 'reclassificar operacao+rota ' + A.id)
  const bad = await cont.from('movements').update({ operation_id: ctx.opLN, rota_id: ctx.RP }).eq('id', A.id).select('id'); ok(bad.error || !bad.data?.length, 'operacao+rota incoerentes aceites ' + A.id)
  const r6 = await must(cont.from('movements').update({ operation_id: ctx.opLN, rota_id: ctx.R1 }).eq('id', A.id).select('rota_id,operation_id').single()); eq([r6.rota_id, r6.operation_id], [ctx.R1, ctx.opLN], 'repor ' + A.id)
  // o registo diario e a fonte: o valor la continua igual
  eq(Number((await sql(`select comb_valor::float v from daily_records where id='${rec}'`))[0].v), 30, 'registo diario')
})
await t('Editar o custo NO registo diario continua a criar nova versao (o servidor pode); o antigo fica substituido', async () => {
  await must(oper.from('daily_records').update({ comb_valor: 45 }).eq('id', rec).select('id'))
  const a = await autos(rec, 'combustivel'); eq([a.length, a.filter((x) => !x.deleted_at).length, a.filter((x) => !x.deleted_at)[0].v, a[0].motivo_apagado], [2, 1, 45, 'substituído por edição'], 'registo ' + rec)
})
await t('Soft delete do automatico: Contabilista recusado; Super Admin com motivo aceite (deleted_at/motivo_apagado continuam permitidos)', async () => {
  const cur = (await autos(rec, 'combustivel')).find((x) => !x.deleted_at)
  await denied(cont.from('movements').update({ deleted_at: new Date().toISOString(), motivo_apagado: 'QA' }).eq('id', cur.id).select('id'), 'contabilista apaga automatico ' + cur.id)
  await denied(admin.from('movements').update({ deleted_at: new Date().toISOString() }).eq('id', cur.id).select('id'), 'super admin sem motivo ' + cur.id)
  const r = await must(admin.from('movements').update({ deleted_at: new Date().toISOString(), motivo_apagado: 'QA-C f5' }).eq('id', cur.id).select('id,deleted_at').single()); ok(r.deleted_at, 'nao apagou ' + cur.id)
})
await t('Regressao: um lancamento MANUAL continua editavel (valor, data, tipo, subcategoria) e reclassificavel; origem acompanha a operacao', async () => {
  const m = await must(mvIns(cont, { valor: 10, subcategoria: 'manutencao', descricao: 'QA-C-f5-manual' }).single())
  const r = await must(cont.from('movements').update({ valor: 11, data: '2026-08-03', tipo: 'credito', subcategoria: 'outro' }).eq('id', m.id).select('valor,data,tipo,subcategoria').single()); eq([Number(r.valor), r.data, r.tipo, r.subcategoria], [11, '2026-08-03', 'credito', 'outro'], 'manual ' + m.id)
  const r2 = await must(cont.from('movements').update({ operation_id: ctx.opLN, rota_id: ctx.R1 }).eq('id', m.id).select('origem').single()); eq(r2.origem, 'manual_rota', 'origem apos reclassificar ' + m.id)
  const r3 = await must(cont.from('movements').update({ operation_id: null, rota_id: null }).eq('id', m.id).select('origem').single()); eq(r3.origem, 'manual_geral', 'origem apos ir a Geral ' + m.id)
})
await t('Regressao: alocacao (manual) continua editavel e mudar valor/tipo/data/pessoa tira a validacao; reclassificar mantem-na', async () => {
  const al = await must(mvIns(cont, { subcategoria: 'outro', valor: 20, pessoa_responsavel: 'QA-F5', lancamento_referencia_id: tr.id, data: '2026-08-04', descricao: 'QA-C-f5-alloc' }).single())
  await must(cont.from('movements').update({ estado: 'confirmado' }).eq('id', al.id).select())
  await must(cont.from('movements').update({ operation_id: ctx.opLN, rota_id: ctx.R2 }).eq('id', al.id).select()); eq((await mv(al.id)).estado, 'confirmado', 'reclassificar mantem validacao ' + al.id)
  for (const [k, p] of [['valor', { valor: 21 }], ['tipo', { tipo: 'credito' }], ['data', { data: '2026-08-05' }], ['pessoa', { pessoa_responsavel: 'QA-F5b' }]]) {
    await must(cont.from('movements').update({ estado: 'confirmado' }).eq('id', al.id).select()); await must(cont.from('movements').update(p).eq('id', al.id).select())
    const m = await mv(al.id); eq([m.estado, m.validado_por], ['pendente', null], `alterar ${k} devia tirar a validacao (${al.id})`)
  }
})

// ---------------- F4 ----------------
setArea('F4 - created_by / created_at'); setCaso('F4')
await t('INSERT com created_at/created_by forjados: created_at = now() do servidor e created_by = quem inseriu (Contabilista e Super Admin)', async () => {
  for (const [who, sb] of [['contabilista', cont], ['admin', admin]]) {
    const before = Date.now()
    const r = await sb.from('movements').insert({ tenant_id: T, data: '2026-08-06', conta_id: ctx.contaA, tipo: 'debito', valor: 1, subcategoria: 'outro', descricao: 'QA-C-f4-' + who, created_at: '2001-01-01T00:00:00Z', created_by: other }).select('id,created_at,created_by')
    if (r.error) return `INSERT com created_at forjado recusado (${r.error.message}) - tambem cumpre`
    const m = r.data[0]; const dt = Math.abs(new Date(m.created_at).getTime() - before)
    ok(dt < 120000, `${who}: created_at ${m.created_at} != now() (movimento ${m.id})`); eq(m.created_by, sb.uid, `${who}: created_by do movimento ${m.id}`)
  }
})
await t('UPDATE de created_by ou created_at recusado (Contabilista e Super Admin), em manual e em automatico', async () => {
  const man = await must(mvIns(cont, { descricao: 'QA-C-f4-manual' }).single()); const s0 = await mv(man.id)
  for (const [who, sb] of [['contabilista', cont], ['admin', admin]]) for (const [k, p] of [['created_by', { created_by: other }], ['created_at', { created_at: '2001-01-01T00:00:00Z' }], ['ambos', { created_by: other, created_at: '2001-01-01T00:00:00Z' }]]) {
    const r = await sb.from('movements').update(p).eq('id', man.id).select('id'); ok(r.error || !r.data?.length, `${who} ${k} aceite em ${man.id}`)
  }
  await same(man.id, s0, 'manual ' + man.id)
})

// ---------------- F3 ----------------
setArea('F3 - registo nao volta a Rascunho'); setCaso('F3')
await t('Submetido -> Rascunho recusado (Operador, Gestor, Super Admin); Validado -> Rascunho recusado (Gestor, Super Admin)', async () => {
  const r = await mkRec(oper, ctx.R2, '2026-08-10', { comb_valor: 20, status: 'submetido' })
  for (const [n, sb] of [['operador', oper], ['gestor', gest], ['admin', admin]]) await denied(sb.from('daily_records').update({ status: 'rascunho' }).eq('id', r).select('id'), `${n}: submetido->rascunho ${r}`)
  eq((await sql(`select status from daily_records where id='${r}'`))[0].status, 'submetido', 'estado do registo ' + r)
  await must(gest.from('daily_records').update({ status: 'validado' }).eq('id', r).select('id'))
  for (const [n, sb] of [['operador', oper], ['gestor', gest], ['admin', admin]]) await denied(sb.from('daily_records').update({ status: 'rascunho' }).eq('id', r).select('id'), `${n}: validado->rascunho ${r}`)
  const s = (await sql(`select status, validado_por from daily_records where id='${r}'`))[0]; eq([s.status, s.validado_por], ['validado', gest.uid], 'registo ' + r)
  eq((await autos(r, 'combustivel')).length, 1, 'lancamentos do registo ' + r)
})
await t('Recusa tambem com outros campos no mesmo UPDATE (status=rascunho + comb_valor=0 nao apaga o automatico)', async () => {
  const r = await mkRec(oper, ctx.R1, '2026-08-11', { comb_valor: 20, status: 'submetido' })
  await denied(oper.from('daily_records').update({ status: 'rascunho', comb_valor: 0 }).eq('id', r).select('id'), 'registo ' + r)
  const a = await autos(r, 'combustivel'); eq([a.length, a.filter((x) => !x.deleted_at).length, Number((await sql(`select comb_valor::float v from daily_records where id='${r}'`))[0].v)], [1, 1, 20], 'registo ' + r)
})
await t('Rascunho continua a poder ser gravado (Rascunho -> Rascunho) sem gerar lancamentos; Rascunho -> Submetido gera 1', async () => {
  const r = await mkRec(oper, ctx.R1, '2026-08-12', { comb_valor: 5 })
  for (const v of [6, 7, 8, 9]) await must(oper.from('daily_records').update({ comb_valor: v, status: 'rascunho' }).eq('id', r).select('id'))
  eq((await autos(r, 'combustivel')).length, 0, 'lancamentos em rascunho ' + r)
  await must(oper.from('daily_records').update({ status: 'submetido' }).eq('id', r).select('id')); eq((await autos(r, 'combustivel')).length, 1, 'ao submeter ' + r)
})
await t('Motorista: nao consegue devolver um registo Submetido a Rascunho', async () => {
  const mot = users.mot
  const rows = await must(mot.from('daily_records').select('id,status').eq('status', 'submetido').limit(1))
  if (!rows.length) return 'motorista sem registos submetidos visiveis (nada a testar por RLS)'
  await denied(mot.from('daily_records').update({ status: 'rascunho' }).eq('id', rows[0].id).select('id'), 'motorista ' + rows[0].id)
})
dump('results-06.json'); savectx()
