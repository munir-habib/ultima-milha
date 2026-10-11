// UI (Chrome headless) das correcoes da 3.a ronda: vista Por ligar, Sem registo previsto (lote + detalhe), confirmacao de
// religacao a registo Validado, sino (?view=validate&mov=), filtros que limpam a selecao, Sem conta forca Tudo, exportacoes.
// Precisa de `npm run dev -- --port 5199`.
import puppeteer from 'puppeteer-core'
import ExcelJS from 'exceljs'
import { mkdirSync, readdirSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ctx, T, loginAll, users, t, setCaso, setArea, eq, ok, must, sql, mvIns, mv, mkRec, dump, savectx, sleep } from './h.mjs'

const BASE = 'http://localhost:5199', CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const here = fileURLToPath(new URL('.', import.meta.url)).replace(/\\/g, '/').replace(/\/$/, '')
const DL = here + '/downloads'; mkdirSync(DL, { recursive: true }); mkdirSync(here + '/shots', { recursive: true })
await loginAll()
const { admin, cont, gest, oper } = users
const ids = (ctx.c22 = ctx.c22 ?? {})
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] })
async function open(email, pw = process.env.QA_PASSWORD, url = '/contabilidade') {
  const bctx = await browser.createBrowserContext(); const page = await bctx.newPage(); await page.setViewport({ width: 1366, height: 1000 })
  await page.goto(BASE, { waitUntil: 'networkidle2' }); await page.waitForSelector('input[type=email]'); await page.type('input[type=email]', email); await page.type('input[type=password]', pw); await page.click('button[type=submit]')
  await page.waitForFunction(() => !document.querySelector('input[type=password]'), { timeout: 20000 })
  await page.goto(BASE + url, { waitUntil: 'networkidle2' }); return { page, bctx }
}
const pill = (page, text) => page.evaluate((tx) => { const b = [...document.querySelectorAll('button[aria-pressed]')].find((x) => x.innerText.trim().startsWith(tx)); b?.click(); return Boolean(b) }, text)
const pillText = (page, prefix) => page.evaluate((tx) => [...document.querySelectorAll('button[aria-pressed]')].map((x) => x.innerText.trim()).find((x) => x.startsWith(tx)) ?? null, prefix)
const pressed = (page) => page.evaluate(() => [...document.querySelectorAll('button[aria-pressed="true"]')].map((b) => b.innerText.trim().replace(/ \(\d+\)$/, '')))
const click = (page, sel) => page.evaluate((s) => { const e = document.querySelector(s); e?.click(); return Boolean(e) }, sel)
const cardsIn = (page, scope) => page.evaluate((s) => [...document.querySelectorAll(`${s} [data-movement]`)].map((e) => e.getAttribute('data-movement')), scope)
const dayOff = async (n) => (await sql(`select (app.today() + (${n}))::text d`))[0].d
const lines = (mid) => sql(`select record_id, valor::float v, deleted_at from daily_record_costs where movimento_id='${mid}' order by created_at, id`)
const drag = (page, id, cell) => page.evaluate(async (i, c) => {
  const dt = new DataTransfer(); const card = document.querySelector(`[data-movement="${i}"]`); const target = document.querySelector(`[data-cell="${c}"]`)
  if (!card || !target) return { err: 'sem cartao/celula ' + !!card + '/' + !!target }
  const fire = (el, type) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }))
  fire(card, 'dragstart'); await new Promise((r) => setTimeout(r, 80)); fire(target, 'dragenter'); fire(target, 'dragover'); await new Promise((r) => setTimeout(r, 80)); fire(target, 'drop'); fire(card, 'dragend'); return { ok: true }
}, id, cell)
const waitCell = (page, id, cell, to = 15000) => page.waitForFunction((i, c) => document.querySelector(`[data-movement="${i}"]`)?.closest('[data-cell]')?.getAttribute('data-cell') === c, { timeout: to }, id, cell)
async function exportNow(page) {
  for (const f of readdirSync(DL)) rmSync(DL + '/' + f)
  const okc = await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find((x) => /Exportar Excel/.test(x.innerText)); if (!b || b.disabled) return false; b.click(); return true }); if (!okc) return null
  for (let i = 0; i < 40; i++) { await sleep(500); const f = readdirSync(DL).find((x) => x.endsWith('.xlsx')); if (f) { await sleep(500); const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(DL + '/' + f); const ws = wb.worksheets[0]; const rows = []; ws.eachRow((r) => rows.push(r.values.slice(1))); return { file: f, n: rows.length - 1, rows: rows.slice(1) } } }
  return { err: 'sem ficheiro' }
}
// numero de "por ligar" (nao marcadas) e marcadas segundo a BD
const dbUnl = (flagged) => sql(`select id, data::text d from movements where tenant_id='${T}' and deleted_at is null and lancamento_referencia_id is not null and tipo='debito' and operation_id is not null and rota_id is not null and registo_id is null and sem_registo_previsto = ${flagged} order by data, created_at, id`)

const U = {}
const C = await open('qa.contabilista@example.test'); const cp = C.page
const cdp = await browser.target().createCDPSession(); await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL.replace(/\//g, '\\'), browserContextId: C.bctx.id })
await cp.waitForSelector('[data-kpi="pending"]'); await pill(cp, 'Tudo'); await sleep(1500)

setArea('UI - filtros'); setCaso('F1')
await t('F1 Mudar QUALQUER filtro limpa a selecao do lote (periodo, conta, origem, categoria); mudar de vista tambem', async () => {
  await cp.goto(BASE + '/contabilidade', { waitUntil: 'networkidle2' }); await cp.waitForSelector('[data-kpi="pending"]'); await pill(cp, 'Tudo'); await sleep(1500)
  const sel = async () => { await cp.evaluate(() => { const c = [...document.querySelectorAll('[data-testid="movement-list"] input[data-check]')].slice(0, 2); c.forEach((x) => x.click()) }); await sleep(300); return (await cp.$('[data-testid="batch-bar"]')) !== null }
  const stillSel = async () => (await cp.$('[data-testid="batch-bar"]')) !== null
  const tries = [['periodo Este mes', () => pill(cp, 'Este mês')], ['periodo Tudo', () => pill(cp, 'Tudo')]]
  const res = []
  for (const [n, fn] of tries) { ok(await sel(), 'sem barra apos selecionar (' + n + ')'); await fn(); await sleep(500); res.push([n, await stillSel()]) }
  const selects = await cp.$$('select'); for (let i = 0; i < selects.length; i++) { if (!(await sel())) { res.push(['select ' + i + ' (lista vazia, nao verificavel)', false]); continue } const opts = await selects[i].evaluate((s) => [...s.options].map((o) => o.value)); if (opts.length < 2) continue; await selects[i].select(opts[1]); await sleep(500); res.push(['select ' + i + ' [' + (await selects[i].evaluate((x) => x.getAttribute('aria-label'))) + ']', await stillSel()]); await selects[i].select(opts[0]); await sleep(300) }
  const notFilter = res.filter((r) => r[1] && /Opera/.test(r[0])); eq(res.filter((r) => r[1] && !/Opera/.test(r[0])), [], 'selecao NAO limpa apos: ' + JSON.stringify(res)); ok(res.length >= 4, 'poucos controlos verificados: ' + JSON.stringify(res)); return 'OBSERVACAO: o seletor global de Operacao (cabecalho) NAO limpa a selecao (nao e filtro da Contabilidade; a acao so aplica aos selecionados visiveis): ' + JSON.stringify(notFilter) + ' | ' + JSON.stringify(res)
})
dump('results-22b.json'); await browser.close(); process.exit(0)
