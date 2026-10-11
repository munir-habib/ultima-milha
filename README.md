# Última Milha

Multi-tenant, mobile-first PWA to run last-mile delivery operations: daily route records, server-side pricing, accounting, fleet costs, alerts and reporting. Built with AI-assisted (agentic) development and verified with an automated test suite.

> Documentação técnica completa em português: [README.pt.md](README.pt.md)

## Stack

React · TypeScript · Vite · Tailwind CSS 4 · Supabase (PostgreSQL, Auth, Row Level Security, Edge Functions, pg_cron) · TanStack Query · react-i18next (PT/EN) · ExcelJS · Recharts · PWA with Web Push

## What it does

- **Daily records** with automatic draft saving and a Draft → Submitted → Validated workflow enforced on the server.
- **Server-side pricing:** revenue is calculated by database triggers using the tariff in force on the record date and is never recalculated, so history stays intact when prices change.
- **Multi-tenant isolation** per operation and tenant, enforced by Row Level Security in the database, not only in the UI.
- **Role-based access:** Super Admin, Manager, Operator, Driver, Accountant and Auditor, each with different permissions.
- **Accounting module:** automatic and manual entries, selective validation, fund allocation, versioning and immutable audit log (no physical deletes).
- **Alerts and notifications:** in-app and Web Push, plus a daily scheduled job (pg_cron).
- **Excel export, PDF report, dark and light themes, Portuguese and English.**

## Engineering practices

| Area | Detail |
|---|---|
| Database | 23 versioned SQL migrations, RLS policies, triggers, audit trail |
| Edge Functions | `invite-user`, `send-push` (Deno) |
| Automated tests | 44 database tests on real Postgres (PGlite), 67 unit tests, headless-Chrome UI tests, plus checks against the live Supabase project |
| Quality rules | No hardcoded text (checked by tests), colours only through design tokens, rules documented in `CLAUDE.md` |
| AI workflow | Specification-driven development with Claude Code, project rules and test sub-agents in `.claude/` |

## Project map

🟦 app (frontend) · 🟩 database and backend · 🟧 tests and scripts · 🟪 AI workflow · ⬜ config and assets

| | Folder | What is in it |
|---|---|---|
| 🟦 | `src/` | React app: `pages`, `components`, `auth`, `i18n` (PT/EN), `lib`, service worker for the PWA |
| 🟩 | `supabase/migrations/` | 23 versioned SQL migrations: schema, RLS, triggers, audit, accounting rules |
| 🟩 | `supabase/functions/` | Edge Functions: `invite-user`, `send-push` |
| 🟧 | `supabase/tests/` | Database tests on real Postgres (PGlite): rules and RLS |
| 🟧 | `qa/` | QA scenarios run by the test sub-agents against a Supabase project (you need your own) |
| 🟧 | `scripts/` | Seed, end-to-end checks, UI tests, test-user helper |
| 🟪 | `.claude/` and `CLAUDE.md` | Project rules for Claude Code, test sub-agents and a write-guard hook |
| ⬜ | `public/` and root files | PWA icon, Vite, TypeScript and package configuration |

<!-- Demo: add your screenshots to docs/screenshots/ and uncomment.
## Demo
![Home](docs/screenshots/home.png)
[Watch the video](https://youtu.be/...)
-->

## Run locally

```bash
npm install
cp .env.example .env   # add your Supabase URL and anon key
npm run dev
```

See [README.pt.md](README.pt.md) for Supabase setup, test commands and the list of business rules.

## License

Copyright (c) 2026 Munir Habib. All rights reserved. The source code is public for portfolio review only; see [LICENSE](LICENSE).
