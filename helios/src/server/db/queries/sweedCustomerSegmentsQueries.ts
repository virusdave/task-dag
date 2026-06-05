// Cache read/write for the Sweed marketing-segment surface on the
// customer / check-in details page (virusdave/top-level#12).
//
// Tables (migration 059_sweed_customer_segments.sql):
//   - sweed_customer_segments          per-customer membership cache
//   - sweed_customer_segments_refresh  per-customer refresh highwater
//   - sweed_marketing_segments         global segment catalog cache
//   - sweed_marketing_segments_refresh global catalog refresh highwater
//
// DB-cost note (docs/canon/AGENTS_CANON.md): the details endpoint only
// ever READS these tables (indexed PK lookups). Writes happen on the
// link worker's best-effort post-link refresh and the operator's
// manual "Refresh segments" button — never on page load. The catalog
// is refreshed at most once every few hours via a global highwater so
// scan volume can't inflate Sweed call volume.

import type { Queryable } from '../pool.js'
import { withTransaction } from '../tx.js'
import {
  HELIOS_PENDING_PURCHASE_SITE_DEALERS,
  type CustomerVisitorAddableSegment,
  type CustomerVisitorSegmentMembership,
  type SweedSegmentScopeLevel,
  type SweedSegmentType,
} from '../../../shared/contracts/index.js'

// Sweed Prime deep-link base for a single segment's editor page. By
// analogy with the documented `/marketing/events/event/<id>` and
// `/marketing/discounts/campaign/<id>` URLs (docs/sweed/marketing.md);
// this is where an operator adds members to a Static segment by hand.
const SWEED_PRIME_SEGMENT_URL_BASE = 'https://prime.sweedpos.com/marketing/segments/segment'

export function sweedPrimeSegmentUrl(segmentId: string | number): string {
  return `${SWEED_PRIME_SEGMENT_URL_BASE}/${segmentId}`
}

function mapSegmentType(typeId: number | null): SweedSegmentType {
  if (typeId === 1) return 'static'
  if (typeId === 2) return 'dynamic'
  return 'unknown'
}

function isSiteDealer(dealerId: number | null): boolean {
  if (dealerId === null) return false
  return HELIOS_PENDING_PURCHASE_SITE_DEALERS.some((d) => d.dealerId === dealerId)
}

function siteLabelForDealer(dealerId: number | null): string | null {
  const d = HELIOS_PENDING_PURCHASE_SITE_DEALERS.find((x) => x.dealerId === dealerId)
  return d ? d.siteLabel : null
}

// Membership scope: site iff the segment's owning dealer is one of our
// store dealers; otherwise state-level (e.g. the 210248 state holder).
function membershipScope(
  scopeDealerId: number | null,
  scopeDealerName: string | null,
): { scopeLevel: SweedSegmentScopeLevel; scopeLabel: string } {
  if (isSiteDealer(scopeDealerId)) {
    return { scopeLevel: 'site', scopeLabel: siteLabelForDealer(scopeDealerId) ?? 'Site' }
  }
  return { scopeLevel: 'state', scopeLabel: scopeDealerName?.trim() || 'All stores' }
}

// Catalog scope: derived from the dealer context the segment was seen
// under (site iff a store dealer, else state). Falls back to the
// target-store names when no scope dealer was recorded.
function catalogScope(
  scopeDealerId: number | null,
  targetStoreNames: string[],
): { scopeLevel: SweedSegmentScopeLevel; scopeLabel: string } {
  if (isSiteDealer(scopeDealerId)) {
    return { scopeLevel: 'site', scopeLabel: siteLabelForDealer(scopeDealerId) ?? 'Site' }
  }
  if (scopeDealerId !== null) {
    // Non-site dealer (the state holder) => state-wide.
    return { scopeLevel: 'state', scopeLabel: 'All stores' }
  }
  const names = targetStoreNames.map((n) => n.trim()).filter((n) => n.length > 0)
  const isAllStores = names.length === 0 || names.some((n) => /^all stores$/i.test(n))
  if (isAllStores) return { scopeLevel: 'state', scopeLabel: 'All stores' }
  return { scopeLevel: 'site', scopeLabel: names.join(', ') }
}

// =====================================================================
// Write — per-customer membership snapshot
// =====================================================================

export interface CustomerSegmentSnapshotRow {
  segmentId: string
  segmentName: string
  segmentDescription: string | null
  segmentTypeId: number | null
  segmentTypeName: string | null
  scopeDealerId: number | null
  scopeDealerName: string | null
  enabled: boolean | null
  dateOnEnter: string | null
}

/**
 * Snapshot-replace a customer's cached segment membership and stamp the
 * refresh highwater 'ok'. Replacing the whole set is safe because
 * `store.customer.segment.list` returns the customer's FULL membership
 * (verified context-independent).
 */
