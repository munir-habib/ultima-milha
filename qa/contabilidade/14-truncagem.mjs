// B1: aviso "Só se mostram os 3000 movimentos mais recentes" (data-testid="truncated-warning").
// Insere movimentos QA-C-bulk (datas antigas) ate o tenant ter 2999 ativos (sem aviso) e depois 3000 (com aviso). Limpeza: qa/cleanup.sql (descricao QA-%).
import puppeteer from 'puppeteer-core'
import { ctx, T, loginAll, users, t, setCaso, setArea, eq, ok, must, sql, dump, sleep } from './h.mjs'
await loginAll(['cont']); const { cont } = users
const BASE = 'http://localhost:5199'
const active = async () => (await sql(`select count(*)::int n from movements where tenant_id='${T}' and deleted_at is null`))[0].n
const insertN = async (n, tag) => { let done = 0; while (done < n) { const k = Math.min(500, n - done); const rows = Array.from({ length: k }, (_, i) => ({ tenant_id: T, data: '2026-01-01', conta_id: ctx.contaA, tipo: 'debito', valor: 1, subcategoria: 'outro', descricao: `QA-C-bulk-${tag}-${done + i}` })); await must(cont.from('movements').insert(rows).select('id')); done += k } }
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', args: ['--no-sandbox'] })
const bctx = await browser.createBrowserContext(); const page = await bctx.newPage(); await page.setViewport({ width: 1366, height: 1000 })
await page.goto(BASE, { waitUntil: 'networkidle2' }); await page.type('input[type=email]', 'qa.contabilista@example.test'); await page.type('input[type=password]', process.env.QA_PASSWORD); await page.click('button[type=submit]')
await page.waitForFunction(() => !document.querySelector('input[type=password]'), { timeout: 20000 })
const view = async () => { await page.goto(BASE + '/contabilidade', { waitUntil: 'networkidle2' }); await page.waitForSelector('[data-kpi="pending"]', { timeout: 30000 }); await sleep(2500); return page.evaluate(() => ({ w: document.querySelector('[data-testid="truncated-warning"]')?.innerText ?? null, cards: document.querySelectorAll('[data-movement]').length })) }
setArea('B1 - truncagem a 3000'); setCaso('B1')
const n0 = await active(); const missing = 2999 - n0; ok(missing >= 0, 'ja ha mais de 2999 movimentos ativos: ' + n0)
await insertN(missing, 'a'); eq(await active(), 2999, 'ativos apos 1.a insercao')
let v1
await t('B1 com 2999 movimentos ativos NAO aparece o aviso de truncagem', async () => { v1 = await view(); eq(v1.w, null, 'aviso com 2999 movimentos') })
await insertN(1, 'b'); eq(await active(), 3000, 'ativos apos 2.a insercao')
await t('B1 com 3000 movimentos ativos aparece o aviso "Só se mostram os 3000 movimentos mais recentes: os totais e os saldos podem estar incompletos."', async () => {
  const v = await view(); ok(v.w && /3000/.test(v.w) && /mais recentes/.test(v.w) && /incompletos/.test(v.w), 'aviso: ' + JSON.stringify(v.w)); return `cartoes na Lista (mes corrente): ${v.cards}; aviso: ${v.w.replace(/\n/g, ' ')}`
})
await browser.close()
dump('results-14.json')
