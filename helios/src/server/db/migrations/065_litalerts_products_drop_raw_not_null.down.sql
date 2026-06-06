-- Down for 065.
--
-- The image_url column and the partial index can be dropped cleanly,
-- but the NOT NULL constraints on raw_config_json / raw_product_json
-- CANNOT be safely re-added once the F3 drain has nulled any row — and
-- re-asserting them is meaningless after the data is gone. If you must
-- restore them before any drain has run, do it manually:
--   alter table litalerts_products alter column raw_config_json set not null;
--   alter table litalerts_products alter column raw_product_json set not null;

\set ON_ERROR_STOP on

drop index concurrently if exists litalerts_products_raw_present_idx;

begin;
set local lock_timeout = '5s';
alter table litalerts_products drop column if exists image_url;
commit;

\echo '065 down dropped image_url + the raw-present partial index; NOT NULL on raw_* is NOT restored (cannot be re-added after the F3 drain).'
