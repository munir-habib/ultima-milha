// Cenario: Contabilidade (estado inicial decidido no servidor, automaticos versionados, alocacoes, soft delete, notificacoes).
import { readFileSync, writeFileSync } from 'node:fs'
import { login, ADMIN, sql, t, setArea, eq, ok, must, denied, save } from './lib.mjs'

const ctx = JSON.parse(readFileSync(new URL('./ctx.json', import.meta.url), 'utf8'))
const admin = await login(...ADMIN)
const [cont, gest, oper] = await Promise.all(['qa.contabilista', 'qa.gestor', 'qa.operador'].map((n) => login(n + '@example.test')))
const tenant_id = (await must(admin.from('profiles').select('tenant_id').eq('id', admin.uid).single())).tenant_id
const CONTA = '51975d3c-aed8-4524-be86-ca02daceaf36'
const SEED_LN_ROUTE = '2504bf59-c578-4c8e-a91f-4fedffdee701'
const mvAct = (rid, tipo) => must(admin.from('movements').select('*').eq('registo_id', rid).eq('custo_tipo', tipo).order('created_at'))
const mkRec = (data, extra = {}) => must(admin.from('daily_records').insert({ route_id: ctx.routeLN, data, ...extra }).select('id').single()).then((r) => r.id)
const setThreshold = (v) => sql(`insert into accounting_settings (tenant_id, validation_threshold) values ('${tenant_id}', ${v}) on conflict (tenant_id) do update set validation_threshold = ${v}`)
const manual = (sb, o) => sb.from('movements').insert({ tenant_id, data: '2026-07-20', conta_id: CONTA, tipo: 'debito', valor: 10, subcategoria: 'outro', ...o }).select('*')

