-- Migration 105: immutable, capture-time inferred transaction attribution.
-- Additive and metadata-only for historical rows (default not_attempted); no
-- backfill or later recomputation guesses attribution.

\set ON_ERROR_STOP on
\timing on

begin;
set local lock_timeout = '5s';

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

commit;
