-- Migration 020: rename the misnomer whitelabel_pricing_snapshots table
-- to whiteglove_pricing_snapshots. The feature was originally landed
-- as "WhiteLabel" in migration 018 / the helios SPA, but the operator
-- corrected the product name to "WhiteGlove" (bespoke / large-order
-- quotes, not OEM private labeling). This migration renames the table
-- and its indexes in place to match the new canonical naming used
-- throughout the codebase from this commit forward.
--
-- Idempotent: each ALTER is wrapped in an "IF EXISTS" guard so an
-- environment that has already been renamed (or that never ran 018)
-- is safe to re-apply.

\echo 'Running migration 020: rename whitelabel_pricing_snapshots -> whiteglove_pricing_snapshots...'

ALTER TABLE  IF EXISTS whitelabel_pricing_snapshots
  RENAME TO whiteglove_pricing_snapshots;

ALTER INDEX  IF EXISTS whitelabel_pricing_snapshots_pkey
  RENAME TO whiteglove_pricing_snapshots_pkey;

ALTER INDEX  IF EXISTS whitelabel_pricing_snapshots_one_current
  RENAME TO whiteglove_pricing_snapshots_one_current;

ALTER INDEX  IF EXISTS whitelabel_pricing_snapshots_created_at
  RENAME TO whiteglove_pricing_snapshots_created_at;

ALTER SEQUENCE IF EXISTS whitelabel_pricing_snapshots_id_seq
  RENAME TO whiteglove_pricing_snapshots_id_seq;

-- If 018 was never applied in this environment, fall back to creating
-- the table directly from the canonical schema so 020 alone is
-- enough to bring a fresh DB up to date.
\i ../schema/whiteglovePricing.sql

\echo 'Migration 020 complete.'
