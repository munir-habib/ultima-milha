// UI (Chrome headless) das correcoes da 3.a ronda: vista Por ligar, Sem registo previsto (lote + detalhe), confirmacao de
// religacao a registo Validado, sino (?view=validate&mov=), filtros que limpam a selecao, Sem conta forca Tudo, exportacoes.
// Precisa de `npm run dev -- --port 5199`.
import puppeteer from 'puppeteer-core'
import ExcelJS from 'exceljs'
import { mkdirSync, readdirSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ctx, T, loginAll, users, t, setCaso, setArea, eq, ok, must, sql, mvIns, mv, mkRec, dump, savectx, sleep } from './h.mjs'

const BASE = 'http://localhost:5199', CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const here = fileURLToPath(new URL('.', import.meta.url)).replace(/\\/g, '/').replace(/\/$/, '')
const DL = here + '/downloads'; mkdirSync(DL, { recursive: true }); mkdirSync(here + '/shots', { recursive: true })
await loginAll()
const { admin, cont, gest, oper } = users
const ids = (ctx.c22 = ctx.c22 ?? {})
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] })
async function open(email, pw = process.env.QA_PASSWORD, url = '/contabilidade') {
  const bctx = await browser.createBrowserContext(); const page = await bctx.newPage(); await page.setViewport({ width: 1366, height: 1000 })
  await page.goto(BASE, { waitUntil: 'networkidle2' }); await page.waitForSelector('input[type=email]'); await page.type('input[type=email]', email); await page.type('input[type=password]', pw); await page.click('button[type=submit]')
  await page.waitForFunction(() => !document.querySelector('input[type=password]'), { timeout: 20000 })
  await page.goto(BASE + url, { waitUntil: 'networkidle2' }); return { page, bctx }
}
const pill = (page, text) => page.evaluate((tx) => { const b = [...document.querySelectorAll('button[aria-pressed]')].find((x) => x.innerText.trim().startsWith(tx)); b?.click(); return Boolean(b) }, text)
const pillText = (page, prefix) => page.evaluate((tx) => [...document.querySelectorAll('button[aria-pressed]')].map((x) => x.innerText.trim()).find((x) => x.startsWith(tx)) ?? null, prefix)
const pressed = (page) => page.evaluate(() => [...document.querySelectorAll('button[aria-pressed="true"]')].map((b) => b.innerText.trim().replace(/ \(\d+\)$/, '')))
const click = (page, sel) => page.evaluate((s) => { const e = document.querySelector(s); e?.click(); return Boolean(e) }, sel)
const cardsIn = (page, scope) => page.evaluate((s) => [...document.querySelectorAll(`${s} [data-movement]`)].map((e) => e.getAttribute('data-movement')), scope)
const dayOff = async (n) => (await sql(`select (app.today() + (${n}))::text d`))[0].d
const lines = (mid) => sql(`select record_id, valor::float v, deleted_at from daily_record_costs where movimento_id='${mid}' order by created_at, id`)
const drag = (page, id, cell) => page.evaluate(async (i, c) => {
  const dt = new DataTransfer(); const card = document.querySelector(`[data-movement="${i}"]`); const target = document.querySelector(`[data-cell="${c}"]`)
  if (!card || !target) return { err: 'sem cartao/celula ' + !!card + '/' + !!target }
  const fire = (el, type) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }))
  fire(card, 'dragstart'); await new Promise((r) => setTimeout(r, 80)); fire(target, 'dragenter'); fire(target, 'dragover'); await new Promise((r) => setTimeout(r, 80)); fire(target, 'drop'); fire(card, 'dragend'); return { ok: true }
}, id, cell)
const waitCell = (page, id, cell, to = 15000) => page.waitForFunction((i, c) => document.querySelector(`[data-movement="${i}"]`)?.closest('[data-cell]')?.getAttribute('data-cell') === c, { timeout: to }, id, cell)
async function exportNow(page) {
  for (const f of readdirSync(DL)) rmSync(DL + '/' + f)
  const okc = await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find((x) => /Exportar Excel/.test(x.innerText)); if (!b || b.disabled) return false; b.click(); return true }); if (!okc) return null
  for (let i = 0; i < 40; i++) { await sleep(500); const f = readdirSync(DL).find((x) => x.endsWith('.xlsx')); if (f) { await sleep(500); const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(DL + '/' + f); const ws = wb.worksheets[0]; const rows = []; ws.eachRow((r) => rows.push(r.values.slice(1))); return { file: f, n: rows.length - 1, rows: rows.slice(1) } } }
  return { err: 'sem ficheiro' }
}
// numero de "por ligar" (nao marcadas) e marcadas segundo a BD
const dbUnl = (flagged) => sql(`select id, data::text d from movements where tenant_id='${T}' and deleted_at is null and lancamento_referencia_id is not null and tipo='debito' and operation_id is not null and rota_id is not null and registo_id is null and sem_registo_previsto = ${flagged} order by data, created_at, id`)

