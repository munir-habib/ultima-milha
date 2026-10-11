// Fronteira do teto de 10 000: com exatamente 10000 movimentos ativos NAO ha aviso e KPIs = BD; com 10001 ha aviso "10000 de 10001".
import puppeteer from 'puppeteer-core'
import { sql } from '../lib.mjs'
const tenant = (await sql(`select tenant_id from profiles where email='qa.contabilista@example.test'`))[0].tenant_id
const conta = (await sql(`select id from bank_accounts where tenant_id='${tenant}' and deleted_at is null and nome not like 'QA-%' order by created_at limit 1`))[0].id
const count = async () => (await sql(`select count(*)::int n from movements where tenant_id='${tenant}' and deleted_at is null`))[0].n
let n = await count(); if (n > 10000) await sql(`update movements set deleted_at=now(), motivo_apagado='QA limpeza (teto)' where id in (select id from movements where tenant_id='${tenant}' and deleted_at is null and descricao like 'QA-C-bulk-%' order by descricao desc limit ${n - 10000})`)
console.log('ativos agora:', await count())
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', args: ['--no-sandbox'] })
let failed = 0; const ok = (c, m) => { console.log(c ? '  PASSOU' : '  FALHOU', m); if (!c) failed++ }
async function run(label) {
  const page = await (await browser.createBrowserContext()).newPage(); await page.setViewport({ width: 1366, height: 1000 })
  await page.goto('http://localhost:5199', { waitUntil: 'networkidle2' }); await page.type('input[type=email]', 'qa.contabilista@example.test'); await page.type('input[type=password]', process.env.QA_PASSWORD); await page.click('button[type=submit]')
  await page.waitForFunction(() => !document.querySelector('input[type=password]')); await page.goto('http://localhost:5199/contabilidade', { waitUntil: 'networkidle2' }); await page.waitForSelector('[data-kpi="pending"]')
  await page.evaluate(() => [...document.querySelectorAll('button[aria-pressed]')].find((x) => x.innerText.trim().startsWith('Tudo'))?.click())
  await page.waitForFunction(() => document.querySelectorAll('[data-movement]').length >= 10000 || document.querySelector('[data-testid="truncated-warning"]'), { timeout: 240000, polling: 250 }).catch(() => {}); await new Promise((r) => setTimeout(r, 3000))
  const ui = await page.evaluate(() => ({ cards: document.querySelectorAll('[data-movement]').length, d: Number(document.querySelector('[data-kpi="debits"]').getAttribute('data-value')), c: Number(document.querySelector('[data-kpi="credits"]').getAttribute('data-value')), w: document.querySelector('[data-testid="truncated-warning"]')?.innerText ?? null }))
  const bd = (await sql(`select count(*)::int n, coalesce(sum(case when tipo='debito' and estado='confirmado' then valor end),0)::float d, coalesce(sum(case when tipo='credito' and estado='confirmado' then valor end),0)::float c from movements where tenant_id='${tenant}' and deleted_at is null`))[0]
  console.log(label, JSON.stringify({ ui, bd })); await page.close(); return { ui, bd }
}
const a = await run('N=10000'); ok(a.bd.n === 10000 && a.ui.cards === 10000 && a.ui.w === null && Math.abs(a.ui.d - a.bd.d) < 0.01 && Math.abs(a.ui.c - a.bd.c) < 0.01, 'exatamente 10000: 10000 cartoes, sem aviso, KPIs = BD')
await sql(`insert into movements (tenant_id, data, conta_id, tipo, valor, subcategoria, descricao, origem, estado) values ('${tenant}', current_date - 100, '${conta}', 'debito', 1.11, 'outro', 'QA-C-bulk-teto-extra', 'manual_geral', 'confirmado')`)
const b = await run('N=10001'); ok(b.bd.n === 10001 && b.ui.cards === 10000 && b.ui.w?.includes('10000 de 10001'), 'com 10001: 10000 cartoes e aviso "10000 de 10001"')
await browser.close(); process.exitCode = failed ? 1 : 0
