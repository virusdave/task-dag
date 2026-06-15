// GAds → Landing-pages rollup refresh (V1, phase P2).
//
// Recomputes the day-grain `gads_lp_rollup` table from the append-only
// `lp_events` sink (migration 070) and maintains the singleton
// `gads_lp_rollup_refresh_state` freshness row. Backs the scheduled
// worker job config.workers.gads_lp_rollup_refresh
// (helios/src/worker/jobs/refreshGadsLpRollupJob.ts) and, downstream,
// the serving endpoint (P3) which reads ONLY the rollup + state row,
// never raw lp_events.
//
// Authoritative design: docs/epics/gads-landing-analytics/EPIC_PLAN.md §3
// (top-level); locked semantics: docs/helios/gads-landing-analytics/
// P0_AUDIT.md. Migration: 087_gads_lp_rollup.sql.
//
// Correctness invariants (P0 §5, Oracle-reviewed):
//   - All funnel counts are assignment-level-unique. The anchor CTE
//     picks the TRUE earliest lp_assignment per assignment_id (distinct
//     on, deterministic tie-break by id) so duplicate assignment posts
//     collapse to one row; bool_or over the outcome events collapses
//     duplicate impression/redirect/conversion posts.
//   - assignment_day is the anchor event's date in America/New_York
//     (the Ads business zone, P0 §3).
//   - conversions_Nd counts an assignment iff it has an lp_conversion in
//     the HALF-OPEN window [assignment_ts, assignment_ts + N days)
//     (assignment-time attribution, P0 §5.2). The lower bound guards
//     against a pre-assignment conversion sharing the assignment_id via
//     clock skew / re-send.
//   - Idempotent bounded-horizon recompute: in one transaction we
//     DELETE then re-INSERT every row with assignment_day >= the NY-local
//     horizon floor (today_ny - horizonDays), leaving older "frozen"
//     rows untouched. Late lp_conversions for cohorts still inside the
//     horizon correctly update their older assignment-day bucket; late
//     conversions for cohorts that have aged past the horizon are
//     intentionally not recomputed (the operator's bounded-horizon
//     decree / epic #11).
//   - Cost: V1 has no in-DB GAds cost snapshot, so allocated_cost_micros
//     stays NULL and cost_attribution_status = 'unavailable' (the column
//     default). No fake numbers.

import { getPool, type Queryable } from '../pool.js'
import { withTransaction } from '../tx.js'

/** Default bounded recompute horizon, in NY-local days (parent §3). */
export const GADS_LP_ROLLUP_HORIZON_DAYS = 90

/**
 * Transaction-scoped advisory lock key so two refresh runs (e.g. an
 * operator manual_run racing the scheduled tick) never recompute the
 * horizon concurrently. Arbitrary constant, namespaced to this job.
 */
const GADS_LP_ROLLUP_ADVISORY_LOCK_KEY = 860_470_001

/**
 * The locked paid-GAds-traffic predicate, as a SQL WHERE fragment over
 * an `lp_events`-shaped row (columns assignment_key_type, traffic_flags).
 *
 * ⚠️ LOCK-STEP with isPaidGadsTraffic() in
 * helios/src/shared/domain/gadsTraffic.ts (which is unit-tested against
 * the P0 §2.2 truth table). Any change here MUST be mirrored there.
 */
export const GADS_PAID_TRAFFIC_SQL = `(
       assignment_key_type in ('gclid','gbraid','wbraid')
       or coalesce(traffic_flags ? 'paid_google', false)
     )
     and not coalesce(traffic_flags ? 'bot_suspected', false)`

export interface GadsLpRollupRefreshResult {
  readonly rowsWritten: number
  readonly horizonFloor: string
  readonly sourceMinAt: string | null
  readonly sourceMaxAt: string | null
  /**
   * Data-quality counters, computed in the same pass over `lp_events`
   * and recorded onto the refresh-state row so the serving endpoint (P3)
   * can surface them WITHOUT reading lp_events itself. Both are an
   * as-of-this-refresh, horizon-bounded snapshot (event_ts within the
   * recompute horizon), not per-request-window figures.
   */
  readonly assignmentsMissingId: number
  readonly unattributedStageEvents: number
}

