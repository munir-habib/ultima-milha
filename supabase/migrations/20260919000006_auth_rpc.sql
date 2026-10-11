-- =====================================================================
-- Sign-up (primeiro utilizador = Super Admin; convidados entram com o papel do convite),
-- convites, gestao de acessos, duplicar operacao.
-- Requer "Confirm email" ativo no Supabase Auth (evita reclamar convites de terceiros).
-- =====================================================================

create function app.handle_new_user() returns trigger language plpgsql security definer set search_path = public as $$
declare inv invitations; t uuid; nm text;
begin
  nm := coalesce(nullif(new.raw_user_meta_data->>'full_name', ''), nullif(new.raw_user_meta_data->>'name', ''), split_part(new.email, '@', 1));
  select * into inv from invitations
    where lower(email) = lower(new.email) and accepted_at is null and expires_at > now()
    order by created_at desc limit 1;
  if found then
    insert into profiles (id, tenant_id, nome, email, accounting_read)
      values (new.id, inv.tenant_id, nm, new.email, inv.accounting_read);
    insert into user_roles (user_id, role) select new.id, unnest(inv.roles);
    insert into user_operations (user_id, operation_id) select new.id, x from unnest(inv.operation_ids) x;
    if 'motorista' = any(inv.roles) then
      insert into drivers (tenant_id, nome, user_id) values (inv.tenant_id, nm, new.id);
    end if;
    update invitations set accepted_at = now() where id = inv.id;
  else
    insert into tenants (nome) values (coalesce(nullif(new.raw_user_meta_data->>'tenant_name', ''), 'Nova empresa'))
      returning id into t;
    insert into profiles (id, tenant_id, nome, email) values (new.id, t, nm, new.email);
    insert into user_roles (user_id, role) values (new.id, 'super_admin');
  end if;
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function app.handle_new_user();

-- ---------- convites ----------
create function public.create_invitation(p_email text, p_roles app_role[], p_operation_ids uuid[] default '{}',
                                         p_accounting_read boolean default false) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_tenant uuid := app.tenant_id(); v_id uuid; v_email text := lower(trim(p_email));
begin
  if v_tenant is null then raise exception 'sem sessao' using errcode = '42501'; end if;
  if v_email = '' or position('@' in v_email) = 0 then raise exception 'email invalido'; end if;
  if exists (select 1 from profiles where lower(email) = v_email) then raise exception 'ja existe uma conta com este email'; end if;
  if exists (select 1 from unnest(p_operation_ids) o where not app.op_in_tenant(o)) then
    raise exception 'operacao invalida' using errcode = '42501';
  end if;

  if app.has_role('super_admin') then
    null;
  elsif app.has_role('gestor') then
    -- Gestor convida so Operadores/Motoristas, dentro das suas operacoes
    if exists (select 1 from unnest(p_roles) r where r not in ('operador','motorista')) then
      raise exception 'Gestor so pode convidar Operadores e Motoristas' using errcode = '42501';
    end if;
    if cardinality(p_operation_ids) = 0 or exists (select 1 from unnest(p_operation_ids) o where not app.assigned(o)) then
      raise exception 'operacoes fora do seu ambito' using errcode = '42501';
    end if;
    if p_accounting_read then raise exception 'sem permissao' using errcode = '42501'; end if;
  else
    raise exception 'sem permissao' using errcode = '42501';
  end if;

  insert into invitations (tenant_id, email, roles, operation_ids, accounting_read, invited_by)
  values (v_tenant, v_email, p_roles, p_operation_ids, p_accounting_read, auth.uid()) returning id into v_id;
  return v_id;
end $$;

create function public.set_user_access(p_user uuid, p_roles app_role[], p_operation_ids uuid[], p_accounting_read boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not app.has_role('super_admin') then raise exception 'sem permissao' using errcode = '42501'; end if;
  if not exists (select 1 from profiles where id = p_user and tenant_id = app.tenant_id()) then
    raise exception 'utilizador invalido' using errcode = '42501';
  end if;
  if cardinality(p_roles) = 0 then raise exception 'pelo menos um papel'; end if;
  if exists (select 1 from unnest(p_operation_ids) o where not app.op_in_tenant(o)) then
    raise exception 'operacao invalida' using errcode = '42501';
  end if;
  if not ('super_admin' = any(p_roles)) and not exists (
       select 1 from user_roles ur join profiles p on p.id = ur.user_id
       where ur.role = 'super_admin' and p.tenant_id = app.tenant_id() and p.deleted_at is null and p.id <> p_user) then
    raise exception 'tem de existir pelo menos um Super Admin';
  end if;
  delete from user_roles where user_id = p_user;
  insert into user_roles (user_id, role) select p_user, unnest(p_roles);
  delete from user_operations where user_id = p_user;
  insert into user_operations (user_id, operation_id) select p_user, x from unnest(p_operation_ids) x;
  update profiles set accounting_read = p_accounting_read where id = p_user;
end $$;

create function public.set_user_active(p_user uuid, p_active boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not app.has_role('super_admin') then raise exception 'sem permissao' using errcode = '42501'; end if;
  if p_user = auth.uid() and not p_active then raise exception 'nao pode desativar a propria conta'; end if;
  update profiles set deleted_at = case when p_active then null else now() end
   where id = p_user and tenant_id = app.tenant_id();
end $$;

-- ---------- duplicar operacao (estrutura sem dados) ----------
create function public.duplicate_operation(p_source uuid, p_nome text) returns uuid
language plpgsql security definer set search_path = public as $$
declare o operations; v_new uuid; z record; r record;
begin
  if not app.has_role('super_admin') then raise exception 'sem permissao' using errcode = '42501'; end if;
  select * into o from operations where id = p_source and tenant_id = app.tenant_id();
  if not found then raise exception 'operacao invalida' using errcode = '42501'; end if;

  insert into operations (tenant_id, nome, valores_estado, salario_fixo_mensal, salario_var_por_entrega,
                          salario_var_pct_receita, outros_custos_mensais, created_by)
  values (o.tenant_id, p_nome, o.valores_estado, o.salario_fixo_mensal, o.salario_var_por_entrega,
          o.salario_var_pct_receita, o.outros_custos_mensais, auth.uid())
  returning id into v_new;

  -- zonas primeiro: assim o primeiro snapshot de cada rota ja as inclui
  for z in select * from postal_zones where operation_id = p_source and deleted_at is null loop
    insert into postal_zones (operation_id, nome, prefixos, valor_por_entrega) values (v_new, z.nome, z.prefixos, z.valor_por_entrega);
  end loop;
  for r in select * from routes where operation_id = p_source and deleted_at is null loop
    insert into routes (operation_id, nome, tarifa_por_estado, tarifa_valor_fixo, tarifa_por_zona, tarifa_por_distancia,
                        valor_fixo_default, taxa_km, escaloes_km)
    values (v_new, r.nome, r.tarifa_por_estado, r.tarifa_valor_fixo, r.tarifa_por_zona, r.tarifa_por_distancia,
            r.valor_fixo_default, r.taxa_km, r.escaloes_km);
  end loop;
  return v_new;
end $$;

revoke execute on function public.create_invitation, public.set_user_access, public.set_user_active, public.duplicate_operation from public, anon;
grant  execute on function public.create_invitation, public.set_user_access, public.set_user_active, public.duplicate_operation to authenticated;
