// VeriScan site_slug ('bx', 'mh', ...) -> Sweed dealer_id mapping.
//
// FreshlyBakedNYC/automation#31, phase A4 — Sweed customer-link
// pipeline. Lives separately from
// helios/src/shared/contracts/domain/pendingPurchases.ts because
// that file's `siteKey` field is `'bronx'` / `'midtown'`, whereas
// VeriScan stamps `'bx'` / `'mh'` on the wire (and we mirror that
// directly into `visitor_scans.site_slug`).
//
// Adding a future site is a code change here AND in
// helios/src/server/routes/visitorScans.ts (the webhook whitelist),
// keeping both lists hard-coded and discoverable.

import {
  HELIOS_PENDING_PURCHASE_SITE_DEALERS,
  type HeliosPendingPurchaseSiteDealer,
} from '../../shared/contracts/index.js'

const SLUG_TO_SITE_KEY: Record<string, HeliosPendingPurchaseSiteDealer['siteKey']> = {
  bx: 'bronx',
  mh: 'midtown',
}

export function getDealerIdForVisitorScanSiteSlug(siteSlug: string): number | null {
  const siteKey = SLUG_TO_SITE_KEY[siteSlug]
  if (siteKey === undefined) return null
  const dealer = HELIOS_PENDING_PURCHASE_SITE_DEALERS.find((d) => d.siteKey === siteKey)
  return dealer === undefined ? null : dealer.dealerId
}

export function getDealerForVisitorScanSiteSlug(
  siteSlug: string,
): HeliosPendingPurchaseSiteDealer | null {
  const siteKey = SLUG_TO_SITE_KEY[siteSlug]
  if (siteKey === undefined) return null
  return HELIOS_PENDING_PURCHASE_SITE_DEALERS.find((d) => d.siteKey === siteKey) ?? null
}
