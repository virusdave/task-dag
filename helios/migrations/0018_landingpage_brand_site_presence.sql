-- Per-(site, brand) presence projection consumed by the Freshly Baked landing
-- page generator (mostly-static-sites repo). One row per (site_dealer_id,
-- brand_id) seen at any point in any successful stock snapshot. The row is
-- preserved even when the brand currently has zero "for sale" inventory at
-- the site so downstream pages can render in a paused-friendly state and so
-- the landing-page reviewer UI can highlight stale brands.
--
-- "For sale" follows the established Sweed inventory rule already used by
-- the deliverybudz snapshot generator and the trade-sample drop tooling:
-- a per-item lot counts only when stockLocation is a FOR SALE location AND
-- the lot has !isTradeSample AND !isNotForSale AND isAvailableOnline AND
-- a positive availableQty.
--
-- This table is owned by the stock-refresh worker and is not written from
-- outside Helios. It is read read-only by the FB-US landing-page service
-- via a dedicated SELECT-only role granted at deploy time.

create table landingpage_brand_site_presence (
  site_dealer_id bigint not null,
  site_key text not null,
  site_label text not null,
  brand_id bigint not null,
  brand_name text not null,
  for_sale_variant_count integer not null default 0,
  for_sale_total_available_qty numeric(18, 3) not null default 0,
  for_sale_lot_count integer not null default 0,
  last_observed_at timestamptz not null default now(),
  last_for_sale_observed_at timestamptz null,
  last_observed_snapshot_id bigint null references stock_snapshots(id),
  last_for_sale_observed_snapshot_id bigint null references stock_snapshots(id),
  first_observed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (site_dealer_id, brand_id)
);

create index landingpage_brand_site_presence_site_idx
  on landingpage_brand_site_presence (site_dealer_id, last_for_sale_observed_at desc nulls last);

create index landingpage_brand_site_presence_site_key_idx
  on landingpage_brand_site_presence (site_key, last_for_sale_observed_at desc nulls last);

create trigger landingpage_brand_site_presence_set_updated_at
before update on landingpage_brand_site_presence
for each row execute function set_updated_at();
