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
  getSweedMarketingSegmentMembers,
  listSweedCustomerSegments,
  listSweedMarketingSegmentsCatalogForDealers,
} from './customers.js'
import {
  isMarketingCatalogStale,
  readMarketingCatalogSegments,
  snapshotCustomerSegments,
  snapshotMarketingCatalog,
  snapshotSegmentMembers,
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

export interface BulkSegmentRefreshResult {
  segmentsTotal: number
  segmentsSnapshotted: number
  membersCached: number
  failures: Array<{ segmentId: number; segmentName: string; error: string }>
  dryRun: boolean
}

/**
 * BULK-populate `sweed_customer_segments` from each segment's full
 * member list (`store.marketing.segment.result.list`, paginated to
 * exhaustion), instead of the per-customer `store.customer.segment.list`
 * path. This is the COMPLETE-coverage populate: one paginated Sweed RPC
 * per enabled segment covers every member at once, so the cache no
 * longer depends on which customers we happened to link.
 *
 * Authoritative per-segment replace (snapshotSegmentMembers). MUST run
 * inside a `withSweedSession` block.
 *
 * Operator-/script-triggered ONLY (scripts/refresh-segment-members-bulk.ts)
 * — NOT auto-scheduled. The `result.list` response shape is
 * operator-verified (live on NY segment 1532) and the parser is
 * fail-closed (see getSweedMarketingSegmentMembers). `dryRun` fetches +
 * parses but skips all writes so the operator can confirm counts before
 * mutating the cache. Refreshes the catalog first so newly-created
 * segments are included.
 */
export async function refreshSegmentMembershipBulk(args: {
  stateDealerId: number
  dryRun?: boolean
  includeDisabled?: boolean
}): Promise<BulkSegmentRefreshResult> {
  const dryRun = args.dryRun ?? false
  // Make sure the catalog is current so we don't miss new segments.
  try {
    await refreshMarketingCatalogIfStale({ stateDealerId: args.stateDealerId })
  } catch {
    // Non-fatal: fall back to whatever catalog is already cached.
  }

  const segments = await readMarketingCatalogSegments(getPool(), {
    includeDisabled: args.includeDisabled ?? false,
  })

  const result: BulkSegmentRefreshResult = {
    segmentsTotal: segments.length,
    segmentsSnapshotted: 0,
    membersCached: 0,
    failures: [],
    dryRun,
  }

  for (const seg of segments) {
    // Prefer the segment's own scope dealer; fall back to the state
    // dealer when the catalog row doesn't carry one.
    const dealerId = seg.scopeDealerId ?? args.stateDealerId
    try {
      const members = await getSweedMarketingSegmentMembers({
        dealerId,
        segmentId: seg.segmentId,
      })
      if (!dryRun) {
        await snapshotSegmentMembers({
          segmentId: seg.segmentId,
          segmentName: seg.segmentName,
          segmentDescription: seg.segmentDescription,
          segmentTypeId: seg.segmentTypeId,
          segmentTypeName: seg.segmentTypeName,
          scopeDealerId: seg.scopeDealerId,
          scopeDealerName: null,
          members: members.map((m) => ({
            customerId: m.customerId,
            // segment.result.list has no per-member enabled flag —
            // membership is presence. Carry the segment's own enabled
            // state so the cached rows reflect whether the segment is live.
            enabled: seg.enabled,
            dateOnEnter: m.dateOnEnter,
          })),
        })
      }
      result.segmentsSnapshotted += 1
      result.membersCached += members.length
    } catch (error) {
      result.failures.push({
        segmentId: seg.segmentId,
        segmentName: seg.segmentName,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return result
}

/**
 * Refresh ONE segment's full cached membership (the Helios segment
 * details page "Refresh membership cache" button). Single-segment
 * analogue of refreshSegmentMembershipBulk: refresh the catalog so the
 * segment's metadata/scope is current, fetch its full member list via
 * one paginated `store.marketing.segment.result.list`, and
 * snapshot-replace its cached rows (authoritative per-segment writer).
 *
 * Throws on Sweed/transport failure so the caller can mark the
 * per-segment refresh highwater failed. MUST run inside a
 * `withSweedSession` block. Returns the number of members cached.
 *
 * Cost: at most one catalog refresh (highwater-gated, shared) + one
 * paginated member pull + one bounded write-on-change snapshot.
 */
export async function refreshOneSegmentMembership(args: {
  segmentId: number
  stateDealerId: number
}): Promise<number> {
  // Keep the catalog current so the segment's name/type/scope are right
  // (non-fatal: fall back to whatever is cached).
  try {
    await refreshMarketingCatalogIfStale({ stateDealerId: args.stateDealerId })
  } catch {
    // ignore — use the already-cached catalog row, if any.
  }

  const catalog = await readMarketingCatalogSegments(getPool(), { includeDisabled: true })
  const seg = catalog.find((s) => s.segmentId === args.segmentId) ?? null

  // Prefer the segment's own scope dealer; fall back to the state dealer
  // when the catalog doesn't carry one (or the segment isn't cached yet).
  const dealerId = seg?.scopeDealerId ?? args.stateDealerId
  const members = await getSweedMarketingSegmentMembers({ dealerId, segmentId: args.segmentId })

  await snapshotSegmentMembers({
    segmentId: args.segmentId,
    segmentName: seg?.segmentName ?? `Segment #${args.segmentId}`,
    segmentDescription: seg?.segmentDescription ?? null,
    segmentTypeId: seg?.segmentTypeId ?? null,
    segmentTypeName: seg?.segmentTypeName ?? null,
    scopeDealerId: seg?.scopeDealerId ?? null,
    scopeDealerName: null,
    members: members.map((m) => ({
      customerId: m.customerId,
      // result.list has no per-member enabled flag; membership is
      // presence. Carry the segment's own enabled state.
      enabled: seg?.enabled ?? null,
      dateOnEnter: m.dateOnEnter,
    })),
  })

  return members.length
}
