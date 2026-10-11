-- =====================================================================
-- Contabilidade: lançamentos automáticos com versionamento, validação
-- seletiva, propagação diferida de alocações, notificações de pendentes.
-- =====================================================================

-- ---------- colunas novas ----------
alter table movements
  alter column conta_id drop not null,                       -- automaticos podem nascer sem conta (ate haver conta por defeito)
  add column versao_anterior_id uuid references movements(id),
  add column registo_id uuid references daily_records(id),   -- automatico: registo de origem | alocacao: registo onde foi propagada (NULL = por ligar)
  add column custo_tipo text check (custo_tipo in ('combustivel','portagens')),
  add column motivo_apagado text,
  add column validado_por uuid references profiles(id),
  add column validado_em timestamptz,
  add constraint movements_conta_check check (conta_id is not null or origem = 'automatico');
create index on movements (registo_id);
create index on movements (versao_anterior_id);

-- ---------- definicoes da Contabilidade (por tenant) ----------
create table accounting_settings (
  tenant_id            uuid primary key references tenants(id),
  validation_threshold numeric(12,2) not null default 100 check (validation_threshold >= 0),
  default_account_id   uuid references bank_accounts(id),   -- conta dos lancamentos automaticos
  updated_at           timestamptz not null default now(),
  updated_by           uuid references profiles(id)
);
alter table accounting_settings enable row level security;
revoke all on accounting_settings from anon;
grant select, insert, update on accounting_settings to authenticated;
revoke delete on accounting_settings from authenticated;
create policy acc_settings_select on accounting_settings for select to authenticated
  using (tenant_id = app.tenant_id() and app.can_read_accounting());
create policy acc_settings_insert on accounting_settings for insert to authenticated
  with check (tenant_id = app.tenant_id() and app.has_role('super_admin'));
create policy acc_settings_update on accounting_settings for update to authenticated
  using (tenant_id = app.tenant_id() and app.has_role('super_admin')) with check (tenant_id = app.tenant_id());
create trigger acc_settings_touch before update on accounting_settings for each row execute function app.touch_updated_at();
create trigger zz_audit after insert or update or delete on accounting_settings for each row execute function app.audit();
create trigger zz_forbid_delete before delete on accounting_settings for each row execute function app.forbid_delete();

create function app.acc_threshold(p_tenant uuid) returns numeric language sql stable security definer set search_path = public as
$$ select coalesce((select validation_threshold from accounting_settings where tenant_id = p_tenant), 100) $$;

create function app.in_system_write() returns boolean language sql stable as
$$ select coalesce(current_setting('app.system_write', true), '0') = '1' $$;

-- ---------- estado inicial (regra de validacao seletiva) ----------
--  * alocacao de fundos: sempre Pendente
--  * automatico acima do limite configuravel: Pendente; abaixo: Confirmado
--  * manual (Contabilista/Super Admin): Confirmado
create function app.movements_state_before() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.origem = 'automatico' then
    new.estado := case when new.valor > app.acc_threshold(new.tenant_id) then 'pendente' else 'confirmado' end;
  elsif new.lancamento_referencia_id is not null then
    new.estado := 'pendente';
  else
    new.estado := 'confirmado';
  end if;
  new.validado_por := null;
  new.validado_em := null;
  return new;
end $$;
create trigger movements_state before insert on movements for each row execute function app.movements_state_before();

-- ---------- guarda de atualizacao ----------
create or replace function app.movements_guard() returns trigger language plpgsql security definer set search_path = public as $$
declare v_sys boolean := app.in_system_write();
begin
  if new.tenant_id <> old.tenant_id then raise exception 'tenant_id imutavel' using errcode = '42501'; end if;

  -- soft delete: motivo obrigatorio; so Super Admin (ou o sistema, no versionamento)
  if new.deleted_at is not null and old.deleted_at is null then
    if coalesce(btrim(new.motivo_apagado), '') = '' then
      raise exception 'motivo obrigatorio para apagar um lancamento' using errcode = '23514';
    end if;
    if auth.uid() is not null and not v_sys and not app.has_role('super_admin') then
      raise exception 'apenas Super Admin pode apagar (soft delete) movimentos' using errcode = '42501';
    end if;
  elsif old.deleted_at is not null and not v_sys
        and (to_jsonb(new) - 'updated_at') is distinct from (to_jsonb(old) - 'updated_at') then
    raise exception 'lancamento apagado e imutavel (historico)' using errcode = '42501';
  end if;

  -- um lancamento automatico so muda no registo diario (o que pode mudar aqui: estado, rota/operacao, descricao)
  if old.origem = 'automatico' and not v_sys
     and (new.valor, new.data, new.tipo, new.origem, new.registo_id, new.custo_tipo, new.versao_anterior_id)
         is distinct from (old.valor, old.data, old.tipo, old.origem, old.registo_id, old.custo_tipo, old.versao_anterior_id) then
    raise exception 'lancamento automatico so pode ser alterado no registo diario' using errcode = '42501';
  end if;

  -- validacao: quem validou / quando; uma alocacao alterada perde a validacao
  if new.estado is distinct from old.estado then
    if new.estado = 'confirmado' then
      new.validado_por := auth.uid(); new.validado_em := now();
    else
      new.validado_por := null; new.validado_em := null;
    end if;
  elsif not v_sys and new.lancamento_referencia_id is not null and old.estado = 'confirmado'
        and (new.valor, new.operation_id, new.rota_id, new.motorista_id, new.pessoa_responsavel, new.data, new.tipo)
            is distinct from (old.valor, old.operation_id, old.rota_id, old.motorista_id, old.pessoa_responsavel, old.data, old.tipo) then
    new.estado := 'pendente'; new.validado_por := null; new.validado_em := null;
  end if;
  return new;
