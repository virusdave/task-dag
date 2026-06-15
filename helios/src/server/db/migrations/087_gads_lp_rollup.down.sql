-- Down for 087: drop the GAds landing-pages rollup + its refresh-state
-- row. Safe to drop — both are derived caches fully reconstructable
-- from lp_events by re-running the up migration + the
-- config.workers.gads_lp_rollup_refresh worker job. The GAds
-- landing-pages surface (P3/P4) renders "no data / unavailable" without
-- them.

\set ON_ERROR_STOP on

drop table if exists gads_lp_rollup_refresh_state;
drop table if exists gads_lp_rollup;
