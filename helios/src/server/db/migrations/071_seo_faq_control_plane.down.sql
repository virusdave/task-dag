-- Down for 071: drop the SEO FAQ control-plane tables.
--
-- seo_faq_sets + seo_approvals are the Helios-side FAQ MVP control plane
-- (FreshlyBakedNYC/automation#44 / virusdave/top-level#15, P3). Dropping
-- them discards all authored/approved FAQ content and the human-approval
-- ledger; only do this in a full teardown/rollback of P3. Drop the child
-- table first (it FKs the ledger).

\set ON_ERROR_STOP on
\timing on

begin;
set local lock_timeout = '5s';

drop table if exists seo_faq_sets;
drop table if exists seo_approvals;

commit;

\echo 'Migration 071 down complete.'
