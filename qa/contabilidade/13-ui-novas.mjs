// UI (Chrome headless) das funcionalidades novas: lote, Sem conta, motivo do Pendente, exportacao, confirmacao de religacao,
// detalhe de automatico/pedir correcao, sino, aviso de truncagem. Precisa de `npm run dev -- --port 5199`.
import puppeteer from 'puppeteer-core'
import ExcelJS from 'exceljs'
import { mkdirSync, readdirSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ctx, T, loginAll, users, t, setCaso, setArea, eq, ok, must, sql, mvIns, mv, mkRec, autos, dump, savectx, sleep } from './h.mjs'
import { applyFilters } from './acc.bundle.mjs'

const BASE = 'http://localhost:5199', CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const here = fileURLToPath(new URL('.', import.meta.url)).replace(/\\/g, '/').replace(/\/$/, '')
const DL = here + '/downloads'
mkdirSync(DL, { recursive: true }); mkdirSync(here + '/shots', { recursive: true })
const shot = (page, n) => page.screenshot({ path: `${here}/shots/${n}.png` })
await loginAll()
const { admin, cont, gest, audacc } = users
const ids = (ctx.c13 = ctx.c13 ?? {})
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] })
const errors = []

async function open(email, pw, url = '/contabilidade') {
  const bctx = await browser.createBrowserContext(); const page = await bctx.newPage()
  await page.setViewport({ width: 1366, height: 1000 })
  page.on('pageerror', (e) => errors.push(email + ' pageerror: ' + e.message))
  await page.goto(BASE, { waitUntil: 'networkidle2' })
  await page.waitForSelector('input[type=email]'); await page.type('input[type=email]', email); await page.type('input[type=password]', pw); await page.click('button[type=submit]')
  await page.waitForFunction(() => !document.querySelector('input[type=password]'), { timeout: 20000 })
  await page.goto(BASE + url, { waitUntil: 'networkidle2' })
  return { page, bctx }
}
const pill = (page, text) => page.evaluate((tx) => { const b = [...document.querySelectorAll('button[aria-pressed]')].find((x) => x.innerText.trim().startsWith(tx)); b?.click(); return Boolean(b) }, text)
const pillOn = (page, text) => page.evaluate((tx) => { const b = [...document.querySelectorAll('button[aria-pressed]')].find((x) => x.innerText.trim().startsWith(tx)); return b ? b.getAttribute('aria-pressed') === 'true' : null }, text)
const pillText = (page, prefix) => page.evaluate((tx) => [...document.querySelectorAll('button[aria-pressed]')].map((x) => x.innerText.trim()).find((x) => x.startsWith(tx)) ?? null, prefix)
const click = (page, sel) => page.evaluate((s) => { const e = document.querySelector(s); e?.click(); return Boolean(e) }, sel)
const cards = (page, scope = '[data-testid="movement-list"]') => page.evaluate((s) => [...document.querySelectorAll(`${s} [data-movement]`)].map((e) => e.getAttribute('data-movement')), scope)
const drag = (page, id, cell) => page.evaluate(async (i, c) => {
  const dt = new DataTransfer(); const card = document.querySelector(`[data-movement="${i}"]`); const target = document.querySelector(`[data-cell="${c}"]`)
  if (!card || !target) return { err: 'sem cartao/celula ' + !!card + '/' + !!target }
  const fire = (el, type) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }))
  fire(card, 'dragstart'); await new Promise((r) => setTimeout(r, 80)); fire(target, 'dragenter'); fire(target, 'dragover'); await new Promise((r) => setTimeout(r, 80))
  fire(target, 'drop'); fire(card, 'dragend'); return { ok: true }
}, id, cell)
const cellOf = (page, id) => page.evaluate((i) => document.querySelector(`[data-movement="${i}"]`)?.closest('[data-cell]')?.getAttribute('data-cell') ?? null, id)
const waitCell = (page, id, cell, to = 15000) => page.waitForFunction((i, c) => document.querySelector(`[data-movement="${i}"]`)?.closest('[data-cell]')?.getAttribute('data-cell') === c, { timeout: to }, id, cell)
const auditN = async (id) => (await sql(`select count(*)::int n from audit_log where tabela='movements' and registo_id='${id}'`))[0].n
const lines = (mid) => sql(`select record_id, valor::float v, deleted_at from daily_record_costs where movimento_id='${mid}' order by created_at, id`)
const dlgText = (page) => page.$eval('[role=dialog]', (e) => e.innerText.replace(/\u00a0/g, ' '))
const dbNoAcc = async () => (await sql(`select count(*)::int n from movements where tenant_id='${T}' and deleted_at is null and conta_id is null`))[0].n

// ---------- dados ----------
const M = process.env.QA_M ?? '2026-11' // mes das datas dos dados (muda-se por execucao: 1 registo por rota+data)
const D = `${M}-10`
const tr = await must(mvIns(cont, { subcategoria: 'transferencia_distribuicao', valor: 5000, pessoa_responsavel: 'QA-C-UI', data: D, conta_id: ctx.contaA, descricao: 'QA-C-u-tr' }).single())
const mkAl = async (k, o = {}) => (await must(mvIns(cont, { subcategoria: 'outro', valor: 20 + k, pessoa_responsavel: 'QA-C-UI', lancamento_referencia_id: tr.id, data: D, conta_id: ctx.contaA, operation_id: null, rota_id: null, descricao: 'QA-C-u-al' + k, ...o }).single())).id
const S = { al1: await mkAl(1), al2: await mkAl(2), al3: await mkAl(3) }
S.man = (await must(mvIns(cont, { valor: 7, data: D, conta_id: ctx.contaA, descricao: 'QA-C-u-man' }).single())).id
const rH = await mkRec(users.oper, ctx.R1, D, { comb_valor: 150, status: 'submetido' }); S.autoHi = (await autos(rH, 'combustivel'))[0].id
const rL = await mkRec(users.oper, ctx.R2, D, { comb_valor: 30, status: 'submetido' }); S.autoLo = (await autos(rL, 'combustivel'))[0].id
const r100 = await mkRec(users.oper, ctx.R1, `${M}-11`, { comb_valor: 100, status: 'submetido' }); S.auto100 = (await autos(r100, 'combustivel'))[0].id
ids.S = S; ids.recs = { rH, rL, r100 }

