// Manual verification harness for the Sweed ephemeral-session flow.
//
// Drives the EXACT same `withSweedSession()` path the worker uses:
//   1. POST store.auth.user with login + password (mints a fresh
//      session token).
//   2. POST store.auth.initial.data.get with that token (read-only
//      sanity check — confirms the token is alive).
//   3. POST store.auth.dealer.set to the configured state dealer
//      (read-only side effect; pins the session's dealer context).
//   4. POST store.auth.end on session teardown (best-effort logout).
//
// Every RPC is auto-logged into sweed_auth_events via the same
// recordAuthEvent() path the worker uses, so a run also serves as a
// live integration test of the auth-event audit trail.
//
// Usage (locally, with creds in env):
//   SWEED_LOGIN_EMAIL=... SWEED_LOGIN_PASSWORD=... \
//   SWEED_API_URL=https://prime.sweedpos.com/api/ \
//   DATABASE_URL=postgres://... \
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
  getCurrentSweedSessionOrigin,
  withSweedSession,
} from '../src/worker/sweed/session.js'

interface InitialDataResponse {
  user?: { id?: unknown; login?: string; currentDealerId?: unknown; currentDealerName?: string | null }
}

async function main(): Promise<void> {
  const env = getWorkerEnv()
  const hasCredentials = env.sweedLoginEmail !== null && env.sweedLoginPassword !== null
  const hasLegacy = env.sweedAuthToken !== null
  console.log('[verify-sweed-session] mode:', hasCredentials ? 'fresh-credentials' : hasLegacy ? 'legacy-shared-token' : 'NONE')
  if (!hasCredentials && !hasLegacy) {
    console.error('[verify-sweed-session] FAIL: no Sweed auth configured (need SWEED_LOGIN_EMAIL+SWEED_LOGIN_PASSWORD or SWEED_AUTH_TOKEN).')
    process.exit(1)
  }

  const summary = await withSweedSession(async () => {
    const sessionOrigin = getCurrentSweedSessionOrigin()
    const tokenPrefix = (getCurrentSweedAuthToken() ?? '').slice(0, 8)
    console.log(`[verify-sweed-session] inside session: origin=${sessionOrigin} token=${tokenPrefix}…`)

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

    return { sessionOrigin, tokenPrefix, dealerId: env.sweedStateDealerId }
  })

  console.log('[verify-sweed-session] PASS', summary)
}

main().catch((error: unknown) => {
  console.error('[verify-sweed-session] FAIL:', error instanceof Error ? error.message : error)
  process.exit(1)
})
