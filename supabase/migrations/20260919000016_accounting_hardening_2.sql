-- =====================================================================
-- Contabilidade: correcoes do 2.o relatorio do tester (F3-F6) e regras novas
--  F5  um lancamento automatico so muda no registo diario: na Contabilidade so se validam/revertem,
--      reclassificam (rota/operacao), atribuem conta e descricao; todos os outros campos imutaveis.
--  F4  created_by / created_at sao imutaveis para o cliente (e o created_at do INSERT e sempre now()).
--  F6  so alocacoes a DEBITO contam para alocado/sobre-alocacao (vista + trigger).
--  F3  um registo Submetido/Validado nao volta a Rascunho (transicao invalida): o Rascunho deixa de
--      poder gerar versoes por gravacao.
--  Nova: uma alocacao anexada a um registo Validado reverte-o para Submetido e notifica quem validou.
--  Etiqueta da linha de custo: "Pagamento distribuido — X" (travessao); linhas antigas atualizadas.
-- =====================================================================

create or replace function app.movements_guard() returns trigger language plpgsql security definer set search_path = public as $$
declare v_sys boolean := app.in_system_write();
begin
  if new.tenant_id <> old.tenant_id then raise exception 'tenant_id imutavel' using errcode = '42501'; end if;

  if not v_sys and auth.uid() is not null and new.origem is distinct from old.origem then
    raise exception 'a origem do lancamento e definida pelo sistema (nao pode ser alterada)' using errcode = '42501';
  end if;
  if not v_sys and auth.uid() is not null and (new.created_by, new.created_at) is distinct from (old.created_by, old.created_at) then
    raise exception 'created_by e created_at sao imutaveis (definidos pelo sistema)' using errcode = '42501';
  end if;
  if not v_sys and auth.uid() is not null
     and (new.registo_id, new.custo_tipo, new.versao_anterior_id, new.validado_por, new.validado_em)
         is distinct from (old.registo_id, old.custo_tipo, old.versao_anterior_id, old.validado_por, old.validado_em) then
    raise exception 'registo_id, custo_tipo, versao_anterior_id, validado_por e validado_em sao geridos pelo sistema (nao podem ser alterados)' using errcode = '42501';
  end if;

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

  -- um lancamento automatico so muda no registo diario: aqui so se pode validar/reverter (estado), reclassificar
  -- (rota/operacao), atribuir conta e editar a descricao. TODOS os outros campos (valor, data, tipo, origem, subcategoria,
  -- pessoa, lancamento_referencia_id, motorista, registo, custo, versao...) ficam imutaveis.
  if old.origem = 'automatico' and not v_sys
     and (to_jsonb(new) - array['updated_at','estado','validado_por','validado_em','rota_id','operation_id','conta_id','descricao','deleted_at','motivo_apagado']) is distinct from (to_jsonb(old) - array['updated_at','estado','validado_por','validado_em','rota_id','operation_id','conta_id','descricao','deleted_at','motivo_apagado']) then
    raise exception 'lancamento automatico so pode ser alterado no registo diario (aqui: validar, reclassificar rota/operacao, conta e descricao)' using errcode = '42501';
  end if;

  -- reclassificar: a origem manual acompanha a operacao (Manual-Rota com operacao, Manual-Geral sem)
  if old.origem <> 'automatico' and not v_sys and auth.uid() is not null then
    new.origem := case when new.operation_id is null then 'manual_geral' else 'manual_rota' end;
  end if;

  -- validacao: quem validou / quando
  if new.estado is distinct from old.estado then
    if new.estado = 'confirmado' then
      new.validado_por := auth.uid(); new.validado_em := now();
    else
      new.validado_por := null; new.validado_em := null;
    end if;
  elsif not v_sys and new.lancamento_referencia_id is not null and old.estado = 'confirmado'
        and (new.valor, new.pessoa_responsavel, new.data, new.tipo)
            is distinct from (old.valor, old.pessoa_responsavel, old.data, old.tipo) then
    -- o que foi validado mudou: precisa de nova validacao
    new.estado := 'pendente'; new.validado_por := null; new.validado_em := null;
  end if;
  return new;
end $$;

-- created_at do INSERT e sempre do servidor (o cliente nao o escolhe)
create function app.movements_stamp() returns trigger language plpgsql as $$
begin
  if auth.uid() is not null and not app.in_system_write() then
    new.created_at := now(); new.updated_at := now();
  end if;
  return new;
end $$;
create trigger movements_stamp before insert on movements for each row execute function app.movements_stamp();

