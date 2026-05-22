-- Migration 023: Customer-Sentiment Capture (A2 — LLM gate columns)
--
-- Appends llm_verdict / degraded_pass / llm_raw / llm_model_ref /
-- llm_at + review_provider_url to review_submissions so the A2 LLM
-- gate can persist its classification + the resolved per-site
-- review-provider paste-text URL on each capture POST.
--
-- See helios/src/server/db/schema/customerReviewsLlmGate.sql for
-- column comments and rationale. Idempotent (`add column if not
-- exists`).
--
-- Satisfies: virusdave/top-level#3

\echo 'Running migration 023: Customer-Sentiment Capture (A2 LLM-gate columns)...'

\i ../schema/customerReviewsLlmGate.sql

\echo 'Migration 023 complete.'
