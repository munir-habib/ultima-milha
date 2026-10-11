// Transicao de entrada (login -> app): sequencia completa, so em arranque frio, temas, mobile/desktop, "reduzir movimento".
//   1) npm run dev -- --port 5199     2) node scripts/ui-transition.mjs
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
const ORIGINAL_THEME = (await api.from('profiles').select('tema').eq('id', uid).single()).data.tema

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] })
let failed = 0
const ok = (cond, msg) => {
  console.log(`  ${cond ? 'OK  ' : 'FALHA'} ${msg}`)
  if (!cond) failed++
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Gravador de linha do tempo: um registo por frame com o estado visivel da sequencia.
const RECORDER = () => {
  window.__tl = []
  // icone mais visivel (opacidade calculada > .5) ou null
  window.__topIcon = (ov) => {
    let best = null
    let bo = 0.5
    for (const el of ov.querySelectorAll('.entry-icon')) {
      const o = parseFloat(getComputedStyle(el).opacity)
      if (o > bo) {
        bo = o
        best = el.getAttribute('data-icon')
      }
    }
    return best
  }
  const t0 = performance.now()
  const tick = () => {
    const ov = document.querySelector('[data-testid=entry-overlay]')
    const app = document.querySelector('.entry-app-hidden, .entry-app-reveal')
    window.__tl.push({
      t: Math.round(performance.now() - t0),
      login: !!document.querySelector('input[type=password]'),
      leaving: !!document.querySelector('.entry-login-leave'),
      overlay: !!ov,
      fading: ov?.getAttribute('data-fading') === 'true',
      icon: ov ? window.__topIcon(ov) : null,
      hidden: !!document.querySelector('.entry-app-hidden'),
      reveal: !!document.querySelector('.entry-app-reveal'),
      appShown: !!document.querySelector('nav, header') && !app?.classList.contains('entry-app-hidden'),
    })
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}

async function open(name, viewport, theme, { reduced = false, force = true } = {}) {
  await setTheme(theme)
  const ctx = await browser.createBrowserContext()
  const page = await ctx.newPage()
  await page.setViewport(viewport)
  if (reduced) await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }])
  await page.evaluateOnNewDocument(
    (t, f) => {
      localStorage.setItem('um.theme', t)
      if (f) localStorage.setItem('um.entry', 'force')
    },
    theme,
    force,
  )
  await page.evaluateOnNewDocument(RECORDER)
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(BASE, { waitUntil: 'networkidle2' })
  return { page, ctx, errors }
}

const timeline = (page) => page.evaluate(() => window.__tl)
const submit = async (page) => {
  await page.waitForSelector('input[type=email]')
  await page.type('input[type=email]', email)
  await page.type('input[type=password]', password)
  await page.evaluate(() => (window.__tl.length = 0))
  await page.click('button[type=submit]')
}

async function fullSequence(name, viewport, theme) {
  console.log(`\n== ${name}: login manual (${viewport.width}px, tema ${theme})`)
  const { page, ctx, errors } = await open(name, viewport, theme)
  await submit(page)
  await page.waitForSelector('[data-testid=entry-overlay]', { timeout: 15000 })
  await sleep(120)
  await page.screenshot({ path: `.shots/entry-${name}-loader.png` }) // captura cedo: o overlay ainda esta opaco
  const activeNow = await page.evaluate(() => [...document.querySelectorAll('.entry-icon')].filter((e) => parseFloat(getComputedStyle(e).opacity) > 0.95).length)
  const centered = await page.evaluate(() => {
    const c = document.querySelector('.entry-circle').getBoundingClientRect()
    const top = [...document.querySelectorAll('.entry-icon')].sort((x, y) => parseFloat(getComputedStyle(y).opacity) - parseFloat(getComputedStyle(x).opacity))[0]
    const i = top.querySelector('svg').getBoundingClientRect()
    return Math.abs(c.x + c.width / 2 - (i.x + i.width / 2)) < 1.5 && Math.abs(c.y + c.height / 2 - (i.y + i.height / 2)) < 1.5
  })
  await page.waitForFunction(() => !document.querySelector('[data-testid=entry-overlay]') && document.querySelector('nav, header'), { timeout: 8000 })
  await sleep(200)
  const tl = await timeline(page)
  const first = (f) => tl.findIndex(f)
  const iLeave = first((r) => r.leaving)
  const iOverlay = first((r) => r.overlay)
  const iReveal = first((r) => r.reveal)
  const iGone = tl.findIndex((r, i) => i > iOverlay && iOverlay >= 0 && !r.overlay)
  ok(iLeave >= 0, 'fase 1: o cartao de login encolhe/desvanece')
  ok(iOverlay > iLeave, 'fase 2: o ecra de transicao aparece depois da fase 1')
  const icons = [...new Set(tl.filter((r) => r.icon !== null).map((r) => r.icon))]
  ok(icons.length >= 3, `fase 2: os icones alternam (${icons.join(',')})`)
  ok(activeNow <= 1, 'um icone ativo de cada vez')
  ok(centered, 'o icone ativo esta centrado no circulo')
  const loaderMs = tl[iReveal]?.t - tl[iOverlay]?.t
  ok(loaderMs >= 500 && loaderMs <= 1400, `fase 2 dura ${loaderMs} ms (config 800; margem: o dev server monta a app por baixo e atrasa temporizadores)`)
  ok(iReveal > iOverlay && tl.slice(iOverlay, iReveal).every((r) => !r.appShown), 'a app nao aparece durante a fase 2')
  ok(iGone > iReveal, 'fase 3: o ecra de transicao desvanece e sai')
  const end = tl[tl.length - 1]
  ok(!end.overlay && !end.hidden && !end.reveal && !end.login, 'estado final limpo: app visivel, sem overlay, sem classes de animacao')
  ok(errors.length === 0, `sem erros de pagina ${errors.join('|')}`)
  await sleep(100)
  await page.screenshot({ path: `.shots/entry-${name}-app.png` })

  // navegacao dentro da app: nunca volta a tocar
  console.log(`-- ${name}: navegacao interna nao repete`)
  await page.evaluate(() => (window.__tl.length = 0))
  for (const href of ['/historico', '/viaturas', '/']) {
    await page.evaluate((h) => {
      const a = document.querySelector(`a[href="${h}"]`)
      if (a) a.click()
      else {
        history.pushState({}, '', h)
        dispatchEvent(new PopStateEvent('popstate'))
      }
    }, href)
    await sleep(500)
  }
  const nav = await timeline(page)
  ok(nav.length > 20 && nav.every((r) => !r.overlay && !r.hidden && !r.reveal && !r.leaving), 'trocar de ecra nao dispara a transicao')

  // sessao guardada: reabrir a app -> so a fase 2 (+3), sem login
  console.log(`-- ${name}: reabrir com sessao guardada`)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => !document.querySelector('[data-testid=entry-overlay]') && document.querySelector('nav, header'), { timeout: 15000 })
  const tl2 = await timeline(page)
  ok(tl2.some((r) => r.overlay), 'arranque frio com sessao: o ecra de transicao toca')
  ok(tl2.every((r) => !r.login && !r.leaving), 'sem cartao de login nem fase 1')
  ok(tl2.filter((r) => r.overlay).length > 0 && tl2.filter((r) => r.icon !== null).length > 0, 'os icones correm')
  await ctx.close()
}