/**
 * Recompute the bounded horizon of `gads_lp_rollup` in a single
 * transaction (delete + re-insert of assignment_day >= floor). Returns
 * the number of rollup rows written and the source event-ts span. Does
 * NOT touch the refresh-state row — the caller (job handler) records
 * running/ok/error around this so a thrown error is still observable.
 */
export async function refreshGadsLpRollup(
  horizonDays: number = GADS_LP_ROLLUP_HORIZON_DAYS,
): Promise<GadsLpRollupRefreshResult> {
  return withTransaction(async (client) => {
    // Serialise concurrent refreshes for the duration of this txn.
    await client.query('select pg_advisory_xact_lock($1)', [GADS_LP_ROLLUP_ADVISORY_LOCK_KEY])

    // Resolve the NY-local horizon floor once so DELETE and INSERT agree.
    const floorRes = await client.query<{ floor: string }>(
      `select ((now() at time zone 'America/New_York')::date - $1::int)::text as floor`,
      [horizonDays],
    )
    const horizonFloor = floorRes.rows[0]?.floor
    if (!horizonFloor) {
      throw new Error('gads_lp_rollup refresh: failed to resolve horizon floor date')
    }

    // Replace every horizon row; older frozen rows are left untouched.
    await client.query(`delete from gads_lp_rollup where assignment_day >= $1::date`, [
      horizonFloor,
    ])

    const insertRes = await client.query(
      `
      with anchor as materialized (
        -- True earliest lp_assignment per assignment_id (the HMAC key
        -- binds the placement/provenance attrs, so the earliest event
        -- defines the grain). Deterministic tie-break by id.
        select distinct on (assignment_id)
          assignment_id,
          event_ts as assignment_ts,
          (event_ts at time zone 'America/New_York')::date as assignment_day,
          site,
          family,
          cluster_slug,
          experiment_id,
          policy_id,
          policy_rule_id,
          branch_id,
          served_probability_bps,
          assignment_key_type,
          traffic_flags
        from lp_events
        where event_type = 'lp_assignment'
          and assignment_id is not null
        order by assignment_id, event_ts asc, id asc
      ),
      paid_anchor as (
        select *
        from anchor
        where assignment_day >= $1::date
          and ${GADS_PAID_TRAFFIC_SQL}
      ),
      flags as (
        select
          pa.assignment_id,
          coalesce(bool_or(e.event_type = 'lp_impression'), false) as reached_impression,
          coalesce(bool_or(e.event_type = 'lp_redirect'), false)   as reached_redirect,
          coalesce(bool_or(
            e.event_type = 'lp_conversion'
            and e.event_ts >= pa.assignment_ts
            and e.event_ts <  pa.assignment_ts + interval '7 days'
          ), false) as conv_7d,
          coalesce(bool_or(
            e.event_type = 'lp_conversion'
            and e.event_ts >= pa.assignment_ts
            and e.event_ts <  pa.assignment_ts + interval '30 days'
          ), false) as conv_30d,
          coalesce(bool_or(
            e.event_type = 'lp_conversion'
            and e.event_ts >= pa.assignment_ts
            and e.event_ts <  pa.assignment_ts + interval '90 days'
          ), false) as conv_90d
        from paid_anchor pa
        left join lp_events e
          on e.assignment_id = pa.assignment_id
         and e.event_type in ('lp_impression', 'lp_redirect', 'lp_conversion')
        group by pa.assignment_id
      )
      insert into gads_lp_rollup (
        assignment_day, site, family, cluster_slug, experiment_id,
        policy_id, policy_rule_id, branch_id,
        assignments, impressions, redirects,
        conversions_7d, conversions_30d, conversions_90d,
        sum_served_prob_bps, assignments_with_prob,
        allocated_cost_micros, cost_attribution_status, refreshed_at
      )
      select
        pa.assignment_day, pa.site, pa.family, pa.cluster_slug, pa.experiment_id,
        pa.policy_id, pa.policy_rule_id, pa.branch_id,
        count(*)::int                                        as assignments,
        count(*) filter (where f.reached_impression)::int    as impressions,
        count(*) filter (where f.reached_redirect)::int      as redirects,
        count(*) filter (where f.conv_7d)::int               as conversions_7d,
        count(*) filter (where f.conv_30d)::int              as conversions_30d,
        count(*) filter (where f.conv_90d)::int              as conversions_90d,
        coalesce(sum(pa.served_probability_bps), 0)::bigint  as sum_served_prob_bps,
        count(*) filter (where pa.served_probability_bps is not null)::int as assignments_with_prob,
        null::bigint                                          as allocated_cost_micros,
        'unavailable'                                         as cost_attribution_status,
        now()                                                as refreshed_at
      from paid_anchor pa
      join flags f using (assignment_id)
      group by
        pa.assignment_day, pa.site, pa.family, pa.cluster_slug, pa.experiment_id,
        pa.policy_id, pa.policy_rule_id, pa.branch_id
      `,
      [horizonFloor],
    )

    const spanRes = await client.query<{ source_min_at: string | null; source_max_at: string | null }>(
      `select min(event_ts)::text as source_min_at, max(event_ts)::text as source_max_at
         from lp_events`,
    )

    // Data-quality counters over the recompute horizon (by event_ts), so
    // the serving endpoint can report them from the refresh-state row and
    // never has to scan lp_events itself (P3). Cheap, bounded count.
    const dqRes = await client.query<{
      assignments_missing_id: string
      unattributed_stage_events: string
    }>(
      `select
         count(*) filter (
           where event_type = 'lp_assignment' and assignment_id is null
         )::bigint as assignments_missing_id,
         count(*) filter (
           where event_type in ('lp_impression', 'lp_redirect', 'lp_conversion')
             and assignment_id is null
         )::bigint as unattributed_stage_events
       from lp_events
       where event_ts >= now() - make_interval(days => $1::int)`,
      [horizonDays],
    )

    return {
      rowsWritten: insertRes.rowCount ?? 0,
      horizonFloor,
      sourceMinAt: spanRes.rows[0]?.source_min_at ?? null,
      sourceMaxAt: spanRes.rows[0]?.source_max_at ?? null,
      assignmentsMissingId: Number(dqRes.rows[0]?.assignments_missing_id ?? 0),
      unattributedStageEvents: Number(dqRes.rows[0]?.unattributed_stage_events ?? 0),
    }
  })
}

