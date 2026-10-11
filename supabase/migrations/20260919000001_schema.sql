-- =====================================================================
-- Ultima Milha - schema base (multi-tenant)
-- Regras: nada e apagado fisicamente (deleted_at); audit em tudo (0007).
-- =====================================================================
create schema if not exists app;

create type app_role         as enum ('super_admin','gestor','operador','motorista','contabilista','auditor');
create type record_status    as enum ('rascunho','submetido','validado');
create type vehicle_kind     as enum ('propria','alugada');
create type vehicle_state    as enum ('ativa','devolvida','em_manutencao','vendida');
create type rental_period    as enum ('diario','semanal','mensal');
create type movement_kind    as enum ('debito','credito');
create type movement_state   as enum ('pendente','confirmado');
create type movement_origin  as enum ('automatico','manual_rota','manual_geral');
create type movement_subcat  as enum ('manutencao','deslocacao_equipa','outro','transferencia_distribuicao','custo_automatico');

-- ---------- Tenant, utilizadores ----------
create table tenants (
  id         uuid primary key default gen_random_uuid(),
  nome       text not null,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table profiles (
  id              uuid primary key references auth.users(id) on delete cascade,
  tenant_id       uuid not null references tenants(id),
  nome            text not null,
  email           text not null,
  tema            text not null default 'dark'  check (tema in ('light','dark')),
  idioma          text not null default 'pt'    check (idioma in ('pt','en')),
  manter_sessao   boolean not null default true,
  accounting_read boolean not null default false,  -- Auditor com leitura da Contabilidade
  created_at      timestamptz not null default now(),
  deleted_at      timestamptz                       -- utilizador desativado
);
create index on profiles(tenant_id);

create table user_roles (
  user_id uuid not null references profiles(id) on delete cascade,
  role    app_role not null,
  primary key (user_id, role)
);

create table invitations (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id),
  email           text not null,
  roles           app_role[] not null,
  operation_ids   uuid[] not null default '{}',
  accounting_read boolean not null default false,
  invited_by      uuid references profiles(id),
  created_at      timestamptz not null default now(),
  expires_at      timestamptz not null default now() + interval '14 days',
  accepted_at     timestamptz,
  check (cardinality(roles) > 0),
  check (not ('super_admin' = any(roles)))
);
create unique index invitations_pending_email on invitations (lower(email)) where accepted_at is null;

-- ---------- Operacoes e configuracao ----------
create table operations (
  id                      uuid primary key default gen_random_uuid(),
  tenant_id               uuid not null references tenants(id),
  nome                    text not null,
  -- valor por estado de encomenda (editavel)
  valores_estado          jsonb not null default '{"entregues":0,"devolucoes":0,"recolhas":0,"canceladas":0,"transitadas":0,"pendentes_entrega":0,"pendentes_recolha":0}',
  -- custos fixos gerais
  salario_fixo_mensal     numeric(12,2) not null default 0,
  salario_var_por_entrega numeric(12,4) not null default 0,
  salario_var_pct_receita numeric(6,3)  not null default 0,
  outros_custos_mensais   numeric(12,2) not null default 0,
  created_by              uuid references profiles(id),
  created_at              timestamptz not null default now(),
  deleted_at              timestamptz
);
create index on operations(tenant_id);

-- Operacoes atribuidas (relevante para Gestor / Operador / Motorista / Auditor)
create table user_operations (
  user_id      uuid not null references profiles(id) on delete cascade,
  operation_id uuid not null references operations(id),
  primary key (user_id, operation_id)
);

create table postal_zones (
  id                uuid primary key default gen_random_uuid(),
  operation_id      uuid not null references operations(id),
  nome              text not null,
  prefixos          text[] not null default '{}',
  valor_por_entrega numeric(12,4) not null default 0,
  deleted_at        timestamptz
);
create index on postal_zones(operation_id);

