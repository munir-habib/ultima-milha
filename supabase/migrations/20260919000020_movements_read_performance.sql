-- =====================================================================
-- Desempenho da leitura de movimentos (achado da 3.a ronda: totais paginados)
-- Com ~10 000 movimentos, a 2.a pagina do carregamento falhava com "statement timeout" (8 s no papel authenticated):
--   * a policy mov_select chamava app.tenant_id() e app.can_read_accounting() POR LINHA (o planificador nao
--     as eleva do Filter: ~0,4 ms/linha, e cada pagina refaz o count exato);
--   * a ordenacao (data desc, created_at desc, id desc) nao tinha indice.
-- Mesma semantica: as funcoes dependem so de auth.uid() (constante no pedido); `(select ...)` faz o Postgres as avalie
-- UMA vez (InitPlan). O indice parcial serve a ordenacao usada pela UI.
-- =====================================================================

drop policy mov_select on movements;
create policy mov_select on movements for select to authenticated
  using (tenant_id = (select app.tenant_id()) and (select app.can_read_accounting()));

create index movements_active_order on movements (tenant_id, data desc, created_at desc, id desc) where deleted_at is null;
