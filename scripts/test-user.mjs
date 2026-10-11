// Cria um utilizador de TESTE (fictício) num tenant, com os papéis e operações pedidos.
// Usa a CLI do Supabase já autenticada (npx supabase login) — não precisa de chaves privilegiadas.
//
//   node scripts/test-user.mjs <email> <password> <papeis> [opcoes]
//
//   papeis   lista separada por virgulas: super_admin,gestor,operador,motorista,contabilista,auditor
//   --ops    "Lisboa Norte,Porto Centro"   operacoes atribuidas (por nome; gestor/operador/motorista/auditor)
//   --accounting-read                       auditor com acesso de leitura a Contabilidade
//   --tenant-of <email>                     tenant do utilizador indicado (por defeito: demo.admin@example.test)
//   --new-tenant "Nome"                     cria um tenant NOVO (o utilizador fica Super Admin dele) — para testar isolamento
//   --name "Nome Completo"
//
// Exemplos:
//   node scripts/test-user.mjs qa.oper@example.test process.env.QA_PASSWORD operador --ops "Lisboa Norte"
//   node scripts/test-user.mjs qa.b@example.test process.env.QA_PASSWORD super_admin --new-tenant "QA Tenant B"
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient } from '@supabase/supabase-js'

const ROLES = ['super_admin', 'gestor', 'operador', 'motorista', 'contabilista', 'auditor']
const args = process.argv.slice(2)
const flag = (n) => { const i = args.indexOf(n); if (i < 0) return undefined; const v = args[i + 1]; args.splice(i, v && !v.startsWith('--') ? 2 : 1); return v && !v.startsWith('--') ? v : true }
const opsArg = flag('--ops'), accRead = flag('--accounting-read') === true, tenantOf = flag('--tenant-of') ?? 'demo.admin@example.test'
const newTenant = flag('--new-tenant'), fullName = flag('--name')
const [email, password, rolesArg] = args
if (!email || !password || (!rolesArg && !newTenant)) { console.error('uso: node scripts/test-user.mjs <email> <password> <papeis> [--ops "A,B"] [--accounting-read] [--tenant-of email] [--new-tenant "Nome"] [--name "Nome"]'); process.exit(2) }
const roles = (rolesArg ?? 'super_admin').split(',').map((r) => r.trim())
for (const r of roles) if (!ROLES.includes(r)) { console.error('papel invalido: ' + r); process.exit(2) }
if (!newTenant && roles.includes('super_admin')) { console.error('super_admin so se cria com --new-tenant (o primeiro utilizador de um tenant e Super Admin)'); process.exit(2) }

const q = (s) => `'${String(s).replace(/'/g, "''")}'`
const ops = String(opsArg ?? '').split(',').map((s) => s.trim()).filter(Boolean)
const meta = JSON.stringify({ full_name: fullName ?? email.split('@')[0], ...(newTenant ? { tenant_name: newTenant } : {}) })

const sql = `
do $$
declare uid uuid := gen_random_uuid(); v_tenant uuid; v_ops uuid[];
begin
  if exists (select 1 from auth.users where lower(email) = lower(${q(email)})) then raise notice 'ja existe'; return; end if;
  ${newTenant ? '' : `
  select tenant_id into v_tenant from profiles where lower(email) = lower(${q(tenantOf)});
  if v_tenant is null then raise exception 'tenant nao encontrado para ${tenantOf.replace(/'/g, '')}'; end if;
  select coalesce(array_agg(id), '{}') into v_ops from operations where tenant_id = v_tenant and deleted_at is null and nome = any(${ops.length ? `array[${ops.map(q).join(',')}]` : "'{}'::text[]"});
  if cardinality(v_ops) <> ${ops.length} then raise exception 'operacao(oes) nao encontrada(s): ${ops.join(',').replace(/'/g, '')}'; end if;
  delete from invitations where lower(email) = lower(${q(email)}) and accepted_at is null;
  insert into invitations (tenant_id, email, roles, operation_ids, accounting_read)
  values (v_tenant, lower(${q(email)}), array[${roles.map((r) => q(r) + '::app_role').join(',')}], v_ops, ${accRead});`}
  -- o trigger on_auth_user_created liga o utilizador ao tenant/papeis (ou cria tenant novo)
  insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
                          created_at, updated_at, confirmation_token, recovery_token, email_change, email_change_token_new, email_change_token_current)
  values ('00000000-0000-0000-0000-000000000000', uid, 'authenticated', 'authenticated', lower(${q(email)}),
          extensions.crypt(${q(password)}, extensions.gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}', ${q(meta)}::jsonb,
          now(), now(), '', '', '', '', '');
  insert into auth.identities (id, user_id, provider_id, provider, identity_data, last_sign_in_at, created_at, updated_at)
  values (gen_random_uuid(), uid, uid::text, 'email', jsonb_build_object('sub', uid::text, 'email', lower(${q(email)}), 'email_verified', true), now(), now(), now());
end $$;`

const dir = mkdtempSync(join(tmpdir(), 'um-user-'))
const file = join(dir, 'user.sql')
writeFileSync(file, sql)
const r = spawnSync('npx', ['supabase', 'db', 'query', '--linked', '-f', file], { encoding: 'utf8', shell: true })
if (r.status !== 0) { console.error((r.stderr || r.stdout).split('\n').filter((l) => /error|ERROR|nao encontrad|tenant/.test(l)).join('\n') || r.stderr); process.exit(1) }

// verificar: o login funciona e o perfil tem o que foi pedido
const env = Object.fromEntries(readFileSync(new URL('../.env', import.meta.url), 'utf8').split(/\r?\n/).filter((l) => l.includes('=')).map((l) => [l.split('=')[0], l.slice(l.indexOf('=') + 1).trim()]))
const sb = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY, { auth: { persistSession: false } })
const { data, error } = await sb.auth.signInWithPassword({ email, password })
if (error) { console.error('login falhou: ' + error.message); process.exit(1) }
const uid = data.user.id
const [p, ur, uo] = await Promise.all([
  sb.from('profiles').select('nome,tenant_id,accounting_read').eq('id', uid).single(),
  sb.from('user_roles').select('role').eq('user_id', uid),
  sb.from('user_operations').select('operation_id').eq('user_id', uid),
])
console.log(JSON.stringify({ ok: true, email, user_id: uid, tenant_id: p.data?.tenant_id, papeis: (ur.data ?? []).map((x) => x.role), operacoes: (uo.data ?? []).length, accounting_read: p.data?.accounting_read }))
