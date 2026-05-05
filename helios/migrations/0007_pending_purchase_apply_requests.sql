create table pending_purchase_apply_requests (
  id bigserial primary key,
  packet_id bigint not null references pending_purchase_packets(id),
  job_id bigint null references job_queue(id),
  requested_by_user_id bigint null references users(id),
  requested_reason text null,
  status text not null check (status in ('queued', 'running', 'succeeded', 'partially_succeeded', 'failed', 'blocked')),
  selected_row_count integer not null default 0,
  applied_row_count integer not null default 0,
  blocked_row_count integer not null default 0,
  failed_row_count integer not null default 0,
  selected_row_ids_json jsonb not null default '[]'::jsonb,
  summary_json jsonb not null default '{}'::jsonb,
  started_at timestamptz null,
  finished_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index pending_purchase_apply_requests_packet_created_idx
  on pending_purchase_apply_requests (packet_id, created_at desc);

create index pending_purchase_apply_requests_status_created_idx
  on pending_purchase_apply_requests (status, created_at desc);

create trigger pending_purchase_apply_requests_set_updated_at
before update on pending_purchase_apply_requests
for each row execute function set_updated_at();

alter table pending_purchase_rows
  add column approval_status text not null default 'pending' check (approval_status in ('pending', 'approved', 'rejected')),
  add column approval_updated_at timestamptz null,
  add column approved_by_user_id bigint null references users(id),
  add column rejected_by_user_id bigint null references users(id),
  add column last_apply_request_id bigint null references pending_purchase_apply_requests(id),
  add column last_apply_status text not null default 'not_requested' check (last_apply_status in ('not_requested', 'queued', 'running', 'applied', 'failed', 'blocked')),
  add column last_apply_error text null,
  add column last_apply_summary_json jsonb not null default '{}'::jsonb,
  add column applied_at timestamptz null;

create index pending_purchase_rows_packet_approval_idx
  on pending_purchase_rows (packet_id, approval_status, distributor_product_name);

create index pending_purchase_rows_apply_status_idx
  on pending_purchase_rows (last_apply_request_id, last_apply_status, id);
