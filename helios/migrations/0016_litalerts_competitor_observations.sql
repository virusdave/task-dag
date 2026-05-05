-- Litalerts competitor observation snapshots produced by the Lit Alerts
-- refresh worker that drains pending_litalerts_refresh_queue. Each row is
-- one attempt to capture competitor pricing/availability for a single
-- variant productId at a particular point in time, with a hard link back
-- to the source stock snapshot that triggered the refresh and the queue
-- row that scheduled it. Failures are first-class rows so the operator
-- audit trail keeps the trigger evidence intact.

create table litalerts_competitor_observations (
  id bigserial primary key,
  queue_row_id bigint null references pending_litalerts_refresh_queue(id) on delete set null,
  product_id bigint not null,
  site_dealer_id bigint null,
  source_snapshot_id bigint null references stock_snapshots(id) on delete set null,
  job_id bigint null references job_queue(id) on delete set null,
  status text not null check (status in ('succeeded', 'failed')),
  brand_id integer null,
  brand_name text null,
  group_id bigint null,
  group_name text null,
  category_name text null,
  search_terms_json jsonb not null default '[]'::jsonb,
  search_term_label text null,
  availability text null,
  listing_count integer not null default 0,
  pricing_eligible_listing_count integer not null default 0,
  near_listing_count integer not null default 0,
  mid_listing_count integer not null default 0,
  far_listing_count integer not null default 0,
  evidence_json jsonb not null default '{}'::jsonb,
  notes text null,
  error text null,
  captured_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index litalerts_competitor_observations_product_idx
  on litalerts_competitor_observations (product_id, captured_at desc);

create index litalerts_competitor_observations_site_idx
  on litalerts_competitor_observations (site_dealer_id, captured_at desc);

create index litalerts_competitor_observations_queue_idx
  on litalerts_competitor_observations (queue_row_id);

create index litalerts_competitor_observations_status_idx
  on litalerts_competitor_observations (status, captured_at desc);

-- The Lit Alerts drainer needs to look up a Sweed productId inside
-- catalog_groups.live_state_json -> 'products' to resolve brand/category
-- without scanning every row, since the queue can drain hundreds of rows
-- per cycle. A GIN index on the products array lets `@>` containment
-- queries hit the index directly.
create index if not exists catalog_groups_live_state_products_gin
  on catalog_groups using gin ((live_state_json -> 'products') jsonb_path_ops);