create table routes (
  id                     uuid primary key default gen_random_uuid(),
  operation_id           uuid not null references operations(id),
  nome                   text not null,
  tarifa_por_estado      boolean not null default true,
  tarifa_valor_fixo      boolean not null default false,
  tarifa_por_zona        boolean not null default false,
  tarifa_por_distancia   boolean not null default false,
  valor_fixo_default     numeric(12,2),
  taxa_km                numeric(12,4),
  -- escaloes progressivos: [{"de":0,"ate":50,"valor":0.30},{"de":50,"ate":null,"valor":0.22}]
  escaloes_km            jsonb,
  created_at             timestamptz not null default now(),
  deleted_at             timestamptz
);
create index on routes(operation_id);
create unique index routes_nome_op on routes(operation_id, lower(nome)) where deleted_at is null;

-- Versoes do tarifario (integridade historica): cada mudanca gera uma versao com data de inicio.
create table tariff_snapshots (
  id         uuid primary key default gen_random_uuid(),
  route_id   uuid not null references routes(id),
  valid_from date not null,
  config     jsonb not null,
  created_at timestamptz not null default now(),
  unique (route_id, valid_from)
);

create table goals (
  id           uuid primary key default gen_random_uuid(),
  operation_id uuid not null references operations(id),
  route_id     uuid references routes(id),
  metrica      text not null check (metrica in ('receita','encomendas','margem')),
  alvo         numeric(14,2) not null check (alvo > 0),
  created_at   timestamptz not null default now(),
  deleted_at   timestamptz
);

-- ---------- Frota e motoristas (nivel Tenant - excecao deliberada) ----------
create table fleet_slots (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants(id),
  nome       text not null,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table vehicles (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references tenants(id),
  matricula          text not null,
  tipo               vehicle_kind not null default 'propria',
  posto_id           uuid references fleet_slots(id),
  estado             vehicle_state not null default 'ativa',
  iuc_ativo          boolean not null default false,
  iuc_valor          numeric(12,2) not null default 0,
  seguro_ativo       boolean not null default false,
  seguro_valor       numeric(12,2) not null default 0,
  manutencao_ativo   boolean not null default false,
  manutencao_valor   numeric(12,2) not null default 0,
  aluguer_fornecedor text,
  aluguer_custo      numeric(12,2),
  aluguer_periodicidade rental_period,
  aluguer_data_inicio   date,
  aluguer_data_fim      date,
  created_at         timestamptz not null default now(),
  deleted_at         timestamptz,
  -- aluguer so existe em viaturas Alugadas
  check (tipo = 'alugada' or (aluguer_fornecedor is null and aluguer_custo is null and aluguer_periodicidade is null
                              and aluguer_data_inicio is null and aluguer_data_fim is null))
);
create unique index vehicles_matricula on vehicles(tenant_id, upper(matricula)) where deleted_at is null;

create table slot_assignments (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id),
  posto_id    uuid not null references fleet_slots(id),
  vehicle_id  uuid not null references vehicles(id),
  data_inicio date not null,
  data_fim    date
);
create index on slot_assignments(posto_id);

