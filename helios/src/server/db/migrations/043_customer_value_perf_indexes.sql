-- Migration 043: covering index for the new /metrics/customer-value
-- analytics page (virusdave/top-level#7).
--
-- The /api/customer-value-analytics endpoint runs a single shared
-- CTE pass over sweed_orders that needs (dealer_id, customer_id,
-- pay_time, invoice_id) as the partition key for the per-customer
-- ROW_NUMBER() purchase ordinal. The existing
-- sweed_orders_customer_pay_time_idx covers (customer_id, pay_time)
-- but NOT dealer_id-scoped queries, which forces a heap fetch on
-- every row.
--
-- The partial-WHERE clause (customer_id IS NOT NULL) keeps the
-- index small — guest orders are excluded from LTV analytics
-- entirely so we don't need them indexed for this query path.

create index concurrently if not exists
  sweed_orders_dealer_customer_pay_invoice_idx
  on sweed_orders (dealer_id, customer_id, pay_time, invoice_id)
  where customer_id is not null;
