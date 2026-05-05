create table proposal_batches (
  id bigserial primary key,
  type text not null check (type in ('description', 'pricing')),
  source text not null check (source in ('import', 'generated', 'debug')),
  trigger_mode text not null check (trigger_mode in ('ui', 'scheduled', 'import')),
  status text not null check (status in ('draft', 'ready', 'failed', 'superseded')),
  prompt_version text null,
  model text null,
  summary_json jsonb not null default '{}'::jsonb,
  config_json jsonb not null default '{}'::jsonb,
  job_id bigint null,
  superseded_by_batch_id bigint null references proposal_batches(id),
  created_by_user_id bigint null references users(id),
  created_at timestamptz not null default now()
);

create index proposal_batches_type_status_created_idx on proposal_batches (type, status, created_at desc);

create table proposal_rows (
  id bigserial primary key,
  proposal_batch_id bigint not null references proposal_batches(id),
  catalog_group_id bigint not null references catalog_groups(id),
  target_entity_type text not null check (target_entity_type in ('catalog_group', 'catalog_product')),
  target_entity_id bigint not null,
  baseline_snapshot_id bigint null references catalog_group_snapshots(id),
  row_title text not null,
  merchandising_context_json jsonb not null default '{}'::jsonb,
  evidence_json jsonb not null default '{}'::jsonb,
  source_llm_run_id bigint null,
  created_at timestamptz not null default now()
);

create unique index proposal_rows_batch_target_unique
  on proposal_rows (proposal_batch_id, target_entity_type, target_entity_id);
create index proposal_rows_group_created_idx on proposal_rows (catalog_group_id, created_at desc);
create index proposal_rows_batch_group_idx on proposal_rows (proposal_batch_id, catalog_group_id);

create table proposal_line_items (
  id bigserial primary key,
  proposal_row_id bigint not null references proposal_rows(id),
  catalog_group_id bigint not null references catalog_groups(id),
  target_entity_type text not null check (target_entity_type in ('catalog_group', 'catalog_product')),
  target_entity_id bigint not null,
  field_path text not null,
  baseline_value_json jsonb not null,
  suggested_value_json jsonb not null,
  edited_value_json jsonb null,
  effective_value_json jsonb not null,
  approval_status text not null check (approval_status in ('pending', 'approved', 'rejected', 'superseded')),
  version integer not null default 1,
  notes text null,
  validation_issues_json jsonb not null default '[]'::jsonb,
  approved_by_user_id bigint null references users(id),
  rejected_by_user_id bigint null references users(id),
  approval_updated_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index proposal_line_items_row_target_field_unique
  on proposal_line_items (proposal_row_id, target_entity_type, target_entity_id, field_path);
create index proposal_line_items_status_updated_idx on proposal_line_items (approval_status, updated_at desc);
create index proposal_line_items_group_field_status_idx on proposal_line_items (catalog_group_id, field_path, approval_status);
create index proposal_line_items_row_status_updated_idx on proposal_line_items (proposal_row_id, approval_status, updated_at desc);

create trigger proposal_line_items_set_updated_at
before update on proposal_line_items
for each row execute function set_updated_at();

create table desired_state_revisions (
  id bigserial primary key,
  proposal_line_item_id bigint not null references proposal_line_items(id),
  catalog_group_id bigint not null references catalog_groups(id),
  target_entity_type text not null check (target_entity_type in ('catalog_group', 'catalog_product')),
  target_entity_id bigint not null,
  field_path text not null,
  desired_value_json jsonb not null,
  active boolean not null default true,
  paused boolean not null default false,
  superseded_by_id bigint null references desired_state_revisions(id),
  created_by_user_id bigint null references users(id),
  created_at timestamptz not null default now()
);

create unique index desired_state_revisions_active_unique
  on desired_state_revisions (catalog_group_id, target_entity_type, target_entity_id, field_path)
  where active = true;
create index desired_state_revisions_group_active_idx on desired_state_revisions (catalog_group_id, paused, active);
