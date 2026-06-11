-- Down for 073: drop the scheduled_publish_at column from seo_posts.
--
-- Removes the auto-blog scheduling field (FreshlyBakedNYC/automation#44 /
-- virusdave/top-level#15, P4 follow-on). Dropping it discards any pending
-- release schedules; approved posts then export immediately again. Only do
-- this in a rollback of the scheduling slice.

\set ON_ERROR_STOP on
\timing on

begin;
set local lock_timeout = '5s';

alter table seo_posts
  drop column if exists scheduled_publish_at;

commit;

\echo 'Migration 073 down complete.'
