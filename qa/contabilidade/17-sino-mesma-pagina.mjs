// B7 (sino): o link para /contabilidade?view=distribution funciona a partir de OUTRA pagina e a partir da propria Contabilidade?
import puppeteer from 'puppeteer-core'
import { loginAll, t, setArea, setCaso, eq, ok, sql, dump, sleep } from './h.mjs'
await loginAll(['cont'])
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', args: ['--no-sandbox'] })
const page = await (await browser.createBrowserContext()).newPage(); await page.setViewport({ width: 1366, height: 1000 })
await page.goto('http://localhost:5199', { waitUntil: 'networkidle2' }); await page.type('input[type=email]', 'qa.contabilista@example.test'); await page.type('input[type=password]', process.env.QA_PASSWORD); await page.click('button[type=submit]')
await page.waitForFunction(() => !document.querySelector('input[type=password]'), { timeout: 20000 }); await sleep(1500)
const active = () => page.evaluate(() => [...document.querySelectorAll('button[aria-pressed="true"]')].map((b) => b.innerText.trim()).filter((x) => /^(Lista|Por validar|Por ligar|Agrupado|Quadro|Distribuições|Contas|Definições)/.test(x)).map((x) => x.replace(/ \(\d+\)$/, '')))
const bell = async (re) => { await page.evaluate(() => document.querySelector('button[aria-label="Notificações"]').click()); await sleep(800); const r = await page.evaluate((src) => { const b = [...document.querySelectorAll('[role=dialog] li button')].find((x) => new RegExp(src).test(x.innerText)); if (b) b.click(); return b ? b.innerText : null }, re); await sleep(1500); return r }
setArea('B7 - sino'); setCaso('B7-sino')
await t('B7 Sino (Contabilista) a partir de OUTRA pagina (/): a notificacao allocation_unlinked abre a vista Distribuicoes', async () => {
  await page.goto('http://localhost:5199/', { waitUntil: 'networkidle2' }); await sleep(1500)
  const r = await bell('Alocação por ligar'); ok(r, 'sem notificacao'); eq([page.url().replace('http://localhost:5199', ''), await active()], ['/contabilidade?view=unlinked', ['Por ligar']], 'destino/vista')
})
await t('B7 Sino (Contabilista) estando JA na Contabilidade (Lista): a notificacao allocation_unlinked / movement_pending muda para a vista pedida', async () => {
  await page.goto('http://localhost:5199/contabilidade', { waitUntil: 'networkidle2' }); await page.waitForSelector('[data-kpi="pending"]'); await sleep(1000); eq(await active(), ['Lista'], 'inicio')
  const r = await bell('Alocação por ligar'); ok(r, 'sem notificacao'); const a = await active(); const url = page.url().replace('http://localhost:5199', '')
  eq([url, a], ['/contabilidade?view=unlinked', ['Por ligar']], 'URL ' + url + ' mas a vista ativa e ' + JSON.stringify(a))
})
await t('B7 Sino (pre-existente) movement_pending -> /contabilidade?view=validate estando ja na Lista', async () => {
  await page.goto('http://localhost:5199/contabilidade', { waitUntil: 'networkidle2' }); await page.waitForSelector('[data-kpi="pending"]'); await sleep(800)
  const r2 = await bell('por validar|Por validar'); if (!r2) return 'sem notificacao movement_pending para comparar'
  const a2 = await active(); eq(a2, ['Por validar'], 'movement_pending estando na Lista: vista ativa ' + JSON.stringify(a2) + ' (texto: ' + r2.replace(/\n/g, ' ') + ')')
})
await browser.close(); dump('results-17.json')
