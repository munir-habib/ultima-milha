// Teste de fumo da UI real: entra com o admin demo, percorre os ecras (desktop e mobile),
// falha se houver erros na consola/pagina e guarda capturas em .shots/
//   1) npm run dev -- --port 5199     2) node scripts/ui-smoke.mjs
import puppeteer from 'puppeteer-core'
import { mkdirSync, readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const BASE = process.env.BASE ?? 'http://localhost:5199'
const CHROME = process.env.CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const [email = 'demo.admin@example.test', password = process.env.DEMO_PASSWORD] = process.argv.slice(2)
mkdirSync('.shots', { recursive: true })

const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8').split(/\r?\n/).filter((l) => l.includes('=')).map((l) => [l.split('=')[0], l.slice(l.indexOf('=') + 1).trim()]),
)
const api = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY, { auth: { persistSession: false } })
await api.auth.signInWithPassword({ email, password })
const uid = (await api.auth.getUser()).data.user.id
const setTheme = (tema) => api.from('profiles').update({ tema }).eq('id', uid)

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] })
const errors = []
let failed = 0

async function session(name, viewport, theme, extra) {
  await setTheme(theme) // a preferencia guardada no perfil (BD) e a que vale depois do login
  const ctx = await browser.createBrowserContext()
  const page = await ctx.newPage()
  await page.setViewport(viewport)
  page.on('pageerror', (e) => errors.push(`[${name}] pageerror: ${e.message}`))
  page.on('console', (m) => {
    if (m.type() === 'error' && !/favicon|Failed to load resource.*(404|401)|net::ERR/.test(m.text())) errors.push(`[${name}] console: ${m.text()}`)
  })
  await page.evaluateOnNewDocument((t) => localStorage.setItem('um.theme', t), theme)
  await page.goto(BASE, { waitUntil: 'networkidle2' })

  // login
  await page.waitForSelector('input[type=email]')
  await page.type('input[type=email]', email)
  await page.type('input[type=password]', password)
  await page.click('button[type=submit]')
  await page.waitForFunction(() => !document.querySelector('input[type=password]'), { timeout: 20000 })

  const shot = async (label) => {
    await new Promise((r) => setTimeout(r, 1800)) // deixa os pedidos e graficos assentarem
    await page.screenshot({ path: `.shots/${name}-${label}.png`, fullPage: true })
    console.log('  captura', `${name}-${label}`)
  }
  const go = async (path, label, expect) => {
    await page.goto(BASE + path, { waitUntil: 'networkidle2' })
    if (expect) {
      const ok = await page.waitForFunction((t) => document.body.innerText.includes(t), { timeout: 15000 }, expect).then(() => true, () => false)
      if (!ok) {
        failed++
        console.log(`  FALHA ${name} ${path}: texto "${expect}" nao apareceu`)
      }
    }
    await shot(label)
  }

  await go('/', 'dashboard', 'Receita')
  await go('/registar', 'registar')
  await go('/historico', 'historico', 'Rota A')
  await go('/viaturas', 'viaturas', '12-AB-34')
  await go('/definicoes', 'definicoes', 'Preferências')
  await go('/contabilidade', 'contabilidade', 'Conta Principal')
  await go('/relatorio?p=thisMonth', 'relatorio', 'Resumo executivo')
  if (extra) await extra(page)
  await ctx.close()
}

try {
  await session('desktop-dark', { width: 1366, height: 900 }, 'dark', async (page) => {
    // ---- fluxo: registar um dia, rascunho automatico, receita calculada no servidor ----
    const day = new Date(Date.now() + 86400000 * 3).toISOString().slice(0, 10)
    await page.goto(BASE + '/registar?data=' + day, { waitUntil: 'networkidle2' })
    await page.waitForFunction(() => [...document.querySelectorAll('label')].some((l) => l.innerText.trim().startsWith('Rota') && l.querySelector('select option:nth-child(2)')))
    const routeSel = await page.evaluateHandle(() => [...document.querySelectorAll('label')].find((l) => l.innerText.trim().startsWith('Rota'))?.querySelector('select'))
    const routeId = await page.evaluate((el) => [...el.options].find((o) => o.textContent.includes('Rota A'))?.value, routeSel)
    await routeSel.asElement().select(routeId)
    await page.waitForFunction(() => document.body.innerText.includes('Receita do dia'), { timeout: 15000 })
    const num = async (label, value) => {
      const input = await page.evaluateHandle((l) => [...document.querySelectorAll('label')].find((x) => x.innerText.trim().startsWith(l))?.querySelector('input'), label)
      await input.asElement().click({ clickCount: 3 })
      await input.asElement().type(value)
    }
    await num('Entregues', '10')
    await num('Devoluções', '4')
    await num('Km', '80')
    // rascunho automatico: espera pelo "guardado" e pela receita devolvida pelo servidor
    // 10*1,80 + 4*0,90 + valor fixo 35 (pre-preenchido pelo default da rota) = 56,60 EUR
    const saved = await page.waitForFunction(() => /56,60/.test(document.body.innerText) && document.body.innerText.includes('Rascunho guardado'), { timeout: 15000 }).then(() => true, () => false)
    console.log(saved ? '  ok   registo: rascunho automatico gravou e o servidor calculou 56,60 EUR' : '  FALHA registo: nao gravou / receita inesperada')
    if (!saved) failed++
    await page.screenshot({ path: '.shots/desktop-dark-registo-preenchido.png', fullPage: true })
    // submeter
    await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.innerText.trim() === 'Submeter')?.click())
    const submitted = await page.waitForFunction(() => document.body.innerText.includes('Submetido'), { timeout: 10000 }).then(() => true, () => false)
    console.log(submitted ? '  ok   registo: submetido' : '  FALHA registo: nao ficou Submetido')
    if (!submitted) failed++
    // limpeza: soft delete (nada se apaga fisicamente)
    const { data } = await api.from('daily_records').select('id').eq('route_id', routeId).eq('data', day)
    for (const r of data ?? []) await api.from('daily_records').update({ deleted_at: new Date().toISOString() }).eq('id', r.id)
  })
  await session('mobile-dark', { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }, 'dark')
  await session('desktop-light', { width: 1366, height: 900 }, 'light')
} finally {
  await setTheme('dark')
  await browser.close()
}

if (errors.length) {
  console.log('\nERROS na consola/pagina:')
  for (const e of [...new Set(errors)]) console.log(' -', e)
}
console.log(errors.length || failed ? '\nUI SMOKE: FALHOU' : '\nUI SMOKE: OK')
process.exitCode = errors.length || failed ? 1 : 0

