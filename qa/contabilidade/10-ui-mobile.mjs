// Quadro em toque (bottom sheet): equivalente ao trecho mobile de scripts/ui-accounting.mjs (que aborta antes por corrida do 2.o arrasto imediato).
import puppeteer from 'puppeteer-core'
import { ctx, loginAll, users, must, mvIns, mv, sql, sleep, t, setArea, setCaso, eq, ok, dump } from './h.mjs'
await loginAll(['cont']); const { cont } = users
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', args: ['--no-sandbox'] })
const m = await (await browser.createBrowserContext()).newPage(); await m.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 })
await m.goto('http://localhost:5199', { waitUntil: 'networkidle2' }); await m.type('input[type=email]', 'qa.contabilista@example.test'); await m.type('input[type=password]', process.env.QA_PASSWORD); await m.click('button[type=submit]')
await m.waitForFunction(() => !document.querySelector('input[type=password]'), { timeout: 20000 })
m.on('response', async (r) => { if (r.request().method() === 'PATCH') console.log('PATCH', r.status(), r.url().slice(-80), String(r.request().postData()).slice(0,160), (await r.text().catch(() => '')).slice(0,200)) }); m.on('console', (c) => { if (c.type() === 'error') console.log('CONSOLE', c.text().slice(0,200)) }); setArea('UI - Quadro em toque'); setCaso('CASO 27-29 (toque)')
const tr = await must(mvIns(cont, { subcategoria: 'transferencia_distribuicao', valor: 900, pessoa_responsavel: 'QA-C-Mob', data: '2026-06-03', descricao: 'QA-C-mob-transf' }).single())
const a = await must(mvIns(cont, { subcategoria: 'outro', valor: 25, pessoa_responsavel: 'QA-C-Mob', lancamento_referencia_id: tr.id, data: '2026-06-03', operation_id: ctx.opLN, rota_id: ctx.R1, descricao: 'QA-C-mob-a' }).single())
await m.goto('http://localhost:5199/contabilidade?view=board', { waitUntil: 'networkidle2' }); await m.waitForSelector('[data-testid="board"]')
await m.evaluate(() => [...document.querySelectorAll('button[aria-pressed]')].find((x) => x.innerText.trim().startsWith('Tudo'))?.click())
await m.waitForSelector(`[data-movement="${a.id}"]`, { timeout: 15000 }); await sleep(1500)
await t('Toque: sem drag, aviso "Toca num cartao"; tocar abre "Mover lancamento"; escolher coluna Confirmado + linha R2 (diagonal) e Aplicar: 1 so entrada de audit, estado e rota mudam', async () => {
  const hint = await m.evaluate(() => document.querySelector('[data-testid="board"] p')?.innerText); ok(/Toca num cart/.test(hint ?? ''), 'hint: ' + hint)
  const dr = await m.evaluate((id) => document.querySelector(`[data-movement="${id}"]`).getAttribute('draggable'), a.id); ok(dr === null || dr === 'false', 'arrastavel no toque')
  const a0 = (await sql(`select count(*)::int n from audit_log where tabela='movements' and registo_id='${a.id}'`))[0].n
  await m.evaluate((id) => document.querySelector(`[data-movement="${id}"]`).scrollIntoView({ block: 'center', inline: 'center' }), a.id)
  console.log("ALVO", a.id); await m.evaluate((id) => document.querySelector(`[data-movement="${id}"]`).click(), a.id); await m.waitForFunction(() => document.body.innerText.includes('Mover lançamento'), { timeout: 10000 })
  const labels = await m.evaluate(() => [...document.querySelectorAll('[role=dialog] label')].map((l) => l.innerText.split('\n')[0]))
  await m.evaluate((r) => {
    const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
    const pick = (start, val) => { const sel = [...document.querySelectorAll('[role=dialog] label')].find((l) => l.innerText.startsWith(start))?.querySelector('select'); set.call(sel, val); sel.dispatchEvent(new Event('change', { bubbles: true })) }
    pick('Coluna', 'confirmado'); pick('Linha', r)
  }, ctx.R2)
  console.log('SELS', JSON.stringify(await m.evaluate(() => [...document.querySelectorAll('[role=dialog] select')].map((x) => [x.value, [...x.options].map((o) => o.value.slice(0,8)+':'+o.text)]))))
  await m.evaluate(() => [...document.querySelectorAll('[role=dialog] button')].find((b) => b.innerText.trim() === 'Aplicar')?.click())
  const t0 = Date.now(); let st; for (let k = 0; k < 6; k++) { st = await mv(a.id); if (st.estado === 'confirmado') break; await sleep(2000) } console.log('APPLY->BD ms', Date.now() - t0, st.estado)
  await m.waitForFunction((i) => !document.querySelector(`[data-movement="${i}"]`)?.hasAttribute('data-pending'), { timeout: 15000 }, a.id); await sleep(800)
  const x = await mv(a.id); eq([x.estado, x.rota_id, x.validado_por], ['confirmado', ctx.R2, cont.uid], `movimento ${a.id}; labels ${JSON.stringify(labels)}`)
  eq((await sql(`select count(*)::int n from audit_log where tabela='movements' and registo_id='${a.id}'`))[0].n - a0, 1, 'entradas de audit')
})
await browser.close(); dump('results-10.json')
