create function set_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create table users (
  id bigserial primary key,
  google_sub text null,
  email text not null,
  name text not null,
  role text not null check (role in ('viewer', 'editor', 'approver', 'admin')),
  active boolean not null default true,
  last_login_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index users_google_sub_unique on users (google_sub) where google_sub is not null;
create unique index users_email_lower_unique on users ((lower(email)));

create trigger users_set_updated_at
before update on users
for each row execute function set_updated_at();

create table catalog_groups (
  id bigserial primary key,
  sweed_group_id bigint not null,
  group_name text not null,
  group_full_name text null,
  brand_name text null,
  category_name text null,
  subcategory_name text null,
  strain_name text null,
  product_tabs_json jsonb not null default '[]'::jsonb,
  live_state_json jsonb not null,
  live_state_hash text not null,
  reconcile_status text not null check (reconcile_status in ('unknown', 'in_sync', 'drifted', 'queued', 'applying', 'error')),
  last_synced_at timestamptz not null,
  last_seen_at timestamptz not null,
  drifted_at timestamptz null,
  deleted_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index catalog_groups_sweed_group_id_unique on catalog_groups (sweed_group_id);
create index catalog_groups_reconcile_status_last_synced_idx on catalog_groups (reconcile_status, last_synced_at desc);
create index catalog_groups_filter_idx on catalog_groups (brand_name, category_name, group_name);

create trigger catalog_groups_set_updated_at
before update on catalog_groups
for each row execute function set_updated_at();

create table catalog_group_snapshots (
  id bigserial primary key,
  catalog_group_id bigint not null references catalog_groups(id),
  source text not null check (source in ('sync', 'pre_write', 'post_write', 'undo')),
  state_json jsonb not null,
  state_hash text not null,
  created_at timestamptz not null default now()
);

create index catalog_group_snapshots_group_created_idx on catalog_group_snapshots (catalog_group_id, created_at desc);
create index catalog_group_snapshots_group_hash_idx on catalog_group_snapshots (catalog_group_id, state_hash);
