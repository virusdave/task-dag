// Bulk-insert query layer for the lp_events sink (migration 070).
//
// Unified-landing-engine conversion-feedback ingest (parent epic
// virusdave/top-level#13 / child FreshlyBakedNYC/automation#42, P1).
// Called by the POST /v1/lp-events/batch route
// (helios/src/server/routes/lpEvents.ts) with a validated
// `freshlybaked.lp.events-batch.v1` body.
//
// The whole batch is inserted in a single multi-row INSERT with
// `on conflict (event_id) do nothing`, so a re-delivered batch (the
// runtime re-sends if a flush is interrupted before it sees our ack)
// collapses duplicates by the runtime-assigned `event_id`. We return
// how many rows were newly inserted vs. already present so the route
// can report it back to the runtime (and so the runtime's metrics can
// distinguish a healthy retry from real new traffic).

import type { Queryable } from '../pool.js'
import type { LpEvent } from '../../lp/contracts.js'

export interface BulkInsertLpEventsResult {
  readonly received: number
  readonly inserted: number
  readonly duplicates: number
}

// Columns inserted per event, in the exact order the VALUES tuples
// below bind them. Keep this list and `eventToParams` in lockstep.
const COLUMNS = [
  'event_id',
  'event_type',
  'event_ts',
  'replica_id',
  'bundle_id',
  'policy_id',
  'policy_rule_id',
  'experiment_id',
  'assignment_id',
  'assignment_key_type',
  'branch_id',
  'selected_variants',
  'counterfactual_variants',
  'candidate_weights',
  'served_probability_bps',
  'bucket_bps',
  'gclid_hash',
  'site',
  'family',
  'cluster_slug',
  'traffic_flags',
  'raw_event',
] as const

function jsonOrNull(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value)
}

function eventToParams(event: LpEvent): unknown[] {
  return [
    event.event_id,
    event.event_type,
    event.event_ts,
    event.replica_id,
    event.bundle_id,
    event.policy_id,
    event.policy_rule_id ?? null,
    event.experiment_id ?? null,
    event.assignment_id ?? null,
    event.assignment_key_type ?? null,
    event.branch_id ?? null,
    jsonOrNull(event.selected_variants),
    jsonOrNull(event.counterfactual_variants),
    jsonOrNull(event.candidate_weights),
    event.served_probability_bps ?? null,
    event.bucket_bps ?? null,
    event.gclid_hash ?? null,
    event.site,
    event.family ?? null,
    event.cluster_slug ?? null,
    jsonOrNull(event.traffic_flags),
    // raw_event: the verbatim event object, so a later mapping change
    // can be re-derived without re-ingesting.
    JSON.stringify(event),
  ]
}

/**
 * Insert a batch of landing-page events idempotently.
 *
 * If two events in the same batch share an `event_id`, Postgres
 * rejects the statement ("ON CONFLICT DO UPDATE command cannot affect
 * row a second time") — but our conflict action is DO NOTHING, which
 * tolerates intra-statement duplicates by skipping the later tuple.
 * Across batches, the unique index collapses re-deliveries. The
 * `inserted` count comes from `returning event_id` (only conflicting-
 * free rows are returned).
 */
export async function bulkInsertLpEvents(
  db: Queryable,
  events: readonly LpEvent[],
): Promise<BulkInsertLpEventsResult> {
  if (events.length === 0) {
    return { received: 0, inserted: 0, duplicates: 0 }
  }

  // The jsonb columns are bound as JSON.stringify(...) strings; with
  // node-postgres leaving the param type unspecified, Postgres infers
  // jsonb from the target column and parses the string directly (same
  // pattern as annotationsQueries' scope_ref / visitor_scans'
  // raw_envelope). No explicit ::jsonb cast needed.
  const params: unknown[] = []
  const tuples: string[] = []
  for (const event of events) {
    const base = params.length
    const placeholders = COLUMNS.map((_, i) => `$${base + i + 1}`)
    tuples.push(`(${placeholders.join(', ')})`)
    params.push(...eventToParams(event))
  }

  const result = await db.query<{ event_id: string }>(
    `
      insert into lp_events (${COLUMNS.join(', ')})
      values ${tuples.join(', ')}
      on conflict (event_id) do nothing
      returning event_id
    `,
    params,
  )

  const inserted = result.rows.length
  return {
    received: events.length,
    inserted,
    duplicates: events.length - inserted,
  }
}
