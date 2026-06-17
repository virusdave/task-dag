-- Down for 092: drop the SEO auto-blog prompt-schedule config table.
--
-- seo_prompt_schedules is the Helios-side auto-blog prompt-schedule +
-- topic-mix CONFIG (FreshlyBakedNYC/automation#44 / virusdave/top-level#15,
-- P4). Dropping it discards all operator-authored generation schedules; only
-- do this in a full teardown/rollback of the prompt-schedule slice. No other
-- table references it.

\set ON_ERROR_STOP on
\timing on

begin;
set local lock_timeout = '5s';

drop table if exists seo_prompt_schedules;

commit;

\echo 'Migration 092 down complete.'
