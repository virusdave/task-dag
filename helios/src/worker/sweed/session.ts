import { AsyncLocalStorage } from 'node:async_hooks'

import { DependencyUnavailableWorkerError } from '../runtime/errors.js'
import {
  buildClaimTag,
  claimSweedToken,
  releaseClaimedSweedToken,
  type ClaimedSweedToken,
} from './activeSessionToken.js'
import { getCurrentJobAuthContext } from './authLog.js'

// How long to defer a job whose claim attempt found the pool
// fully leased. Short enough that a job which "just missed" a
// release comes back online quickly, long enough not to busy-poll
// the DB when the pool is genuinely empty.
const POOL_EMPTY_RETRY_DELAY_MS = 5_000

/**
 * Per-job Sweed session context.
 *
 * Helios workers cannot mint their own Sweed sessions: `store.auth.user`
 * is gated by Google reCAPTCHA v3 and rejects any request without a
 * valid `X-Recaptcha-Token` header. Instead an operator pastes one or
 * more live Sweed auth UUIDs (captured from a real logged-in browser)
 * into `/config/sweed/sessions`, where they sit in the
 * `sweed_session_tokens` table as an exclusive-use POOL.
 *
 * `withSweedSession`:
 *   1. CLAIMS one available row from the pool (via
 *      claimAvailableSweedSessionToken — `SELECT ... FOR UPDATE SKIP
 *      LOCKED`), pinning it for the lifetime of the job.
 *   2. Runs `fn` with that token + the captured initial dealer
 *      pinned in AsyncLocalStorage so every downstream Sweed RPC
 *      uses the same row.
 *   3. RELEASES the row back to the pool in `finally` so a future
 *      worker job can reuse it. Crucially this is NOT a Sweed
 *      `store.auth.end` — the operator-pasted token must keep
 *      working for the next job to claim it.
 *
 * If `fn` throws because the token itself is dead ("Auth expired"
 * etc), the transport layer marks the pool row permanently expired
 * (see expireClaimedSweedToken called from transport.ts); the row
 * leaves the pool rather than being released back into it.
 */

interface SweedSessionContext {
  authToken: string
  origin: 'fresh' | 'legacy'
  /**
   * Last dealer the session was pinned to via `store.auth.dealer.set`.
   * Used to skip redundant dealer-set RPCs when subsequent calls
   * target the same dealer. Mutated via setCurrentSweedDealerId().
   */
  currentDealerId: number | null
  /**
   * Source of the claimed token. The transport layer reads this to
   * decide whether an auth-error response should retire the pool row
   * (db-pasted) vs simply surface to the operator (env-fallback).
   */
  claim: ClaimedSweedToken
}

const sessionStorage = new AsyncLocalStorage<SweedSessionContext>()

export function getCurrentSweedAuthToken(): string | null {
  return sessionStorage.getStore()?.authToken ?? null
}

export function hasActiveSweedSession(): boolean {
  return sessionStorage.getStore() !== undefined
}

export function getCurrentSweedSessionOrigin(): 'fresh' | 'legacy' | null {
  return sessionStorage.getStore()?.origin ?? null
}

export function getCurrentSweedDealerId(): number | null {
  return sessionStorage.getStore()?.currentDealerId ?? null
}

export function setCurrentSweedDealerId(dealerId: number | null): void {
  const store = sessionStorage.getStore()
  if (store === undefined) {
    return
  }
  store.currentDealerId = dealerId
}

/**
 * The session token claim held by the currently-executing job, or
 * null if the call is not inside a `withSweedSession` block. The
 * transport layer reads this to (a) tag auth-log rows with the pool
 * row id and (b) decide whether to retire the row on auth errors.
 */
export function getCurrentSweedSessionClaim(): ClaimedSweedToken | null {
  return sessionStorage.getStore()?.claim ?? null
}

/**
 * Run `fn` against a Sweed session claimed exclusively from the
 * pool. See file header for the full lifecycle.
 *
 * Nested calls reuse the outer session — we never re-claim inside a
 * session that already has a token pinned.
 *
 * Empty-pool handling: if every unexpired pool row is currently
 * leased to another worker, we throw a
 * `DependencyUnavailableWorkerError` so the worker loop defers the
 * job (re-queues with a short delay) instead of failing it. This is
 * the natural backpressure for "more concurrent Sweed jobs than pool
 * tokens" — extra jobs sit in the queue until a token frees up,
 * rather than erroring out.
 *
 * Concurrency: there is NO per-process serialization. With each job
 * holding an exclusive pool row, Sweed's server-side dealer context
 * is partitioned by token and two jobs in the same worker can run
 * in parallel safely. The old `runWithSweedSessionLock` mutex made
 * sense only under the shared-token model.
 */
export async function withSweedSession<T>(fn: () => Promise<T>): Promise<T> {
  if (sessionStorage.getStore() !== undefined) {
    return fn()
  }

  const jobCtx = getCurrentJobAuthContext()
  const claimedBy = buildClaimTag(jobCtx ? { jobId: jobCtx.jobId } : null)
  const claim = await claimSweedToken({ claimedBy })
  if (claim === null) {
    throw new DependencyUnavailableWorkerError(
      'Sweed session pool exhausted: every unexpired token is currently in ' +
        'use by another worker. The job will be re-queued automatically. If ' +
        'this keeps happening, paste another live session UUID at ' +
        '/config/sweed/sessions to enlarge the pool.',
      { delayMs: POOL_EMPTY_RETRY_DELAY_MS },
    )
  }

  // `legacy` here means "shared-process token, dealer context lives on
  // the server side" — same operational semantics whether the token
  // came from the DB pool or from SWEED_AUTH_TOKEN. The distinguishing
  // tokenSource is captured per-RPC in the auth-events row.
  // Do NOT pre-populate currentDealerId from claim.initialDealerId.
  // initialDealerId is only the dealer Sweed was on at OPERATOR PASTE
  // time; any subsequent job that held this same row could have called
  // store.auth.dealer.set on Sweed's side and changed it. Pool rows
  // outlive paste events. If we trusted initialDealerId, the first
  // ensureDealerContext(X) where X equals initialDealerId would silently
  // SKIP the dealer.set call — and we'd read the WRONG dealer's data
  // back from Sweed, with no error. (Observed: a freshly-claimed token
  // whose initialDealerId was 210705 returned 1 row of inventory under
  // Midtown context — actually Bronx/state-holder data from the prior
  // job. See bulk-flower-cost-table recall bug, 2026-05-20.)
  // By leaving currentDealerId null we force the first
  // ensureDealerContext call inside the session to actually round-trip
  // store.auth.dealer.set + verification; subsequent calls within the
  // same session keep the per-RPC-skip optimization.
  const context: SweedSessionContext = {
    authToken: claim.token,
    origin: 'legacy',
    currentDealerId: null,
    claim,
  }

  try {
    return await sessionStorage.run(context, fn)
  } finally {
    // Always release back to the pool, even on failure. If the
    // transport layer retired the row (auth-expired), the release
    // is a harmless no-op because the row's claimed_by no longer
    // matches our tag once it's been marked expired with claim
    // columns cleared by markSweedSessionTokenExpired.
    await releaseClaimedSweedToken(claim)
  }
}
