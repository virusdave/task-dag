# Helios Target Architecture (2026-05)

## Status

Decision recorded 2026-05-05. Phase 1 of the migration plan landed in the same
pass that wrote this doc. Later phases are sequential and incremental.

## Decision

Helios stays as **one user-facing app** but evolves into a **modular monolith
with strict module manifests** plus **multiple independently-restartable worker
processes split by execution pool**, with a **dedicated singleton Sweed worker**.

### Slogan

> One app for humans, one database for truth, many small workers for isolation.
> Not many services.

### Target shape

```
React 19 + RR7 SPA  →  one Fastify BFF/API  →  TigerData (Postgres)
                                                    │
                       ┌────────────┬───────────────┼────────────┐
                       │            │               │            │
                  worker:sweed  worker:ads  worker:scheduling  worker:system
                  (singleton)
```

- Exactly one user-facing React app, one Fastify BFF, one auth/session context,
  one primary navigation surface (`PrimarySidebar` rendered with `TreeNav`).
- Exactly one TigerData/Postgres schema as system of record. `job_queue` and
  `audit_events` stay platform-owned and global; module-specific snapshot
  tables keep their FKs into the global chain.
- Multiple worker processes split by **execution pool** (not by business
  domain). Each pool process leases only the job types tagged for its pool.
- `worker:sweed` is a **singleton** process. Every Sweed-touching job (Stock
  refresh, Catalog taxonomy refresh, Litalerts competitor refresh, screen
  banner pushes, dealer-context resets, etc.) routes through it AND keeps the
  database-level `concurrency_key='sweed-session'` lane.
- Job metadata carries two orthogonal axes:
  - `module` — the audit / nav / ownership axis (`catalog`, `screens`,
    `pricing`, `communications`, `scheduling`, `config`, future `crm`).
  - `executionPool` — the process-isolation axis (`sweed`, `ads`,
    `scheduling`, `system`).
- A job is, e.g. `module=screens, executionPool=sweed,
  requiresSweedSession=true`.

## Rejected alternatives

| Option | Verdict | Why |
| --- | --- | --- |
| (a) Keep current single monolith unchanged | No | Does not give restart/crash isolation, does not give per-domain ownership, does not address Python migration shape. |
| (b) **Independent backend services sharing Postgres + master/UI service** | **No (worst fit)** | Service boundaries in code/deploys but database coupling everywhere. Cross-service migration coordination, awkward shared ownership of `job_queue`/`audit_events`/Sweed session. More moving parts without real decoupling. |
| (c) **Modular monolith + worker pools** | **Yes** | Best fit for one-operator + LLM-agent team. Preserves single nav/auth/contracts/audit. Gives crash/restart isolation where it matters (workers). Easiest incremental migration path. |
| (d) Event-bus-coordinated services (NATS / Redis / outbox) | No (not now) | Adds infra and eventual consistency. Weakens the simple FK-linked audit model. Only justified at much larger team size or genuinely independent deploy cadences. |

## Hard constraints preserved by this design

- One primary navigation surface (`docs/helios/ui-standards.md`). Per-task
  pages register subtrees via `useRegisterConfigSidebarSubtree`. Never a second
  nav rail.
- Never silently swallow operational failures: failed work persists with
  `status='failed'` AND the job throws.
- Sweed jobs strictly serialize through the `sweed-session` lane; dealer
  context is reset explicitly per job (`automation/AGENTS_MUST_KNOW.md`).
- Audit FKs in TigerData stay queryable across module boundaries:
  - `stock_snapshot_items.snapshot_id`
  - `pending_litalerts_refresh_queue.source_snapshot_id`
  - `litalerts_competitor_observations.queue_row_id` /
    `litalerts_competitor_observations.source_snapshot_id`
- Never use quadratic-or-worse approaches without explicit approval.
- Long-running tmux processes in `helios-dev` (windows 1 Vite, 2 server, 3
  worker) and the unrelated `bulk_additions/catalog_curation/` Vite must be
  left alone.

