-- Market Data Sweep — additional columns on existing tables.
--
-- Augments pending_litalerts_refresh_queue and litalerts_competitor_observations
-- with the priority/scheduling/expiry/extra-evidence columns needed by the
-- market-data-sweep epic.
--
-- ALTER-only; safe to apply against the live DB.

begin;

-- pending_litalerts_refresh_queue: priority + rolling scheduling + classification

alter table pending_litalerts_refresh_queue
  add column if not exists priority smallint not null default 100;

alter table pending_litalerts_refresh_queue
  add column if not exists next_run_at timestamptz null;

alter table pending_litalerts_refresh_queue
  add column if not exists enqueue_reason text not null default 'rolling';

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'pending_litalerts_refresh_queue_enqueue_reason_check'
  ) then
    alter table pending_litalerts_refresh_queue
      add constraint pending_litalerts_refresh_queue_enqueue_reason_check
      check (enqueue_reason in (
        'rolling',
        'proposal-source',
        'pending-purchase',
        'brand-alarm',
        'in-stock-alarm',
        'manual',
        'purchase-lifecycle'
      ));
  end if;
end$$;

alter table pending_litalerts_refresh_queue
  add column if not exists alarm_class text null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'pending_litalerts_refresh_queue_alarm_class_check'
  ) then
    alter table pending_litalerts_refresh_queue
      add constraint pending_litalerts_refresh_queue_alarm_class_check
      check (
        alarm_class is null
        or alarm_class in ('in_stock', 'pending_purchase', 'brand_match')
      );
  end if;
end$$;

create index if not exists pending_litalerts_refresh_queue_priority_idx
  on pending_litalerts_refresh_queue (status, priority, next_run_at)
  where status = 'pending';

-- litalerts_competitor_observations: expiry + rolling-refresh hint + extra evidence

alter table litalerts_competitor_observations
  add column if not exists expires_at timestamptz;

alter table litalerts_competitor_observations
  add column if not exists next_refresh_at timestamptz null;

alter table litalerts_competitor_observations
  add column if not exists images_jsonb jsonb;

alter table litalerts_competitor_observations
  add column if not exists description_text text;

alter table litalerts_competitor_observations
  add column if not exists competitor_urls_jsonb jsonb;

update litalerts_competitor_observations
   set expires_at = captured_at + interval '4 days'
 where expires_at is null;

alter table litalerts_competitor_observations
  alter column expires_at set not null;

create index if not exists litalerts_competitor_observations_expiry_idx
  on litalerts_competitor_observations (expires_at, product_id);

commit;
