// Manual verification harness for the Sweed session-pool flow.
//
// Drives the EXACT same `withSweedSession()` path the worker uses:
//   1. CLAIM an available row from sweed_session_tokens (or fall
//      back to SWEED_AUTH_TOKEN if the pool is empty).
//   2. POST store.auth.initial.data.get with the claimed token
//      (read-only sanity check — confirms the session is alive).
//   3. POST store.auth.dealer.set to the configured state dealer
//      (read-only side effect; pins the session's dealer context).
//   4. RELEASE the claimed row back to the pool on session
//      teardown so the next worker can reuse it. There is NO
//      Sweed-side logout (no store.auth.end) — the operator-pasted
//      token must keep working for future claimers.
//
// Every RPC is auto-logged into sweed_auth_events via the same
// recordAuthEvent() path the worker uses, so a run also serves as a
// live integration test of the auth-event audit trail.
//
// Usage (locally, with a DB URL pointing at a sweed_session_tokens
// table that has at least one unexpired row):
//   DATABASE_URL=postgres://... \
//   SWEED_API_URL=https://prime.sweedpos.com/api/ \
//   npx tsx scripts/verify-sweed-session.ts
//
// Prints a structured summary to stdout and exits 0 on success, 1
// on any failure. The corresponding sweed_auth_events rows can then
// be inspected at /config/sweed-auth-log in the helios UI.

import { getWorkerEnv } from '../src/worker/config/env.js'
import { ensureDealerContext } from '../src/worker/sweed/rpc.js'
import { callSweedRpcRaw } from '../src/worker/sweed/rpc.js'
import {
  getCurrentSweedAuthToken,
  getCurrentSweedSessionClaim,
  getCurrentSweedSessionOrigin,
  withSweedSession,
} from '../src/worker/sweed/session.js'

interface InitialDataResponse {
  user?: { id?: unknown; login?: string; currentDealerId?: unknown; currentDealerName?: string | null }
}

async function main(): Promise<void> {
  const env = getWorkerEnv()

  const summary = await withSweedSession(async () => {
    const sessionOrigin = getCurrentSweedSessionOrigin()
    const claim = getCurrentSweedSessionClaim()
    const tokenPrefix = (getCurrentSweedAuthToken() ?? '').slice(0, 8)
    const source = claim?.source ?? 'unknown'
    const rowId = claim?.rowId ?? null
    console.log(
      `[verify-sweed-session] claimed: source=${source} rowId=${rowId ?? '-'} ` +
        `origin=${sessionOrigin} token=${tokenPrefix}…`,
    )

    // (a) Read-only sanity check.
    const initialData = await callSweedRpcRaw<InitialDataResponse>('store.auth.initial.data.get')
    const user = initialData.user ?? {}
    console.log('[verify-sweed-session] initial.data.get OK:', JSON.stringify({
      login: user.login,
      currentDealerId: user.currentDealerId,
      currentDealerName: user.currentDealerName,
    }))

    // (b) Read-only-ish: pin the session's dealer context.
    await ensureDealerContext(env.sweedStateDealerId)
    console.log(`[verify-sweed-session] dealer.set OK: pinned to ${env.sweedStateDealerId}`)

    return { source, rowId, sessionOrigin, tokenPrefix, dealerId: env.sweedStateDealerId }
  })
  console.log('[verify-sweed-session] session released back to pool (no Sweed-side logout).')

  console.log('[verify-sweed-session] PASS', summary)
}

main().catch((error: unknown) => {
  console.error('[verify-sweed-session] FAIL:', error instanceof Error ? error.message : error)
  process.exit(1)
})
