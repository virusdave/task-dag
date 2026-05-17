// Historically every Sweed-touching job was enqueued with
// `concurrency_key='sweed-session'` so the lease query would refuse
// to run two of them at once. That made sense when the worker
// shared a single SWEED_AUTH_TOKEN and dealer context, but now
// every job claims its own exclusive row from the
// `sweed_session_tokens` pool (claimAvailableSweedSessionToken in
// the queries module) — that claim IS the mutual-exclusion
// mechanism. Funneling every Sweed job through a single concurrency
// key on top of that just caps throughput to one job at a time
// regardless of pool size, which is exactly the bug we hit. So
// from now on Sweed jobs use `concurrency_key = null` and the
// pool's claim/release lease does the gating.
//
// The exported symbol is retained (returning null) so all the
// existing call sites compile unchanged; once they're all migrated
// to just passing `null` we can delete the helper entirely.
export const SWEED_SESSION_CONCURRENCY_KEY = null

export function getOptionalSweedSessionConcurrencyKey(_requiresSweedSession: boolean): string | null {
  return null
}
