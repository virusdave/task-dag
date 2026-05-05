create table job_queue (
  id bigserial primary key,
  job_type text not null,
  dedupe_key text null,
  concurrency_key text null,
  catalog_group_id bigint null references catalog_groups(id),
  payload_json jsonb not null,
  status text not null check (status in ('queued', 'running', 'succeeded', 'failed', 'dead_letter')),
  run_at timestamptz not null,
  leased_until timestamptz null,
  lease_token text null,
  attempt_count integer not null default 0,
  last_error text null,
  requested_by_user_id bigint null references users(id),
  started_at timestamptz null,
  finished_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index job_queue_status_run_at_idx on job_queue (status, run_at, id);
create index job_queue_group_status_run_at_idx on job_queue (catalog_group_id, status, run_at, id);
create unique index job_queue_active_dedupe_unique on job_queue (dedupe_key)
  where status in ('queued', 'running') and dedupe_key is not null;

create trigger job_queue_set_updated_at
before update on job_queue
for each row execute function set_updated_at();

create table audit_events (
  id bigserial primary key,
  actor_type text not null check (actor_type in ('user', 'system')),
  actor_user_id bigint null references users(id),
  catalog_group_id bigint null references catalog_groups(id),
  event_type text not null,
  entity_type text not null,
  entity_id text not null,
  payload_json jsonb not null,
  undo_payload_json jsonb null,
  request_id text null,
  created_at timestamptz not null default now()
);

create index audit_events_created_idx on audit_events (created_at desc);
create index audit_events_entity_idx on audit_events (entity_type, entity_id, created_at desc);
create index audit_events_event_type_idx on audit_events (event_type, created_at desc);
create index audit_events_catalog_group_idx on audit_events (catalog_group_id, created_at desc);
create index audit_events_actor_idx on audit_events (actor_user_id, created_at desc);

create table write_operations (
  id bigserial primary key,
  catalog_group_id bigint not null references catalog_groups(id),
  operation_type text not null check (operation_type in ('apply', 'undo')),
  trigger_event_id bigint null,
  job_id bigint null references job_queue(id),
  desired_projection_json jsonb not null,
  desired_projection_hash text not null,
  status text not null check (status in ('queued', 'running', 'succeeded', 'failed', 'verified_mismatch')),
  attempt_count integer not null default 0,
  pre_write_snapshot_id bigint null references catalog_group_snapshots(id),
  post_write_snapshot_id bigint null references catalog_group_snapshots(id),
  request_json jsonb null,
  response_json jsonb null,
  error text null,
  started_at timestamptz null,
  finished_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index write_operations_group_created_idx on write_operations (catalog_group_id, created_at desc);
create index write_operations_status_created_idx on write_operations (status, created_at desc);

create trigger write_operations_set_updated_at
before update on write_operations
for each row execute function set_updated_at();

create table undo_events (
  id bigserial primary key,
  original_event_id bigint not null,
  undo_audit_event_id bigint null,
  requested_by_user_id bigint null references users(id),
  job_id bigint null references job_queue(id),
  status text not null check (status in ('queued', 'running', 'completed', 'failed')),
  error text null,
  started_at timestamptz null,
  finished_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index undo_events_original_event_idx on undo_events (original_event_id);
create index undo_events_status_created_idx on undo_events (status, created_at desc);

create trigger undo_events_set_updated_at
before update on undo_events
for each row execute function set_updated_at();

create table llm_runs (
  id bigserial primary key,
  catalog_group_id bigint not null references catalog_groups(id),
  proposal_row_id bigint null references proposal_rows(id),
  purpose text not null check (purpose in ('description', 'pricing', 'debug')),
  model text not null,
  prompt_version text not null,
  input_json jsonb not null,
  raw_output_text text not null,
  parsed_output_json jsonb null,
  validation_issues_json jsonb not null default '[]'::jsonb,
  forced_refresh boolean not null default false,
  status text not null check (status in ('queued', 'running', 'succeeded', 'failed', 'invalid')),
  job_id bigint null references job_queue(id),
  supersedes_run_id bigint null references llm_runs(id),
  created_by_user_id bigint null references users(id),
  created_at timestamptz not null default now()
);

create index llm_runs_group_created_idx on llm_runs (catalog_group_id, created_at desc);
create index llm_runs_purpose_created_idx on llm_runs (purpose, created_at desc);
create index llm_runs_proposal_row_created_idx on llm_runs (proposal_row_id, created_at desc);
