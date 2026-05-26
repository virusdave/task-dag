-- 033_litalerts_product_images.sql
--
-- Per-product primary image URLs for cached LitAlerts products.
--
-- The structured partner-API LAProduct response (the one consumed by
-- migration 028's litalerts_products) does not include any image
-- field. The LitAlerts dashboard backend at
-- `POST https://public-api.litalerts.com/Products/menulistings`
-- (Cognito-bearer-auth) DOES return an `imageUrl` per listing — those
-- are stable S3 CDN URLs (e.g.
-- `https://s3-us-west-2.amazonaws.com/dutchie-images/<hash>`) that we
-- can directly embed in helios review/proposal UIs without any
-- Cloudflare bot-protection in the way.
--
-- This table is keyed by (state_code, product_id) so we keep one
-- canonical image URL per LitAlerts product across observations
-- (instead of N copies, one per observation_id). It's populated by
-- the one-off `scripts/litalerts-backfill-product-images.mts` (and,
-- eventually, by the scheduled retailer-products backfill once we
-- promote it from one-off to recurring).
--
-- Idempotent. Re-running is a no-op.

\echo 'Running migration 033: litalerts_product_images...'

create table if not exists litalerts_product_images (
  state_code  text not null,
  product_id  bigint not null,
  image_url   text not null,
  fetched_at  timestamptz not null default now(),
  primary key (state_code, product_id)
);

create index if not exists litalerts_product_images_fetched_idx
  on litalerts_product_images (fetched_at desc);

comment on table litalerts_product_images is
  'Per-product primary image URL captured from the LitAlerts dashboard backend (POST /Products/menulistings). One row per (state, productId); upsert on refresh.';

\echo 'Migration 033 complete.'
