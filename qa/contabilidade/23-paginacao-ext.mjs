// 3.a ronda: totais paginados, alargado. Uso: node qa/contabilidade/23-paginacao-ext.mjs [N]   (precisa de `npm run dev -- --port 5199`)
// Cria (SQL, idempotente) ate N movimentos 'QA-C-bulk-*' e compara, na UI real (Contabilista): cartoes/KPIs em Lista, Agrupado, Quadro,
// Distribuicoes e Contas, com "todas as operacoes" e com uma Operacao selecionada, + aviso de truncagem + tempos.
import puppeteer from 'puppeteer-core'
import { sql } from '../lib.mjs'
import { login } from '../lib.mjs'

const N = Number(process.argv[2] ?? 3000)
const tenant = (await sql(`select tenant_id from profiles where email='qa.contabilista@example.test'`))[0].tenant_id
const opLN = (await sql(`select id from operations where nome='Lisboa Norte' and tenant_id='${tenant}'`))[0].id
const conta = (await sql(`select id from bank_accounts where tenant_id='${tenant}' and deleted_at is null and nome not like 'QA-%' order by created_at limit 1`))[0].id
const have = (await sql(`select count(*)::int n from movements where tenant_id='${tenant}' and deleted_at is null and descricao like 'QA-C-bulk-%'`))[0].n
if (have < N) {
  const t0 = Date.now()
  await sql(`insert into movements (tenant_id, data, conta_id, tipo, valor, subcategoria, descricao, origem, estado)
    select '${tenant}', current_date - (g % 40), '${conta}', case when g % 5 = 0 then 'credito' else 'debito' end::movement_kind, (g % 97) + 0.37, 'outro', 'QA-C-bulk-' || g, 'manual_geral', 'confirmado'
    from generate_series(${have + 1}, ${N}) g`)
  console.log(`inseridos ${N - have} movimentos em ${Date.now() - t0} ms`)
}
// alguns dos bulk com operacao (para o teste com Operacao selecionada): 1 em cada 7 -> Lisboa Norte (manual_rota, sem rota)
try { sql(`update movements set operation_id='${opLN}', origem='manual_rota' where tenant_id='${tenant}' and deleted_at is null and descricao like 'QA-C-bulk-%' and operation_id is null and (regexp_replace(descricao, '\\D', '', 'g'))::int % 7 = 0`) } catch (e) { console.log('nota: update de operacao dos bulk falhou ' + String(e.message).slice(0, 120)) }

const num = (s) => Number(String(s).replace(/\s|€|\u00a0/g, '').replace('−', '-').replace(/\.(?=\d{3}\b)/g, '').replace(',', '.'))
const ex = async (where) => (await sql(`select count(*)::int n,
  coalesce(sum(case when tipo='debito' and estado='confirmado' then valor else 0 end),0)::float d,
  coalesce(sum(case when tipo='credito' and estado='confirmado' then valor else 0 end),0)::float c,
  coalesce(sum(case when estado='pendente' then valor else 0 end),0)::float p
  from movements where tenant_id='${tenant}' and deleted_at is null ${where}`))[0]
const nTransfers = async (where = '') => (await sql(`select count(*)::int n from movements where tenant_id='${tenant}' and deleted_at is null and subcategoria='transferencia_distribuicao' and lancamento_referencia_id is null ${where}`))[0].n
const tot = await ex(''), ln = await ex(`and operation_id='${opLN}'`)
const capped = tot.n > 10000
console.log('BD todas:', JSON.stringify(tot), '| Lisboa Norte:', JSON.stringify(ln), '| teto excedido:', capped)

