-- Sweed purchases (real, completed POs we received from distributors)
-- backing the new Catalog → Purchase Sell-Through page family.
--
-- Distinct from `pending_purchase_*`, which is the proposal/catalog-
-- enrichment pipeline. These tables mirror actual POs (everything
-- visible at `store.purchase.order.list/get`) so we can show per-PO
-- and per-line-item sell-through against the existing sweed_orders
-- invoice mirror.
--
-- Probe confirmed (2026-06-02, helios/scripts/probe-sweed-purchase-orders.ts):
--   * Header has id, externalOrderId, deliveryDate, dueDate (=payment due),
--     distributor.{id,name}, orderStatus.name, financialStatus.name,
--     totalPayAmount, totalSubtotalAmount, totalRegularAmount,
--     totalDiscountAmount, totalDeliveryChargesAmount, totalTaxAmount,
--     totalOwedAmount, totalProductQty, totalDistributorProductQty,
--     isCashOnDelivery, plus the positions[] array.
--   * Each PO position carries `externalTrackCode` (the Metrc tag,
--     stored as `metrc_tag` in `sweed_package_snapshots`) at the
--     position top level *and* under `orderPositionIntegrationData`,
--     giving us a 100% direct bridge to inventory packages → sales.
--   * Each position also carries `suggestedProduct.{id,name}` (the
--     catalog product id), `distributorProductPrice` (per-unit cost),
--     `extendedAmount` (line cost), `productPrice` (current retail).

create table if not exists sweed_purchases (
  dealer_id bigint not null,
  po_id text not null,
  primary key (dealer_id, po_id),

  -- Helios site denorm. Looked up from dealer_id against the
  -- HELIOS_PENDING_PURCHASE_SITE_DEALERS registry at ingest time.
  site_key text not null,

  -- Sweed header. Nullable where Sweed may omit fields on a given
  -- PO shape.
  po_name text,                                -- order "name" (sometimes blank)
  external_order_id text,                      -- e.g. "0000247352"
  delivery_date date,                          -- ET date the goods arrived
  delivery_at timestamptz,                     -- exact instant from deliveryDate
  payment_due_date date,                       -- header.dueDate
  order_status_name text,                      -- "Received", "Closed", ...
  financial_status_name text,                  -- "Fully paid", "Unpaid", ...
  is_cash_on_delivery boolean,

  distributor_id bigint,
  distributor_name text,
  distributor_integration_id bigint,
  distributor_integration_name text,

  -- Cash side. po_total_dollars is the sum the operator owes /
  -- owed for this PO (totalPayAmount). Used as the headline "what
  -- did I pay for this PO" number.
  po_total_dollars numeric(12, 2),
  po_subtotal_dollars numeric(12, 2),
  po_regular_amount_dollars numeric(12, 2),
  po_discount_amount_dollars numeric(12, 2),
  po_delivery_charges_dollars numeric(12, 2),
  po_tax_dollars numeric(12, 2),
  po_owed_dollars numeric(12, 2),

  ordered_units_total numeric(14, 3),
  distributor_product_qty_total numeric(14, 3),
  line_count int not null default 0,

  -- Header-level denorms for the list-page filter chips. Rebuilt
  -- from the line rows on every ingest overwrite.
  product_ids bigint[] not null default '{}',
  product_names text[] not null default '{}',
  brand_names text[] not null default '{}',
  category_names text[] not null default '{}',
  subcategory_names text[] not null default '{}',

  fetched_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Full store.purchase.order.get response (positions[] + every
  -- field we did not normalise). Kept verbatim so we can re-derive
  -- columns without re-fetching from Sweed.
  raw_json jsonb not null
);

create index if not exists sweed_purchases_site_delivery_idx
  on sweed_purchases (site_key, delivery_date desc);
create index if not exists sweed_purchases_dealer_delivery_idx
  on sweed_purchases (dealer_id, delivery_date desc);
create index if not exists sweed_purchases_distributor_idx
  on sweed_purchases (distributor_name);
create index if not exists sweed_purchases_payment_due_idx
  on sweed_purchases (payment_due_date)
  where payment_due_date is not null;