create or replace view fund_transfer_status with (security_invoker = true) as
select t.id, t.tenant_id, t.data, t.pessoa_responsavel, t.valor,
       coalesce(sum(a.valor), 0)::numeric(14,2) as alocado,
       (t.valor - coalesce(sum(a.valor), 0))::numeric(14,2) as diferenca,
       case when t.valor - coalesce(sum(a.valor), 0) > 0 then 'under'
            when t.valor - coalesce(sum(a.valor), 0) < 0 then 'over'
            else 'ok' end as estado
from movements t
left join movements a on a.lancamento_referencia_id = t.id and a.deleted_at is null and a.tipo = 'debito'
where t.subcategoria = 'transferencia_distribuicao' and t.lancamento_referencia_id is null and t.deleted_at is null
group by t.id;;

create or replace function app.movements_overalloc() returns trigger language plpgsql security definer set search_path = public as $$
declare
  ids uuid[] := array[]::uuid[]; t_id uuid; tr movements;
  v_now numeric; v_before numeric; v_tr_before numeric; u uuid;
  n_val numeric := 0; o_val numeric := 0;
begin
  -- transferencias afetadas: aquela a que a linha (nova/antiga) se refere, e a propria linha se for uma transferencia
  if new.lancamento_referencia_id is not null then ids := ids || new.lancamento_referencia_id; end if;
  if TG_OP = 'UPDATE' and old.lancamento_referencia_id is not null and old.lancamento_referencia_id is distinct from new.lancamento_referencia_id then
    ids := ids || old.lancamento_referencia_id;
  end if;
  if new.lancamento_referencia_id is null and new.subcategoria = 'transferencia_distribuicao' then ids := ids || new.id; end if;

  foreach t_id in array ids loop
    select * into tr from movements
     where id = t_id and deleted_at is null and lancamento_referencia_id is null and subcategoria = 'transferencia_distribuicao';
    if not found then continue; end if;   -- transferencia apagada/inexistente: nada a comparar
    select coalesce(sum(valor), 0) into v_now from movements where lancamento_referencia_id = t_id and deleted_at is null and tipo = 'debito';

    -- contribuicao desta linha (nova e antiga) para ESTA transferencia
    n_val := case when new.lancamento_referencia_id = t_id and new.deleted_at is null and new.tipo = 'debito' then new.valor else 0 end;
    o_val := 0; v_tr_before := tr.valor;
    if TG_OP = 'UPDATE' then
      o_val := case when old.lancamento_referencia_id = t_id and old.deleted_at is null and old.tipo = 'debito' then old.valor else 0 end;
      if old.id = t_id then v_tr_before := old.valor; end if;
    end if;
    v_before := v_now - n_val + o_val;

    -- so agrava: o excesso depois > excesso antes (evita ruido ao corrigir/diminuir)
    if greatest(0, v_now - tr.valor) > greatest(0, v_before - v_tr_before) then
      -- <- para BLOQUEAR em vez de sinalizar: raise exception 'sobre-alocacao ...' using errcode = '23514';
      for u in select * from app.tenant_users(tr.tenant_id, array['super_admin','contabilista']::app_role[]) loop
        perform app.notify(tr.tenant_id, u, 'fund_over_allocated',
          jsonb_build_object('movement_id', tr.id, 'pessoa', coalesce(tr.pessoa_responsavel, ''), 'valor', tr.valor,
                             'alocado', v_now, 'excesso', v_now - tr.valor),
          'fund_over:' || tr.id || ':' || v_now);
      end loop;
    end if;
  end loop;
  return new;
end $$;

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
    -- transicao invalida: um registo Submetido/Validado nao volta a Rascunho (o rascunho gera-se sozinho ao escrever)
    if v_uid is not null and old.status <> 'rascunho' and new.status = 'rascunho' then
      raise exception 'um registo submetido ou validado nao pode voltar a rascunho' using errcode = '23514';
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

create or replace function app.attach_allocations(p_record uuid) returns integer language plpgsql security definer set search_path = public as $$
declare rec daily_records; m movements; n integer := 0; v_tenant uuid;
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
    values (rec.id, 'Pagamento distribuído — ' || coalesce(m.pessoa_responsavel, ''), m.valor, m.descricao, m.id, m.created_by);
    update movements set registo_id = rec.id where id = m.id;
    n := n + 1;
  end loop;
  perform set_config('app.system_write', '0', true);
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

-- etiqueta antiga (hifen) -> travessao
update daily_record_costs set categoria = replace(categoria, 'Pagamento distribuído - ', 'Pagamento distribuído — ')
 where categoria like 'Pagamento distribuído - %';
