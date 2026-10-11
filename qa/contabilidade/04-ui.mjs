// UI (Chrome headless) - casos 4, 8, 17, 18, 20, 21, 23, 24 (parte UI), 25, 26 e Quadro 27-31. Precisa de `npm run dev -- --port 5199`.
import puppeteer from 'puppeteer-core'
import { mkdirSync } from 'node:fs'
import { ctx, T, loginAll, users, t, setCaso, setArea, eq, ok, must, sql, mvIns, mv, dump, savectx, sleep } from './h.mjs'
import { sums } from './acc.bundle.mjs'

const BASE = 'http://localhost:5199', CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
mkdirSync(new URL('./shots/', import.meta.url), { recursive: true })
const shot = (page, n) => page.screenshot({ path: new URL(`./shots/${n}.png`, import.meta.url).pathname.replace(/^\//, '') })
await loginAll()
const { admin, cont, audacc } = users
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] })
const errors = []

async function open(email, pw, url = '/contabilidade', pre) {
  const bctx = await browser.createBrowserContext(); const page = await bctx.newPage()
  await page.setViewport({ width: 1366, height: 1000 })
  page.on('pageerror', (e) => errors.push(email + ' pageerror: ' + e.message))
  await page.goto(BASE, { waitUntil: 'networkidle2' })
  if (pre) await page.evaluate(pre)
  await page.waitForSelector('input[type=email]'); await page.type('input[type=email]', email); await page.type('input[type=password]', pw); await page.click('button[type=submit]')
  await page.waitForFunction(() => !document.querySelector('input[type=password]'), { timeout: 20000 })
  await page.goto(BASE + url, { waitUntil: 'networkidle2' })
  return { page, bctx }
}
const pill = (page, text) => page.evaluate((tx) => { const b = [...document.querySelectorAll('button[aria-pressed]')].find((x) => x.innerText.trim().startsWith(tx)); b?.click(); return Boolean(b) }, text)
const kpi = (page, name) => page.$eval(`[data-kpi="${name}"]`, (el) => Number(el.getAttribute('data-value')))
const num = (s) => Number(String(s).replace(/\s|€|\u00a0/g, '').replace('−', '-').replace(/\.(?=\d{3}\b)/g, '').replace(',', '.'))
const drag = (page, id, cell) => page.evaluate(async (i, c) => {
  const dt = new DataTransfer(); const card = document.querySelector(`[data-movement="${i}"]`); const target = document.querySelector(`[data-cell="${c}"]`)
  if (!card || !target) return { err: 'sem cartao/celula ' + !!card + '/' + !!target }
  const fire = (el, type) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }))
  fire(card, 'dragstart'); await new Promise((r) => setTimeout(r, 80)); fire(target, 'dragenter'); fire(target, 'dragover'); await new Promise((r) => setTimeout(r, 80))
  fire(target, 'drop'); fire(card, 'dragend'); return { ok: true }
}, id, cell)
const cellOf = (page, id) => page.evaluate((i) => document.querySelector(`[data-movement="${i}"]`)?.closest('[data-cell]')?.getAttribute('data-cell') ?? null, id)
const waitCell = (page, id, cell, to = 15000) => page.waitForFunction((i, c) => document.querySelector(`[data-movement="${i}"]`)?.closest('[data-cell]')?.getAttribute('data-cell') === c, { timeout: to }, id, cell)
const auditCount = async (id) => (await sql(`select count(*)::int n from audit_log where tabela='movements' and registo_id='${id}'`))[0].n
const auditRows = (id) => sql(`select acao, antes->>'estado' ae, depois->>'estado' de, antes->>'rota_id' ar, depois->>'rota_id' dr, user_id from audit_log where tabela='movements' and registo_id='${id}' order by id`)

