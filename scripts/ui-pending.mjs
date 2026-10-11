// Tema claro + alerta Pendente: contorno forte, pulso lento (unica animacao em loop) e reduced-motion.
//   1) npm run dev -- --port 5199     2) node scripts/ui-pending.mjs
import puppeteer from 'puppeteer-core'
import { mkdirSync, readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const BASE = process.env.BASE ?? 'http://localhost:5199'
const CHROME = process.env.CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const email = 'demo.admin@example.test'
const password = process.env.DEMO_PASSWORD
mkdirSync('.shots', { recursive: true })
const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8').split(/\r?\n/).filter((l) => l.includes('=')).map((l) => [l.split('=')[0], l.slice(l.indexOf('=') + 1).trim()]),
)
const api = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY, { auth: { persistSession: false } })
await api.auth.signInWithPassword({ email, password })
const uid = (await api.auth.getUser()).data.user.id
const original = (await api.from('profiles').select('tema').eq('id', uid).single()).data.tema
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] })
let failed = 0
const ok = (c, m) => {
  console.log(`  ${c ? 'OK  ' : 'FALHA'} ${m}`)
  if (!c) failed++
}
const lum = (rgb) => {
  const [r, g, b] = rgb.match(/\d+/g).slice(0, 3).map((v) => {
    v /= 255
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const ratio = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p)
  return (x + 0.05) / (y + 0.05)
}

async function run(name, theme, reduced, viewport) {
  console.log(`\n== ${name}`)
  await api.from('profiles').update({ tema: theme }).eq('id', uid)
  const ctx = await browser.createBrowserContext()
  const page = await ctx.newPage()
  await page.setViewport(viewport)
  if (reduced) await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }])
  await page.evaluateOnNewDocument((t) => localStorage.setItem('um.theme', t), theme)
  await page.goto(BASE, { waitUntil: 'networkidle2' })
  await page.type('input[type=email]', email)
  await page.type('input[type=password]', password)
  await page.click('button[type=submit]')
  await page.waitForFunction(() => document.querySelector('nav, header'), { timeout: 20000 })
  await page.goto(BASE + '/contabilidade', { waitUntil: 'networkidle2' })
  await new Promise((r) => setTimeout(r, 2500))
  const info = await page.evaluate(() => {
    const el = document.querySelector('.pending-outline')
    const cs = el && getComputedStyle(el)
    const loops = document
      .getAnimations()
      .filter((a) => a.effect.getComputedTiming().iterations === Infinity)
      .map((a) => a.animationName ?? a.constructor.name)
    const root = getComputedStyle(document.body)
    return {
      count: document.querySelectorAll('.pending-outline').length,
      border: cs && `${cs.borderTopWidth} ${cs.borderTopColor}`,
      shadow: cs && cs.boxShadow,
      anim: cs && cs.animationName,
      loops,
      bg: root.backgroundColor,
      fg: root.color,
      card: getComputedStyle(document.querySelector('main [class*=bg-card], [class*=bg-card]') ?? document.body).backgroundColor,
    }
  })
  console.log('  ', JSON.stringify(info))
  await page.screenshot({ path: `.shots/pending-${name}.png` })
  await ctx.close()
  return info
}

try {
  const V = { width: 1280, height: 900 }
  const light = await run('light', 'light', false, V)
  ok(light.count > 0, `há lançamentos Pendente visíveis (${light.count})`)
  ok(light.border === '2px rgb(220, 38, 38)', `claro: contorno 2px #dc2626 (${light.border})`)
  ok(/rgba?\(220, 38, 38/.test(light.shadow), `claro: glow vermelho (${light.shadow})`)
  ok(light.anim === 'pending-pulse', 'pulso ativo')
  ok(light.loops.length > 0 && light.loops.every((n) => n === 'pending-pulse'), `única animação em loop: ${light.loops.join(',') || '(nenhuma)'}`)
  ok(light.bg === 'rgb(221, 225, 230)', `fundo claro #dde1e6 (${light.bg})`)
  ok(ratio(light.fg, light.bg) >= 7, `texto legível sobre o fundo: contraste ${ratio(light.fg, light.bg).toFixed(1)}:1`)
  const dark = await run('dark', 'dark', false, V)
  ok(/^1(\.5)?px rgb\(239, 68, 68\)$/.test(dark.border), `escuro mantém 1.5px #ef4444 (o Chrome arredonda a 1px a 1x) (${dark.border})`)
  ok(dark.loops.every((n) => n === 'pending-pulse'), 'escuro: só o pulso em loop')
  const red = await run('light-reduced', 'light', true, V)
  ok(red.count > 0 && red.anim === 'none' && red.loops.length === 0, `reduzir movimento: contorno estático, nenhuma animação em loop (${red.anim}, ${red.loops.length})`)
  ok(red.border === '2px rgb(220, 38, 38)', 'reduzir movimento: o contorno mantém-se')
  await run('light-mobile', 'light', false, { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 })
} finally {
  await api.from('profiles').update({ tema: original }).eq('id', uid)
  await browser.close()
}
console.log(failed ? `\n${failed} FALHA(S)` : '\nPendente/tema claro: TUDO OK')
process.exit(failed ? 1 : 0)