setArea('Contabilidade - lancamentos automaticos (regra do estado inicial, so a partir de Submetido, versionamento)')
const A1 = await mkRec('2026-07-01', { comb_valor: 30 })
await t('Rascunho com combustivel NAO gera lancamento', async () => { eq((await mvAct(A1, 'combustivel')).length, 0, 'lancamentos do registo rascunho ' + A1) })
await must(admin.from('daily_records').update({ status: 'submetido' }).eq('id', A1))
await t('Ao sair de Rascunho gera lancamento Automatico, Confirmado (30 <= 100), com origem/rota/operacao explicitas e conta nula (sem conta por defeito)', async () => {
  const m = await mvAct(A1, 'combustivel'); eq(m.length, 1, 'n lancamentos ' + A1)
  eq([m[0].origem, m[0].estado, m[0].rota_id, m[0].operation_id, m[0].tipo, Number(m[0].valor), m[0].subcategoria], ['automatico', 'confirmado', ctx.routeLN, ctx.opLN, 'debito', 30, 'custo_automatico'], 'mov ' + m[0].id)
  eq(m[0].conta_id, null, 'conta_id (sem default_account_id) mov ' + m[0].id)
})
await must(admin.from('daily_records').update({ comb_valor: 60 }).eq('id', A1))
await t('Editar o custo cria NOVA versao; anterior fica soft-deleted "substituído por edição" e ligada por versao_anterior_id', async () => {
  const all = await must(admin.from('movements').select('*').eq('registo_id', A1).eq('custo_tipo', 'combustivel').order('created_at'))
  eq(all.length, 2, 'versoes'); const [v1, v2] = all
  ok(v1.deleted_at && v1.motivo_apagado === 'substituído por edição', `v1 ${v1.id}: deleted_at/motivo = ${v1.deleted_at}/${v1.motivo_apagado}`)
  eq([v2.versao_anterior_id, v2.deleted_at, Number(v2.valor)], [v1.id, null, 60], 'v2 ' + v2.id)
})
await must(admin.from('daily_records').update({ comb_valor: 150 }).eq('id', A1))
let pend
await t('Nova versao acima do limite (150 > 100) nasce Pendente (nunca herda validacao)', async () => {
  const a = (await mvAct(A1, 'combustivel')).filter((x) => !x.deleted_at); eq(a.length, 1, 'ativos'); pend = a[0]
  eq([pend.estado, pend.validado_por], ['pendente', null], 'mov ' + pend.id)
})
await t('Limite exato: 100.00 -> Confirmado; 100.01 -> Pendente', async () => {
  await must(admin.from('daily_records').update({ portagens_valor: 100 }).eq('id', A1))
  const a = (await mvAct(A1, 'portagens')).filter((x) => !x.deleted_at)[0]; eq(a.estado, 'confirmado', 'portagens 100.00 mov ' + a.id)
  await must(admin.from('daily_records').update({ portagens_valor: 100.01 }).eq('id', A1))
  const b = (await mvAct(A1, 'portagens')).filter((x) => !x.deleted_at)[0]; eq(b.estado, 'pendente', 'portagens 100.01 mov ' + b.id)
})
await t('Custo passado a 0 apaga (soft) o lancamento ativo com motivo', async () => {
  await must(admin.from('daily_records').update({ portagens_valor: 0 }).eq('id', A1))
  const all = await mvAct(A1, 'portagens'); ok(all.every((x) => x.deleted_at), 'restam ativos: ' + all.filter((x) => !x.deleted_at).map((x) => x.id))
  ok(all.at(-1).motivo_apagado === 'custo removido no registo diário', 'motivo: ' + all.at(-1).motivo_apagado)
})
await t('Registo apagado (soft) apaga o lancamento automatico com motivo', async () => {
  const A2 = await mkRec('2026-07-02', { comb_valor: 40, status: 'submetido' }); ctx.A2 = A2
  eq((await mvAct(A2, 'combustivel')).length, 1, 'criado')
  await must(admin.from('daily_records').update({ deleted_at: new Date().toISOString() }).eq('id', A2))
  const m = (await mvAct(A2, 'combustivel'))[0]; ok(m.deleted_at && m.motivo_apagado === 'registo diário apagado', `mov ${m.id}: ${m.motivo_apagado}`)
})
await t('Limite configuravel: com limite 50, automatico de 60 nasce Pendente; so Super Admin altera o limite', async () => {
  await denied(cont.from('accounting_settings').upsert({ tenant_id, validation_threshold: 1 }).select(), 'contabilista altera limite')
  await setThreshold(50)
  const A3 = await mkRec('2026-07-03', { comb_valor: 60, status: 'submetido' }); ctx.A3 = A3
  const m = (await mvAct(A3, 'combustivel'))[0]; await setThreshold(100); eq(m.estado, 'pendente', 'mov ' + m.id)
})
await t('Conta por defeito: novos automaticos passam a ter conta_id', async () => {
  await sql(`update accounting_settings set default_account_id='${CONTA}' where tenant_id='${tenant_id}'`)
  const A4 = await mkRec('2026-07-04', { comb_valor: 20, status: 'submetido' }); ctx.A4 = A4
  const m = (await mvAct(A4, 'combustivel'))[0]; await sql(`update accounting_settings set default_account_id=null where tenant_id='${tenant_id}'`); eq(m.conta_id, CONTA, 'mov ' + m.id)
})
await t('Notificacao ao entrar em Pendente: TODOS os Super Admin E TODOS os Contabilistas do tenant (e mais ninguem)', async () => {
  const n = await sql(`select n.user_id, p.email from notifications n join profiles p on p.id=n.user_id where n.tipo='movement_pending' and n.payload->>'movement_id'='${pend.id}' order by 2`)
  const exp = await sql(`select p.email from profiles p join user_roles r on r.user_id=p.id where p.tenant_id='${tenant_id}' and r.role in ('super_admin','contabilista') and p.deleted_at is null group by p.email order by 1`)
  eq(n.map((x) => x.email), exp.map((x) => x.email), 'destinatarios do movimento ' + pend.id)
})
await t('Automatico: na Contabilidade nao se altera valor/data; pode validar e reclassificar', async () => {
  await denied(cont.from('movements').update({ valor: 1 }).eq('id', pend.id).select(), 'contabilista muda valor do automatico ' + pend.id)
  const v = await must(cont.from('movements').update({ estado: 'confirmado' }).eq('id', pend.id).select('estado,validado_por,validado_em').single())
  eq([v.estado, v.validado_por, !!v.validado_em], ['confirmado', cont.uid, true], 'validar ' + pend.id)
  const r = await must(cont.from('movements').update({ rota_id: SEED_LN_ROUTE }).eq('id', pend.id).select('rota_id,estado').single()); eq(r.rota_id, SEED_LN_ROUTE, 'reclassificar')
})

