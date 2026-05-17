import type { Queryable } from '../pool.js'
import type {
  SweedAuthEvent,
  SweedAuthEventsQuery,
} from '../../../shared/contracts/index.js'

interface SweedAuthEventRow {
  id: string | number
  created_at: Date
  job_id: string | number | null
  job_type: string | null
  rpc_name: string
  event_kind: string
  session_origin: string | null
  auth_token_prefix: string | null
  dealer_id: string | number | null
  outcome: string
  http_status: number | null
  error_message: string | null
  duration_ms: number
  context_json: Record<string, unknown> | null
}

function rowToEvent(row: SweedAuthEventRow): SweedAuthEvent {
  return {
    id: Number(row.id),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    jobId: row.job_id === null ? null : Number(row.job_id),
    jobType: row.job_type,
    rpcName: row.rpc_name,
    eventKind: row.event_kind as SweedAuthEvent['eventKind'],
    sessionOrigin:
      row.session_origin === 'fresh' || row.session_origin === 'legacy' ? row.session_origin : null,
    authTokenPrefix: row.auth_token_prefix,
    dealerId: row.dealer_id === null ? null : Number(row.dealer_id),
    outcome: row.outcome as SweedAuthEvent['outcome'],
    httpStatus: row.http_status,
    errorMessage: row.error_message,
    durationMs: row.duration_ms,
    context: (row.context_json ?? {}) as Record<string, unknown>,
  }
}

/**
 * Fetch every sweed_auth_events row for `jobId` in chronological
 * order (oldest first), so callers can render a session timeline.
 *
 * Tolerates the table being absent (migration 011 not applied) by
 * returning an empty array, so the job-detail API does not 500 in
 * environments that haven't picked up the migration yet.
 */
export async function listSweedAuthEventsForJob(
  db: Queryable,
  jobId: number,
): Promise<SweedAuthEvent[]> {
  try {
    // Hard cap so a single runaway job (e.g. one retrying the same
    // RPC thousands of times) can't blow up the job-detail response.
    const result = await db.query<SweedAuthEventRow>(
      `
        select
          id,
          created_at,
          job_id,
          job_type,
          rpc_name,
          event_kind,
          session_origin,
          auth_token_prefix,
          dealer_id,
          outcome,
          http_status,
          error_message,
          duration_ms,
          context_json
        from sweed_auth_events
        where job_id = $1
        order by created_at asc, id asc
        limit 500
      `,
      [jobId],
    )
    return result.rows.map(rowToEvent)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/relation .*sweed_auth_events.* does not exist/i.test(message)) {
      return []
    }
    throw error
  }
}

export async function listSweedAuthEvents(
  db: Queryable,
  query: SweedAuthEventsQuery,
): Promise<{ items: SweedAuthEvent[]; truncated: boolean }> {
  const conditions: string[] = []
  const params: unknown[] = []

  if (query.jobId !== undefined) {
    params.push(query.jobId)
    conditions.push(`job_id = $${params.length}`)
  }
  if (query.outcomeFilter === 'errors') {
    conditions.push(`outcome <> 'ok'`)
  }
  if (query.authTokenPrefix !== undefined) {
    params.push(query.authTokenPrefix)
    conditions.push(`auth_token_prefix = $${params.length}`)
  }

  const whereClause = conditions.length > 0 ? `where ${conditions.join(' and ')}` : ''

  // We over-fetch by one row so we can tell the caller whether the
  // result set was truncated and there are older rows behind the
  // limit they should narrow the filter to see.
  const fetchLimit = query.limit + 1
  params.push(fetchLimit)
  const limitPlaceholder = `$${params.length}`

  const result = await db.query<SweedAuthEventRow>(
    `
      select
        id,
        created_at,
        job_id,
        job_type,
        rpc_name,
        event_kind,
        session_origin,
        auth_token_prefix,
        dealer_id,
        outcome,
        http_status,
        error_message,
        duration_ms,
        context_json
      from sweed_auth_events
      ${whereClause}
      order by created_at desc, id desc
      limit ${limitPlaceholder}
    `,
    params,
  )

  const rows = result.rows
  const truncated = rows.length > query.limit
  const items = (truncated ? rows.slice(0, query.limit) : rows).map(rowToEvent)
  return { items, truncated }
}
