-- =====================================================================
-- Row Level Security: isolamento ao nivel da base de dados.
--  * Rotas / registos: isolados por Operacao
--  * Viaturas / motoristas: partilhados por Tenant (excecao deliberada)
--  * Contabilidade: transversal ao Tenant
--  * Nada e apagado fisicamente: DELETE revogado, sem policies de delete.
-- Nota: as policies de SELECT nao filtram deleted_at (um UPDATE que faz soft delete
-- tem de continuar a ver a linha); a app filtra deleted_at is null.
-- =====================================================================

grant usage on schema app to authenticated;
revoke all on all tables in schema public from anon;
grant select, insert, update on all tables in schema public to authenticated;
revoke delete on all tables in schema public from authenticated;
-- tabelas geridas apenas por triggers / RPCs
revoke insert, update on tenants, user_roles, user_operations, invitations, tariff_snapshots, audit_log, slot_assignments from authenticated;
grant update (nome) on tenants to authenticated;
-- perfil: cada utilizador so edita as suas preferencias
revoke update on profiles from authenticated;
grant update (nome, tema, idioma, manter_sessao) on profiles to authenticated;
revoke update on notifications from authenticated;
grant update (lido_em) on notifications to authenticated;
revoke insert on notifications from authenticated;

do $$ declare t text; begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table %I enable row level security', t);
  end loop;
end $$;

-- ---------- funcoes extra ----------
create function app.op_visible(op uuid) returns boolean language sql stable security definer set search_path = public as
$$ select app.op_in_tenant(op) and (app.can_read_op(op) or app.motorista_on_op(op) or app.can_read_accounting()) $$;

create function app.can_edit_record(p_record uuid) returns boolean language sql stable security definer set search_path = public as
$$ select exists (
     select 1 from daily_records r where r.id = p_record and (
       app.can_manage_op(app.route_op(r.route_id))
       or (r.status <> 'validado' and (app.can_write_op(app.route_op(r.route_id))
                                        or (app.has_role('motorista') and r.created_by = auth.uid()))))) $$;

create function app.set_created_by() returns trigger language plpgsql as
$$ begin if auth.uid() is not null then new.created_by := auth.uid(); end if; return new; end $$;
create trigger movements_created_by before insert on movements for each row execute function app.set_created_by();
create trigger costs_created_by before insert on daily_record_costs for each row execute function app.set_created_by();
create trigger operations_created_by before insert on operations for each row execute function app.set_created_by();

-- ---------- tenants / utilizadores ----------
create policy tenants_select on tenants for select to authenticated using (id = app.tenant_id());
create policy tenants_update on tenants for update to authenticated
  using (id = app.tenant_id() and app.has_role('super_admin')) with check (id = app.tenant_id());

create policy profiles_select on profiles for select to authenticated
  using (id = auth.uid() or (tenant_id = app.tenant_id() and app.has_role('super_admin')));
create policy profiles_update on profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

create policy user_roles_select on user_roles for select to authenticated
  using (user_id = auth.uid() or (app.has_role('super_admin') and user_id in (select id from profiles)));
create policy user_ops_select on user_operations for select to authenticated
  using (user_id = auth.uid() or (app.has_role('super_admin') and user_id in (select id from profiles)));

create policy invitations_select on invitations for select to authenticated
  using (tenant_id = app.tenant_id() and (app.has_role('super_admin') or invited_by = auth.uid()));

-- ---------- operacoes / configuracao ----------
-- Nota: nestas policies nao se usa app.can_*_op(id) porque consultam a propria tabela operations
-- e uma funcao STABLE nao ve a linha acabada de inserir (INSERT ... RETURNING falharia).
create policy operations_select on operations for select to authenticated
  using (tenant_id = app.tenant_id() and (app.has_role('super_admin')
         or (app.assigned(id) and app.has_any_role(array['gestor','auditor']::app_role[]))));
create policy operations_insert on operations for insert to authenticated
  with check (tenant_id = app.tenant_id() and app.has_role('super_admin'));
create policy operations_update on operations for update to authenticated
  using (tenant_id = app.tenant_id() and (app.has_role('super_admin') or (app.assigned(id) and app.has_role('gestor'))))
  with check (tenant_id = app.tenant_id() and (app.has_role('super_admin') or (app.assigned(id) and app.has_role('gestor'))));

create policy zones_select on postal_zones for select to authenticated using (app.can_view_settings(operation_id));
create policy zones_insert on postal_zones for insert to authenticated with check (app.can_manage_op(operation_id));
create policy zones_update on postal_zones for update to authenticated
  using (app.can_manage_op(operation_id)) with check (app.can_manage_op(operation_id));

create policy routes_select on routes for select to authenticated using (app.can_view_settings(operation_id));
create policy routes_insert on routes for insert to authenticated with check (app.can_manage_op(operation_id));
create policy routes_update on routes for update to authenticated
  using (app.can_manage_op(operation_id)) with check (app.can_manage_op(operation_id));

create policy snapshots_select on tariff_snapshots for select to authenticated
  using (app.can_view_settings(app.route_op(route_id)));

create policy goals_select on goals for select to authenticated using (app.can_read_op(operation_id));
create policy goals_insert on goals for insert to authenticated with check (app.can_manage_op(operation_id));
create policy goals_update on goals for update to authenticated
  using (app.can_manage_op(operation_id)) with check (app.can_manage_op(operation_id));

-- ---------- frota (Tenant) ----------
create policy slots_select on fleet_slots for select to authenticated
  using (tenant_id = app.tenant_id() and app.has_any_role(array['super_admin','gestor','operador','auditor']::app_role[]));
create policy slots_insert on fleet_slots for insert to authenticated
  with check (tenant_id = app.tenant_id() and app.has_any_role(array['super_admin','gestor']::app_role[]));
