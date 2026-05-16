/**
 * Process-wide mutex that serializes Sweed RPC calls which depend on
 * the server-side dealer context (the per-auth-token dealer that
 * Sweed remembers between `store.auth.dealer.set` calls).
 *
 * Helios runs multiple worker jobs concurrently (default
 * WORKER_MAX_CONCURRENT_JOBS=2). All jobs share a single
 * SWEED_AUTH_TOKEN and therefore a single server-side dealer
 * context. Without this lock, job A can call
 * `store.auth.dealer.set(midtownSite)` followed by job B calling
 * `store.auth.dealer.set(stateDealer)` between job A's set and its
 * real RPC, leaving job A executing its call against the state
 * dealer instead of midtown.
 *
 * Symptom previously observed: the screen-banner-bounce job hitting
 * `store.screen.carousel.banner.list failed: Action does not exist
 * or you do not have permission` (subcode 14002), which is exactly
 * what Sweed returns when you call that method while the session is
 * pinned to the state dealer instead of a store/site dealer.
 *
 * Anything that calls `store.auth.dealer.set` and then issues
 * follow-up RPCs MUST do so inside `runWithSweedSessionLock` so the
 * pair cannot be interleaved with another job's dealer switch.
 */

let chain: Promise<unknown> = Promise.resolve()

export function runWithSweedSessionLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn)
  // Make sure a rejection in this caller doesn't poison the chain for
  // the next caller, but always preserve ordering.
  chain = next.then(
    () => undefined,
    () => undefined,
  )
  return next
}
