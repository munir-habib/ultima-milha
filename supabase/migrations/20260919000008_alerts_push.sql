-- =====================================================================
-- Alertas agendados, vencimentos de viaturas e gancho para push notifications
-- =====================================================================

alter table vehicles
  add column iuc_vencimento date,
  add column seguro_vencimento date;

-- deduplicacao: cada alerta so e enviado uma vez por utilizador e chave
alter table notifications add column dedupe_key text;
create unique index notifications_dedupe on notifications (user_id, dedupe_key) where dedupe_key is not null;

drop function app.notify(uuid, uuid, text, jsonb);
create function app.notify(p_tenant uuid, p_user uuid, p_tipo text, p_payload jsonb, p_key text default null) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  insert into notifications (tenant_id, user_id, tipo, payload, dedupe_key) values (p_tenant, p_user, p_tipo, p_payload, p_key)
  on conflict (user_id, dedupe_key) where dedupe_key is not null do nothing;
  return found;
end $$;

-- utilizadores do tenant com um dos papeis dados (para alertas transversais)
create function app.tenant_users(p_tenant uuid, p_roles app_role[]) returns setof uuid
language sql stable security definer set search_path = public as $$
  select distinct p.id from profiles p join user_roles ur on ur.user_id = p.id
  where p.tenant_id = p_tenant and p.deleted_at is null and ur.role = any(p_roles) $$;

-- ---------- motor de alertas (chamado diariamente pelo pg_cron) ----------
-- p_force_evening: para testes / execucao manual fora da hora
create function app.run_alerts(p_force_evening boolean default false) returns integer
language plpgsql security definer set search_path = public as $$
declare
  n integer := 0;
  v_today date := app.today();
  v_evening boolean := p_force_evening or extract(hour from (now() at time zone 'Europe/Lisbon')) >= 20;
  v_from date := date_trunc('month', v_today - interval '1 month')::date;
  v_to date := (date_trunc('month', v_today) - interval '1 day')::date;
  v_ndays integer := (v_to - v_from) + 1;
  r record; u uuid;
