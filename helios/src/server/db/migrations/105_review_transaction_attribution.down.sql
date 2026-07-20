-- Inverse of migration 105.
-- DESTRUCTIVE: removes all captured invoice/cashier attribution.

\set ON_ERROR_STOP on
\timing on

begin;
set local lock_timeout = '5s';

alter table review_submissions
  drop constraint if exists review_submissions_invoice_match_state_check,
  drop constraint if exists review_submissions_invoice_match_status_check,
  drop column if exists matched_at,
  drop column if exists matched_cashier_user_id,
  drop column if exists matched_invoice_id,
  drop column if exists invoice_match_status;

commit;