const C = await open('qa.contabilista@example.test', process.env.QA_PASSWORD); const cp = C.page
await cp.waitForSelector('[data-kpi="pending"]'); await pill(cp, 'Tudo'); await sleep(1500)

// =================== B2 lote ===================
setArea('B2 - acoes em lote'); setCaso('B2')
await t('B2 Lista (Contabilista): 1 checkbox por cartao; "Selecionar todos (N)" com N = cartoes da lista; sem selecao nao ha barra', async () => {
  const cs = await cards(cp); const n = await cp.$$eval('[data-testid="movement-list"] input[data-check]', (e) => e.length)
  eq(n, cs.length, 'checkboxes vs cartoes'); ok(await cp.$('input[data-check-all]'), 'sem check-all')
  const lbl = await cp.$eval('input[data-check-all]', (e) => e.closest('label').innerText.replace(/\u00a0/g, ' ')); eq(lbl.trim(), `Selecionar todos (${cs.length})`, 'rotulo')
  eq(await cp.$('[data-testid="batch-bar"]'), null, 'barra sem selecao')
  await click(cp, 'input[data-check-all]'); await sleep(300); const c1 = await cp.$eval('[data-batch-count]', (e) => e.getAttribute('data-batch-count')); eq(Number(c1), cs.length, 'selecionar todos'); await click(cp, 'input[data-check-all]'); await sleep(300)
  eq(await cp.$('[data-testid="batch-bar"]'), null, 'barra depois de desselecionar todos')
})
await t('B2 Validar em lote: 2 alocacoes + 1 automatico acima do limite + 1 manual Confirmado selecionados -> "Validar (3)" (so os pendentes); 1 clique valida os 3 com validado_por = Contabilista e 1 entrada de audit por movimento', async () => {
  const pend = [S.al1, S.al2, S.autoHi]; const sel = [...pend, S.man]; const a0 = await Promise.all(pend.map(auditN)); const manAudit = await auditN(S.man)
  for (const id of sel) await click(cp, `[data-movement="${id}"] input[data-check]`)
  await sleep(400); await cp.waitForSelector('[data-testid="batch-bar"]'); const txt = await cp.$eval('[data-testid="batch-bar"]', (e) => e.innerText.replace(/\u00a0/g, ' '))
  ok(/4 selecionados/.test(txt) && /Validar \(3\)/.test(txt) && /Atribuir conta/.test(txt) && /Limpar sele/.test(txt), 'barra: ' + txt.replace(/\n/g, ' | '))
  await shot(cp, 'lote-barra'); await click(cp, '[data-batch-validate]')
  await cp.waitForFunction(() => !document.querySelector('[data-testid="batch-bar"]'), { timeout: 15000 }); await sleep(500)
  const rows = await sql(`select id, estado, validado_por from movements where id in (${pend.map((x) => `'${x}'`).join(',')})`); eq(rows.map((r) => [r.estado, r.validado_por]), pend.map(() => ['confirmado', cont.uid]), 'movimentos ' + pend)
  const a1 = await Promise.all(pend.map(auditN)); eq(a1.map((n, i) => n - a0[i]), [1, 1, 1], 'entradas de audit por movimento ' + pend); eq(await auditN(S.man), manAudit, 'o manual Confirmado nao devia ser tocado')
  eq(await cp.$$eval('[data-check]:checked', (e) => e.length), 0, 'selecao limpa depois de validar')
})
await t('B2 Atribuir conta em lote: automatico sem conta + manual (ContaA) + alocacao (ContaA) -> QA-C-ContaB (1 PATCH, servidor decide; manuais/alocacoes nao podem ficar sem conta: movements_conta_check)', async () => {
  const sel = [S.autoLo, S.man, S.al3]; eq((await sql(`select count(*)::int n from movements where id in (${sel.map((x) => `'${x}'`).join(',')}) and conta_id is null`))[0].n, 1, 'precondicao: so o automatico esta sem conta')
  for (const id of sel) await click(cp, `[data-movement="${id}"] input[data-check]`); await sleep(300)
  const hasVal = await cp.$('[data-batch-validate]'); ok(hasVal, 'al3 pendente -> deve haver "Validar (1)"'); eq(await cp.$eval('[data-batch-validate]', (e) => e.innerText.trim()), 'Validar (1)', 'so 1 pendente')
  ok((await cp.$eval('[data-batch-assign]', (e) => e.disabled)), 'atribuir desativado sem conta escolhida')
  await cp.select('[data-batch-account]', ctx.contaB); await sleep(200); ok(!(await cp.$eval('[data-batch-assign]', (e) => e.disabled)), 'atribuir ativo')
  await click(cp, '[data-batch-assign]'); await cp.waitForFunction(() => !document.querySelector('[data-testid="batch-bar"]'), { timeout: 15000 }); await sleep(500)
  const rows = await sql(`select id, conta_id, estado from movements where id in (${sel.map((x) => `'${x}'`).join(',')})`); eq(rows.map((r) => r.conta_id), [ctx.contaB, ctx.contaB, ctx.contaB], 'contas ' + sel); eq(rows.find((r) => r.id === S.al3).estado, 'pendente', 'atribuir conta nao valida')
})
await t('B2 So Lista e "Por validar" tem selecao: Agrupado/Quadro/Distribuicoes/Contas/Definicoes sem checkboxes; a selecao limpa-se ao mudar de vista (e nao volta)', async () => {
  await click(cp, `[data-movement="${S.man}"] input[data-check]`); await click(cp, `[data-movement="${S.autoLo}"] input[data-check]`); await sleep(300); eq(await cp.$$eval('[data-check]:checked', (e) => e.length), 2, 'selecao inicial')
  await pill(cp, 'Por validar'); await sleep(500); eq([await cp.$$eval('[data-check]:checked', (e) => e.length), await cp.$('[data-testid="batch-bar"]')], [0, null], 'apos mudar para Por validar')
  ok(await cp.$('input[data-check-all]'), 'Por validar sem check-all'); const q = await cards(cp); const dbq = (await sql(`select count(*)::int n from movements where tenant_id='${T}' and deleted_at is null and estado='pendente'`))[0].n; eq(q.length, dbq, 'fila vs BD')
  eq(await cp.$eval('input[data-check-all]', (e) => e.closest('label').innerText.trim()), `Selecionar todos (${q.length})`, 'rotulo da fila')
  for (const v of ['Agrupado', 'Quadro', 'Distribuições', 'Contas', 'Definições']) { await pill(cp, v); await sleep(700); eq([v, await cp.$$eval('[data-check],[data-check-all]', (e) => e.length), await cp.$('[data-testid="batch-bar"]')], [v, 0, null], 'vista ' + v) }
  await pill(cp, 'Lista'); await sleep(500); eq(await cp.$$eval('[data-check]:checked', (e) => e.length), 0, 'selecao nao voltou')
})
await t('B2 Auditor com accounting_read: sem checkboxes nem barra (Lista e Por validar), sem "Novo movimento"', async () => {
  const A = await open('qa.auditor.acc@example.test', process.env.QA_PASSWORD); const ap = A.page; await ap.waitForSelector('[data-kpi="pending"]'); await pill(ap, 'Tudo'); await sleep(1200)
  for (const v of ['Lista', 'Por validar']) { await pill(ap, v); await sleep(700); ok((await cards(ap)).length > 0, 'sem cartoes em ' + v); eq([v, await ap.$$eval('[data-check],[data-check-all]', (e) => e.length), await ap.$('[data-testid="batch-bar"]')], [v, 0, null], 'auditor ' + v) }
  await A.bctx.close()
})

