create table pending_purchase_packets (
  id bigserial primary key,
  source text not null check (source in ('import', 'generated')),
  status text not null check (status in ('ready', 'superseded')),
  packet_title text not null,
  import_file_name text null,
  source_path text null,
  generated_at timestamptz not null,
  site_keys_json jsonb not null default '[]'::jsonb,
  site_labels_json jsonb not null default '[]'::jsonb,
  orders_json jsonb not null default '[]'::jsonb,
  summary_json jsonb not null default '{}'::jsonb,
  state_context_json jsonb not null default '{}'::jsonb,
  job_id bigint null references job_queue(id),
  created_by_user_id bigint null references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index pending_purchase_packets_status_created_idx on pending_purchase_packets (status, created_at desc);
create index pending_purchase_packets_generated_created_idx on pending_purchase_packets (generated_at desc, created_at desc);

create trigger pending_purchase_packets_set_updated_at
before update on pending_purchase_packets
for each row execute function set_updated_at();

create table pending_purchase_rows (
  id bigserial primary key,
  packet_id bigint not null references pending_purchase_packets(id),
  row_key text not null,
  row_input_signature text null,
  site_key text not null,
  site_label text not null,
  site_dealer_id bigint null,
  site_dealer_name text null,
  distributor_product_id text not null,
  distributor_product_name text not null,
  action_type text not null,
  mapping_status text not null,
  target_brand text null,
  target_group_name text null,
  target_variant_name text null,
  expected_category text null,
  expected_subcategory text null,
  current_price numeric(12, 2) null,
  proposed_price numeric(12, 2) null,
  edited_proposed_price numeric(12, 2) null,
  current_description text null,
  proposed_description text null,
  edited_proposed_description text null,
  primary_image_url text null,
  edited_primary_image_url text null,
  primary_image_source text null,
  primary_image_note text null,
  catalog_action text not null,
  pricing_reason text null,
  market_advice_summary text null,
  notes text null,
  review_flags_json jsonb not null default '[]'::jsonb,
  order_ids_json jsonb not null default '[]'::jsonb,
  position_ids_json jsonb not null default '[]'::jsonb,
  raw_row_json jsonb not null,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index pending_purchase_rows_packet_row_key_unique on pending_purchase_rows (packet_id, row_key);
create index pending_purchase_rows_packet_site_action_idx on pending_purchase_rows (packet_id, site_key, action_type, distributor_product_name);
create index pending_purchase_rows_packet_mapping_idx on pending_purchase_rows (packet_id, mapping_status, distributor_product_name);

create trigger pending_purchase_rows_set_updated_at
before update on pending_purchase_rows
for each row execute function set_updated_at();
