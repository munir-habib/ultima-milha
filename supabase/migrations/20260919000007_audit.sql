-- =====================================================================
-- Audit trail generico (quem, quando, valores antes/depois) + bloqueio de DELETE fisico
-- =====================================================================

create function app.audit() returns trigger language plpgsql security definer set search_path = public as $$
declare v_old jsonb; v_new jsonb; v_action text; v_row jsonb;
begin
  if TG_OP = 'INSERT' then
    v_new := to_jsonb(new); v_action := 'INSERT';
  elsif TG_OP = 'UPDATE' then
    v_old := to_jsonb(old); v_new := to_jsonb(new);
    if (v_old - 'updated_at') = (v_new - 'updated_at') then return new; end if;
    v_action := case when v_old->>'deleted_at' is null and v_new->>'deleted_at' is not null then 'SOFT_DELETE' else 'UPDATE' end;
  else
    v_old := to_jsonb(old); v_action := 'DELETE';
  end if;
  v_row := coalesce(v_new, v_old);
  insert into audit_log (tenant_id, tabela, registo_id, acao, user_id, antes, depois)
  values (coalesce((v_row->>'tenant_id')::uuid, case when TG_TABLE_NAME = 'tenants' then (v_row->>'id')::uuid end, app.tenant_id()), TG_TABLE_NAME,
          coalesce(v_row->>'id', v_row->>'user_id'), v_action, auth.uid(), v_old, v_new);
  return coalesce(new, old);
end $$;

create function app.forbid_delete() returns trigger language plpgsql as $$
begin raise exception 'apagar fisicamente nao e permitido em % (usar soft delete)', TG_TABLE_NAME using errcode = '42501'; end $$;

do $$ declare t text; begin
  for t in select tablename from pg_tables where schemaname = 'public'
            and tablename not in ('audit_log','notifications','push_subscriptions') loop
    execute format('create trigger zz_audit after insert or update or delete on %I for each row execute function app.audit()', t);
  end loop;
  -- tabelas de negocio: DELETE fisico proibido (mesmo para service role)
  for t in select tablename from pg_tables where schemaname = 'public'
            and tablename not in ('audit_log','notifications','push_subscriptions','user_roles','user_operations') loop
    execute format('create trigger zz_forbid_delete before delete on %I for each row execute function app.forbid_delete()', t);
  end loop;
end $$;

-- audit_log e append-only
create function app.audit_immutable() returns trigger language plpgsql as
$$ begin raise exception 'audit_log e imutavel'; end $$;
create trigger audit_log_immutable before update or delete on audit_log for each row execute function app.audit_immutable();
