# Helios admin: pending-migrations page with worker-driven "Apply Now"

Design for [automation#62](https://github.com/FreshlyBakedNYC/automation/issues/62).
Status: **design (Oracle-reviewed)** — this is the mandated pre-implementation
design + Oracle review for a web-triggered production schema mutation. It fixes
the mechanism (A: enqueue a job) and the gating/safety model so the
implementation leaves can proceed. It does **not** itself mutate prod.

> Scope note: this doc is the deliverable of the epic's first (design) task.
> The remaining tasks (see [Task decomposition](#task-decomposition-oracle-reviewed-split)
> below: lifecycle schema, runtime artifact plumbing, worker apply engine,
> read API, enqueue API, SPA page, banner retire, first real apply of `097`)
> are separate frontier leaves that depend on it. Each still owes its own
> Oracle **diff** review before landing, and the first real prod apply (`097`)
> still owes a per-migration Oracle blessing + explicit operator approval at
> apply time (canon `rules/DB_PERFORMANCE.md` steps 3–7).

## Problem

Helios detects unapplied SQL migrations with a hand-curated sentinel registry
([`pendingMigrations.ts`](../../../helios/src/server/db/pendingMigrations.ts))
and surfaces them in an all-pages banner
([`PendingMigrationsBanner.tsx`](../../../helios/src/client/components/PendingMigrationsBanner.tsx)).
Today the banner hands the operator a copy-paste `psql -f …` line
(`makeApplyCommand`). That contradicts the operator directive and canon
`rules/DB_PERFORMANCE.md` step 5 ("**the agent applies the approved
migration** — not an operator chore"). We want an admin-only page that lists
pending migrations and applies a chosen one via a **reliable, fast,
worker-driven** path, then retire the copy-paste from the banner.

## Key constraints discovered (these drive the design)

1. **Migration artifacts are psql scripts, not plain SQL.** 122 of the
   migration/`.down` files use psql client meta-commands (`\set`, `\echo`,
   `\timing`), and 25 use `\i` / `\ir` includes that pull in
   `src/server/db/schema/*.sql`. The node `pg` driver **cannot** execute these
   — only the `psql` binary can. Canon also requires running "the exact
   reviewed migration artifact … never ad-hoc SQL", which rules out a
   home-grown meta-command preprocessor. **⇒ the apply path must shell out to
   `psql -f <file>`.**

2. **`psql` is present on the prod host** (`/run/current-system/sw/bin/psql`,
   PG 17) but is **not** declared in Helios's own nix closure
   ([`flake.nix`](../../../flake.nix) only pins `nodejs_22`). Relying on
   ambient PATH is fragile. **⇒ add `postgresql`/`psql` to the Helios runtime
   closure** so `helios-worker` deterministically has it.

3. **`.sql` files are not shipped to `dist/`.** `build:server` runs `tsc` +
   copies a single JS asset; the migration/schema `.sql` files stay in `src/`.
   The deployed worker runs from `dist/` (`node dist/worker/main.js`), so it
   currently cannot see the artifacts. **⇒ the build must copy
   `src/server/db/migrations/**` and `src/server/db/schema/**` into `dist/`,
   and the runtime must resolve the migration path relative to the compiled
   module (`import.meta.url`), preserving the `\ir ../schema/...` relative
   layout.**

4. **A mature job queue already exists** (`job_queue`) with a **fastlane**
   lease loop for `priority >= JOB_PRIORITY_URGENT (1000)` plus a `NOTIFY`
   wakeup, and a ready-made **job-status polling** surface
   (`GET /api/jobs/:jobId`, `loadJobStatus`, `isJobTerminal`, and the
   `JobDetailPage` polling pattern). **⇒ enqueue-a-job (mechanism A) is both
   the most auditable and, via fastlane+NOTIFY, effectively as fast as an
   inline apply.**

## Decision: Mechanism A (enqueue an urgent `job_queue` job)

The issue offered A (enqueue a task-dag/queue job), B (per-apply ops epic), C
(direct server-side apply). The operator said "how the button works almost
doesn't matter, reliable and fast". We choose **A on the existing `job_queue`**:

| Axis | A: urgent job_queue job (chosen) | C: inline server apply |
| --- | --- | --- |
| Latency | fastlane (`priority=URGENT`) + `NOTIFY` ⇒ near-instant pickup | instant |
| Long migrations (`CREATE INDEX CONCURRENTLY`, minutes) | runs in worker, off the web request | blocks a web request thread; risks proxy timeout |
| Auditability | `job_queue` row (`requested_by_user_id`, timestamps, `last_error`) + audit event + attempt record | none unless hand-built |
| Retry / dead-letter | built in | none |
| Live progress UI | reuse `GET /api/jobs/:jobId` polling as-is | must hand-build |
| Credential isolation | worker already holds DB creds + runs where `psql` lives | web tier gains a shell-to-psql path |

A wins on every axis except a marginal latency edge that fastlane+`NOTIFY`
erases. B is heavier for no added benefit here.

## Architecture

```diagram
 Admin browser                Helios server (fastify)              Helios worker (fastlane)
╭───────────────╮  POST     ╭────────────────────────────╮  NOTIFY ╭──────────────────────────╮
│ /config/      │──apply───▶│ /api/admin/pending-         │────────▶│ db.migration.apply       │
│  pending-     │  {id}     │   migrations/:id/apply      │ job_queue│  handler:                │
│  migrations   │           │  • requireSessionUser admin │  (URGENT)│  1 validate id∈registry  │
│  (Apply Now)  │◀──jobId───│  • assert eligible (blessed)│         │  2 resolve dist .sql path │
│               │           │  • dedupe: 1 live apply/id  │         │  3 execFile psql -f (argv)│
│  poll ───────────GET──────▶│ /api/jobs/:jobId           │         │  4 live sentinel re-check │
│  status       │◀──status──│  (existing)                 │         │  5 record attempt + audit │
╰───────────────╯           │ /api/admin/pending-         │         │  success only if sentinel │
                            │   migrations (list+status)  │         │   flips to applied        │
                            ╰────────────────────────────╯         ╰──────────────────────────╯
```

## Data model

- **New job type** `db.migration.apply` with payload
  `{ migrationId: string, requestedByUserId: number, confirmMigrationId:
  string, blessingArtifactSha256: string }`. Enqueued at `JOB_PRIORITY_URGENT`
  with `dedupeKey = "migration-apply:<migrationId>"` (the existing
  `job_queue_active_dedupe_unique` partial index guarantees at most one
  `queued|running` apply per migration ⇒ idempotent enqueue) and
  `concurrencyKey = "migration-apply"` (serialize applies fleet-wide, so two
  migrations never race the schema at once). **This job is single-attempt for
  anything after `psql` has started** (see safety §, item on retries): the
  worker must not let the default `WORKER_MAX_ATTEMPTS=5` re-run a
  partially-applied DDL.

- **New lifecycle table** `migration_apply_attempts` (row-per-attempt, updated
  through its states — *not* strictly append-only; the immutable event log is
  `audit_events`). A row is **inserted `running` before `psql` launches**, then
  transitioned to a terminal state: `succeeded`, `failed`, `already_applied`
  (live sentinel already true ⇒ no-op success, psql never run), `blocked_lock`
  (advisory lock unavailable), or `dead_letter/abandoned` (crash / ambiguous
  process death). Columns / `context_json`: `id`, `migration_id`, `job_id`
  (FK `job_queue`), `requested_by_user_id`, `confirm_migration_id`,
  `blessing_ref`, `artifact_sha256` (of the resolved dist artifact + its `\i`/
  `\ir` include closure), `deployed_build_id` (if available), `psql_path`,
  `psql_version`, `redacted_command`, `transaction_mode`
  (`transactional | nontransactional-cic | mixed`), `advisory_lock_acquired`,
  `sentinel_before`, `sentinel_after` (bool, both **live**, cache bypassed),
  `psql_exit_code`, `psql_signal`, `stdout_tail`/`stderr_tail` (bounded +
  redacted), `error_message`, `started_at`, `finished_at`. This satisfies
  canon step 7. (The table is itself a normal Helios migration
  `NNN_migration_apply_attempts.sql` + `.down` + sentinel — bootstrapped once
  via the current manual path, then the feature is self-hosting.)

- **Gating metadata lives in the registry, in git, bound to the artifact.**
  Extend each `MigrationSentinel` with a **required-for-eligibility** blessing:
  `blessing?: { ref: string; reviewedSha: string; artifactSha256: string;
  transactionMode: 'transactional'|'nontransactional-cic'|'mixed'; note?:
  string }`. `artifactSha256` is a digest over the main migration file **plus
  its `\i`/`\ir` include closure** — the real reviewed unit — so a later edit
  to a shared `schema/*.sql` include invalidates the blessing rather than
  silently running unblessed SQL. The Oracle blessing every migration already
  needs (canon step 3) is recorded here by the author when it lands, so
  provenance is version-controlled, not a mutable DB flag. A migration is
  **apply-eligible** iff it is (live) pending **and** has a complete `blessing`
  **and** the deployed artifact's recomputed digest matches
  `blessing.artifactSha256`.

## Gating / safety model (issue safety req #1)

1. **Admin-gated (server-enforced).** Both the list API and the apply API call
   `requireSessionUser(request, reply, 'admin')`; the SPA page also
   client-guards and hides "Apply Now" for non-admins (defense in depth; the
   server is the real gate). Mutating `/api/*` already passes the origin/CSRF
   gate in `buildServer.ts`.
2. **Oracle-blessing + artifact digest is a hard prerequisite.** "Apply Now"
   is disabled unless the registry entry has a complete `blessing` **and** the
   runtime-recomputed artifact-closure digest matches `blessing.artifactSha256`.
   The apply endpoint AND the worker both re-check and refuse (`409` / terminal
   failure) otherwise. Oracle blessing ≠ approval.
3. **Operator approval = the admin click, server-validated.** The UI requires
   type-to-confirm; the POST body carries `confirmMigrationId` and the server
   rejects unless it exactly equals the path `:id`. The endpoint records
   `requested_by_user_id`. This deliberate action is the "operator go".
4. **Exact artifact only, hardened path + invocation.** The worker never
   accepts SQL from the client. The registry maps the validated `migrationId`
   (allowlisted) to a committed filename; the resolver enforces: id ∈ registry,
   filename matches a conservative `NNN_[a-z0-9_]+\.sql` pattern, `realpath` is
   under the deployed `dist/server/db/migrations` root, and **every include in
   the artifact closure resolves under the deployed DB artifact root** (fail
   closed otherwise). Eligible migrations must use `\ir` (resolves relative to
   the script), or `psql` is run with `cwd` set to the migration dir to make
   `\i ../schema/...` resolve; verified from the dist layout. Invocation uses
   `spawn` (bounded/streamed stdout+stderr, no `execFile` `maxBuffer` kill),
   **no shell**, a closure-resolved absolute `psql` path,
   `-X --no-psqlrc -v ON_ERROR_STOP=1 -f <abs>`,
   `application_name=helios-migration-apply:<id>:job:<jobId>`, and DB
   connection via parsed `PG*` env (`PGHOST/PGPORT/PGDATABASE/PGUSER/
   PGPASSWORD/PGSSLMODE`) rather than a URL in argv. Credentials never logged.
5. **Exclusive, non-double-run execution.** Before running, the handler takes a
   session-level `pg_try_advisory_lock(<fixed key>)` on a dedicated pool
   connection held for the whole `psql` child lifetime (defends against stale
   leases, duplicate jobs, and future queue changes — `concurrencyKey` alone is
   insufficient because an expired 5-min lease could be reclaimed mid-apply).
   The handler **heartbeats/extends `leased_until`** while `psql` runs so the
   row is not reclaimed. If the advisory lock can't be acquired, record
   `blocked_lock` and stop.
6. **Transaction handling per canon.** Migration files that wrap their own
   `begin;`/`commit;` (e.g. `097`) run atomically; files with
   `CREATE INDEX CONCURRENTLY` must not be wrapped — psql `-f` runs each
   statement as authored, so we defer to the file's own structure (recorded as
   `transaction_mode` from the blessing) and note the non-transactional
   exception in the attempt record.
7. **Live sentinel verification (canon step 6), cache bypassed.** Eligibility
   and verification bypass the ~30s `getPendingMigrations` cache. Handler flow:
   (a) live sentinel *before*; (b) if already applied ⇒ record
   `already_applied` no-op success, never run psql; (c) if pending ⇒ run exact
   artifact; (d) live sentinel *after*; (e) succeed **iff** the live sentinel
   verifies applied. After every attempt (success or fail) invalidate the
   pending-migrations cache so the UI/banner don't invite a duplicate click for
   30s. (Blessing review must confirm the sentinel truly represents the
   migration's end-state; a migration with a non-representative sentinel is not
   eligible.)
8. **Retry discipline (issue safety req #4).** Auto-retry is allowed **only**
   for pre-apply infrastructure failures where no DDL ran (can't lease advisory
   lock, can't resolve/verify artifact, `psql` missing). Any failure **after
   `psql` starts** — nonzero exit, signal, sentinel mismatch, ambiguous death —
   is **terminal/non-retryable** and requires a fresh admin click after review.
   Forward SQL remains authored idempotent (`IF NOT EXISTS`, guarded `DO $$`),
   so that fresh click safely re-runs.
9. **Full lifecycle recorded (canon step 7).** `audit_events` is the immutable
   event log ("requested", "started", "finished/failed"); the
   `migration_apply_attempts` row carries the structured record (who/when,
   blessing ref, artifact digest, redacted command, txn mode, advisory-lock,
   psql path/version, exit/signal, bounded redacted output, live sentinel
   before/after, confirm id).

## API contract (in `shared/contracts`)

- `GET /api/admin/pending-migrations` → `{ migrations: [{ migrationId, label,
  sentinelState: 'pending'|'applied', eligible: boolean, ineligibleReason:
  string|null, blessing: {ref,note,transactionMode}|null, artifactDigestMatch:
  boolean, lastAttempt: { jobId, state, error, startedAt, finishedAt,
  requestedBy } | null }] }` (sentinel/eligibility computed **live**).
- `POST /api/admin/pending-migrations/:id/apply` body `{ confirmMigrationId }`
  → validates id ∈ registry, `confirmMigrationId === id`, eligible (blessing +
  live digest match), still (live) pending; enqueues the URGENT job; returns
  `{ jobId }`. `409` if not eligible / already applied; the dedupe index means
  a repeat click while one is in flight returns the in-flight `jobId`.
- Live progress reuses the existing `GET /api/jobs/:jobId`.
- Optional (nice-to-have): `POST /api/admin/pending-migrations/:id/preflight`
  — validates eligibility, artifact digest, psql availability, and advisory-lock
  availability **without executing SQL** (explicitly not a SQL dry-run).

## SPA page (`/config/pending-migrations`, admin-only)

Follows [`helios/AGENTS.md`](../../../helios/AGENTS.md): the table is the whole
page, tight chrome, methodology/notes collapsed. One row per pending migration:
id, label, sentinel state, eligibility/blessing, last attempt + result, and an
**Apply Now** button (disabled unless eligible) with a type-to-confirm. On
click it POSTs, then polls `GET /api/jobs/:jobId` (reusing
`loadJobStatus`/`isJobTerminal`, 1.5 s like `JobDetailPage`) to show live
running → success (sentinel now applied; row drops) / failure (error surfaced,
safe to retry).

## Banner retirement

`PendingMigrationsBanner` stops rendering the `psql` copy-paste; instead it
deep-links to `/config/pending-migrations` ("Review & apply pending
migrations"). `makeApplyCommand` / `PendingMigration.applyCommand` are removed
from the client-facing session envelope surface (kept only if some non-UI
consumer needs it — confirmed none do). The banner stays visible to all users
as a drift warning, but the apply action lives behind the admin page.

## Rollout / ordering (canon "apply vs deploy ordering")

The `migration_apply_attempts` table is additive (new table) and its migration
is applied first (via the current manual/canon path — the feature can't apply
its own bootstrap), verified via sentinel, then the code that reads/writes it
deploys — the standard expand-then-deploy order. The apply feature itself is
additive and admin-only; no old/new schema hazard. The very first real use of
the button (`097`) is a separate operator-approved leaf.

## Task decomposition (Oracle-reviewed split)

Leaf 2 was deliberately split so the risky prod-mutation engine gets isolated
review/rollback. The epic breaks into (dependencies in parens):

1. **Design + Oracle review** — this doc. *(done)*
2. **Lifecycle schema bootstrap** — `NNN_migration_apply_attempts.sql` + `.down`
   + sentinel, applied via the current manual/canon path. No button, no
   execution. (dep 1)
3. **Runtime artifact plumbing** — add `psql` to Helios's nix closure; copy
   `src/server/db/migrations/**` + `src/server/db/schema/**` into `dist/`;
   artifact resolver + `realpath`/allowlist checks + `\i`/`\ir` include
   handling + artifact-closure digest; unit tests with fixture SQL. (dep 1)
4. **Worker apply engine (no public button yet)** — `db.migration.apply` job
   type + payload; handler with advisory lock, lease heartbeat, single-attempt/
   non-retryable post-psql behavior, bounded/redacted psql output, live
   sentinel bypass + cache invalidation, `migration_apply_attempts` write, and
   a fake-psql/test harness that never touches prod. (dep 2, 3)
5. **Admin read/list API** — `GET /api/admin/pending-migrations` (live sentinel,
   eligibility/blessing, artifact digest match, last attempt) + auth tests.
   (dep 4)
6. **Admin enqueue API** — `POST …/:id/apply` with server-side `confirmMigrationId`,
   admin + origin/CSRF coverage, live eligibility re-check, dedupe→in-flight
   jobId; tests. (dep 5)
7. **SPA admin page** `/config/pending-migrations` — table, Apply Now,
   type-to-confirm, `GET /api/jobs/:id` polling, failure surfacing. (dep 6)
8. **Retire banner psql copy-paste** — deep-link to the admin page; drop
   `makeApplyCommand`/`applyCommand` from the client surface. (dep 7)
9. **First real apply of `097_litalerts_parse_feedback`** — its own per-migration
   Oracle blessing (+ `artifactSha256`) and explicit operator approval at apply
   time; apply via the button; verify live sentinel; Agent Gate Record. (dep 7)

Every implementation leaf (2–8) owes an Oracle **diff** review before landing;
leaf 9 owes a per-migration Oracle blessing + operator approval at apply time.
Minimum test coverage across the leaves: path allowlisting, digest-mismatch
refusal, psql argv/env redaction, cached-vs-live sentinel behavior, enqueue
dedupe→in-flight, auth/CSRF, and a fake long-running psql exercising lease
heartbeat + advisory lock.

## Explicitly out of scope (from the issue)

Auto-applying on deploy/boot; web-triggered `down`/rollback; changing the
manual/sentinel migration model itself.
