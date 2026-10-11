// Edge Function: envia web push para um utilizador quando nasce uma notificacao.
// Chamada pelo trigger de BD (pg_net) com o cabecalho x-push-secret. Deploy com --no-verify-jwt.
// Segredos: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT, PUSH_WEBHOOK_SECRET.
import { createClient } from 'npm:@supabase/supabase-js@2'
import webpush from 'npm:web-push@3.6.7'

type Lang = 'pt' | 'en'
const TEXT: Record<string, Record<Lang, (p: Record<string, unknown>) => string>> = {
  record_submitted: { pt: (p) => `Registo submetido (${p.data})`, en: (p) => `Record submitted (${p.data})` },
  record_reopened: { pt: (p) => `Registo validado foi editado e reaberto (${p.data})`, en: (p) => `A validated record was edited and reopened (${p.data})` },
  record_missing: { pt: (p) => `Falta o registo de hoje: ${p.route}`, en: (p) => `Today's record is missing: ${p.route}` },
  fund_unreconciled: { pt: (p) => `Fundo por reconciliar: ${p.pessoa} (${p.valor} €)`, en: (p) => `Unreconciled funds: ${p.pessoa} (€${p.valor})` },
  fund_over_allocated: {
    pt: (p) => `Sobre-alocação: ${p.pessoa} — alocado ${p.alocado} € de ${p.valor} € (excesso ${p.excesso} €)`,
    en: (p) => `Over-allocated: ${p.pessoa} — €${p.alocado} allocated of €${p.valor} (excess €${p.excesso})`,
  },
  allocation_unlinked: {
    pt: (p) => `Alocação por ligar: ${p.valor} € para ${p.route} (${p.data}) — falta criar o registo diário`,
    en: (p) => `Unlinked allocation: €${p.valor} for ${p.route} (${p.data}) — the daily record is missing`,
  },
  auto_cost_disputed: {
    pt: (p) => `Correção pedida: lançamento automático de ${p.valor} € em ${p.route} (${p.data}). ${p.note ?? ''}`,
    en: (p) => `Correction requested: automatic entry of €${p.valor} in ${p.route} (${p.data}). ${p.note ?? ''}`,
  },
  margin_negative: { pt: (p) => `Margem negativa em ${p.operation} (${p.periodo})`, en: (p) => `Negative margin in ${p.operation} (${p.periodo})` },
  movement_pending: {
    pt: (p) => (p.kind === 'auto' ? `Novo lançamento automático por validar — €${p.valor} em ${p.destino}` : `Nova alocação de fundos por validar — €${p.valor} em ${p.destino}`),
    en: (p) => (p.kind === 'auto' ? `New automatic entry to validate — €${p.valor} in ${p.destino}` : `New fund allocation to validate — €${p.valor} in ${p.destino}`),
  },
  cost_due: { pt: (p) => `${String(p.custo).toUpperCase()} a vencer: ${p.matricula} (${p.vencimento})`, en: (p) => `${String(p.custo).toUpperCase()} due: ${p.matricula} (${p.vencimento})` },
}

Deno.serve(async (req) => {
  if (req.headers.get('x-push-secret') !== Deno.env.get('PUSH_WEBHOOK_SECRET')) return new Response('unauthorized', { status: 401 })

  const { user_id, tipo, payload } = await req.json()
  webpush.setVapidDetails(Deno.env.get('VAPID_SUBJECT')!, Deno.env.get('VAPID_PUBLIC_KEY')!, Deno.env.get('VAPID_PRIVATE_KEY')!)

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  const [{ data: subs }, { data: prof }] = await Promise.all([
    admin.from('push_subscriptions').select('id,endpoint,keys').eq('user_id', user_id),
    admin.from('profiles').select('idioma').eq('id', user_id).maybeSingle(),
  ])
  if (!subs?.length) return Response.json({ sent: 0 })

  const lang: Lang = prof?.idioma === 'en' ? 'en' : 'pt'
  const body = TEXT[tipo]?.[lang](payload ?? {}) ?? tipo
  // destino do clique: quem so tem Contabilidade nao acede a /registar
  let canRegister = true
  if (tipo === 'allocation_unlinked') {
    const { data: rs } = await admin.from('user_roles').select('role').eq('user_id', user_id)
    canRegister = (rs ?? []).some((r: { role: string }) => ['super_admin', 'gestor', 'operador'].includes(r.role))
  }
  const rec = payload?.route_id ? `/registar?rota=${payload.route_id}${payload.data ? `&data=${payload.data}` : ''}` : '/'
  const url =
    tipo === 'movement_pending' ? (payload?.movement_id ? `/contabilidade?view=validate&mov=${payload.movement_id}` : '/contabilidade?view=validate')
    : tipo === 'allocation_unlinked' ? (canRegister ? rec : '/contabilidade?view=unlinked')
    : tipo === 'auto_cost_disputed' ? rec
    : '/'
  const message = JSON.stringify({ title: 'Última Milha', body, tipo, url })

  let sent = 0
  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, message)
        sent++
      } catch (e) {
        // subscricao expirada/revogada: remove
        if ((e as { statusCode?: number }).statusCode === 404 || (e as { statusCode?: number }).statusCode === 410) {
          await admin.from('push_subscriptions').delete().eq('id', s.id)
        }
      }
    }),
  )
  return Response.json({ sent })
})
