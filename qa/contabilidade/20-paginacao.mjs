// 3.a ronda: totais paginados. Cria N movimentos QA (SQL) e compara cartoes/KPIs/aviso da UI com a BD.
//   node qa/contabilidade/20-paginacao.mjs 3000        (precisa de `npm run dev -- --port 5199`)
//   node qa/contabilidade/20-paginacao.mjs 10500       (acima do teto de 10000: o aviso tem de aparecer e dizer a verdade)
import puppeteer from 'puppeteer-core'
import { sql } from '../lib.mjs'

const N = Number(process.argv[2] ?? 3000)
const tenant = (await sql(`select tenant_id from profiles where email='qa.contabilista@example.test'`))[0].tenant_id
const conta = (await sql(`select id from bank_accounts where tenant_id='${tenant}' and deleted_at is null order by created_at limit 1`))[0].id
const have = (await sql(`select count(*)::int n from movements where tenant_id='${tenant}' and deleted_at is null and descricao like 'QA-C-bulk-%'`))[0].n
if (have < N) await sql(`insert into movements (tenant_id, data, conta_id, tipo, valor, subcategoria, descricao, origem, estado)
  select '${tenant}', current_date - (g % 40), '${conta}', case when g % 5 = 0 then 'credito' else 'debito' end::movement_kind, (g % 97) + 0.37, 'outro', 'QA-C-bulk-' || g, 'manual_geral', 'confirmado'
  from generate_series(${have + 1}, ${N}) g`)

const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', args: ['--no-sandbox'] })
let failed = 0
try {
  const page = await (await browser.createBrowserContext()).newPage(); await page.setViewport({ width: 1366, height: 1000 })
  await page.goto('http://localhost:5199', { waitUntil: 'networkidle2' })
  await page.type('input[type=email]', 'qa.contabilista@example.test'); await page.type('input[type=password]', process.env.QA_PASSWORD); await page.click('button[type=submit]')
  await page.waitForFunction(() => !document.querySelector('input[type=password]'), { timeout: 20000 })
  await page.goto('http://localhost:5199/contabilidade', { waitUntil: 'networkidle2' })
  await page.waitForSelector('[data-kpi="pending"]')
  await page.evaluate(() => [...document.querySelectorAll('button[aria-pressed]')].find((x) => x.innerText.trim().startsWith('Tudo'))?.click())
  const t0 = Date.now()
  // P5: a Lista desenha um bloco de 100; os KPIs/totais usam a lista COMPLETA
  await page.waitForFunction((n) => document.querySelectorAll('[data-movement]').length >= n, { timeout: 240000 }, Math.min(N, 100)).catch(() => {})
  const renderMs = Date.now() - t0
  await new Promise((r) => setTimeout(r, 1500))
  const ui = await page.evaluate(() => ({
    cards: document.querySelectorAll('[data-movement]').length,
    debits: Number(document.querySelector('[data-kpi="debits"]').getAttribute('data-value')),
    credits: Number(document.querySelector('[data-kpi="credits"]').getAttribute('data-value')),
    warning: document.querySelector('[data-testid="truncated-warning"]')?.innerText ?? null,
    rest: Number(document.querySelector('[data-show-more]')?.getAttribute('data-rest') ?? 0),
  }))
  const capNow = Math.min(N, 10000)
  const tot = (await sql(`select count(*)::int n, coalesce(sum(case when tipo='debito' and estado='confirmado' then valor else 0 end),0)::float d, coalesce(sum(case when tipo='credito' and estado='confirmado' then valor else 0 end),0)::float c from movements where tenant_id='${tenant}' and deleted_at is null`))[0]
  const capped = tot.n > 10000
  console.log(JSON.stringify({ ui, bd: tot, capped, renderMs }))
  const ok = (c, m) => { console.log(c ? '  PASSOU' : '  FALHOU', m); if (!c) failed++ }
  if (!capped) {
    ok(ui.cards <= 100, `so se desenha o 1.o bloco (${ui.cards} cartoes; render ${renderMs} ms)`)
    ok(ui.rest === tot.n - ui.cards, `"Mostrar mais" diz quantos restam (${ui.rest} = ${tot.n} - ${ui.cards})`)
    await page.click('[data-show-more]'); await new Promise((r) => setTimeout(r, 800))
    ok((await page.evaluate(() => document.querySelectorAll('[data-movement]').length)) === Math.min(tot.n, 200), 'Mostrar mais acrescenta 100')
    ok(Math.abs(ui.debits - tot.d) < 0.01 && Math.abs(ui.credits - tot.c) < 0.01, `KPIs debitos/creditos conferem com a BD (${ui.debits} / ${tot.d})`)
    ok(ui.warning === null, 'sem aviso de truncagem quando esta tudo carregado')
  } else {
    ok(ui.warning !== null && ui.warning.includes(String(tot.n)) && ui.warning.includes('10000'), `aviso de truncagem diz a verdade («${ui.warning}»)`)
    ok(ui.cards <= 100 && ui.rest === capNow - ui.cards, `no teto: 1.o bloco desenhado (${ui.cards}) e restam ${ui.rest} dos ${capNow} carregados (render ${renderMs} ms)`)
  }
  // Agrupado e Quadro tambem so desenham blocos (antes: milhares de cartoes, ate 24 s)
  const pill = (txt) => page.evaluate((x) => { const b = [...document.querySelectorAll('button[aria-pressed]')].find((y) => y.innerText.trim().startsWith(x)); b?.click(); return Boolean(b) }, txt)
  let t1 = Date.now(); await pill('Agrupado'); await page.waitForSelector('[data-testid="grouped-view"]', { timeout: 120000 })
  const grouped = await page.evaluate(() => document.querySelectorAll('[data-movement]').length); const gMs = Date.now() - t1
  ok(grouped <= 1500 && gMs < 8000, `Agrupado desenha ${grouped} cartoes em ${gMs} ms (blocos por grupo; dias fechados nao montam cartoes)`)
  t1 = Date.now(); await pill('Quadro'); await page.waitForSelector('[data-testid="board"]', { timeout: 120000 }); await pill('Tudo'); await new Promise((r) => setTimeout(r, 1500))
  const board = await page.evaluate(() => document.querySelectorAll('[data-movement]').length); const bMs = Date.now() - t1
  ok(board <= 1500 && bMs < 10000, `Quadro desenha ${board} cartoes em ${bMs} ms (limite por celula)`)
  console.log(JSON.stringify({ groupedCards: grouped, groupedMs: gMs, boardCards: board, boardMs: bMs }))
} finally {
  await browser.close()
}
process.exitCode = failed ? 1 : 0