## How each constraint maps to the design

- **One nav, one auth**: One Fastify BFF and one React SPA shell. Worker
  splitting is invisible to the human-facing surface.
- **`sweed-session` lane**: Two layers of safety. Database `concurrency_key`
  still serializes leases. The dedicated `worker:sweed` process is the only
  process that initializes the shared Sweed session runtime.
- **Zod contracts as single source of truth**: `src/shared/contracts/` stays
  the one boundary. Client, server, and every worker process import from it.
  No duplication across services.
- **FK-linked TigerData audit chain**: Keep `job_queue`,
  `audit_events`, and module snapshot tables in one schema. Domain row +
  audit row + job status transition stay in one DB transaction whenever
  possible.

## UI direction

Keep the React 19 + React Router v7 SPA. Do **not** rewrite to Next, Remix,
SvelteKit, or Astro right now. The dramatic UI improvement comes from:

- Module manifests contributing sidebar subtrees, client routes, server route
  registration, and role gating from one declaration per module.
- A small, standardized page-shell kit:
  - `ModulePageShell`
  - `ReviewWorkspace`
  - `RunHistoryPage`
  - `JobProgressCard`
  - `AuditTimeline`
  - `FilterBar`
- Removing in-page secondary navigation patterns (e.g. `PricingNav`,
  `SchedulingNav`) so the single primary sidebar is the only navigation tree.

## Python migration target

| Current | Target module | Target pool |
| --- | --- | --- |
| `automation/ads/` (Google Ads + Mantle) | `communications` | `worker:ads` |
| `automation/screens/` (Sweed banner clones, refreshes, readbacks) | `screens` | `worker:sweed` |
| `automation/customers/` (segmentation, merges) | new `crm` | `worker:system` (or `crm` later if isolation is needed) |
| One-off utilities | per-module admin actions | `worker:system` |

CLI is only a thin wrapper that enqueues the same TS job. No business logic
in CLI.

## Phased migration plan

- **Phase 1 — foundation (L, ~1–2d)**
  - Declare per-job `executionPool` and `requiresSweedSession` metadata.
  - Pool-to-job-type mapping lives in the job registry.
  - Worker entry process reads a `WORKER_POOL` selector and only leases its
    job types.
  - `npm run dev:worker` defaults to running every pool in one process so the
    operator dev loop is unchanged. A separate supervisor flag splits pools
    when needed without changing the operator's tmux window count.
  - Default everything to `executionPool='system'` initially; explicitly stamp
    the Sweed-touching `config.workers.{stock,catalog,litalerts}_refresh.*`
    jobs and existing `screens.*` jobs as `executionPool='sweed' +
    requiresSweedSession=true`.
- **Phase 2 — isolate Sweed runtime (M, 1–3h scaffold + harden)**
  - Extract Sweed session/dealer-reset code into `platform/sweed`.
  - Run a dedicated singleton `worker:sweed` process in production-shaped
    deployments.
- **Phase 3 — UI architecture cleanup (L, 1–2d structure + incremental)**
  - Module manifests contribute sidebar subtree + client/server routes.
  - Remove module-internal nav strips.
  - Standardize the page-shell kit listed above.
- **Phase 4 — Python migration module by module (XL, ongoing)**
  - Ads first (lowest Sweed coupling), then screens (Sweed-heavy), then
    customers/segmentation.
  - Every migrated flow is visible in `/jobs` and `/history` from day one.
- **Phase 5 — Postgres `LISTEN/NOTIFY` wakeup (S/M, only if needed)**
  - Wakeup optimization for queue polling. Do not let it morph into an
    event-bus rewrite.

## Out of scope

- Microservices.
- Kubernetes or any new orchestration layer.
- Event-bus / message-broker infrastructure.
- A server-rendered framework rewrite.
- Splitting `audit_events` or `job_queue` per module.