/** Mark the refresh as started (status=running, last_started_at=now). */
export async function markGadsLpRollupRefreshRunning(db: Queryable = getPool()): Promise<void> {
  await db.query(
    `update gads_lp_rollup_refresh_state
        set status = 'running', last_started_at = now(), error_message = null, updated_at = now()
      where id = 'singleton'`,
  )
}

/** Mark the refresh as completed OK and record the span + row count. */
export async function markGadsLpRollupRefreshOk(
  result: GadsLpRollupRefreshResult,
  db: Queryable = getPool(),
): Promise<void> {
  await db.query(
    `update gads_lp_rollup_refresh_state
        set status = 'ok',
            last_completed_at = now(),
            source_min_at = $1::timestamptz,
            source_max_at = $2::timestamptz,
            rows_written = $3::int,
            assignments_missing_id = $4::int,
            unattributed_stage_events = $5::int,
            error_message = null,
            updated_at = now()
      where id = 'singleton'`,
    [
      result.sourceMinAt,
      result.sourceMaxAt,
      result.rowsWritten,
      result.assignmentsMissingId,
      result.unattributedStageEvents,
    ],
  )
}

/** Mark the refresh as failed and persist the error for observability. */
export async function markGadsLpRollupRefreshError(
  message: string,
  db: Queryable = getPool(),
): Promise<void> {
  await db.query(
    `update gads_lp_rollup_refresh_state
        set status = 'error', error_message = $1, updated_at = now()
      where id = 'singleton'`,
    [message.slice(0, 2000)],
  )
}
