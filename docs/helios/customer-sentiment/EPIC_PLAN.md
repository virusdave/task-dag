# Customer-Sentiment Capture — Helios slice

Owning child of [virusdave/top-level#3]. Parent design lives in that
top-level repo at `docs/epics/customer-sentiment/EPIC_PLAN.md`; the
authoritative scope for this repo is captured in
[issue #13](https://github.com/FreshlyBakedNYC/automation/issues/13).

Every implementation commit that lands on `automation` master and
satisfies any part of this child epic MUST carry the trailer:

```
Satisfies: virusdave/top-level#3
```

so the top-level coordinator's `cross-repo-completion-sync.yml`
ingests it as a completion ref.

## Phase status

| Phase | Status | Notes |
| ----- | ------ | ----- |
| A1 — DB schema + skeleton submission API + read-only `/reviews` list | **shipped** | Migration 022, `POST /v1/reviews/submit`, `POST /v1/reviews/<id>/drawing-entry`, `GET /api/customer-reviews`, `/reviews` SPA page. Gated server-side by `HELIOS_REVIEWS_CAPTURE_V1`, per-site by `site_review_settings.review_drawing_enabled`. |
| A2 — LLM sentiment + suitability gate, degraded heuristic, P3 page on error | **shipped** | Migration 023, `classifyReviewSentiment` + `computeDegradedPass` in [`reviews/reviewSentimentGate.ts`](../../../helios/src/server/llm/reviewSentimentGate.ts). Submit handler wires in the gate + page-Dave-on-error. |
| A3 — Email pipeline + templates (negative / lukewarm / strong-with-text) | **shipped** | Templates under [`helios/email_templates/reviews/`](../../../helios/email_templates/reviews/). Pipeline in [`helios/src/server/reviews/emailPipeline.ts`](../../../helios/src/server/reviews/emailPipeline.ts) + [`smtpSender.ts`](../../../helios/src/server/reviews/smtpSender.ts). Sender `reviews@freshlybaked.us` (env: `REVIEWS_EMAIL_FROM`). When `REVIEWS_SMTP_HOST` is unset, sends queue with `send_status='queued'` so the operator UI surfaces the would-be send while we wait on `nixos-sbc` provisioning the mailbox; when set, attempts a minimal plain-TCP SMTP exchange and records `'sent'` / `'failed'` with the error captured. Resend exposed at `POST /api/customer-reviews/<id>/resend-email`. |
| A4 — Sweed integration (customers + segments) | **shipped** | Migration 024 + `helios/src/worker/sweed/customers.ts` (find/create client + segment add/remove) + drawing-entry route now fires segment-add (drawing always when id non-null; free-preroll only on `strong-with-text`/degraded + `acceptedPasteOffer=true`). New `/reviews/<id>` SPA detail page exposes acknowledge, re-run-LLM, force-add/remove (per segment), mark-fraudulent (auto-removes from both per-site segments). Midtown segment ids: drawing `8669`, free-preroll `8666`. |
| A5 — `/reviews/drawing` exportable list + acknowledge workflow | not started | Detail-page actions: acknowledge, resend-email, re-run-llm, force-add/remove-segment, mark-fraudulent. |

## A1 surface (shipped) — orientation

- **DB schema** —
  [`helios/src/server/db/schema/customerReviews.sql`](../../../helios/src/server/db/schema/customerReviews.sql)
  defines `site_review_settings`, `review_submissions`,
  `review_contact_info`, `review_drawing_entries`, `review_emails`.
  `site_review_settings` is seeded with the Midtown row (dealer
  `210705`); Bronx left NULL until that site rolls out.
- **Migration** —
  [`022_customer_reviews_capture.sql`](../../../helios/src/server/db/migrations/022_customer_reviews_capture.sql).
  Re-runnable.
- **Contracts** —
  [`helios/src/shared/contracts/api/customerReviews.ts`](../../../helios/src/shared/contracts/api/customerReviews.ts).
- **Routes** —
  [`helios/src/server/routes/customerReviews.ts`](../../../helios/src/server/routes/customerReviews.ts)
  registers the two public POSTs and the internal list GET.
- **Auth gate** — public POSTs added to
  [`helios/src/server/auth/authGate.ts`](../../../helios/src/server/auth/authGate.ts)'s
  allowlist (plus a new prefix-match table for the per-submission
  drawing-entry path).
- **SPA page** —
  [`helios/src/client/routes/customerReviews/CustomerReviewsListPage.tsx`](../../../helios/src/client/routes/customerReviews/CustomerReviewsListPage.tsx)
  renders the read-only submissions table. Per `helios/AGENTS.md` the
  methodology + remaining-phases blurb is collapsed inside `<details>`
  so the table is the only default-visible content.
- **Feature flag** — `HELIOS_REVIEWS_CAPTURE_V1` (server-level).

## Cross-repo dependencies

- A3 needs `nixos-sbc` to provision the `reviews@freshlybaked.us`
  mailbox + DKIM/SPF before emails can actually deliver.
- A4 + A5 only become observable to real customers once
  `mostly-static-sites` lands the public landing page that POSTs to
  `/v1/reviews/submit`. A1 + A2 can be exercised end-to-end with
  `curl` against helios staging until then.
- Sweed-side segment / promo definitions are operator-manual,
  prerequisite to A4 going live but not to A4 code landing.

## Completion signal

This child epic is considered complete when:

1. All five A-phases have landing commits on `automation`'s master
   carrying `Satisfies: virusdave/top-level#3`.
2. The Helios `/reviews` and `/reviews/drawing` routes are accessible.
3. Midtown-site submissions flow end-to-end in a smoke test (see
   issue #13 for the two scenarios — 5★+text and 5★ no-text).
