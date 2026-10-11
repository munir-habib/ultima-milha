-- =====================================================================
-- Desempenho da leitura de registos diarios (analista, 4.a ronda: P1). Mesmo defeito da 0020, noutra tabela:
-- records_select chamava app.can_read_op(app.route_op(route_id)) POR LINHA (~0,8 ms/linha) e costs_select arrastava-a
-- (uma leitura do registo por cada linha de custo). Com ~9 700 registos uma varredura estoura o statement_timeout (8 s)
-- e o dashboard pede-os por paginas (OFFSET) com os custos embutidos.
-- Aqui a condicao depende da LINHA (route_id), por isso nao serve so `(select fn())`: calcula-se UMA vez o conjunto de rotas
-- legiveis (as rotas sao dezenas) e a policy passa a `route_id in (<conjunto>)` — um hashed SubPlan avaliado uma vez.
-- Semantica identica: o conjunto e exatamente { rotas cuja operacao app.can_read_op deixa ler }; o ramo do Motorista
-- (os seus proprios registos, em rotas do tenant) mantem-se. Provado por teste papel a papel (oraculo em SQL).
-- =====================================================================

create function app.readable_routes() returns setof uuid language sql stable security definer set search_path = public as
$$ select r.id from routes r where app.can_read_op(r.operation_id) $$;

create function app.tenant_routes() returns setof uuid language sql stable security definer set search_path = public as
$$ select r.id from routes r join operations o on o.id = r.operation_id where o.tenant_id = app.tenant_id() $$;

revoke execute on function app.readable_routes(), app.tenant_routes() from public, anon;
grant execute on function app.readable_routes(), app.tenant_routes() to authenticated;

drop policy records_select on daily_records;
create policy records_select on daily_records for select to authenticated
  using (route_id in (select app.readable_routes())
         or ((select app.has_role('motorista')) and created_by = (select auth.uid()) and route_id in (select app.tenant_routes())));

-- linhas de custo: visiveis quando o registo o e (a policy acima e aplicada na subconsulta, uma vez)
drop policy costs_select on daily_record_costs;
create policy costs_select on daily_record_costs for select to authenticated
  using (record_id in (select id from daily_records));
