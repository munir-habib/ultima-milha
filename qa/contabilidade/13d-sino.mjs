// UI (Chrome headless) das funcionalidades novas: lote, Sem conta, motivo do Pendente, exportacao, confirmacao de religacao,
// detalhe de automatico/pedir correcao, sino, aviso de truncagem. Precisa de `npm run dev -- --port 5199`.
import puppeteer from 'puppeteer-core'
import ExcelJS from 'exceljs'
import { mkdirSync, readdirSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ctx, T, loginAll, users, t, setCaso, setArea, eq, ok, must, sql, mvIns, mv, mkRec, autos, dump, savectx, sleep } from './h.mjs'
import { applyFilters } from './acc.bundle.mjs'

const BASE = 'http://localhost:5199', CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const here = fileURLToPath(new URL('.', import.meta.url)).replace(/\\/g, '/').replace(/\/$/, '')
const DL = here + '/downloads'
mkdirSync(DL, { recursive: true }); mkdirSync(here + '/shots', { recursive: true })
const shot = (page, n) => page.screenshot({ path: `${here}/shots/${n}.png` })
await loginAll()
const { admin, cont, gest, audacc } = users
const ids = (ctx.c13 = ctx.c13 ?? {})
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] })
const errors = []

async function open(email, pw, url = '/contabilidade') {
  const bctx = await browser.createBrowserContext(); const page = await bctx.newPage()
  await page.setViewport({ width: 1366, height: 1000 })
  page.on('pageerror', (e) => errors.push(email + ' pageerror: ' + e.message))
  await page.goto(BASE, { waitUntil: 'networkidle2' })
  await page.waitForSelector('input[type=email]'); await page.type('input[type=email]', email); await page.type('input[type=password]', pw); await page.click('button[type=submit]')
  await page.waitForFunction(() => !document.querySelector('input[type=password]'), { timeout: 20000 })
  await page.goto(BASE + url, { waitUntil: 'networkidle2' })
  return { page, bctx }
}
const pill = (page, text) => page.evaluate((tx) => { const b = [...document.querySelectorAll('button[aria-pressed]')].find((x) => x.innerText.trim().startsWith(tx)); b?.click(); return Boolean(b) }, text)
const pillOn = (page, text) => page.evaluate((tx) => { const b = [...document.querySelectorAll('button[aria-pressed]')].find((x) => x.innerText.trim().startsWith(tx)); return b ? b.getAttribute('aria-pressed') === 'true' : null }, text)
const pillText = (page, prefix) => page.evaluate((tx) => [...document.querySelectorAll('button[aria-pressed]')].map((x) => x.innerText.trim()).find((x) => x.startsWith(tx)) ?? null, prefix)
const click = (page, sel) => page.evaluate((s) => { const e = document.querySelector(s); e?.click(); return Boolean(e) }, sel)
const cards = (page, scope = '[data-testid="movement-list"]') => page.evaluate((s) => [...document.querySelectorAll(`${s} [data-movement]`)].map((e) => e.getAttribute('data-movement')), scope)
const drag = (page, id, cell) => page.evaluate(async (i, c) => {
  const dt = new DataTransfer(); const card = document.querySelector(`[data-movement="${i}"]`); const target = document.querySelector(`[data-cell="${c}"]`)
  if (!card || !target) return { err: 'sem cartao/celula ' + !!card + '/' + !!target }
  const fire = (el, type) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }))
  fire(card, 'dragstart'); await new Promise((r) => setTimeout(r, 80)); fire(target, 'dragenter'); fire(target, 'dragover'); await new Promise((r) => setTimeout(r, 80))
  fire(target, 'drop'); fire(card, 'dragend'); return { ok: true }
}, id, cell)
const cellOf = (page, id) => page.evaluate((i) => document.querySelector(`[data-movement="${i}"]`)?.closest('[data-cell]')?.getAttribute('data-cell') ?? null, id)
const waitCell = (page, id, cell, to = 15000) => page.waitForFunction((i, c) => document.querySelector(`[data-movement="${i}"]`)?.closest('[data-cell]')?.getAttribute('data-cell') === c, { timeout: to }, id, cell)
const auditN = async (id) => (await sql(`select count(*)::int n from audit_log where tabela='movements' and registo_id='${id}'`))[0].n
const lines = (mid) => sql(`select record_id, valor::float v, deleted_at from daily_record_costs where movimento_id='${mid}' order by created_at, id`)
const dlgText = (page) => page.$eval('[role=dialog]', (e) => e.innerText.replace(/\u00a0/g, ' '))
const dbNoAcc = async () => (await sql(`select count(*)::int n from movements where tenant_id='${T}' and deleted_at is null and conta_id is null`))[0].n

