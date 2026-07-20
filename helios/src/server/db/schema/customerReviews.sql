-- Customer-Sentiment Capture (issue #13, A1 phase)
--
-- Helios-side capture tables for customer reviews submitted via the
-- mostly-static-sites public landing page.  See
-- docs/helios/customer-sentiment/EPIC_PLAN.md for the full design.
--
-- This file ships the A1 surface only:
--   - site_review_settings  - per-site feature config (LLM gate,
--                             provider URL template, contact emails,
--                             Sweed segment ids, etc.)
--   - review_submissions    - one row per public POST /v1/reviews/submit
--   - review_contact_info   - contact channel(s) the customer attached
--                             to a submission (1-N rows per submission)
--   - review_drawing_entries - drawing-form opt-ins (POST .../drawing-entry)
--   - review_emails         - outbound email log (populated by A3)
--
-- A2 will add LLM verdict columns to review_submissions in a follow-up
-- migration; A3-A5 will populate review_emails and add Sweed segment
-- result columns to review_drawing_entries.
--
-- All tables are guarded by `if not exists` so this file is safe to
-- re-run as part of the schema-replay path used by the test harness.

-- Per-site configuration.  Keyed by the canonical Sweed dealer_id.
-- One row per Freshly Baked NYC location.  Operator-edited via a
-- future /reviews/config admin surface (A2+); for A1 we seed Midtown
-- so the capture API has the IDs it needs to dispatch correctly.
create table if not exists site_review_settings (
  dealer_id                       integer primary key,
  site_label                      text not null,
  -- "google" | "yelp" | "other"
  review_provider_kind            text not null default 'google'
                                    check (review_provider_kind in ('google', 'yelp', 'other')),
  -- e.g. "https://search.google.com/local/writereview?placeid={place_id}"
  -- substituted at submission time from the per-site PlaceID source
  -- already present in this repo's history.  Nullable while operator
  -- finishes seeding.
  review_provider_url_template    text,
  -- Per-site contact emails for negative / lukewarm escalation (A3).
  review_email_dave               text,
  review_email_support            text,
  review_email_ops                text,
  -- Feature switches.  Default off so A1 cannot accidentally start
  -- accepting public submissions before the operator has explicitly
  -- enabled the site.
  review_drawing_enabled          boolean not null default false,
  review_free_preroll_enabled     boolean not null default false,
  review_llm_gate_enabled         boolean not null default false,
  -- Sweed segment ids the drawing + free-preroll paths add customers to
  -- (A4 will read these).  Bronx stays NULL until that site rolls out.
  sweed_drawing_segment_id        integer,
  sweed_free_preroll_segment_id   integer,
  created_at                      timestamptz not null default now(),
  updated_at                      timestamptz not null default now()
);

-- One row per submission accepted by POST /v1/reviews/submit.  The
-- raw_payload column preserves the full incoming JSON for debugging
-- and forward-compat as we extend the contract.
create table if not exists review_submissions (
  id                  uuid primary key default gen_random_uuid(),
  dealer_id           integer not null references site_review_settings(dealer_id),
  -- 1..5 star rating from the customer.  Nullable for partial
  -- submissions (e.g. drawing-only entries that never picked a star
  -- value), though the A1 contract requires it.
  star_rating         integer check (star_rating between 1 and 5),
  -- Free-text review the customer typed (may be empty / NULL).
  review_text         text,
  -- "form" | "drawing" | "other".  Disambiguates submissions that
  -- came in via the drawing-form CTA vs. the bare review form.
  submission_kind     text not null default 'form'
                        check (submission_kind in ('form', 'drawing', 'other')),
  -- Captured request metadata for fraud/abuse triage.
  source_ip           text,
  user_agent          text,
  referrer            text,
  -- Raw incoming POST body, preserved verbatim for replay/debug.
  raw_payload         jsonb not null,
  -- Operator-managed state.  A2 will add llm_verdict; A5 will add
  -- acknowledged_at / acknowledged_by.
  fraud_marked        boolean not null default false,
  fraud_marked_at     timestamptz,
  fraud_marked_by     text,
  created_at          timestamptz not null default now()
);

create index if not exists review_submissions_dealer_created_idx
  on review_submissions (dealer_id, created_at desc);
create index if not exists review_submissions_kind_idx
  on review_submissions (submission_kind);

-- Contact channels the customer attached to a submission.  1..N rows
-- per submission_id.  Kept separate from review_submissions so we can
-- carry both phone and email on one submission without nullable column
-- spam, and so /reviews/drawing exports can join cleanly in A5.
create table if not exists review_contact_info (
  id              uuid primary key default gen_random_uuid(),
  submission_id   uuid not null references review_submissions(id) on delete cascade,
  -- "phone" | "email" | "name" | "other"
  contact_kind    text not null
                    check (contact_kind in ('phone', 'email', 'name', 'other')),
  contact_value   text not null,
  created_at      timestamptz not null default now()
);

create index if not exists review_contact_info_submission_idx
  on review_contact_info (submission_id);
create index if not exists review_contact_info_kind_value_idx
  on review_contact_info (contact_kind, contact_value);

-- Drawing-form entries.  One row per POST .../drawing-entry call.
-- A4 will populate the segment_add_* columns when Sweed wiring lands;
-- for A1 the row is just a record-of-intent that the customer opted
-- in.  acknowledged_* is the A5 operator-review state.
create table if not exists review_drawing_entries (
  id                                  uuid primary key default gen_random_uuid(),
  submission_id                       uuid not null references review_submissions(id) on delete cascade,
  dealer_id                           integer not null references site_review_settings(dealer_id),
  -- A4 outcomes per segment.  "skipped" = per-site id NULL or feature
  -- disabled, "failed" = Sweed call errored, "added" = success, NULL
  -- = not yet attempted.
  drawing_segment_status              text
                                        check (drawing_segment_status in ('skipped', 'failed', 'added')),
  drawing_segment_attempted_at        timestamptz,
  drawing_segment_error               text,
  free_preroll_segment_status         text
                                        check (free_preroll_segment_status in ('skipped', 'failed', 'added')),
  free_preroll_segment_attempted_at   timestamptz,
  free_preroll_segment_error          text,
  -- A5 ack workflow.
  acknowledged_at                     timestamptz,
  acknowledged_by                     text,
  created_at                          timestamptz not null default now()
);

create index if not exists review_drawing_entries_submission_idx
  on review_drawing_entries (submission_id);
create index if not exists review_drawing_entries_dealer_created_idx
  on review_drawing_entries (dealer_id, created_at desc);
create unique index if not exists review_drawing_entries_one_per_submission
  on review_drawing_entries (submission_id);

-- Outbound email log.  Populated by A3.  Pre-created in A1 so the
-- contract column shape doesn't shift later.
create table if not exists review_emails (
  id              uuid primary key default gen_random_uuid(),
  submission_id   uuid not null references review_submissions(id) on delete cascade,
  -- "negative" | "lukewarm" | "strong_with_text" | "other"
  template_kind   text not null
                    check (template_kind in ('negative', 'lukewarm', 'strong_with_text', 'other')),
  to_address      text not null,
  cc_addresses    text[],
  subject         text not null,
  body_text       text,
  body_html       text,
  -- "queued" | "sent" | "failed" | "skipped"
  send_status     text not null default 'queued'
                    check (send_status in ('queued', 'sent', 'failed', 'skipped')),
  send_error      text,
  sent_at         timestamptz,
  created_at      timestamptz not null default now()
);

create index if not exists review_emails_submission_idx
  on review_emails (submission_id);
create index if not exists review_emails_status_idx
  on review_emails (send_status);

-- Midtown pilot seed (issue #13).  Inserted only if the row is
-- missing so re-running the schema doesn't clobber operator edits.
-- Bronx (dealer 210249) is seeded separately by the forward migration
-- 086_seed_bronx_review_settings.sql (its full launch config: provider
-- URL, flags, segments 10291/10292), so it is intentionally NOT added
-- to this pilot seed.
insert into site_review_settings (
  dealer_id,
  site_label,
  review_provider_kind,
  review_drawing_enabled,
  review_free_preroll_enabled,
  review_llm_gate_enabled,
  sweed_drawing_segment_id,
  sweed_free_preroll_segment_id
) values (
  210705,
  'Midtown',
  'google',
  false,    -- operator will flip these on once the public landing
  false,    -- page + nixos-sbc mailbox are ready (cross-repo deps
  false,    -- listed in issue #13).
  8669,     -- per issue #13: drawing segment, always added
  8666      -- per issue #13: free-preroll segment, strong-with-text only
) on conflict (dealer_id) do nothing;

-- Transaction attribution (migration 105). New submissions snapshot the
-- nearest same-site transaction once; historical rows are never guessed.
alter table review_submissions
  add column if not exists invoice_match_status text not null default 'not_attempted',
  add column if not exists matched_invoice_id text,
  add column if not exists matched_cashier_user_id bigint,
  add column if not exists matched_at timestamptz;

do $$ begin
  alter table review_submissions add constraint review_submissions_invoice_match_status_check
    check (invoice_match_status in ('not_attempted', 'matched', 'unmatched'));
exception when duplicate_object then null;
end $$;

do $$ begin
  alter table review_submissions add constraint review_submissions_invoice_match_state_check check (
    (invoice_match_status in ('not_attempted', 'unmatched')
      and matched_invoice_id is null and matched_cashier_user_id is null and matched_at is null)
    or
    (invoice_match_status = 'matched' and matched_invoice_id is not null
      and matched_cashier_user_id is not null and matched_at is not null)
  );
exception when duplicate_object then null;
end $$;
