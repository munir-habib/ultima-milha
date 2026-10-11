-- Limpeza dos dados de teste QA- (soft delete; nada e apagado fisicamente)
update daily_records set deleted_at = now() where deleted_at is null and route_id in (select id from routes where nome like 'QA-%');
update movements set deleted_at = now(), motivo_apagado = 'QA limpeza'
 where deleted_at is null and (descricao like 'QA-%' or pessoa_responsavel like 'QA-%'
   or rota_id in (select id from routes where nome like 'QA-%')
   or operation_id in (select id from operations where nome like 'QA-%')
   or registo_id in (select d.id from daily_records d join routes r on r.id = d.route_id where r.nome like 'QA-%'));
update daily_record_costs set deleted_at = now() where deleted_at is null
 and (categoria like 'QA-%' or descricao like 'QA-%' or record_id in (select d.id from daily_records d join routes r on r.id = d.route_id where r.nome like 'QA-%'));
update routes set deleted_at = now() where deleted_at is null and nome like 'QA-%';
update operations set deleted_at = now() where deleted_at is null and nome like 'QA-%';
update vehicles set deleted_at = now() where deleted_at is null and matricula like 'QA-%';
update fleet_slots set deleted_at = now() where deleted_at is null and nome like 'QA-%';
update bank_accounts set deleted_at = now() where deleted_at is null and nome like 'QA-%';
select
 (select count(*) from daily_records d join routes r on r.id=d.route_id where d.deleted_at is null and r.nome like 'QA-%') qa_records_ativos,
 (select count(*) from movements where deleted_at is null and (descricao like 'QA-%' or pessoa_responsavel like 'QA-%')) qa_mov_ativos,
 (select count(*) from daily_records d join routes r on r.id=d.route_id where d.deleted_at is null and r.nome not like 'QA-%') seed_registos,
 (select count(*) from movements where deleted_at is null) mov_ativos_total,
 (select count(*) from vehicles where deleted_at is null) veic_ativos,
 (select count(*) from routes where deleted_at is null) rotas_ativas;
