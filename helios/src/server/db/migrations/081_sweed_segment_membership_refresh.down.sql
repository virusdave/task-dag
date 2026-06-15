-- Down for 081: drop the per-segment membership-refresh highwater.
-- Safe to drop; the details page falls back to "cached before highwater
-- tracking" using the membership rows' own timestamps.

\set ON_ERROR_STOP on

drop table if exists sweed_segment_membership_refresh;
