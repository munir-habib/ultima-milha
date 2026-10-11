// Executa qa/cleanup.sql statement a statement (o CLI so devolve o ultimo resultado) e verifica.
import { readFileSync } from 'node:fs'
import { sql } from '../lib.mjs'
const stmts = readFileSync(new URL('../cleanup.sql', import.meta.url), 'utf8').split(/;\s*\n/).map((s) => s.replace(/^--.*$/gm, '').trim()).filter(Boolean)
for (const s of stmts.slice(0, -1)) await sql(s)
console.log(JSON.stringify((await sql(stmts.at(-1)))[0]))
