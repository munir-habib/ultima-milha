// UI (Chrome headless, dev server em :5199): cada papel so alcanca as paginas permitidas (URL directo incluido).
import puppeteer from 'puppeteer-core'
import { t, setArea, save } from './lib.mjs'

const BASE = process.env.BASE ?? 'http://localhost:5199'
const CHROME = process.env.CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PATHS = ['/', '/registar', '/historico', '/viaturas', '/contabilidade', '/definicoes', '/relatorio']
const OPS = ['/', '/registar', '/historico', '/viaturas', '/definicoes', '/relatorio']
const CASES = [
  ['qa.motorista', ['/registar']],
  ['qa.contabilista', ['/contabilidade', '/definicoes']],
  ['qa.auditor', ['/', '/historico', '/viaturas', '/definicoes', '/relatorio']],
  ['qa.auditor.acc', ['/', '/historico', '/viaturas', '/contabilidade', '/definicoes', '/relatorio']],
  ['qa.operador', OPS],
  ['qa.gestor', OPS],
]
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] })
setArea('UI - acesso por papel (navegacao directa por URL)')
for (const [user, allowed] of CASES) {
  await t(`${user}: alcanca exatamente ${allowed.join(' ')}; as restantes redirecionam`, async () => {
    const ctx = await browser.createBrowserContext(); const page = await ctx.newPage()
    await page.goto(BASE, { waitUntil: 'networkidle2' })
    await page.waitForSelector('input[type=email]'); await page.type('input[type=email]', user + '@example.test'); await page.type('input[type=password]', process.env.QA_PASSWORD); await page.click('button[type=submit]')
    await page.waitForFunction(() => !document.querySelector('input[type=password]'), { timeout: 20000 })
    const bad = []
    for (const p of PATHS) {
      await page.goto(BASE + p, { waitUntil: 'networkidle2' }); await new Promise((r) => setTimeout(r, 500))
      const at = new URL(page.url()).pathname
      const reached = at === p
      if (allowed.includes(p) !== reached) bad.push(`${p} -> ${at} (${allowed.includes(p) ? 'devia estar acessivel' : 'devia ser recusado'})`)
    }
    const links = await page.evaluate(() => [...document.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')))
    const navLeak = user === 'qa.motorista' ? links.filter((h) => ['/', '/historico', '/viaturas', '/contabilidade', '/relatorio'].includes(h)) : []
    await ctx.close()
    if (bad.length || navLeak.length) throw new Error(user + ': ' + bad.join('; ') + (navLeak.length ? ' | motorista ve links de menu: ' + navLeak.join(',') : ''))
  })
}
await browser.close()
save('./results-07.json')
