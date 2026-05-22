-- Migration 024: Customer-Sentiment Capture (A4 — Sweed integration)
--
-- Adds the per-segment Sweed add/remove outcome columns +
-- accepted_paste_offer + sweed_customer_id + fraudulent flag to
-- review_drawing_entries. Allowed values for the per-segment status
-- columns grow to include 'removed' (operator force-remove + the
-- automatic remove triggered by mark-fraudulent).
--
-- See helios/src/server/db/schema/customerReviewsSweedIntegration.sql
-- for column comments and rationale. Idempotent (`add column if not
-- exists` + DO blocks).
--
-- Satisfies: virusdave/top-level#3

\echo 'Running migration 024: Customer-Sentiment Capture (A4 Sweed integration)...'

\i ../schema/customerReviewsSweedIntegration.sql

\echo 'Migration 024 complete.'