setArea('Contabilidade - estado inicial decidido pelo servidor e origem explicita')
await t('Manual: o cliente pede "pendente" mas o servidor grava Confirmado', async () => { const r = await must(manual(cont, { estado: 'pendente', descricao: 'QA-manual-geral' }).single()); ctx.mManual = r.id; eq([r.estado, r.origem, r.operation_id], ['confirmado', 'manual_geral', null], 'mov ' + r.id) })
await t('Origem e decidida pelo servidor: Manual-Geral sem operacao, Manual-Rota com operacao; rota sem operacao e recusada', async () => {
  await denied(manual(cont, { rota_id: ctx.routeLN }), 'rota sem operacao')
  const r = await must(manual(cont, { operation_id: ctx.opLN, rota_id: ctx.routeLN, descricao: 'QA-manual-rota' }).single()); eq([r.origem, r.estado], ['manual_rota', 'confirmado'], 'mov ' + r.id); ctx.mRota = r.id
})
await t('O cliente NAO consegue enviar origem (qualquer valor, incluindo o certo) nem forjar um lancamento automatico', async () => {
  for (const o of ['automatico', 'manual_geral', 'manual_rota']) {
    const r = await manual(cont, { origem: o, valor: 10, descricao: 'QA-origem-enviada-' + o })
    if (!r.error && r.data?.length) { ctx.mForged = r.data[0].id; throw new Error(`Contabilista (qa.contabilista) criou o movimento ${r.data[0].id} enviando origem='${o}' (estado=${r.data[0].estado}): a origem tem de ser decidida so pelo servidor.`) }
  }
  const m = await must(manual(cont, { descricao: 'QA-origem-update' }).single()); ctx.mOrigUpd = m.id
  await denied(cont.from('movements').update({ origem: 'automatico' }).eq('id', m.id).select(), 'update origem -> automatico')
  const now = (await sql(`select origem from movements where id='${m.id}'`))[0]; eq(now.origem, 'manual_geral', 'origem de ' + m.id)
})
await t('O cliente NAO consegue escrever registo_id, custo_tipo, versao_anterior_id, validado_por nem validado_em (insert e update)', async () => {
  const m = await must(manual(cont, { descricao: 'QA-campos-sistema' }).single()); ctx.mSys = m.id
  const forged = { registo_id: ctx.RMIN, custo_tipo: 'combustivel', versao_anterior_id: m.id, validado_por: cont.uid, validado_em: new Date().toISOString() }
  for (const [k, v] of Object.entries(forged)) {
    const ins = await manual(cont, { [k]: v, descricao: 'QA-forjado-' + k })
    if (!ins.error && ins.data?.length) { ctx.mForged2 = (ctx.mForged2 ?? []).concat(ins.data[0].id); throw new Error(`insert com ${k} aceite: movimento ${ins.data[0].id}`) }
    const upd = await cont.from('movements').update({ [k]: v }).eq('id', m.id).select()
    if (!upd.error && upd.data?.length) throw new Error(`update de ${k} aceite no movimento ${m.id}`)
  }
})
await t('Origem sempre preenchida e coerente em todos os movimentos ativos do tenant', async () => {
  const bad = await sql(`select id, origem, operation_id from movements where tenant_id='${tenant_id}' and deleted_at is null and (origem is null or (origem='manual_geral' and operation_id is not null) or (origem='manual_rota' and operation_id is null))`); eq(bad.length, 0, 'incoerentes ' + JSON.stringify(bad))
})

