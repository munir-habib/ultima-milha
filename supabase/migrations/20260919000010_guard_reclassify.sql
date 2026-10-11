-- Reclassificar (rota / operacao / motorista) uma alocacao validada NAO lhe tira a validacao:
-- so perde a validacao se mudar aquilo que foi validado (valor, tipo, data, pessoa).
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

  -- um lancamento automatico so muda no registo diario (aqui pode mudar: estado, rota/operacao, conta, descricao)
  if old.origem = 'automatico' and not v_sys
     and (new.valor, new.data, new.tipo, new.origem, new.registo_id, new.custo_tipo, new.versao_anterior_id)
         is distinct from (old.valor, old.data, old.tipo, old.origem, old.registo_id, old.custo_tipo, old.versao_anterior_id) then
    raise exception 'lancamento automatico so pode ser alterado no registo diario' using errcode = '42501';
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
