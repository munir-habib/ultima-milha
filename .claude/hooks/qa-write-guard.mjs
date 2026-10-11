// Guarda do agente ultima-milha-tester (hook PreToolUse, definido no frontmatter do agente => so ativo enquanto ele corre).
// Regra: o agente so pode ESCREVER dentro de <projeto>/qa/. Nunca em src/, supabase/, scripts/ (incl. scripts/test-user.mjs), .claude/, package.json, etc.
// Ler e EXECUTAR (node scripts/test-user.mjs ...) continua permitido.
// Bloqueia com exit 2 (a mensagem em stderr volta ao agente). Falha SEMPRE fechado.
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

const LOG = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), 'guard.log')
const log = (s) => { if (process.env.GUARD_LOG === 'off') return; try { appendFileSync(LOG,`${new Date().toISOString()} ${s}\n`) } catch { /* o log nunca bloqueia */ } }

const deny = (why, what) => {
  log(`DENY  ${what.slice(0, 200)}  <- ${why}`)
  process.stderr.write(`BLOQUEADO pelo guarda do agente de testes: ${why}\nSo podes escrever ficheiros dentro de qa/. Nao alteres codigo da aplicacao (src/, supabase/, scripts/, config): reporta o bug ao agente principal.\n`)
  process.exit(2)
}
const allow = (what) => { log(`ALLOW ${what.slice(0, 200)}`); process.exit(0) }

let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (d) => (input += d))
process.stdin.on('end', () => {
  try { main(JSON.parse(input || '{}')) } catch (e) { deny('erro interno do guarda (falha fechada): ' + e.message, 'guard-error') }
})

const norm = (p) => path.resolve(p).replace(/\\/g, '/').toLowerCase()

