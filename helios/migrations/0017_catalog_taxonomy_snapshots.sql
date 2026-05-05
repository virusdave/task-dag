-- State-level catalog taxonomy snapshots produced by the Config catalog
-- refresh background worker. Each snapshot row is one scan attempt across
-- the state catalog dealer and lives even when the scan fails partway,
-- so operators can see failed attempts in history rather than retrying
-- on top of stale snapshot rows. Per-entity payloads are stored as
-- jsonb rows in catalog_taxonomy_snapshot_rows so future query patterns
-- can index or filter by entity_type without rewriting the table.

create table catalog_taxonomy_snapshots (
  id bigserial primary key,
  state_dealer_id bigint not null,
  job_id bigint null references job_queue(id),
  status text not null check (status in ('running', 'succeeded', 'failed')),
  trigger text not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz null,
  product_count integer null,
  group_count integer null,
  category_count integer null,
  strain_count integer null,
  prevalence_count integer null,
  size_count integer null,
  distributor_count integer null,
  brand_count integer null,
  subcategory_count integer null,
  error text null,
  metadata_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index catalog_taxonomy_snapshots_started_idx
  on catalog_taxonomy_snapshots (started_at desc);
create index catalog_taxonomy_snapshots_status_started_idx
  on catalog_taxonomy_snapshots (status, started_at desc);

create trigger catalog_taxonomy_snapshots_set_updated_at
before update on catalog_taxonomy_snapshots
for each row execute function set_updated_at();

create table catalog_taxonomy_snapshot_rows (
  snapshot_id bigint not null references catalog_taxonomy_snapshots(id) on delete cascade,
  entity_type text not null check (entity_type in (
    'product', 'group', 'category', 'subcategory', 'brand',
    'strain', 'prevalence', 'size', 'distributor'
  )),
  entity_id bigint not null,
  entity_name text null,
  payload jsonb not null,
  primary key (snapshot_id, entity_type, entity_id)
);

create index catalog_taxonomy_snapshot_rows_type_idx
  on catalog_taxonomy_snapshot_rows (snapshot_id, entity_type);
