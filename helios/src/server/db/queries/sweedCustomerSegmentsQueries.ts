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
 *
 * Write-on-change (docs/canon/rules/DB_PERFORMANCE.md): this runs on every
 * per-scan link, so it must not churn. Instead of delete-all + reinsert it
 * (1) deletes only this customer's rows no longer present (anti-join on the
 * incoming (scope_dealer_id, segment_id) set), and (2) batch-upserts the
 * incoming rows in a single statement, with an `IS DISTINCT FROM` guard so an
 * unchanged membership row is left untouched (no dead tuple, no WAL).
 */
export async function snapshotCustomerSegments(
  args: { sweedCustomerId: number; rows: CustomerSegmentSnapshotRow[] },
): Promise<void> {
  const rows = args.rows
  const segmentIds = rows.map((r) => Number(r.segmentId))
  // scope_dealer_id is part of the PK and NOT NULL; fall back to 0 (an
  // unknown/state sentinel) when Sweed omits the owning dealer.
  const scopeDealerIds = rows.map((r) => r.scopeDealerId ?? 0)
  const names = rows.map((r) => r.segmentName)
  const descriptions = rows.map((r) => r.segmentDescription)
  const typeIds = rows.map((r) => r.segmentTypeId)
  const typeNames = rows.map((r) => r.segmentTypeName)
  const scopeDealerNames = rows.map((r) => r.scopeDealerName)
  const enabledFlags = rows.map((r) => r.enabled)
  const dateOnEnters = rows.map((r) => r.dateOnEnter)
  await withTransaction(async (tx) => {
    // (1) Drop rows for this customer that are no longer in the membership.
    await tx.query(
      `delete from sweed_customer_segments s
        where s.sweed_customer_id = $1
          and not exists (
            select 1
              from unnest($2::bigint[], $3::bigint[]) as i(scope_dealer_id, segment_id)
             where i.scope_dealer_id = s.scope_dealer_id
               and i.segment_id = s.segment_id
          )`,
      [args.sweedCustomerId, scopeDealerIds, segmentIds],
    )
    // (2) Batch-upsert the incoming rows; write only changed columns.
    if (rows.length > 0) {
      await tx.query(
        `insert into sweed_customer_segments
           (sweed_customer_id, segment_id, segment_name, segment_description,
            segment_type_id, segment_type_name, scope_dealer_id, scope_dealer_name,
            enabled, date_on_enter, refreshed_at)
         select $1, u.segment_id, u.segment_name, u.segment_description,
                u.segment_type_id, u.segment_type_name, u.scope_dealer_id,
                u.scope_dealer_name, u.enabled, u.date_on_enter, now()
           from unnest($2::bigint[], $3::bigint[], $4::text[], $5::text[],
                       $6::int[], $7::text[], $8::text[], $9::boolean[],
                       $10::timestamptz[])
             as u(segment_id, scope_dealer_id, segment_name, segment_description,
                  segment_type_id, segment_type_name, scope_dealer_name, enabled,
                  date_on_enter)
         on conflict (sweed_customer_id, scope_dealer_id, segment_id) do update set
           segment_name        = excluded.segment_name,
           segment_description = excluded.segment_description,
           segment_type_id     = excluded.segment_type_id,
           segment_type_name   = excluded.segment_type_name,
           scope_dealer_name   = excluded.scope_dealer_name,
           enabled             = excluded.enabled,
           date_on_enter       = excluded.date_on_enter,
           refreshed_at        = now()
         where (
           sweed_customer_segments.segment_name,
           sweed_customer_segments.segment_description,
           sweed_customer_segments.segment_type_id,
           sweed_customer_segments.segment_type_name,
           sweed_customer_segments.scope_dealer_name,
           sweed_customer_segments.enabled,
           sweed_customer_segments.date_on_enter
         ) is distinct from (
           excluded.segment_name,
           excluded.segment_description,
           excluded.segment_type_id,
           excluded.segment_type_name,
           excluded.scope_dealer_name,
           excluded.enabled,
           excluded.date_on_enter
         )`,
        [
          args.sweedCustomerId,
          segmentIds,
          scopeDealerIds,
          names,
          descriptions,
          typeIds,
          typeNames,
          scopeDealerNames,
          enabledFlags,
          dateOnEnters,
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
  // Write-on-change (docs/canon/rules/DB_PERFORMANCE.md): the catalog is
  // refreshed every few hours and rarely changes, so don't delete-all +
  // reinsert (that churns the whole table each run). Delete only segments no
  // longer in the catalog, then upsert with an `IS DISTINCT FROM` guard so
  // unchanged rows are left untouched. The per-row loop is fine here: the
  // catalog is ~tens of rows, not the 1000s the membership writers handle.
  const segmentIds = rows.map((r) => Number(r.segmentId))
  await withTransaction(async (tx) => {
    await tx.query(
      `delete from sweed_marketing_segments s
        where not exists (
          select 1 from unnest($1::bigint[]) as i(segment_id)
           where i.segment_id = s.segment_id
        )`,
      [segmentIds],
    )
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
           refreshed_at      = now()
         where (
           sweed_marketing_segments.segment_name,
           sweed_marketing_segments.segment_type_id,
           sweed_marketing_segments.segment_type_name,
           sweed_marketing_segments.enabled,
           sweed_marketing_segments.total_customers,
           sweed_marketing_segments.scope_dealer_id,
           sweed_marketing_segments.target_store_names
         ) is distinct from (
           excluded.segment_name,
           excluded.segment_type_id,
           excluded.segment_type_name,
           excluded.enabled,
           excluded.total_customers,
           excluded.scope_dealer_id,
           excluded.target_store_names
         )`,
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

// =====================================================================
// Read — bounded chips for the check-ins LIST (many customers at once)
// =====================================================================

export interface VisitorScanMarketingSegmentChip {
  segmentId: string
  scopeDealerId: number | null
  name: string
  type: SweedSegmentType
  scopeLabel: string
}

export interface VisitorScanMarketingSegmentsSummary {
  totalCount: number
  items: VisitorScanMarketingSegmentChip[]
}

interface ChipRow {
  sweed_customer_id: string | number
  segment_id: string
  scope_dealer_id: string | number | null
  segment_name: string
  segment_type_id: number | null
  scope_dealer_name: string | null
  total_count: string | number
}

// Max chips returned per customer; the rest are summarised as "+N more".
const VISITOR_SCAN_SEGMENT_CHIP_LIMIT = 3

/**
 * Batch-read a bounded marketing-segment summary for a page of linked
 * customers, for the check-ins list's Expanded view.
 *
 * DB-cost (docs/canon/rules/DB_PERFORMANCE.md): ONE query for the whole
 * page (vs a per-row lateral join inside the already-complex scan list
 * query). The page is capped at limit+1 rows, so the input id array is
 * tiny and the scan over `sweed_customer_segments` rides the
 * customer-leading primary key. We return only the top
 * VISITOR_SCAN_SEGMENT_CHIP_LIMIT rows per customer plus the full
 * enabled membership count, so payload stays small regardless of how
 * many segments a customer is in. Disabled segments are excluded.
 */
export async function readMarketingSegmentChipsForCustomers(
  db: Queryable,
  sweedCustomerIds: readonly number[],
): Promise<Map<number, VisitorScanMarketingSegmentsSummary>> {
  const out = new Map<number, VisitorScanMarketingSegmentsSummary>()
  const ids = [...new Set(sweedCustomerIds.filter((id) => Number.isInteger(id) && id > 0))]
  if (ids.length === 0) return out

  const res = await db.query<ChipRow>(
    `with ranked as (
       select
         s.sweed_customer_id,
         s.segment_id::text                                 as segment_id,
         s.scope_dealer_id,
         s.segment_name,
         s.segment_type_id,
         s.scope_dealer_name,
         count(*) over (partition by s.sweed_customer_id)   as total_count,
         row_number() over (
           partition by s.sweed_customer_id
           order by
             case when s.segment_type_id = 1 then 0 else 1 end,
             s.segment_name asc,
             s.segment_id asc
         )                                                  as rn
       from sweed_customer_segments s
       where s.sweed_customer_id = any($1::bigint[])
         and s.enabled is distinct from false
     )
     select sweed_customer_id, segment_id, scope_dealer_id, segment_name,
            segment_type_id, scope_dealer_name, total_count
       from ranked
      where rn <= $2
      order by sweed_customer_id, rn`,
    [ids, VISITOR_SCAN_SEGMENT_CHIP_LIMIT],
  )

  for (const r of res.rows) {
    const customerId = Number(r.sweed_customer_id)
    const scopeDealerId =
      r.scope_dealer_id === null || Number(r.scope_dealer_id) === 0
        ? null
        : Number(r.scope_dealer_id)
    const { scopeLabel } = membershipScope(scopeDealerId, r.scope_dealer_name)
    let entry = out.get(customerId)
    if (!entry) {
      entry = { totalCount: Number(r.total_count), items: [] }
      out.set(customerId, entry)
    }
    entry.items.push({
      segmentId: r.segment_id,
      scopeDealerId,
      name: r.segment_name,
      type: mapSegmentType(r.segment_type_id),
      scopeLabel,
    })
  }
  return out
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

// =====================================================================
// Write — BULK per-segment membership snapshot (authoritative)
// =====================================================================
//
// WRITE-MODEL RULE (architecture review): two writers touch
// `sweed_customer_segments` with DIFFERENT delete scopes:
//   - snapshotCustomerSegments() deletes WHERE sweed_customer_id = $1
//     (per-customer full replace; on-demand details-page refresh).
//   - snapshotSegmentMembers() below deletes WHERE segment_id = $1
//     (per-segment full replace; bulk population).
// To keep them from stomping each other, BULK-BY-SEGMENT is the
// AUTHORITATIVE coverage path. The per-customer path is a targeted
// on-demand overlay. When bulk becomes the primary populate path (it is
// currently operator-/script-triggered, not auto-scheduled — see
// refreshSegmentMembershipBulk + scripts/refresh-segment-members-bulk.ts),
// the per-customer path MUST be switched to positive-only upsert (drop
// its delete) so it can no longer remove bulk-populated rows. Until
// then, do not run both continuously against the same customers.
//
// Deleting by segment_id ALONE (not (scope_dealer_id, segment_id)) is
// deliberate: segment ids are globally unique (sweed_marketing_segments
// PK is segment_id), so a corrected scope can never leave stale dupes.

export interface SegmentMemberRow {
  customerId: number
  enabled: boolean | null
  dateOnEnter: string | null
}

export interface SegmentMembershipSnapshot {
  segmentId: number
  segmentName: string
  segmentDescription: string | null
  segmentTypeId: number | null
  segmentTypeName: string | null
  /** Segment's owning (scope) dealer; part of the row PK. */
  scopeDealerId: number | null
  scopeDealerName: string | null
  members: SegmentMemberRow[]
}

/**
 * Snapshot-replace ALL cached membership rows for one segment from the
 * bulk `store.marketing.segment.result.list` member list. Authoritative:
 * this is the only writer allowed to delete by segment. Replacing the
 * whole set per segment is safe because result.list paginates the
 * segment's FULL membership.
 *
 * Write-on-change + indexed (docs/canon/rules/DB_PERFORMANCE.md): the
 * operator bulk-populates every segment (NY segment 1532 alone = 1412
 * members), so this must not seq-scan or churn. It (1) deletes only the
 * segment's stale rows (members no longer present, or whose scope dealer
 * changed) via the `sweed_customer_segments_segment_customer_idx`
 * (segment_id, sweed_customer_id) index — see migration 080 — and (2)
 * batch-upserts all members in one `unnest()` statement (not N round-trips),
 * with an `IS DISTINCT FROM` guard so unchanged members are left untouched.
 * An empty member list correctly clears every row for the segment.
 */
export async function snapshotSegmentMembers(snapshot: SegmentMembershipSnapshot): Promise<void> {
  const scopeDealerId = snapshot.scopeDealerId ?? 0
  const customerIds = snapshot.members.map((m) => m.customerId)
  const enabledFlags = snapshot.members.map((m) => m.enabled)
  const dateOnEnters = snapshot.members.map((m) => m.dateOnEnter)
  await withTransaction(async (tx) => {
    // (1) Drop rows for this segment that are no longer members, or whose
    // scope dealer changed (the new-scope row is re-inserted below). Uses
    // the (segment_id, sweed_customer_id) index; no seq scan.
    await tx.query(
      `delete from sweed_customer_segments s
        where s.segment_id = $1
          and (
            s.scope_dealer_id is distinct from $2::bigint
            or not exists (
              select 1
                from unnest($3::bigint[]) as i(sweed_customer_id)
               where i.sweed_customer_id = s.sweed_customer_id
            )
          )`,
      [snapshot.segmentId, scopeDealerId, customerIds],
    )
    // (2) Batch-upsert all members; write only changed columns.
    if (customerIds.length > 0) {
      await tx.query(
        `insert into sweed_customer_segments
           (sweed_customer_id, segment_id, segment_name, segment_description,
            segment_type_id, segment_type_name, scope_dealer_id, scope_dealer_name,
            enabled, date_on_enter, refreshed_at)
         select u.sweed_customer_id, $1, $2, $3, $4, $5, $6, $7,
                u.enabled, u.date_on_enter, now()
           from unnest($8::bigint[], $9::boolean[], $10::timestamptz[])
             as u(sweed_customer_id, enabled, date_on_enter)
         on conflict (sweed_customer_id, scope_dealer_id, segment_id) do update set
           segment_name        = excluded.segment_name,
           segment_description = excluded.segment_description,
           segment_type_id     = excluded.segment_type_id,
           segment_type_name   = excluded.segment_type_name,
           scope_dealer_name   = excluded.scope_dealer_name,
           enabled             = excluded.enabled,
           date_on_enter       = excluded.date_on_enter,
           refreshed_at        = now()
         where (
           sweed_customer_segments.segment_name,
           sweed_customer_segments.segment_description,
           sweed_customer_segments.segment_type_id,
           sweed_customer_segments.segment_type_name,
           sweed_customer_segments.scope_dealer_name,
           sweed_customer_segments.enabled,
           sweed_customer_segments.date_on_enter
         ) is distinct from (
           excluded.segment_name,
           excluded.segment_description,
           excluded.segment_type_id,
           excluded.segment_type_name,
           excluded.scope_dealer_name,
           excluded.enabled,
           excluded.date_on_enter
         )`,
        [
          snapshot.segmentId,
          snapshot.segmentName,
          snapshot.segmentDescription,
          snapshot.segmentTypeId,
          snapshot.segmentTypeName,
          scopeDealerId,
          snapshot.scopeDealerName,
          customerIds,
          enabledFlags,
          dateOnEnters,
        ],
      )
    }
  })
}

export interface MarketingCatalogSegment {
  segmentId: number
  segmentName: string
  segmentDescription: string | null
  segmentTypeId: number | null
  segmentTypeName: string | null
  scopeDealerId: number | null
  enabled: boolean | null
}

/**
 * Read the cached marketing-segment catalog rows for the bulk
 * membership refresh. Enabled segments only by default (disabled
 * segments are not worth a Sweed round-trip).
 */
export async function readMarketingCatalogSegments(
  db: Queryable,
  opts: { includeDisabled?: boolean } = {},
): Promise<MarketingCatalogSegment[]> {
  const res = await db.query<{
    segment_id: string
    segment_name: string
    segment_type_id: number | null
    segment_type_name: string | null
    scope_dealer_id: string | null
    enabled: boolean | null
  }>(
    `select segment_id, segment_name, segment_type_id, segment_type_name,
            scope_dealer_id, enabled
       from sweed_marketing_segments
      ${opts.includeDisabled ? '' : 'where coalesce(enabled, true) = true'}
      order by segment_name asc`,
  )
  return res.rows.map((r) => ({
    segmentId: Number(r.segment_id),
    segmentName: r.segment_name,
    segmentDescription: null,
    segmentTypeId: r.segment_type_id,
    segmentTypeName: r.segment_type_name,
    scopeDealerId: r.scope_dealer_id === null ? null : Number(r.scope_dealer_id),
    enabled: r.enabled,
  }))
}
