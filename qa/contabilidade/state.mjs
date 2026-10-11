// Estado base / verificacao final (leitura). Uso: node qa/contabilidade/state.mjs
import { sql } from '../lib.mjs'
console.log(JSON.stringify((await sql(`select (select validation_threshold::float from accounting_settings limit 1) thr, (select default_account_id from accounting_settings limit 1) dacc,
(select count(*) from daily_records d join routes r on r.id=d.route_id where d.deleted_at is null and r.nome not like 'QA-%')::int seed_regs,
(select count(*) from daily_records d join routes r on r.id=d.route_id where d.deleted_at is null and r.nome like 'QA-%')::int qa_regs,
(select count(*) from movements where deleted_at is null and (descricao like 'QA-%' or pessoa_responsavel like 'QA-%'))::int qa_mov,
(select count(*) from movements where deleted_at is null)::int mov_total,
(select count(*) from routes where deleted_at is null and nome like 'QA-%')::int qa_routes,
(select count(*) from bank_accounts where deleted_at is null and nome like 'QA-%')::int qa_acc,
(select count(*) from bank_accounts where deleted_at is null)::int accs`))[0]))
console.log(JSON.stringify(await sql(`select p.email, (select array_agg(role) from user_roles r where r.user_id=p.id) roles, p.accounting_read from profiles p where p.email like 'qa.%' or p.email like 'demo.%' order by 1`)))
