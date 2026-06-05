// Shared Sweed marketing-segment refresh helpers
// (virusdave/top-level#12).
//
// Both the per-scan link worker (best-effort, after a successful link)
// and the operator-triggered refresh job reuse these so the
// fetch→map→snapshot logic lives in exactly one place. Callers MUST be
// inside a `withSweedSession` block (these issue Sweed RPCs).
//
// DB-cost discipline (docs/canon/AGENTS_CANON.md):
//   - Membership refresh is ONE Sweed RPC + one bounded snapshot write.
//   - The catalog refresh is global and gated by a highwater so it
//     fires at most once per `maxAgeHours` no matter how many scans or
//     manual refreshes flow through.

import { getPool } from '../../server/db/pool.js'
import { HELIOS_PENDING_PURCHASE_SITE_DEALERS } from '../../shared/contracts/index.js'
import {
  listSweedCustomerSegments,
  listSweedMarketingSegmentsCatalogForDealers,
} from './customers.js'
import {
  isMarketingCatalogStale,
  snapshotCustomerSegments,
  snapshotMarketingCatalog,
  type CustomerSegmentSnapshotRow,
  type MarketingSegmentCatalogRow,
} from '../../server/db/queries/sweedCustomerSegmentsQueries.js'

// Catalog is small and changes rarely; once every 6h is plenty fresh
// for the "add to a static segment" picker and keeps Sweed calls flat.
const CATALOG_MAX_AGE_HOURS = 6

/**
 * Refresh one customer's cached segment membership from Sweed. Throws
 * on Sweed/transport failure so the caller can decide whether to mark
 * the refresh highwater failed (refresh job) or swallow it (link
 * worker — must never fail the link).
 *
 * Returns the number of segments cached.
 */
export async function refreshCustomerSegmentMembership(args: {
  sweedCustomerId: number
  dealerId: number
}): Promise<number> {
  const rows = await listSweedCustomerSegments({
    dealerId: args.dealerId,
    customerId: args.sweedCustomerId,
  })
  const snapshot: CustomerSegmentSnapshotRow[] = rows.map((r) => ({
    segmentId: r.id,
    segmentName: (r.name ?? '').trim() || '(unnamed segment)',
    segmentDescription: r.description ?? null,
    segmentTypeId: r.type?.id ?? null,
    segmentTypeName: r.type?.name ?? null,
    scopeDealerId: r.dealer?.id ?? null,
    scopeDealerName: r.dealer?.name ?? null,
    enabled: r.enabled ?? null,
    dateOnEnter: r.dateOnEnter ?? null,
  }))
  await snapshotCustomerSegments({ sweedCustomerId: args.sweedCustomerId, rows: snapshot })
  return snapshot.length
}

/**
 * Refresh the global marketing-segment catalog if it's stale. No-op
 * (returns false) when the cache is fresh. Best-effort: callers
 * generally ignore the boolean.
 */
export async function refreshMarketingCatalogIfStale(args: {
  stateDealerId: number
  maxAgeHours?: number
}): Promise<boolean> {
  const pool = getPool()
  const stale = await isMarketingCatalogStale(pool, args.maxAgeHours ?? CATALOG_MAX_AGE_HOURS)
  if (!stale) return false
  // segment.list is dealer-scoped, so fan out: state dealer first (keeps
  // org-wide segments state-scoped on dedup), then both site dealers
  // (which own the static delivery/import segments).
  const dealerIds = [
    args.stateDealerId,
    ...HELIOS_PENDING_PURCHASE_SITE_DEALERS.map((d) => d.dealerId),
  ]
  const rows = await listSweedMarketingSegmentsCatalogForDealers({ dealerIds })
  const catalog: MarketingSegmentCatalogRow[] = rows.map((r) => ({
    segmentId: r.id,
    segmentName: (r.name ?? '').trim() || '(unnamed segment)',
    segmentTypeId: r.type?.id ?? null,
    segmentTypeName: r.type?.name ?? null,
    enabled: r.enabled ?? null,
    totalCustomers: r.totalCustomers ?? null,
    scopeDealerId: r.scopeDealerId,
    targetStoreNames: r.targetStoreNames ?? [],
  }))
  await snapshotMarketingCatalog(catalog)
  return true
}