setArea('Contabilidade - distribuicao de fundos e propagacao diferida')
const T = await must(manual(cont, { valor: 100, subcategoria: 'transferencia_distribuicao', pessoa_responsavel: 'QA-Joao', data: '2026-05-01', descricao: 'QA-transferencia' }).single()); ctx.T = T.id
const alloc = (o) => manual(cont, { valor: 60, subcategoria: 'outro', pessoa_responsavel: 'QA-Joao', operation_id: ctx.opLN, rota_id: ctx.routeLN, lancamento_referencia_id: T.id, data: '2026-05-01', ...o })
let a1, a2
await t('Alocacao nasce SEMPRE Pendente (mesmo que o cliente peca Confirmado) e propaga para o registo diario existente (linha de custo)', async () => {
  a1 = await must(alloc({ estado: 'confirmado', descricao: 'QA-alloc-1' }).single()); ctx.a1 = a1.id
  const a1db = (await sql(`select estado, registo_id, validado_por from movements where id='${a1.id}'`))[0] // RETURNING nao ve o UPDATE feito pelo trigger AFTER INSERT
  eq([a1db.estado, a1db.registo_id, a1db.validado_por], ['pendente', ctx.RMIN, null], 'alloc ' + a1.id)
  const c = await sql(`select id, valor::float v, categoria from daily_record_costs where movimento_id='${a1.id}'`); eq(c.map((x) => x.v), [60], 'linha de custo da alloc ' + a1.id)
})
await t('Sem registo diario: alocacao fica "por ligar" (registo_id nulo) e NAO cria o registo', async () => {
  a2 = await must(alloc({ data: '2026-08-10', valor: 30, descricao: 'QA-alloc-2' }).single()); ctx.a2 = a2.id
  eq(a2.registo_id, null, 'alloc ' + a2.id)
  eq((await sql(`select count(*)::int n from daily_records where route_id='${ctx.routeLN}' and data='2026-08-10'`))[0].n, 0, 'registo criado indevidamente')
})
await t('Quando o registo nasce, a alocacao anexa-se (registo_id preenchido + linha de custo)', async () => {
  const rid = await mkRec('2026-08-10'); ctx.R810 = rid
  const m = await sql(`select registo_id from movements where id='${a2.id}'`); eq(m[0].registo_id, rid, 'alloc ' + a2.id)
  eq((await sql(`select count(*)::int n from daily_record_costs where movimento_id='${a2.id}' and record_id='${rid}'`))[0].n, 1, 'linha de custo')
})
await t('A linha de custo e copia inicial: editar o movimento nao altera a linha; editar a linha nao altera o movimento', async () => {
  await must(admin.from('daily_record_costs').update({ valor: 61 }).eq('movimento_id', a1.id).select().single())
  eq(Number((await sql(`select valor from movements where id='${a1.id}'`))[0].valor), 60, 'movimento alterado pela linha ' + a1.id)
})
await t('Sobre-alocacao (60+30+50 > 100) nao e escondida: transferencia + alocacoes permitem calcular alocado vs recebido; UI mostra "over"', async () => {
  const a3 = await must(alloc({ valor: 50, data: '2026-08-11', descricao: 'QA-alloc-3' }).single()); ctx.a3 = a3.id
  const rows = await must(admin.from('movements').select('valor,tipo,deleted_at').eq('lancamento_referencia_id', T.id).is('deleted_at', null))
  const alocado = rows.reduce((s, x) => s + Number(x.valor), 0); eq(alocado, 140, 'alocado')
  const st = (await sql(`select estado, alocado::float a, diferenca::float d from fund_transfer_status where id='${T.id}'`))[0]
  eq([st.estado, st.a, st.d], ['over', 140, -40], 'fund_transfer_status da transferencia ' + T.id)
  const n = await sql(`select count(*)::int n from notifications where tipo='fund_over_allocated' and payload->>'movement_id'='${T.id}'`); ok(n[0].n >= 2, 'sem notificacao fund_over_allocated para ' + T.id)
})
await t('Validar alocacao: so Contabilista/Super Admin; reclassificar (rota) mantem a validacao; mudar valor tira-a', async () => {
  await denied(gest.from('movements').update({ estado: 'confirmado' }).eq('id', a1.id).select(), 'gestor valida')
  const v = await must(cont.from('movements').update({ estado: 'confirmado' }).eq('id', a1.id).select('estado,validado_por').single()); eq([v.estado, v.validado_por], ['confirmado', cont.uid], 'validar ' + a1.id)
  const r = await must(cont.from('movements').update({ rota_id: SEED_LN_ROUTE }).eq('id', a1.id).select('estado,validado_por').single()); eq([r.estado, r.validado_por], ['confirmado', cont.uid], 'reclassificar mantem ' + a1.id)
  const c = await must(cont.from('movements').update({ valor: 61 }).eq('id', a1.id).select('estado,validado_por').single()); eq([c.estado, c.validado_por], ['pendente', null], 'mudar valor tira validacao ' + a1.id)
})