end $$;

-- ---------- notificacao: sempre que um lancamento entra em Pendente ----------
create function app.movements_notify() returns trigger language plpgsql security definer set search_path = public as $$
declare u uuid; v_dest text;
begin
  if new.deleted_at is null and new.estado = 'pendente' and (TG_OP = 'INSERT' or old.estado is distinct from 'pendente') then
    select coalesce((select nome from operations where id = new.operation_id), (select nome from bank_accounts where id = new.conta_id), '—') into v_dest;
    -- todas as contas Super Admin E todas as contas Contabilista (nunca so uma das duas)
    for u in select * from app.tenant_users(new.tenant_id, array['super_admin','contabilista']::app_role[]) loop
      perform app.notify(new.tenant_id, u, 'movement_pending',
        jsonb_build_object('movement_id', new.id, 'valor', new.valor, 'destino', v_dest,
                           'kind', case when new.origem = 'automatico' then 'auto' else 'alloc' end));
    end loop;
  end if;
  return new;
end $$;
create trigger movements_notify after insert or update on movements for each row execute function app.movements_notify();

-- ---------- alocacoes: propagacao diferida ----------
-- Liga as alocacoes pendentes de (rota, data) ao registo diario: cria a linha de custo (copia inicial).
create function app.attach_allocations(p_record uuid) returns integer language plpgsql security definer set search_path = public as $$
declare rec daily_records; m movements; n integer := 0;
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
    values (rec.id, 'Pagamento distribuído - ' || coalesce(m.pessoa_responsavel, ''), m.valor, m.descricao, m.id, m.created_by);
    update movements set registo_id = rec.id where id = m.id;
    n := n + 1;
  end loop;
  perform set_config('app.system_write', '0', true);
  return n;
end $$;

-- substitui a versao anterior (que criava o registo diario): agora so liga se o registo JA existir
create or replace function app.movement_propagate() returns trigger language plpgsql security definer set search_path = public as $$
declare v_rec uuid;
begin
  if new.lancamento_referencia_id is not null and new.operation_id is not null and new.rota_id is not null
     and new.tipo = 'debito' and new.deleted_at is null then
    select id into v_rec from daily_records where route_id = new.rota_id and data = new.data and deleted_at is null;
    if v_rec is not null then perform app.attach_allocations(v_rec); end if;
  end if;
  return new;
end $$;

-- quando o registo diario e criado mais tarde, anexa as alocacoes pendentes dessa rota+data
create function app.records_attach() returns trigger language plpgsql security definer set search_path = public as $$
begin perform app.attach_allocations(new.id); return new; end $$;
create trigger records_attach after insert on daily_records for each row execute function app.records_attach();

-- ---------- lancamentos automaticos (combustivel, portagens) com versionamento ----------
create function app.sync_auto_movements(p_record uuid) returns void language plpgsql security definer set search_path = public as $$
declare
  rec daily_records; v_op uuid; v_tenant uuid; v_conta uuid; k record; cur movements; v_val numeric; v_had boolean;
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
  perform set_config('app.system_write', '0', true);
end $$;

create function app.records_sync_auto() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if TG_OP = 'INSERT' or (new.comb_valor, new.portagens_valor, new.status, new.deleted_at)
                         is distinct from (old.comb_valor, old.portagens_valor, old.status, old.deleted_at) then
    perform app.sync_auto_movements(new.id);
  end if;
  return new;
end $$;
create trigger records_sync_auto after insert or update on daily_records for each row execute function app.records_sync_auto();

-- lancamentos automaticos dos registos ja existentes
select app.sync_auto_movements(id) from daily_records where deleted_at is null and status <> 'rascunho';
