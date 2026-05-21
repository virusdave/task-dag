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

-- Per-photo focal-point cache for the public "Meet The Team" tiles.
--
-- Why this exists:
--   The public-page CSS crops each staff portrait with
--   `object-fit: cover`. Without an explicit focal point, the
--   geometric center wins, which clips heads off portraits where
--   the subject is not framed dead center (a common condition for
--   auto-imported POS headshots that no human curator framed).
--   This table caches a per-image focal point (computed once by the
--   private LLM in the helios worker) so the public renderer can
--   emit `object-position: <x*100>% <y*100>%` and keep the face in
--   frame.
--
-- Append-only by convention. Keys on the UUID portion of the Sweed
-- photo URL (which is stable per image but changes on every Sweed
-- re-upload). Old rows for replaced photos stay forever, but they
-- are tiny and the read path joins on the *current* photo_url so
-- they cause no harm.
--
-- See helios/src/server/staff/staffPhotoFocalPoint.ts for the
-- writer and helios/src/server/db/queries/staffQueries.ts for the
-- public-route join.
create table if not exists staff_photo_focal_points (
  sweed_uuid   text primary key,
  sweed_url    text not null,
  x            double precision not null check (x >= 0 and x <= 1),
  y            double precision not null check (y >= 0 and y <= 1),
  confidence   double precision not null check (confidence >= 0 and confidence <= 1),
  model        text not null,
  rationale    text,
  computed_at  timestamptz not null default now()
);

-- Lookup-by-URL is what the public-team join uses (current Sweed
-- URL → focal point). Cheap secondary index over the sparse table.
create index if not exists staff_photo_focal_points_sweed_url_idx
  on staff_photo_focal_points (sweed_url);