const M = process.env.QA_M ?? '2027-05'
const C = await open('qa.contabilista@example.test', process.env.QA_PASSWORD); const cp = C.page
await cp.waitForSelector('[data-kpi="pending"]'); await sleep(1000)
// =================== sino ===================
setArea('Sino'); setCaso('B7-sino')
await t('B7 Sino: allocation_unlinked leva o Gestor a /registar?rota=..&data=.. e o Contabilista as Distribuicoes; auto_cost_disputed leva o Gestor a /registar?rota=..&data=..', async () => {
  const d5 = (await sql(`select (app.today() - g)::text d from generate_series(10, 60) g where not exists (select 1 from daily_records where route_id='${ctx.R2}' and data = app.today() - g) order by g limit 1`))[0].d; // data (>=10 dias) sem registo em R2 await sql('select app.run_alerts(false)') // despeja o backlog de alertas (senao empatam em created_at e ficam fora das 40 do sino)
  const trU = await must(mvIns(cont, { subcategoria: 'transferencia_distribuicao', valor: 500, pessoa_responsavel: 'QA-C-Sino', data: d5, descricao: 'QA-C-u-sino-tr' }).single())
  const al = (await must(mvIns(cont, { subcategoria: 'outro', valor: 12, pessoa_responsavel: 'QA-C-Sino', lancamento_referencia_id: trU.id, data: d5, operation_id: ctx.opLN, rota_id: ctx.R2, descricao: 'QA-C-u-sino-al' }).single())).id
  await sql('select app.run_alerts(false)')
  const rr = await mkRec(users.oper, ctx.R1, `${M}-15`, { comb_valor: 30, status: 'submetido' }); const au = (await autos(rr, 'combustivel'))[0].id; const rq = await cont.rpc('request_cost_correction', { p_movement: au, p_note: 'QA-C sino' }); ok(!rq.error && rq.data > 0, 'rpc ' + rq.error?.message)
  const G = await open('qa.gestor@example.test', process.env.QA_PASSWORD, '/'); const gp = G.page; await sleep(2500)
  const bell = async (p, re) => { await p.evaluate(() => document.querySelector('button[aria-label="Notificações"]').click()); await sleep(800); const clicked = await p.evaluate((src) => { const b = [...document.querySelectorAll('[role=dialog] li button')].find((x) => new RegExp(src).test(x.innerText)); if (b) b.click(); return b ? b.innerText.replace(/\n/g, ' ') : null }, re); await sleep(1500); return clicked }
  const c1 = await bell(gp, 'Correção pedida'); ok(c1, 'gestor sem notificacao "Correcao pedida"'); eq(await gp.evaluate(() => location.pathname + location.search), `/registar?rota=${ctx.R1}&data=${M}-15`, 'destino de auto_cost_disputed (' + c1 + ')')
  const c2 = await bell(gp, `Alocação por ligar: 12 € para QA-C-R2 \\(${d5}\\)`); ok(c2, 'gestor sem notificacao "Alocacao por ligar"'); eq(await gp.evaluate(() => location.pathname + location.search), `/registar?rota=${ctx.R2}&data=${d5}`, 'destino de allocation_unlinked (' + c2 + ')')
  await G.bctx.close()
  await cp.goto(BASE + '/contabilidade', { waitUntil: 'networkidle2' }); await cp.waitForSelector('[data-kpi="pending"]'); await sleep(1500)
  const c3 = await bell(cp, `Alocação por ligar: 12 € para QA-C-R2 \\(${d5}\\)`); ok(c3, 'contabilista sem notificacao'); eq(await cp.evaluate(() => location.pathname + location.search), '/contabilidade?view=unlinked', 'destino do Contabilista (3.a ronda: allocation_unlinked -> Por ligar)'); await sleep(500)
  ok(await cp.$('[data-testid="unlinked-view"]'), 'abre a vista Por ligar')
})

await C.bctx.close()
await browser.close()
if (errors.length) console.log('\nERROS DE PAGINA:', [...new Set(errors)])
savectx(); dump('results-13d.json')
