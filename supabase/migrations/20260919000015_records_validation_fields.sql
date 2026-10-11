-- =====================================================================
-- Registo diario: validado_por / validado_em so o servidor escreve (relatorio QA N1)
-- Antes: num registo Validado, um Gestor enviando status='validado' sem outras alteracoes
-- conseguia reescrever validado_por/validado_em (o ramo "validado -> validado" so os repunha
-- quando os inputs mudavam). Agora, sem reabertura, mantem-se sempre o valor anterior.
-- (Restantes caminhos ja eram do servidor: validar define-os, sair de Validado limpa-os.)
-- =====================================================================
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
      else
        -- validado -> validado sem reabrir: quem/quando validou nao muda (so o servidor escreve estes campos)
        new.validado_por := old.validado_por; new.validado_em := old.validado_em;
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
