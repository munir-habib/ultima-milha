// Edge Function: cria o convite (com as permissoes de quem convida) e envia o email de convite.
// Deploy: supabase functions deploy invite-user
// Requer os segredos SUPABASE_URL, SUPABASE_ANON_KEY e SUPABASE_SERVICE_ROLE_KEY (injetados por defeito).
import { createClient } from 'npm:@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  const auth = req.headers.get('Authorization')
  if (!auth) return json({ error: 'unauthorized' }, 401)

  const { email, roles, operation_ids, accounting_read } = await req.json()

  // 1) o convite e criado como o utilizador que convida: a RPC aplica a matriz de permissoes
  const asUser = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: auth } },
  })
  const { error: rpcError } = await asUser.rpc('create_invitation', {
    p_email: email,
    p_roles: roles,
    p_operation_ids: operation_ids ?? [],
    p_accounting_read: Boolean(accounting_read),
  })
  if (rpcError) return json({ error: rpcError.message }, 400)

  // 2) so depois de autorizado se envia o email (service role)
  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  const { error: mailError } = await admin.auth.admin.inviteUserByEmail(String(email).trim().toLowerCase())
  if (mailError) return json({ error: mailError.message }, 400)

  return json({ ok: true })
})
