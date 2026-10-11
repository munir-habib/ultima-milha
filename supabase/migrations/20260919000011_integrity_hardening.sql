-- =====================================================================
-- Endurecimento de integridade (relatorio QA F1-F4, F9, F10)
--  F1-F4  referencias coerentes: nenhuma linha aponta para dados de outro Tenant,
--         e a rota de uma alocacao tem de pertencer a operacao da alocacao.
--  F9     so Gestor/Super Admin apagam (soft delete) registos diarios.
--  F10    a ORIGEM de um lancamento e decidida pelo sistema; nenhum utilizador a escolhe.
--  F10b   o mesmo para os outros campos geridos pelo sistema: registo_id, custo_tipo,
--         versao_anterior_id, validado_por, validado_em (o cliente nunca os escreve).
-- Nota: as verificacoes vivem em triggers (nao so em policies) para valerem tanto no
-- INSERT como no UPDATE e para qualquer caminho de escrita.
-- =====================================================================

-- ---------- F1-F3: referencias dos lancamentos ----------
create function app.movements_refs() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.operation_id is not null and (TG_OP = 'INSERT' or new.operation_id is distinct from old.operation_id)
     and not exists (select 1 from operations where id = new.operation_id and tenant_id = new.tenant_id) then
    raise exception 'operation_id nao pertence ao tenant do lancamento' using errcode = '42501';
  end if;
  if new.conta_id is not null and (TG_OP = 'INSERT' or new.conta_id is distinct from old.conta_id)
     and not exists (select 1 from bank_accounts where id = new.conta_id and tenant_id = new.tenant_id) then
    raise exception 'conta_id nao pertence ao tenant do lancamento' using errcode = '42501';
  end if;
  if new.motorista_id is not null and (TG_OP = 'INSERT' or new.motorista_id is distinct from old.motorista_id)
     and not exists (select 1 from drivers where id = new.motorista_id and tenant_id = new.tenant_id) then
    raise exception 'motorista_id nao pertence ao tenant do lancamento' using errcode = '42501';
  end if;
  if new.lancamento_referencia_id is not null and (TG_OP = 'INSERT' or new.lancamento_referencia_id is distinct from old.lancamento_referencia_id)
     and not exists (select 1 from movements where id = new.lancamento_referencia_id and tenant_id = new.tenant_id) then
    raise exception 'lancamento_referencia_id nao pertence ao tenant do lancamento' using errcode = '42501';
  end if;
  if new.versao_anterior_id is not null and (TG_OP = 'INSERT' or new.versao_anterior_id is distinct from old.versao_anterior_id)
     and not exists (select 1 from movements where id = new.versao_anterior_id and tenant_id = new.tenant_id) then
    raise exception 'versao_anterior_id nao pertence ao tenant do lancamento' using errcode = '42501';
  end if;
  if new.registo_id is not null and (TG_OP = 'INSERT' or new.registo_id is distinct from old.registo_id)
     and not exists (select 1 from daily_records d join routes r on r.id = d.route_id join operations o on o.id = r.operation_id
                     where d.id = new.registo_id and o.tenant_id = new.tenant_id) then
    raise exception 'registo_id nao pertence ao tenant do lancamento' using errcode = '42501';
  end if;
  -- a rota tem de pertencer a operacao do lancamento (uma alocacao nunca propaga para a rota de outra operacao)
  if new.rota_id is not null and (TG_OP = 'INSERT' or new.rota_id is distinct from old.rota_id or new.operation_id is distinct from old.operation_id)
     and not exists (select 1 from routes where id = new.rota_id and operation_id = new.operation_id) then
    raise exception 'a rota nao pertence a operacao do lancamento' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger movements_refs before insert or update on movements
  for each row execute function app.movements_refs();

