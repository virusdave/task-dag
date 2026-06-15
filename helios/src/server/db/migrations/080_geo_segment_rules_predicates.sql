-- 080_geo_segment_rules_predicates.sql
--
-- Phase 1 of the composable auto-segmentation engine: turn the narrow,
-- single-shape `geo_segment_rules` (migration 079) into a COMPOSABLE
-- rule language. Each rule gains a `predicate_json` AST — a versioned
-- AND-list of typed, scan-safe predicates (geofence, zip5_in,
-- us_state_in, scan_time_window, first_scan_in_days, age_range,
-- gender_in). The AST becomes the source of truth; the original 079
-- columns (center_*, radius_feet, since, reactivation_days) are kept
-- ONLY as deprecated mirrors for the backfill CLI and existing geofence
-- rules. See docs/helios/customer-segmentation/GEO_SEGMENT_RULES_DESIGN.md
-- and helios/src/shared/contracts/api/geoSegmentRules.ts (the zod AST).
--
-- DB cost (canon rules/DB_PERFORMANCE.md): `geo_segment_rules` is a tiny
-- config table (single-/double-digit rows). This migration is pure DDL
-- + a one-row backfill: add a jsonb column (fast metadata op, default
-- applied lazily on read in PG11+), one bounded UPDATE, three NOT-NULL
-- relaxations (metadata ops), two shallow CHECKs, and an index swap. No
-- table rewrite, no large scan. The dropped unique index is replaced by
-- a non-unique partial lookup index (composable rules legitimately let
-- multiple enabled rules target the same site+trigger+segment).
--
-- Idempotent: column add is `if not exists`; the backfill only touches
-- rows still carrying the empty-AST default; constraints use
-- drop-if-exists+add; indexes use if-(not-)exists.

\set ON_ERROR_STOP on
\echo 'Running migration 080: geo_segment_rules predicate AST...'

begin;
set local lock_timeout = '5s';

-- 1. The composable rule definition. Empty default = "no conditions"
--    (only valid for a disabled draft; the enabled-nonempty CHECK below
--    forbids an enabled empty rule).
alter table geo_segment_rules
  add column if not exists predicate_json jsonb not null
    default '{"version":1,"op":"and","predicates":[]}'::jsonb;

-- 2. Backfill the existing 079-shaped rules into an equivalent AST:
--      * the mandatory geofence  -> {kind:'geofence', ...}
--      * first_scan reactivation -> {kind:'first_scan_in_days', days}
--      * an optional `since`      -> {kind:'scan_time_window', since}
--    `since` is emitted as a UTC ISO-8601 'Z' string so it round-trips
--    through the zod `z.iso.datetime()` validator. Only rows still at
--    the empty default with a real geofence are touched, so re-running
--    (and rows already authored in AST form) are left alone.
update geo_segment_rules r
set predicate_json = jsonb_build_object(
  'version', 1,
  'op', 'and',
  'predicates',
    jsonb_build_array(
      jsonb_build_object(
        'kind', 'geofence',
        'centerLat', r.center_lat,
        'centerLng', r.center_lng,
        'radiusFeet', r.radius_feet
      )
    )
    || case
         when r.trigger = 'first_scan' and r.reactivation_days is not null
           then jsonb_build_array(
             jsonb_build_object('kind', 'first_scan_in_days', 'days', r.reactivation_days)
           )
         else '[]'::jsonb
       end
    || case
         when r.since is not null
           then jsonb_build_array(
             jsonb_build_object(
               'kind', 'scan_time_window',
               'since', to_char(r.since at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
             )
           )
         else '[]'::jsonb
       end
)
where r.predicate_json = '{"version":1,"op":"and","predicates":[]}'::jsonb
  and r.center_lat is not null
  and r.center_lng is not null
  and r.radius_feet is not null;

-- 3. Allow non-geofence rules (zip-only / state-only): the geofence is
--    now just one optional predicate, so its mirror columns are nullable.
alter table geo_segment_rules
  alter column center_lat  drop not null,
  alter column center_lng  drop not null,
  alter column radius_feet drop not null;

-- 4. Shallow structural CHECK (the full discriminated-union validation is
--    enforced by zod at the API boundary + re-parsed by the evaluator;
--    duplicating it in SQL would be brittle). Drop-then-add = idempotent.
alter table geo_segment_rules
  drop constraint if exists geo_segment_rules_predicate_shape_chk;
alter table geo_segment_rules
  add constraint geo_segment_rules_predicate_shape_chk check (
    jsonb_typeof(predicate_json) = 'object'
    and predicate_json ->> 'version' = '1'
    and predicate_json ->> 'op' = 'and'
    and jsonb_typeof(predicate_json -> 'predicates') = 'array'
    and jsonb_array_length(predicate_json -> 'predicates') <= 20
  );

-- An ENABLED rule must have at least one predicate, so a misconfigured
-- empty rule can never silently match every scan.
alter table geo_segment_rules
  drop constraint if exists geo_segment_rules_enabled_predicates_chk;
alter table geo_segment_rules
  add constraint geo_segment_rules_enabled_predicates_chk check (
    not enabled or jsonb_array_length(predicate_json -> 'predicates') > 0
  );

-- 5. Composable rules legitimately allow multiple enabled rules to target
--    the same (site, trigger, segment) — e.g. a geofence rule AND a
--    zip-set rule both feeding segment 10282. Drop the old uniqueness;
--    keep a NON-unique partial lookup index for the evaluator/admin.
drop index if exists geo_segment_rules_one_enabled_idx;
create index if not exists geo_segment_rules_active_target_idx
  on geo_segment_rules (site_slug, trigger, segment_id)
  where enabled;

commit;

-- Sanity: every enabled rule must now carry at least one predicate.
-- (Belt-and-braces; the CHECK above would already have aborted.)
\echo 'Verifying no enabled rule has an empty predicate AST (expect 0 rows):'
select id, site_slug, trigger, segment_id
  from geo_segment_rules
 where enabled
   and jsonb_array_length(predicate_json -> 'predicates') = 0;

\echo 'Migration 080 complete.'
