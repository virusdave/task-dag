-- Down for 077: drop the SEO recommendation-engine table.
--
-- Removes the GA4/GSC feedback-loop recommendation queue (P5;
-- FreshlyBakedNYC/automation#44 / virusdave/top-level#15). Dropping it
-- discards all open/accepted/dismissed recommendations; the drafts an
-- accepted recommendation already spawned (FAQ sets / posts) are NOT
-- affected. Recommendations are regenerable from the imported metrics.

\set ON_ERROR_STOP on
\timing on

begin;
set local lock_timeout = '5s';

drop table if exists seo_recommendations;

commit;

\echo 'Migration 077 down complete.'
