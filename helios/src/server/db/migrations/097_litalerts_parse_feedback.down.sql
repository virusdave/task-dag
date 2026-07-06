-- Inverse of 097: drop the litalerts_parse_feedback inbox.
--
-- Safe to run only after every reader of the parse-feedback endpoint has been
-- reverted. The table is a standalone inbox that nothing in the production
-- scorer / market-match read path joins, so dropping it cannot affect
-- production matching, scoring, `fuzzy_skus`, market aggregates, or IQR.
--
-- Destructive: this DROPs the table and every operator-authored correction /
-- convention proposal it holds. Only run when intentionally discarding that
-- feedback (or in a dev/rollback context).

\set ON_ERROR_STOP on

begin;

drop table if exists litalerts_parse_feedback;

commit;
