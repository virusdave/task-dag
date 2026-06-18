-- Down for 093: drop the derived `site` scope columns.
--
-- Reverses migration 093 (automation#51 P2). Dropping the columns
-- discards the best-effort backfilled site scope; re-running the up
-- migration recomputes it deterministically from the still-present
-- campaign_name + ad_group_name, so this is a safe, lossless rollback
-- of derived data.

\set ON_ERROR_STOP on
\timing on

begin;
set local lock_timeout = '5s';

alter table gads_ad_attempts
  drop column if exists site;

alter table landingpage_ad_outcomes
  drop column if exists site;

commit;

\echo 'Migration 093 down complete.'
