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
// Legacy fallback: if the pool is empty AND `SWEED_AUTH_TOKEN` is
// set, we hand out a synthetic non-DB lease so dev/smoke flows
// still work without anyone having pasted into the DB.
// `releaseClaimedSweedToken` is a no-op for the env-fallback lease.
//
// `expireClaimedSweedToken` is the auth-error path: when a worker
// hits "Auth expired" mid-session, the DB row is permanently
// retired (the operator must paste a fresh token).

import { randomUUID } from 'node:crypto'

import { getPool } from '../../server/db/pool.js'
import {
  claimAvailableSweedSessionToken,
  markSweedSessionTokenExpired,
  releaseSweedSessionToken as releaseSweedSessionTokenRow,
} from '../../server/db/queries/sweedSessionTokensQueries.js'
import { getWorkerEnv } from '../config/env.js'

// Default lease length for a per-job claim. Generous enough to cover
// any realistic single-job Sweed workload; if a worker crashes
// without releasing, another worker can reclaim the row after this
// expires. Tune via SWEED_SESSION_LEASE_MS if needed.
const DEFAULT_LEASE_MS = 15 * 60 * 1000

export interface ClaimedSweedToken {
  readonly token: string
  readonly tokenPrefix: string
  readonly source: 'db-pasted' | 'env-fallback'
  readonly rowId: number | null
  readonly claimedBy: string | null
  readonly initialDealerId: number | null
}

export interface ClaimSweedTokenOptions {
  /** Opaque tag used as claimed_by on the DB row. */
  readonly claimedBy: string
  /** Lease length in ms; falls back to DEFAULT_LEASE_MS. */
  readonly leaseMs?: number
}

/**
 * Take an available Sweed session out of the pool for exclusive
 * use. Returns null when the pool is empty AND no env fallback is
 * configured.
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
      }
    }
  } catch (error) {
    console.warn(
      '[sweed] pool claim failed, falling back to env token if available:',
      error instanceof Error ? error.message : error,
    )
  }
  const env = getWorkerEnv()
  if (env.sweedAuthToken) {
    return {
      token: env.sweedAuthToken,
      tokenPrefix: env.sweedAuthToken.slice(0, 8),
      source: 'env-fallback',
      rowId: null,
      claimedBy: null,
      initialDealerId: null,
    }
  }
  return null
}

/**
 * Return a previously-claimed session to the pool so a future
 * worker can reuse it. Safe to call multiple times; safe to call
 * on env-fallback leases (no-op).
 *
 * Never throws — releasing is best-effort. A leaked claim will
 * be automatically reclaimable once its lease expires.
 */
export async function releaseClaimedSweedToken(claim: ClaimedSweedToken): Promise<void> {
  if (claim.source !== 'db-pasted' || claim.rowId === null || claim.claimedBy === null) {
    return
  }
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
 * a fresh one. No-op for env-fallback leases (the operator has to
 * rotate the env var by hand in that case).
 */
export async function expireClaimedSweedToken(
  claim: ClaimedSweedToken,
  reason: string,
): Promise<void> {
  if (claim.source !== 'db-pasted' || claim.rowId === null) {
    return
  }
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
 * Generate a stable opaque tag for `claimed_by`. The tag identifies
 * this worker process + the specific job (when known) so the UI
 * can show "row #5 in use by worker:1234 job:42".
 */
export function buildClaimTag(jobContext: { jobId?: number | string | null } | null = null): string {
  const pid = process.pid
  const jobLabel = jobContext?.jobId ? `job:${String(jobContext.jobId)}` : `session:${randomUUID().slice(0, 8)}`
  return `worker:${pid}:${jobLabel}`
}
