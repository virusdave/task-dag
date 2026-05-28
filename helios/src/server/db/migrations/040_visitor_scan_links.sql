-- 040_visitor_scan_links.sql
--
-- Customer / Visitor Address Ingestion Pipeline (virusdave/top-level#9,
-- child epic FreshlyBakedNYC/automation#31, phase A4 — "first time"
-- indicator + Sweed-customer link surfaced on /admin/visitors/scans).
--
-- Schema for the scan -> Sweed CRM customer linking pipeline + the
-- local "person_key" derivation that powers first-vs-returning
-- without needing a Sweed match.
--
-- Three changes (all idempotent):
--
--   1. Add `visitor_scans.person_key` text column + helpful indexes
--      so the API can answer "is this the same person we've scanned
--      before?" locally (no Sweed RPC required). The key is a
--      normalised concat of first/last name + birth_date + state +
--      zip5 — strong enough that a returning customer carrying the
--      same driver's license produces a stable key, weak enough
--      that minor punctuation/whitespace differences collapse.
--
--   2. Create `visitor_scan_links` — one row per scan, holding the
--      Sweed CRM linkage outcome (pending / ambiguous / linked /
--      no_match / failed / rejected / insufficient_data) plus the
--      next_probe_at backoff schedule the background worker uses
--      to re-attempt Sweed lookups. Seeded by the
--      `insertVisitorScan` helper at webhook/backfill insert time
--      so the worker can simply pick up due rows.
--
--   3. Create `visitor_scan_link_candidates` — cached fuzzy
--      candidates from `store.customer.list` so an operator can
--      confirm/reject ambiguous matches from the customer-details
--      page without re-probing Sweed every visit.
--
-- No drop / replace. Safe to re-run.

\echo 'Running migration 040: visitor_scan_links / person_key...'

-- ---------------------------------------------------------------------
-- 1) visitor_scans.person_key
-- ---------------------------------------------------------------------
alter table visitor_scans
  add column if not exists person_key text;

-- Backfill existing rows. Generated expression mirrors what the
-- Node insert helper computes for new rows in
-- helios/src/server/db/queries/visitorScansQueries.ts.
update visitor_scans
set person_key = nullif(
  concat_ws(
    '|',
    nullif(
      lower(
        regexp_replace(
          trim(both ' ' from coalesce(first_name, '') || ' ' || coalesce(last_name, '')),
          '\s+', ' ', 'g'
        )
      ),
      ''
    ),
    coalesce(to_char(birth_date, 'YYYY-MM-DD'), ''),
    upper(coalesce(state, '')),
    left(regexp_replace(coalesce(postal_code, ''), '[^0-9]', '', 'g'), 5)
  ),
  '|||'  -- all-empty → null (concat_ws drops empty strings except separators)
)
where person_key is null
  and (first_name is not null or last_name is not null);

-- Hard guard: never index against the placeholder.
update visitor_scans
set person_key = null
where person_key = '|||' or person_key = '';

create index if not exists visitor_scans_person_key_time_idx
  on visitor_scans (provider, person_key, coalesce(scanned_at, ingested_at) desc)
  where person_key is not null;

create index if not exists visitor_scans_id_num_idx
  on visitor_scans (provider, id_num)
  where id_num is not null;

-- ---------------------------------------------------------------------
-- 2) visitor_scan_links
-- ---------------------------------------------------------------------
create table if not exists visitor_scan_links (
  scan_id              bigint primary key references visitor_scans(id) on delete cascade,

  -- Pinned at insert time from `visitor_scans.site_slug` -> dealer_id
  -- via the per-slug mapping in
  -- helios/src/shared/contracts/domain/pendingPurchases.ts +
  -- visitorScans/dealerForSiteSlug.ts. Storing it here means the
  -- worker doesn't have to re-derive on every tick.
  dealer_id            bigint not null,

  -- Resolved Sweed CRM customer once we have one. NULL until the
  -- link transitions to 'linked'.
  sweed_customer_id    bigint,

  -- See helios/src/shared/contracts/api/visitorScanLinks.ts for the
  -- canonical TypeScript union of these strings.
  link_status          text not null default 'pending',
  link_method          text,
  confidence           numeric(5,4),

  linked_at            timestamptz,
  confirmed_by_user_id bigint,

  -- Background-worker schedule + audit.
  last_probed_at       timestamptz,
  next_probe_at        timestamptz not null default now(),
  probe_count          integer not null default 0,
  probe_failed_count   integer not null default 0,
  last_error           text,

  -- The exact strings the worker searched (id_num, full name, etc.)
  -- captured per attempt so an operator can reproduce the probe.
  lookup_terms         jsonb not null default '{}'::jsonb,
  -- The full Sweed customer envelope at the time of auto/operator
  -- link, for provenance.
  raw_match            jsonb,

  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  constraint visitor_scan_links_status_chk check (
    link_status in (
      'pending',
      'ambiguous',
      'linked',
      'no_match',
      'failed',
      'rejected',
      'insufficient_data'
    )
  )
);

create index if not exists visitor_scan_links_due_idx
  on visitor_scan_links (next_probe_at, link_status)
  where link_status in ('pending', 'failed');

create index if not exists visitor_scan_links_sweed_customer_idx
  on visitor_scan_links (dealer_id, sweed_customer_id)
  where sweed_customer_id is not null;

create index if not exists visitor_scan_links_status_idx
  on visitor_scan_links (link_status, updated_at desc);

-- Backfill: every existing visitor_scan should have a link row. We
-- bx/mh map below mirrors the constants in pendingPurchases.ts; if
-- a future site is added, this migration won't seed it, but the
-- Node insert helper will create the link row going forward.
insert into visitor_scan_links (scan_id, dealer_id, link_status, next_probe_at)
select
  v.id,
  case v.site_slug
    when 'bx' then 210249
    when 'mh' then 210705
    else null
  end as dealer_id,
  case
    when nullif(trim(both ' ' from coalesce(v.id_num, '')), '') is null
     and nullif(
           trim(both ' ' from coalesce(v.first_name, '') || ' ' || coalesce(v.last_name, '')),
           ''
         ) is null
      then 'insufficient_data'
    else 'pending'
  end as link_status,
  now()
from visitor_scans v
where (case v.site_slug
         when 'bx' then 210249
         when 'mh' then 210705
         else null
       end) is not null
on conflict (scan_id) do nothing;

-- ---------------------------------------------------------------------
-- 3) visitor_scan_link_candidates
-- ---------------------------------------------------------------------
create table if not exists visitor_scan_link_candidates (
  id                 bigserial primary key,
  scan_id            bigint not null references visitor_scans(id) on delete cascade,
  dealer_id          bigint not null,
  sweed_customer_id  bigint not null,

  candidate_status   text not null default 'open',
  match_method       text not null,
  score              numeric(5,4) not null default 0,
  reasons            text[]       not null default '{}',

  display_name       text,
  display_address    text,
  display_phone      text,
  display_email      text,

  source_search      text not null,
  raw_candidate      jsonb not null,

  first_seen_at      timestamptz not null default now(),
  last_seen_at       timestamptz not null default now(),

  constraint visitor_scan_link_candidates_status_chk check (
    candidate_status in ('open', 'confirmed', 'rejected')
  ),

  unique (scan_id, dealer_id, sweed_customer_id)
);

create index if not exists visitor_scan_link_candidates_scan_idx
  on visitor_scan_link_candidates (scan_id, candidate_status, score desc);

create index if not exists visitor_scan_link_candidates_customer_idx
  on visitor_scan_link_candidates (dealer_id, sweed_customer_id);

\echo 'Migration 040 complete.'
