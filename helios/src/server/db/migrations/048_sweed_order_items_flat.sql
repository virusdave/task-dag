-- Flattened sweed_orders.raw_json->'items' rows.
--
-- Catalog → Purchase Sell-Through joins each PO line's matched
-- inventory_item_ids[] against the items[] inside every
-- sweed_orders.raw_json blob. Doing that join via
-- `cross join lateral jsonb_array_elements(raw_json -> 'items')`
-- at request time blows up to millions of intermediate rows for ~40k
-- orders × ~1000 PO lines, taking 15-50s per page load and timing
-- out the user's browser.
--
-- This migration materialises the items[] expansion once into a
-- normal table with btree indexes so the sell-through query becomes
-- a plain indexed join:
--
--    sweed_order_items_flat (dealer_id, inventory_item_id, pay_time)
--      → covering index on (qty, revenue)
--
-- One row per `(dealer_id, invoice_id, item_ordinal)`. Cascades on
-- delete so reingest/rewrite of sweed_orders cleanly resets the flat
-- rows. The Sweed orders ingest job tail-fills new rows on insert
-- (see configWorkersSweedOrdersIngestJob.ts → upsertFlatOrderItems).
--
-- raw_item is kept so downstream consumers don't have to re-join
-- back to sweed_orders.raw_json just to read extras like
-- product_name / cashier breakdown.

create table if not exists sweed_order_items_flat (
  dealer_id          bigint                    not null,
  invoice_id         text                      not null,
  item_ordinal       int                       not null,

  pay_time           timestamp with time zone  not null,
  inventory_item_id  text                      not null,

  qty                numeric(14, 3)            not null default 0,
  revenue            numeric(12, 2)            not null default 0,

  raw_item           jsonb                     not null,
  flattened_at       timestamp with time zone  not null default now(),

  primary key (dealer_id, invoice_id, item_ordinal),

  foreign key (dealer_id, invoice_id)
    references sweed_orders (dealer_id, invoice_id)
    on delete cascade
);

-- Backfill from every existing order. Items missing an
-- inventoryItemId are skipped (the sell-through join can't use them
-- anyway).
insert into sweed_order_items_flat (
  dealer_id,
  invoice_id,
  item_ordinal,
  pay_time,
  inventory_item_id,
  qty,
  revenue,
  raw_item
)
select
  so.dealer_id,
  so.invoice_id,
  (item.ord - 1)::int as item_ordinal,
  so.pay_time,
  item.value->>'inventoryItemId' as inventory_item_id,
  coalesce(
    nullif(item.value->>'currentQty', '')::numeric,
    nullif(item.value->>'quantity', '')::numeric,
    nullif(item.value->>'qty', '')::numeric,
    0
  ) as qty,
  coalesce(nullif(item.value->>'subtotalAmount', '')::numeric, 0) as revenue,
  item.value as raw_item
from sweed_orders so
cross join lateral jsonb_array_elements(coalesce(so.raw_json->'items', '[]'::jsonb))
  with ordinality as item(value, ord)
where nullif(item.value->>'inventoryItemId', '') is not null
on conflict (dealer_id, invoice_id, item_ordinal) do update set
  pay_time          = excluded.pay_time,
  inventory_item_id = excluded.inventory_item_id,
  qty               = excluded.qty,
  revenue           = excluded.revenue,
  raw_item          = excluded.raw_item,
  flattened_at      = now();

-- Catalog → Purchase Sell-Through hot-path: join PO line packages by
-- (dealer_id, inventory_item_id) and bound by pay_time >= delivery.
create index if not exists sweed_order_items_flat_item_pay_idx
  on sweed_order_items_flat (dealer_id, inventory_item_id, pay_time)
  include (qty, revenue);

-- Per-invoice cleanup / re-flatten lookup.
create index if not exists sweed_order_items_flat_invoice_idx
  on sweed_order_items_flat (dealer_id, invoice_id);

analyze sweed_order_items_flat;
