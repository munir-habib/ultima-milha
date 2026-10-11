-- =====================================================================
-- Distribuicao de fundos: sobre-alocacao sinalizada NO SERVIDOR
-- (antes so a UI calculava "over"; nao podia depender do frontend).
--
-- Decisao: a sobre-alocacao NAO e bloqueada — o desenho aceita que aconteca (gasto real acima do
-- fundo recebido) e o que importa e que nunca fique escondida. O servidor:
--   1. mantem a vista `fund_transfer_status` (alocado, diferenca, under/ok/over) — fonte unica de verdade;
--   2. notifica todos os Super Admin E Contabilistas quando uma alteracao AGRAVA o excesso.
-- Para passar a bloquear, basta um `raise exception` no ponto marcado em app.movements_overalloc().
-- Transferencia = subcategoria 'transferencia_distribuicao' sem lancamento_referencia_id (como na UI);
-- alocacao = qualquer lancamento ativo com lancamento_referencia_id = transferencia.
-- =====================================================================

create view fund_transfer_status with (security_invoker = true) as
select t.id, t.tenant_id, t.data, t.pessoa_responsavel, t.valor,
       coalesce(sum(a.valor), 0)::numeric(14,2) as alocado,
       (t.valor - coalesce(sum(a.valor), 0))::numeric(14,2) as diferenca,
       case when t.valor - coalesce(sum(a.valor), 0) > 0 then 'under'
            when t.valor - coalesce(sum(a.valor), 0) < 0 then 'over'
            else 'ok' end as estado
from movements t
left join movements a on a.lancamento_referencia_id = t.id and a.deleted_at is null
where t.subcategoria = 'transferencia_distribuicao' and t.lancamento_referencia_id is null and t.deleted_at is null
group by t.id;
revoke all on fund_transfer_status from anon;
grant select on fund_transfer_status to authenticated;

create function app.movements_overalloc() returns trigger language plpgsql security definer set search_path = public as $$
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
    select coalesce(sum(valor), 0) into v_now from movements where lancamento_referencia_id = t_id and deleted_at is null;

    -- contribuicao desta linha (nova e antiga) para ESTA transferencia
    n_val := case when new.lancamento_referencia_id = t_id and new.deleted_at is null then new.valor else 0 end;
    o_val := 0; v_tr_before := tr.valor;
    if TG_OP = 'UPDATE' then
      o_val := case when old.lancamento_referencia_id = t_id and old.deleted_at is null then old.valor else 0 end;
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
create trigger movements_overalloc after insert or update on movements
  for each row execute function app.movements_overalloc();
