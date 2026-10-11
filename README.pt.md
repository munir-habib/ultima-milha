# Última Milha

Gestão de operações de entregas de última milha. Mobile-first, multi-tenant, PWA.
React + Vite + Tailwind 4 · Supabase (Postgres + Auth + RLS + Edge Functions) · react-i18next (PT/EN).

## Arrancar

```bash
npm install
cp .env.example .env        # VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, VITE_VAPID_PUBLIC_KEY
npm run dev
```

### Supabase (já feito no projeto ERP Last Mile)
1. `npx supabase login` + `npx supabase link --project-ref <ref>`
2. `npx supabase db push` — aplica `supabase/migrations/*.sql` (0001–0023)
3. Edge Functions: `npx supabase functions deploy invite-user --use-api` e `npx supabase functions deploy send-push --use-api --no-verify-jwt`
4. Segredos (push): `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`, `PUSH_WEBHOOK_SECRET` (`npx supabase secrets set …`)
5. Trigger de push → função: linhas `push_url` e `push_secret` na tabela `app.config` (o segredo fica só na BD, nunca no git)
6. Auth → Providers: Email com *Confirm email* ligado (impede reclamar convites de terceiros); Google opcional
7. Auth → URL Configuration: adicionar o URL da app aos Redirect URLs

Alertas diários: `pg_cron` executa `app.run_alerts()` às 20:00 UTC (job `um-alerts`).

## Testes

| Comando | O que verifica |
|---|---|
| `npm run test:db` | 44 testes das migrações em Postgres real (PGlite): RLS por papel, tarifário, workflow, audit, alertas, regras da Contabilidade, endurecimento (referências, origem, frota, snapshots, sobre-alocação) e um teste de **atualização** 0010→0023 com dados sujos |
| `npm test` | 67 testes: analytics, lógica da Contabilidade (totais, agrupado, quadro), acessos, export e cobertura de traduções PT/EN |
| `npm run typecheck` | TypeScript |
| `npm run check:real` | 11 verificações contra o projeto Supabase real (login, RLS, consultas da app, audit, funções) |
| `npm run test:ui` | UI real em Chrome headless (precisa de `npm run dev -- --port 5199`): 3 sessões (desktop escuro, mobile, desktop claro), 7 ecrãs cada, fluxo do registo diário; capturas em `.shots/` |
| `npm run test:ui:accounting` | checklist da Contabilidade em UI real (contorno vermelho, validar, agrupado, quadro por arrasto, mobile por toque) |
- `npm run test:ui:transition` — transição de entrada (login → app): sequência completa, mobile/desktop, ambos os temas, «reduzir movimento»
| `npm run seed` | dados de exemplo (30 registos, 2 operações, frota, contabilidade, metas) — retomável; precisa de `DEMO_PASSWORD` no `.env` e de um utilizador demo criado com `scripts/test-user.mjs` |

## Funcionalidades

Registo diário com rascunho automático · receita calculada no servidor com o tarifário em vigor na data (nunca recalculada) ·
Rascunho → Submetido → Validado · Dashboard (filtros, KPIs, tendência, metas, seletor de custos) ·
Frota (custos independentes, postos com histórico) ·
Contabilidade (lançamentos automáticos versionados, validação seletiva, distribuição de fundos com propagação diferida, vistas Lista / Por validar / Agrupado / Quadro) ·
Notificações in-app + push · Exportação Excel (`Operacao_AAAA-MM-DD.xlsx`, `Contabilidade_AAAA-MM-DD.xlsx`) ·
Relatório PDF (página de relatório + "Guardar como PDF" do browser) · PT/EN · tema claro/escuro por utilizador.

## Onde estão as regras não-negociáveis

| Regra | Onde |
|---|---|
| Isolamento por Operação/Tenant (RLS) | `migrations/…_rls.sql`, `…_helpers.sql` |
| Receita gravada com o tarifário da data do registo | `…_tariff.sql` (versões) + `…_records_logic.sql` (trigger) |
| Nunca apagar fisicamente; audit antes/depois | `…_audit.sql` (DELETE bloqueado, `audit_log` imutável) |
| Rascunho → Submetido → Validado | `…_records_logic.sql` |
| Alertas e push | `…_alerts_push.sql`, `functions/send-push` |
| Contabilidade: validação seletiva, versionamento, propagação diferida, motivo ao apagar | `…_accounting_rules.sql`, `…_guard_reclassify.sql`, `src/lib/accounting.ts` |
| Nenhum texto hardcoded | `src/i18n/{pt,en}.json` (verificado por `npm test`) |
| Cores só por tokens | `src/index.css` |