export async function snapshotCustomerSegments(
  args: { sweedCustomerId: number; rows: CustomerSegmentSnapshotRow[] },
): Promise<void> {
  await withTransaction(async (tx) => {
    await tx.query(`delete from sweed_customer_segments where sweed_customer_id = $1`, [
      args.sweedCustomerId,
    ])
    for (const r of args.rows) {
      // scope_dealer_id is part of the PK and NOT NULL; fall back to 0
      // (an unknown/state sentinel) when Sweed omits the owning dealer.
      const scopeDealerId = r.scopeDealerId ?? 0
      await tx.query(
        `insert into sweed_customer_segments
           (sweed_customer_id, segment_id, segment_name, segment_description,
            segment_type_id, segment_type_name, scope_dealer_id, scope_dealer_name,
            enabled, date_on_enter, refreshed_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())
         on conflict (sweed_customer_id, scope_dealer_id, segment_id) do update set
           segment_name        = excluded.segment_name,
           segment_description = excluded.segment_description,
           segment_type_id     = excluded.segment_type_id,
           segment_type_name   = excluded.segment_type_name,
           scope_dealer_name   = excluded.scope_dealer_name,
           enabled             = excluded.enabled,
           date_on_enter       = excluded.date_on_enter,
           refreshed_at        = now()`,
        [
          args.sweedCustomerId,
          Number(r.segmentId),
          r.segmentName,
          r.segmentDescription,
          r.segmentTypeId,
          r.segmentTypeName,
          scopeDealerId,
          r.scopeDealerName,
          r.enabled,
          r.dateOnEnter,
        ],
      )
    }
    await tx.query(
      `insert into sweed_customer_segments_refresh
         (sweed_customer_id, status, refreshed_at, segment_count, last_error, updated_at)
       values ($1, 'ok', now(), $2, null, now())
       on conflict (sweed_customer_id) do update set
         status        = 'ok',
         refreshed_at  = now(),
         segment_count = excluded.segment_count,
         last_error    = null,
         updated_at    = now()`,
      [args.sweedCustomerId, args.rows.length],
    )
  })
}

export async function markCustomerSegmentsRefreshPending(
  db: Queryable,
  sweedCustomerId: number,
): Promise<void> {
  await db.query(
    `insert into sweed_customer_segments_refresh
       (sweed_customer_id, status, requested_at, updated_at)
     values ($1, 'pending', now(), now())
     on conflict (sweed_customer_id) do update set
       status       = 'pending',
       requested_at = now(),
       updated_at   = now()`,
    [sweedCustomerId],
  )
}

export async function markCustomerSegmentsRefreshFailed(
  db: Queryable,
  args: { sweedCustomerId: number; error: string },
): Promise<void> {
  await db.query(
    `insert into sweed_customer_segments_refresh
       (sweed_customer_id, status, last_error, updated_at)
     values ($1, 'failed', $2, now())
     on conflict (sweed_customer_id) do update set
       status     = 'failed',
       last_error = excluded.last_error,
       updated_at = now()`,
    [args.sweedCustomerId, args.error.slice(0, 1000)],
  )
}

// =====================================================================
// Write — global catalog snapshot
// =====================================================================

export interface MarketingSegmentCatalogRow {
  segmentId: string
  segmentName: string
  segmentTypeId: number | null
  segmentTypeName: string | null
  enabled: boolean | null
  totalCustomers: number | null
  scopeDealerId: number | null
  targetStoreNames: string[]
}

/** Whether the catalog cache is missing or older than `maxAgeHours`. */
export async function isMarketingCatalogStale(
  db: Queryable,
  maxAgeHours: number,
): Promise<boolean> {
  const res = await db.query<{ stale: boolean }>(
    `select coalesce(
       (select refreshed_at is null
               or refreshed_at < now() - ($1 || ' hours')::interval
          from sweed_marketing_segments_refresh where id = 1),
       true
     ) as stale`,
    [String(maxAgeHours)],
  )
  return res.rows[0]?.stale !== false
}

