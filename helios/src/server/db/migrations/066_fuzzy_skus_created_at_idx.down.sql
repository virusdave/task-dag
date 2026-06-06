-- Down for 066: drop the retention-support index.

\set ON_ERROR_STOP on

drop index concurrently if exists fuzzy_skus_created_at_idx;

\echo '066 down dropped fuzzy_skus_created_at_idx.'
