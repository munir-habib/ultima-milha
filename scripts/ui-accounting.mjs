// Checklist da Contabilidade na UI real (Chrome headless + projeto Supabase real).
//   1) npm run dev -- --port 5199     2) node scripts/ui-accounting.mjs
// Cria lancamentos de teste e no fim apaga-os (soft delete, com motivo).
import puppeteer from 'puppeteer-core'
import { createClient } from '@supabase/supabase-js'
import { mkdirSync, readFileSync } from 'node:fs'

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
const prof = (await api.from('profiles').select('tenant_id').eq('id', uid).single()).data
await api.from('profiles').update({ tema: 'dark', idioma: 'pt' }).eq('id', uid)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failed = 0
const ok = (cond, msg) => {
  console.log(cond ? '  ok   ' : '  FALHA', msg)
  if (!cond) failed++
}

// ---------- preparar dados de teste (como o Contabilista faria) ----------
const [{ data: acc }, { data: op }, { data: route }] = await Promise.all([
  api.from('bank_accounts').select('id').limit(1).single(),
  api.from('operations').select('id').eq('nome', 'Lisboa Norte').single(),
  api.from('routes').select('id').ilike('nome', 'Rota A%').single(),
])
const created = []
const createdRecs = []
const { count: notifBefore } = await api.from('notifications').select('id', { count: 'exact', head: true }).eq('tipo', 'movement_pending')
const mk = async (row) => {
  const { data, error } = await api.from('movements').insert({ tenant_id: prof.tenant_id, conta_id: acc.id, ...row }).select('id,estado').single()
  if (error) throw new Error('insert: ' + error.message)
  created.push(data.id)
  return data
}
const future = new Date(Date.now() + 86400000 * 9).toISOString().slice(0, 10) // sem registo diario nesse dia
const transfer = await mk({ data: future, tipo: 'debito', valor: 200, subcategoria: 'transferencia_distribuicao', pessoa_responsavel: 'Teste UI', descricao: 'TESTE-UI transferencia' })
const alloc = await mk({ data: future, tipo: 'debito', valor: 60, subcategoria: 'outro', operation_id: op.id, rota_id: route.id, pessoa_responsavel: 'Teste UI', lancamento_referencia_id: transfer.id, estado: 'confirmado', descricao: 'TESTE-UI alocacao' })
const alloc2 = await mk({ data: future, tipo: 'debito', valor: 30, subcategoria: 'outro', operation_id: op.id, rota_id: route.id, pessoa_responsavel: 'Teste UI', lancamento_referencia_id: transfer.id, descricao: 'TESTE-UI alocacao 2' })

ok(transfer.estado === 'confirmado', 'transferencia manual nasce Confirmado')
ok(alloc.estado === 'pendente' && alloc2.estado === 'pendente', 'alocacoes nascem SEMPRE Pendente (mesmo com estado=confirmado no pedido)')
const { count: notifAfter } = await api.from('notifications').select('id', { count: 'exact', head: true }).eq('tipo', 'movement_pending')
ok(notifAfter - notifBefore >= 2, 'alocacao pendente gerou notificacao de "por validar" ao Super Admin')
const { data: recs } = await api.from('daily_records').select('id').eq('route_id', route.id).eq('data', future)
ok((recs ?? []).length === 0, 'alocacao sem registo diario NAO criou registo (fica "por ligar")')

