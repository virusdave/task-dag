-- Down for 080: revert the composable-predicate columns/constraints back
-- to the 079 single-shape geofence model.
--
-- Removes `predicate_json` and its CHECKs, restores the
-- single-enabled-per-(site,trigger,segment) unique index, and drops the
-- non-unique lookup index added in 080.
--
-- NOTE: this does NOT re-add the NOT NULL constraints on
-- center_lat/center_lng/radius_feet — any zip-only/state-only rules
-- created after 080 would have NULLs there and the re-add would fail.
-- Re-NOT-NULL by hand only after confirming every row has a geofence.
-- Only run this after rolling the worker/server back to an 079-era build
-- that does not read `predicate_json`.

\set ON_ERROR_STOP on
\timing on

begin;
set local lock_timeout = '5s';

drop index if exists geo_segment_rules_active_target_idx;

-- Restore 079's at-most-one-enabled-rule-per-target uniqueness.
create unique index if not exists geo_segment_rules_one_enabled_idx
  on geo_segment_rules (site_slug, trigger, segment_id)
  where enabled;

alter table geo_segment_rules
  drop constraint if exists geo_segment_rules_enabled_predicates_chk;
alter table geo_segment_rules
  drop constraint if exists geo_segment_rules_predicate_shape_chk;

alter table geo_segment_rules
  drop column if exists predicate_json;

commit;

\echo 'Migration 080 down complete.'
