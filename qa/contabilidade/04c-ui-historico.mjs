// Caso 14 (UI): historico de versoes no detalhe do lancamento; caso 22 (UI): so o Super Admin tem "Apagar".
import puppeteer from 'puppeteer-core'
import { ctx, loginAll, users, t, setCaso, setArea, eq, ok, sql, dump, sleep } from './h.mjs'
const BASE = 'http://localhost:5199', CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
await loginAll()
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] })
const pill = (page, text) => page.evaluate((tx) => { const b = [...document.querySelectorAll('button[aria-pressed]')].find((x) => x.innerText.trim().startsWith(tx)); b?.click(); return Boolean(b) }, text)
async function open(email, pw) {
  const bctx = await browser.createBrowserContext(); const page = await bctx.newPage(); await page.setViewport({ width: 1366, height: 1000 })
  await page.goto(BASE, { waitUntil: 'networkidle2' }); await page.type('input[type=email]', email); await page.type('input[type=password]', pw); await page.click('button[type=submit]')
  await page.waitForFunction(() => !document.querySelector('input[type=password]'), { timeout: 20000 })
  await page.goto(BASE + '/contabilidade', { waitUntil: 'networkidle2' }); await page.waitForSelector('[data-kpi="pending"]'); await pill(page, 'Tudo'); await sleep(1200)
  return { page, bctx }
}
try {
  const act = (await sql(`select id from movements where registo_id='${ctx.c2.r13}' and custo_tipo='combustivel' and deleted_at is null`))[0].id
  setArea('UI - historico e apagar'); setCaso('CASO 14')
  for (const [who, email, pw] of [['Contabilista', 'qa.contabilista@example.test', process.env.QA_PASSWORD], ['Super Admin', 'demo.admin@example.test', process.env.DEMO_PASSWORD]]) {
    const P = await open(email, pw); const pg = P.page
    await t(`UI (${who}): detalhe do lancamento automatico ativo ${act} mostra o Historico de versoes (15 versoes: 1 ativa + 14 substituidas com motivo)`, async () => {
      await pg.waitForSelector(`[data-movement="${act}"]`, { timeout: 20000 }); await pg.click(`[data-movement="${act}"]`); await pg.waitForSelector('[role=dialog]'); await sleep(1500)
      const r = await pg.evaluate(() => { const li = [...document.querySelectorAll('[role=dialog] ol li')].map((x) => x.innerText.replace(/\n/g, ' ')); return { li, h: [...document.querySelectorAll('[role=dialog] h3')].map((x) => x.innerText) } })
      eq(r.li.length, 15, 'versoes na UI ' + JSON.stringify(r.h)); ok(r.li.filter((x) => /substituída — substituído por edição/.test(x)).length === 14 && r.li.filter((x) => /ativa/.test(x)).length === 1, 'texto das versoes: ' + r.li.slice(0, 2).join(' | '))
      await pg.screenshot({ path: new URL('./shots/historico-versoes.png', import.meta.url).pathname.replace(/^\//, '') })
    })
    setCaso('CASO 22')
    await t(`UI (${who}): botao "Apagar" no detalhe: ${who === 'Super Admin' ? 'visivel' : 'ausente'}`, async () => {
      const btns = await pg.evaluate(() => [...document.querySelectorAll('[role=dialog] button')].map((b) => b.innerText.trim()))
      const has = btns.some((b) => /^Apagar/.test(b)); eq(has, who === 'Super Admin', 'botoes: ' + JSON.stringify(btns))
    })
    setCaso('CASO 14'); await P.bctx.close()
  }
} finally { await browser.close() }
dump('results-04c.json')
