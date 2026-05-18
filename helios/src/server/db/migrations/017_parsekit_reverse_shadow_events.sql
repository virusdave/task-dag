-- Migration 017: Parsekit Reverse-Shadow Event Log
-- Adds the parsekit_reverse_shadow_events table the worker appends to
-- whenever the new parsekit parser disagrees with the legacy waterfall
-- (regression_diff, regression_unmatched, legacy_threw).

\echo 'Running migration 017: Parsekit Reverse-Shadow Event Log...'

\i ../schema/parsekitReverseShadowEvents.sql

\echo 'Migration 017 complete.'
