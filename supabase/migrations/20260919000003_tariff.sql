-- =====================================================================
-- Tarifario: versoes (snapshots) + calculo de receita
-- Integridade historica: a receita de um registo usa a versao do tarifario
-- em vigor na DATA do registo e fica gravada; mudar o tarifario nunca
-- recalcula registos existentes.
-- =====================================================================

create function app.build_route_config(p_route uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare r routes; o operations; zones jsonb;
begin
  select * into r from routes where id = p_route;
  select * into o from operations where id = r.operation_id;
  select coalesce(jsonb_object_agg(z.id::text, jsonb_build_object('nome', z.nome, 'valor', z.valor_por_entrega)), '{}'::jsonb)
    into zones from postal_zones z where z.operation_id = r.operation_id and z.deleted_at is null;
  return jsonb_build_object(
    'por_estado',        r.tarifa_por_estado,
    'valor_fixo',        r.tarifa_valor_fixo,
    'por_zona',          r.tarifa_por_zona,
    'por_distancia',     r.tarifa_por_distancia,
    'valores_estado',    o.valores_estado,
    'valor_fixo_default', r.valor_fixo_default,
    'zonas',             zones,
    'taxa_km',           r.taxa_km,
    'escaloes_km',       r.escaloes_km
  );
end $$;

-- Cria uma nova versao se a configuracao mudou. A primeira versao vale desde sempre.
create function app.snapshot_route(p_route uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_cfg jsonb; v_last jsonb; v_from date;
begin
  v_cfg := app.build_route_config(p_route);
  select config into v_last from tariff_snapshots where route_id = p_route order by valid_from desc limit 1;
  if v_last is not null and v_last = v_cfg then return; end if;
  v_from := case when v_last is null then date '1900-01-01' else app.today() end;
  insert into tariff_snapshots (route_id, valid_from, config) values (p_route, v_from, v_cfg)
  on conflict (route_id, valid_from) do update set config = excluded.config;
end $$;

create function app.routes_snapshot_trg() returns trigger language plpgsql security definer set search_path = public as $$
begin perform app.snapshot_route(new.id); return new; end $$;
create trigger routes_snapshot after insert or update on routes
  for each row execute function app.routes_snapshot_trg();

create function app.operations_snapshot_trg() returns trigger language plpgsql security definer set search_path = public as $$
declare rid uuid;
begin
  if new.valores_estado is distinct from old.valores_estado then
    for rid in select id from routes where operation_id = new.id loop perform app.snapshot_route(rid); end loop;
  end if;
  return new;
end $$;
create trigger operations_snapshot after update on operations
  for each row execute function app.operations_snapshot_trg();

create function app.zones_snapshot_trg() returns trigger language plpgsql security definer set search_path = public as $$
declare rid uuid;
begin
  for rid in select id from routes where operation_id = new.operation_id loop perform app.snapshot_route(rid); end loop;
  return new;
end $$;
create trigger zones_snapshot after insert or update on postal_zones
  for each row execute function app.zones_snapshot_trg();

-- Receita do dia = soma dos componentes ativos na rota, calculada com a configuracao (cfg) dada.
create function app.compute_revenue(cfg jsonb, rec daily_records) returns jsonb
language plpgsql immutable as $$
declare
  vals jsonb := coalesce(cfg->'valores_estado', '{}'::jsonb);
  v_estado numeric := 0; v_fixo numeric := 0; v_zona numeric := 0; v_dist numeric := 0;
  v_km numeric := coalesce(rec.km, 0);
  b jsonb;
begin
  if coalesce((cfg->>'por_estado')::boolean, false) and rec.incluir_entregas then
    v_estado := coalesce(rec.enc_entregues, 0)          * coalesce((vals->>'entregues')::numeric, 0)
              + coalesce(rec.enc_devolucoes, 0)         * coalesce((vals->>'devolucoes')::numeric, 0)
              + coalesce(rec.enc_recolhas, 0)           * coalesce((vals->>'recolhas')::numeric, 0)
              + coalesce(rec.enc_canceladas, 0)         * coalesce((vals->>'canceladas')::numeric, 0)
              + coalesce(rec.enc_transitadas, 0)        * coalesce((vals->>'transitadas')::numeric, 0)
              + coalesce(rec.enc_pendentes_entrega, 0)  * coalesce((vals->>'pendentes_entrega')::numeric, 0)
              + coalesce(rec.enc_pendentes_recolha, 0)  * coalesce((vals->>'pendentes_recolha')::numeric, 0);
  end if;

  if coalesce((cfg->>'valor_fixo')::boolean, false) then
    v_fixo := coalesce(rec.valor_fixo_do_dia, 0);   -- a UI pre-preenche com o default da rota
  end if;

  if coalesce((cfg->>'por_zona')::boolean, false) then
    select coalesce(sum(e.value::numeric * coalesce((cfg->'zonas'->e.key->>'valor')::numeric, 0)), 0)
      into v_zona from jsonb_each_text(rec.entregas_por_zona) e;
  end if;

  if coalesce((cfg->>'por_distancia')::boolean, false) and v_km > 0 then
    if jsonb_typeof(cfg->'escaloes_km') = 'array' and jsonb_array_length(cfg->'escaloes_km') > 0 then
      -- escaloes progressivos: cada escalao cobra o seu valor por km na fatia de km que lhe corresponde
      select coalesce(sum(greatest(0, least(v_km, coalesce((b2->>'ate')::numeric, v_km)) - coalesce((b2->>'de')::numeric, 0))
                          * coalesce((b2->>'valor')::numeric, 0)), 0)
        into v_dist from jsonb_array_elements(cfg->'escaloes_km') b2;
    else
      v_dist := v_km * coalesce((cfg->>'taxa_km')::numeric, 0);
    end if;
  end if;

  b := jsonb_build_object(
    'por_estado',    round(v_estado, 2),
    'valor_fixo',    round(v_fixo, 2),
    'por_zona',      round(v_zona, 2),
    'por_distancia', round(v_dist, 2));
  return b || jsonb_build_object('total', round(v_estado, 2) + round(v_fixo, 2) + round(v_zona, 2) + round(v_dist, 2));
end $$;
