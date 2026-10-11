// Dashboard com >1000 registos diarios na janela de dados (periodo + periodo anterior): os totais da UI batem com a BD.
// Cria (SQL como postgres) 30 rotas QA-C-DB-n x 40 dias = 1200 registos; limpeza via qa/cleanup.sql (rotas QA-%, registos das rotas QA-%).
import puppeteer from 'puppeteer-core'
import { ctx, sql } from './h.mjs'
const today = (await sql('select app.today()::text d'))[0].d
const have = (await sql(`select count(*)::int n from routes where nome like 'QA-C-DB-%' and deleted_at is null`))[0].n
if (have < 30) await sql(`insert into routes (operation_id, nome, tarifa_por_estado, tarifa_valor_fixo, tarifa_por_distancia, valor_fixo_default) select '${ctx.opLN}', 'QA-C-DB-' || g, false, true, false, 40 from generate_series(${have + 1}, 30) g`)
const t0 = Date.now()
await sql(`insert into daily_records (route_id, data, km, enc_entregues, status)
  select r.id, (date '${today}' - d), 10 + (d % 7), 5 + (d % 3), 'validado' from routes r cross join generate_series(0, 39) d
  where r.nome like 'QA-C-DB-%' and r.deleted_at is null and not exists (select 1 from daily_records x where x.route_id = r.id and x.data = (date '${today}' - d) and x.deleted_at is null)`)
console.log('registos inseridos/verificados em', Date.now() - t0, 'ms')
const from = (await sql(`select date_trunc('month', date '${today}')::date::text d`))[0].d
const days = (await sql(`select (date '${today}' - date '${from}')::int + 1 n`))[0].n
const prevFrom = (await sql(`select (date '${from}' - ${days})::text d`))[0].d
const win = (await sql(`select count(*)::int n from daily_records where data between '${prevFrom}' and '${today}' and deleted_at is null`))[0].n
const cur = (await sql(`select coalesce(sum(receita_total),0)::float rev, coalesce(sum(km),0)::float km, count(*)::int n from daily_records where data between '${from}' and '${today}' and deleted_at is null`))[0]
console.log(`janela de dados ${prevFrom}..${today}: ${win} registos (>1000: ${win > 1000}); periodo atual ${from}..${today}: ${JSON.stringify(cur)}`)
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', args: ['--no-sandbox'] })
let failed = 0; const ok = (c, m) => { console.log(c ? '  PASSOU' : '  FALHOU', m); if (!c) failed++ }
try {
  const page = await (await browser.createBrowserContext()).newPage(); await page.setViewport({ width: 1366, height: 1200 })
  await page.goto('http://localhost:5199', { waitUntil: 'networkidle2' }); await page.type('input[type=email]', 'demo.admin@example.test'); await page.type('input[type=password]', process.env.DEMO_PASSWORD); await page.click('button[type=submit]')
  await page.waitForFunction(() => !document.querySelector('input[type=password]')); await page.goto('http://localhost:5199/dashboard', { waitUntil: 'networkidle2' })
  await new Promise((r) => setTimeout(r, 6000))
  const txt = await page.evaluate(() => document.body.innerText.replace(/\u00a0/g, ' '))
  const pills = await page.evaluate(() => [...document.querySelectorAll('button[aria-pressed="true"]')].map((b) => b.innerText.trim()))
  console.log('pilulas ativas:', JSON.stringify(pills))
  const lines = txt.split('\n').map((s) => s.trim()).filter(Boolean)
  const after = (label) => { const i = lines.findIndex((l) => l.toLowerCase() === label.toLowerCase()); return i >= 0 ? lines[i + 1] : null }
  const rev = after('Receita'), km = after('Km')
  console.log('UI Receita:', rev, '| Km:', km)
  const parse = (s) => Number(String(s).replace(/[^\d,\-]/g, '').replace(',', '.'))
  ok(rev !== null && Math.abs(parse(rev) - Math.round(cur.rev)) <= 1, `receita UI (${rev}) = BD (${cur.rev.toFixed(2)})`)
  ok(km !== null && Math.abs(parse(km) - Math.round(cur.km)) <= 1, `km UI (${km}) = BD (${cur.km})`)
} finally { await browser.close() }
process.exitCode = failed ? 1 : 0
