-- Down for 080: drop the sweed_customer_segments(segment_id, sweed_customer_id)
-- secondary index. Safe to drop; the bulk segment-membership writer falls back
-- to a seq scan (correct, just slower) without it.

\set ON_ERROR_STOP on

drop index if exists sweed_customer_segments_segment_customer_idx;
