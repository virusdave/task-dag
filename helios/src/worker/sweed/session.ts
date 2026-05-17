import { AsyncLocalStorage } from 'node:async_hooks'

import {
  buildClaimTag,
  claimSweedToken,
  releaseClaimedSweedToken,
  type ClaimedSweedToken,
} from './activeSessionToken.js'
import { getCurrentJobAuthContext } from './authLog.js'
import { runWithSweedSessionLock } from './sessionLock.js'

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
 */
export async function withSweedSession<T>(fn: () => Promise<T>): Promise<T> {
  if (sessionStorage.getStore() !== undefined) {
    return fn()
  }

  const jobCtx = getCurrentJobAuthContext()
  const claimedBy = buildClaimTag(jobCtx ? { jobId: jobCtx.jobId } : null)
  const claim = await claimSweedToken({ claimedBy })
  if (claim === null) {
    throw new Error(
      'Sweed session pool is empty. Paste a live session UUID at ' +
        '/config/sweed/sessions (or set SWEED_AUTH_TOKEN as a bootstrap ' +
        'fallback in the helios runtime env).',
    )
  }

  // `legacy` here means "shared-process token, dealer context lives on
  // the server side" — same operational semantics whether the token
  // came from the DB pool or from SWEED_AUTH_TOKEN. The distinguishing
  // tokenSource is captured per-RPC in the auth-events row.
  const context: SweedSessionContext = {
    authToken: claim.token,
    origin: 'legacy',
    currentDealerId: claim.initialDealerId,
    claim,
  }

  try {
    return await runWithSweedSessionLock(() => sessionStorage.run(context, fn))
  } finally {
    // Always release back to the pool, even on failure. If the
    // transport layer retired the row (auth-expired), the release
    // is a harmless no-op because the row's claimed_by no longer
    // matches our tag once it's been marked expired with claim
    // columns cleared by markSweedSessionTokenExpired.
    await releaseClaimedSweedToken(claim)
  }
}
