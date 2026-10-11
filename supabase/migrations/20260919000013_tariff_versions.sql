-- =====================================================================
-- Tarifario: varias mudancas no mesmo dia (relatorio QA F5)
-- Antes: unique (route_id, valid_from) + 'on conflict do update' => a 2.a mudanca do dia
-- SOBRESCREVIA a 1.a e o registo gravado com a 1.a deixava de ser reproduzivel.
-- Agora cada mudanca e o seu proprio snapshot, ordenado por (valid_from, versao), e os
-- snapshots sao imutaveis (so se acrescentam). Um registo usa o ultimo snapshot em vigor
-- na data do registo.
-- =====================================================================

alter table tariff_snapshots add column versao integer not null default 1;
alter table tariff_snapshots drop constraint tariff_snapshots_route_id_valid_from_key;
alter table tariff_snapshots add constraint tariff_snapshots_route_dia_versao_key unique (route_id, valid_from, versao);

create or replace function app.snapshot_route(p_route uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_cfg jsonb; v_last jsonb; v_from date; v_versao integer;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_route::text, 0));   -- mudancas da mesma rota em serie
  v_cfg := app.build_route_config(p_route);
  select config into v_last from tariff_snapshots where route_id = p_route order by valid_from desc, versao desc limit 1;
  if v_last is not null and v_last = v_cfg then return; end if;
  v_from := case when v_last is null then date '1900-01-01' else app.today() end;
  select coalesce(max(versao), 0) + 1 into v_versao from tariff_snapshots where route_id = p_route and valid_from = v_from;
  insert into tariff_snapshots (route_id, valid_from, versao, config) values (p_route, v_from, v_versao, v_cfg);
end $$;

-- historico so se acrescenta: um snapshot nunca e alterado
create function app.tariff_snapshots_immutable() returns trigger language plpgsql as $$
begin raise exception 'tariff_snapshots e imutavel (cada mudanca cria uma nova versao)' using errcode = '42501'; end $$;
create trigger tariff_snapshots_immutable before update on tariff_snapshots
  for each row execute function app.tariff_snapshots_immutable();

-- o registo diario usa o ultimo snapshot em vigor na data (desempate por versao)
create or replace function app.records_before() returns trigger language plpgsql security definer set search_path = public as $$
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
      where route_id = new.route_id and valid_from <= new.data order by valid_from desc, versao desc limit 1;
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
