-- F3 (virusdave/top-level#11, phase F3): stop persisting the redundant
-- litalerts_products.raw_config_json / raw_product_json blobs.
--
-- litalerts_products is ~3.4 GB / 3.48M rows on prod, and effectively
-- every row still carries the two raw JSON blobs the structured ingest
-- captured "for forensics". Every field the live pricing-cache reader
-- (loadBrandProductsFromCache in worker/pricing/litAlertsMarket.ts)
-- actually needs already exists as a typed column —
--   amount, units, normal_price, sale_price, current_stock,
--   recreational, medical, medical_url, recreational_url
-- — with one exception: the per-product image URL, which the reader was
-- pulling out of raw_product_json->>'imageURL'. This migration adds a
-- typed `image_url` column to hold it (the partner API now returns
-- LAProduct.imageURL as a first-class field, so the steady-state writer
-- populates it directly going forward).
--
-- It also drops the NOT NULL constraint on both raw_* columns so the
-- new bounded drain worker
-- (config.workers.litalerts_products_raw_json_drain) can null them for
-- rows older than its cutoff. As it nulls each old row it carries any
-- still-present raw_product_json->>'imageURL' into image_url first, so
-- no image is ever lost.
--
-- Finally it adds a PARTIAL index over the rows that still carry raw
-- JSON. Unlike sweed_orders (F5), the litalerts writer STOPS writing
-- raw entirely, so after the one-time backlog drains the column is
-- permanently all-NULL. A partial index keyed on `observed_at where
-- raw_product_json is not null` keeps both the drain's candidate scan
-- AND its eventual steady-state no-op O(matching-rows) instead of a
-- full 3.48M-row seq scan every tick. The index shrinks to empty once
-- the backlog is drained.
--
-- The follow-up `ALTER TABLE ... DROP COLUMN raw_config_json,
-- raw_product_json` (and removing the transitional raw fallback in the
-- reader) is intentionally OUT of scope for this migration — it is a
-- separate task filed once observation confirms the drain has fully
-- converged and no surprise consumer remains.

\set ON_ERROR_STOP on
\timing on

-- Catalog-only changes. Adding a nullable column with no default is a
-- metadata-only operation in modern Postgres (instant), and the two
-- DROP NOT NULLs are likewise fast — bounded by lock_timeout so they
-- fail fast rather than wedging behind a long-running query on the
-- live table.
begin;
set local lock_timeout = '5s';
alter table litalerts_products add column if not exists image_url text;
alter table litalerts_products alter column raw_config_json drop not null;
alter table litalerts_products alter column raw_product_json drop not null;
commit;

-- Built CONCURRENTLY (must run outside a transaction block) so it never
-- takes a blocking lock on the live serving table while it scans 3.48M
-- rows.
create index concurrently if not exists litalerts_products_raw_present_idx
  on litalerts_products (observed_at)
  where raw_product_json is not null;
