-- =====================================================================
-- Registo diario: workflow Rascunho -> Submetido -> Validado, receita
-- gravada no servidor, notificacoes, propagacao de alocacoes.
-- =====================================================================

create function app.records_before() returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_op uuid := app.route_op(new.route_id);
  v_uid uuid := auth.uid();
  v_manage boolean := app.can_manage_op(app.route_op(new.route_id));
  v_cfg jsonb; v_from date; v_bd jsonb;
  v_inputs_changed boolean;
begin
  if TG_OP = 'INSERT' then
    if v_uid is not null then new.created_by := v_uid; end if;
    v_inputs_changed := true;
  else
    -- identidade do registo e imutavel
    if new.route_id <> old.route_id or new.data <> old.data then
      raise exception 'route_id/data nao podem ser alterados' using errcode = '23514';
    end if;
    new.created_by := old.created_by;
    new.created_at := old.created_at;
    new.updated_at := now();
    v_inputs_changed :=
      (new.enc_entregues, new.enc_devolucoes, new.enc_recolhas, new.enc_canceladas, new.enc_transitadas,
       new.enc_pendentes_entrega, new.enc_pendentes_recolha, new.km, new.valor_fixo_do_dia,
       new.incluir_entregas, new.entregas_por_zona)
      is distinct from
      (old.enc_entregues, old.enc_devolucoes, old.enc_recolhas, old.enc_canceladas, old.enc_transitadas,
       old.enc_pendentes_entrega, old.enc_pendentes_recolha, old.km, old.valor_fixo_do_dia,
       old.incluir_entregas, old.entregas_por_zona);
  end if;

  -- workflow de estado (so quando ha utilizador autenticado)
  if v_uid is not null then
    if new.status = 'validado' and (TG_OP = 'INSERT' or old.status <> 'validado') then
      if not v_manage then
        raise exception 'apenas Gestor/Super Admin podem validar registos' using errcode = '42501';
      end if;
      new.validado_por := v_uid; new.validado_em := now();
    elsif TG_OP = 'UPDATE' and old.status = 'validado' and new.status = 'validado' then
      -- editar um registo validado devolve-o a Submetido e avisa quem validou
      if v_inputs_changed or (new.viatura_id, new.motorista_ids, new.comb_litros, new.comb_valor, new.comb_tipo, new.portagens_valor)
                            is distinct from (old.viatura_id, old.motorista_ids, old.comb_litros, old.comb_valor, old.comb_tipo, old.portagens_valor) then
        new.status := 'submetido'; new.validado_por := null; new.validado_em := null;
        if old.validado_por is not null and old.validado_por <> v_uid then
          perform app.notify((select tenant_id from operations where id = v_op), old.validado_por,
                             'record_reopened', jsonb_build_object('record_id', new.id, 'route_id', new.route_id, 'data', new.data, 'by', v_uid));
        end if;
      end if;
    elsif new.status <> 'validado' then
      new.validado_por := null; new.validado_em := null;
    end if;
  end if;

  -- receita: recalcula apenas se os inputs mudaram, sempre com o tarifario da data do registo
  if v_inputs_changed then
    select config, valid_from into v_cfg, v_from from tariff_snapshots
      where route_id = new.route_id and valid_from <= new.data order by valid_from desc limit 1;
    if v_cfg is null then
      v_bd := jsonb_build_object('por_estado',0,'valor_fixo',0,'por_zona',0,'por_distancia',0,'total',0);
    else
      v_bd := app.compute_revenue(v_cfg, new);
    end if;
    new.receita_breakdown := v_bd;
    new.receita_total := (v_bd->>'total')::numeric;
    new.tarifa_valid_from := v_from;
  else
    new.receita_breakdown := old.receita_breakdown;
    new.receita_total := old.receita_total;
    new.tarifa_valid_from := old.tarifa_valid_from;
  end if;
  return new;
end $$;
create trigger records_before before insert or update on daily_records
  for each row execute function app.records_before();

-- Notifica Gestores/Super Admins quando outro utilizador submete um registo
create function app.records_after() returns trigger language plpgsql security definer set search_path = public as $$
declare v_op uuid := app.route_op(new.route_id); v_uid uuid := auth.uid(); m uuid; v_tenant uuid;
begin
  if new.status = 'submetido' and (TG_OP = 'INSERT' or old.status <> 'submetido') then
    select tenant_id into v_tenant from operations where id = v_op;
    for m in select * from app.op_managers(v_op) loop
      if m is distinct from v_uid then
        perform app.notify(v_tenant, m, 'record_submitted',
          jsonb_build_object('record_id', new.id, 'route_id', new.route_id, 'data', new.data, 'by', v_uid));
      end if;
    end loop;
  end if;
  return new;
end $$;
create trigger records_after after insert or update on daily_records
  for each row execute function app.records_after();

-- ---------- Posto de frota: mantem o historico de viaturas por posto ----------
create function app.vehicle_slot_history() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if TG_OP = 'INSERT' or new.posto_id is distinct from old.posto_id then
    update slot_assignments set data_fim = app.today() where vehicle_id = new.id and data_fim is null;
    if new.posto_id is not null then
      insert into slot_assignments (tenant_id, posto_id, vehicle_id, data_inicio)
      values (new.tenant_id, new.posto_id, new.id, app.today());
    end if;
  end if;
  return new;
end $$;
create trigger vehicles_slot_history after insert or update on vehicles
  for each row execute function app.vehicle_slot_history();

-- ---------- Contabilidade: distribuicao de fundos -> linha de custo no registo diario ----------
-- Copia inicial: depois de criada, a linha e editavel de forma independente.
create function app.movement_propagate() returns trigger language plpgsql security definer set search_path = public as $$
declare v_rec uuid;
begin
  if new.lancamento_referencia_id is not null and new.operation_id is not null and new.rota_id is not null
     and new.tipo = 'debito' and new.deleted_at is null then
    select id into v_rec from daily_records where route_id = new.rota_id and data = new.data and deleted_at is null;
    if v_rec is null then
      insert into daily_records (route_id, data, status) values (new.rota_id, new.data, 'rascunho') returning id into v_rec;
    end if;
    insert into daily_record_costs (record_id, categoria, valor, descricao, movimento_id, created_by)
    values (v_rec, 'Pagamento distribuído - ' || coalesce(new.pessoa_responsavel, ''), new.valor, new.descricao, new.id, new.created_by);
  end if;
  return new;
end $$;
create trigger movements_propagate after insert on movements
  for each row execute function app.movement_propagate();

create trigger movements_touch before update on movements
  for each row execute function app.touch_updated_at();

-- Contabilista nao pode apagar (soft delete so por Super Admin)
create function app.movements_guard() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null then
    if new.tenant_id <> old.tenant_id then raise exception 'tenant_id imutavel' using errcode = '42501'; end if;
    if old.deleted_at is null and new.deleted_at is not null and not app.has_role('super_admin') then
      raise exception 'apenas Super Admin pode apagar (soft delete) movimentos' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
create trigger movements_guard before update on movements
  for each row execute function app.movements_guard();