async function reduced(name, viewport) {
  console.log(`\n== ${name}: prefers-reduced-motion`)
  const { page, ctx, errors } = await open(name, viewport, 'dark', { reduced: true })
  await submit(page)
  await page.waitForFunction(() => !document.querySelector('input[type=password]') && document.querySelector('nav, header'), { timeout: 15000 })
  await sleep(600)
  const tl = await timeline(page)
  ok(tl.every((r) => !r.overlay && !r.hidden && !r.reveal && !r.leaving), 'sem transicao (nem overlay, nem ocultacao, nem animacao) — vai direto para a app')
  const end = tl[tl.length - 1]
  ok(end.appShown && !end.overlay, 'a app esta visivel e nada ficou a meio')
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => document.querySelector('nav, header'), { timeout: 15000 })
  const tl2 = await timeline(page)
  ok(tl2.every((r) => !r.overlay && !r.hidden), 'sessao guardada + reduzir movimento: tambem direto')
  ok(errors.length === 0, 'sem erros de pagina')
  await ctx.close()
}

async function automationSkips() {
  console.log('\n== automatizacao sem um.entry=force: salta (os outros testes E2E nao esperam 1 s por login)')
  const { page, ctx } = await open('auto', { width: 1280, height: 800 }, 'dark', { force: false })
  await submit(page)
  await page.waitForFunction(() => !document.querySelector('input[type=password]') && document.querySelector('nav, header'), { timeout: 15000 })
  const tl = await timeline(page)
  ok(tl.every((r) => !r.overlay), 'sem transicao')
  await ctx.close()
}

async function keyframesOnlyTransformOpacity() {
  console.log('\n== keyframes da transicao: so transform e opacity')
  const { page, ctx } = await open('css', { width: 800, height: 600 }, 'dark')
  const props = await page.evaluate(() => {
    const out = {}
    for (const sheet of document.styleSheets)
      for (const rule of sheet.cssRules)
        if (rule.type === CSSRule.KEYFRAMES_RULE && rule.name.startsWith('entry-'))
          out[rule.name] = [...new Set([...rule.cssRules].flatMap((k) => [...k.style]))]
    return out
  })
  const names = Object.keys(props)
  ok(names.length >= 5, `keyframes encontradas: ${names.join(', ')}`)
  ok(
    Object.values(props).every((ps) => ps.every((p) => p === 'opacity' || p === 'transform')),
    'nenhuma anima largura/altura/margens (so opacity/transform)',
  )
  await ctx.close()
}

const DESKTOP = { width: 1280, height: 800 }
const MOBILE = { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }
try {
  for (const theme of ['dark', 'light']) {
    await fullSequence(`desktop-${theme}`, DESKTOP, theme)
    await fullSequence(`mobile-${theme}`, MOBILE, theme)
  }
  await reduced('reduced-desktop', DESKTOP)
  await reduced('reduced-mobile', MOBILE)
  await automationSkips()
  await keyframesOnlyTransformOpacity()
} finally {
  await setTheme(ORIGINAL_THEME)
  await browser.close()
}
console.log(failed ? `\n${failed} FALHA(S)` : '\nTransicao de entrada: TUDO OK')
process.exit(failed ? 1 : 0)