create index if not exists sweed_purchases_total_idx
  on sweed_purchases (po_total_dollars)
  where po_total_dollars is not null;
create index if not exists sweed_purchases_brand_names_gin
  on sweed_purchases using gin (brand_names);
create index if not exists sweed_purchases_product_ids_gin
  on sweed_purchases using gin (product_ids);


create table if not exists sweed_purchase_line_items (
  dealer_id bigint not null,
  po_id text not null,
  line_id text not null,
  primary key (dealer_id, po_id, line_id),

  line_index int not null,

  -- Sweed position / product fields.
  distributor_product_id text,
  distributor_product_name text,
  sweed_product_id bigint,                     -- suggestedProduct.id or distributorProduct.product.id
  sweed_product_name text,

  -- Catalog denorms (best-effort at ingest time; fall back to
  -- snapshot lookup when sweed_product_id is null).
  product_name text,
  product_sku text,
  brand_id bigint,
  brand_name text,
  category_id bigint,
  category_name text,
  subcategory_id bigint,
  subcategory_name text,
  size_label text,
  pack_count int,

  -- Static PO quantity / cost. These power PO-cost summaries.
  ordered_units numeric(14, 3) not null default 0,
  distributor_product_qty numeric(14, 3),
  extended_cost_dollars numeric(12, 2),         -- extendedAmount
  unit_cost_dollars numeric(12, 4),             -- distributorProductPrice (or discountProductPrice)
  unit_cost_source text,                        -- 'distributor_product_price' | 'discount_product_price' | 'metrc_wholesale_price' | 'unknown'
  discount_product_price_dollars numeric(12, 4),
  metrc_wholesale_price_dollars numeric(12, 4), -- per-unit, derived from orderPositionIntegrationData.wholesalePrice / qty
  is_trade_sample boolean,
  is_testing_sample boolean,

  -- Snapshot of the catalog retail price at ingest time
  -- (position.productPrice). The live list price for "what's the
  -- current outstanding list value" is recomputed at read time
  -- from catalog_groups → cheaper than maintaining per-line.
  list_price_dollars_at_ingest numeric(12, 4),

  -- Bridge to inventory packages. PO probe shows externalTrackCode is
  -- always present, so package_match_method='direct_metrc_tag' is the
  -- normal case. Schema keeps room for fallbacks (fuzzy match etc.).
  metrc_tag text,                               -- externalTrackCode
  matched_inventory_item_ids text[] not null default '{}',
  package_match_method text not null default 'unmatched',
  package_match_confidence numeric(5, 4),

  received_at_min timestamptz,                  -- from package snapshots
  received_at_max timestamptz,

  fetched_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Full position JSON for re-derivation / audit.
  raw_json jsonb not null,

  foreign key (dealer_id, po_id)
    references sweed_purchases (dealer_id, po_id)
    on delete cascade
);

create index if not exists sweed_purchase_lines_po_idx
  on sweed_purchase_line_items (dealer_id, po_id, line_index);
create index if not exists sweed_purchase_lines_product_idx
  on sweed_purchase_line_items (sweed_product_id)
  where sweed_product_id is not null;
create index if not exists sweed_purchase_lines_brand_idx
  on sweed_purchase_line_items (brand_name)
  where brand_name is not null;
create index if not exists sweed_purchase_lines_category_idx
  on sweed_purchase_line_items (category_name, subcategory_name);
create index if not exists sweed_purchase_lines_metrc_tag_idx
  on sweed_purchase_line_items (metrc_tag)
  where metrc_tag is not null;
create index if not exists sweed_purchase_lines_inventory_ids_gin
  on sweed_purchase_line_items using gin (matched_inventory_item_ids);


create table if not exists sweed_purchases_ingest_state (
  dealer_id bigint primary key,
  highwater_delivery_date date,
  min_delivery_date date not null,
  backfill_cursor_day date,
  last_polled_at timestamptz not null default now(),
  last_seen_count int not null default 0,
  last_upserted_count int not null default 0,
  last_skipped_pending_count int not null default 0,
  consecutive_empty_polls int not null default 0,
  notes text
);
