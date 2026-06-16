-- Helios-local "retirement" of Sweed marketing segments
-- (/config/marketing/segments directory + details page).
--
-- WHY: the operator accumulates test / junk Sweed segments that should
-- vanish from every Helios surface (pickers, lenses, chips, customer
-- membership lists) without being deleted in Sweed. Disabled-in-Sweed
-- segments are already treated as out-of-service; this table lets the
-- operator semi-permanently hide additional (still-enabled) segments
-- from Helios too. A segment is "retired" iff it is disabled in Sweed
-- (sweed_marketing_segments.enabled = false) OR has a row here.
--
-- This is deliberately a SEPARATE table, not a column on
-- sweed_marketing_segments: that table is a faithful cache of Sweed's
-- catalog and snapshotMarketingCatalog() DELETEs rows that leave the
-- catalog, which would silently drop a retirement. A standalone PK table
-- survives catalog churn and can even retire a segment not (yet) in the
-- catalog. There is intentionally NO FK to sweed_marketing_segments.
--
-- Read on the segment directory/details + every segment-listing query as
-- a PK anti-join (`not exists … where r.segment_id = c.segment_id`);
-- written only by the operator's retire/unretire buttons. Tiny table.

\set ON_ERROR_STOP on

\echo 'Running migration 089: sweed_marketing_segment_retirement...'

create table if not exists sweed_marketing_segment_retirement (
  segment_id         bigint primary key,
  retired_at         timestamptz not null default now(),
  retired_by_user_id bigint references users(id) on delete set null,
  note               text
);

\echo 'Migration 089 complete.'
