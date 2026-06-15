-- Per-segment membership-refresh highwater for the Helios segment
-- details page (virusdave/top-level#12).
--
-- WHY: snapshotSegmentMembers() is write-on-change (migration 080 +
-- DB-efficiency review) — unchanged member rows intentionally keep
-- their old `refreshed_at`, so `max(sweed_customer_segments.refreshed_at)`
-- is NOT a truthful "last refreshed this segment" timestamp. This single
-- row per segment records the authoritative refresh status the details
-- page shows ("Membership cache refreshed … · N members cached"), the
-- same way sweed_customer_segments_refresh does for the per-customer
-- path. Written only by the per-segment refresh job (manual, operator-
-- triggered); read on page load via a PK lookup.

\echo 'Running migration 081: sweed_segment_membership_refresh...'

create table if not exists sweed_segment_membership_refresh (
  segment_id   bigint  primary key,
  status       text    not null
                 check (status in ('pending', 'ok', 'failed')),
  requested_at timestamptz,
  refreshed_at timestamptz,
  member_count integer not null default 0,
  last_error   text,
  updated_at   timestamptz not null default now()
);

\echo 'Migration 081 complete.'