// ---------- dados ----------
const tr = await must(mvIns(cont, { subcategoria: 'transferencia_distribuicao', valor: 9000, pessoa_responsavel: 'QA-C-UI3', data: await dayOff(-50), conta_id: ctx.contaA, descricao: 'QA-C-u3-tr' }).single())
const mkAl = async (k, d, o = {}) => (await must(mvIns(cont, { subcategoria: 'outro', valor: 30 + k, pessoa_responsavel: 'QA-C-UI3', lancamento_referencia_id: tr.id, data: d, conta_id: ctx.contaA, operation_id: ctx.opLN, rota_id: ctx.R1, descricao: 'QA-C-u3-al' + k, ...o }).single())).id
const d40 = await dayOff(-45), d30 = await dayOff(-35), d20 = await dayOff(-20), d15 = await dayOff(-13), d12 = await dayOff(-11)
const U = { u1: await mkAl(1, d40), u2: await mkAl(2, d30), u3: await mkAl(3, d20, { rota_id: ctx.R2 }), u4: await mkAl(4, d15), u5: await mkAl(5, d12) }
ids.U = U
// registo Validado (Gestor) em R2 na data de u4: mover u4 para R2 = ligar a um registo Validado
const rV = await mkRec(oper, ctx.R2, d15); await must(gest.from('daily_records').update({ status: 'validado' }).eq('id', rV).select('id')); ids.rV = rV
const rV5 = await mkRec(oper, ctx.R2, d12); await must(gest.from('daily_records').update({ status: 'validado' }).eq('id', rV5).select('id')); ids.rV5 = rV5