try {
  // =============== ADMIN: casos 1-4, 8, 17, 18, 20, 21, 25, 26 (UI) ===============
  const A = await open('demo.admin@example.test', process.env.DEMO_PASSWORD); const ap = A.page
  await ap.waitForSelector('[data-kpi="pending"]'); await pill(ap, 'Tudo'); await sleep(1500)

  setArea('UI - distribuicao'); setCaso('CASO 1')
  await t('UI Distribuicoes: transferencia 800 totalmente alocada (266.67+266.67+266.66) mostra "Totalmente alocado" e sem "Por alocar"', async () => {
    await pill(ap, 'Distribuições'); await ap.waitForSelector('[data-alloc-state]')
    const cards = await ap.evaluate(() => [...document.querySelectorAll('[data-alloc-state]')].map((e) => ({ s: e.getAttribute('data-alloc-state'), tx: e.closest('.cursor-pointer')?.innerText ?? '' })))
    const ana = cards.filter((c) => c.tx.includes('QA-Ana'))
    ok(ana.length >= 3 && ana.every((c) => c.s === 'ok' && /Totalmente alocado/.test(c.tx) && !/Por alocar/.test(c.tx)), 'QA-Ana: ' + JSON.stringify(ana.map((c) => [c.s, c.tx.replace(/\n/g, ' ')])))
    ctx.ui = { cards: cards.length }
  })
  setCaso('CASO 2')
  await t('UI: sub-alocacao 800 com 500 mostra "Por alocar 300,00"', async () => {
    const tx = await ap.evaluate(() => [...document.querySelectorAll('[data-alloc-state="under"]')].map((e) => e.closest('.cursor-pointer').innerText))
    ok(tx.some((s) => s.includes('QA-Bruno') && /Por alocar\s*300,00/.test(s.replace(/\u00a0/g, ' '))), 'nao encontrado; textos QA-Bruno: ' + JSON.stringify(tx.filter((s) => s.includes('QA-Bruno')).map((s) => s.replace(/\n/g, ' '))))
  })
  setCaso('CASO 3')
  await t('UI: sobre-alocacao mostra "Sobre-alocado" com o excesso (transferencia QA-Carla 800 com 500+400+10)', async () => {
    const tx = await ap.evaluate(() => [...document.querySelectorAll('[data-alloc-state="over"]')].map((e) => e.closest('.cursor-pointer').innerText.replace(/\u00a0/g, ' ')))
    ok(tx.some((s) => s.includes('QA-Carla') && /Sobre-alocado\s*110,00/.test(s)), 'textos: ' + JSON.stringify(tx.map((s) => s.replace(/\n/g, ' '))))
    await shot(ap, 'distribuicoes')
  })

  setCaso('CASO 4'); setArea('UI - alocacoes de transferencia removida')
  await t('UI: detalhe da alocacao cuja transferencia foi removida mostra "Origem: transferencia removida" + data e motivo, mantem valor; alocacao ligada a transferencia ativa nao mostra o aviso', async () => {
    await pill(ap, 'Lista'); await ap.waitForSelector(`[data-movement="${ctx.c.c4a}"]`, { timeout: 15000 })
    await ap.click(`[data-movement="${ctx.c.c4a}"]`); await ap.waitForSelector('[role=dialog]'); await sleep(800)
    const txt = (await ap.$eval('[role=dialog]', (e) => e.innerText)).replace(/\u00a0/g, ' '); await shot(ap, 'c4-detalhe-alocacao')
    ok(/120,00/.test(txt), 'valor nao visivel no detalhe: ' + txt.slice(0, 200))
    ok(await ap.$('[role=dialog] [data-parent-removed]'), `alocacao ${ctx.c.c4a} (transferencia ${ctx.c.c4} soft-deleted): sem bloco data-parent-removed. Texto: ` + txt.slice(0, 400))
    ok(/Origem: transfer[eê]ncia removida/.test(txt), 'sem "Origem: transferencia removida": ' + txt.slice(0, 400))
    ok(/QA-C teste caso 4/.test(txt) && /\d{2}\/\d{2}\/\d{4}/.test(txt), 'sem motivo/data da remocao: ' + txt.slice(0, 500))
    await ap.keyboard.press('Escape'); await sleep(400)
    await ap.click(`[data-movement="${ctx.c.c7}"]`); await ap.waitForSelector('[role=dialog]'); await sleep(800)
    const other = await ap.evaluate(() => document.querySelector('[role=dialog] [data-parent-removed]') !== null); await ap.keyboard.press('Escape')
    eq(other, false, 'aviso indevido numa alocacao com transferencia ativa (' + ctx.c.c7 + ')')
  })
  await t('UI Distribuicoes: seccao "Alocacoes sem transferencia ativa" lista as alocacoes orfas (c4a/c4b) com valor e ligacao; a transferencia apagada nao aparece como cartao', async () => {
    await pill(ap, 'Distribuições'); await ap.waitForSelector('[data-orphans]', { timeout: 15000 }); await sleep(500)
    const r = await ap.evaluate((ids) => { const sec = document.querySelector('[data-orphans]'); return { txt: sec.innerText.replace(/\u00a0/g, ' '), found: ids.map((i) => sec.querySelector(`[data-movement="${i}"]`) !== null) } }, [ctx.c.c4a, ctx.c.c4b])
    ok(/Alocações sem transferência ativa/.test(r.txt), 'sem titulo da seccao: ' + r.txt.slice(0, 200)); eq(r.found, [true, true], 'c4a/c4b na seccao')
    ok(/120,00/.test(r.txt) && /150,00/.test(r.txt), 'valores das orfas em falta: ' + r.txt.replace(/\n/g, ' ').slice(0, 300))
    const trCards = await ap.evaluate(() => [...document.querySelectorAll('[data-alloc-state]')].map((e) => e.closest('.cursor-pointer')?.innerText ?? '').filter((x) => x.includes('QA-Diogo')).length)
    eq(trCards, 0, 'a transferencia apagada (QA-Diogo ' + ctx.c.c4 + ') nao devia aparecer como cartao de distribuicao'); await shot(ap, 'c4-orfas')
  })
  await ap.keyboard.press('Escape'); await sleep(300)

  setCaso('CASO 8'); setArea('UI - propagacao'); await pill(ap, 'Lista'); await sleep(500)
  await t('UI: alocacao sem registo diario mostra chip "Por ligar ao operacional" (e a ligada a registo nao)', async () => {
    const unl = ctx.c.c8[2], linked = ctx.c.c8[0]
    await ap.waitForSelector(`[data-movement="${unl}"]`, { timeout: 15000 })
    const a = await ap.$eval(`[data-movement="${unl}"]`, (e) => e.innerText), b = await ap.$eval(`[data-movement="${linked}"]`, (e) => e.innerText)
    ok(/Por ligar ao operacional/.test(a), 'alocacao por ligar ' + unl + ': ' + a.replace(/\n/g, ' ')); ok(!/Por ligar/.test(b) && /Propagada/.test(b), 'alocacao ligada ' + linked + ': ' + b.replace(/\n/g, ' '))
  })

  // ---- 17: totais oficiais excluem Pendente (UI) ----
  setCaso('CASO 17'); setArea('UI - totais oficiais')
  await t('UI: filtro Conta B/Tudo: KPI Saldo e Debitos NAO mudam ao criar alocacao de 4000 Pendente; "por validar" sobe 4000; ao Validar entra no saldo', async () => {
    await pill(ap, 'Lista'); await pill(ap, 'QA-C-ContaB'); await sleep(600)
    const rd = async () => ({ d: await kpi(ap, 'debits'), b: await kpi(ap, 'balance'), p: await kpi(ap, 'pending') })
    const dbOf = async () => sums(await must(cont.from('movements').select('*').eq('conta_id', ctx.contaB).is('deleted_at', null)))
    const b0 = await rd(); const s0 = await dbOf(); eq([b0.d, b0.b], [s0.debit, s0.net], 'KPI vs BD (antes)')
    const al = await must(mvIns(cont, { conta_id: ctx.contaB, subcategoria: 'outro', valor: 4000, pessoa_responsavel: 'QA-Ines', lancamento_referencia_id: ctx.c2.c17.tr, data: '2026-04-18', descricao: 'QA-C-c17-ui-alloc' }).single())
    await ap.reload({ waitUntil: 'networkidle2' }); await ap.waitForSelector('[data-kpi="pending"]'); await pill(ap, 'Tudo'); await pill(ap, 'QA-C-ContaB'); await sleep(800)
    const b1 = await rd(); eq([b1.d, b1.b], [b0.d, b0.b], 'saldo/debitos oficiais mudaram com uma alocacao Pendente ' + al.id)
    ok(Math.abs((b1.p - b0.p) - 4000) < 0.01, `"por validar" (KPI global) devia subir 4000: ${b0.p} -> ${b1.p}`)
    const card = await ap.$eval(`[data-movement="${al.id}"]`, (e) => ({ pend: e.hasAttribute('data-pending'), b: getComputedStyle(e).borderTopColor })); eq([card.pend, card.b], [true, 'rgb(239, 68, 68)'], 'contorno vermelho ' + al.id)
    await ap.evaluate((id) => [...document.querySelectorAll(`[data-movement="${id}"] button`)].find((b) => b.innerText.trim() === 'Validar')?.click(), al.id)
    await ap.waitForFunction((id) => !document.querySelector(`[data-movement="${id}"]`)?.hasAttribute('data-pending'), { timeout: 15000 }, al.id); await sleep(800)
    const b2 = await rd(); ok(Math.abs(b2.d - b1.d - 4000) < 0.01 && Math.abs(b1.b - b2.b - 4000) < 0.01, `ao validar: debitos +4000/saldo -4000: ${JSON.stringify([b1, b2])}`)
    ctx.ui.c17 = al.id
  })

  // ---- 18: Por validar ----
  setCaso('CASO 18')
  await t('UI "Por validar": mostra exatamente os Pendentes ativos (nem automaticos <= limiar nem manuais Confirmado nem versoes substituidas)', async () => {
    await pill(ap, 'Por validar'); await ap.waitForSelector('[data-testid="movement-list"]'); await sleep(800)
    const shown = await ap.evaluate(() => [...document.querySelectorAll('[data-testid="movement-list"] [data-movement]')].map((e) => ({ id: e.getAttribute('data-movement'), p: e.hasAttribute('data-pending') })))
    const db = (await sql(`select id from movements where tenant_id='${T}' and deleted_at is null and estado='pendente'`)).map((r) => r.id)
    eq(shown.map((s) => s.id).sort(), db.sort(), 'fila UI vs pendentes ativos BD'); ok(shown.every((s) => s.p), 'cartao sem contorno pendente na fila')
    const ex = [(await sql(`select id from movements where registo_id='${ctx.c2.r12}' and deleted_at is null limit 1`))[0].id, ctx.c3.c22.man]
    ok(ex.every((i) => !shown.some((s) => s.id === i)), 'confirmados na fila')
    await shot(ap, 'por-validar')
  })

  // ---- 20: op selecionada ----
  setCaso('CASO 20'); setArea('UI - despesa solta com operacao selecionada')
  const setOp = async (op) => { await ap.evaluate((o) => localStorage.setItem('um.op', o), op); await ap.reload({ waitUntil: 'networkidle2' }); await ap.waitForSelector('[data-kpi="debits"]'); await pill(ap, 'Tudo'); await sleep(900) }
  const ids20 = ctx.c3.c20
  await t('UI com Operacao "Lisboa Norte" selecionada: KPIs = so movimentos da operacao (despesas soltas NAO entram); Lista, Agrupado e Quadro tambem nao mostram as despesas soltas', async () => {
    const rows = await must(admin.from('movements').select('*').is('deleted_at', null)); const inOp = rows.filter((m) => m.operation_id === ctx.opLN), noOp = rows.filter((m) => m.operation_id === null)
    await setOp(ctx.opLN)
    const kd = await kpi(ap, 'debits'), kb = await kpi(ap, 'balance'), only = sums(inOp)
    ok(noOp.some((m) => ids20.includes(m.id)), 'precondicao: despesas soltas existem')
    ok(Math.abs(kd - only.debit) < 0.01 && Math.abs(kb - only.net) < 0.01, `KPIs com Lisboa Norte: debitos=${kd} saldo=${kb}; so-operacao=${only.debit}/${only.net}; operacao+soltas=${sums(inOp.concat(noOp)).debit}`)
    await pill(ap, 'Lista'); await sleep(500)
    const inList = await ap.evaluate((ids) => ids.map((i) => document.querySelector(`[data-testid="movement-list"] [data-movement="${i}"]`) !== null), ids20); eq(inList, [false, false], 'despesas soltas na Lista ' + ids20)
    await pill(ap, 'Agrupado'); await ap.waitForSelector('[data-testid="grouped-view"]'); await sleep(500)
    const inGr = await ap.evaluate((ids) => ids.map((i) => document.querySelectorAll(`[data-testid="grouped-view"] [data-movement="${i}"]`).length), ids20); eq(inGr, [0, 0], 'despesas soltas no Agrupado')
    const totalGr = await ap.evaluate(() => document.querySelectorAll('[data-testid="grouped-view"] [data-movement]').length)
    eq(totalGr, inOp.length, 'cartoes do Agrupado vs movimentos da operacao (periodo Tudo)')
    await pill(ap, 'Quadro'); await ap.waitForSelector('[data-testid="board"]'); await pill(ap, 'Tudo'); await sleep(900)
    const inBd = await ap.evaluate((ids) => ids.map((i) => document.querySelectorAll(`[data-testid="board"] [data-movement="${i}"]`).length), ids20); eq(inBd, [0, 0], 'despesas soltas no Quadro')
    const bdTotal = await ap.evaluate(() => document.querySelectorAll('[data-testid="board"] [data-movement]').length); eq(bdTotal, inOp.length, 'cartoes do Quadro vs movimentos da operacao')
    await shot(ap, 'c20-op-selecionada')
  })
  await t('Excecao deliberada: com a Operacao selecionada, a fila "Por validar", o cartao "por validar" e o painel Distribuicoes INCLUEM o que nao tem operacao (nunca escondem pendentes/transferencias)', async () => {
    const rows = await must(admin.from('movements').select('*').is('deleted_at', null))
    const scoped = rows.filter((m) => m.operation_id === ctx.opLN || m.operation_id === null)
    const pendScoped = scoped.filter((m) => m.estado === 'pendente'), pendNoOp = pendScoped.filter((m) => m.operation_id === null)
    ok(pendNoOp.length > 0, 'precondicao: pendentes sem operacao')
    await pill(ap, 'Por validar'); await ap.waitForSelector('[data-testid="movement-list"]'); await sleep(700)
    const shown = await ap.evaluate(() => [...document.querySelectorAll('[data-testid="movement-list"] [data-movement]')].map((e) => e.getAttribute('data-movement')))
    eq(shown.slice().sort(), pendScoped.map((m) => m.id).sort(), 'fila por validar com Lisboa Norte selecionada (pendentes da operacao + sem operacao)')
    ok(pendNoOp.every((m) => shown.includes(m.id)), 'pendentes sem operacao escondidos da fila')
    const kp = await kpi(ap, 'pending'); const exp = sums(pendScoped).pendingAmount; ok(Math.abs(kp - exp) < 0.01, `KPI "por validar" ${kp} vs pendentes do ambito (${exp})`)
    await pill(ap, 'Distribuições'); await sleep(600)
    const cards = await ap.evaluate(() => [...document.querySelectorAll('[data-alloc-state]')].map((e) => e.closest('.cursor-pointer')?.innerText ?? ''))
    ok(cards.some((c) => c.includes('QA-Ana')) && cards.some((c) => c.includes('QA-Carla')), 'transferencias (sem operacao) em falta no painel Distribuicoes com operacao selecionada: ' + cards.length + ' cartoes')
  })
  await t('Com "Todas as operacoes" a despesa solta entra normalmente nos totais (KPI debitos = BD) e na Lista', async () => {
    await setOp('all'); await pill(ap, 'Lista'); await sleep(500)
    const rows = await must(admin.from('movements').select('*').is('deleted_at', null)); const kd = await kpi(ap, 'debits')
    ok(Math.abs(kd - sums(rows).debit) < 0.01, `KPI debitos ${kd} vs BD ${sums(rows).debit}`)
    const inList = await ap.evaluate((ids) => ids.map((i) => document.querySelector(`[data-testid="movement-list"] [data-movement="${i}"]`) !== null), ids20); eq(inList, [true, true], 'despesas soltas na Lista com Todas as operacoes')
  })

  // ---- 21: painel Contas ----
  setCaso('CASO 21')
  await t('UI painel Contas: saldo de QA-C-ContaA e QA-C-ContaB = soma dos seus proprios movimentos Confirmados (pendentes a parte)', async () => {
    await ap.reload({ waitUntil: 'networkidle2' }); await ap.waitForSelector('[data-kpi="pending"]'); await pill(ap, 'Tudo'); await pill(ap, 'Contas'); await sleep(800)
    const rows = await ap.evaluate(() => [...document.querySelectorAll('.divide-y > div')].map((r) => ({ name: r.querySelector('.font-medium')?.innerText, net: r.querySelector('.font-semibold.tabular-nums')?.innerText, extra: r.querySelector('.text-xs[style]')?.innerText ?? '' })))
    for (const [n, id] of [['QA-C-ContaA', ctx.contaA], ['QA-C-ContaB', ctx.contaB]]) {
      const r = rows.find((x) => x.name === n); ok(r, 'sem linha ' + n); const s = sums(await must(cont.from('movements').select('*').eq('conta_id', id).is('deleted_at', null)))
      eq([Math.round(num(r.net) * 100), Math.round(num((r.extra.match(/[\d\s\u00a0.]+,\d{2}/) ?? ['0'])[0]) * 100) || 0], [Math.round(s.net * 100), Math.round(s.pendingAmount * 100)], `linha ${n}: ${JSON.stringify(r)}`)
    }
    await shot(ap, 'contas')
  })

  // ---- 25/26: Agrupado ----
  setCaso('CASO 25'); setArea('UI - agrupado')
  await t('UI Agrupado: cada movimento aparece 1x, no dia+grupo (rota/Geral) dos seus proprios campos; transferencia separada das alocacoes', async () => {
    await pill(ap, 'Agrupado'); await ap.waitForSelector('[data-testid="grouped-view"]'); await sleep(500)
    await ap.evaluate(() => document.querySelectorAll('[data-testid="grouped-view"] details').forEach((d) => (d.open = true)))
    const rows = await sql(`select id, data::text d, rota_id::text r from movements where deleted_at is null and data between '2026-05-04' and '2026-05-06'`)
    const pos = await ap.evaluate((ids) => Object.fromEntries(ids.map((id) => {
      const els = [...document.querySelectorAll(`[data-testid="grouped-view"] [data-movement="${id}"]`)]
      const g = els[0]?.closest('details'); const d = g?.parentElement?.closest('details')
      return [id, { n: els.length, group: g?.querySelector('summary span')?.innerText, day: d?.querySelector('summary span')?.innerText }]
    })), rows.map((r) => r.id))
    const routeName = { [ctx.R1]: 'QA-C-R1', [ctx.R2]: 'QA-C-R2' }, dayLabels = {}, bad = []
    for (const r of rows) { const p = pos[r.id]; if (p.n !== 1 || p.group !== (r.r ? routeName[r.r] : 'Geral')) bad.push([r.id, p]); (dayLabels[r.d] ??= new Set()).add(p.day) }
    eq(bad.length, 0, 'movimentos repetidos/no grupo errado: ' + JSON.stringify(bad.slice(0, 3)))
    eq(Object.values(dayLabels).map((s) => s.size), [1, 1, 1], 'um dia = uma so etiqueta de dia'); ok(new Set(Object.values(dayLabels).map((s) => [...s][0])).size === 3, 'dias distintos')
    ctx.ui.grouped = rows.length
  })
  setCaso('CASO 26')
  await t('UI Agrupado: subtotal de cada grupo (oficial + "por validar") e total do dia = soma dos grupos', async () => {
    const all = await sql(`select data::text d, coalesce(rota_id::text,'__geral') g, tipo, valor::float v, estado from movements where deleted_at is null and data between '2026-05-04' and '2026-05-06'`)
    const exp = {}; const add = (k, r) => { const e = (exp[k] ??= { net: 0, pend: 0 }); if (r.estado === 'confirmado') e.net += (r.tipo === 'credito' ? 1 : -1) * Math.round(r.v * 100); else e.pend += Math.round(r.v * 100) }
    for (const r of all) { add(r.d + '|' + r.g, r); add(r.d + '|*', r) }
    const dom = await ap.evaluate(() => [...document.querySelectorAll('[data-testid="grouped-view"] > div')].map((card) => {
      const day = card.querySelector('details > summary'); const sumOf = (s) => ({ net: s.querySelector('b')?.innerText, pend: [...s.querySelectorAll('span.text-xs')].map((x) => x.innerText).join('') })
      return { label: day.querySelector('span')?.innerText, sums: sumOf(day), groups: [...card.querySelectorAll('details details > summary')].map((s) => ({ label: s.querySelector('span')?.innerText, ...sumOf(s) })) }
    }))
    const mapD = { '2026-05-04': '04', '2026-05-05': '05', '2026-05-06': '06' }
    let checked = 0
    for (const [d, dd] of Object.entries(mapD)) {
      const day = dom.find((x) => x.label === dd + '/05/2026'); ok(day, 'dia ' + d + ' nao encontrado: ' + dom.map((x) => x.label))
      const dayExp = exp[d + '|*']; eq([Math.round(num(day.sums.net) * 100), day.sums.pend ? Math.round(num(day.sums.pend.replace(/[^\d,.\-]/g, '')) * 100) : 0], [dayExp.net, dayExp.pend], 'total do dia ' + d)
      let sn = 0, sp = 0
      for (const g of day.groups) {
        const key = g.label === 'Geral' ? '__geral' : g.label === 'QA-C-R1' ? ctx.R1 : g.label === 'QA-C-R2' ? ctx.R2 : g.label
        const e = exp[d + '|' + key]; ok(e, `grupo inesperado ${g.label} em ${d}`); const gn = Math.round(num(g.net) * 100), gp = g.pend ? Math.round(num(g.pend.replace(/[^\d,.\-]/g, '')) * 100) : 0
        eq([gn, gp], [e.net, e.pend], `subtotal ${d} ${g.label}`); sn += gn; sp += gp; checked++
      }
      eq([sn, sp], [dayExp.net, dayExp.pend], 'soma dos grupos = total do dia ' + d)
    }
    return `${checked} subtotais de grupo + 3 totais de dia conferidos na UI`
  })
  await shot(ap, 'agrupado')
  await A.bctx.close()

  // =============== GESTOR / AUDITORES: casos 23-24 UI ===============
  setArea('UI - permissoes'); setCaso('CASO 23')
  await t('UI: Gestor nao tem Contabilidade no menu e /contabilidade nao mostra nada (redireciona)', async () => {
    const G = await open('qa.gestor@example.test', process.env.QA_PASSWORD, '/contabilidade'); const gp = G.page; await sleep(1200)
    const r = await gp.evaluate(() => ({ url: location.pathname, kpi: !!document.querySelector('[data-kpi]'), links: [...document.querySelectorAll('a[href="/contabilidade"]')].length, txt: document.body.innerText.includes('Saldo') }))
    await shot(gp, 'gestor-contabilidade'); await G.bctx.close()
    eq([r.kpi, r.links, r.url === '/contabilidade'], [false, 0, false], 'gestor viu contabilidade ' + JSON.stringify(r))
  })
  setCaso('CASO 24')
  await t('UI: Auditor SEM accounting_read: sem menu e /contabilidade nao mostra nada', async () => {
    const P = await open('qa.auditor@example.test', process.env.QA_PASSWORD, '/contabilidade'); await sleep(1200)
    const r = await P.page.evaluate(() => ({ url: location.pathname, kpi: !!document.querySelector('[data-kpi]'), links: document.querySelectorAll('a[href="/contabilidade"]').length })); await P.bctx.close()
    eq([r.kpi, r.links, r.url === '/contabilidade'], [false, 0, false], 'auditor sem leitura ' + JSON.stringify(r))
  })
  await t('UI: Auditor COM accounting_read ve KPIs e pendentes (contorno vermelho) mas sem "Novo movimento", sem "Validar", sem "Apagar/Editar" no detalhe; Quadro em modo so leitura', async () => {
    const P = await open('qa.auditor.acc@example.test', process.env.QA_PASSWORD, '/contabilidade'); const pg = P.page
    await pg.waitForSelector('[data-kpi="pending"]'); await pill(pg, 'Tudo'); await sleep(1200)
    const r = await pg.evaluate(() => ({ novo: [...document.querySelectorAll('button')].some((b) => /Novo movimento/.test(b.innerText)), validar: [...document.querySelectorAll('button')].some((b) => b.innerText.trim() === 'Validar'), pend: document.querySelectorAll('[data-pending]').length, cards: document.querySelectorAll('[data-movement]').length }))
    ok(r.cards > 0 && r.pend > 0, 'nao ve movimentos/pendentes ' + JSON.stringify(r)); eq([r.novo, r.validar], [false, false], 'botoes de escrita visiveis ' + JSON.stringify(r))
    // detalhe: sem acoes
    const pid = (await sql(`select id from movements where tenant_id='${T}' and deleted_at is null and estado='pendente' and lancamento_referencia_id is not null limit 1`))[0].id
    await pill(pg, 'Por validar'); await pg.waitForSelector(`[data-movement="${pid}"]`); await pg.click(`[data-movement="${pid}"]`); await pg.waitForSelector('[role=dialog]'); await sleep(400)
    const acts = await pg.evaluate(() => [...document.querySelectorAll('[role=dialog] button')].map((b) => b.innerText.trim()).filter(Boolean)); await shot(pg, 'auditor-detalhe')
    ok(!acts.some((a) => /Validar|Editar|Apagar|Mover|Atribuir|Reverter/.test(a)), 'acoes de escrita no detalhe: ' + JSON.stringify(acts))
    await pg.keyboard.press('Escape'); await P.bctx.close()
  })

  // =============== QUADRO: 27-31 (Contabilista real) ===============
  setArea('UI - Quadro (Kanban) como Contabilista'); setCaso('CASO 27')
  const tr = await must(mvIns(cont, { subcategoria: 'transferencia_distribuicao', valor: 900, pessoa_responsavel: 'QA-Kanban', data: '2026-06-01', descricao: 'QA-C-k-transf' }).single())
  const mkA = async (k) => (await must(mvIns(cont, { subcategoria: 'outro', valor: 20 + k, pessoa_responsavel: 'QA-Kanban', lancamento_referencia_id: tr.id, data: '2026-06-01', operation_id: ctx.opLN, rota_id: ctx.R1, descricao: 'QA-C-k-' + k }).single())).id
  const K = { a27: await mkA(1), a28: await mkA(2), a29: await mkA(3), a31a: await mkA(4), a31b: await mkA(5), a30: await mkA(6) }
  ctx.ui.kanban = K
  const C = await open('qa.contabilista@example.test', process.env.QA_PASSWORD, '/contabilidade?view=board'); const cp = C.page
  await cp.waitForSelector('[data-testid="board"]'); await pill(cp, 'Tudo'); await sleep(1500)
  const rowKeys = await cp.evaluate(() => [...document.querySelectorAll('[data-row]')].map((r) => r.getAttribute('data-row')))
  await t('Quadro do Contabilista tem linhas das rotas (R1, R2) + Geral e colunas Pendente|Confirmado', async () => { ok(rowKeys.includes(ctx.R1) && rowKeys.includes(ctx.R2) && rowKeys.includes('__geral'), 'linhas: ' + JSON.stringify(rowKeys)) })
  await t('Arrastar Pendente -> Confirmado (mesma linha): estado muda, rota igual, 1 entrada de audit com estado pendente->confirmado, validado_por = contabilista', async () => {
    eq(await cellOf(cp, K.a27), `${ctx.R1}|pendente`, 'celula inicial'); const a0 = await auditCount(K.a27)
    const r = await drag(cp, K.a27, `${ctx.R1}|confirmado`); ok(r.ok, r.err); await waitCell(cp, K.a27, `${ctx.R1}|confirmado`); await sleep(500)
    const m = await mv(K.a27); eq([m.estado, m.rota_id, m.operation_id, m.validado_por], ['confirmado', ctx.R1, ctx.opLN, cont.uid], 'movimento ' + K.a27)
    const au = await auditRows(K.a27); eq(au.length - a0, 1, 'entradas de audit novas'); eq([au.at(-1).acao, au.at(-1).ae, au.at(-1).de], ['UPDATE', 'pendente', 'confirmado'], 'audit ' + K.a27)
  })
  setCaso('CASO 28')
  await t('Arrastar para outra linha (R1 -> R2) na mesma coluna: so a rota/operacao muda; estado mantem-se Pendente; 1 entrada de audit', async () => {
    const a0 = await auditCount(K.a28); const r = await drag(cp, K.a28, `${ctx.R2}|pendente`); ok(r.ok, r.err); await waitCell(cp, K.a28, `${ctx.R2}|pendente`); await sleep(500)
    const m = await mv(K.a28); eq([m.estado, m.rota_id, m.operation_id, m.origem, m.validado_por], ['pendente', ctx.R2, ctx.opLN, 'manual_rota', null], 'movimento ' + K.a28)
    const au = await auditRows(K.a28); eq(au.length - a0, 1, 'entradas de audit novas'); eq([au.at(-1).ae, au.at(-1).de, au.at(-1).ar, au.at(-1).dr], ['pendente', 'pendente', ctx.R1, ctx.R2], 'audit ' + K.a28)
  })
  await t('Arrastar para Geral (mesma coluna): rota removida, operacao mantida, origem Manual-Rota continua coerente', async () => {
    const r = await drag(cp, K.a30, `__geral|pendente`); ok(r.ok, r.err); await waitCell(cp, K.a30, `__geral|pendente`); await sleep(500)
    const m = await mv(K.a30); eq([m.estado, m.rota_id, m.operation_id, m.origem], ['pendente', null, ctx.opLN, 'manual_rota'], 'movimento ' + K.a30)
  })
  setCaso('CASO 29')
  await t('Arrastar na diagonal (R1|Pendente -> R2|Confirmado): estado E rota mudam numa UNICA entrada de audit (nao duas)', async () => {
    const a0 = await auditCount(K.a29); const r = await drag(cp, K.a29, `${ctx.R2}|confirmado`); ok(r.ok, r.err); await waitCell(cp, K.a29, `${ctx.R2}|confirmado`); await sleep(600)
    const m = await mv(K.a29); eq([m.estado, m.rota_id, m.validado_por], ['confirmado', ctx.R2, cont.uid], 'movimento ' + K.a29)
    const au = await auditRows(K.a29); eq(au.length - a0, 1, 'entradas de audit novas (esperado 1)'); const l = au.at(-1); eq([l.ae, l.de, l.ar, l.dr], ['pendente', 'confirmado', ctx.R1, ctx.R2], 'a mesma entrada tem estado e rota ' + K.a29)
  })
  await shot(cp, 'quadro-contabilista')

  setCaso('CASO 31')
  await t('Falha a meio do arrasto (pedido PATCH recusado 403 sem permissao): cartao volta a celula original, mostra erro, BD e audit inalterados, nao fica preso', async () => {
    await cp.setRequestInterception(true)
    const handler = (req) => { if (req.method() === 'PATCH' && /\/rest\/v1\/movements/.test(req.url())) req.respond({ status: 403, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ code: '42501', message: 'permission denied for table movements' }) }); else req.continue() }
    cp.on('request', handler)
    const before = await mv(K.a31a), a0 = await auditCount(K.a31a), origin = await cellOf(cp, K.a31a)
    await drag(cp, K.a31a, `${ctx.R2}|confirmado`); await sleep(2000)
    const now = await cellOf(cp, K.a31a), txt = await cp.$eval('[data-testid="board"]', (e) => e.innerText); await shot(cp, 'quadro-falha-403')
    const after = await mv(K.a31a); cp.off('request', handler)
    eq(now, origin, 'cartao ' + K.a31a + ' nao voltou'); ok(/N[ãa]o foi poss[ií]vel mover/.test(txt), 'sem mensagem de erro: ' + txt.slice(0, 200))
    eq([after.estado, after.rota_id, await auditCount(K.a31a)], [before.estado, before.rota_id, a0], 'BD/audit alterados')
    // depois da falha o cartao e arrastavel outra vez (nao ficou preso)
    await cp.setRequestInterception(false)
    await drag(cp, K.a31a, `${ctx.R2}|pendente`); await waitCell(cp, K.a31a, `${ctx.R2}|pendente`); eq((await mv(K.a31a)).rota_id, ctx.R2, 'novo arrasto depois da falha')
  })
  await t('Falha de rede (pedido abortado) a meio do arrasto: cartao volta ao sitio e ha mensagem', async () => {
    await cp.setRequestInterception(true)
    const handler = (req) => { if (req.method() === 'PATCH' && /\/rest\/v1\/movements/.test(req.url())) req.abort('failed'); else req.continue() }
    cp.on('request', handler)
    const origin = await cellOf(cp, K.a31a), before = await mv(K.a31a)
    await drag(cp, K.a31a, `${ctx.R1}|confirmado`); await sleep(2000)
    const now = await cellOf(cp, K.a31a), txt = await cp.$eval('[data-testid="board"]', (e) => e.innerText); cp.off('request', handler); await cp.setRequestInterception(false)
    eq(now, origin, 'cartao nao voltou'); ok(/N[ãa]o foi poss[ií]vel mover/.test(txt), 'sem mensagem: ' + txt.slice(0, 200)); eq((await mv(K.a31a)).estado, before.estado, 'estado')
  })
  await t('Recusa real do servidor a meio do arrasto (lancamento apagado entretanto por Super Admin): erro, cartao volta, nada preso', async () => {
    const origin = await cellOf(cp, K.a31b)
    await must(admin.from('movements').update({ deleted_at: new Date().toISOString(), motivo_apagado: 'QA-C caso 31' }).eq('id', K.a31b).select())
    await drag(cp, K.a31b, `${ctx.R2}|confirmado`); await sleep(2500)
    const now = await cellOf(cp, K.a31b), txt = await cp.$eval('[data-testid="board"]', (e) => e.innerText); await shot(cp, 'quadro-recusa-servidor')
    const m = await mv(K.a31b); eq([m.estado, m.rota_id], ['pendente', ctx.R1], 'movimento apagado ' + K.a31b + ' alterado')
    ok(/N[ãa]o foi poss[ií]vel mover/.test(txt), 'sem mensagem de erro: ' + txt.slice(0, 200))
    // ao refrescar, o cartao apagado desaparece (nao fica fantasma); ate la voltou a celula original: ' + origin + ' -> ' + now
    return `celula original ${origin}; depois da recusa ${now}`
  })
  await C.bctx.close()

  setCaso('CASO 30')
  const AU = await open('qa.auditor.acc@example.test', process.env.QA_PASSWORD, '/contabilidade?view=board'); const up = AU.page
  await up.waitForSelector('[data-testid="board"]'); await pill(up, 'Tudo'); await sleep(1500)
  await t('Auditor no Quadro: aviso "Modo so leitura", cartoes nao arrastaveis, drag simulado nao altera a BD', async () => {
    const hint = await up.$eval('[data-testid="board"] p', (e) => e.innerText); ok(/s[óo] leitura/i.test(hint), 'sem aviso so leitura: ' + hint)
    await up.waitForSelector(`[data-movement="${K.a30}"]`, { timeout: 15000 })
    const dr = await up.$eval(`[data-movement="${K.a30}"]`, (e) => e.getAttribute('draggable')); ok(dr === null || dr === 'false', 'cartao arrastavel: ' + dr)
    const before = await mv(K.a30), a0 = await auditCount(K.a30), origin = await cellOf(up, K.a30)
    const r = await drag(up, K.a30, `${ctx.R1}|confirmado`); await sleep(1500)
    const after = await mv(K.a30); eq([after.estado, after.rota_id, await auditCount(K.a30), await cellOf(up, K.a30)], [before.estado, before.rota_id, a0, origin], 'drag simulado do Auditor alterou algo em ' + K.a30 + ' ' + JSON.stringify(r))
    await shot(up, 'quadro-auditor')
  })
  await t('Auditor: mesmo forcando um drop com dados no dataTransfer (sem dragstart) a BD nao muda e o cartao mantem-se', async () => {
    const before = await mv(K.a30)
    await up.evaluate((id, cell) => { const dt = new DataTransfer(); dt.setData('text/plain', id); const target = document.querySelector(`[data-cell="${cell}"]`); target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt })) }, K.a30, `${ctx.R1}|confirmado`)
    await sleep(2000); const after = await mv(K.a30); eq([after.estado, after.rota_id], [before.estado, before.rota_id], 'BD ' + K.a30)
    const txt = await up.$eval('[data-testid="board"]', (e) => e.innerText)
    return /N[ãa]o foi poss[ií]vel mover/.test(txt) ? 'a UI mostra erro' : 'nota: a UI tenta o PATCH num drop forcado e o servidor recusa em silencio (0 linhas por RLS, sem erro) - o cartao volta sem mensagem'
  })
  await AU.bctx.close()
} finally {
  await browser.close()
}
if (errors.length) console.log('\nERROS DE PAGINA:', [...new Set(errors)])
savectx(); dump('results-04.json')