// =================== Sem conta ===================
setArea('Filtro Sem conta'); setCaso('B3')
await t('B3 Pill "Sem conta (N)" (N = ativos sem conta, so aparece se N>0) na Lista, Agrupado e Quadro; filtra so os sem conta', async () => {
  const n = await dbNoAcc(); ok(n > 0, 'precondicao: existem movimentos sem conta (automaticos do seed)')
  for (const v of ['Lista', 'Agrupado', 'Quadro']) { await pill(cp, v); await sleep(600); if (v === 'Quadro') await pill(cp, 'Tudo'); eq([v, await pillText(cp, 'Sem conta')], [v, `Sem conta (${n})`], 'pill em ' + v) }
  await pill(cp, 'Lista'); await pill(cp, 'Sem conta'); await sleep(700)
  const shown = await cards(cp); const dbIds = (await sql(`select id from movements where tenant_id='${T}' and deleted_at is null and conta_id is null`)).map((r) => r.id)
  eq(shown.slice().sort(), dbIds.sort(), 'Lista com filtro Sem conta vs BD (periodo Tudo)'); ok(await pillOn(cp, 'Sem conta'), 'pill ativa')
  const all = await must(cont.from('movements').select('*').is('deleted_at', null)); eq(applyFilters(all, { period: 'all', account: 'none', origin: 'all', category: 'all' }, '2026-09-20').length, dbIds.length, 'applyFilters(account:none) (funcao real do cliente)')
  await pill(cp, 'Todas as contas'); await sleep(300)
})
await t('B3 Painel Contas: a linha "Sem conta" e clicavel ([data-no-account]) e leva a Lista com o filtro Sem conta e periodo Tudo', async () => {
  await pill(cp, 'Contas'); await sleep(600); ok(await cp.$('[data-no-account]'), 'linha Sem conta nao clicavel'); await click(cp, '[data-no-account]'); await sleep(900)
  eq([await pillOn(cp, 'Sem conta'), await pillOn(cp, 'Tudo'), (await cards(cp)).length], [true, true, await dbNoAcc()], 'apos clicar: pill Sem conta / periodo Tudo / cartoes')
  await pill(cp, 'Todas as contas')
})
await t('B3 Pill "Sem conta" NAO aparece quando N=0 (Super Admin do tenant B, que so tem 1 movimento com conta)', async () => {
  const B = await open('qa.tenantb@example.test', process.env.QA_PASSWORD); const bp = B.page; await bp.waitForSelector('[data-kpi="pending"]'); await pill(bp, 'Tudo'); await sleep(1000)
  const r = await bp.evaluate(() => ({ p: [...document.querySelectorAll('button[aria-pressed]')].map((b) => b.innerText.trim()).filter((x) => x.startsWith('Sem conta')), cards: document.querySelectorAll('[data-movement]').length }))
  const nb = (await sql(`select count(*)::int n from movements where tenant_id=(select tenant_id from profiles where email='qa.tenantb@example.test') and deleted_at is null and conta_id is null`))[0].n
  await B.bctx.close(); eq([r.p.length, nb], [0, 0], 'pills sem conta no tenant B ' + JSON.stringify(r))
})

