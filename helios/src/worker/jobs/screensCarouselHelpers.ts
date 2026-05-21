/**
 * Shared helpers for the screen-carousel worker jobs.
 *
 * Every screens job currently follows the same pattern:
 *   `store.screen.carousel.list`        → list screens
 *   `store.screen.carousel.banner.list` → list each screen's banners
 *
 * Sweed rejects `store.screen.carousel.banner.list` on any screen
 * whose `enabled` flag is false with the *misleading* error
 *
 *   `Action does not exist or you do not have permission`  (subcode 14002)
 *
 * which used to abort the whole job — most visibly the operator-facing
 * "Queue 30-second banner/screen bounce" button on /screens, which has
 * been failing on every attempt because the Midtown carousel contains
 * a disabled screen named "DEAD - TV SE Over Kiosks" (id 255).
 *
 * Each job uses both layers below:
 *
 *   `isScreenEligibleForBannerOps` — call as a `.filter(...)` predicate
 *   after `store.screen.carousel.list`. Disabled screens cannot have
 *   their banners listed, edited, or toggled, so iterating them is
 *   guaranteed work for guaranteed failure.
 *
 *   `looksLikeSweedDeadScreenError` — call as a safety net inside the
 *   try/catch around `store.screen.carousel.banner.list`. If the
 *   carousel.list filter ever lags reality (e.g. a screen was just
 *   disabled between the two RPCs), the job still continues with an
 *   empty banner list for that screen rather than dying.
 */

export function isScreenEligibleForBannerOps(screen: { enabled: boolean }): boolean {
  return screen.enabled
}

export function looksLikeSweedDeadScreenError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return /Action does not exist or you do not have permission/i.test(error.message)
}
