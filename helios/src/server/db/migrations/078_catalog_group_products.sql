-- Migration 078: catalog_group_products (per-product live-state projection)
--
-- Phase B of the /catalog/review performance epic (parent
-- virusdave/top-level#16, child FreshlyBakedNYC/automation#45).
--
-- WHY: the family-grouped review queue needs each product's `sizeName`
-- (and price/name/tab) to be SQL-visible so the narrow family-page query
-- can group/sort/paginate by size WITHOUT cracking
-- `catalog_groups.live_state_json` per row (canon §3: never
-- `jsonb_array_elements` a big JSON column when a few columns will do).
-- Phase A keyed families by (brand, category, subcategory) only and
-- rendered multi-size groups as "Mixed"; this table lets Phase B fold
-- size into the family key and group multi-size groups correctly.
--
-- SHAPE: one skinny row per (catalog_group_id, product_id). It is a pure
-- projection of `live_state_json.products[]`; the blob remains the source
-- of truth. Maintained write-on-change inside `updateCatalogGroupLiveState`
-- (helios/src/worker/jobs/catalogGroupPersistence.ts) alongside the
-- existing brand/category/subcategory column projection — NOT by any new
-- background/polling job. So this adds no new recurring DB workload; the
-- only writes ride the already-existing catalog-sync write path, and only
-- when a product field actually changed.
--
-- DB-cost budget (canon §3): tiny table — production today is ~3,319
-- catalog groups / ~3,541 products (~1 row/group). Reads are PK
-- (catalog_group_id, product_id) point lookups + a per-group size rollup
-- over a handful of rows; writes are an unnest upsert + delete-missing
-- per group-sync, guarded by `IS DISTINCT FROM` so an unchanged sync
-- writes ZERO rows (no dead-tuple churn, no WAL). Index footprint: PK +
-- (product_id) + (catalog_group_id, ordinal), all small.
--
-- BACKFILL: done synchronously here (the catalog is tiny — a single
-- INSERT … SELECT over live_state_json), not via a worker. Idempotent:
-- ON CONFLICT DO UPDATE only when a column changed, so re-running this
-- migration is a no-op once the projection is in sync.
--
-- Idempotent: every create is `if not exists`; the backfill upserts.
-- Safe to re-run.

\echo 'Running migration 078: catalog_group_products...'

\set ON_ERROR_STOP on
\timing on

begin;
set local lock_timeout = '5s';

create table if not exists catalog_group_products (
  catalog_group_id bigint      not null,
  product_id       bigint      not null,
  -- 0-based position of the product within live_state_json.products[],
  -- so consumers can reconstruct the original product order.
  ordinal          integer     not null,
  name             text,
  tab              text,
  size_name        text,
  price            numeric,
  updated_at       timestamptz not null default now(),
  primary key (catalog_group_id, product_id)
);

-- Latest-observation join path (review pricing ladder fetches observations
-- by product_id) and any reverse lookup product -> group.
create index if not exists catalog_group_products_product_id_idx
  on catalog_group_products (product_id);

-- Per-group ordered scan (rebuild the product list in original order).
create index if not exists catalog_group_products_group_ordinal_idx
  on catalog_group_products (catalog_group_id, ordinal);

-- Synchronous, idempotent backfill from the canonical blob. Cracks
-- live_state_json.products[] once for every group; this is a one-shot the
-- operator runs, not a recurring cost. `with ordinality` gives the
-- original array order (1-based -> 0-based). Products with a null/blank/
-- non-numeric productId are skipped (they can't be keyed or joined).
insert into catalog_group_products
  (catalog_group_id, product_id, ordinal, name, tab, size_name, price, updated_at)
select
  cg.id,
  (p.elem ->> 'productId')::bigint,
  (p.ord - 1)::int,
  p.elem ->> 'name',
  p.elem ->> 'tab',
  p.elem ->> 'sizeName',
  nullif(p.elem ->> 'price', '')::numeric,
  now()
from catalog_groups cg
cross join lateral jsonb_array_elements(
  case
    when jsonb_typeof(cg.live_state_json -> 'products') = 'array'
      then cg.live_state_json -> 'products'
    else '[]'::jsonb
  end
) with ordinality as p(elem, ord)
where (p.elem ->> 'productId') ~ '^[0-9]+$'
on conflict (catalog_group_id, product_id) do update
  set ordinal   = excluded.ordinal,
      name      = excluded.name,
      tab       = excluded.tab,
      size_name = excluded.size_name,
      price     = excluded.price,
      updated_at = now()
  where catalog_group_products.ordinal   is distinct from excluded.ordinal
     or catalog_group_products.name      is distinct from excluded.name
     or catalog_group_products.tab       is distinct from excluded.tab
     or catalog_group_products.size_name is distinct from excluded.size_name
     or catalog_group_products.price     is distinct from excluded.price;

-- Remove projection rows whose product no longer exists in the blob (a
-- product was dropped from a group between a prior backfill and now).
delete from catalog_group_products cgp
where not exists (
  select 1
  from catalog_groups cg
  cross join lateral jsonb_array_elements(
    case
      when jsonb_typeof(cg.live_state_json -> 'products') = 'array'
        then cg.live_state_json -> 'products'
      else '[]'::jsonb
    end
  ) as p(elem)
  where cg.id = cgp.catalog_group_id
    and (p.elem ->> 'productId') ~ '^[0-9]+$'
    and (p.elem ->> 'productId')::bigint = cgp.product_id
);

-- Give the planner stats immediately (cheap at ~3.5k rows) rather than
-- waiting for autovacuum's first analyze after the table goes live.
analyze catalog_group_products;

commit;

\echo 'Migration 078 complete.'
