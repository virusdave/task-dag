-- Down for 076: drop the GA4/GSC metric-import tables.
--
-- Removes the SEO feedback-loop ingest data model (P5 first slice;
-- FreshlyBakedNYC/automation#44 / virusdave/top-level#15). Dropping these
-- discards all imported Search Console / GA4 daily facts and import
-- provenance; only do this in a rollback of the P5 ingest slice. The data
-- is re-importable from the operator's original export files.

\set ON_ERROR_STOP on
\timing on

begin;
set local lock_timeout = '5s';

-- Fact tables reference the batch table, so drop them first.
drop table if exists seo_gsc_daily;
drop table if exists seo_ga4_daily;
drop table if exists seo_metric_import_batches;

commit;

\echo 'Migration 076 down complete.'
