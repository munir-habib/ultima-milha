-- =====================================================================
-- Contabilidade: achados da analise de simplificacao (13a, 4, 5, 6, dedupe do 7)
--  13a  alerta fund_unreconciled: so alocacoes a DEBITO contam (igual a vista e a UI).
--  4    alerta allocation_unlinked: alocacao "por ligar" ha 3+ dias (semanal) ao Gestor da operacao e ao Contabilista.
--  5    reclassificar (rota/operacao/data) uma alocacao JA propagada: a linha de custo antiga e apagada (soft delete),
--       o registo (se estava Validado) volta a Submetido e o validador e avisado, a alocacao fica "por ligar" e liga-se
--       ao registo da nova rota+data, se existir.  ** ALTERA a regra "copias independentes" — decisao expressa **
--  6    public.request_cost_correction: o Contabilista pede ao Gestor da operacao a correcao de um automatico
--       (notificacao auto_cost_disputed); o automatico continua a so mudar no registo diario.
--  7    movement_pending com dedupe_key por movimento e dia (sem resumo diario).
-- =====================================================================

create or replace function app.run_alerts(p_force_evening boolean default false) returns integer
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
           t.valor - coalesce((select sum(a.valor) from movements a where a.lancamento_referencia_id = t.id and a.deleted_at is null and a.tipo = 'debito'), 0) as por_alocar
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

  -- 5) alocacoes "por ligar ao operacional" ha 3+ dias (sem registo diario onde propagar): lembrete semanal ao Gestor da
  --    operacao (quem manda criar o registo) e ao Contabilista. A Contabilidade nunca cria o registo.
  for r in
    select m.id, m.tenant_id, m.operation_id, m.rota_id, m.data, m.valor, m.pessoa_responsavel, ro.nome as rota
    from movements m join routes ro on ro.id = m.rota_id
    where m.lancamento_referencia_id is not null and m.operation_id is not null and m.rota_id is not null
      and m.tipo = 'debito' and m.deleted_at is null and m.registo_id is null and m.data <= v_today - 3
  loop
    for u in select o from app.op_managers(r.operation_id) o
             union select c from app.tenant_users(r.tenant_id, array['super_admin','contabilista']::app_role[]) c loop
      if app.notify(r.tenant_id, u, 'allocation_unlinked',
                    jsonb_build_object('movement_id', r.id, 'route_id', r.rota_id, 'route', r.rota, 'data', r.data, 'valor', r.valor, 'pessoa', r.pessoa_responsavel),
                    'unlinked:' || r.id || ':' || to_char(v_today, 'IYYY-IW')) then n := n + 1; end if;
    end loop;
  end loop;

  return n;
end $$;

create or replace function app.movements_notify() returns trigger language plpgsql security definer set search_path = public as $$
declare u uuid; v_dest text;
begin
  if new.deleted_at is null and new.estado = 'pendente' and (TG_OP = 'INSERT' or old.estado is distinct from 'pendente') then
    select coalesce((select nome from operations where id = new.operation_id), (select nome from bank_accounts where id = new.conta_id), '—') into v_dest;
    -- todas as contas Super Admin E todas as contas Contabilista (nunca so uma das duas)
    for u in select * from app.tenant_users(new.tenant_id, array['super_admin','contabilista']::app_role[]) loop
      perform app.notify(new.tenant_id, u, 'movement_pending',
        jsonb_build_object('movement_id', new.id, 'valor', new.valor, 'destino', v_dest,
                           'kind', case when new.origem = 'automatico' then 'auto' else 'alloc' end),
        -- um aviso por movimento e por dia (reverter/revalidar no mesmo dia nao repete o aviso)
        'pending:' || new.id || ':' || app.today());
    end loop;
  end if;
  return new;
end $$;

-- ---------- 5) reclassificar uma alocacao ja propagada ----------
create function app.movements_relink() returns trigger language plpgsql security definer set search_path = public as $$
declare v_old daily_records; v_rec uuid; v_tenant uuid;
begin
  if new.lancamento_referencia_id is null or new.tipo <> 'debito' or new.deleted_at is not null then return new; end if;
  if (new.rota_id, new.operation_id, new.data) is not distinct from (old.rota_id, old.operation_id, old.data) then return new; end if;

  if new.registo_id is not null then
    perform set_config('app.system_write', '1', true);
    -- a linha de custo (copia) do registo antigo deixa de fazer sentido: soft delete (fica no audit)
    update daily_record_costs set deleted_at = now() where movimento_id = new.id and deleted_at is null;
    select * into v_old from daily_records where id = new.registo_id;
    if found and v_old.status = 'validado' then
      update daily_records set status = 'submetido', validado_por = null, validado_em = null where id = v_old.id;
      if v_old.validado_por is not null and v_old.validado_por is distinct from auth.uid() then
        select o.tenant_id into v_tenant from routes r join operations o on o.id = r.operation_id where r.id = v_old.route_id;
        perform app.notify(v_tenant, v_old.validado_por, 'record_reopened',
          jsonb_build_object('record_id', v_old.id, 'route_id', v_old.route_id, 'data', v_old.data, 'by', auth.uid()));
      end if;
    end if;
    -- o UPDATE do registo acima corre sync_auto_movements, que repoe app.system_write a 0: voltar a ativa-lo
    perform set_config('app.system_write', '1', true);
    update movements set registo_id = null where id = new.id;   -- volta a "por ligar"
    perform set_config('app.system_write', '0', true);
  end if;

  -- liga ao registo da nova rota+data, se ja existir (nunca o cria)
  if new.operation_id is not null and new.rota_id is not null then
    select id into v_rec from daily_records where route_id = new.rota_id and data = new.data and deleted_at is null;
    if v_rec is not null then perform app.attach_allocations(v_rec); end if;
  end if;
  return new;
end $$;
create trigger movements_relink after update on movements for each row execute function app.movements_relink();

-- ---------- 6) pedir correcao de um automatico ao Gestor da operacao ----------
create function public.request_cost_correction(p_movement uuid, p_note text default null) returns integer
language plpgsql security definer set search_path = public as $$
declare m movements; u uuid; n integer := 0; v_route text;
begin
  if not app.can_write_accounting() then raise exception 'sem permissao' using errcode = '42501'; end if;
  select * into m from movements where id = p_movement and tenant_id = app.tenant_id() and deleted_at is null;
  if not found then raise exception 'lancamento nao encontrado' using errcode = 'P0002'; end if;
  if m.origem <> 'automatico' or m.operation_id is null then
    raise exception 'so se pede correcao de lancamentos automaticos (com operacao)' using errcode = '23514';
  end if;
  select nome into v_route from routes where id = m.rota_id;
  for u in select o from app.op_managers(m.operation_id) o loop
    continue when u is not distinct from auth.uid();
    if app.notify(m.tenant_id, u, 'auto_cost_disputed',
                  jsonb_build_object('movement_id', m.id, 'registo_id', m.registo_id, 'route_id', m.rota_id, 'route', coalesce(v_route, ''),
                                     'data', m.data, 'valor', m.valor, 'custo_tipo', m.custo_tipo, 'note', left(coalesce(btrim(p_note), ''), 500), 'by', auth.uid()),
                  'dispute:' || m.id || ':' || app.today()) then n := n + 1; end if;
  end loop;
  return n;   -- 0 = ja foi pedido hoje (ou ninguem a avisar)
end $$;
revoke execute on function public.request_cost_correction(uuid, text) from public, anon;
grant execute on function public.request_cost_correction(uuid, text) to authenticated;
