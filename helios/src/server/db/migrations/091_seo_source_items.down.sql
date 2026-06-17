-- Down for 091: drop the SEO source-ingestion tables.
--
-- seo_source_items + seo_source_allowlist are the Helios-side auto-blog
-- source-intake brick (FreshlyBakedNYC/automation#44 / virusdave/top-level#15,
-- P4). Dropping them discards all recorded source items and the approved-
-- source allowlist; only do this in a full teardown/rollback of the source-
-- ingestion brick. Drop the child table first (it FKs the allowlist).

\set ON_ERROR_STOP on
\timing on

begin;
set local lock_timeout = '5s';

drop table if exists seo_source_items;
drop table if exists seo_source_allowlist;

commit;

\echo 'Migration 091 down complete.'
