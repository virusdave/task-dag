-- Reverse migration 055 (litalerts_competitor_observations
-- hypertable conversion). OPERATOR RUNBOOK — see the same notes
-- on 050/051 down migrations. This rollback is only practical
-- while the table is small.
--
-- At conversion time the table was ~73k rows / 501 MB (heap 37 MB
-- + TOAST 422 MB + indexes 19 MB). Copying TOAST through a shadow
-- table is the slow part; expect tens of seconds to a minute or
-- two depending on Tiger Cloud I/O.

\set ON_ERROR_STOP on
\timing on

set lock_timeout      = '15s';
set statement_timeout = '30min';

begin;

lock table public.litalerts_competitor_observations
  in access exclusive mode;

create table public.litalerts_competitor_observations__rollback (
  id                              bigint primary key,
  queue_row_id                    bigint,
  product_id                      bigint not null,
  site_dealer_id                  bigint,
  source_snapshot_id              bigint,
  job_id                          bigint,
  status                          text not null,
  brand_id                        integer,
  brand_name                      text,
  group_id                        bigint,
  group_name                      text,
  category_name                   text,
  search_terms_json               jsonb not null default '[]'::jsonb,
  search_term_label               text,
  availability                    text,
  listing_count                   integer not null default 0,
  pricing_eligible_listing_count  integer not null default 0,
  near_listing_count              integer not null default 0,
  mid_listing_count               integer not null default 0,
  far_listing_count               integer not null default 0,
  evidence_json                   jsonb not null default '{}'::jsonb,
  notes                           text,
  error                           text,
  captured_at                     timestamptz not null default now(),
  created_at                      timestamptz not null default now(),
  expires_at                      timestamptz not null,
  next_refresh_at                 timestamptz,
  images_jsonb                    jsonb,
  description_text                text,
  competitor_urls_jsonb           jsonb,
  constraint litalerts_competitor_observations_status_check
    check (status = any (array['succeeded'::text, 'failed'::text]))
);

insert into public.litalerts_competitor_observations__rollback
select id, queue_row_id, product_id, site_dealer_id, source_snapshot_id,
       job_id, status, brand_id, brand_name, group_id, group_name,
       category_name, search_terms_json, search_term_label, availability,
       listing_count, pricing_eligible_listing_count, near_listing_count,
       mid_listing_count, far_listing_count, evidence_json, notes, error,
       captured_at, created_at, expires_at, next_refresh_at, images_jsonb,
       description_text, competitor_urls_jsonb
from public.litalerts_competitor_observations;

alter sequence public.litalerts_competitor_observations_id_seq
  owned by none;

drop table public.litalerts_competitor_observations;

alter table public.litalerts_competitor_observations__rollback
  rename to litalerts_competitor_observations;

alter sequence public.litalerts_competitor_observations_id_seq
  owned by public.litalerts_competitor_observations.id;

alter table public.litalerts_competitor_observations
  alter column id set default nextval('public.litalerts_competitor_observations_id_seq');

-- Restore outbound FKs.
alter table public.litalerts_competitor_observations
  add constraint litalerts_competitor_observations_job_id_fkey
  foreign key (job_id) references public.job_queue(id) on delete set null;

alter table public.litalerts_competitor_observations
  add constraint litalerts_competitor_observations_queue_row_id_fkey
  foreign key (queue_row_id)
  references public.pending_litalerts_refresh_queue(id) on delete set null;

alter table public.litalerts_competitor_observations
  add constraint litalerts_competitor_observations_source_snapshot_id_fkey
  foreign key (source_snapshot_id)
  references public.stock_snapshots(id) on delete set null;

-- Restore the original secondary indexes.
create index litalerts_competitor_observations_product_idx
  on public.litalerts_competitor_observations (product_id, captured_at desc);

create index litalerts_competitor_observations_site_idx
  on public.litalerts_competitor_observations (site_dealer_id, captured_at desc);

create index litalerts_competitor_observations_queue_idx
  on public.litalerts_competitor_observations (queue_row_id);

create index litalerts_competitor_observations_status_idx
  on public.litalerts_competitor_observations (status, captured_at desc);

create index litalerts_competitor_observations_expiry_idx
  on public.litalerts_competitor_observations (expires_at, product_id);

-- Restore the partial latest-succeeded index from migration 054
-- (the prep migration is NOT reversed by 055.down; the index
-- still exists on the rollback table because the new code path
-- relies on it).
create index litalerts_competitor_observations_latest_succeeded_idx
  on public.litalerts_competitor_observations
    (product_id, captured_at desc, id desc)
  include (expires_at, next_refresh_at, listing_count, pricing_eligible_listing_count)
  where status = 'succeeded';

-- Re-seat the sequence past max(id).
select setval(
  'public.litalerts_competitor_observations_id_seq',
  coalesce((select max(id) from public.litalerts_competitor_observations), 0),
  true
);

commit;

analyze public.litalerts_competitor_observations;
