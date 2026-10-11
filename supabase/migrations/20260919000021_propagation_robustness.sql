-- =====================================================================
-- Contabilidade: pacote B da 4.a ronda (analista) — propagacao mais robusta
--  P3   mudar o TIPO de uma alocacao ja propagada (Debito -> Credito) apaga a linha de custo (deixa de ser um custo);
--       Credito -> Debito liga-a (se ha registo). So rota, data e tipo decidem a que registo pertence.
--  P8   "Sem registo previsto" e "nao me avises": quando o registo aparece e a alocacao se liga, a marca e limpa
--       (estado coerente: registo_id preenchido e marca ativa nao coexistem).
--  P9   app.system_write repoe o valor ANTERIOR (attach_allocations, sync_auto_movements, drop_allocation_line, relink);
--       antes repunham '0' e "desligavam" um contexto de sistema que os chamasse.
--  P12  uma alocacao = uma linha de custo ativa (indice unico parcial + on conflict) e indice por movimento_id
--       (o drop/relink fazia varredura completa). Linhas ativas duplicadas antigas: fica a mais antiga.
-- =====================================================================

-- P12: duplicados historicos (se existirem) -> fica a linha ativa mais antiga; as outras em soft delete (audit)
update daily_record_costs c set deleted_at = now()
 where c.deleted_at is null and c.movimento_id is not null
   and exists (select 1 from daily_record_costs o where o.movimento_id = c.movimento_id and o.deleted_at is null and (o.created_at, o.id) < (c.created_at, c.id));
create index daily_record_costs_movimento_idx on daily_record_costs (movimento_id) where movimento_id is not null;
create unique index daily_record_costs_um_ativo_por_movimento on daily_record_costs (movimento_id) where deleted_at is null and movimento_id is not null;

create or replace function app.attach_allocations(p_record uuid) returns integer language plpgsql security definer set search_path = public as $$
declare rec daily_records; m movements; n integer := 0; v_tenant uuid; v_prev text := coalesce(current_setting('app.system_write', true), '0');
begin
  select * into rec from daily_records where id = p_record and deleted_at is null;
  if not found then return 0; end if;
  perform set_config('app.system_write', '1', true);
  for m in
    select * from movements
    where lancamento_referencia_id is not null and operation_id is not null and rota_id = rec.route_id
      and data = rec.data and tipo = 'debito' and deleted_at is null and registo_id is null
  loop
    insert into daily_record_costs (record_id, categoria, valor, descricao, movimento_id, created_by)
    values (rec.id, 'Pagamento distribuído — ' || coalesce(m.pessoa_responsavel, ''), m.valor, m.descricao, m.id, m.created_by)
    on conflict (movimento_id) where deleted_at is null and movimento_id is not null do nothing;   -- uma alocacao = uma linha de custo ativa (duas ligacoes concorrentes nao duplicam)
    -- ligada ao registo: a marca "sem registo previsto" deixa de fazer sentido (o registo existe)
    update movements set registo_id = rec.id, sem_registo_previsto = false where id = m.id;
    n := n + 1;
  end loop;
  perform set_config('app.system_write', v_prev, true);
  -- uma alocacao anexada a um registo VALIDADO altera-lhe os custos: reverte-o para Submetido e avisa quem validou
  -- (mesma regra das edicoes diretas)
  if n > 0 and rec.status = 'validado' then
    update daily_records set status = 'submetido', validado_por = null, validado_em = null where id = rec.id;
    if rec.validado_por is not null and rec.validado_por is distinct from auth.uid() then
      select o.tenant_id into v_tenant from routes r join operations o on o.id = r.operation_id where r.id = rec.route_id;
      perform app.notify(v_tenant, rec.validado_por, 'record_reopened',
        jsonb_build_object('record_id', rec.id, 'route_id', rec.route_id, 'data', rec.data, 'by', auth.uid()));
    end if;
  end if;
  return n;
end $$;

create or replace function app.sync_auto_movements(p_record uuid) returns void language plpgsql security definer set search_path = public as $$
declare
  rec daily_records; v_prev text := coalesce(current_setting('app.system_write', true), '0'); v_op uuid; v_tenant uuid; v_conta uuid; k record; cur movements; v_val numeric; v_had boolean;
