-- Down for 074: drop the SEO image-asset control-plane table + revert the
-- approval-ledger content_kind check to its post-072 ('faq_set','post')
-- shape.
--
-- seo_image_assets is the Helios-side INDEPENDENT image approval control
-- plane (FreshlyBakedNYC/automation#44 / virusdave/top-level#15, P4).
-- Dropping it discards all registered/approved image-asset metadata; only
-- do this in a full teardown/rollback of this slice. The seo_approvals
-- ledger itself is shared with P3/P4 and is NOT dropped here — we only
-- narrow its content_kind check back to the pre-074 set.
--
-- NOTE: reverting the check will FAIL if any 'image' approval rows still
-- exist. Remove/retire those first before running this.

\set ON_ERROR_STOP on
\timing on

begin;
set local lock_timeout = '5s';

drop table if exists seo_image_assets;

alter table seo_approvals
  drop constraint if exists seo_approvals_content_kind_check;
alter table seo_approvals
  add constraint seo_approvals_content_kind_check
    check (content_kind in ('faq_set', 'post'));

commit;

\echo 'Migration 074 down complete.'
