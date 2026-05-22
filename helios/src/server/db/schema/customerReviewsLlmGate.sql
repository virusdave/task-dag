-- Customer-Sentiment Capture (issue #13, A2 phase)
--
-- Adds the LLM-verdict columns to review_submissions plus a
-- review_provider_url column that records the final paste-text URL
-- the customer was offered on the strong-with-text path (resolved
-- via the per-site review_provider_url_template). All A1 columns
-- already exist; A2 strictly appends.
--
-- See helios/src/server/llm/reviewSentimentGate.ts for the
-- private-LLM call that fills these columns and the operator-settled
-- degraded-pass heuristic that fires on llm_verdict='error'. The
-- HTTP submit handler in routes/customerReviews.ts orchestrates the
-- call + persistence + Dave-page.
--
-- Idempotent (add column if not exists).

alter table review_submissions
  add column if not exists llm_verdict      text
    check (llm_verdict in ('strong-with-text','strong-no-text','lukewarm','negative','error')),
  add column if not exists degraded_pass    boolean,
  add column if not exists llm_raw          jsonb,
  add column if not exists llm_model_ref    text,
  add column if not exists llm_at           timestamptz,
  -- Final substituted paste-text URL the customer was offered on the
  -- strong-with-text path. NULL when no offer was made (verdict not
  -- in the offer-eligible bucket, or per-site
  -- review_provider_url_template is unset). Stored verbatim so the
  -- operator /reviews/<id> page can show exactly which URL the
  -- customer would have visited.
  add column if not exists review_provider_url text;

create index if not exists review_submissions_llm_verdict_idx
  on review_submissions (llm_verdict)
  where llm_verdict is not null;
