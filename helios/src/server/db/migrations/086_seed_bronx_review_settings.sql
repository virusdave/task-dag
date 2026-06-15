-- Migration 086: Customer-Sentiment Capture - Bronx site launch
--
-- Seeds the per-site review configuration for the Bronx storefront
-- (Sweed dealer_id 210249) into site_review_settings so the public
-- review page at https://freshlybaked.nyc/go/bx/review works end to
-- end. Bronx mirrors the Midtown (dealer 210705) pilot that was wired
-- up in migration 022 + subsequent operator DB edits.
--
-- Two-phase rollout (see packages/config/src/reviews.ts in
-- mostly-static-sites): this migration is phase 1. The mostly-static-
-- sites Bronx page ships with reviewPageEnabled:false until THIS row
-- exists in prod, because POST /v1/reviews/submit returns 404
-- ("Unknown site dealer_id") when getSiteReviewSettings finds no row.
-- After applying this migration and confirming the row, flip the mss
-- bx.reviewPageEnabled flag to true and deploy mostly-static-sites to
-- both VPS nodes (phase 2).
--
-- Field provenance:
--   review_provider_url_template - Bronx Google business review link
--     supplied by the operator: https://g.page/r/CVvrYxFQkCZDEAE/review
--     (NOTE: differs from the pre-existing /google-review-retail
--      redirect, which targets .../CVvrYxFQkCZDEB0/review - suffix B0
--      vs AE. Flagged for operator reconciliation; this migration uses
--      the operator-supplied AE form for the review page.)
--   sweed_drawing_segment_id      - 10291 ("preroll raffle" drawing,
--     always added on drawing-form submit). Midtown analogue: 8669.
--   sweed_free_preroll_segment_id - 10292 ("eligible for free preroll
--     on next visit", added only on strong-with-text + paste-accepted).
--     Midtown analogue: 8666.
--   review_email_*                - Bronx contact aliases. Confirm these
--     mailboxes exist (operations-bronx@ / support-bronx@) so negative /
--     lukewarm escalation email does not bounce.
--   review_drawing_enabled        - true: enables the raffle/drawing
--     path (matches live Midtown).
--   review_llm_gate_enabled       - true: enables the LLM sentiment gate
--     (matches live Midtown).
--   review_free_preroll_enabled   - false, to exactly mirror the live
--     Midtown row. This column is currently a NO-OP in the route logic:
--     the free-preroll segment add is gated solely by
--     sweed_free_preroll_segment_id being non-null + the LLM verdict +
--     the customer accepting the paste offer (see
--     customerReviews/segmentOrchestrator.ts shouldAttemptFreePreroll),
--     NOT by this flag. So free preroll still functions for Bronx via
--     segment 10292 regardless; we keep the flag false purely for
--     row-level parity with Midtown and to avoid implying behavior the
--     flag does not control.
--
-- Idempotent: INSERT ... ON CONFLICT (dealer_id) DO UPDATE refreshes
-- only the launch-critical config (provider URL/kind, feature flags,
-- segment ids, label) and updated_at. It deliberately does NOT clobber
-- contact emails on re-run, so a later operator email edit survives a
-- re-apply. Safe to re-run.

\echo 'Running migration 086: seed Bronx review settings (dealer 210249)...'

insert into site_review_settings (
  dealer_id,
  site_label,
  review_provider_kind,
  review_provider_url_template,
  review_email_dave,
  review_email_support,
  review_email_ops,
  review_drawing_enabled,
  review_free_preroll_enabled,
  review_llm_gate_enabled,
  sweed_drawing_segment_id,
  sweed_free_preroll_segment_id,
  updated_at
) values (
  210249,
  'Bronx',
  'google',
  'https://g.page/r/CVvrYxFQkCZDEAE/review',
  'dave@freshlybaked.nyc',
  'support-bronx@freshlybaked.nyc',
  'operations-bronx@freshlybaked.nyc',
  true,   -- review_drawing_enabled  (matches Midtown)
  false,  -- review_free_preroll_enabled  (no-op flag; mirrors Midtown)
  true,   -- review_llm_gate_enabled  (matches Midtown)
  10291,
  10292,
  now()
)
on conflict (dealer_id) do update set
  site_label                    = excluded.site_label,
  review_provider_kind          = excluded.review_provider_kind,
  review_provider_url_template  = excluded.review_provider_url_template,
  review_drawing_enabled        = excluded.review_drawing_enabled,
  review_free_preroll_enabled   = excluded.review_free_preroll_enabled,
  review_llm_gate_enabled       = excluded.review_llm_gate_enabled,
  sweed_drawing_segment_id      = excluded.sweed_drawing_segment_id,
  sweed_free_preroll_segment_id = excluded.sweed_free_preroll_segment_id,
  updated_at                    = now();

\echo 'Migration 086 complete.'
