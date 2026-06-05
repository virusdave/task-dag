-- Down for 061: intentionally a no-op.
--
-- 061 is a one-time data backfill of sweed_orders.cashier_user_id from
-- raw_json. It cannot be safely reverted: after the backfill there is
-- no marker distinguishing rows whose cashier_user_id came from the
-- backfill versus from the ingest job's normal write, so nulling the
-- backfilled rows would also clobber legitimately-ingested values.
--
-- If you genuinely need to undo it (e.g. to re-test the budtender
-- raw_json fallback path), do so manually with a scoped UPDATE against
-- a known pay_time / dealer window — never blanket.

\echo '061 down is a no-op; data backfill is not safely reversible (see file header).'
