-- Migration 041: pending_purchase_rows.edited_structured_fields
--
-- Adds a JSONB column that captures reviewer overrides for the
-- 9 *structured* product-classification fields that the LLM teacher
-- most often misclassifies on pending-purchase rows:
--
--   targetBrand, targetGroupName, expectedCategory, expectedSubcategory,
--   targetSize, targetPackCount, targetVariantName, targetVariantTab,
--   targetStrainName
--
-- Stored as a sparse partial object so per-field nullability is
-- preserved (a key being present means "the reviewer set this to
-- the given value, even if null"; a key being absent means "no
-- override, fall back to the parser/LLM value"). The applier reads
-- the overrides via a single `effectiveStructuredFields` helper that
-- mirrors how `effective_proposed_price` /
-- `effective_proposed_description` work today.
--
-- Idempotent: uses `add column if not exists`, safe to re-run.
--
-- Backs FreshlyBakedNYC/automation#35 ("Catalog → Pending Purchases:
-- reuse canonical product-review row, editable structured data,
-- collapse-on-decision"). Without this column the `PATCH
-- /api/catalog/pending-purchases/:rowId` endpoint silently drops the
-- new `editedStructuredFields` body field, and the worker still
-- writes the parser's misclassified taxonomy to Sweed even after the
-- reviewer "fixes" it inline.

\echo 'Running migration 041: pending_purchase_rows.edited_structured_fields…'

alter table pending_purchase_rows
  add column if not exists edited_structured_fields jsonb;

comment on column pending_purchase_rows.edited_structured_fields is
  'Reviewer overrides for the LLM/parser-supplied structured taxonomy '
  '(targetBrand, targetGroupName, expectedCategory, expectedSubcategory, '
  'targetSize, targetPackCount, targetVariantName, targetVariantTab, '
  'targetStrainName). Sparse: key present = override, key absent = use '
  'the parsed value. Consumed by applyPendingPurchaseRequestJob via the '
  'effectiveStructuredFields helper. See issue #35.';

\echo 'Migration 041 complete.'
