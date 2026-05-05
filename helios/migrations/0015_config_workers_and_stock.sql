-- Config module: background-worker schedules plus the first stock-refresh
-- snapshot tables and per-variant in-stock state used to drive auto-scheduled
-- Lit Alerts refreshes when a variant transitions from out-of-stock to
-- in-stock at a site.
--
-- Schedule rows describe a windowed cadence:
--   weekday_mask : 7-bit mask, bit 0 = Sunday, bit 6 = Saturday.
--   window_start_minute / window_end_minute : minute-of-day, 0..1440.
--     Wrap-around windows (start > end) are handled at runtime, e.g.
--     08:00 -> 02:00 next day spans the late-night/morning rollover.
--   interval_minutes : enqueue cadence within the window.
--
-- Multiple windows per task_key are supported so the user-described
-- "every 2 minutes 8am-2am, every 15 minutes 2am-8am" pattern is one
-- task_key with two rows.

create table config_worker_schedules (
  id bigserial primary key,
  task_key text not null,
  weekday_mask integer not null check (weekday_mask between 0 and 127),
  window_start_minute integer not null check (window_start_minute between 0 and 1440),
  window_end_minute integer not null check (window_end_minute between 0 and 1440),
  interval_minutes integer not null check (interval_minutes between 1 and 1440),
  paused boolean not null default false,
  notes text null,
  updated_by_user_id bigint null references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index config_worker_schedules_task_idx
  on config_worker_schedules (task_key, window_start_minute);

create trigger config_worker_schedules_set_updated_at
before update on config_worker_schedules
for each row execute function set_updated_at();

-- Tracks the most recent successful enqueue for each task so the recurring
-- scheduler can decide whether the next interval window has elapsed.
create table config_worker_schedule_runs (
  task_key text primary key,
  last_enqueued_at timestamptz null,
  last_enqueued_job_id bigint null references job_queue(id),
  updated_at timestamptz not null default now()
);

create trigger config_worker_schedule_runs_set_updated_at
before update on config_worker_schedule_runs
for each row execute function set_updated_at();

-- Per-site full-stock snapshot. One row per scan attempt, even when the scan
-- is incomplete or fails partway, so failures stay visible instead of being
-- silently retried on top of stale snapshot rows.
create table stock_snapshots (
  id bigserial primary key,
  site_dealer_id bigint not null,
  site_key text not null,
  site_label text not null,
  job_id bigint null references job_queue(id),
  status text not null check (status in ('running', 'succeeded', 'failed')),
  started_at timestamptz not null default now(),
  finished_at timestamptz null,
  variant_count integer null,
  in_stock_variant_count integer null,
  newly_in_stock_variant_count integer null,
  newly_out_of_stock_variant_count integer null,
  litalerts_refresh_enqueued_count integer null,
  error text null,
  metadata_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index stock_snapshots_site_started_idx
  on stock_snapshots (site_dealer_id, started_at desc);
create index stock_snapshots_status_started_idx
  on stock_snapshots (status, started_at desc);

create trigger stock_snapshots_set_updated_at
before update on stock_snapshots
for each row execute function set_updated_at();

-- Per-variant rows recorded for each successful snapshot. Only meaningful
-- fields are persisted: the integer quantities are aggregated per
-- (snapshot, variant) so downstream diffs are (snapshot_id, product_id) ->
-- in-stock yes/no plus quantity for traceability.
create table stock_snapshot_items (
  snapshot_id bigint not null references stock_snapshots(id) on delete cascade,
  product_id bigint not null,
  is_on_stock boolean not null,
  quantity numeric(18, 3) null,
  package_count integer null,
  product_name text null,
  primary key (snapshot_id, product_id)
);

create index stock_snapshot_items_in_stock_idx
  on stock_snapshot_items (snapshot_id, is_on_stock);

-- Authoritative current per-(site, variant) in-stock state. Updated at the
-- end of each successful snapshot so transitions can be detected by diffing
-- the new snapshot against this table inside the same transaction.
create table stock_variant_state (
  site_dealer_id bigint not null,
  product_id bigint not null,
  is_on_stock boolean not null,
  quantity numeric(18, 3) null,
  last_snapshot_id bigint null references stock_snapshots(id),
  last_observed_at timestamptz not null default now(),
  last_in_stock_at timestamptz null,
  last_out_of_stock_at timestamptz null,
  primary key (site_dealer_id, product_id)
);

create index stock_variant_state_in_stock_idx
  on stock_variant_state (site_dealer_id, is_on_stock);

-- Pending Lit Alerts refresh queue. A variant transitioning from
-- out-of-stock to in-stock at a site enqueues a row here, which a follow-up
-- worker can drain into actual Lit Alerts API calls. The reason and source
-- snapshot id keep the trigger evidence first-class for audit.
create table pending_litalerts_refresh_queue (
  id bigserial primary key,
  product_id bigint not null,
  site_dealer_id bigint null,
  reason text not null check (reason in ('variant_in_stock_transition', 'manual', 'daily_full_sweep')),
  source_snapshot_id bigint null references stock_snapshots(id),
  status text not null default 'pending' check (status in ('pending', 'in_progress', 'completed', 'cancelled')),
  enqueued_at timestamptz not null default now(),
  completed_at timestamptz null,
  notes text null
);

create unique index pending_litalerts_refresh_queue_pending_unique
  on pending_litalerts_refresh_queue (product_id, coalesce(site_dealer_id, 0))
  where status = 'pending';

create index pending_litalerts_refresh_queue_status_idx
  on pending_litalerts_refresh_queue (status, enqueued_at);
