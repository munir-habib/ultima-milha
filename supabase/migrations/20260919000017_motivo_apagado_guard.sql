-- =====================================================================
-- Contabilidade: motivo_apagado so ao apagar (residuo do F5, 2.a ronda do tester)
-- Antes: motivo_apagado estava na lista de excecoes do guard dos automaticos e (em geral) era gravavel
-- numa linha ATIVA. Agora so muda quando deleted_at passa de nulo a preenchido (o soft delete, que
-- continua a exigir motivo e Super Admin). Ligacoes diretas a BD (sem utilizador) podem corrigir dados.
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

  -- motivo_apagado so se define AO APAGAR (deleted_at de nulo para preenchido): numa linha ativa nao se escreve
  if not v_sys and auth.uid() is not null and new.motivo_apagado is distinct from old.motivo_apagado
     and not (old.deleted_at is null and new.deleted_at is not null) then
    raise exception 'motivo_apagado so pode ser definido ao apagar o lancamento' using errcode = '42501';
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