begin
  select * into rec from daily_records where id = p_record;
  if not found then return; end if;
  select r.operation_id, o.tenant_id into v_op, v_tenant from routes r join operations o on o.id = r.operation_id where r.id = rec.route_id;
  select default_account_id into v_conta from accounting_settings where tenant_id = v_tenant;

  perform set_config('app.system_write', '1', true);
  for k in select * from (values ('combustivel', rec.comb_valor), ('portagens', rec.portagens_valor)) as t(tipo, val) loop
    v_val := coalesce(k.val, 0);
    select * into cur from movements
      where registo_id = rec.id and custo_tipo = k.tipo and origem = 'automatico' and deleted_at is null
      order by created_at desc limit 1;
    v_had := found;  -- FOUND e reescrito por cada UPDATE/INSERT abaixo

    if rec.deleted_at is not null or v_val <= 0 then
      if v_had then
        update movements set deleted_at = now(),
               motivo_apagado = case when rec.deleted_at is not null then 'registo diário apagado' else 'custo removido no registo diário' end
         where id = cur.id;
      end if;
      continue;
    end if;
    -- rascunhos ainda sao trabalho em curso: nao geram lancamentos (evita uma versao por cada gravacao automatica)
    continue when rec.status = 'rascunho' and not v_had;

    if v_had and cur.valor = v_val then continue; end if;

    if v_had then  -- nova versao: o lancamento antigo fica no historico
      update movements set deleted_at = now(), motivo_apagado = 'substituído por edição' where id = cur.id;
    end if;
    insert into movements (tenant_id, data, conta_id, tipo, valor, operation_id, subcategoria, rota_id, motorista_id,
                           estado, origem, registo_id, custo_tipo, versao_anterior_id, created_by)
    values (v_tenant, rec.data, v_conta, 'debito', v_val, v_op, 'custo_automatico', rec.route_id, rec.motorista_ids[1],
            'confirmado', 'automatico', rec.id, k.tipo, case when v_had then cur.id end, rec.created_by);
  end loop;
  perform set_config('app.system_write', v_prev, true);
end $$;

-- linha de custo de uma alocacao deixa de fazer sentido: soft delete (fica no audit); registo Validado volta a Submetido
create or replace function app.drop_allocation_line(p_mov uuid, p_rec uuid) returns void language plpgsql security definer set search_path = public as $$
declare v_old daily_records; v_tenant uuid; v_prev text := coalesce(current_setting('app.system_write', true), '0');
begin
  perform set_config('app.system_write', '1', true);
  update daily_record_costs set deleted_at = now() where movimento_id = p_mov and deleted_at is null;
  select * into v_old from daily_records where id = p_rec;
  if found and v_old.status = 'validado' then
    update daily_records set status = 'submetido', validado_por = null, validado_em = null where id = v_old.id;
    if v_old.validado_por is not null and v_old.validado_por is distinct from auth.uid() then
      select o.tenant_id into v_tenant from routes r join operations o on o.id = r.operation_id where r.id = v_old.route_id;
      perform app.notify(v_tenant, v_old.validado_por, 'record_reopened',
        jsonb_build_object('record_id', v_old.id, 'route_id', v_old.route_id, 'data', v_old.data, 'by', auth.uid()));
    end if;
  end if;
  perform set_config('app.system_write', v_prev, true);
end $$;

create or replace function app.movements_relink() returns trigger language plpgsql security definer set search_path = public as $$
declare v_rec uuid; v_prev text := coalesce(current_setting('app.system_write', true), '0');
begin
  if new.lancamento_referencia_id is null then return new; end if;
  -- apagar a alocacao apaga tambem a linha de custo que gerou
  if old.deleted_at is null and new.deleted_at is not null then
    if old.tipo = 'debito' and new.registo_id is not null then perform app.drop_allocation_line(new.id, new.registo_id); end if;
    return new;
  end if;
  if new.deleted_at is not null then return new; end if;
  -- so a rota, a data e o TIPO decidem a que registo diario a alocacao pertence (e se gera custo)
  if (new.rota_id, new.data, new.tipo) is not distinct from (old.rota_id, old.data, old.tipo) then return new; end if;

  if new.registo_id is not null or new.sem_registo_previsto then
    if new.registo_id is not null then perform app.drop_allocation_line(new.id, new.registo_id); end if;
    perform set_config('app.system_write', '1', true);
    update movements set registo_id = null, sem_registo_previsto = false where id = new.id;   -- volta a "por ligar" (ou deixa de ser custo)
    perform set_config('app.system_write', v_prev, true);
  end if;

  -- deixou de ser debito (ex.: corrigiu-se o tipo): nao gera custo, nao liga
  if new.tipo <> 'debito' then return new; end if;
  -- liga ao registo da nova rota+data, se ja existir (nunca o cria)
  if new.operation_id is not null and new.rota_id is not null then
    select id into v_rec from daily_records where route_id = new.rota_id and data = new.data and deleted_at is null;
    if v_rec is not null then perform app.attach_allocations(v_rec); end if;
  end if;
  return new;
end $$;
