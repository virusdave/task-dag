-- Invoice-grain margin rollup for CRM Segment Analysis margin/customer +
-- gross-margin% (virusdave/top-level#12, oracle DB-cost review).
--
-- WHY: per-customer margin needs per-LINE COGS via
-- sweed_package_cost_as_of_or_earliest(), and an EXPLAIN ANALYZE against
-- prod showed that function dominates the cost — ~333ms of a 408ms
-- margin/customer query is ~16.8k per-line cost lookups (the same query
-- WITHOUT the cost function is 41ms), and it grows linearly with line
-- volume. That violates the interactive DB budget, so we precompute the
-- expensive part ONCE at invoice grain and let the hot read path do a
-- trivial PK join.
--
-- The margin convention is identical to the proven
-- margins.gross_margin_dollars registry metric and the Customer Value
-- tab's margin money basis: per-line margin = REVENUE_EXPR - COGS_EXPR
-- over sweed_order_items_flat, unknown package cost => $0, canceled LINE
-- items zeroed (not row-filtered). Keep these expressions in lock-step
-- with sweedPackageSnapshotsQueries.ts (REVENUE_EXPR / QTY_EXPR /
-- COGS_EXPR / NON_CANCELED_LINE_SQL) and the ingest-time refresh in
-- configWorkersSweedOrdersIngestJob.ts.
--
-- Freshness: the ingest job recomputes the affected invoices whenever it
-- (re)flattens their line items, so this stays current with order
-- ingest. Package-cost snapshots changing retroactively for an
-- already-ingested invoice is the one residual staleness window; it is
-- rare and a future trailing-window reconcile (pay_time is stored for
-- exactly that) can cover it. PK (dealer_id, invoice_id) matches the
-- sweed_orders PK so the read-path join is a single index lookup.

\set ON_ERROR_STOP on
\echo 'Running migration 085: analytics_invoice_margin_facts...'

create table if not exists analytics_invoice_margin_facts (
  dealer_id       bigint      not null,
  invoice_id      text        not null,
  pay_time        timestamptz,
  line_count      integer     not null default 0,
  revenue_dollars numeric     not null default 0,
  cogs_dollars    numeric     not null default 0,
  margin_dollars  numeric     not null default 0,
  refreshed_at    timestamptz not null default now(),
  primary key (dealer_id, invoice_id)
);

-- Supports an optional trailing-window reconcile (refresh facts whose
-- pay_time falls in the last N days) without scanning the whole table.
create index if not exists analytics_invoice_margin_facts_pay_time_idx
  on analytics_invoice_margin_facts (pay_time);

-- One-time backfill of all existing invoices. ~62.7k lines today; the
-- cost function makes this a few seconds, well within the timeout. The
-- ingest job keeps it fresh from here. Idempotent via the PK upsert, so
-- safe to re-run.
begin;
set local lock_timeout = '10s';
set local statement_timeout = '15min';
insert into analytics_invoice_margin_facts as aimf
  (dealer_id, invoice_id, pay_time, line_count,
   revenue_dollars, cogs_dollars, margin_dollars, refreshed_at)
select
  f.dealer_id,
  f.invoice_id,
  max(f.pay_time) as pay_time,
  count(*)::int as line_count,
  coalesce(sum(
    case when lower(coalesce(f.raw_item->'invoiceItemStatus'->>'name', '')) <> 'canceled'
         then f.revenue else 0 end
  ), 0)::numeric as revenue_dollars,
  coalesce(sum(
    (case when lower(coalesce(f.raw_item->'invoiceItemStatus'->>'name', '')) <> 'canceled'
          then f.qty else 0 end)
    * coalesce(sweed_package_cost_as_of_or_earliest(f.dealer_id, f.inventory_item_id, f.pay_time), 0)
  ), 0)::numeric as cogs_dollars,
  coalesce(sum(
    (case when lower(coalesce(f.raw_item->'invoiceItemStatus'->>'name', '')) <> 'canceled'
          then f.revenue else 0 end)
    - (case when lower(coalesce(f.raw_item->'invoiceItemStatus'->>'name', '')) <> 'canceled'
            then f.qty else 0 end)
      * coalesce(sweed_package_cost_as_of_or_earliest(f.dealer_id, f.inventory_item_id, f.pay_time), 0)
  ), 0)::numeric as margin_dollars,
  now()
from sweed_order_items_flat f
group by f.dealer_id, f.invoice_id
on conflict (dealer_id, invoice_id) do update set
  pay_time        = excluded.pay_time,
  line_count      = excluded.line_count,
  revenue_dollars = excluded.revenue_dollars,
  cogs_dollars    = excluded.cogs_dollars,
  margin_dollars  = excluded.margin_dollars,
  refreshed_at    = excluded.refreshed_at;
commit;

analyze analytics_invoice_margin_facts;

\echo 'Migration 085 complete.'
