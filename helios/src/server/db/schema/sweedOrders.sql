-- sweed_orders + sweed_orders_ingest_highwater
--
-- Helios-owned mirror of completed Sweed retail invoices, polled
-- every ~5 minutes by the worker and backfilled day-by-day from
-- each dealer's store-opening date. This is the data backing every
-- P2-P6 "real" metric on the `/metrics` page tree.
--
-- See FreshlyBakedNYC/automation#22 (the Sweed orders ingest epic)
-- which is a sibling/unblocker for FreshlyBakedNYC/automation#21
-- (Business & Performance Metrics page tree) and indirectly satisfies
-- virusdave/top-level#7.
--
-- v1 design notes:
--   * Only the invoice HEADER is mirrored (grand total, customer,
--     fulfillment, payment, delivery zip). Line items are intentionally
--     deferred — the existing `store.sale.invoice.list` envelope does
--     not include line items, and per-row `store.sale.invoice.get`
--     calls would multiply Sweed RPC cost by ~basket-size. A separate
--     follow-on will add a `sweed_order_line_items` table once we've
--     confirmed the correct RPC variant.
--   * `(dealer_id, invoice_id)` is the only key. Upserts are
--     idempotent via `on conflict do nothing`, which is what makes
--     the overlap-window highwater advance safe (see the worker).
--
-- Idempotent: every `create` is `if not exists`.

create table if not exists sweed_orders (
  dealer_id          bigint not null,
  invoice_id         text not null,
  primary key (dealer_id, invoice_id),

  -- Time fields. `pay_time` is the canonical sale moment; we filter
  -- and bucket every metric on it. `ingested_at` powers the
  -- /config/workers freshness badge.
  pay_time           timestamptz not null,
  ingested_at        timestamptz not null default now(),

  -- Customer denormalised onto the order so the first-vs-returning
  -- aggregation can be done without a customer table.
  -- `customer_id` is null for guests; `first_time_for_customer` is
  -- computed at ingest as `not exists (...where customer_id = $1
  -- and pay_time < $2)`.
  customer_id        bigint,
  is_guest           boolean not null default false,
  first_time_for_customer boolean,

  -- Cash-side aggregates from the RPC envelope.
  grand_total_dollars  numeric(12, 2) not null,
  subtotal_dollars     numeric(12, 2),
  tax_dollars          numeric(12, 2),
  discount_dollars     numeric(12, 2),

  -- Fulfillment + payment denormalised from the RPC envelope.
  -- Free string today because Sweed's taxonomy is operator-editable;
  -- metrics derive their stack labels from `distinct fulfillment_type`
  -- queried at request time.
  fulfillment_type   text,
  payment_method     text,

  -- Header lifecycle status from invoiceStatus.name (for example Paid or
  -- Cancelled). Kept out of raw_json so cancellation filtering remains narrow
  -- and durable after the raw-envelope drain.
  invoice_status_name text,

  -- For the customer-origin map (P6 of #21). Coalesces the
  -- delivery_address.zip field on the invoice envelope; null when
  -- there is no delivery address (kiosk / pickup / in-store).
  --
  -- Historical: this column was the zip-only persistence the
  -- original #25 design proposed. Migration 037 added
  -- `delivery_address_id` (FK to the new `addresses` table) as
  -- the full-resolution successor. `delivery_zip` is left in
  -- place for backwards compatibility with the existing
  -- _real/sweedOrdersQueries.ts metric queries; the address-
  -- enrichment job (helios/src/worker/jobs/
  -- enrichDeliveryAddressJob.ts) populates both columns.
  delivery_zip       text,

  -- Provenance: keep the raw RPC payload so we can re-derive any
  -- field we forgot to normalise without re-fetching from Sweed.
  raw_json           jsonb not null

  -- ----- migration 037 (FreshlyBakedNYC/automation#25) -----
  --
  -- delivery_address_id    FK to addresses.id; null until the
  --                        per-invoice enrichment job has
  --                        resolved this order's delivery
  --                        destination.
  --
  -- invoice_get_status     NULL | 'ok' | 'no_address' | 'failed'.
  --                        Lets the per-invoice enrichment job
  --                        avoid re-polling rows with a known
  --                        terminal outcome. See
  --                        helios/src/server/db/migrations/
  --                        037_addresses.sql.
  --
  -- invoice_get_polled_at  timestamptz of the most recent
  --                        store.sale.invoice.get attempt.
);

create index if not exists sweed_orders_pay_time_idx          on sweed_orders (pay_time);
create index if not exists sweed_orders_dealer_pay_time_idx   on sweed_orders (dealer_id, pay_time);
create index if not exists sweed_orders_customer_pay_time_idx on sweed_orders (customer_id, pay_time) where customer_id is not null;
create index if not exists sweed_orders_fulfillment_idx       on sweed_orders (fulfillment_type);
create index if not exists sweed_orders_payment_idx           on sweed_orders (payment_method);
create index if not exists sweed_orders_delivery_zip_idx      on sweed_orders (delivery_zip) where delivery_zip is not null;

-- Per-dealer highwater + backfill cursor.
--
-- `highwater_pay_time` = largest `pay_time` we have ever inserted for
-- this dealer. The next forward poll asks Sweed for invoices with
-- `fromDate = highwater - overlap` so we never miss rows even when
-- the worker crashes between fetch and commit. The redundant rows
-- are no-ops via `on conflict do nothing`.
--
-- `backfill_cursor_day` = the next ET-day the backfill loop should
-- pull (working backwards toward `min_pay_time`). NULL means
-- backfill is complete.
--
-- `min_pay_time` = the dealer's store-opening date; the backfill
-- loop will not request anything earlier than this.
create table if not exists sweed_orders_ingest_highwater (
  dealer_id                bigint primary key,
  highwater_pay_time       timestamptz not null,
  min_pay_time             timestamptz not null,
  backfill_cursor_day      date,
  last_polled_at           timestamptz not null default now(),
  last_seen_count          int not null default 0,
  last_inserted_count      int not null default 0,
  consecutive_empty_polls  int not null default 0,
  notes                    text
);
