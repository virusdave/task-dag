-- Migration 088: gads_lp_rollup_refresh_state data-quality counters
--
-- GAds → Landing-pages analytics V1, phase P3 (parent epic
-- virusdave/top-level#18, child FreshlyBakedNYC/automation#47).
-- Authoritative design: docs/epics/gads-landing-analytics/EPIC_PLAN.md
-- (top-level) §3 + child EPIC_PLAN P3; locked semantics:
-- docs/helios/gads-landing-analytics/P0_AUDIT.md.
--
-- WHY: P3 requires the serving endpoint to read ONLY the rollup + the
-- refresh-state row, never raw lp_events (parent §3 / migration 087
-- header / the operator's DB-cost steer, epic #11). The V1 response
-- contract carries two data-quality counters (assignments_missing_id,
-- unattributed_stage_events) that are inherently lp_events-level
-- observations. To keep them WITHOUT putting an lp_events scan back on
-- the serving path, the out-of-band refresh job records them onto the
-- singleton refresh-state row each run; the serving endpoint reads them
-- from there. They are an as-of-last-refresh, horizon-scoped snapshot
-- (not per-request-window) — honest and clearly badged, consistent with
-- "reasonably accurate, not accounting".
--
-- Idempotent + cheap: two nullable-with-default integer columns on a
-- single-row table; backfilled to 0 (the refresh job overwrites them on
-- its next tick). Reversible via 088_gads_lp_rollup_dq.down.sql.

\set ON_ERROR_STOP on
\echo 'Running migration 088: gads_lp_rollup_refresh_state DQ counters...'

alter table gads_lp_rollup_refresh_state
  add column if not exists assignments_missing_id   integer not null default 0,
  add column if not exists unattributed_stage_events integer not null default 0;

\echo 'Migration 088 complete.'