create table drivers (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants(id),
  nome       text not null,
  contacto   text,
  user_id    uuid references profiles(id),  -- ligacao ao login quando o motorista tem conta
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index on drivers(tenant_id);

-- ---------- Registo diario ----------
create table daily_records (
  id                    uuid primary key default gen_random_uuid(),
  route_id              uuid not null references routes(id),
  data                  date not null,
  status                record_status not null default 'rascunho',
  viatura_id            uuid references vehicles(id),
  motorista_ids         uuid[] not null default '{}',
  km                    numeric(10,2),
  enc_entregues         integer, enc_devolucoes integer, enc_recolhas integer, enc_canceladas integer,
  enc_transitadas       integer, enc_pendentes_entrega integer, enc_pendentes_recolha integer,
  valor_fixo_do_dia     numeric(12,2),
  incluir_entregas      boolean not null default true,
  entregas_por_zona     jsonb not null default '{}',
  comb_litros           numeric(10,2),
  comb_valor            numeric(12,2),
  comb_tipo             text,
  portagens_valor       numeric(12,2),
  -- calculado no servidor com o tarifario em vigor na data (nunca recalculado retroativamente)
  receita_breakdown     jsonb not null default '{}',
  receita_total         numeric(14,2) not null default 0,
  tarifa_valid_from     date,
  created_by            uuid references profiles(id),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  validado_por          uuid references profiles(id),
  validado_em           timestamptz,
  deleted_at            timestamptz,
  check (coalesce(enc_entregues,0) >= 0 and coalesce(enc_devolucoes,0) >= 0 and coalesce(enc_recolhas,0) >= 0
     and coalesce(enc_canceladas,0) >= 0 and coalesce(enc_transitadas,0) >= 0
     and coalesce(enc_pendentes_entrega,0) >= 0 and coalesce(enc_pendentes_recolha,0) >= 0
     and coalesce(km,0) >= 0)
);
create unique index daily_records_route_day on daily_records(route_id, data) where deleted_at is null;
create index on daily_records(data);
create index on daily_records(created_by);

create table daily_record_costs (
  id           uuid primary key default gen_random_uuid(),
  record_id    uuid not null references daily_records(id),
  categoria    text not null,
  valor        numeric(12,2) not null,
  descricao    text,
  movimento_id uuid,   -- FK abaixo (copia inicial, nao referencia viva)
  created_by   uuid references profiles(id),
  created_at   timestamptz not null default now(),
  deleted_at   timestamptz
);
create index on daily_record_costs(record_id);

-- ---------- Contabilidade (transversal ao Tenant) ----------
create table bank_accounts (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants(id),
  nome       text not null,
  banco      text,
  iban       text,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table movements (
  id                       uuid primary key default gen_random_uuid(),
  tenant_id                uuid not null references tenants(id),
  data                     date not null,
  conta_id                 uuid not null references bank_accounts(id),
  tipo                     movement_kind not null,
  valor                    numeric(14,2) not null check (valor > 0),
  operation_id             uuid references operations(id),   -- NULL = categoria "Outro"
  subcategoria             movement_subcat not null,
  pessoa_responsavel       text,
  lancamento_referencia_id uuid references movements(id),
  rota_id                  uuid references routes(id),
  motorista_id             uuid references drivers(id),
  descricao                text,
  estado                   movement_state not null default 'pendente',
  origem                   movement_origin not null,
  created_by               uuid references profiles(id),
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  deleted_at               timestamptz,
  check (origem <> 'manual_geral' or operation_id is null),
  check (origem <> 'manual_rota'  or operation_id is not null),
  check (rota_id is null or operation_id is not null)
);
create index on movements(tenant_id, data);
create index on movements(lancamento_referencia_id);
alter table daily_record_costs add foreign key (movimento_id) references movements(id);

-- ---------- Notificacoes, audit ----------
create table notifications (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants(id),
  user_id    uuid not null references profiles(id),
  tipo       text not null,
  payload    jsonb not null default '{}',
  lido_em    timestamptz,
  created_at timestamptz not null default now()
);
create index on notifications(user_id, created_at desc);

create table push_subscriptions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references profiles(id),
  endpoint   text not null unique,
  keys       jsonb not null,
  created_at timestamptz not null default now()
);

create table audit_log (
  id         bigint generated always as identity primary key,
  tenant_id  uuid,
  tabela     text not null,
  registo_id text,
  acao       text not null,           -- INSERT / UPDATE / SOFT_DELETE / DELETE
  user_id    uuid,
  em         timestamptz not null default now(),
  antes      jsonb,
  depois     jsonb
);
create index on audit_log(tenant_id, em desc);
create index on audit_log(tabela, registo_id);
