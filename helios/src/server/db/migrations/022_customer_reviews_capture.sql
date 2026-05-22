-- Migration 022: Customer-Sentiment Capture (A1 phase, issue #13)
--
-- Adds the A1 surface for the Customer-Sentiment Capture child epic:
-- site_review_settings, review_submissions, review_contact_info,
-- review_drawing_entries, and review_emails — plus the Midtown
-- pilot seed row in site_review_settings.
--
-- A2 (LLM gate), A3 (email pipeline), A4 (Sweed segment add), and
-- A5 (drawing export + acknowledge) will land additional migrations
-- that extend these tables in place.  See
-- helios/src/server/db/schema/customerReviews.sql for full column
-- comments and rationale, and the issue body for the phase plan.
--
-- Idempotent: the schema file uses `create ... if not exists`
-- everywhere and the seed uses `on conflict do nothing`, so this
-- migration is safe to re-run.

\echo 'Running migration 022: Customer-Sentiment Capture (A1)...'

\i ../schema/customerReviews.sql

\echo 'Migration 022 complete.'
