// Repro do timeout de `npm run test:ui:accounting` (2.o arrasto imediato do MESMO cartao). Compara arrasto imediato vs com espera.
import puppeteer from 'puppeteer-core'
import { ctx, loginAll, users, must, mvIns, mv, sql, sleep, t, setArea, setCaso, eq, ok, dump } from './h.mjs'
await loginAll(['admin', 'cont']); const { cont } = users
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', args: ['--no-sandbox'] })
const page = await (await browser.createBrowserContext()).newPage(); await page.setViewport({ width: 1366, height: 1000 })
await page.goto('http://localhost:5199', { waitUntil: 'networkidle2' }); await page.type('input[type=email]', 'qa.contabilista@example.test'); await page.type('input[type=password]', process.env.QA_PASSWORD); await page.click('button[type=submit]')
await page.waitForFunction(() => !document.querySelector('input[type=password]'))
await page.goto('http://localhost:5199/contabilidade?view=board', { waitUntil: 'networkidle2' }); await page.waitForSelector('[data-testid="board"]')
const pill = (text) => page.evaluate((tx) => { const b = [...document.querySelectorAll('button[aria-pressed]')].find((x) => x.innerText.trim().startsWith(tx)); b?.click(); return Boolean(b) }, text)
await pill('Tudo'); await sleep(1500)
const drag = (id, cell) => page.evaluate(async (i, c) => {
  const dt = new DataTransfer(); const card = document.querySelector(`[data-movement="${i}"]`); const target = document.querySelector(`[data-cell="${c}"]`)
  if (!card || !target) return { err: 'sem cartao/celula ' + !!card + '/' + !!target }
  const fire = (el, type) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }))
  fire(card, 'dragstart'); await new Promise((r) => setTimeout(r, 80)); fire(target, 'dragenter'); fire(target, 'dragover'); await new Promise((r) => setTimeout(r, 80)); fire(target, 'drop'); fire(card, 'dragend'); return { ok: true }
}, id, cell)
const cellOf = (id) => page.evaluate((i) => document.querySelector(`[data-movement="${i}"]`)?.closest('[data-cell]')?.getAttribute('data-cell') ?? null, id)
const waitCell = (id, c, to = 8000) => page.waitForFunction((i, cc) => document.querySelector(`[data-movement="${i}"]`)?.closest('[data-cell]')?.getAttribute('data-cell') === cc, { timeout: to }, id, c)
setArea('UI - arrasto consecutivo do mesmo cartao'); setCaso('CASO 29')
const tr = await must(mvIns(cont, { subcategoria: 'transferencia_distribuicao', valor: 900, pessoa_responsavel: 'QA-C-Kb', data: '2026-06-02', descricao: 'QA-C-kb-transf' }).single())
for (const wait of [0, 1500]) {
  await t(`Diagonal (Pendente R1 -> Geral|Confirmado) e logo a seguir (${wait}ms) outro arrasto do mesmo cartao para R2|Confirmado`, async () => {
    const a = await must(mvIns(cont, { subcategoria: 'outro', valor: 20, pessoa_responsavel: 'QA-C-Kb', lancamento_referencia_id: tr.id, data: '2026-06-02', operation_id: ctx.opLN, rota_id: ctx.R1, descricao: 'QA-C-kb-' + wait }).single())
    await page.reload({ waitUntil: 'networkidle2' }); await page.waitForSelector('[data-testid="board"]'); await pill('Tudo'); await sleep(1500)
    ok((await drag(a.id, '__geral|confirmado')).ok, 'drag1'); await waitCell(a.id, '__geral|confirmado'); await sleep(wait)
    const r2 = await drag(a.id, `${ctx.R2}|confirmado`); ok(r2.ok, JSON.stringify(r2))
    try { await waitCell(a.id, `${ctx.R2}|confirmado`) } catch { const m = await mv(a.id); throw new Error(`2.o arrasto do movimento ${a.id} nao aplicou (celula ${await cellOf(a.id)}; BD estado=${m.estado} rota=${m.rota_id}; espera ${wait}ms)`) }
    eq((await mv(a.id)).rota_id, ctx.R2, 'BD ' + a.id)
  })
}
await browser.close(); dump('results-09.json')