// tempo do carregamento na camada de dados (paginas de 1000 como a UI), como utilizador real
const cont = await login('qa.contabilista@example.test')
{
  const t0 = Date.now(); let got = 0, pages = 0
  for (let from = 0; from < 10000; from += 1000) {
    const t1 = Date.now(); const r = await cont.from('movements').select('id', from === 0 ? { count: 'exact' } : undefined).is('deleted_at', null).order('data', { ascending: false }).order('created_at', { ascending: false }).order('id', { ascending: false }).range(from, from + 999)
    if (r.error) { console.log('ERRO pagina', from, r.error.message); break } pages++; got += r.data.length; if (from === 0 || pages % 3 === 0) console.log(`  pagina ${pages}: ${Date.now() - t1} ms`); if (r.data.length < 1000) break
  }
  console.log(`REST (paginas de 1000, so ids): ${got} linhas em ${pages} paginas, ${Date.now() - t0} ms`)
}

const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', args: ['--no-sandbox'] })
let failed = 0
const ok = (c, m) => { console.log(c ? '  PASSOU' : '  FALHOU', m); if (!c) failed++ }
try {
  const page = await (await browser.createBrowserContext()).newPage(); await page.setViewport({ width: 1366, height: 1000 })
  page.on('pageerror', (e) => console.log('pageerror', e.message.slice(0, 200)))
  await page.goto('http://localhost:5199', { waitUntil: 'networkidle2' })
  await page.type('input[type=email]', 'qa.contabilista@example.test'); await page.type('input[type=password]', process.env.QA_PASSWORD); await page.click('button[type=submit]')
  await page.waitForFunction(() => !document.querySelector('input[type=password]'), { timeout: 20000 })
  const T0 = Date.now()
  await page.goto('http://localhost:5199/contabilidade', { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('[data-kpi="pending"]', { timeout: 60000 }); const tShell = Date.now() - T0
  await page.evaluate(() => [...document.querySelectorAll('button[aria-pressed]')].find((x) => x.innerText.trim().startsWith('Tudo'))?.click())
  const want = Math.min(tot.n, 10000)
  await page.waitForFunction((n) => document.querySelectorAll('[data-testid="movement-list"] [data-movement]').length >= n || document.querySelector('[data-testid="truncated-warning"]'), { timeout: 300000, polling: 250 }, want).catch(() => {})
  const tLoaded = Date.now() - T0; await new Promise((r) => setTimeout(r, 2500))
  console.log(`TEMPO ate KPIs visiveis: ${tShell} ms; ate todos os cartoes da Lista (${want}): ${tLoaded} ms`)
  const snap = () => page.evaluate(() => ({
    cards: document.querySelectorAll('[data-movement]').length,
    debits: Number(document.querySelector('[data-kpi="debits"]')?.getAttribute('data-value')), credits: Number(document.querySelector('[data-kpi="credits"]')?.getAttribute('data-value')),
    pending: Number(document.querySelector('[data-kpi="pending"]')?.getAttribute('data-value')), warning: document.querySelector('[data-testid="truncated-warning"]')?.innerText ?? null,
  }))
  const pill = (text) => page.evaluate((tx) => { const b = [...document.querySelectorAll('button[aria-pressed]')].find((x) => x.innerText.trim().startsWith(tx)); b?.click(); return Boolean(b) }, text)
  const near = (a, b) => Math.abs(a - b) < 0.01

  const u = await snap(); console.log('UI todas/Lista:', JSON.stringify(u))
  if (!capped) {
    ok(u.cards === tot.n, `Lista: cartoes (${u.cards}) = BD (${tot.n})`)
    ok(near(u.debits, tot.d) && near(u.credits, tot.c) && near(u.pending, tot.p), `KPIs (deb ${u.debits}, cred ${u.credits}, por validar ${u.pending}) = BD (${tot.d}, ${tot.c}, ${tot.p})`)
    ok(u.warning === null, 'sem aviso de truncagem')
  } else {
    ok(u.warning !== null && u.warning.includes(String(tot.n)) && u.warning.includes('10000'), `aviso de truncagem verdadeiro («${u.warning}»)`)
    ok(u.cards <= 10000 && u.cards >= 9000, `carrega ate ao teto (${u.cards})`)
  }
  const shownExpected = capped ? null : tot.n
  for (const [v, sel] of [['Agrupado', '[data-testid="grouped-view"] [data-movement]'], ['Quadro', '[data-testid="board"] [data-movement]']]) {
    const t1 = Date.now(); await pill(v); await new Promise((r) => setTimeout(r, 600))
    if (v === 'Quadro') await pill('Tudo')
    await page.waitForSelector(sel.split(' ')[0], { timeout: 120000 }); await new Promise((r) => setTimeout(r, 1500))
    const n = await page.evaluate((s) => document.querySelectorAll(s).length, sel); const ms = Date.now() - t1
    if (shownExpected !== null) ok(n === shownExpected, `${v}: ${n} cartoes = BD ${shownExpected} (render ${ms} ms)`); else ok(n >= 9000 && n <= 10000, `${v}: ${n} cartoes com teto excedido (render ${ms} ms)`)
  }
  await pill('Distribuições'); await new Promise((r) => setTimeout(r, 1500))
  const nTr = await page.evaluate(() => document.querySelectorAll('[data-alloc-state]').length); const expTr = await nTransfers()
  ok(capped ? nTr <= expTr : nTr === expTr, `Distribuicoes: ${nTr} transferencias = BD ${expTr}`)
  await pill('Contas'); await new Promise((r) => setTimeout(r, 1200))
  const rows = await page.evaluate(() => [...document.querySelectorAll('.divide-y > div')].map((r) => ({ name: r.querySelector('.font-medium')?.innerText, net: r.querySelector('.font-semibold.tabular-nums')?.innerText })))
  const acc = (await sql(`select b.nome, coalesce(sum(case when m.estado='confirmado' then case when m.tipo='credito' then m.valor else -m.valor end else 0 end),0)::float net from bank_accounts b left join movements m on m.conta_id=b.id and m.deleted_at is null where b.tenant_id='${tenant}' and b.deleted_at is null group by b.nome`))
  for (const a of acc) { const r = rows.find((x) => x.name === a.nome); if (!r) { ok(false, `Contas: sem linha ${a.nome}`); continue } const uiNet = num(r.net); ok(capped ? true : near(uiNet, a.net), `Contas: ${a.nome} UI ${uiNet} vs BD ${a.net}${capped ? ' (teto excedido: so informativo)' : ''}`) }

  // ---- Operacao selecionada (Lisboa Norte) ----
  await pill('Lista'); await new Promise((r) => setTimeout(r, 500))
  await page.evaluate((op) => { const s = document.querySelector('select[aria-label="Operação"]'); const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; set.call(s, op); s.dispatchEvent(new Event('change', { bubbles: true })) }, opLN)
  await new Promise((r) => setTimeout(r, 2500)); await pill('Tudo'); await new Promise((r) => setTimeout(r, 1500))
  const l = await snap(); console.log('UI Lisboa Norte/Lista:', JSON.stringify(l), '| BD:', JSON.stringify(ln))
  if (!capped) {
    ok(l.cards === ln.n, `Op selecionada, Lista: ${l.cards} cartoes = BD (${ln.n})`)
    ok(near(l.debits, ln.d) && near(l.credits, ln.c), `Op selecionada: KPIs deb/cred (${l.debits}/${l.credits}) = BD (${ln.d}/${ln.c})`)
  } else ok(l.cards <= ln.n + 5, `Op selecionada com teto excedido: ${l.cards} cartoes (BD ${ln.n})`)
  for (const [v, sel] of [['Agrupado', '[data-testid="grouped-view"] [data-movement]'], ['Quadro', '[data-testid="board"] [data-movement]']]) {
    await pill(v); await new Promise((r) => setTimeout(r, 800)); if (v === 'Quadro') await pill('Tudo'); await page.waitForSelector(sel.split(' ')[0], { timeout: 60000 }); await new Promise((r) => setTimeout(r, 1200))
    const n = await page.evaluate((s) => document.querySelectorAll(s).length, sel); ok(capped ? n <= ln.n : n === ln.n, `Op selecionada, ${v}: ${n} cartoes = BD ${ln.n}`)
  }
} finally { await browser.close() }
process.exitCode = failed ? 1 : 0
