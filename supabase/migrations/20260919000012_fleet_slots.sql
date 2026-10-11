-- =====================================================================
-- Frota: historico dos postos (relatorio QA F6, F7, F8)
--
-- REGRA DOS INTERVALOS: slot_assignments.data_fim e EXCLUSIVO.
--   A viatura ocupou o posto no intervalo [data_inicio, data_fim): data_fim e o dia em que
--   JA NAO esta la (nao o ultimo dia em que esteve). data_fim NULL = ainda la.
--   Logo, numa troca A -> B no dia D: A.data_fim = D e B.data_inicio = D — sem sobreposicao
--   e sem buracos. Uma ocupacao com data_inicio = data_fim passou pelo posto sem ocupar
--   nenhum dia (ex.: atribuida e retirada no mesmo dia) e mantem-se no historico.
--
-- INVARIANTES (impostas por triggers + indices unicos):
--   * um posto tem no maximo UMA viatura aberta; uma viatura ocupa no maximo UM posto;
--   * atribuir uma viatura a um posto ocupado substitui a anterior (que fica sem posto);
--   * viatura apagada, vendida ou em manutencao nao ocupa nenhum posto (F7, F8).
-- =====================================================================

comment on column slot_assignments.data_inicio is 'Primeiro dia em que a viatura ocupa o posto (inclusivo).';
comment on column slot_assignments.data_fim is 'Fim EXCLUSIVO: dia em que a viatura ja nao esta no posto (nao o ultimo dia em que esteve). NULL = ocupacao em curso.';

-- ---------- viaturas fora de servico libertam o posto (F7, F8) ----------
-- Decisao de produto: vendida e em_manutencao libertam o posto; devolvida (aluguer terminado) NAO liberta (por decidir).
-- Ao voltar a 'ativa' a viatura NAO regressa sozinha ao posto: e atribuida de novo, se for caso disso.
create function app.vehicles_free_slot() returns trigger language plpgsql as $$
begin
  if new.posto_id is not null and (new.deleted_at is not null or new.estado in ('vendida', 'em_manutencao')) then
    new.posto_id := null;   -- o trigger de historico (abaixo) fecha a ocupacao
  end if;
  return new;
end $$;
create trigger vehicles_free_slot before insert or update on vehicles
  for each row execute function app.vehicles_free_slot();

-- ---------- historico: fecha a ocupacao anterior e nunca deixa 2 viaturas no mesmo posto (F6) ----------
create or replace function app.vehicle_slot_history() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if TG_OP = 'INSERT' or new.posto_id is distinct from old.posto_id then
    -- a viatura sai do posto anterior (fim exclusivo = hoje)
    update slot_assignments set data_fim = greatest(data_inicio, app.today()) where vehicle_id = new.id and data_fim is null;
    if new.posto_id is not null then
      -- a viatura que la estava e substituida: fica sem posto (o seu proprio trigger fecha a ocupacao)
      update vehicles set posto_id = null where posto_id = new.posto_id and id <> new.id;
      -- ocupacoes abertas orfas (sem viatura correspondente) tambem fecham
      update slot_assignments set data_fim = greatest(data_inicio, app.today()) where posto_id = new.posto_id and data_fim is null and vehicle_id <> new.id;
      insert into slot_assignments (tenant_id, posto_id, vehicle_id, data_inicio)
      values (new.tenant_id, new.posto_id, new.id, app.today());
    end if;
  end if;
  return new;
end $$;

-- ---------- reparar dados anteriores a estas regras (antes de criar os indices unicos) ----------
-- a) viaturas apagadas / vendidas / em manutencao deixam o posto
update vehicles set posto_id = null
 where posto_id is not null and (deleted_at is not null or estado in ('vendida', 'em_manutencao'));

-- b) postos com mais de uma viatura: fica a que la entrou mais recentemente
with ranked as (
  select v.id,
         row_number() over (
           partition by v.posto_id
           order by coalesce((select max(a.data_inicio) from slot_assignments a where a.vehicle_id = v.id and a.posto_id = v.posto_id and a.data_fim is null), date '1900-01-01') desc,
                    v.created_at desc, v.id) as rn
  from vehicles v where v.posto_id is not null)
update vehicles set posto_id = null where id in (select id from ranked where rn > 1);

-- c) ocupacoes abertas que ja nao correspondem ao posto da viatura
update slot_assignments a set data_fim = greatest(a.data_inicio, app.today())
 where a.data_fim is null
   and not exists (select 1 from vehicles v where v.id = a.vehicle_id and v.posto_id = a.posto_id);

-- d) intervalos invertidos (fim antes do inicio) passam a vazios
update slot_assignments set data_fim = data_inicio where data_fim < data_inicio;

alter table slot_assignments add constraint slot_assignments_intervalo check (data_fim is null or data_fim >= data_inicio);
create unique index slot_assignments_um_aberto_por_posto on slot_assignments (posto_id) where data_fim is null;
create unique index slot_assignments_um_aberto_por_viatura on slot_assignments (vehicle_id) where data_fim is null;
