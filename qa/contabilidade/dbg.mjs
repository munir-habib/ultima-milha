import puppeteer from 'puppeteer-core'
import { sql } from '../lib.mjs'
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', args: ['--no-sandbox'] })
const page = await (await browser.createBrowserContext()).newPage(); await page.setViewport({ width: 1366, height: 1000 })
await page.goto('http://localhost:5199', { waitUntil: 'networkidle2' }); await page.type('input[type=email]', 'qa.contabilista@example.test'); await page.type('input[type=password]', process.env.QA_PASSWORD); await page.click('button[type=submit]')
await page.waitForFunction(() => !document.querySelector('input[type=password]')); await page.goto('http://localhost:5199/contabilidade', { waitUntil: 'networkidle2' })
await page.waitForSelector('[data-kpi="pending"]'); await new Promise(r => setTimeout(r, 3000))
console.log(await page.evaluate(() => [...document.querySelectorAll('select')].map((s) => ({ label: s.getAttribute('aria-label'), parent: s.parentElement.innerText.slice(0,40), opts: [...s.options].map((o) => o.text).slice(0,5) }))));console.log(await page.evaluate(() => ({ u1: !!document.querySelector('[data-movement="a03dfe27-cf88-4024-9518-fbc0235d5d75"]'), all: document.querySelectorAll('[data-movement]').length, n: document.querySelectorAll('[data-testid="unlinked-view"] [data-movement]').length, first: document.querySelector('[data-testid="unlinked-view"] [data-movement]')?.innerText, pressed: [...document.querySelectorAll('button[aria-pressed=true]')].map(b=>b.innerText) })))
console.log(await sql(`select count(*)::int n from movements where deleted_at is null and lancamento_referencia_id is not null and tipo='debito' and operation_id is not null and rota_id is not null and registo_id is null and not sem_registo_previsto`))
await browser.close()
