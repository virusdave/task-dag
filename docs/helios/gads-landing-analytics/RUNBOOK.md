# GAds landing-pages analytics runbook

> Child epic: [FreshlyBakedNYC/automation#47](https://github.com/FreshlyBakedNYC/automation/issues/47).  
> Parent design: `top-level/docs/epics/gads-landing-analytics/EPIC_PLAN.md`.  
> Live operator surface: `https://helios.freshlybaked.us/metrics/gads-<site>/landing-pages`
> (`gads-bronx`, `gads-midtown`, or `gads-all` grant required).

## Cadence and serving contract

- `config.workers.gads_lp_rollup_refresh` refreshes the small
  `gads_lp_rollup` table every **60 minutes** by default through the
  config-workers scheduler (`workers.scheduling.gads_lp_rollup_refresh`).
- Each run recomputes the trailing **90 NY-local assignment days** in one
  advisory-locked transaction, then updates the singleton
  `gads_lp_rollup_refresh_state` row.
- Dashboard requests read only `gads_lp_rollup` plus
  `gads_lp_rollup_refresh_state`; they never scan raw `lp_events`.

## Inspect the last refresh

Use the GAds landing-pages page first: its freshness strip reflects the
same refresh-state row and warns when data is stale, running, failed, or
never refreshed.

For DB-level inspection, use a read-only shell with the Helios database URL:

```sql
select
  status,
  last_started_at,
  last_completed_at,
  source_min_at,
  source_max_at,
  rows_written,
  assignments_missing_id,
  unattributed_stage_events,
  error_message,
  updated_at
from gads_lp_rollup_refresh_state
where id = 'singleton';
```

For worker logs, filter on the stable log tag:

```sh
journalctl -u helios-worker.service --since '2 hours ago' --no-pager \
  | rg '\[gads-lp-rollup-refresh\]'
```

Successful runs log `status=ok`, `durationMs`, `horizonDays`,
`floor`, `rows`, `assignmentsMissingId`, and
`unattributedStageEvents`. Failed runs log `status=error` and persist
the same failure onto `gads_lp_rollup_refresh_state.error_message`.

## Manually rebuild the rollup

Preferred path: enqueue through Helios's admin-gated run-now route (the
same route the worker-schedule UI uses for tasks with a detail page):

```http
POST /api/config/workers/schedules/workers.scheduling.gads_lp_rollup_refresh/run-now
```

That creates a `config.workers.gads_lp_rollup_refresh` job with
`trigger = manual_run`; the worker still uses the same advisory lock and
90-day default horizon, so it is safe to run if a scheduled tick is
nearby.

If the API route is unavailable and an operator explicitly asks for DB-level
queueing, enqueue the same job through the canonical jobs path rather
than running the refresh SQL by hand. Use the existing job queue shape:

```sql
insert into job_queue (
  job_type,
  dedupe_key,
  concurrency_key,
  module_code,
  payload_json,
  status,
  run_at,
  priority
) values (
  'config.workers.gads_lp_rollup_refresh',
  'config.workers.gads_lp_rollup_refresh:manual:' || to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS'),
  'config.workers.gads_lp_rollup_refresh',
  'config',
  '{"trigger":"manual_run"}'::jsonb,
  'queued',
  now(),
  100
);
```

Use a custom `horizonDays` only for a deliberate one-off rebuild (for
example `{"trigger":"manual_run","horizonDays":120}`); the payload
schema caps it at 365 days.

## Rollout and rollback

- Deploy code changes only with the canonical Helios path:
  `git push origin HEAD:master`, then `self-deploy-helios`. Do not
  restart `helios-*` services manually.
- The rollup is isolated from request-time writes. If the refresh fails,
  the dashboard serves the last completed rollup with an error/stale
  freshness badge.
- Schema rollback for the V1 rollup is the migration down path documented
  in `087_gads_lp_rollup.down.sql` and `088_gads_lp_rollup_dq.down.sql`;
  dropping the rollup makes the GAds surface show unavailable/no data but
  does not remove raw `lp_events`.

## Deferred V2 items

These are intentionally out of V1 and need their own design and review
before implementation:

- `mostly-static-sites` event-schema enrichment: order id, revenue,
  device class, web-vitals/page-load-failure signals on landing-page
  events.
- Sweed revenue attribution, cancellation/refund handling, CPA/ROAS, and
  exact gclid-level cost.
- Timescale/HLL features: `lp_events` hypertable conversion,
  compression, continuous aggregates, or sketch-based distinct counts.
- Cardinality expansion for campaigns, keywords, devices, policy health,
  creative, experiments, and iteration sub-pages beyond the already
  reserved navigation stubs.
- Historical rebuilds beyond the bounded 90-day recompute horizon.
