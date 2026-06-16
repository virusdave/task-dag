// Read the canonical (site, brand) presence rows that drive the branding
// opaque manifest. Mirrors mss `fetchHeliosBrandPresence`
// (`apps/freshlybakedus-site/lib/landingpages-db.ts`) so the producer sees
// exactly the same registry projection mss's `generateStaticParams` derives
// pages from. Read-only; no writes to `landingpage_brand_site_presence`.

import type { Queryable } from '../db/pool.js'
import { FB_US_LOCATION_KEYS, type BrandPresenceRow } from './manifest.js'

interface PresenceRecord {
  readonly site_key: string
  readonly brand_id: string | number
  readonly brand_name: string
  readonly for_sale_variant_count: string | number
  readonly last_for_sale_observed_at: Date | null
}

function toInteger(value: string | number, label: string): number {
  const numeric = typeof value === 'number' ? value : Number.parseInt(value, 10)
  if (!Number.isFinite(numeric) || !Number.isInteger(numeric)) {
    throw new Error(`branding presence: expected integer ${label}, received ${String(value)}`)
  }
  return numeric
}

/**
 * Fetch FB-US (bronx/midtown) brand presence rows from the canonical
 * registry. One row per (site, brand) ever observed, regardless of current
 * for-sale state — the builder applies the canonical-presence filter, just
 * like mss.
 */
export async function fetchBrandingPresenceRows(db: Queryable): Promise<BrandPresenceRow[]> {
  const result = await db.query<PresenceRecord>(
    `
      select
        site_key,
        brand_id,
        brand_name,
        for_sale_variant_count,
        last_for_sale_observed_at
      from landingpage_brand_site_presence
      where site_key = any($1::text[])
      order by site_key, lower(brand_name)
    `,
    [FB_US_LOCATION_KEYS as readonly string[]],
  )

  return result.rows.map((row) => ({
    siteKey: row.site_key,
    sweedBrandId: toInteger(row.brand_id, 'brand_id'),
    brandName: row.brand_name,
    forSaleVariantCount: toInteger(row.for_sale_variant_count, 'for_sale_variant_count'),
    lastForSaleObservedAt: row.last_for_sale_observed_at,
  }))
}
