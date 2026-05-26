-- sweed_package_snapshots + sweed_package_snapshots_ingest_state
--
-- Helios-owned versioned mirror of every package (inventoryItemId) ever
-- observed at any dealer, polled every 5 minutes during 08:00–02:00 ET
-- via Sweed's `store.inventory.item.list.grouped` (with `isOnStock: false`
-- so already-sold-through packages remain visible for historical-cost
-- joins).
--
-- The headline blockers this unblocks on the /metrics page tree:
--   * Margin / COGS metrics — wholesale cost is a per-PACKAGE
--     (inventoryItemId) attribute on Sweed, not per-SKU. Different
--     packages for the same SKU can have different costs.
--   * Inventory.* metrics (cost_distribution, misalignment, slow-movers,
--     low-stock) — needs current on-hand qty per package.
--
-- See FreshlyBakedNYC/automation#24 (sibling of #22, unblocker for #21).
--
-- ============================================================================
-- Versioning model
-- ============================================================================
--
-- We do NOT overwrite-in-place. Every poll inserts a new row WHENEVER the
-- observed shape changes (cost, qty, lab, expiration, location, …) and
-- merely bumps `observed_at_max` when the shape matches the most recent
-- row for that (dealer, inventory_item_id). That gives us:
--
--   * A full audit trail of cost / qty changes over the life of a
--     package (e.g. so historical COGS uses the cost as it was on the
--     order date, not whatever it is today after a restock).
--   * Cheap "current state" via the `sweed_package_current` view.
--   * O(history) storage instead of O(polls) — typical package only
--     changes shape a handful of times in its life.
--
-- The "shape fingerprint" is a stable JSON blob computed at ingest time
-- and stored in `shape_fingerprint`. The worker first looks up the most
-- recent row's fingerprint and either:
--   * INSERT if it differs (or no prior row exists),
--   * UPDATE observed_at_max if it matches.
--
-- ============================================================================
-- Joins
-- ============================================================================
--
-- For COGS at metric-query time, line items already live in
-- `sweed_orders.raw_json -> 'items'[]` (each item carries
-- `inventoryItemId` — verified live 2026-05-26). A typical join:
--
--   select so.pay_time, item->>'inventoryItemId' as inv_id,
--          (item->>'subtotalAmount')::numeric as revenue,
--          sweed_package_cost_as_of(
--            so.dealer_id, item->>'inventoryItemId', so.pay_time
--          ) * (item->>'currentQty')::numeric as cogs
--   from sweed_orders so,
--        jsonb_array_elements(so.raw_json->'items') as item
--   where so.pay_time between $from and $to
--
-- so we deliberately do NOT materialise a sweed_order_line_items table
-- in v1. (If jsonb perf becomes a bottleneck we can add one later
-- without touching the ingest path.)

create table if not exists sweed_package_snapshots (
  dealer_id           bigint not null,
  inventory_item_id   text not null,
  observed_at_min     timestamptz not null,        -- when this shape first observed
  observed_at_max     timestamptz not null,        -- bumped every poll that matched
  primary key (dealer_id, inventory_item_id, observed_at_min),

  -- Product / catalog denorm (kept on the snapshot row because Sweed
  -- products themselves are mutable — e.g. category re-tags — and we
  -- want as-of-then semantics, not as-of-now).
  product_id          bigint,
  product_name        text,
  product_short_name  text,
  product_sku         text,
  category_id         bigint,
  category_name       text,
  subcategory_id      bigint,
  subcategory_name    text,
  brand_id            bigint,
  brand_name          text,
  size_label          text,                         -- e.g. "1g", "3.5g"

  -- Quantity (all three for completeness; available_qty is the
  -- "for sale right now" signal because it nets out holds).
  current_qty         numeric(12, 3),
  hold_qty            numeric(12, 3),
  available_qty       numeric(12, 3),
  is_on_stock         boolean,

  -- Cost — operator-confirmed per-PACKAGE (2026-05-26).
  -- Sweed's invoice envelope returns `wholesaleCost: 0` on every line
  -- item, so the only reliable source is this snapshot table.
  wholesale_cost_dollars numeric(12, 4),

  -- Lab + package metadata. Each is captured if Sweed surfaces it on
  -- the grouped feed; otherwise nullable.
  metrc_tag           text,                         -- externalTrackCode
  internal_track_code text,
  lab_thc_pct         numeric(6, 3),
  lab_cbd_pct         numeric(6, 3),
  expiration_date     date,
  received_at         timestamptz,
  stock_location      text,
  distributor_name    text,

  -- Provenance: keep the raw RPC item payload so we can re-derive any
  -- field we forgot to normalise without re-fetching from Sweed.
  raw_json            jsonb not null,

  -- Fingerprint of the observed shape used to decide INSERT vs
  -- UPDATE-observed_at_max. Stable hash over the normalised columns
  -- (NOT the full raw_json — we tolerate raw_json adding new noise
  -- fields without producing a new snapshot row).
  shape_fingerprint   text not null
);

create index if not exists sweed_package_snapshots_dealer_observed_idx
  on sweed_package_snapshots (dealer_id, observed_at_max desc);
create index if not exists sweed_package_snapshots_inventory_item_idx
  on sweed_package_snapshots (inventory_item_id);
create index if not exists sweed_package_snapshots_product_idx
  on sweed_package_snapshots (product_id);
create index if not exists sweed_package_snapshots_category_idx
  on sweed_package_snapshots (category_id) where category_id is not null;

-- Latest snapshot per (dealer, inventory_item_id). Use for "current
-- on-hand stock per package" queries (P4 inventory metrics).
create or replace view sweed_package_current as
  select distinct on (dealer_id, inventory_item_id) *
  from sweed_package_snapshots
  order by dealer_id, inventory_item_id, observed_at_max desc;

-- As-of helper for COGS joins. Returns the wholesale cost that was in
-- effect for the given package at the given timestamp (the row whose
-- observed_at_min <= ts and is the latest such). Stable so it's safe
-- in correlated subqueries.
create or replace function sweed_package_cost_as_of(
  p_dealer bigint,
  p_inventory_item_id text,
  p_ts timestamptz
)
returns numeric language sql stable as $$
  select wholesale_cost_dollars
  from sweed_package_snapshots
  where dealer_id = p_dealer
    and inventory_item_id = p_inventory_item_id
    and observed_at_min <= p_ts
  order by observed_at_min desc
  limit 1
$$;

-- Per-dealer ingest state. Mostly an operator-facing breadcrumb for
-- /config/workers (last poll outcome, page count, etc.) — no
-- highwater / cursor here because the grouped feed is full-scan, not
-- incremental.
create table if not exists sweed_package_snapshots_ingest_state (
  dealer_id                bigint primary key,
  last_polled_at           timestamptz not null default now(),
  last_pages_scanned       int not null default 0,
  last_items_seen          int not null default 0,
  last_rows_inserted       int not null default 0,
  last_rows_updated        int not null default 0,
  consecutive_empty_polls  int not null default 0,
  notes                    text
);
