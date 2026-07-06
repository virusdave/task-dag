-- Migration 097: litalerts_parse_feedback
--
-- Adds the INERT operator parse-correction feedback inbox that backs the
-- brand-categorical-family market-match audit panel (issue #59, task T3). See
-- helios/src/server/db/schema/litalertsParseFeedback.sql for full column
-- rationale, constraints, and the "this is NOT a live parser" invariant.
--
-- Cost/plan: brand-new, starts EMPTY, and grows only on explicit operator save
-- (human-driven — a handful of rows/day at most; no background writer). Every
-- read is a bounded point/IN lookup on a partial index (by fuzzy_sku_id,
-- retailer_id, source_listing_id) or by uuid PK; writes are single-row
-- inserts/updates inside a short transaction. No scheduled/recurring workload,
-- no JSON-column-wide scans (the small `details` payload is always fully
-- consumed and never filtered on in SQL). Well within the interactive budgets.
--
-- Forward-only, additive, idempotent — the schema file uses
-- `create ... if not exists` everywhere, so this migration is safe to re-run.

\set ON_ERROR_STOP on

\echo 'Running migration 097: litalerts_parse_feedback...'

-- `\ir` resolves the include relative to THIS file, so the operator can apply
-- the migration from any cwd (unlike `\i`, which is cwd-relative).
begin;
\ir ../schema/litalertsParseFeedback.sql
commit;

\echo 'Migration 097 complete.'
