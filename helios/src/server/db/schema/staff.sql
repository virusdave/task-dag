-- Staff Directory + Inclusion (Utilities → Staff)
--
-- Two tables, intentionally separated:
--
-- 1. staff_directory_cache: an upstream snapshot of the Sweed
--    `user.compliance.list` response on the state-level dealer.
--    Refreshed on demand from the Helios Utilities → Staff page (or
--    any future scheduled refresh job). Truth-of-record is Sweed, so
--    this whole table can be wiped and re-fetched without losing
--    operator intent.
--
-- 2. staff_inclusion: human editorial decision about whether each
--    employee should appear on the public "Meet The Team" surface.
--    Survives across refreshes of staff_directory_cache so a
--    refresh never clobbers an operator's prior approve/reject
--    decision.
--
-- The first time a brand-new staff_id appears (i.e. no row yet in
-- staff_inclusion), the refresh job seeds it as:
--   * 'unapproved' when photo_url is non-empty
--   * 'rejected'   when photo_url is null/empty
-- Existing rows are NEVER overwritten by refresh.

create table if not exists staff_directory_cache (
  staff_id            text primary key,
  -- whole raw row from Sweed user.compliance.list .data[*], for
  -- forward-compatibility and admin debugging.
  raw                 jsonb not null,
  -- Denormalized projections for cheap querying / display.
  full_name           text not null,
  first_name          text not null,
  last_name           text,
  email               text,
  photo_url           text,
  current_dealer_id   integer,
  current_dealer_name text,
  blocked             boolean not null default false,
  user_status         integer,
  fetched_at          timestamptz not null default now()
);

create index if not exists staff_directory_cache_first_name_idx
  on staff_directory_cache (first_name);

create table if not exists staff_inclusion (
  staff_id    text primary key,
  -- 'unapproved' (default for new with-photo) | 'approved' | 'rejected'
  status      text not null check (status in ('unapproved', 'approved', 'rejected')),
  decided_at  timestamptz not null default now(),
  decided_by  text,
  notes       text
);

create index if not exists staff_inclusion_status_idx
  on staff_inclusion (status);
