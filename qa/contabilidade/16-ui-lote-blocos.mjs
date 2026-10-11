// B2: "Um PATCH por bloco de 100 ids". Na Lista filtrada a QA-C-ContaB (so movimentos QA) seleciona todos (>100) e atribui conta:
// observa os pedidos PATCH reais (tamanho de cada in.(...)) e confirma o resultado na BD.
import puppeteer from 'puppeteer-core'
import { ctx, T, loginAll, users, t, setCaso, setArea, eq, ok, sql, dump, sleep } from './h.mjs'
await loginAll(['cont'])
const BASE = 'http://localhost:5199'
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', args: ['--no-sandbox'] })
const page = await (await browser.createBrowserContext()).newPage(); await page.setViewport({ width: 1366, height: 1000 })
await page.goto(BASE, { waitUntil: 'networkidle2' }); await page.type('input[type=email]', 'qa.contabilista@example.test'); await page.type('input[type=password]', process.env.QA_PASSWORD); await page.click('button[type=submit]')
await page.waitForFunction(() => !document.querySelector('input[type=password]'), { timeout: 20000 })
await page.goto(BASE + '/contabilidade', { waitUntil: 'networkidle2' }); await page.waitForSelector('[data-kpi="pending"]')
const pill = (text) => page.evaluate((tx) => { const b = [...document.querySelectorAll('button[aria-pressed]')].find((x) => x.innerText.trim().startsWith(tx)); b?.click(); return Boolean(b) }, text)
setArea('B2 - lote em blocos de 100'); setCaso('B2')
await t('B2 Selecionar todos (N>100) e Atribuir conta: os PATCH saem em blocos de <=100 ids (um por bloco); todos os N movimentos ficam com a conta; 1 entrada de audit por movimento', async () => {
  const inB = (await sql(`select id from movements where conta_id='${ctx.contaB}' and deleted_at is null`)).map((r) => r.id); ok(inB.length > 100, 'precondicao: mais de 100 movimentos na QA-C-ContaB: ' + inB.length)
  const nonQA = (await sql(`select count(*)::int n from movements where conta_id='${ctx.contaB}' and deleted_at is null and coalesce(descricao,'') not like 'QA-%' and origem<>'automatico'`))[0].n; eq(nonQA, 0, 'a conta B so deve ter dados QA')
  await pill('Tudo'); await pill('QA-C-ContaB'); await sleep(1200)
  const patches = []; page.on('request', (r) => { if (r.method() === 'PATCH' && /rest\/v1\/movements/.test(r.url())) { const m = decodeURIComponent(r.url()).match(/id=in\.\(([^)]*)\)/); patches.push(m ? m[1].split(',').length : -1) } })
  const shown = await page.evaluate(() => document.querySelectorAll('[data-testid="movement-list"] [data-movement]').length); eq(shown, inB.length, 'cartoes com o filtro Conta B')
  await page.evaluate(() => document.querySelector('input[data-check-all]').click()); await sleep(500)
  eq(await page.$eval('[data-batch-count]', (e) => Number(e.getAttribute('data-batch-count'))), inB.length, 'selecionados')
  await page.select('[data-batch-account]', ctx.contaA); await sleep(200); const a0 = (await sql(`select count(*)::int n from audit_log where tabela='movements' and acao='UPDATE' and registo_id in (${inB.map((x) => `'${x}'`).join(',')})`))[0].n
  await page.evaluate(() => document.querySelector('[data-batch-assign]').click())
  await page.waitForFunction(() => !document.querySelector('[data-testid="batch-bar"]'), { timeout: 60000 }); await sleep(800)
  const exp = []; for (let i = 0; i < inB.length; i += 100) exp.push(Math.min(100, inB.length - i))
  eq(patches, exp, 'tamanho dos blocos de PATCH')
  const r = (await sql(`select count(*) filter (where conta_id='${ctx.contaA}')::int a from movements where id in (${inB.map((x) => `'${x}'`).join(',')})`))[0].a; eq(r, inB.length, 'movimentos com a nova conta')
  const a1 = (await sql(`select count(*)::int n from audit_log where tabela='movements' and acao='UPDATE' and registo_id in (${inB.map((x) => `'${x}'`).join(',')})`))[0].n; eq(a1 - a0, inB.length, '1 entrada de audit por movimento')
  return `${inB.length} movimentos; PATCH: ${patches.join(' + ')}`
})
await browser.close(); dump('results-16.json')
