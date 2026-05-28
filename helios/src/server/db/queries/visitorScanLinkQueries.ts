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