// =================== motivo do Pendente ===================
setArea('Motivo do Pendente'); setCaso('B4')
await t('B4 Cartao Pendente mostra o motivo: alocacao = alloc, automatico > limite = aboveLimit, revertido (manual e automatico <= limite, mesmo exatamente 100) = reverted; Confirmado sem motivo; detalhe tambem', async () => {
  await must(cont.from('movements').update({ estado: 'pendente' }).eq('id', S.man).select()); await must(cont.from('movements').update({ estado: 'pendente' }).eq('id', S.auto100).select())
  const newAl = await mkAl(9); const newHi = (await autos(await mkRec(users.oper, ctx.R2, `${M}-12`, { comb_valor: 100.01, status: 'submetido' }), 'combustivel'))[0].id
  await cp.reload({ waitUntil: 'networkidle2' }); await cp.waitForSelector('[data-kpi="pending"]'); await pill(cp, 'Tudo'); await sleep(1200); await pill(cp, 'Por validar'); await sleep(700)
  const reasonOf = (id) => cp.evaluate((i) => { const c = document.querySelector(`[data-movement="${i}"]`); return { r: c?.querySelector('[data-reason]')?.getAttribute('data-reason') ?? null, tx: c?.querySelector('[data-reason]')?.innerText ?? '' } }, id)
  const got = { al: await reasonOf(newAl), hi: await reasonOf(newHi), man: await reasonOf(S.man), a100: await reasonOf(S.auto100) }
  eq([got.al.r, got.hi.r, got.man.r, got.a100.r], ['alloc', 'aboveLimit', 'reverted', 'autoBelow'], 'motivos (3.a ronda: automatico pendente <= limite = autoBelow) ' + JSON.stringify({ al: newAl, hi: newHi, man: S.man, a100: S.auto100 }))
  ok(/Aloca/.test(got.al.tx) && /100/.test(got.hi.tx) && /Revertido/.test(got.man.tx) && /limite alterado ou revertido/.test(got.a100.tx), 'textos: ' + JSON.stringify(got))
  await pill(cp, 'Lista'); await sleep(400); eq(await cp.evaluate((i) => document.querySelector(`[data-movement="${i}"] [data-reason]`) !== null, S.al1), false, 'Confirmado nao tem motivo (' + S.al1 + ')')
  await pill(cp, 'Por validar'); await sleep(400); await cp.click(`[data-movement="${newAl}"]`); await cp.waitForSelector('[role=dialog]'); await sleep(500)
  eq(await cp.$eval('[role=dialog] [data-reason]', (e) => e.getAttribute('data-reason')), 'alloc', 'detalhe ' + newAl); await cp.keyboard.press('Escape'); await sleep(300)
  await pill(cp, 'Quadro'); await pill(cp, 'Tudo'); await sleep(900); eq(await cp.$$eval('[data-testid="board"] [data-reason]', (e) => e.length), 0, 'cartoes compactos do Quadro nao mostram o motivo')
  ids.b4 = { newAl, newHi }
})

// =================== detalhe: registo de origem + pedir correcao ===================
setArea('Detalhe do automatico'); setCaso('B7')
await t('B7 Detalhe de automatico: "Registo de origem: <rota> · <data>" e "Pedir correcao ao Gestor"; enviar -> "Pedido enviado"; 2.o pedido no mesmo dia -> "ja foi pedido hoje"; alocacao ligada: "Registo diario ligado"; manual/automatico Geral sem botao; Auditor sem botao', async () => {
  await pill(cp, 'Lista'); await sleep(500); await cp.click(`[data-movement="${S.autoLo}"]`); await cp.waitForSelector('[role=dialog]'); await sleep(600)
  const tx = await dlgText(cp); ok(/Registo de origem/.test(tx) && /QA-C-R2/.test(tx) && new RegExp(`10\/${M.slice(5)}\/${M.slice(0, 4)}`).test(tx), 'texto: ' + tx.slice(0, 400))
  ok(await cp.$('[data-request-correction]'), 'sem botao de pedido'); await cp.evaluate(() => [...document.querySelectorAll('[data-request-correction] button')].find((b) => /Pedir corre/.test(b.innerText)).click()); await sleep(300)
  await cp.type('[data-request-correction] input', 'QA-C nota UI'); await cp.evaluate(() => [...document.querySelectorAll('[data-request-correction] button')].find((b) => /Enviar pedido/.test(b.innerText)).click())
  await cp.waitForSelector('[data-request-result]', { timeout: 10000 }); const r1 = await cp.$eval('[data-request-result]', (e) => [e.getAttribute('data-request-result'), e.innerText]); ok(Number(r1[0]) > 0 && /Pedido enviado/.test(r1[1]), 'resultado 1: ' + r1)
  const nots = await sql(`select count(*)::int n from notifications where tipo='auto_cost_disputed' and payload->>'movement_id'='${S.autoLo}' and payload->>'note'='QA-C nota UI'`); ok(nots[0].n > 0, 'sem notificacao com a nota')
  await cp.evaluate(() => [...document.querySelectorAll('[data-request-correction] button')].find((b) => /Pedir corre/.test(b.innerText)).click()); await sleep(300)
  await cp.evaluate(() => [...document.querySelectorAll('[data-request-correction] button')].find((b) => /Enviar pedido/.test(b.innerText)).click()); await sleep(1500)
  const r2 = await cp.$eval('[data-request-result]', (e) => [e.getAttribute('data-request-result'), e.innerText]); ok(r2[0] === '0' && /j[áa] foi pedida hoje/.test(r2[1]), 'resultado 2: ' + r2)
  await shot(cp, 'detalhe-automatico'); await cp.keyboard.press('Escape'); await sleep(300)
  await cp.click(`[data-movement="${S.man}"]`); await cp.waitForSelector('[role=dialog]'); await sleep(400); eq(await cp.$('[data-request-correction]'), null, 'manual nao tem pedir correcao'); await cp.keyboard.press('Escape'); await sleep(300)
  await cp.click(`[data-movement="${S.al1}"]`); await cp.waitForSelector('[role=dialog]'); await sleep(400); eq(await cp.$('[data-request-correction]'), null, 'alocacao nao tem pedir correcao'); await cp.keyboard.press('Escape'); await sleep(300)
  const A = await open('qa.auditor.acc@example.test', process.env.QA_PASSWORD); const ap = A.page; await ap.waitForSelector('[data-kpi="pending"]'); await pill(ap, 'Tudo'); await sleep(1200)
  await ap.waitForSelector(`[data-movement="${S.autoLo}"]`); await ap.click(`[data-movement="${S.autoLo}"]`); await ap.waitForSelector('[role=dialog]'); await sleep(500); const atx = await dlgText(ap); eq(await ap.$('[data-request-correction]'), null, 'auditor sem pedir correcao'); ok(/Registo de origem/.test(atx), 'auditor ve o registo de origem'); await A.bctx.close()
})
await t('B7 (achado a verificar) automatico RECLASSIFICADO para outra rota: o detalhe continua a dizer o registo de ORIGEM (rota do registo), nao a rota reclassificada', async () => {
  const r = await mkRec(users.oper, ctx.R1, `${M}-13`, { comb_valor: 30, status: 'submetido' }); const a = (await autos(r, 'combustivel'))[0].id
  await must(cont.from('movements').update({ rota_id: ctx.R2 }).eq('id', a).select()); await cp.reload({ waitUntil: 'networkidle2' }); await cp.waitForSelector('[data-kpi="pending"]'); await pill(cp, 'Tudo'); await sleep(1200)
  await cp.click(`[data-movement="${a}"]`); await cp.waitForSelector('[role=dialog]'); await sleep(600); const dd = await cp.evaluate(() => document.querySelector('[role=dialog] [data-record-link]')?.innerText ?? null); await cp.keyboard.press('Escape'); await sleep(300)
  ok(dd && dd.includes('QA-C-R1'), `automatico ${a} (registo ${r}, rota de origem QA-C-R1) reclassificado para QA-C-R2: o detalhe mostra "Registo de origem: ${dd}" (rota reclassificada, nao a do registo)`)
})
await t('B7 Detalhe de alocacao ligada mostra "Registo diario ligado"', async () => {
  const D2 = `${M}-14`; const rr = await mkRec(users.oper, ctx.R1, D2); const al = (await must(mvIns(cont, { subcategoria: 'outro', valor: 15, pessoa_responsavel: 'QA-C-UI', lancamento_referencia_id: tr.id, data: D2, operation_id: ctx.opLN, rota_id: ctx.R1, descricao: 'QA-C-u-linked' }).single())).id
  eq((await mv(al)).registo_id, rr, 'ligada ' + al); await cp.reload({ waitUntil: 'networkidle2' }); await cp.waitForSelector('[data-kpi="pending"]'); await pill(cp, 'Tudo'); await sleep(1200)
  await cp.click(`[data-movement="${al}"]`); await cp.waitForSelector('[role=dialog]'); await sleep(500); const tx = await dlgText(cp); await cp.keyboard.press('Escape'); await sleep(300)
  ok(/Registo di[áa]rio ligado/.test(tx) && /QA-C-R1/.test(tx), 'texto: ' + tx.replace(/\n/g, ' | ').slice(0, 300)); ids.linkedAl = al
})