begin
  -- 1) registo diario em falta (rotas ativas: com registos nos ultimos 14 dias, sem registo hoje, depois das 20h)
  if v_evening then
    for r in
      select ro.id, ro.nome, ro.operation_id, o.tenant_id from routes ro join operations o on o.id = ro.operation_id
      where ro.deleted_at is null and o.deleted_at is null and ro.created_at::date < v_today
        and exists (select 1 from daily_records d where d.route_id = ro.id and d.deleted_at is null and d.data between v_today - 14 and v_today - 1)
        and not exists (select 1 from daily_records d where d.route_id = ro.id and d.data = v_today and d.deleted_at is null)
    loop
      for u in select * from app.op_managers(r.operation_id) loop
        if app.notify(r.tenant_id, u, 'record_missing', jsonb_build_object('route_id', r.id, 'route', r.nome, 'data', v_today), 'missing:' || r.id || ':' || v_today) then n := n + 1; end if;
      end loop;
    end loop;
  end if;

  -- 2) fundos de distribuicao por reconciliar ha 7+ dias (lembrete semanal)
  for r in
    select t.id, t.tenant_id, t.pessoa_responsavel, t.valor, t.data,
           t.valor - coalesce((select sum(a.valor) from movements a where a.lancamento_referencia_id = t.id and a.deleted_at is null), 0) as por_alocar
    from movements t
    where t.subcategoria = 'transferencia_distribuicao' and t.lancamento_referencia_id is null and t.deleted_at is null
      and t.data <= v_today - 7
  loop
    continue when r.por_alocar <= 0;
    for u in select * from app.tenant_users(r.tenant_id, array['super_admin','contabilista']::app_role[]) loop
      if app.notify(r.tenant_id, u, 'fund_unreconciled',
                    jsonb_build_object('movement_id', r.id, 'pessoa', r.pessoa_responsavel, 'valor', r.por_alocar, 'data', r.data),
                    'fund:' || r.id || ':' || to_char(v_today, 'IYYY-IW')) then n := n + 1; end if;
    end loop;
  end loop;

  -- 3) margem negativa no mes fechado (mesma logica de custos do dashboard; /30 por dia)
  for r in
    with recs as (
      select d.*, ro.operation_id from daily_records d join routes ro on ro.id = d.route_id
      where d.deleted_at is null and d.data between v_from and v_to),
    per_op as (
      select operation_id, sum(receita_total) rev,
             sum(coalesce(comb_valor, 0) + coalesce(portagens_valor, 0)) direct,
             sum(coalesce(enc_entregues, 0)) deliv
      from recs group by operation_id),
    veh_days as (select distinct operation_id, viatura_id, data from recs where viatura_id is not null),
    veh as (
      select vd.operation_id,
             sum(case when v.iuc_ativo then v.iuc_valor / 30 else 0 end
               + case when v.seguro_ativo then v.seguro_valor / 30 else 0 end
               + case when v.manutencao_ativo then v.manutencao_valor / 30 else 0 end
               + coalesce(v.aluguer_custo / case v.aluguer_periodicidade when 'semanal' then 7 when 'mensal' then 30 else 1 end, 0)) as custo
      from veh_days vd join vehicles v on v.id = vd.viatura_id group by vd.operation_id),
    dist as (
      select rc.operation_id, sum(c.valor) as custo from daily_record_costs c join recs rc on rc.id = c.record_id
      where c.deleted_at is null group by rc.operation_id)
    select o.id as op_id, o.nome, o.tenant_id, p.rev,
           p.rev - p.direct - coalesce(dist.custo, 0) - coalesce(veh.custo, 0)
                 - (o.salario_fixo_mensal / 30 * v_ndays + o.outros_custos_mensais / 30 * v_ndays
                    + o.salario_var_por_entrega * p.deliv + o.salario_var_pct_receita / 100 * p.rev) as margem
    from per_op p join operations o on o.id = p.operation_id
    left join veh on veh.operation_id = p.operation_id left join dist on dist.operation_id = p.operation_id
    where o.deleted_at is null
  loop
    continue when r.margem >= 0;
    for u in select * from app.op_managers(r.op_id) loop
      if app.notify(r.tenant_id, u, 'margin_negative',
                    jsonb_build_object('operation_id', r.op_id, 'operation', r.nome, 'margem', round(r.margem, 2), 'periodo', to_char(v_from, 'YYYY-MM')),
                    'margin:' || r.op_id || ':' || to_char(v_from, 'YYYY-MM')) then n := n + 1; end if;
    end loop;
  end loop;

  -- 4) custos fixos a vencer (IUC, seguro, fim de aluguer) nos proximos 15 dias
  for r in
    select v.id, v.tenant_id, v.matricula, k.tipo, k.venc
    from vehicles v
    cross join lateral (values
      ('iuc', case when v.iuc_ativo then v.iuc_vencimento end),
      ('seguro', case when v.seguro_ativo then v.seguro_vencimento end),
      ('aluguer', case when v.tipo = 'alugada' then v.aluguer_data_fim end)) as k(tipo, venc)
    where v.deleted_at is null and v.estado <> 'vendida' and k.venc is not null and k.venc between v_today and v_today + 15
  loop
    for u in select * from app.tenant_users(r.tenant_id, array['super_admin','gestor']::app_role[]) loop
      if app.notify(r.tenant_id, u, 'cost_due', jsonb_build_object('vehicle_id', r.id, 'matricula', r.matricula, 'custo', r.tipo, 'vencimento', r.venc),
                    'due:' || r.tipo || ':' || r.id || ':' || r.venc) then n := n + 1; end if;
    end loop;
  end loop;

  return n;
end $$;

revoke execute on function app.run_alerts(boolean) from public, anon, authenticated;

-- ---------- push: cada notificacao nova chama a Edge Function send-push (via pg_net) ----------
create table app.config (key text primary key, value text not null);

create function app.notifications_push() returns trigger language plpgsql security definer set search_path = public as $$
declare v_url text; v_secret text;
begin
  select value into v_url from app.config where key = 'push_url';
  select value into v_secret from app.config where key = 'push_secret';
  if v_url is null or v_secret is null then return new; end if;
  begin
    perform net.http_post(
      url := v_url,
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-push-secret', v_secret),
      body := jsonb_build_object('notification_id', new.id, 'user_id', new.user_id, 'tipo', new.tipo, 'payload', new.payload));
  exception when others then
    null; -- o push nunca pode impedir a criacao da notificacao
  end;
  return new;
end $$;
create trigger notifications_push after insert on notifications for each row execute function app.notifications_push();

-- extensoes e agendamento (indisponiveis fora do Supabase, p.ex. nos testes locais)
do $$
begin
  begin create extension if not exists pg_net; exception when others then raise notice 'pg_net indisponivel: %', sqlerrm; end;
  begin
    create extension if not exists pg_cron;
    perform cron.schedule('um-alerts', '0 20 * * *', 'select app.run_alerts()');
  exception when others then raise notice 'pg_cron indisponivel: %', sqlerrm; end;
end $$;