const C = await open('qa.contabilista@example.test'); const cp = C.page
const cdp = await browser.target().createCDPSession(); await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL.replace(/\//g, '\\'), browserContextId: C.bctx.id })
await cp.waitForSelector('[data-kpi="pending"]'); await pill(cp, 'Tudo'); await sleep(1500)

setArea('R3 UI - Por ligar'); setCaso('R3-UI')
await t('U1 pilula "Por ligar (N)" (N = por ligar NAO marcadas da BD); a vista mostra as mais antigas primeiro, com "ha N dias" no cartao; sem checkboxes-fantasma fora do necessario', async () => {
  const exp = await dbUnl(false); const txt = await pillText(cp, 'Por ligar'); eq(txt, `Por ligar (${exp.length})`, 'pilula')
  await pill(cp, 'Por ligar'); await cp.waitForSelector('[data-testid="unlinked-view"]'); await sleep(600)
  const shown = await cp.evaluate(() => { const v = document.querySelector('[data-testid="unlinked-view"]'); const fl = v.querySelector('[data-testid="unlinked-flagged"]'); const all = [...v.querySelectorAll('[data-movement]')].map((e) => e.getAttribute('data-movement')); const inFl = fl ? [...fl.querySelectorAll('[data-movement]')].map((e) => e.getAttribute('data-movement')) : []; return { all, inFl } })
  eq(shown.all.filter((x) => !shown.inFl.includes(x)), exp.map((e) => e.id), 'ordem/conteudo da lista Por ligar (mais antigas primeiro) vs BD')
  const age = await cp.evaluate((i) => document.querySelector(`[data-movement="${i}"]`)?.innerText.replace(/\u00a0/g, ' '), U.u1); ok(/há 45 dias/.test(age), 'idade no cartao de ' + U.u1 + ': ' + age)
  const age1 = await cp.evaluate((i) => document.querySelector(`[data-movement="${i}"]`)?.innerText.replace(/\u00a0/g, ' '), U.u5); ok(/há 11 dias/.test(age1), 'idade ' + U.u5 + ': ' + age1)
  const M0 = (await dbUnl(true)).length; eq(Boolean(await cp.$('[data-testid="unlinked-flagged"]')), M0 > 0, 'secao "Sem registo previsto" so aparece com marcadas (M=' + M0 + ')')
})
await t('U2 Marcar em lote (checkboxes + [data-batch-norecord]): as 2 vao para "Sem registo previsto (M)", a pilula desce 2, BD flag=true, 1 entrada de audit UPDATE por movimento; Desmarcar em lote volta', async () => {
  const before = (await dbUnl(false)).length
  for (const id of [U.u1, U.u2]) await cp.evaluate((i) => document.querySelector(`[data-movement="${i}"] input[data-check]`)?.click(), id); await sleep(300)
  ok(await cp.$('[data-batch-norecord]'), 'sem botao de marcar em lote'); const a0 = (await sql(`select count(*)::int n from audit_log where tabela='movements' and registo_id in ('${U.u1}','${U.u2}')`))[0].n
  await click(cp, '[data-batch-norecord]'); await sleep(2000)
  eq([(await mv(U.u1)).sem_registo_previsto, (await mv(U.u2)).sem_registo_previsto], [true, true], 'flags')
  eq((await sql(`select count(*)::int n from audit_log where tabela='movements' and registo_id in ('${U.u1}','${U.u2}')`))[0].n - a0, 2, 'entradas de audit')
  eq(await pillText(cp, 'Por ligar'), `Por ligar (${before - 2})`, 'pilula depois de marcar')
  const inFl = await cardsIn(cp, '[data-testid="unlinked-flagged"]'); ok(inFl.includes(U.u1) && inFl.includes(U.u2), 'marcadas na secao Sem registo previsto: ' + inFl.length)
  const hd = await cp.$eval('[data-testid="unlinked-flagged"] h3', (e) => e.innerText); eq(hd, `Sem registo previsto (${(await dbUnl(true)).length})`, 'cabecalho')
  // desmarcar em lote
  for (const id of [U.u1, U.u2]) await cp.evaluate((i) => document.querySelector(`[data-movement="${i}"] input[data-check]`)?.click(), id); await sleep(300)
  ok(await cp.$('[data-batch-unnorecord]'), 'sem botao desmarcar em lote'); await click(cp, '[data-batch-unnorecord]'); await sleep(2000)
  eq([(await mv(U.u1)).sem_registo_previsto, (await mv(U.u2)).sem_registo_previsto], [false, false], 'flags depois de desmarcar'); eq(await pillText(cp, 'Por ligar'), `Por ligar (${before})`, 'pilula depois de desmarcar')
})
await t('U3 Detalhe: botao [data-norecord-toggle] marca/desmarca; chip "Sem registo previsto"; ausente numa alocacao ligada / manual', async () => {
  await cp.click(`[data-movement="${U.u3}"]`); await cp.waitForSelector('[role=dialog]'); await sleep(400)
  await click(cp, '[data-norecord-toggle]'); await sleep(1500); eq((await mv(U.u3)).sem_registo_previsto, true, 'marcada ' + U.u3)
  const tx = await cp.$eval('[role=dialog]', (e) => e.innerText.replace(/\u00a0/g, ' ')); ok(/Sem registo previsto/.test(tx), 'chip no detalhe')
  await click(cp, '[data-norecord-toggle]'); await sleep(1500); eq((await mv(U.u3)).sem_registo_previsto, false, 'desmarcada ' + U.u3); await cp.keyboard.press('Escape'); await sleep(300)
  // ligada (a registo)
  const linked = (await sql(`select id from movements where tenant_id='${T}' and deleted_at is null and lancamento_referencia_id is not null and registo_id is not null and tipo='debito' limit 1`))[0]?.id
  if (linked) { await pill(cp, 'Lista'); await sleep(500); await cp.evaluate((i) => document.querySelector(`[data-movement="${i}"]`)?.click(), linked); await sleep(700); if (await cp.$('[role=dialog]')) eq(await cp.$('[data-norecord-toggle]'), null, 'toggle numa alocacao ligada ' + linked); await cp.keyboard.press('Escape') }
})
await t('U4 Exportar em "Por ligar" = as por ligar + as marcadas; em Distribuicoes = transferencias + as suas alocacoes + alocacoes sem transferencia ativa (nao o livro todo)', async () => {
  await must(cont.from('movements').update({ sem_registo_previsto: true }).eq('id', U.u3).select()); await pill(cp, 'Lista'); await sleep(300); await pill(cp, 'Por ligar'); await sleep(1500)
  const x = await exportNow(cp); const expU = (await dbUnl(false)).length + (await dbUnl(true)).length; eq(x.n, expU, 'linhas exportadas em Por ligar')
  await pill(cp, 'Distribuições'); await sleep(1000); const y = await exportNow(cp)
  const expD = (await sql(`select count(*)::int n from movements m where tenant_id='${T}' and deleted_at is null and ((subcategoria='transferencia_distribuicao' and lancamento_referencia_id is null) or (lancamento_referencia_id is not null and (not exists (select 1 from movements p where p.id=m.lancamento_referencia_id and p.deleted_at is null) or exists (select 1 from movements p where p.id=m.lancamento_referencia_id and p.deleted_at is null and p.subcategoria='transferencia_distribuicao' and p.lancamento_referencia_id is null))))`))[0].n
  const all = (await sql(`select count(*)::int n from movements where tenant_id='${T}' and deleted_at is null`))[0].n; ok(expD < all, 'cenario sem sentido')
  eq(y.n, expD, `linhas exportadas em Distribuicoes (livro todo seria ${all})`)
  await must(cont.from('movements').update({ sem_registo_previsto: false }).eq('id', U.u3).select())
})
await t('U5 Auditor com accounting_read: ve a vista Por ligar (e o cabecalho) mas sem checkboxes nem botao de marcar', async () => {
  const A = await open('qa.auditor.acc@example.test', process.env.QA_PASSWORD, '/contabilidade?view=unlinked'); const ap = A.page; await ap.waitForSelector('[data-testid="unlinked-view"]'); await sleep(1200)
  eq([await ap.$$eval('input[data-check],input[data-check-all]', (e) => e.length), await ap.$('[data-batch-norecord]'), await ap.$('[data-testid="batch-bar"]')], [0, null, null], 'controlos do Auditor')
  await ap.click(`[data-movement="${U.u4}"]`); await ap.waitForSelector('[role=dialog]'); await sleep(400); eq(await ap.$('[data-norecord-toggle]'), null, 'toggle do Auditor'); await A.bctx.close()
})

// =================== confirmacao ao ligar a registo Validado ===================
setArea('UI - confirmacao de religacao a registo Validado'); setCaso('B6')
await cp.goto(BASE + '/contabilidade?view=board', { waitUntil: 'networkidle2' }); await cp.waitForSelector('[data-testid="board"]'); await pill(cp, 'Tudo'); await sleep(1500)
await t('B6.1 Quadro: arrastar alocacao "por ligar" (R1) para R2 cujo registo dessa data esta VALIDADO pede confirmacao ([data-testid=relink-confirm], texto de "Validado"); cancelar nao muda nada', async () => {
  ok((await drag(cp, U.u4, `${ctx.R2}|pendente`)).ok, 'drag'); await cp.waitForSelector('[data-testid="relink-confirm"]', { timeout: 8000 })
  const tx = await cp.$eval('[data-testid="relink-confirm"]', (e) => e.innerText.replace(/\u00a0/g, ' ')); ok(/Validado/.test(tx) && /Submetido/.test(tx) && /QA-C-R2/.test(tx), 'texto: ' + tx.slice(0, 300))
  const a0 = (await sql(`select count(*)::int n from audit_log where tabela='movements' and registo_id='${U.u4}'`))[0].n
  await click(cp, '[data-relink-cancel]'); await sleep(1500); const m = await mv(U.u4); const r = (await sql(`select status from daily_records where id='${rV}'`))[0]
  eq([m.rota_id, m.registo_id, r.status, (await sql(`select count(*)::int n from audit_log where tabela='movements' and registo_id='${U.u4}'`))[0].n], [ctx.R1, null, 'validado', a0], 'BD inalterada apos cancelar ' + U.u4 + ' / registo ' + rV)
  eq(await cp.$('[data-testid="relink-confirm"]'), null, 'dialogo fechado')
})
await t('B6.2 Confirmar: liga-se ao registo (linha de custo), o registo volta a Submetido e o Gestor que o validou recebe record_reopened', async () => {
  ok((await drag(cp, U.u4, `${ctx.R2}|pendente`)).ok, 'drag'); await cp.waitForSelector('[data-testid="relink-confirm"]', { timeout: 8000 }); await click(cp, '[data-relink-confirm]'); await waitCell(cp, U.u4, `${ctx.R2}|pendente`); await sleep(800)
  const m = await mv(U.u4); const r = (await sql(`select status, validado_por from daily_records where id='${rV}'`))[0]
  eq([m.registo_id, m.rota_id, r.status, r.validado_por], [rV, ctx.R2, 'submetido', null], 'alocacao ' + U.u4 + ' registo ' + rV)
  eq((await lines(U.u4)).filter((l) => !l.deleted_at).length, 1, 'linha ativa'); eq((await sql(`select user_id from notifications where tipo='record_reopened' and payload->>'record_id'='${rV}'`)).map((x) => x.user_id), [gest.uid], 'record_reopened')
})
await t('B6.3 Bottom sheet "Mover..." (Detalhe): ligar uma "por ligar" a registo Validado tambem pede confirmacao; cancelar nao muda', async () => {
  await pill(cp, 'Lista'); await cp.goto(BASE + '/contabilidade', { waitUntil: 'networkidle2' }); await cp.waitForSelector('[data-kpi="pending"]'); await pill(cp, 'Tudo'); await sleep(1500)
  await cp.click(`[data-movement="${U.u5}"]`); await cp.waitForSelector('[role=dialog]'); await sleep(400)
  await cp.evaluate(() => [...document.querySelectorAll('[role=dialog] button')].find((b) => /^Mover/.test(b.innerText.trim())).click()); await sleep(500)
  const sels = await cp.$$('[role=dialog] select'); await sels[1].select(ctx.R2)
  await cp.evaluate(() => [...document.querySelectorAll('[role=dialog] button')].find((b) => b.innerText.trim() === 'Aplicar').click()); await cp.waitForSelector('[data-testid="relink-confirm"]', { timeout: 8000 })
  const tx = await cp.$eval('[data-testid="relink-confirm"]', (e) => e.innerText.replace(/\u00a0/g, ' ')); ok(/Validado/.test(tx), 'texto ' + tx.slice(0, 200))
  await click(cp, '[data-relink-cancel]'); await sleep(1500); const m = await mv(U.u5); eq([m.rota_id, m.registo_id, (await sql(`select status from daily_records where id='${rV5}'`))[0].status], [ctx.R1, null, 'validado'], 'cancelar ' + U.u5)
})
await t('B6.4 Nova alocacao (Distribuicoes > transferencia > "+ Adicionar alocacao") a R2 na data de um registo Validado pede confirmacao ("Validado"); cancelar = nada criado; confirmar = liga e reverte o registo', async () => {
  await pill(cp, 'Distribuições'); await sleep(1000)
  await cp.evaluate((tid) => { const c = [...document.querySelectorAll('.cursor-pointer')].find((e) => /QA-C-UI3/.test(e.innerText) && e.querySelector('[data-alloc-state]')); c.click() }, tr.id); await cp.waitForSelector('[role=dialog]'); await sleep(500)
  await cp.evaluate(() => [...document.querySelectorAll('[role=dialog] button')].find((b) => /Adicionar aloca/.test(b.innerText)).click()); await cp.waitForSelector('[role=dialog] form'); await sleep(500)
  const fill = async (v) => { await cp.$eval('[role=dialog] input[type=date]', (el, val) => { const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(el, val); el.dispatchEvent(new Event('input', { bubbles: true })) }, d12)
    await cp.evaluate(() => { const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; const n = [...document.querySelectorAll('[role=dialog] input')].find((i) => i.inputMode === 'decimal' || i.type === 'number'); set.call(n, '5,55'); n.dispatchEvent(new Event('input', { bubbles: true })) })
    const opSel = await cp.evaluateHandle(() => [...document.querySelectorAll('[role=dialog] select')].find((s) => [...s.options].some((o) => o.text === 'Lisboa Norte'))); await opSel.select(ctx.opLN); await sleep(400)
    const rSel = await cp.evaluateHandle(() => [...document.querySelectorAll('[role=dialog] select')].find((s) => [...s.options].some((o) => o.text === 'QA-C-R2'))); await rSel.select(ctx.R2); await sleep(300) }
  await fill()
  const n0 = (await sql(`select count(*)::int n from movements where lancamento_referencia_id='${tr.id}' and deleted_at is null`))[0].n
  await cp.evaluate(() => [...document.querySelectorAll('[role=dialog] button[type=submit]')][0].click()); await cp.waitForSelector('[data-testid="relink-confirm"]', { timeout: 8000 })
  const tx = await cp.$eval('[data-testid="relink-confirm"]', (e) => e.innerText.replace(/\u00a0/g, ' ')); ok(/Validado/.test(tx), 'texto ' + tx.slice(0, 200))
  await click(cp, '[data-relink-cancel]'); await sleep(1500)
  eq([(await sql(`select count(*)::int n from movements where lancamento_referencia_id='${tr.id}' and deleted_at is null`))[0].n, (await sql(`select status from daily_records where id='${rV5}'`))[0].status], [n0, 'validado'], 'cancelar nao cria nada')
  await cp.evaluate(() => [...document.querySelectorAll('[role=dialog] button[type=submit]')][0].click()); await cp.waitForSelector('[data-testid="relink-confirm"]', { timeout: 8000 }); await click(cp, '[data-relink-confirm]'); await sleep(2500)
  const created = await sql(`select id, registo_id from movements where lancamento_referencia_id='${tr.id}' and deleted_at is null and valor=5.55`)
  eq([created.length, created[0]?.registo_id, (await sql(`select status from daily_records where id='${rV5}'`))[0].status], [1, rV5, 'submetido'], 'confirmar: cria, liga, reverte o registo ' + rV5)
})

// =================== sino, filtros, Sem conta ===================
setArea('UI - sino e filtros'); setCaso('B7-sino')
await t('S1 Sino: movement_pending leva a /contabilidade?view=validate&mov=<id>: a vista SEGUE o ?view= mesmo ja dentro da Contabilidade e o movimento abre', async () => {
  const a = await mkAl(9, await dayOff(-1), { rota_id: null, operation_id: null, descricao: 'QA-C-u3-sino' })
  await cp.goto(BASE + '/contabilidade', { waitUntil: 'networkidle2' }); await cp.waitForSelector('[data-kpi="pending"]'); await sleep(1200); ok((await pressed(cp)).includes('Lista'), 'inicio na Lista')
  await cp.evaluate(() => document.querySelector('button[aria-label="Notificações"]').click()); await sleep(900)
  const clicked = await cp.evaluate(() => { const b = [...document.querySelectorAll('[role=dialog] li button')].find((x) => /por validar/i.test(x.innerText)); if (b) b.click(); return b?.innerText ?? null }); ok(clicked, 'sem notificacao movement_pending'); await sleep(1800)
  const st = await cp.evaluate(() => ({ url: location.pathname + location.search, dlg: document.querySelector('[role=dialog]')?.innerText.replace(/\u00a0/g, ' ') ?? null }))
  ok(await pressed(cp).then((p) => p.includes('Por validar')), 'vista ativa: ' + JSON.stringify(await pressed(cp))); ok(st.dlg && /QA-C-u3-sino/.test(st.dlg), `movimento ${a} nao abriu: ${JSON.stringify(st)}`)
  return 'url final ' + st.url
})
await t('S2 Sino allocation_unlinked estando ja em Por validar: muda para ?view=unlinked ("Por ligar")', async () => {
  await sql(`update notifications set lido_em = null where tipo='allocation_unlinked' and user_id='${cont.uid}' and payload->>'movement_id' = '${U.u5}'`)
  await pill(cp, 'Por validar'); await sleep(500)
  await cp.evaluate(() => document.querySelector('button[aria-label="Notificações"]').click()); await sleep(900)
  const clicked = await cp.evaluate(() => { const b = [...document.querySelectorAll('[role=dialog] li button')].find((x) => /Alocação por ligar/i.test(x.innerText)); if (b) b.click(); return b?.innerText ?? null })
  if (!clicked) return 'sem notificacao allocation_unlinked para este utilizador (NAO TESTADO aqui; ver 17-sino-mesma-pagina)'
  await sleep(1500); ok((await pressed(cp)).includes('Por ligar'), 'vista ativa ' + JSON.stringify(await pressed(cp)))
})
await t('F1 Mudar QUALQUER filtro limpa a selecao do lote (periodo, conta, origem, categoria); mudar de vista tambem', async () => {
  await cp.goto(BASE + '/contabilidade', { waitUntil: 'networkidle2' }); await cp.waitForSelector('[data-kpi="pending"]'); await pill(cp, 'Tudo'); await sleep(1500)
  const sel = async () => { await cp.evaluate(() => { const c = [...document.querySelectorAll('[data-testid="movement-list"] input[data-check]')].slice(0, 2); c.forEach((x) => x.click()) }); await sleep(300); return (await cp.$('[data-testid="batch-bar"]')) !== null }
  const stillSel = async () => (await cp.$('[data-testid="batch-bar"]')) !== null
  const tries = [['periodo Este mes', () => pill(cp, 'Este mês')], ['periodo Tudo', () => pill(cp, 'Tudo')]]
  const res = []
  for (const [n, fn] of tries) { ok(await sel(), 'sem barra apos selecionar (' + n + ')'); await fn(); await sleep(500); res.push([n, await stillSel()]) }
  const selects = await cp.$$('select'); for (let i = 0; i < selects.length; i++) { if (!(await sel())) { res.push(['select ' + i + ' (lista vazia, nao verificavel)', false]); continue } const opts = await selects[i].evaluate((s) => [...s.options].map((o) => o.value)); if (opts.length < 2) continue; await selects[i].select(opts[1]); await sleep(500); res.push(['select ' + i + ' [' + (await selects[i].evaluate((x) => x.getAttribute('aria-label'))) + ']', await stillSel()]); await selects[i].select(opts[0]); await sleep(300) }
  const notFilter = res.filter((r) => r[1] && /Opera/.test(r[0])); eq(res.filter((r) => r[1] && !/Opera/.test(r[0])), [], 'selecao NAO limpa apos: ' + JSON.stringify(res)); ok(res.length >= 4, 'poucos controlos verificados: ' + JSON.stringify(res)); return 'OBSERVACAO: o seletor global de Operacao (cabecalho) NAO limpa a selecao (nao e filtro da Contabilidade; a acao so aplica aos selecionados visiveis): ' + JSON.stringify(notFilter) + ' | ' + JSON.stringify(res)
})
await t('F2 Pilula "Sem conta (N)" forca periodo Tudo (N global): estando em "Este mes", ao clicar ficam ativas "Sem conta" e "Tudo"', async () => {
  await cp.goto(BASE + '/contabilidade', { waitUntil: 'networkidle2' }); await cp.waitForSelector('[data-kpi="pending"]'); await sleep(1200); await pill(cp, 'Este mês'); await sleep(500)
  const N = (await sql(`select count(*)::int n from movements where tenant_id='${T}' and deleted_at is null and conta_id is null`))[0].n; ok(N > 0, 'cenario: nenhum sem conta'); eq(await pillText(cp, 'Sem conta'), `Sem conta (${N})`, 'N global')
  ok(!(await pressed(cp)).includes('Tudo'), 'antes ja estava Tudo: ' + JSON.stringify(await pressed(cp))); await pill(cp, 'Sem conta'); await sleep(900)
  const p = await pressed(cp); ok(p.includes('Sem conta') && p.includes('Tudo'), 'depois: ' + JSON.stringify(p)); eq((await cardsIn(cp, '[data-testid="movement-list"]')).length, N, 'cartoes = N')
})
dump('results-22.json'); savectx(); await browser.close(); process.exit(0)
