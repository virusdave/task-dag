-- Down-migration for 088_gads_lp_rollup_dq.sql.
-- Drops the two data-quality counter columns from the singleton
-- gads_lp_rollup_refresh_state row. Safe: they are pure observability
-- fields, fully recomputed by the refresh job from lp_events.

\set ON_ERROR_STOP on
\echo 'Reverting migration 088: gads_lp_rollup_refresh_state DQ counters...'

alter table gads_lp_rollup_refresh_state
  drop column if exists assignments_missing_id,
  drop column if exists unattributed_stage_events;

\echo 'Migration 088 reverted.'
