-- Down for 070: drop the lp_events sink.
--
-- lp_events is an append-only analytics sink for the unified-landing
-- engine (FreshlyBakedNYC/automation#42 / virusdave/top-level#13).
-- Dropping it discards captured landing-page telemetry; the
-- mostly-static-sites runtime's durable local spool is the only other
-- copy in flight, so only drop this in a teardown/rollback of the
-- whole P1 ingest.

\set ON_ERROR_STOP on
\timing on

begin;
set local lock_timeout = '5s';

drop table if exists lp_events;

commit;

\echo 'Migration 070 down complete.'
