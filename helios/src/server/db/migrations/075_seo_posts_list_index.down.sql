-- Down for 075: drop the seo_posts paginated-list index.
--
-- Reverting only removes the list-query optimization; the control plane
-- still works (it falls back to a sort). FreshlyBakedNYC/automation#44 /
-- virusdave/top-level#15, P4.

\set ON_ERROR_STOP on
\timing on

drop index if exists seo_posts_updated_at_id_desc_idx;

\echo 'Migration 075 down complete.'
