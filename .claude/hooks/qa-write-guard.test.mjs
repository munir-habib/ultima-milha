// Testes do guarda do agente ultima-milha-tester:  node --test .claude/hooks/qa-write-guard.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'

const ROOT = path.resolve(new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const GUARD = path.join(ROOT, '.claude', 'hooks', 'qa-write-guard.mjs')

function run(tool_name, tool_input) {
  const r = spawnSync('node', [GUARD], { input: JSON.stringify({ tool_name, tool_input, cwd: ROOT }), encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: ROOT, GUARD_LOG: 'off' } })
  return { code: r.status, err: r.stderr }
}
const allowed = (tool, input, msg) => assert.equal(run(tool, input).code, 0, `devia PERMITIR: ${msg ?? JSON.stringify(input)}`)
const denied = (tool, input, msg) => {
  const r = run(tool, input)
  assert.equal(r.code, 2, `devia BLOQUEAR: ${msg ?? JSON.stringify(input)}`)
  assert.match(r.err, /BLOQUEADO/)
}
const bash = (command) => ({ command })

const PROTECTED = 'scripts/test-user.mjs'

test('Write/Edit: so dentro de qa/', () => {
  for (const tool of ['Write', 'Edit', 'MultiEdit']) {
    allowed(tool, { file_path: path.join(ROOT, 'qa', 'cenario.mjs') })
    allowed(tool, { file_path: 'qa/relatorios/2026-09-19.md' }, 'caminho relativo em qa/')
    allowed(tool, { file_path: path.join(ROOT, 'qa', 'sub', 'a.json').replace(/\//g, '\\') }, 'barras invertidas (Windows)')
    denied(tool, { file_path: path.join(ROOT, PROTECTED) }, `${tool} em ${PROTECTED} (absoluto)`)
    denied(tool, { file_path: PROTECTED }, `${tool} em ${PROTECTED} (relativo)`)
    denied(tool, { file_path: path.join(ROOT, 'scripts', 'test-user.mjs').replace(/\//g, '\\') }, `${tool} ${PROTECTED} com barras invertidas`)
    denied(tool, { file_path: path.join(ROOT, 'src', 'App.tsx') })
    denied(tool, { file_path: path.join(ROOT, 'supabase', 'migrations', 'x.sql') })
    denied(tool, { file_path: path.join(ROOT, '.claude', 'hooks', 'qa-write-guard.mjs') }, 'o agente nao pode desligar o proprio guarda')
    denied(tool, { file_path: path.join(ROOT, '.claude', 'agents', 'ultima-milha-tester.md') }, 'nem editar a sua definicao')
    denied(tool, { file_path: path.join(ROOT, 'package.json') })
    denied(tool, { file_path: path.join(ROOT, '.env') })
    denied(tool, { file_path: path.join(ROOT, 'CLAUDE.md') })
  }
})

test('Write: truques de caminho nao contornam', () => {
  denied('Write', { file_path: path.join(ROOT, 'qa', '..', 'scripts', 'test-user.mjs') }, 'qa/../scripts/test-user.mjs')
  denied('Write', { file_path: 'qa/../scripts/test-user.mjs' }, 'relativo com ..')
  denied('Write', { file_path: 'qa\\..\\scripts\\test-user.mjs' }, 'relativo, barras invertidas e ..')
  denied('Write', { file_path: path.join(ROOT, 'qa-evil', 'x.mjs') }, 'pasta irma qa-evil/')
  denied('Write', { file_path: path.join(ROOT, 'qa') }, 'a propria pasta qa (sem ficheiro)')
  denied('Write', { file_path: 'C:/Windows/Temp/x.txt' }, 'fora do projeto')
  denied('Write', {}, 'sem caminho')
  denied('Write', { file_path: path.join(ROOT, 'QA', '..', 'src', 'x.ts') }, 'maiusculas + ..')
})

test('Bash: EXECUTAR scripts/test-user.mjs e permitido; ALTERA-LO nunca', () => {
  allowed('Bash', bash("node scripts/test-user.mjs qa.novo@example.test '<QA_PASSWORD>' operador --ops \"Lisboa Norte\""), 'executar o helper')
  allowed('Bash', bash(`cat ${PROTECTED}`), 'ler o helper')
  allowed('Bash', bash(`node scripts/test-user.mjs a@b.test 'x' operador 2>&1 | tail -3`), 'executar com pipe/2>&1')
  denied('Bash', bash(`echo "// x" >> ${PROTECTED}`), 'append por redirecao')
  denied('Bash', bash(`echo x > ${PROTECTED}`))
  denied('Bash', bash(`cat > ${PROTECTED} <<'EOF'\nx\nEOF`), 'heredoc')
  denied('Bash', bash(`node scripts/test-user.mjs a b operador > ${PROTECTED}`), 'redirecionar a saida do proprio helper para ele')
  denied('Bash', bash(`sed -i 's/operador/admin/' ${PROTECTED}`))
  denied('Bash', bash(`sed -i.bak 's/a/b/' ${PROTECTED}`))
  denied('Bash', bash(`perl -pi -e 's/a/b/' ${PROTECTED}`))
  denied('Bash', bash(`cp qa/x.mjs ${PROTECTED}`))
  denied('Bash', bash(`mv qa/x.mjs ${PROTECTED}`))
  denied('Bash', bash(`mv ${PROTECTED} qa/roubado.mjs`), 'tirar o ficheiro do sitio')
  denied('Bash', bash(`rm ${PROTECTED}`))
  denied('Bash', bash(`rm -f scripts/*`))
  denied('Bash', bash(`tee ${PROTECTED} < qa/x.mjs`))
  denied('Bash', bash(`echo x | tee -a ${PROTECTED}`))
  denied('Bash', bash(`touch ${PROTECTED}`))
  denied('Bash', bash(`chmod +x ${PROTECTED}`))
  denied('Bash', bash(`git checkout -- ${PROTECTED}`))
  denied('Bash', bash(`git restore ${PROTECTED}`))
  denied('Bash', bash(`git stash`))
  denied('Bash', bash(`node -e "require('fs').appendFileSync('${PROTECTED}','x')"`), 'node -e')
  denied('Bash', bash(`node -e "require('fs').writeFileSync('scripts/test-user.mjs','')"`))
  denied('Bash', bash(`python -c "open('${PROTECTED}','w').write('x')"`))
  denied('Bash', bash(`powershell -Command "Set-Content ${PROTECTED} x"`))
  denied('Bash', bash(`powershell -Command "Add-Content -Path ${PROTECTED} -Value x"`))
  denied('Bash', bash(`powershell -Command "Remove-Item ${PROTECTED}"`))
  denied('Bash', bash(`cd scripts && echo x >> test-user.mjs`), 'com cd antes (caminho relativo ao root: scripts/ nao e qa/)')
  denied('Bash', bash(`echo ok && echo x >> ${PROTECTED}`), 'encadeado')
  denied('Bash', bash(`ls; rm ${PROTECTED}`), 'apos ;')
})

test('Bash: escritas em qa/ e leituras continuam a funcionar', () => {
  allowed('Bash', bash('mkdir -p qa/relatorios'))
  allowed('Bash', bash('echo "ok" > qa/notas.txt'))
  allowed('Bash', bash('node qa/cenario.mjs > qa/saida.log 2>&1'))
  allowed('Bash', bash('node qa/cenario.mjs 2>/dev/null'))
  allowed('Bash', bash('cp qa/a.json qa/b.json'))
  allowed('Bash', bash('rm qa/tmp.json'))
  allowed('Bash', bash('ls scripts && cat scripts/e2e-check.mjs | head -20'))
  allowed('Bash', bash('grep -rn "movements" src | head'))
  allowed('Bash', bash('npm run test:db'))
  allowed('Bash', bash('npm test'))
  allowed('Bash', bash('node scripts/e2e-check.mjs'))
  allowed('Bash', bash('git status --short'))
  allowed('Bash', bash('git diff --stat'))
  allowed('Bash', bash('git log --oneline | head -3'))
  allowed('Bash', bash(`npx supabase db query --linked "select count(*) from movements"`))
  allowed('Bash', bash(`npx supabase db query --linked "insert into movements (tenant_id) values ('x') -- QA move copy touch"`), 'palavras suspeitas dentro de SQL nao disparam')
  allowed('Bash', bash(`curl -s https://example.com | head`))
})

test('Bash: nada de alterar o projeto (git, dependencias, schema, funcoes, segredos)', () => {
  for (const c of ['git add -A', 'git commit -m x', 'git push', 'git reset --hard', 'git clean -fd', 'git apply x.patch', 'git rm scripts/test-user.mjs', 'git -C . commit -m x'])
    denied('Bash', bash(c), c)
  for (const c of ['npm install lodash', 'npm i -D x', 'npm uninstall vitest', 'npm update', 'npm ci'])
    denied('Bash', bash(c), c)
  for (const c of ['npx supabase db push', 'npx supabase db reset', 'npx supabase functions deploy send-push', 'npx supabase secrets set X=1', 'npx supabase migration new x', 'npx supabase link --project-ref x', 'npx supabase config push'])
    denied('Bash', bash(c), c)
})

test('Bash: SQL de dados sim, schema/seguranca nao (mesmo escondido num ficheiro -f)', () => {
  for (const sql of [
    'alter table movements add column x int',
    'create or replace function app.movements_guard() returns trigger as $$ $$',
    'drop trigger movements_guard on movements',
    'create policy p on movements for select using (true)',
    'drop table movements',
    'truncate movements',
    'grant all on movements to anon',
    'alter table movements disable trigger all',
    "set session_replication_role = replica",
    "select cron.schedule('x','* * * * *','select 1')",
  ]) denied('Bash', bash(`npx supabase db query --linked "${sql}"`), sql)
  // DDL escondido num ficheiro: o guarda le o ficheiro
  mkdirSync(path.join(ROOT, 'qa', '_guard_test'), { recursive: true })
  try {
    writeFileSync(path.join(ROOT, 'qa', '_guard_test', 'ddl.sql'), 'alter table routes add column x int;')
    writeFileSync(path.join(ROOT, 'qa', '_guard_test', 'dados.sql'), "update routes set nome = nome where false;")
    denied('Bash', bash('npx supabase db query --linked -f qa/_guard_test/ddl.sql'), 'DDL dentro de -f')
    allowed('Bash', bash('npx supabase db query --linked -f qa/_guard_test/dados.sql'), 'dados dentro de -f')
  } finally {
    rmSync(path.join(ROOT, 'qa', '_guard_test'), { recursive: true, force: true })
  }
})

test('falha fechada: entrada invalida = bloqueio, nunca permissao', () => {
  const r = spawnSync('node', [GUARD], { input: 'isto nao e json', encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: ROOT, GUARD_LOG: 'off' } })
  assert.equal(r.status, 2)
})
