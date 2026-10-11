-- =====================================================================
-- Desempenho da leitura do audit_log (mesmo defeito das 0020/0022): audit_select avaliava app.tenant_id() e
-- app.has_role('super_admin') POR LINHA. Com ~62 000 linhas (o audit e append-only e cresce com cada escrita) uma leitura
-- sem filtro por indice demorava 1,9 s (medido no projeto real) e uma listagem larga estourava o statement_timeout (8 s).
-- Semantica identica: as duas funcoes dependem so de auth.uid(); `(select ...)` avalia-as UMA vez (InitPlan) e o indice
-- (tenant_id, em desc) passa a servir. Medido no projeto real: 1885 ms -> 11,6 ms.
-- =====================================================================

drop policy audit_select on audit_log;
create policy audit_select on audit_log for select to authenticated
  using (tenant_id = (select app.tenant_id()) and (select app.has_role('super_admin')));
