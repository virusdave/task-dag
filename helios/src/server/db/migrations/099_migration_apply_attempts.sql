-- Migration 099: migration_apply_attempts
--
-- Adds the lifecycle table that backs the admin "Apply Now" pending-migrations
-- flow (issue #62, leaf 2). See
-- helios/src/server/db/schema/migrationApplyAttempts.sql for full column
-- rationale, states, and the canon-step-7 audit invariant.
--
-- Bootstrap note: this table is applied via the current manual/canon apply path
-- because the apply feature cannot apply its own bootstrap. No button, no
-- worker execution is introduced by this migration — it is purely additive
-- schema.
--
-- Cost/plan: brand-new, starts EMPTY, and grows one row per operator-initiated
-- migration apply (a rare, human-driven action — a handful of rows ever). Reads
-- are point lookups by uuid PK or a bounded "latest per migration_id" index
-- scan. No background writer, no scheduled workload. Trivially within the
-- interactive budgets.
--
-- Forward-only, additive, idempotent — the schema file uses
-- `create ... if not exists` everywhere, so this migration is safe to re-run.

\set ON_ERROR_STOP on

\echo 'Running migration 099: migration_apply_attempts...'

-- `\ir` resolves the include relative to THIS file, so the operator can apply
-- the migration from any cwd (unlike `\i`, which is cwd-relative).
begin;
\ir ../schema/migrationApplyAttempts.sql
commit;

\echo 'Migration 099 complete.'