create policy slots_update on fleet_slots for update to authenticated
  using (tenant_id = app.tenant_id() and app.has_any_role(array['super_admin','gestor']::app_role[]))
  with check (tenant_id = app.tenant_id());

create policy vehicles_select on vehicles for select to authenticated
  using (tenant_id = app.tenant_id() and app.has_any_role(array['super_admin','gestor','operador','auditor']::app_role[]));
create policy vehicles_insert on vehicles for insert to authenticated
  with check (tenant_id = app.tenant_id() and app.has_any_role(array['super_admin','gestor']::app_role[]));
create policy vehicles_update on vehicles for update to authenticated
  using (tenant_id = app.tenant_id() and app.has_any_role(array['super_admin','gestor']::app_role[]))
  with check (tenant_id = app.tenant_id());

create policy slot_assign_select on slot_assignments for select to authenticated
  using (tenant_id = app.tenant_id() and app.has_any_role(array['super_admin','gestor','operador','auditor']::app_role[]));

create policy drivers_select on drivers for select to authenticated
  using (tenant_id = app.tenant_id() and (user_id = auth.uid()
         or app.has_any_role(array['super_admin','gestor','operador','auditor','contabilista']::app_role[])));
create policy drivers_insert on drivers for insert to authenticated
  with check (tenant_id = app.tenant_id() and app.has_any_role(array['super_admin','gestor']::app_role[]));
create policy drivers_update on drivers for update to authenticated
  using (tenant_id = app.tenant_id() and app.has_any_role(array['super_admin','gestor']::app_role[]))
  with check (tenant_id = app.tenant_id());

-- ---------- registos diarios ----------
create policy records_select on daily_records for select to authenticated
  using (app.can_read_op(app.route_op(route_id))
         or (app.has_role('motorista') and created_by = auth.uid() and app.op_in_tenant(app.route_op(route_id))));
create policy records_insert on daily_records for insert to authenticated
  with check (app.can_write_op(app.route_op(route_id)) or app.motorista_on_op(app.route_op(route_id)));
create policy records_update on daily_records for update to authenticated
  using (app.can_manage_op(app.route_op(route_id))
         or (status <> 'validado' and (app.can_write_op(app.route_op(route_id))
                                        or (app.has_role('motorista') and created_by = auth.uid()))))
  with check (app.can_manage_op(app.route_op(route_id))
         or (status <> 'validado' and (app.can_write_op(app.route_op(route_id))
                                        or (app.has_role('motorista') and created_by = auth.uid()))));

create policy costs_select on daily_record_costs for select to authenticated
  using (exists (select 1 from daily_records r where r.id = record_id));
create policy costs_insert on daily_record_costs for insert to authenticated with check (app.can_edit_record(record_id));
create policy costs_update on daily_record_costs for update to authenticated
  using (app.can_edit_record(record_id)) with check (app.can_edit_record(record_id));

-- ---------- contabilidade ----------
create policy bank_select on bank_accounts for select to authenticated
  using (tenant_id = app.tenant_id() and app.can_read_accounting());
create policy bank_insert on bank_accounts for insert to authenticated
  with check (tenant_id = app.tenant_id() and app.can_write_accounting());
create policy bank_update on bank_accounts for update to authenticated
  using (tenant_id = app.tenant_id() and app.can_write_accounting()) with check (tenant_id = app.tenant_id());

create policy mov_select on movements for select to authenticated
  using (tenant_id = app.tenant_id() and app.can_read_accounting());
create policy mov_insert on movements for insert to authenticated
  with check (tenant_id = app.tenant_id() and app.can_write_accounting()
              and (operation_id is null or app.op_in_tenant(operation_id)));
create policy mov_update on movements for update to authenticated
  using (tenant_id = app.tenant_id() and app.can_write_accounting())
  with check (tenant_id = app.tenant_id() and (operation_id is null or app.op_in_tenant(operation_id)));

-- ---------- notificacoes / audit ----------
create policy notif_select on notifications for select to authenticated using (user_id = auth.uid());
create policy notif_update on notifications for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- unica excecao ao "nunca apagar": subscricoes push nao sao dados de negocio
create policy push_all on push_subscriptions for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
grant delete on push_subscriptions to authenticated;

create policy audit_select on audit_log for select to authenticated
  using (tenant_id = app.tenant_id() and app.has_role('super_admin'));

-- ---------- vistas de opcoes (pickers) sem expor custos/definicoes ----------
create view operation_options as
  select o.id, o.nome from operations o
  where o.deleted_at is null and app.op_visible(o.id);

create view route_options as
  select r.id, r.operation_id, r.nome, r.tarifa_por_estado, r.tarifa_valor_fixo, r.tarifa_por_zona,
         r.tarifa_por_distancia, r.valor_fixo_default
  from routes r where r.deleted_at is null and app.op_visible(r.operation_id);

create view zone_options as
  select z.id, z.operation_id, z.nome from postal_zones z
  where z.deleted_at is null and app.op_visible(z.operation_id);

create view vehicle_options as
  select v.id, v.matricula, v.posto_id, v.estado from vehicles v
  where v.deleted_at is null and v.tenant_id = app.tenant_id();

create view driver_options as
  select d.id, d.nome, d.user_id from drivers d
  where d.deleted_at is null and d.tenant_id = app.tenant_id()
    and (d.user_id = auth.uid()
         or app.has_any_role(array['super_admin','gestor','operador','auditor','contabilista']::app_role[]));

revoke all on operation_options, route_options, zone_options, vehicle_options, driver_options from anon;
grant select on operation_options, route_options, zone_options, vehicle_options, driver_options to authenticated;
