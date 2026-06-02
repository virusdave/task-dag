import { ALL_METRIC_GRANT_KEYS, type MetricGrantKey, type SessionUser } from '../contracts/domain/auth.js'

// Shared helpers for the per-user metric subpage grant system.
//
// Single source of truth for:
//   * which grant the admin role implicitly carries (all)
//   * which grant a given registered time-series metric belongs to
//     (used by both the /api/metrics/:metricId data endpoint
//     authorization and the client tab visibility filter on
//     MetricsLayoutPage)
//
// Keep the mapping in sync with:
//   - METRICS_TABS in helios/src/client/routes/metrics/MetricsLayoutPage.tsx
//   - the /api/metrics/:metricId gate in helios/src/server/routes/metrics.ts

// Group buckets borrowed from MetricsLayoutPage.tsx. A metric is
// "inventory-ish" if its group is one of these — those metrics drive
// the Reordering surface and need a 'reordering' grant.
const INVENTORY_GROUPS: ReadonlySet<string> = new Set([
  'Inventory',
  'Running low',
  'Slow movers',
])

/** Returns the grant key required to query a registered metric by group. */
export function metricGrantForGroup(group: string | null | undefined): MetricGrantKey {
  if (group && INVENTORY_GROUPS.has(group)) return 'reordering'
  return 'explore'
}

/** Admin shortcut + literal-set membership check. */
export function userHasMetricGrant(
  user: Pick<SessionUser, 'role' | 'metricGrants'> | null | undefined,
  key: MetricGrantKey,
): boolean {
  if (!user) return false
  if (user.role === 'admin') return true
  return user.metricGrants.includes(key)
}

/**
 * True iff the user has at least one of the requested grants. Used
 * for endpoints that serve multiple subpages with a single payload
 * (e.g. /api/catalog-analytics/* is shared by Explore, Brands, and
 * Distributors).
 */
export function userHasAnyMetricGrant(
  user: Pick<SessionUser, 'role' | 'metricGrants'> | null | undefined,
  keys: ReadonlyArray<MetricGrantKey>,
): boolean {
  if (!user) return false
  if (user.role === 'admin') return true
  for (const k of keys) {
    if (user.metricGrants.includes(k)) return true
  }
  return false
}

/** Returns the effective set: ALL keys for admins, the literal set otherwise. */
export function effectiveMetricGrants(
  user: Pick<SessionUser, 'role' | 'metricGrants'> | null | undefined,
): ReadonlyArray<MetricGrantKey> {
  if (!user) return []
  if (user.role === 'admin') return ALL_METRIC_GRANT_KEYS
  return user.metricGrants
}

/** Dedupes + validates an array of grant strings against the enum. */
export function normalizeMetricGrants(input: ReadonlyArray<MetricGrantKey>): MetricGrantKey[] {
  const seen = new Set<MetricGrantKey>()
  const out: MetricGrantKey[] = []
  for (const k of input) {
    if (seen.has(k)) continue
    seen.add(k)
    out.push(k)
  }
  return out
}
