-- F5 (virusdave/top-level#11, phase F5): allow sweed_orders.raw_json to
-- be NULL so the drain worker can null it for orders older than 30 days.
--
-- Every request-time / historical reader of sweed_orders.raw_json has
-- been migrated off it (items -> sweed_order_items_flat in D1; cashier
-- creatorId -> cashier_user_id in migration 061). The only remaining
-- reference is the orders-ingest tail-fill, which reads raw_json only
-- for freshly-inserted invoices (never within the >30d drain window),
-- and the ingest INSERT still always supplies raw_json, so dropping the
-- NOT NULL constraint does not affect ingest.
--
-- Fast catalog-only change, but it takes a brief ACCESS EXCLUSIVE lock;
-- bounded by lock_timeout so it fails fast rather than wedging behind a
-- long-running query on the live serving table.

\set ON_ERROR_STOP on
\timing on

begin;
set local lock_timeout = '5s';
alter table sweed_orders alter column raw_json drop not null;
commit;
