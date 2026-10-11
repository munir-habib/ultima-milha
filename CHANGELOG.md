# Changelog

## v0.1.0 (2026-10-11)
First tagged version, built between 2026-09-19 and 2026-09-24.
- Core app: daily route records, role-based access, multi-tenant isolation with Row Level Security, server-side pricing with versioned tariffs.
- Alerts and Web Push notifications, Excel export, PDF report, goals and dashboard.
- Accounting module: selective validation, versioned automatic entries, fund distribution, grouped and board views, batch actions, "unlinked" allocations.
- Hardening rounds (migrations 0011 to 0023): data integrity, fleet slots, over-allocation checks, audit log, query performance verified with 10,500 movements.
- Rendering in blocks ("Show more"), login entry transition, stronger "Pending" alert in the light theme.
- Test agents with a write guard limited to `qa/`; 44 database tests, 67 unit tests and headless-browser UI tests.

A full copy of the repository at this point is kept in the branch `backup/2026-10-11`.
