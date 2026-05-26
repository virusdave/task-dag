-- Migration 030: metric_annotations
--
-- Adds the metric_annotations table that backs the operator
-- annotation surface on the Helios `/metrics` page tree (P0 of
-- automation#21, satisfying virusdave/top-level#7). See the
-- schema file for full column rationale and constraints.
--
-- Idempotent: the schema file uses `create ... if not exists`
-- everywhere, so this migration is safe to re-run.

\echo 'Running migration 030: metric_annotations...'

\i ../schema/metricAnnotations.sql

\echo 'Migration 030 complete.'
