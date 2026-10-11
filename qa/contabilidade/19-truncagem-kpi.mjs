// Com 3000 movimentos ativos: o que a UI carrega/mostra? (PostgREST devolve no maximo 1000 linhas por pedido)
import puppeteer from 'puppeteer-core'
import { T, sql, sleep } from './h.mjs'
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', args: ['--no-sandbox'] })
const page = await (await browser.createBrowserContext()).newPage(); await page.setViewport({ width: 1366, height: 1000 })
await page.goto('http://localhost:5199', { waitUntil: 'networkidle2' }); await page.type('input[type=email]', 'qa.contabilista@example.test'); await page.type('input[type=password]', process.env.QA_PASSWORD); await page.click('button[type=submit]')
await page.waitForFunction(() => !document.querySelector('input[type=password]'), { timeout: 20000 })
await page.goto('http://localhost:5199/contabilidade', { waitUntil: 'networkidle2' }); await page.waitForSelector('[data-kpi="pending"]'); await sleep(2500)
await page.evaluate(() => [...document.querySelectorAll('button[aria-pressed]')].find((x) => x.innerText.trim().startsWith('Tudo'))?.click()); await sleep(2500)
const ui = await page.evaluate(() => ({ cards: document.querySelectorAll('[data-movement]').length, debits: Number(document.querySelector('[data-kpi="debits"]').getAttribute('data-value')), credits: Number(document.querySelector('[data-kpi="credits"]').getAttribute('data-value')), warn: document.querySelector('[data-testid="truncated-warning"]') !== null }))
const db = (await sql(`select count(*)::int n, sum(case when tipo='debito' and estado='confirmado' then valor else 0 end)::float d from movements where tenant_id='${T}' and deleted_at is null`))[0]
console.log(JSON.stringify({ ui, bd: db }))
await browser.close()
