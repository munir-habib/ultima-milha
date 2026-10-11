// Helpers partilhados pelos cenarios do agente de testes (so leitura de .env; nada e impresso).
import { createClient } from '@supabase/supabase-js'
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8').split(/\r?\n/).filter((l) => l.includes('=')).map((l) => [l.split('=')[0], l.slice(l.indexOf('=') + 1).trim()]),
)
export const PW = process.env.QA_PASSWORD ?? env.QA_PASSWORD
export const ADMIN = ['demo.admin@example.test', process.env.DEMO_PASSWORD ?? env.DEMO_PASSWORD]
if (!PW) throw new Error('Defina QA_PASSWORD no .env (palavra-passe dos utilizadores de teste que criou com scripts/test-user.mjs)')

export async function login(email, password = PW) {
  const sb = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
  const { data, error } = await sb.auth.signInWithPassword({ email, password })
  if (error) throw new Error('login ' + email + ': ' + error.message)
  sb.uid = data.user.id
  return sb
}
export const anonClient = () => createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY, { auth: { persistSession: false } })

// SQL como postgres (ignora RLS) - SO para montar cenarios / verificar resultados
export function sql(query) {
  const dir = mkdtempSync(join(tmpdir(), 'qa-'))
  const f = join(dir, 'q.sql')
  writeFileSync(f, query)
  const r = spawnSync('npx', ['supabase', 'db', 'query', '--linked', '-f', f], { encoding: 'utf8', shell: true })
  const out = r.stdout ?? ''
  const i = out.indexOf('{')
  if (r.status !== 0 || i < 0) throw new Error('sql falhou: ' + ((r.stderr || '') + out).replace(/Initialising login role...s*/g, '').trim().slice(-1200))
  return JSON.parse(out.slice(i)).rows ?? []
}

export const results = []
let area = ''
export const setArea = (a) => { area = a; console.log('\n== ' + a) }
export async function t(name, fn) {
  try {
    const r = await fn()
    // fn devolve undefined/true = PASSOU; string = PASSOU com nota; {fail: 'msg'} = FALHOU
    if (r && r.fail) throw new Error(r.fail)
    results.push({ area, name, res: 'PASSOU', note: typeof r === 'string' ? r : '' })
    console.log('  PASSOU ', name, typeof r === 'string' ? '- ' + r : '')
  } catch (e) {
    results.push({ area, name, res: 'FALHOU', note: e.message })
    console.log('  FALHOU ', name, '-', e.message)
  }
}
export const eq = (a, b, msg) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg ?? 'esperado != observado'}: esperado ${JSON.stringify(b)}, observado ${JSON.stringify(a)}`) }
export const ok = (c, msg) => { if (!c) throw new Error(msg) }
// a acao TEM de ser recusada (erro ou 0 linhas afetadas)
export async function denied(p, msg) {
  const r = await p
  if (r.error) return r.error.message
  if (Array.isArray(r.data) && r.data.length === 0) return '0 linhas'
  if (r.data === null && (r.status === 204 || r.status === 200 || r.status === 201)) return '0 linhas'
  throw new Error(`${msg}: acao NAO foi recusada (${JSON.stringify(r.data).slice(0, 200)})`)
}
export const must = async (p) => { const r = await p; if (r.error) throw new Error(r.error.message); return r.data }
export function save(file) { writeFileSync(new URL(file, import.meta.url), JSON.stringify(results, null, 2)) }
