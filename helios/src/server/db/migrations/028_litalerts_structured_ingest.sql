-- 028_litalerts_structured_ingest.sql
--
-- Structured LitAlerts product ingest (issue #20). We pivot away from
-- per-tenant text parsing of free-text listingName (the substrate
-- built in #19) toward consuming the LitAlerts partner-API's
-- structured product RPCs directly:
--
--   GET /v1/brands?state=NY
--   GET /v1/brands/{brandId}/products?state=NY&includeOOS=true
--   GET /v1/retailers?state=NY
--   GET /v1/retailers/{retailerId}/products
--
-- Each LAProduct carries `brand`, `brandId`, `category`, and a
-- `configs[]` array with `amount`, `units`, `normalPrice`,
-- `salePrice`, `currentStock`, recreational/medical flags, and
-- per-listing URLs. That is essentially a pre-built FuzzySku for
-- 95% of fields — no text parsing required.
--
-- We snapshot each (retailer × product × config) row on every
-- successful crawl, keyed by `(retailer_id, product_id, config_idx)`
-- with a monotonically-increasing `observed_at` so the consumer
-- (pricing comp, market-data review) can either grab the latest
-- row per key or replay history.

-- Brand directory mirror. Refreshed by the per-state brand-crawl
-- pass of the structured ingest job.
create table if not exists litalerts_brands (
  brand_id        bigint primary key,
  name            text not null,
  state_code      text not null,                  -- 'NY' for now; index covers MA/NJ when we open
  states_csv      text,                           -- raw `states` field from LitAlerts (may list multiple)
  last_seen_at    timestamptz not null default now(),
  first_seen_at   timestamptz not null default now()
);

create index if not exists litalerts_brands_state_idx
  on litalerts_brands (state_code, last_seen_at desc);

create index if not exists litalerts_brands_name_lower_idx
  on litalerts_brands ((lower(trim(name))));

comment on table litalerts_brands is
  'Mirror of LitAlerts /v1/brands keyed by upstream brandId. Used to enumerate all brands carried in a state so the product crawl knows which brandIds to fan out across.';

-- Product snapshots. One row per (retailer, product, config) per
-- crawl tick. `latest_per_key_idx` lets the consumer query "the
-- newest row for each upstream key" cheaply; historical rows stay
-- around for trend/price-history use cases.
create table if not exists litalerts_products (
  observation_id      bigserial primary key,
  observed_at         timestamptz not null default now(),
  state_code          text not null,
  brand_id            bigint,                    -- nullable: some LAProducts have null brandId
  brand_name          text,                      -- denormalized for fast review without a join
  retailer_id         bigint not null,
  product_id          bigint not null,
  config_idx          integer not null,          -- index into LAProduct.configs[]
  product_name        text not null,             -- raw LAProduct.name
  category            text,                      -- raw LAProduct.category
  amount              text,                      -- LAProductConfig.amount (string per swagger)
  units               text,                      -- LAProductConfig.units (g/mg/etc)
  normal_price        numeric(10, 2),
  sale_price          numeric(10, 2),
  current_stock       integer,                   -- nullable when out of stock with no count
  recreational        boolean,
  medical             boolean,
  medical_url         text,
  recreational_url    text,
  -- Full structured payload for forensics / future column extraction
  -- without re-crawling. Trimmed to the per-config slice (so we
  -- aren't storing N copies of the same LAProduct envelope).
  raw_config_json     jsonb not null,
  raw_product_json    jsonb not null
);

create index if not exists litalerts_products_observed_idx
  on litalerts_products (observed_at desc);

create index if not exists litalerts_products_key_observed_idx
  on litalerts_products (retailer_id, product_id, config_idx, observed_at desc);

create index if not exists litalerts_products_brand_idx
  on litalerts_products (brand_id, state_code, observed_at desc);

create index if not exists litalerts_products_state_observed_idx
  on litalerts_products (state_code, observed_at desc);

comment on table litalerts_products is
  'Per-crawl-tick snapshots of LAProduct.configs[] rows. Latest row per (retailer_id, product_id, config_idx) is the current observed state; history is retained for price-history / stock-history queries.';

-- A small heartbeat table so the helios UI / scheduler can show
-- "last successful structured-ingest run" without scanning the
-- full snapshots table.
create table if not exists litalerts_structured_ingest_runs (
  run_id              bigserial primary key,
  state_code          text not null,
  started_at          timestamptz not null default now(),
  finished_at         timestamptz,
  ok                  boolean,
  brands_seen         integer,
  products_seen       integer,
  config_rows_written integer,
  error_message       text,
  -- summary by category for an at-a-glance review.
  category_counts     jsonb
);

create index if not exists litalerts_structured_ingest_runs_state_started_idx
  on litalerts_structured_ingest_runs (state_code, started_at desc);
