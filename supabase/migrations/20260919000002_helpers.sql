-- =====================================================================
-- Helpers de permissoes (security definer para evitar recursao de RLS)
-- =====================================================================

create function app.today() returns date language sql stable as
$$ select (now() at time zone 'Europe/Lisbon')::date $$;

create function app.tenant_id() returns uuid language sql stable security definer set search_path = public as
$$ select tenant_id from profiles where id = auth.uid() and deleted_at is null $$;

create function app.has_role(r app_role) returns boolean language sql stable security definer set search_path = public as
$$ select exists (select 1 from user_roles ur join profiles p on p.id = ur.user_id
                  where ur.user_id = auth.uid() and ur.role = r and p.deleted_at is null) $$;

create function app.has_any_role(rs app_role[]) returns boolean language sql stable security definer set search_path = public as
$$ select exists (select 1 from user_roles ur join profiles p on p.id = ur.user_id
                  where ur.user_id = auth.uid() and ur.role = any(rs) and p.deleted_at is null) $$;

create function app.op_in_tenant(op uuid) returns boolean language sql stable security definer set search_path = public as
$$ select exists (select 1 from operations where id = op and tenant_id = app.tenant_id()) $$;

create function app.assigned(op uuid) returns boolean language sql stable security definer set search_path = public as
$$ select exists (select 1 from user_operations where user_id = auth.uid() and operation_id = op) $$;

create function app.route_op(p_route uuid) returns uuid language sql stable security definer set search_path = public as
$$ select operation_id from routes where id = p_route $$;

-- Ler dados operacionais de uma operacao (Super Admin / Gestor / Operador / Auditor atribuidos)
create function app.can_read_op(op uuid) returns boolean language sql stable security definer set search_path = public as
$$ select app.op_in_tenant(op) and (
     app.has_role('super_admin')
     or (app.assigned(op) and app.has_any_role(array['gestor','operador','auditor']::app_role[])) ) $$;

-- Criar/editar registos diarios (Super Admin / Gestor / Operador)
create function app.can_write_op(op uuid) returns boolean language sql stable security definer set search_path = public as
$$ select app.op_in_tenant(op) and (
     app.has_role('super_admin')
     or (app.assigned(op) and app.has_any_role(array['gestor','operador']::app_role[])) ) $$;

-- Gerir definicoes, tarifario, validar registos (Super Admin / Gestor)
create function app.can_manage_op(op uuid) returns boolean language sql stable security definer set search_path = public as
$$ select app.op_in_tenant(op) and (
     app.has_role('super_admin')
     or (app.assigned(op) and app.has_role('gestor')) ) $$;

-- Ver definicoes/tarifario (Operador nao ve)
create function app.can_view_settings(op uuid) returns boolean language sql stable security definer set search_path = public as
$$ select app.op_in_tenant(op) and (
     app.has_role('super_admin')
     or (app.assigned(op) and app.has_any_role(array['gestor','auditor']::app_role[])) ) $$;

-- Motorista pode registar em rotas das operacoes que lhe foram atribuidas
create function app.motorista_on_op(op uuid) returns boolean language sql stable security definer set search_path = public as
$$ select app.op_in_tenant(op) and app.has_role('motorista') and app.assigned(op) $$;

create function app.can_read_accounting() returns boolean language sql stable security definer set search_path = public as
$$ select app.tenant_id() is not null and (
     app.has_any_role(array['super_admin','contabilista']::app_role[])
     or (app.has_role('auditor') and exists (select 1 from profiles where id = auth.uid() and accounting_read)) ) $$;

create function app.can_write_accounting() returns boolean language sql stable security definer set search_path = public as
$$ select app.tenant_id() is not null and app.has_any_role(array['super_admin','contabilista']::app_role[]) $$;

-- Utilizadores com acesso a lista de utilizadores atribuidos a uma operacao (para notificacoes)
create function app.op_managers(op uuid) returns setof uuid language sql stable security definer set search_path = public as
$$ select p.id from profiles p
   join user_roles ur on ur.user_id = p.id
   where p.tenant_id = (select tenant_id from operations where id = op) and p.deleted_at is null
     and ( ur.role = 'super_admin'
        or (ur.role = 'gestor' and exists (select 1 from user_operations uo where uo.user_id = p.id and uo.operation_id = op)) ) $$;

create function app.notify(p_tenant uuid, p_user uuid, p_tipo text, p_payload jsonb) returns void
language sql security definer set search_path = public as
$$ insert into notifications (tenant_id, user_id, tipo, payload) values (p_tenant, p_user, p_tipo, p_payload) $$;

create function app.touch_updated_at() returns trigger language plpgsql as
$$ begin new.updated_at := now(); return new; end $$;