// ---------- UI ----------
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] })
const errors = []
try {
  const ctx = await browser.createBrowserContext()
  const page = await ctx.newPage()
  await page.setViewport({ width: 1366, height: 900, deviceScaleFactor: 2 })
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message))
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource|net::ERR/.test(m.text())) errors.push('console: ' + m.text()) })
  await page.goto(BASE, { waitUntil: 'networkidle2' })
  await page.waitForSelector('input[type=email]')
  await page.type('input[type=email]', email)
  await page.type('input[type=password]', password)
  await page.click('button[type=submit]')
  await page.waitForFunction(() => !document.querySelector('input[type=password]'), { timeout: 20000 })

  const kpi = (name) => page.$eval(`[data-kpi="${name}"]`, (el) => Number(el.getAttribute('data-value')))
  const clickPill = (text) => page.evaluate((t) => { const b = [...document.querySelectorAll('button[aria-pressed]')].find((x) => x.innerText.trim().startsWith(t)); b?.click(); return Boolean(b) }, text)
  const waitCard = (id) => page.waitForSelector(`[data-movement="${id}"]`, { timeout: 15000 })

  await page.goto(BASE + '/contabilidade', { waitUntil: 'networkidle2' })
  await page.waitForSelector('[data-kpi="pending"]')
  await clickPill('Tudo') // periodo: tudo
  await waitCard(alloc.id)

  // ---- contorno vermelho nos Pendentes (nos dois temas: cor semantica igual) ----
  const style = await page.$eval(`[data-movement="${alloc.id}"]`, (el) => { const c = getComputedStyle(el); return { border: c.borderTopColor, width: c.borderTopWidth, shadow: c.boxShadow, pending: el.getAttribute('data-pending') } })
  // a espessura declarada na regra CSS (o valor computado e arredondado ao pixel do dispositivo)
  const declared = await page.evaluate(() => {
    for (const sheet of document.styleSheets) for (const r of sheet.cssRules ?? []) if (r.selectorText === '.pending-outline') return { border: r.style.getPropertyValue('border'), shadow: r.style.getPropertyValue('box-shadow') }
    return null
  })
  ok(style.pending === 'true' && style.border === 'rgb(239, 68, 68)', 'Pendente: contorno vermelho #ef4444 (' + style.border + ')')
  ok(/^var\(--pending-width\) solid/.test(declared?.border ?? ''), 'Pendente: regra CSS usa os tokens --pending-* (' + declared?.border + ')')
  // o glow pulsa (animacao), por isso so a cor e fixa; o tamanho oscila entre --pending-glow e --pending-glow-max
  ok(/rgba\(239, 68, 68, /.test(style.shadow) && /\dpx/.test(style.shadow), 'Pendente: glow vermelho (' + style.shadow + ')')
  const confirmedStyle = await page.$eval(`[data-movement="${transfer.id}"]`, (el) => ({ b: getComputedStyle(el).borderTopColor, p: el.getAttribute('data-pending') }))
  ok(confirmedStyle.p === null && confirmedStyle.b !== 'rgb(239, 68, 68)', 'Confirmado: sem contorno vermelho')
  const unlinked = await page.$eval(`[data-movement="${alloc.id}"]`, (el) => el.innerText.includes('Por ligar ao operacional'))
  ok(unlinked, 'alocacao mostra "Por ligar ao operacional"')
  await page.screenshot({ path: '.shots/acc-lista-pendentes.png', fullPage: false })

  // ---- totais oficiais so contam Confirmado; pendentes a parte ----
  const before = { debits: await kpi('debits'), balance: await kpi('balance'), pending: await kpi('pending') }
  ok(before.pending >= 90, `cartao "por validar" inclui os pendentes (${before.pending})`)

  // ---- validar remove o contorno e entra no saldo oficial ----
  await page.evaluate((id) => [...document.querySelectorAll(`[data-movement="${id}"] button`)].find((b) => b.innerText.trim() === 'Validar')?.click(), alloc.id)
  await page.waitForFunction((id) => !document.querySelector(`[data-movement="${id}"]`)?.hasAttribute('data-pending'), { timeout: 15000 }, alloc.id)
  await sleep(600)
  const after = { debits: await kpi('debits'), balance: await kpi('balance'), pending: await kpi('pending') }
  ok(Math.abs(after.debits - before.debits - 60) < 0.01 && Math.abs(before.balance - after.balance - 60) < 0.01, `validar: entra no saldo oficial (debitos +60, saldo -60)`)
  ok(Math.abs(before.pending - after.pending - 60) < 0.01, 'validar: sai do "por validar"')
  const nowOutline = await page.$eval(`[data-movement="${alloc.id}"]`, (el) => getComputedStyle(el).borderTopColor)
  ok(nowOutline !== 'rgb(239, 68, 68)', 'validar remove o contorno vermelho')
  const { data: v } = await api.from('movements').select('estado,validado_por,validado_em').eq('id', alloc.id).single()
  ok(v.estado === 'confirmado' && v.validado_por === uid && v.validado_em, 'audit: quem e quando validou ficou registado')

  // ---- acoes em lote: selecionar varios pendentes na fila e validar de uma vez; motivo do Pendente visivel ----
  const bA = await mk({ data: future, tipo: 'debito', valor: 11, subcategoria: 'outro', pessoa_responsavel: 'Teste UI', lancamento_referencia_id: transfer.id, descricao: 'TESTE-UI lote A' })
  const bB = await mk({ data: future, tipo: 'debito', valor: 12, subcategoria: 'outro', pessoa_responsavel: 'Teste UI', lancamento_referencia_id: transfer.id, descricao: 'TESTE-UI lote B' })
  await page.goto(BASE + '/contabilidade?view=validate', { waitUntil: 'networkidle2' })
  await waitCard(bA.id); await waitCard(bB.id)
  const reason = await page.$eval(`[data-movement="${bA.id}"] [data-reason]`, (el) => el.getAttribute('data-reason'))
  ok(reason === 'alloc', 'Pendente diz porque: alocacao de fundos (' + reason + ')')
  ok(await page.evaluate(() => !document.querySelector('[data-testid="batch-bar"]')), 'sem selecao nao ha barra de lote')
  for (const id of [bA.id, bB.id]) await page.click(`[data-movement="${id}"] input[data-check]`)
  await page.waitForSelector('[data-testid="batch-bar"]')
  const nSel = await page.$eval('[data-batch-count]', (el) => Number(el.getAttribute('data-batch-count')))
  ok(nSel === 2, 'barra de lote mostra 2 selecionados (' + nSel + ')')
  const auditA0 = (await api.from('audit_log').select('id', { count: 'exact', head: true }).eq('tabela', 'movements').eq('registo_id', bA.id)).count
  await page.click('[data-batch-validate]')
  const untilBatch = async () => { const t0 = Date.now(); for (;;) { const { data } = await api.from('movements').select('id,estado,validado_por').in('id', [bA.id, bB.id]); if (data?.every((x) => x.estado === 'confirmado') || Date.now() - t0 > 15000) return data; await sleep(250) } }
  const batched = await untilBatch()
  ok(batched.length === 2 && batched.every((x) => x.estado === 'confirmado' && x.validado_por === uid), 'lote: os 2 validados de uma vez, com validado_por = utilizador (o servidor regista)')
  const auditA1 = (await api.from('audit_log').select('id', { count: 'exact', head: true }).eq('tabela', 'movements').eq('registo_id', bA.id)).count
  ok(auditA1 - auditA0 === 1, 'lote: uma entrada de audit por movimento (' + (auditA1 - auditA0) + ')')
  await page.waitForFunction(() => !document.querySelector('[data-testid="batch-bar"]'), { timeout: 10000 })
  ok(true, 'lote: a selecao limpa-se no fim')
  // filtro "Sem conta" (so leitura: nao altera dados reais)
  await page.goto(BASE + '/contabilidade', { waitUntil: 'networkidle2' })
  await page.waitForSelector('[data-kpi="pending"]')
  await clickPill('Tudo')
  const hasNoAcc = await clickPill('Sem conta')
  if (hasNoAcc) {
    await sleep(500)
    const allNoAcc = await page.evaluate(() => { const cards = [...document.querySelectorAll('[data-testid="movement-list"] [data-movement]')]; return cards.length > 0 && cards.every((c) => c.innerText.includes('Sem conta')) })
    ok(allNoAcc, 'filtro "Sem conta": so aparecem movimentos sem conta')
  } else ok(true, 'filtro "Sem conta": nao ha movimentos sem conta (pilula escondida)')
  await clickPill('Todas')
  await waitCard(alloc.id)

  // ---- vista "Por ligar": marcar/desmarcar "Sem registo previsto"; a vista segue o ?view= mesmo dentro da app ----
  const waitDb = async (q, pred, ms = 15000) => { const t0 = Date.now(); for (;;) { const { data } = await q(); if (pred(data) || Date.now() - t0 > ms) return data; await sleep(250) } }
  const uA = await mk({ data: future, tipo: 'debito', valor: 9, subcategoria: 'outro', pessoa_responsavel: 'Teste UI', operation_id: op.id, rota_id: route.id, lancamento_referencia_id: transfer.id, descricao: 'TESTE-UI por ligar' })
  await page.goto(BASE + '/contabilidade?view=unlinked', { waitUntil: 'networkidle2' })
  await page.waitForSelector('[data-testid="unlinked-view"]', { timeout: 10000 })
  ok(true, 'carregar com ?view=unlinked abre a vista "Por ligar"')
  await waitCard(uA.id)
  const pillTxt = await page.evaluate(() => [...document.querySelectorAll('button[aria-pressed="true"]')].map((b) => b.innerText.trim()).find((x) => x.startsWith('Por ligar')))
  ok(/^Por ligar \(\d+\)$/.test(pillTxt ?? ''), 'pilula "Por ligar (N)" com contador (' + pillTxt + ')')
  ok(await page.$eval(`[data-movement="${uA.id}"]`, (el) => el.innerText.includes('Por ligar')), 'a alocacao por ligar diz ha quantos dias espera')
  const flagDb = () => api.from('movements').select('sem_registo_previsto').eq('id', uA.id).single()
  await page.click(`[data-movement="${uA.id}"] input[data-check]`)
  await page.waitForSelector('[data-batch-norecord]')
  await page.click('[data-batch-norecord]')
  const marked = await waitDb(() => flagDb(), (d) => d?.sem_registo_previsto === true)
  ok(marked.sem_registo_previsto === true, 'lote: "Sem registo previsto" gravado (servidor)')
  await page.waitForFunction((id) => document.querySelector(`[data-testid="unlinked-flagged"] [data-movement="${id}"]`) !== null, { timeout: 10000 }, uA.id)
  ok(true, 'a marcada passa para a secao "Sem registo previsto" e sai de "Por ligar"')
  await page.click(`[data-movement="${uA.id}"] input[data-check]`)
  await page.waitForSelector('[data-batch-unnorecord]')
  await page.click('[data-batch-unnorecord]')
  const unmarked = await waitDb(() => flagDb(), (d) => d?.sem_registo_previsto === false)
  ok(unmarked.sem_registo_previsto === false, 'lote: "Voltar a por ligar" desfaz a marca')
  await page.evaluate(() => { history.pushState({}, '', '/contabilidade?view=list'); window.dispatchEvent(new PopStateEvent('popstate')) })
  await page.waitForFunction(() => !document.querySelector('[data-testid="unlinked-view"]'), { timeout: 10000 })
  await clickPill('Tudo')
  await waitCard(alloc.id)

  // ---- 4.a ronda: ?mov= inexistente avisa; aviso de conta por defeito; "marcar tudo como lido" marca TODAS ----
  await page.goto(BASE + '/contabilidade?view=list&mov=00000000-0000-0000-0000-000000000000', { waitUntil: 'networkidle2' })
  await page.waitForSelector('[data-testid="mov-gone"]', { timeout: 15000 })
  ok(true, '?mov= de um movimento que ja nao existe mostra um aviso (nao fica em silencio)')
  const cfg = (await api.from('accounting_settings').select('default_account_id').limit(1)).data?.[0]
  const semConta = (await api.from('movements').select('id', { count: 'exact', head: true }).is('deleted_at', null).is('conta_id', null).eq('origem', 'automatico')).count ?? 0
  await page.goto(BASE + '/contabilidade?view=settings', { waitUntil: 'networkidle2' })
  await page.waitForFunction(() => document.body.innerText.includes('Limite') || document.body.innerText.includes('limite'), { timeout: 15000 }).catch(() => {})
  await sleep(800)
  const warned = await page.evaluate(() => Boolean(document.querySelector('[data-testid="no-default-account"]')))
  const expectWarn = !cfg?.default_account_id && semConta > 0
  ok(warned === expectWarn, `aviso "sem conta por defeito" nas Definicoes: ${warned ? 'mostrado' : 'escondido'} (conta por defeito ${cfg?.default_account_id ? 'definida' : 'nula'}, ${semConta} automaticos sem conta)`)
  const unreadDb = async () => (await api.from('notifications').select('id', { count: 'exact', head: true }).is('lido_em', null)).count ?? 0
  const unreadBefore = await unreadDb()
  if (unreadBefore > 0) {
    const badge = await page.evaluate(() => document.querySelector('button[aria-label="Notificações"] span')?.innerText ?? '')
    ok(badge === (unreadBefore > 9 ? '9+' : String(unreadBefore)), `crachá do sino = contagem verdadeira de nao lidas (${badge} para ${unreadBefore})`)
    await page.click('button[aria-label="Notificações"]')
    await page.evaluate(() => [...document.querySelectorAll('[role=dialog] button')].find((b) => b.innerText.trim().startsWith('Marcar tudo'))?.click())
    const t0 = Date.now(); let left = unreadBefore
    while (left > 0 && Date.now() - t0 < 15000) { await sleep(300); left = await unreadDb() }
    ok(left === 0, `"Marcar tudo como lido" marcou TODAS (${unreadBefore} -> ${left}), nao so as 40 carregadas`)
  } else ok(true, 'sem notificacoes por ler (verificacao ignorada)')
  await page.goto(BASE + '/contabilidade', { waitUntil: 'networkidle2' })
  await page.waitForSelector('[data-kpi="pending"]')
  await clickPill('Tudo')
  await waitCard(alloc.id)

  // ---- Agrupado: cada movimento uma so vez (transferencia + alocacoes distintas) ----
  await clickPill('Agrupado')
  await page.waitForSelector('[data-testid="grouped-view"]')
  const counts = await page.evaluate((ids) => ids.map((id) => document.querySelectorAll(`[data-testid="grouped-view"] [data-movement="${id}"]`).length), [transfer.id, alloc.id, alloc2.id])
  ok(counts.every((c) => c === 1), 'Agrupado: transferencia e alocacoes aparecem exatamente uma vez cada (' + counts.join(',') + ')')
  const group = await page.evaluate((id) => { const el = document.querySelector(`[data-movement="${id}"]`); const d = el.closest('details').querySelector('summary').innerText; return d }, alloc2.id)
  ok(/Rota A/.test(group), 'Agrupado: a alocacao esta no grupo da sua Rota (' + group.split('\n')[0] + ')')
  await page.screenshot({ path: '.shots/acc-agrupado.png' })

  // ---- Quadro: arrastar na diagonal (estado + linha) = uma atualizacao, um audit ----
  await clickPill('Quadro')
  await page.waitForSelector('[data-testid="board"]')
  await clickPill('Tudo')
  await waitCard(alloc2.id)
  const cellOf = (id) => page.evaluate((i) => document.querySelector(`[data-movement="${i}"]`)?.closest('[data-cell]')?.getAttribute('data-cell'), id)
  const from = await cellOf(alloc2.id)
  ok(from === `${route.id}|pendente`, 'Quadro: cartao pendente na linha da Rota A (' + from + ')')
  const auditBefore = (await api.from('audit_log').select('id', { count: 'exact', head: true }).eq('tabela', 'movements').eq('registo_id', alloc2.id)).count
  // o cartao move-se otimisticamente; a BD so reflete quando o PATCH termina (arrastos do mesmo cartao correm em serie)
  const untilDb = async (q, pred, ms = 15000) => { const t0 = Date.now(); for (;;) { const { data } = await q(); if (pred(data) || Date.now() - t0 > ms) return data; await new Promise((r) => setTimeout(r, 250)) } }
  const drag = (id, cell) => page.evaluate(async (i, c) => {
    const dt = new DataTransfer()
    const card = document.querySelector(`[data-movement="${i}"]`)
    const target = document.querySelector(`[data-cell="${c}"]`)
    const fire = (el, type) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }))
    fire(card, 'dragstart'); await new Promise((r) => setTimeout(r, 80))
    fire(target, 'dragenter'); fire(target, 'dragover'); await new Promise((r) => setTimeout(r, 80))
    const highlighted = target.className.includes('border-brand')
    fire(target, 'drop'); fire(card, 'dragend')
    return highlighted
  }, id, cell)
  const highlighted = await drag(alloc2.id, `__geral|confirmado`)
  ok(highlighted, 'Quadro: a celula de destino destaca-se durante o arrasto')
  await page.waitForFunction((i) => document.querySelector(`[data-movement="${i}"]`)?.closest('[data-cell]')?.getAttribute('data-cell') === '__geral|confirmado', { timeout: 15000 }, alloc2.id)
  ok(true, 'Quadro: diagonal moveu o cartao para Geral + Confirmado')
  const mv = await untilDb(() => api.from('movements').select('estado,rota_id,operation_id').eq('id', alloc2.id).single(), (d) => d?.estado === 'confirmado' && d.rota_id === null)
  ok(mv.estado === 'confirmado' && mv.rota_id === null && mv.operation_id === op.id, 'BD: estado=confirmado, rota removida (operacao mantida)')
  const auditAfter = (await api.from('audit_log').select('id', { count: 'exact', head: true }).eq('tabela', 'movements').eq('registo_id', alloc2.id)).count
  ok(auditAfter - auditBefore === 1, 'audit: a diagonal gerou UMA so entrada (' + (auditAfter - auditBefore) + ')')
  // outra linha, mesma coluna: reclassifica a rota
  await drag(alloc2.id, `${route.id}|confirmado`)
  await page.waitForFunction((i, c) => document.querySelector(`[data-movement="${i}"]`)?.closest('[data-cell]')?.getAttribute('data-cell') === c, { timeout: 15000 }, alloc2.id, `${route.id}|confirmado`)
  const mv2 = await untilDb(() => api.from('movements').select('estado,rota_id').eq('id', alloc2.id).single(), (d) => d?.rota_id === route.id)
  ok(mv2.rota_id === route.id && mv2.estado === 'confirmado', 'Quadro: mesma coluna, outra linha = so reclassifica a rota')
  await page.screenshot({ path: '.shots/acc-quadro.png' })

  // ---- distribuicao: soma alocada vs recebido, visivel ----
  await clickPill('Distribuições')
  await page.waitForFunction(() => document.body.innerText.includes('Teste UI'))
  const dist = await page.evaluate(() => [...document.querySelectorAll('[data-alloc-state]')].map((e) => e.getAttribute('data-alloc-state')))
  ok(dist.includes('under'), 'Distribuicao: sub-alocacao (200 recebido, 90 alocado) visivel como "Por alocar"')
  await page.screenshot({ path: '.shots/acc-distribuicao.png' })

  // ---- mobile: sem drag fisico; tocar no cartao -> bottom sheet -> escolher destino ----
  // ---- reclassificar uma alocacao JA propagada pede confirmacao (cancelar nao muda nada; confirmar apaga a linha e religa) ----
  const other = (await api.from('routes').select('id').eq('operation_id', op.id).neq('id', route.id).is('deleted_at', null).limit(1)).data?.[0]
  if (!other) ok(true, 'reclassificar alocacao propagada: sem 2.a rota na operacao (verificacao ignorada)')
  else {
    const dRel = '2031-05-05'
    const rec = (await api.from('daily_records').insert({ route_id: route.id, data: dRel }).select('id').single()).data
    createdRecs.push(rec.id)
    const rl = await mk({ data: dRel, tipo: 'debito', valor: 7, subcategoria: 'outro', pessoa_responsavel: 'Teste UI', operation_id: op.id, rota_id: route.id, lancamento_referencia_id: transfer.id, descricao: 'TESTE-UI relink' })
    const dbRl = () => api.from('movements').select('rota_id,registo_id').eq('id', rl.id).single()
    ok((await dbRl()).data.registo_id === rec.id, 'alocacao criada com registo existente fica propagada (registo_id preenchido)')
    await page.goto(BASE + '/contabilidade', { waitUntil: 'networkidle2' })
    await page.waitForSelector('[data-kpi="pending"]')
    await clickPill('Tudo')
    await waitCard(rl.id)
    const openMove = async () => {
      await page.click(`[data-movement="${rl.id}"]`)
      await page.waitForFunction(() => [...document.querySelectorAll('[role=dialog] button')].some((b) => b.innerText.trim().startsWith('Mover')), { timeout: 10000 })
      await page.evaluate(() => [...document.querySelectorAll('[role=dialog] button')].find((b) => b.innerText.trim().startsWith('Mover'))?.click())
      await page.waitForFunction(() => document.body.innerText.includes('Mover lançamento'), { timeout: 10000 })
      await page.evaluate((v) => {
        const sel = [...document.querySelectorAll('[role=dialog] label')].find((l) => l.innerText.startsWith('Linha'))?.querySelector('select')
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, v); sel.dispatchEvent(new Event('change', { bubbles: true }))
      }, other.id)
      await page.evaluate(() => [...document.querySelectorAll('[role=dialog] button')].find((b) => b.innerText.trim() === 'Aplicar')?.click())
      await page.waitForSelector('[data-testid="relink-confirm"]', { timeout: 10000 })
    }
    await openMove()
    ok(await page.$eval('[data-testid="relink-confirm"]', (el) => el.innerText.includes('linha de custo')), 'mudar a rota de uma alocacao propagada pede confirmacao')
    await page.click('[data-relink-cancel]')
    await sleep(800)
    const kept = (await dbRl()).data
    ok(kept.rota_id === route.id && kept.registo_id === rec.id, 'cancelar: nada muda (rota e ligacao ao registo intactas)')
    await page.waitForFunction(() => !document.querySelector('[data-testid="relink-confirm"]'), { timeout: 5000 })
    await openMove()
    await page.click('[data-relink-confirm]')
    const moved = await untilDb(() => dbRl(), (d) => d?.rota_id === other.id)
    ok(moved.rota_id === other.id && moved.registo_id === null, 'confirmar: reclassifica, apaga a linha do registo antigo e fica "por ligar" (sem registo na nova rota+data)')
    const lines = (await api.from('daily_record_costs').select('id,deleted_at').eq('record_id', rec.id).eq('movimento_id', rl.id)).data
    ok(lines.length === 1 && lines[0].deleted_at !== null, 'a linha de custo antiga ficou em soft delete')
  }

  const mctx = await browser.createBrowserContext()
  const m = await mctx.newPage()
  await m.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 })
  m.on('pageerror', (e) => errors.push('mobile pageerror: ' + e.message))
  await m.goto(BASE, { waitUntil: 'networkidle2' })
  await m.waitForSelector('input[type=email]')
  await m.type('input[type=email]', email)
  await m.type('input[type=password]', password)
  await m.click('button[type=submit]')
  await m.waitForFunction(() => !document.querySelector('input[type=password]'), { timeout: 20000 })
  await m.goto(BASE + '/contabilidade?view=board', { waitUntil: 'networkidle2' })
  await m.waitForSelector('[data-testid="board"]')
  await m.evaluate(() => [...document.querySelectorAll('button[aria-pressed]')].find((x) => x.innerText.trim().startsWith('Tudo'))?.click())
  await m.waitForSelector(`[data-movement="${alloc2.id}"]`, { timeout: 15000 })
  const hint = await m.evaluate(() => document.querySelector('[data-testid="board"] p')?.innerText)
  ok(/Toca num cart/.test(hint ?? ''), 'mobile: quadro indica "Toca num cartao para o mover" (sem drag)')
  const draggable = await m.evaluate((id) => document.querySelector(`[data-movement="${id}"]`).getAttribute('draggable'), alloc2.id)
  ok(draggable === null || draggable === 'false', 'mobile: cartoes nao sao arrastaveis')
  await sleep(1500) // deixa o layout assentar (o quadro tem scroll horizontal e as rotas chegam depois)
  await m.evaluate((id) => {
    const c = document.querySelector(`[data-movement="${id}"]`)
    c.scrollIntoView({ block: 'center', inline: 'center' })
    const r = c.getBoundingClientRect()
    const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
    return { rect: [r.x, r.y, r.width, r.height].map(Math.round), onCard: c.contains(top), top: top?.tagName + '.' + String(top?.className).slice(0, 60) }
  }, alloc2.id)
  await m.tap(`[data-movement="${alloc2.id}"]`)
  await m.waitForFunction(() => document.body.innerText.includes('Mover lançamento'), { timeout: 10000 })
  await m.screenshot({ path: '.shots/acc-mobile-mover.png' })
  await m.evaluate(() => {
    const sel = [...document.querySelectorAll('[role=dialog] label')].find((l) => l.innerText.startsWith('Coluna'))?.querySelector('select')
    const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
    set.call(sel, 'pendente'); sel.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await m.evaluate(() => [...document.querySelectorAll('[role=dialog] button')].find((b) => b.innerText.trim() === 'Aplicar')?.click())
  await m.waitForFunction((i) => document.querySelector(`[data-movement="${i}"]`)?.hasAttribute('data-pending'), { timeout: 15000 }, alloc2.id)
  const mm = await untilDb(() => api.from('movements').select('estado').eq('id', alloc2.id).single(), (d) => d?.estado === 'pendente')
  ok(mm.estado === 'pendente', 'mobile: bottom sheet moveu o cartao (Confirmado -> Pendente) e a BD confirma')
  await m.screenshot({ path: '.shots/acc-mobile-quadro.png' })
  await mctx.close()
} finally {
  await browser.close()
  // limpeza: soft delete com motivo (nada se apaga fisicamente)
  for (const id of createdRecs) await api.from('daily_records').update({ deleted_at: new Date().toISOString() }).eq('id', id)
  for (const id of created) await api.from('movements').update({ deleted_at: new Date().toISOString(), motivo_apagado: 'teste automatico de UI' }).eq('id', id)
}

if (errors.length) { console.log('\nERROS:'); for (const e of [...new Set(errors)]) console.log(' -', e); failed += errors.length }
console.log(failed ? '\nUI ACCOUNTING: FALHOU' : '\nUI ACCOUNTING: OK')
process.exitCode = failed ? 1 : 0