setArea('Contabilidade - soft delete e imutabilidade')
await t('RECUSADO: DELETE fisico de movimento (Contabilista e Super Admin)', async () => { await denied(cont.from('movements').delete().eq('id', ctx.mManual).select(), 'cont delete'); await denied(admin.from('movements').delete().eq('id', ctx.mManual).select(), 'admin delete') })
await t('RECUSADO: Contabilista apaga (soft delete) movimento', async () => {
  const r = await cont.from('movements').update({ deleted_at: new Date().toISOString(), motivo_apagado: 'QA teste' }).eq('id', ctx.mManual).select('id')
  ok(r.error || !r.data?.length, `Contabilista apagou movimento ${ctx.mManual}`)
})
await t('RECUSADO: Super Admin apaga sem motivo; com motivo funciona', async () => {
  await denied(admin.from('movements').update({ deleted_at: new Date().toISOString() }).eq('id', ctx.mManual).select(), 'sem motivo')
  const r = await must(admin.from('movements').update({ deleted_at: new Date().toISOString(), motivo_apagado: 'QA limpeza' }).eq('id', ctx.mManual).select('id,deleted_at,motivo_apagado').single()); ok(r.deleted_at, 'nao apagou')
})
await t('Movimento apagado e imutavel (nem o Super Admin o altera/reativa)', async () => {
  await denied(admin.from('movements').update({ deleted_at: null }).eq('id', ctx.mManual).select(), 'reativar'); await denied(admin.from('movements').update({ valor: 99 }).eq('id', ctx.mManual).select(), 'editar apagado')
})
await t('Audit do soft delete do movimento: quem, quando, antes/depois', async () => {
  const a = await must(admin.from('audit_log').select('*').eq('tabela', 'movements').eq('registo_id', ctx.mManual).eq('acao', 'SOFT_DELETE').single())
  ok(a.user_id === admin.uid && a.em && a.antes.deleted_at === null && a.depois.deleted_at && a.depois.motivo_apagado === 'QA limpeza', 'audit ' + a.id)
})
await t('Movimento com valor <= 0 e recusado', async () => { await denied(manual(cont, { valor: 0 }), 'valor 0'); await denied(manual(cont, { valor: -5 }), 'valor negativo') })

writeFileSync(new URL('./ctx.json', import.meta.url), JSON.stringify(ctx, null, 2))
save('./results-04.json')