function main(ev) {
  const root = norm(process.env.CLAUDE_PROJECT_DIR || ev.cwd || process.cwd())
  const qa = root + '/qa/'
  const resolveFrom = (p) => norm(path.isAbsolute(p) ? p : path.join(root, p))
  /** dentro de qa/ (resolve `..`; nao aceita `qa-x/` nem `qa` sem barra) */
  const inQa = (p) => resolveFrom(p.replace(/^["']|["']$/g, '')).startsWith(qa)

  const tool = ev.tool_name ?? ''
  const ti = ev.tool_input ?? {}

  // ---------- ferramentas de escrita de ficheiros ----------
  if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(tool)) {
    const target = ti.file_path ?? ti.notebook_path ?? ti.path
    if (!target) deny('escrita sem caminho de ficheiro', tool)
    if (!inQa(target)) deny(`escrita fora de qa/: ${target}`, `${tool} ${target}`)
    return allow(`${tool} ${target}`)
  }

  if (tool !== 'Bash') return allow(tool) // Read/Grep/Glob: leitura

  // ---------- Bash ----------
  const cmd = String(ti.command ?? '')
  if (!cmd.trim()) return allow('bash-vazio')

  // 1) redirecoes: > >> >| (ignora /dev/null e duplicacao de fd tipo 2>&1)
  for (const m of cmd.matchAll(/(?:^|[^<>&\d])\d*(>>|>\||>)(?!&)\s*("[^"]*"|'[^']*'|[^\s;&|)]+)/g)) {
    const t = m[2]
    if (t === '/dev/null' || t.toLowerCase() === 'nul') continue
    if (!inQa(t)) deny(`redirecao de escrita para fora de qa/: ${t}`, cmd)
  }

  // 2) comandos de escrita/alteracao de ficheiros: todos os argumentos-caminho tem de estar em qa/
  // (so em posicao de comando: inicio, ou depois de ; & | ( — assim palavras dentro de strings SQL nao disparam)
  const fileCmds = /(?:^|[;&|(])\s*(?:sudo\s+)?(rm|rmdir|mv|cp|del|erase|ren|rename|move|copy|xcopy|robocopy|touch|mkdir|ln|chmod|chown|truncate|dd|install|tee)\s+([^;&|]*)/g
  for (const m of cmd.matchAll(fileCmds)) {
    const args = (m[2].match(/"[^"]*"|'[^']*'|\S+/g) ?? []).filter((a) => !a.startsWith('-') && a !== '/dev/null')
    if (args.length === 0 || args.some((a) => !inQa(a))) deny(`"${m[1]}" com caminho fora de qa/`, cmd)
  }

  // 3) edicao in-place e escritas inline em linguagens
  if (/\bsed\b[^;&|]*\s-[a-zA-Z]*i|\bperl\b[^;&|]*\s-[a-zA-Z]*i|awk\b[^;&|]*-i\s*inplace/.test(cmd)) deny('edicao in-place de ficheiros (sed/perl/awk -i)', cmd)
  if (/writeFile|appendFile|createWriteStream|writeFileSync|fs\.(rm|rmdir|unlink|rename|copyFile|mkdir|truncate)|Set-Content|Add-Content|Out-File|Remove-Item|New-Item|Move-Item|Copy-Item|Rename-Item|open\([^)]*['"][wax]\+?b?['"]|shutil\.|os\.(remove|rename|unlink)|\.write_text|\.write_bytes/i.test(cmd) && !/^\s*node\s+qa\/|^\s*npx\s+supabase\s+db\s+query/.test(cmd))
    deny('escrita inline de ficheiros (node -e / python -c / powershell). Cria um script em qa/ com a ferramenta Write e corre-o', cmd)

  // 4) git: so leitura
  for (const m of cmd.matchAll(/(?:^|[;&|(])\s*git\s+(?:-C\s+\S+\s+)?([a-z-]+)/g)) {
    if (!['status', 'diff', 'log', 'show', 'ls-files', 'blame', 'rev-parse', 'grep', 'shortlog', 'describe', 'cat-file'].includes(m[1])) deny(`git ${m[1]} altera o repositorio (so leitura: status/diff/log/show/ls-files)`, cmd)
  }

  // 5) instalacao de dependencias / alteracoes ao projeto Supabase (codigo, schema, funcoes, segredos)
  if (/\b(npm|pnpm|yarn)\s+(i|install|add|remove|rm|uninstall|update|upgrade|ci|link|publish|version|pkg)\b/.test(cmd)) deny('instalar/alterar dependencias altera package.json', cmd)
  if (/\bsupabase\s+(db\s+(push|reset|pull|dump|diff|lint)|migration|functions\s+(deploy|delete|new)|secrets|link|unlink|config|branches|projects\s+(create|delete)|orgs|init|start|stop|gen|storage|sso|domains|vanity)\b/.test(cmd)) deny('comando supabase que altera schema/funcoes/segredos/projeto (so `supabase db query` para dados)', cmd)

  // 6) SQL: dados sim, schema/seguranca nao (migrations sao codigo). Inclui o conteudo de `-f ficheiro`
  if (/\bsupabase\s+db\s+query\b/.test(cmd)) {
    let sql = cmd
    const f = cmd.match(/(?:-f|--file)\s+("[^"]+"|'[^']+'|\S+)/)
    if (f) {
      const fp = resolveFrom(f[1].replace(/^["']|["']$/g, ''))
      if (existsSync(fp)) sql += '\n' + readFileSync(fp, 'utf8')
    }
    const ddl = sql.match(/\b(create|alter|drop)\s+(or\s+replace\s+)?(unique\s+)?(table|function|trigger|policy|index|type|view|schema|extension|role|publication|sequence|domain|materialized)\b|\btruncate\b|\b(grant|revoke)\b|\bdisable\s+trigger\b|\benable\s+(row|always)\b|session_replication_role|\bcron\.(schedule|unschedule|alter_job)|\bsecurity\s+definer\b/i)
    if (ddl) deny(`SQL que altera schema/seguranca ("${ddl[0]}") — isso e codigo (migrations). Para dados usa insert/update/select`, cmd)
  }

  allow(cmd)
}
