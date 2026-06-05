-- Down for 062: intentionally a no-op.
--
-- Once the F5 drain has nulled raw_json for >30d orders, re-adding the
-- NOT NULL constraint would fail (and re-asserting it is meaningless
-- after the data is gone). If you must restore the constraint before
-- any drain has run, do it manually:
--   alter table sweed_orders alter column raw_json set not null;

\echo '062 down is a no-op; NOT NULL cannot be safely re-added after the F5 drain.'
