// CRUD for the visitor_scan_links + visitor_scan_link_candidates
// tables (FreshlyBakedNYC/automation#31 phase A4).
//
// Conventions:
//   - `seedVisitorScanLink` is called by the visitor_scans insert
//     helper after a successful row insert; it materialises the
//     row in 'pending' or 'insufficient_data' so the background
//     worker can pick it up. Idempotent via the (scan_id) PK.
//   - `markVisitorScanLinkLinked` is for both worker auto-link AND
//     operator-confirmed match. It also flips the matching
//     candidate row (when one is supplied) to 'confirmed'.
//   - All updates set `updated_at = now()` so the worker selection
//     query orders predictably.

import type { Queryable } from '../pool.js'
import { getDealerIdForVisitorScanSiteSlug } from '../../visitorScans/dealerForSiteSlug.js'

export type VisitorScanLinkStatus =
  | 'pending'
  | 'ambiguous'
  | 'linked'
  | 'no_match'
  | 'failed'
  | 'rejected'
  | 'insufficient_data'

export interface SeedVisitorScanLinkArgs {
  scanId: number
  siteSlug: string
  idNum: string | null
  firstName: string | null
  lastName: string | null
}

/**
 * Insert (idempotently) one row in visitor_scan_links for a freshly
 * inserted visitor_scans row. Returns `false` when the link row
 * already existed (re-delivery / backfill collision) and `true`
 * when a new row was created.
 */
export async function seedVisitorScanLink(
  db: Queryable,
  args: SeedVisitorScanLinkArgs,
): Promise<boolean> {
  const dealerId = getDealerIdForVisitorScanSiteSlug(args.siteSlug)
  if (dealerId === null) {
    // Future-site safety: don't create a link row we can't probe.
    return false
  }
  const hasIdNum = args.idNum !== null && args.idNum.trim().length > 0
  const hasName =
    (args.firstName !== null && args.firstName.trim().length > 0) ||
    (args.lastName !== null && args.lastName.trim().length > 0)
  const status: VisitorScanLinkStatus =
    !hasIdNum && !hasName ? 'insufficient_data' : 'pending'

  const result = await db.query<{ scan_id: number }>(
    `
      insert into visitor_scan_links (scan_id, dealer_id, link_status, next_probe_at)
      values ($1, $2, $3, now())
      on conflict (scan_id) do nothing
      returning scan_id
    `,
    [args.scanId, dealerId, status],
  )
  return result.rows.length > 0
}

// ---------------------------------------------------------------------
// Read + update helpers used by `linkVisitorScanToSweedJob`
// (virusdave/top-level#12). Centralised here so the worker doesn't
// hand-write SQL against `visitor_scan_links` and the schema is
// owned in one place.
// ---------------------------------------------------------------------

export interface DueLinkRow {
  scanId: number
  dealerId: number
  linkStatus: VisitorScanLinkStatus
  idNum: string | null
  firstName: string | null
  lastName: string | null
  siteSlug: string
}

/**
 * Look up a single visitor_scan_links row + the matching
 * visitor_scans columns we need to probe Sweed (id_num, name).
 * Returns null when the row doesn't exist (e.g. a delete-cascade
 * between webhook insert and job execution).
 */
export async function loadLinkForJob(
  db: Queryable,
  scanId: number,
): Promise<DueLinkRow | null> {
  const result = await db.query<{
    scan_id: string | number
    dealer_id: string | number
    link_status: VisitorScanLinkStatus
    id_num: string | null
    first_name: string | null
    last_name: string | null
    site_slug: string
  }>(
    `
      select
        l.scan_id,
        l.dealer_id,
        l.link_status,
        v.id_num,
        v.first_name,
        v.last_name,
        v.site_slug
      from visitor_scan_links l
      join visitor_scans v on v.id = l.scan_id
      where l.scan_id = $1
      limit 1
    `,
    [scanId],
  )
  if (result.rows.length === 0) return null
  const row = result.rows[0]
  return {
    scanId: Number(row.scan_id),
    dealerId: Number(row.dealer_id),
    linkStatus: row.link_status,
    idNum: row.id_num,
    firstName: row.first_name,
    lastName: row.last_name,
    siteSlug: row.site_slug,
  }
}

export interface MarkLinkedArgs {
  scanId: number
  sweedCustomerId: number
  method: string
  confidence: number
  lookupTerms: Record<string, unknown>
  rawMatch: unknown
}

/**
 * Transition a link row to `linked`, stamping the resolved customer
 * id, method, confidence + raw Sweed envelope for provenance.
 * Idempotent: re-running for an already-linked scan to the same
 * customer is a no-op.
 */
export async function markLinkLinked(
  db: Queryable,
  args: MarkLinkedArgs,
): Promise<void> {
  await db.query(
    `
      update visitor_scan_links
         set link_status      = 'linked',
             sweed_customer_id = $2,
             link_method       = $3,
             confidence        = $4,
             linked_at         = coalesce(linked_at, now()),
             last_probed_at    = now(),
             probe_count       = probe_count + 1,
             next_probe_at     = now(),
             last_error        = null,
             lookup_terms      = $5::jsonb,
             raw_match         = $6::jsonb,
             updated_at        = now()
       where scan_id = $1
    `,
    [
      args.scanId,
      args.sweedCustomerId,
      args.method,
      args.confidence,
      JSON.stringify(args.lookupTerms),
      JSON.stringify(args.rawMatch ?? null),
    ],
  )
}

/**
 * Transition a link row to a terminal "Sweed has nothing" status:
 * 'no_match' (we probed; Sweed returned 0 rows) or 'ambiguous' (we
 * probed; Sweed returned >1 and no exact match).
 */
export async function markLinkTerminal(
  db: Queryable,
  args: {
    scanId: number
    status: 'no_match' | 'ambiguous' | 'insufficient_data'
    lookupTerms: Record<string, unknown>
    rawMatch?: unknown
  },
): Promise<void> {
  await db.query(
    `
      update visitor_scan_links
         set link_status     = $2,
             last_probed_at  = now(),
             probe_count     = probe_count + 1,
             next_probe_at   = now(),
             last_error      = null,
             lookup_terms    = $3::jsonb,
             raw_match       = coalesce($4::jsonb, raw_match),
             updated_at      = now()
       where scan_id = $1
    `,
    [
      args.scanId,
      args.status,
      JSON.stringify(args.lookupTerms),
      args.rawMatch === undefined ? null : JSON.stringify(args.rawMatch),
    ],
  )
}

/**
 * Transition a link row to `failed` and push `next_probe_at` out by
 * the supplied delay. Used by the worker on transport/RPC errors so
 * the periodic safety-net job (and the next live scan that hashes
 * to the same person) can retry on a slower cadence.
 */
export async function markLinkFailed(
  db: Queryable,
  args: {
    scanId: number
    errorMessage: string
    retryDelaySeconds: number
    lookupTerms: Record<string, unknown>
  },
): Promise<void> {
  await db.query(
    `
      update visitor_scan_links
         set link_status        = 'failed',
             last_probed_at     = now(),
             probe_count        = probe_count + 1,
             probe_failed_count = probe_failed_count + 1,
             next_probe_at      = now() + make_interval(secs => $3),
             last_error         = $2,
             lookup_terms       = $4::jsonb,
             updated_at         = now()
       where scan_id = $1
    `,
    [
      args.scanId,
      args.errorMessage,
      args.retryDelaySeconds,
      JSON.stringify(args.lookupTerms),
    ],
  )
}