// =================== relink confirm ===================
setArea('Confirmacao de religacao'); setCaso('B6')
const DR = `${M}-20`; const rec1 = await mkRec(users.oper, ctx.R1, DR), rec2 = await mkRec(users.oper, ctx.R2, DR)
const mkProp = async (k, o = {}) => (await must(mvIns(cont, { subcategoria: 'outro', valor: 40 + k, pessoa_responsavel: 'QA-C-UI', lancamento_referencia_id: tr.id, data: DR, operation_id: ctx.opLN, rota_id: ctx.R1, descricao: 'QA-C-u-rl' + k, ...o }).single())).id
const P = { cancel: await mkProp(1), confirm: await mkProp(2), colonly: await mkProp(3), unlinked: await mkProp(4, { data: `${M}-21` }), sheet: await mkProp(5), form: await mkProp(6) }
ids.P = P; for (const k of ['cancel', 'confirm', 'colonly', 'sheet', 'form']) eq((await mv(P[k])).registo_id, rec1, 'propagada ' + k)
eq((await mv(P.unlinked)).registo_id, null, 'por ligar')
await cp.goto(BASE + '/contabilidade?view=board', { waitUntil: 'networkidle2' }); await cp.waitForSelector('[data-testid="board"]'); await pill(cp, 'Tudo'); await sleep(1500)
await t('B6 Quadro: arrastar alocacao PROPAGADA para outra rota pede confirmacao; Cancelar -> cartao volta ao sitio, sem mensagem de erro, BD e linha de custo inalteradas', async () => {
  eq(await cellOf(cp, P.cancel), `${ctx.R1}|pendente`, 'inicio'); const a0 = await auditN(P.cancel)
  ok((await drag(cp, P.cancel, `${ctx.R2}|pendente`)).ok, 'drag'); await cp.waitForSelector('[data-testid="relink-confirm"]', { timeout: 8000 }); await shot(cp, 'relink-confirm')
  const tx = await cp.$eval('[data-testid="relink-confirm"]', (e) => e.innerText.replace(/\u00a0/g, ' ')); ok(/QA-C-R1/.test(tx) && /Mudar e religar/.test(tx) && /Cancelar/.test(tx), 'texto: ' + tx.slice(0, 250))
  await click(cp, '[data-relink-cancel]'); await sleep(1500)
  eq(await cellOf(cp, P.cancel), `${ctx.R1}|pendente`, 'cartao nao voltou'); const err = await cp.$eval('[data-testid="board"]', (e) => e.innerText); ok(!/N[ãa]o foi poss[ií]vel mover/.test(err), 'mensagem de erro apos cancelar')
  const m = await mv(P.cancel); const ls = await lines(P.cancel); eq([m.registo_id, m.rota_id, ls.length, ls[0].deleted_at, await auditN(P.cancel)], [rec1, ctx.R1, 1, null, a0], 'BD inalterada ' + P.cancel)
  eq(await cp.$('[data-testid="relink-confirm"]'), null, 'dialogo fechado')
})
await t('B6 Quadro: Confirmar aplica as consequencias (linha antiga apagada, liga ao registo da nova rota+data); o cartao fica na nova linha', async () => {
  ok((await drag(cp, P.confirm, `${ctx.R2}|pendente`)).ok, 'drag'); await cp.waitForSelector('[data-testid="relink-confirm"]', { timeout: 8000 }); await click(cp, '[data-relink-confirm]'); await waitCell(cp, P.confirm, `${ctx.R2}|pendente`); await sleep(600)
  const m = await mv(P.confirm); const ls = await lines(P.confirm); eq([m.registo_id, m.rota_id, ls.length, !!ls[0].deleted_at, ls[1].record_id, ls[1].deleted_at], [rec2, ctx.R2, 2, true, rec2, null], 'movimento ' + P.confirm)
})
await t('B6 Mover so de COLUNA (estado) uma alocacao propagada, ou mover uma alocacao "por ligar" para outra rota, NAO pede confirmacao', async () => {
  ok((await drag(cp, P.colonly, `${ctx.R1}|confirmado`)).ok, 'drag col'); await sleep(1200); eq(await cp.$('[data-testid="relink-confirm"]'), null, 'pediu confirmacao ao mudar so de coluna'); await waitCell(cp, P.colonly, `${ctx.R1}|confirmado`); eq((await mv(P.colonly)).registo_id, rec1, 'mantem-se ligada')
  ok((await drag(cp, P.unlinked, `${ctx.R2}|pendente`)).ok, 'drag unlinked'); await sleep(1200); eq(await cp.$('[data-testid="relink-confirm"]'), null, 'pediu confirmacao a uma alocacao por ligar'); await waitCell(cp, P.unlinked, `${ctx.R2}|pendente`)
})
await t('B6 Bottom sheet "Mover..." (Detalhe) e Editar (data/rota) tambem pedem confirmacao numa propagada; cancelar nao muda nada; confirmar aplica', async () => {
  await cp.goto(BASE + '/contabilidade', { waitUntil: 'networkidle2' }); await cp.waitForSelector('[data-kpi="pending"]'); await pill(cp, 'Tudo'); await sleep(1200)
  // --- Mover... ---
  await cp.click(`[data-movement="${P.sheet}"]`); await cp.waitForSelector('[role=dialog]'); await sleep(400)
  await cp.evaluate(() => [...document.querySelectorAll('[role=dialog] button')].find((b) => /^Mover/.test(b.innerText.trim())).click()); await sleep(500)
  const sels = await cp.$$('[role=dialog] select'); ok(sels.length >= 2, 'selects do sheet ' + sels.length); await sels[1].select(ctx.R2)
  await cp.evaluate(() => [...document.querySelectorAll('[role=dialog] button')].find((b) => b.innerText.trim() === 'Aplicar').click()); await cp.waitForSelector('[data-testid="relink-confirm"]', { timeout: 8000 })
  await click(cp, '[data-relink-cancel]'); await sleep(1200); const m0 = await mv(P.sheet); eq([m0.registo_id, m0.rota_id], [rec1, ctx.R1], 'cancelar no sheet ' + P.sheet)
  await cp.goto(BASE + '/contabilidade', { waitUntil: 'networkidle2' }); await cp.waitForSelector('[data-kpi="pending"]'); await pill(cp, 'Tudo'); await sleep(1500)
  await cp.click(`[data-movement="${P.sheet}"]`); await cp.waitForSelector('[role=dialog]'); await sleep(400); await cp.evaluate(() => [...document.querySelectorAll('[role=dialog] button')].find((b) => /^Mover/.test(b.innerText.trim())).click()); await sleep(500)
  const sels2 = await cp.$$('[role=dialog] select'); await sels2[1].select(ctx.R2); await cp.evaluate(() => [...document.querySelectorAll('[role=dialog] button')].find((b) => b.innerText.trim() === 'Aplicar').click()); await cp.waitForSelector('[data-testid="relink-confirm"]'); await click(cp, '[data-relink-confirm]'); await sleep(1500)
  const m1 = await mv(P.sheet); eq([m1.registo_id, m1.rota_id], [rec2, ctx.R2], 'confirmar no sheet ' + P.sheet)
  // --- Editar (data) ---
  await cp.goto(BASE + '/contabilidade', { waitUntil: 'networkidle2' }); await cp.waitForSelector('[data-kpi="pending"]'); await pill(cp, 'Tudo'); await sleep(1500)
  await shot(cp, 'b6-antes-editar'); await cp.click(`[data-movement="${P.form}"]`); await cp.waitForSelector('[role=dialog]'); await sleep(400)
  await cp.evaluate(() => [...document.querySelectorAll('[role=dialog] button')].find((b) => b.innerText.trim() === 'Editar').click()); await cp.waitForSelector('[role=dialog] input[type=date]'); await sleep(300)
  const setDate = (v) => cp.$eval('[role=dialog] input[type=date]', (el, val) => { const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(el, val); el.dispatchEvent(new Event('input', { bubbles: true })) }, v)
  await setDate(`${M}-22`); await cp.evaluate(() => [...document.querySelectorAll('[role=dialog] button[type=submit]')][0].click()); await cp.waitForSelector('[data-testid="relink-confirm"]', { timeout: 8000 })
  await click(cp, '[data-relink-cancel]'); await sleep(1200); const f0 = await mv(P.form); eq([f0.registo_id, f0.data], [rec1, DR], 'cancelar no formulario ' + P.form)
  await cp.evaluate(() => [...document.querySelectorAll('[role=dialog] button[type=submit]')][0].click()); await cp.waitForSelector('[data-testid="relink-confirm"]', { timeout: 8000 }); await click(cp, '[data-relink-confirm]'); await sleep(2000)
  const f1 = await mv(P.form); eq([f1.registo_id, f1.data.toString().slice(0, 10)], [null, `${M}-22`], 'confirmar no formulario ' + P.form)
  eq((await lines(P.form)).filter((l) => !l.deleted_at).length, 0, 'linha antiga apagada')
})
await t('B6 Editar so valor/descricao de uma propagada NAO pede confirmacao e nao mexe na linha', async () => {
  const id = await mkProp(7); eq((await mv(id)).registo_id, rec1, 'propagada'); await cp.reload({ waitUntil: 'networkidle2' }); await cp.waitForSelector('[data-kpi="pending"]'); await pill(cp, 'Tudo'); await sleep(1200)
  await cp.click(`[data-movement="${id}"]`); await cp.waitForSelector('[role=dialog]'); await sleep(400); await cp.evaluate(() => [...document.querySelectorAll('[role=dialog] button')].find((b) => b.innerText.trim() === 'Editar').click()); await cp.waitForSelector('[role=dialog] input[type=date]'); await sleep(300)
  const l0 = await lines(id); await cp.evaluate(() => { const inputs = [...document.querySelectorAll('[role=dialog] input')].filter((i) => i.type === 'text' || i.type === 'number' || i.inputMode === 'decimal'); const desc = inputs[inputs.length - 1]; const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(desc, 'QA-C-u-rl7-editada'); desc.dispatchEvent(new Event('input', { bubbles: true })) })
  await cp.evaluate(() => [...document.querySelectorAll('[role=dialog] button[type=submit]')][0].click()); await sleep(1800)
  eq(await cp.$('[data-testid="relink-confirm"]'), null, 'pediu confirmacao'); const m = await mv(id); eq([m.descricao, m.registo_id], ['QA-C-u-rl7-editada', rec1], 'descricao editada ' + id); eq(await lines(id), l0, 'linha inalterada')
})

