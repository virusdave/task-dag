// Structured, persisted log of every auth-touching Sweed JSON-RPC the
// worker issues. Each event is best-effort fire-and-forget so a
// logging failure cannot mask the outcome of the caller's work. The
// rows are surfaced in the helios UI under /config/sweed-auth-log
// (and inline on each job detail page) so an operator can answer
// questions like "did this job actually log in?", "did another job's
// store.auth.end kill our token?", or "which RPC saw the Auth
// expired response first?" without having to scrape worker stdout.

import { AsyncLocalStorage } from 'node:async_hooks'

import { getPool, type Queryable } from '../../server/db/pool.js'

export type SweedAuthEventKind =
  | 'login'
  | 'logout'
  | 'dealer_set'
  | 'initial_data'
  | 'rpc_auth_error'

export type SweedAuthEventOutcome = 'ok' | 'error' | 'retryable'

export interface SweedAuthEventInput {
  rpcName: string
  eventKind: SweedAuthEventKind
  sessionOrigin: 'fresh' | 'legacy' | null
  authToken: string | null
  dealerId: number | null
  outcome: SweedAuthEventOutcome
  httpStatus: number | null
  errorMessage: string | null
  durationMs: number
  context?: Record<string, unknown>
}

interface JobAuthContext {
  jobId: number
  jobType: string
}

const jobContext = new AsyncLocalStorage<JobAuthContext>()

export function withJobAuthContext<T>(context: JobAuthContext, fn: () => Promise<T>): Promise<T> {
  return jobContext.run(context, fn)
}

export function getCurrentJobAuthContext(): JobAuthContext | null {
  return jobContext.getStore() ?? null
}

/**
 * Phrases Sweed returns in its `error.message` (and a handful of HTTP
 * statuses) that almost always indicate the auth token is no longer
 * valid. Used to classify generic RPC failures into the
 * `rpc_auth_error` event kind so they bubble to the UI's
 * "auth-related" filter alongside the deliberate login/logout/etc.
 * calls.
 */
const AUTH_ERROR_PHRASES: readonly string[] = [
  'auth expired',
  'authentication required',
  'invalid auth',
  'not authorized',
  'permission denied',
  'session expired',
  'token expired',
  'unauthorized',
]

export function looksLikeAuthError(message: string | null | undefined, httpStatus?: number | null): boolean {
  if (httpStatus === 401 || httpStatus === 403) {
    return true
  }
  if (!message) {
    return false
  }
  const lowered = message.toLowerCase()
  return AUTH_ERROR_PHRASES.some((needle) => lowered.includes(needle))
}

function tokenPrefix(token: string | null): string | null {
  if (!token) {
    return null
  }
  return token.slice(0, 8)
}

function truncateError(message: string | null): string | null {
  if (!message) {
    return null
  }
  // 2 KiB cap matches the column-level comment in the schema; even if
  // a Sweed response leaks a stack-style payload we keep table growth
  // bounded.
  if (message.length <= 2048) {
    return message
  }
  return `${message.slice(0, 2047)}…`
}

/**
 * Append a single auth-event row. Fire-and-forget: failures are
 * logged to stderr but never propagated. Callers should treat this
 * as an instrumentation side effect, not a critical path.
 */
export function recordAuthEvent(input: SweedAuthEventInput): void {
  const ctx = getCurrentJobAuthContext()
  // Snapshot now so the row's created_at lines up tightly with when
  // the RPC actually completed (rather than when the async write
  // happens). The DB column still defaults to now() for inserts that
  // forget to pass one, but in our case we want sub-second accuracy.
  insertEventRow(getPool(), {
    jobId: ctx?.jobId ?? null,
    jobType: ctx?.jobType ?? null,
    ...input,
  }).catch((error) => {
    console.warn(
      '[sweed-auth-log] failed to persist auth event for',
      input.rpcName,
      '-',
      error instanceof Error ? error.message : error,
    )
  })
}

interface InsertableEvent extends SweedAuthEventInput {
  jobId: number | null
  jobType: string | null
}

async function insertEventRow(db: Queryable, event: InsertableEvent): Promise<void> {
  await db.query(
    `
      insert into sweed_auth_events (
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
      ) values (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb
      )
    `,
    [
      event.jobId,
      event.jobType,
      event.rpcName,
      event.eventKind,
      event.sessionOrigin,
      tokenPrefix(event.authToken),
      event.dealerId,
      event.outcome,
      event.httpStatus,
      truncateError(event.errorMessage),
      Math.max(0, Math.round(event.durationMs)),
      JSON.stringify(event.context ?? {}),
    ],
  )
}
