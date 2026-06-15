-- Down for 085: drop the invoice-margin rollup. Safe to drop — it is a
-- derived cache fully reconstructable from sweed_order_items_flat +
-- sweed_package_cost_as_of_or_earliest() by re-running the up migration.
-- The CRM Segment Analysis tab degrades to no margin metrics without it.

\set ON_ERROR_STOP on

drop table if exists analytics_invoice_margin_facts;