// =================== exportacao ===================
setArea('Exportacao'); setCaso('B5')
const bctxC = C.bctx; const cdp = await browser.target().createCDPSession(); await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL.replace(/\//g, '\\'), browserContextId: bctxC.id })
async function exportNow(page) {
  for (const f of readdirSync(DL)) rmSync(DL + '/' + f)
  const okc = await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find((x) => /Exportar Excel/.test(x.innerText)); if (!b || b.disabled) return false; b.click(); return true }); if (!okc) return null
  for (let i = 0; i < 40; i++) { await sleep(500); const f = readdirSync(DL).find((x) => x.endsWith('.xlsx')); if (f) { await sleep(500); const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(DL + '/' + f); const ws = wb.worksheets[0]; const rows = []; ws.eachRow((r) => rows.push(r.values.slice(1))); return { file: f, header: rows[0], n: rows.length - 1, rows: rows.slice(1) } } }
  return { err: 'sem ficheiro' }
}
await cp.goto(BASE + '/contabilidade', { waitUntil: 'networkidle2' }); await cp.waitForSelector('[data-kpi="pending"]'); await sleep(800)
const today = (await sql('select app.today()::text d'))[0].d
const HDR = ['Data', 'Conta', 'Tipo', 'Valor', 'Categoria/Origem', 'Rota', 'Estado', 'Origem', 'Descrição', 'Pessoa responsável', 'Subcategoria']
await t('B5 Exportar (Lista, periodo Tudo): ficheiro Contabilidade_<hoje>.xlsx, 11 colunas (8 exigidas + Descricao, Pessoa responsavel, Subcategoria), tantas linhas como cartoes da Lista; valores conferem com a BD', async () => {
  await pill(cp, 'Lista'); await pill(cp, 'Tudo'); await sleep(800); const shown = await cards(cp); const x = await exportNow(cp); ok(x && !x.err, 'sem ficheiro: ' + JSON.stringify(x))
  eq(x.file, `Contabilidade_${today}.xlsx`, 'nome do ficheiro'); eq(x.header.map((h) => (h === 'Valor (€)' ? 'Valor' : h)), HDR, 'cabecalhos ("Valor (€)" conta como Valor)'); eq(x.n, shown.length, 'linhas do ficheiro vs cartoes da Lista')
  const one = await mv(S.al1); const row = x.rows.find((r) => r[8] === 'QA-C-u-al1'); ok(row, 'linha da alocacao ' + S.al1)
  eq([Math.abs(Number(row[3])), Number(row[3]) < 0, row[9], row[6], row[7]], [Number(one.valor), true, 'QA-C-UI', 'Confirmado', 'Manual'], 'valores da linha ' + S.al1 + ' ' + JSON.stringify(row))
  const au = x.rows.find((r) => String(r[8] ?? '') === '' && r[7] === 'Automático'); ok(au, 'linha de automatico'); ids.b5 = { total: x.n }
})
await t('B5 Exportar segue a vista: Lista filtrada (Sem conta / Este mes) = so o filtrado; Agrupado = igual; "Por validar" = so a fila; Contas = todos; Definicoes = botao desativado', async () => {
  await pill(cp, 'Lista'); await pill(cp, 'Sem conta'); await sleep(700); const s1 = await cards(cp); const x1 = await exportNow(cp); eq(x1.n, s1.length, 'Lista Sem conta'); ok(x1.rows.every((r) => r[1] === 'Sem conta'), 'linhas sem a conta "Sem conta"')
  await pill(cp, 'Todas as contas'); await pill(cp, 'Este mês'); await sleep(700); const s2 = await cards(cp); const x2 = await exportNow(cp); eq(x2.n, s2.length, 'Lista Este mes')
  await pill(cp, 'Agrupado'); await sleep(700); const s3 = await cards(cp, '[data-testid="grouped-view"]'); const x3 = await exportNow(cp); eq(x3.n, s3.length, 'Agrupado (filtrado)')
  await pill(cp, 'Por validar'); await sleep(700); const s4 = await cards(cp); const x4 = await exportNow(cp); eq([x4.n, x4.rows.every((r) => r[6] === 'Pendente')], [s4.length, true], 'Por validar = so a fila')
  await pill(cp, 'Contas'); await sleep(500); const all = (await sql(`select count(*)::int n from movements where tenant_id='${T}' and deleted_at is null`))[0].n; const x5 = await exportNow(cp); eq(x5.n, all, 'Contas = todos os movimentos ativos')
  await pill(cp, 'Definições'); await sleep(500); eq(await exportNow(cp), null, 'botao devia estar desativado em Definicoes')
})
await t('B5 Exportar em Distribuicoes = "o que a vista mostra" (transferencias + alocacoes sem transferencia ativa)', async () => {
  await pill(cp, 'Distribuições'); await sleep(800)
  const trs = await cp.$$eval('[data-alloc-state]', (e) => e.length); const orph = await cp.$$eval('[data-orphans] [data-movement]', (e) => e.length); const x = await exportNow(cp)
  const all = (await sql(`select count(*)::int n from movements where tenant_id='${T}' and deleted_at is null`))[0].n
  if (false) throw new Error(`Distribuicoes mostra ${trs} transferencias + ${orph} alocacoes orfas, mas o ficheiro exportado tem ${x.n} linhas (= TODOS os ${all} movimentos ativos; o codigo usa exportList=scoped)`)
  const expD = (await sql(`select count(*)::int n from movements m where tenant_id='${T}' and deleted_at is null and ((subcategoria='transferencia_distribuicao' and lancamento_referencia_id is null) or (lancamento_referencia_id is not null and (not exists (select 1 from movements p where p.id=m.lancamento_referencia_id and p.deleted_at is null) or exists (select 1 from movements p where p.id=m.lancamento_referencia_id and p.deleted_at is null and p.subcategoria='transferencia_distribuicao' and p.lancamento_referencia_id is null))))`))[0].n; eq(x.n, expD, '3.a ronda: Distribuicoes exporta transferencias + as suas alocacoes + alocacoes sem transferencia ativa (' + trs + ' transferencias visiveis, ' + orph + ' orfas)')
})

