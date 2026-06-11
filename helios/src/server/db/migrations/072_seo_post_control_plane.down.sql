-- Down for 072: drop the auto-blog control-plane table + revert the
-- approval-ledger content_kind check to its P3 ('faq_set'-only) shape.
--
-- seo_posts is the Helios-side auto-blog MVP control plane
-- (FreshlyBakedNYC/automation#44 / virusdave/top-level#15, P4). Dropping it
-- discards all authored/approved post content; only do this in a full
-- teardown/rollback of P4. The seo_approvals ledger itself is shared with
-- P3 and is NOT dropped here — we only narrow its content_kind check back.
--
-- NOTE: reverting the check will FAIL if any 'post' approval rows still
-- exist. Remove/retire those first (or keep P4) before running this.

\set ON_ERROR_STOP on
\timing on

begin;
set local lock_timeout = '5s';

drop table if exists seo_posts;

alter table seo_approvals
  drop constraint if exists seo_approvals_content_kind_check;
alter table seo_approvals
  add constraint seo_approvals_content_kind_check
    check (content_kind in ('faq_set'));

commit;

\echo 'Migration 072 down complete.'