-- ---------- F4: referencias dos registos diarios ----------
create function app.records_refs() returns trigger language plpgsql security definer set search_path = public as $$
declare v_tenant uuid;
begin
  select o.tenant_id into v_tenant from routes r join operations o on o.id = r.operation_id where r.id = new.route_id;
  if v_tenant is null then return new; end if;   -- rota inexistente: a FK recusa
  if new.viatura_id is not null and (TG_OP = 'INSERT' or new.viatura_id is distinct from old.viatura_id)
     and not exists (select 1 from vehicles where id = new.viatura_id and tenant_id = v_tenant) then
    raise exception 'viatura_id nao pertence ao tenant do registo' using errcode = '42501';
  end if;
  if cardinality(new.motorista_ids) > 0 and (TG_OP = 'INSERT' or new.motorista_ids is distinct from old.motorista_ids)
     and exists (select 1 from unnest(new.motorista_ids) d(id) where not exists (select 1 from drivers x where x.id = d.id and x.tenant_id = v_tenant)) then
    raise exception 'motorista_ids nao pertencem ao tenant do registo' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger records_refs before insert or update on daily_records
  for each row execute function app.records_refs();

-- ---------- F9: so Gestor/Super Admin apagam registos diarios ----------
-- (Operador "nunca apaga"; o Motorista so edita o seu registo enquanto nao Validado.)
create function app.records_guard_delete() returns trigger language plpgsql as $$
begin
  if new.deleted_at is distinct from old.deleted_at and auth.uid() is not null
     and not app.can_manage_op(app.route_op(new.route_id)) then
    raise exception 'apenas Gestor/Super Admin podem apagar (ou restaurar) registos diarios' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger records_guard_delete before update on daily_records
  for each row execute function app.records_guard_delete();

-- ---------- F10: a origem e decidida pelo sistema ----------
-- Regra: quem escreve pela API (auth.uid() definido) NUNCA envia `origem`:
--   * INSERT: se vier preenchida, e recusado; o servidor deriva Manual-Rota (com operacao) ou Manual-Geral (sem).
--   * UPDATE: mudar `origem` e recusado; num lancamento manual a origem acompanha a operacao (reclassificar).
--   * 'automatico' so pode ser criado por funcoes internas (app.sync_auto_movements, sob app.system_write).
-- Mesma regra para registo_id, custo_tipo, versao_anterior_id, validado_por e validado_em: so o servidor os
-- escreve (sync_auto_movements, attach_allocations e a validacao no guard); o cliente nunca.
-- Ligacoes diretas a BD (sem utilizador, ex.: migracoes/manutencao) continuam a poder defini-los.
create or replace function app.movements_state_before() returns trigger language plpgsql security definer set search_path = public as $$
declare v_sys boolean := app.in_system_write();
begin
  if auth.uid() is not null and not v_sys then
    if new.origem is not null then
      raise exception 'a origem do lancamento e definida pelo sistema (nao pode ser enviada)' using errcode = '42501';
    end if;
    if new.registo_id is not null or new.custo_tipo is not null or new.versao_anterior_id is not null
       or new.validado_por is not null or new.validado_em is not null then
      raise exception 'registo_id, custo_tipo, versao_anterior_id, validado_por e validado_em sao geridos pelo sistema (nao podem ser enviados)' using errcode = '42501';
    end if;
    new.origem := case when new.operation_id is null then 'manual_geral' else 'manual_rota' end;
  elsif new.origem is null then
    new.origem := case when new.operation_id is null then 'manual_geral' else 'manual_rota' end;
  end if;

  -- estado inicial (validacao seletiva): o cliente nao o escolhe
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

create or replace function app.movements_guard() returns trigger language plpgsql security definer set search_path = public as $$
declare v_sys boolean := app.in_system_write();
begin
  if new.tenant_id <> old.tenant_id then raise exception 'tenant_id imutavel' using errcode = '42501'; end if;

  if not v_sys and auth.uid() is not null and new.origem is distinct from old.origem then
    raise exception 'a origem do lancamento e definida pelo sistema (nao pode ser alterada)' using errcode = '42501';
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

  -- um lancamento automatico so muda no registo diario (aqui pode mudar: estado, rota/operacao, conta, descricao)
  if old.origem = 'automatico' and not v_sys
     and (new.valor, new.data, new.tipo, new.origem, new.registo_id, new.custo_tipo, new.versao_anterior_id)
         is distinct from (old.valor, old.data, old.tipo, old.origem, old.registo_id, old.custo_tipo, old.versao_anterior_id) then
    raise exception 'lancamento automatico so pode ser alterado no registo diario' using errcode = '42501';
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
