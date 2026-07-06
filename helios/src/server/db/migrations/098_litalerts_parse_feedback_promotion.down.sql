-- Inverse of 098: drop the litalerts_parse_feedback promotion-provenance
-- columns + coupling CHECK, restoring the 097 shape.
--
-- Safe to run only after every reader/writer of the promotion columns has been
-- reverted (the promotion export + the `promoted` status transition). The
-- columns are provenance-only; nothing in the production scorer / market-match
-- read path joins them, so dropping them cannot affect production matching,
-- scoring, `fuzzy_skus`, market aggregates, or IQR.
--
-- Destructive: this DROPs the promotion provenance recorded on any promoted /
-- superseded rows. Only run when intentionally discarding it (or in a
-- dev/rollback context).

\set ON_ERROR_STOP on

begin;

alter table litalerts_parse_feedback
  drop constraint if exists litalerts_parse_feedback_promotion_meta_ok;

alter table litalerts_parse_feedback
  drop column if exists promoted_parser_id,
  drop column if exists promoted_rule_id,
  drop column if exists promoted_config_sha;

commit;
