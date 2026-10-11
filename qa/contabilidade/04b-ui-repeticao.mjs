// Repeticao dos casos 21, 25, 26 na UI (o 04-ui.mjs tinha 2 erros MEUS: periodo repostos a "Este mes" apos reload e parser do "por validar").
import puppeteer from 'puppeteer-core'
import { ctx, T, loginAll, users, t, setCaso, setArea, eq, ok, must, sql, dump, sleep } from './h.mjs'
import { sums } from './acc.bundle.mjs'
const BASE = 'http://localhost:5199', CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
await loginAll(); const { cont } = users
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] })
const pill = (page, text) => page.evaluate((tx) => { const b = [...document.querySelectorAll('button[aria-pressed]')].find((x) => x.innerText.trim().startsWith(tx)); b?.click(); return Boolean(b) }, text)
const money = (s) => { const m = String(s ?? '').replace(/\u00a0/g, ' ').match(/(−|-)?\s*(\d[\d ]*(?:[.,]\d+)?)/); if (!m) return 0; const v = Number(m[2].replace(/\s/g, '').replace(/\.(?=\d{3}\b)/g, '').replace(',', '.')); return Math.round((m[1] ? -v : v) * 100) }
try {
  const bctx = await browser.createBrowserContext(); const ap = await bctx.newPage(); await ap.setViewport({ width: 1366, height: 1000 })
  await ap.goto(BASE, { waitUntil: 'networkidle2' }); await ap.type('input[type=email]', 'demo.admin@example.test'); await ap.type('input[type=password]', process.env.DEMO_PASSWORD); await ap.click('button[type=submit]')
  await ap.waitForFunction(() => !document.querySelector('input[type=password]'), { timeout: 20000 })
  await ap.goto(BASE + '/contabilidade', { waitUntil: 'networkidle2' }); await ap.waitForSelector('[data-kpi="pending"]'); await pill(ap, 'Tudo'); await sleep(1000)

  setArea('UI - contas (repeticao)'); setCaso('CASO 21')
  await t('UI painel Contas: saldo de QA-C-ContaA e QA-C-ContaB = soma dos SEUS movimentos Confirmados; "por validar" a parte', async () => {
    await pill(ap, 'Contas'); await sleep(800)
    const rows = await ap.evaluate(() => [...document.querySelectorAll('.divide-y > div')].map((r) => ({ name: r.querySelector('.font-medium')?.innerText, net: r.querySelector('.font-semibold.tabular-nums')?.innerText, extra: r.querySelector('.text-xs[style]')?.innerText ?? '' })))
    const out = []
    for (const [n, id] of [['QA-C-ContaA', ctx.contaA], ['QA-C-ContaB', ctx.contaB]]) {
      const r = rows.find((x) => x.name === n); ok(r, 'sem linha ' + n); const s = sums(await must(cont.from('movements').select('*').eq('conta_id', id).is('deleted_at', null)))
      eq([money(r.net), money(r.extra)], [Math.round(s.net * 100), Math.round(s.pendingAmount * 100)], `linha ${n}: ${JSON.stringify(r)}`); out.push(`${n}: ${r.net} (+${r.extra})`)
    }
    return out.join(' | ')
  })

  setArea('UI - agrupado (repeticao)'); setCaso('CASO 25')
  await pill(ap, 'Agrupado'); await ap.waitForSelector('[data-testid="grouped-view"]'); await sleep(500)
  await ap.evaluate(() => document.querySelectorAll('[data-testid="grouped-view"] details').forEach((d) => (d.open = true)))
  await t('UI Agrupado: cada movimento aparece 1x, no dia+grupo (rota/Geral) dos seus campos; transferencia separada das alocacoes', async () => {
    const rows = await sql(`select id, data::text d, rota_id::text r, descricao from movements where deleted_at is null and data between '2026-05-04' and '2026-05-06'`)
    ok(rows.length >= 10, 'poucos movimentos ' + rows.length)
    const pos = await ap.evaluate((ids) => Object.fromEntries(ids.map((id) => {
      const els = [...document.querySelectorAll(`[data-testid="grouped-view"] [data-movement="${id}"]`)]
      const g = els[0]?.closest('details'); const d = g?.parentElement?.closest('details')
      return [id, { n: els.length, group: g?.querySelector('summary span')?.innerText, day: d?.querySelector('summary span')?.innerText }]
    })), rows.map((r) => r.id))
    const routeName = { [ctx.R1]: 'QA-C-R1', [ctx.R2]: 'QA-C-R2' }, dayLabels = {}, bad = []
    for (const r of rows) { const p = pos[r.id]; if (p.n !== 1 || p.group !== (r.r ? routeName[r.r] : 'Geral')) bad.push([r.id, r.descricao, p]); (dayLabels[r.d] ??= new Set()).add(p.day) }
    eq(bad.length, 0, 'movimentos repetidos/no grupo errado: ' + JSON.stringify(bad.slice(0, 3)))
    eq(Object.entries(dayLabels).sort().map(([d, s]) => [d, [...s].join()]), [['2026-05-04', '04/05/2026'], ['2026-05-05', '05/05/2026'], ['2026-05-06', '06/05/2026']], 'etiquetas de dia')
    const total = await ap.evaluate(() => document.querySelectorAll('[data-testid="grouped-view"] [data-movement]').length)
    return `${rows.length} movimentos dos dias 04-06/05 (2 execucoes do cenario) + total de cartoes no Agrupado=${total}`
  })
  setCaso('CASO 26')
  await t('UI Agrupado: subtotal de cada grupo (oficial + "por validar") e total do dia = soma dos grupos', async () => {
    const all = await sql(`select data::text d, coalesce(rota_id::text,'__geral') g, tipo, valor::float v, estado from movements where deleted_at is null and data between '2026-05-04' and '2026-05-06'`)
    const exp = {}; const add = (k, r) => { const e = (exp[k] ??= { net: 0, pend: 0 }); if (r.estado === 'confirmado') e.net += (r.tipo === 'credito' ? 1 : -1) * Math.round(r.v * 100); else e.pend += Math.round(r.v * 100) }
    for (const r of all) { add(r.d + '|' + r.g, r); add(r.d + '|*', r) }
    const dom = await ap.evaluate(() => [...document.querySelectorAll('[data-testid="grouped-view"] > div')].map((card) => {
      const day = card.querySelector('details > summary'); const sumOf = (s) => ({ net: s.querySelector('b')?.innerText, pend: [...s.querySelectorAll('span.text-xs')].map((x) => x.innerText).join('') })
      return { label: day.querySelector('span')?.innerText, sums: sumOf(day), groups: [...card.querySelectorAll('details details > summary')].map((s) => ({ label: s.querySelector('span')?.innerText, ...sumOf(s) })) }
    }))
    let checked = 0
    for (const [d, lab] of [['2026-05-04', '04/05/2026'], ['2026-05-05', '05/05/2026'], ['2026-05-06', '06/05/2026']]) {
      const day = dom.find((x) => x.label === lab); ok(day, 'dia ' + lab + ' nao encontrado: ' + dom.map((x) => x.label).slice(0, 8))
      const de = exp[d + '|*']; eq([money(day.sums.net), money(day.sums.pend)], [de.net, de.pend], 'total do dia ' + d)
      let sn = 0, sp = 0
      for (const g of day.groups) {
        const key = g.label === 'Geral' ? '__geral' : g.label === 'QA-C-R1' ? ctx.R1 : g.label === 'QA-C-R2' ? ctx.R2 : g.label
        const e = exp[d + '|' + key]; ok(e, `grupo inesperado ${g.label} em ${d}`)
        eq([money(g.net), money(g.pend)], [e.net, e.pend], `subtotal ${d} ${g.label}`); sn += money(g.net); sp += money(g.pend); checked++
      }
      eq([sn, sp], [de.net, de.pend], 'soma dos grupos = total do dia ' + d); eq(day.groups.length, Object.keys(exp).filter((k) => k.startsWith(d + '|') && !k.endsWith('*')).length, 'grupos do dia ' + d)
    }
    return `${checked} subtotais de grupo + 3 totais de dia conferidos na UI`
  })
  await bctx.close()
} finally { await browser.close() }
dump('results-04b.json')
