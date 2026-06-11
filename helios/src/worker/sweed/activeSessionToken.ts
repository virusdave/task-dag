// Worker-side helpers for the Sweed session POOL.
//
// Source of truth is the `sweed_session_tokens` table (migrations
// 014 + 015). The operator pastes one or more live Sweed `auth`
// UUIDs through the helios admin page; each worker job claims one
// row for the duration of its work and releases it back to the
// pool when done (see worker/sweed/session.ts withSweedSession).
// Two jobs never share a token concurrently — Sweed keeps
// server-side dealer context per-token.
//
// There is intentionally NO `SWEED_AUTH_TOKEN` env-var fallback
// here: every pooled session-bound caller must lease a real DB row
// or defer. The legacy env var was retired so a stale locally-
// saved session secret can never silently mask an empty / exhausted
// pool with a token that returns "Auth expired" on every RPC.
//
// `expireClaimedSweedToken` is the auth-error path: when a worker
// hits "Auth expired" mid-session, the DB row is permanently
// retired (the operator must paste a fresh token).

import { randomUUID } from 'node:crypto'

import { getPool } from '../../server/db/pool.js'
import {
  claimAvailableSweedSessionToken,
  markSweedSessionTokenExpired,
  markSweedSessionTokenProlonged,
  releaseSweedSessionToken as releaseSweedSessionTokenRow,
} from '../../server/db/queries/sweedSessionTokensQueries.js'

// Default lease length for a per-job claim. Generous enough to cover
// any realistic single-job Sweed workload; if a worker crashes
// without releasing, another worker can reclaim the row after this
// expires. Tune via SWEED_SESSION_LEASE_MS if needed.
const DEFAULT_LEASE_MS = 15 * 60 * 1000

export interface ClaimedSweedToken {
  readonly token: string
  readonly tokenPrefix: string
  /**
   * Always `'db-pasted'` — the env-var fallback was retired. The
   * discriminator is preserved so the transport-layer auth-log /
   * token-retirement code can keep switching on it without a
   * coordinated rewrite.
   */
  readonly source: 'db-pasted'
  readonly rowId: number
  readonly claimedBy: string
  readonly initialDealerId: number | null
  /**
   * Highwater mark of the last successful Sweed keep-alive
   * ("prolongs") for this row at claim time, or null if helios has
   * never prolonged it. withSweedSession reads this to decide whether
   * the daily store.auth.dealer.list keep-alive is due before use.
   */
  readonly lastProlongedAt: Date | null
}

export interface ClaimSweedTokenOptions {
  /** Opaque tag used as claimed_by on the DB row. */
  readonly claimedBy: string
  /** Lease length in ms; falls back to DEFAULT_LEASE_MS. */
  readonly leaseMs?: number
}

/**
 * Take an available Sweed session out of the pool for exclusive
 * use. Returns null when no pool row is available — either the
 * pool table is empty (operator has never pasted) or every
 * unexpired row is currently leased to another worker. The caller
 * (withSweedSession) translates that into a deferred re-queue so
 * the operator can paste / a worker can release without the job
 * silently using a stale locally-saved SWEED_AUTH_TOKEN.
 */
export async function claimSweedToken(
  options: ClaimSweedTokenOptions,
): Promise<ClaimedSweedToken | null> {
  const ttlMs = options.leaseMs ?? DEFAULT_LEASE_MS
  try {
    const claimed = await claimAvailableSweedSessionToken(getPool(), {
      claimedBy: options.claimedBy,
      ttlMs,
    })
    if (claimed !== null) {
      return {
        token: claimed.token,
        tokenPrefix: claimed.tokenPrefix,
        source: 'db-pasted',
        rowId: claimed.id,
        claimedBy: claimed.claimedBy,
        initialDealerId: claimed.initialDealerId,
        lastProlongedAt: claimed.lastProlongedAt,
      }
    }
  } catch (error) {
    console.warn(
      '[sweed] pool claim failed:',
      error instanceof Error ? error.message : error,
    )
  }
  return null
}

/**
 * Return a previously-claimed session to the pool so a future
 * worker can reuse it. Safe to call multiple times.
 *
 * Never throws — releasing is best-effort. A leaked claim will
 * be automatically reclaimable once its lease expires.
 */
export async function releaseClaimedSweedToken(claim: ClaimedSweedToken): Promise<void> {
  try {
    await releaseSweedSessionTokenRow(getPool(), {
      id: claim.rowId,
      claimedBy: claim.claimedBy,
    })
  } catch (error) {
    console.warn(
      `[sweed] failed to release session token row #${claim.rowId} (lease will expire automatically):`,
      error instanceof Error ? error.message : error,
    )
  }
}

/**
 * Permanently retire a claimed pool row (auth-expired path). The
 * token will NOT be returned to the pool — the operator must paste
 * a fresh one.
 */
export async function expireClaimedSweedToken(
  claim: ClaimedSweedToken,
  reason: string,
): Promise<void> {
  try {
    await markSweedSessionTokenExpired(getPool(), claim.rowId, reason)
    console.warn(`[sweed] marked session token #${claim.rowId} expired: ${reason}`)
  } catch (error) {
    console.warn(
      `[sweed] failed to mark session token #${claim.rowId} expired:`,
      error instanceof Error ? error.message : error,
    )
  }
}

/**
 * Persist the keep-alive ("prolongs") highwater mark for a claimed
 * pool row after a successful Sweed `store.auth.dealer.list` call.
 * Best-effort: a failure to stamp the column never aborts the job
 * (the session was already prolonged server-side; we just lose the
 * local highwater-mark update and will re-prolong next claim).
 */
export async function prolongClaimedSweedToken(claim: ClaimedSweedToken): Promise<void> {
  try {
    await markSweedSessionTokenProlonged(getPool(), {
      id: claim.rowId,
      claimedBy: claim.claimedBy,
    })
  } catch (error) {
    console.warn(
      `[sweed] failed to stamp prolong highwater mark on session token row #${claim.rowId}:`,
      error instanceof Error ? error.message : error,
    )
  }
}

/**
 * Generate a stable opaque tag for `claimed_by`. The tag identifies
 * this worker process + the specific job (when known) so the UI
 * can show "row #5 in use by worker:1234 job:42".
 */
export function buildClaimTag(jobContext: { jobId?: number | string | null } | null = null): string {
  const pid = process.pid
  const jobLabel = jobContext?.jobId ? `job:${String(jobContext.jobId)}` : `session:${randomUUID().slice(0, 8)}`
  return `worker:${pid}:${jobLabel}`
}