// =================== sino ===================
setArea('Sino'); setCaso('B7-sino')
await t('B7 Sino: allocation_unlinked leva o Gestor a /registar?rota=..&data=.. e o Contabilista as Distribuicoes; auto_cost_disputed leva o Gestor a /registar?rota=..&data=..', async () => {
  const d5 = (await sql(`select (app.today() - g)::text d from generate_series(10, 60) g where not exists (select 1 from daily_records where route_id='${ctx.R2}' and data = app.today() - g) order by g limit 1`))[0].d; // data (>=10 dias) sem registo em R2 await sql('select app.run_alerts(false)') // despeja o backlog de alertas (senao empatam em created_at e ficam fora das 40 do sino)
  const trU = await must(mvIns(cont, { subcategoria: 'transferencia_distribuicao', valor: 500, pessoa_responsavel: 'QA-C-Sino', data: d5, descricao: 'QA-C-u-sino-tr' }).single())
  const al = (await must(mvIns(cont, { subcategoria: 'outro', valor: 12, pessoa_responsavel: 'QA-C-Sino', lancamento_referencia_id: trU.id, data: d5, operation_id: ctx.opLN, rota_id: ctx.R2, descricao: 'QA-C-u-sino-al' }).single())).id
  await sql('select app.run_alerts(false)')
  const rr = await mkRec(users.oper, ctx.R1, `${M}-15`, { comb_valor: 30, status: 'submetido' }); const au = (await autos(rr, 'combustivel'))[0].id; const rq = await cont.rpc('request_cost_correction', { p_movement: au, p_note: 'QA-C sino' }); ok(!rq.error && rq.data > 0, 'rpc ' + rq.error?.message)
  const G = await open('qa.gestor@example.test', process.env.QA_PASSWORD, '/'); const gp = G.page; await sleep(2500)
  const bell = async (p, re) => { await p.evaluate(() => document.querySelector('button[aria-label="Notificações"]').click()); await sleep(800); const clicked = await p.evaluate((src) => { const b = [...document.querySelectorAll('[role=dialog] li button')].find((x) => new RegExp(src).test(x.innerText)); if (b) b.click(); return b ? b.innerText.replace(/\n/g, ' ') : null }, re); await sleep(1500); return clicked }
  const c1 = await bell(gp, 'Correção pedida'); ok(c1, 'gestor sem notificacao "Correcao pedida"'); eq(await gp.evaluate(() => location.pathname + location.search), `/registar?rota=${ctx.R1}&data=${M}-15`, 'destino de auto_cost_disputed (' + c1 + ')')
  const c2 = await bell(gp, `Alocação por ligar: 12 € para QA-C-R2 \\(${d5}\\)`); ok(c2, 'gestor sem notificacao "Alocacao por ligar"'); eq(await gp.evaluate(() => location.pathname + location.search), `/registar?rota=${ctx.R2}&data=${d5}`, 'destino de allocation_unlinked (' + c2 + ')')
  await G.bctx.close()
  await cp.goto(BASE + '/contabilidade', { waitUntil: 'networkidle2' }); await cp.waitForSelector('[data-kpi="pending"]'); await sleep(1500)
  const c3 = await bell(cp, `Alocação por ligar: 12 € para QA-C-R2 \\(${d5}\\)`); ok(c3, 'contabilista sem notificacao'); eq(await cp.evaluate(() => location.pathname + location.search), '/contabilidade?view=unlinked', 'destino do Contabilista (3.a ronda: allocation_unlinked -> Por ligar)'); await sleep(500)
  ok(await cp.$('[data-testid="unlinked-view"]'), 'abre a vista Por ligar')
})

await C.bctx.close()
await browser.close()
if (errors.length) console.log('\nERROS DE PAGINA:', [...new Set(errors)])
savectx(); dump('results-13.json')
