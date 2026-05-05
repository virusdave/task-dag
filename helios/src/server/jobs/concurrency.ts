export const SWEED_SESSION_CONCURRENCY_KEY = 'sweed-session'

export function getOptionalSweedSessionConcurrencyKey(requiresSweedSession: boolean): string | null {
  return requiresSweedSession ? SWEED_SESSION_CONCURRENCY_KEY : null
}