export async function snapshotMarketingCatalog(
  rows: MarketingSegmentCatalogRow[],
): Promise<void> {
  await withTransaction(async (tx) => {
    await tx.query(`delete from sweed_marketing_segments`)
    for (const r of rows) {
      await tx.query(
        `insert into sweed_marketing_segments
           (segment_id, segment_name, segment_type_id, segment_type_name,
            enabled, total_customers, scope_dealer_id, target_store_names, refreshed_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8, now())
         on conflict (segment_id) do update set
           segment_name      = excluded.segment_name,
           segment_type_id   = excluded.segment_type_id,
           segment_type_name = excluded.segment_type_name,
           enabled           = excluded.enabled,
           total_customers   = excluded.total_customers,
           scope_dealer_id   = excluded.scope_dealer_id,
           target_store_names = excluded.target_store_names,
           refreshed_at      = now()`,
        [
          Number(r.segmentId),
          r.segmentName,
          r.segmentTypeId,
          r.segmentTypeName,
          r.enabled,
          r.totalCustomers,
          r.scopeDealerId,
          r.targetStoreNames,
        ],
      )
    }
    await tx.query(
      `insert into sweed_marketing_segments_refresh
         (id, status, refreshed_at, segment_count, last_error, updated_at)
       values (1, 'ok', now(), $1, null, now())
       on conflict (id) do update set
         status        = 'ok',
         refreshed_at  = now(),
         segment_count = excluded.segment_count,
         last_error    = null,
         updated_at    = now()`,
      [rows.length],
    )
  })
}

// =====================================================================
// Read — for the details endpoint
// =====================================================================

interface MembershipRow {
  segment_id: string
  segment_name: string
  segment_description: string | null
  segment_type_id: number | null
  scope_dealer_id: string | number | null
  scope_dealer_name: string | null
  enabled: boolean | null
  date_on_enter: Date | null
}

export async function readCustomerSegments(
  db: Queryable,
  sweedCustomerId: number,
): Promise<CustomerVisitorSegmentMembership[]> {
  const res = await db.query<MembershipRow>(
    `select segment_id::text, segment_name, segment_description, segment_type_id,
            scope_dealer_id, scope_dealer_name, enabled, date_on_enter
       from sweed_customer_segments
      where sweed_customer_id = $1
      order by segment_name asc`,
    [sweedCustomerId],
  )
  return res.rows.map((r) => {
    const scopeDealerId =
      r.scope_dealer_id === null || Number(r.scope_dealer_id) === 0
        ? null
        : Number(r.scope_dealer_id)
    const { scopeLevel, scopeLabel } = membershipScope(scopeDealerId, r.scope_dealer_name)
    return {
      segmentId: r.segment_id,
      name: r.segment_name,
      description: r.segment_description,
      type: mapSegmentType(r.segment_type_id),
      scopeLevel,
      scopeLabel,
      enabled: r.enabled,
      dateOnEnter: r.date_on_enter ? r.date_on_enter.toISOString() : null,
    }
  })
}

interface CatalogStaticRow {
  segment_id: string
  segment_name: string
  enabled: boolean | null
  scope_dealer_id: string | number | null
  target_store_names: string[] | null
}

/**
 * Static segments from the catalog that the customer is NOT already in.
 * Excludes disabled segments and the obvious probe/test segments so the
 * "add" picker stays clean.
 */
export async function readAddableStaticSegments(
  db: Queryable,
  sweedCustomerId: number,
): Promise<CustomerVisitorAddableSegment[]> {
  const res = await db.query<CatalogStaticRow>(
    `select c.segment_id::text, c.segment_name, c.enabled, c.scope_dealer_id, c.target_store_names
       from sweed_marketing_segments c
      where c.segment_type_id = 1
        and coalesce(c.enabled, true) = true
        and not exists (
          select 1 from sweed_customer_segments m
           where m.sweed_customer_id = $1
             and m.segment_id = c.segment_id
        )
      order by c.segment_name asc`,
    [sweedCustomerId],
  )
  return res.rows.map((r) => {
    const scopeDealerId = r.scope_dealer_id === null ? null : Number(r.scope_dealer_id)
    const { scopeLevel, scopeLabel } = catalogScope(scopeDealerId, r.target_store_names ?? [])
    return {
      segmentId: r.segment_id,
      name: r.segment_name,
      scopeLevel,
      scopeLabel,
      enabled: r.enabled,
      sweedPrimeUrl: sweedPrimeSegmentUrl(r.segment_id),
    }
  })
}

export interface CustomerSegmentsRefreshState {
  status: 'never' | 'pending' | 'ok' | 'failed'
  refreshedAt: string | null
  lastError: string | null
}

export async function readSegmentsRefreshState(
  db: Queryable,
  sweedCustomerId: number,
): Promise<CustomerSegmentsRefreshState> {
  const res = await db.query<{
    status: 'pending' | 'ok' | 'failed'
    refreshed_at: Date | null
    last_error: string | null
  }>(
    `select status, refreshed_at, last_error
       from sweed_customer_segments_refresh
      where sweed_customer_id = $1`,
    [sweedCustomerId],
  )
  const row = res.rows[0]
  if (!row) {
    return { status: 'never', refreshedAt: null, lastError: null }
  }
  return {
    status: row.status,
    refreshedAt: row.refreshed_at ? row.refreshed_at.toISOString() : null,
    lastError: row.last_error,
  }
}
