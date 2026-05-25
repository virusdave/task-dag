/**
 * Read paths for the Config → LitAlerts → Parsing live-review page
 * (issue #19 L3). Treats `dispensaryName` from
 * litalerts_competitor_observations.evidence_json.matchedListings as
 * the competitor identity for v1; a future epic will wire this to
 * the proper LitAlerts retailer-directory ID once the partner API
 * substrate lands.
 */

import {
  hashRawInput,
  parseListingToFuzzy,
  type ParsedListing,
} from '../../../shared/marketMatch/listingParse.js'
import { tryParseLitalertsListing } from '../../parsekit/litalertsLookup.js'
import type { Queryable } from '../pool.js'

export interface CompetitorSummary {
  competitorName: string
  observationCount: number
  matchedListingCount: number
  uniqueCategories: number
  uniqueBrands: number
  /**
   * Min great-circle distance (miles) from this competitor's address
   * to ANY of our stores in helios_store_locations (where the store
   * has a non-null lat/lng). NULL when:
   *   - the competitor's name didn't match a row in
   *     litalerts_retailer_locations, OR
   *   - that row was never geocoded, OR
   *   - no helios_store_locations row has coords yet.
   */
  minDistanceMiles: number | null
  /** site_key of the nearest store, or null when minDistanceMiles is null. */
  nearestStoreKey: string | null
}

export interface CompetitorSampleListing {
  observationId: number
  observedAt: string
  searchTerm: string | null
  raw: {
    url: string | null
    listingName: string | null
    category: string | null
    brand: string | null
    dispensaryName: string | null
    subcategory: string | null
  }
  parsed: ParsedListing
  fuzzyHash: string
  /**
   * Where `parsed` came from.
   *   - `'parsekit'`: a tenant config in helios-parser-configs matched
   *     this listing and produced the row above. `parserId` /
   *     `snapshotSha` identify which config + release.
   *   - `'placeholder'`: no parsekit tenant config applied (none
   *     loaded yet, none matches this competitor, or the tenant
   *     parser failed on this input). `reason` says which one.
   *
   * The UI uses this to badge each row and to surface coverage gaps
   * back to the LLM chat / config editor.
   */
  parserSource: 'parsekit' | 'placeholder'
  parserId: string | null
  snapshotSha: string | null
  /** When parserSource === 'placeholder', why parsekit didn't apply. */
  placeholderReason?: 'no_registry' | 'no_tenant_config' | 'parse_failed'
  placeholderDetail?: string
}

/**
 * Top N competitors by total matched-listing volume (with at least
 * one parseable matched listing).
 */
export async function listLitalertsCompetitors(
  db: Queryable,
  options: { limit?: number } = {},
): Promise<CompetitorSummary[]> {
  const limit = options.limit ?? 50
  // Distance computation: great-circle haversine in miles between
  // litalerts_retailer_locations and helios_store_locations. We
  // CROSS JOIN the (≤ 555 retailers) × (≤ ~5 stores) cardinality and
  // take MIN per retailer. Both sides filter out NULL coords so
  // unmatched / un-geocoded competitors get NULL min_distance,
  // sorted to the bottom of the list.
  const result = await db.query<{
    competitor_name: string
    observation_count: number
    matched_listing_count: number
    unique_categories: number
    unique_brands: number
    min_distance_miles: number | null
    nearest_store_key: string | null
  }>(
    `
      with listings as (
        select
          o.id as observation_id,
          listing->>'dispensaryName' as competitor_name,
          listing->>'category' as category,
          listing->>'brand' as brand,
          listing
        from litalerts_competitor_observations o,
             lateral jsonb_array_elements(
               case when jsonb_typeof(o.evidence_json->'matchedListings') = 'array'
                    then o.evidence_json->'matchedListings'
                    else '[]'::jsonb end
             ) listing
        where listing->>'dispensaryName' is not null
      ),
      retailer_distances as (
        select
          r.retailer_id,
          lower(trim(r.name)) as name_key,
          s.site_key,
          3958.7613 * 2 * asin(
            sqrt(
              sin(radians((s.latitude - r.latitude) / 2)) ^ 2
              + cos(radians(r.latitude)) * cos(radians(s.latitude))
                * sin(radians((s.longitude - r.longitude) / 2)) ^ 2
            )
          ) as miles
        from litalerts_retailer_locations r
        cross join helios_store_locations s
        where r.latitude is not null and r.longitude is not null
          and s.latitude is not null and s.longitude is not null
      ),
      retailer_nearest as (
        select distinct on (name_key)
          name_key,
          site_key as nearest_store_key,
          miles as min_distance_miles
        from retailer_distances
        order by name_key, miles asc
      ),
      grouped as (
        select
          competitor_name,
          count(distinct observation_id)::int as observation_count,
          count(*)::int as matched_listing_count,
          count(distinct category)::int as unique_categories,
          count(distinct brand)::int as unique_brands
        from listings
        group by competitor_name
      )
      select
        g.competitor_name,
        g.observation_count,
        g.matched_listing_count,
        g.unique_categories,
        g.unique_brands,
        rn.min_distance_miles,
        rn.nearest_store_key
      from grouped g
      left join retailer_nearest rn
        on rn.name_key = lower(trim(g.competitor_name))
      order by
        rn.min_distance_miles asc nulls last,
        g.matched_listing_count desc,
        g.competitor_name asc
      limit $1
    `,
    [limit],
  )
  return result.rows.map((row) => ({
    competitorName: row.competitor_name,
    observationCount: row.observation_count,
    matchedListingCount: row.matched_listing_count,
    uniqueCategories: row.unique_categories,
    uniqueBrands: row.unique_brands,
    minDistanceMiles: row.min_distance_miles,
    nearestStoreKey: row.nearest_store_key,
  }))
}

/**
 * Per-competitor sample for the reviewer panel: most recent N
 * matched listings + the FuzzySku-shape that the current inline
 * parser produces.
 */
export async function loadCompetitorSample(
  db: Queryable,
  competitorName: string,
  options: { limit?: number } = {},
): Promise<CompetitorSampleListing[]> {
  const limit = options.limit ?? 25
  const result = await db.query<{
    observation_id: number
    observed_at: string
    search_term: string | null
    listing: {
      url?: string | null
      listingName?: string | null
      category?: string | null
      brand?: string | null
      dispensaryName?: string | null
      subcategory?: string | null
    }
  }>(
    `
      select
        o.id as observation_id,
        o.captured_at::text as observed_at,
        o.evidence_json->>'searchTerm' as search_term,
        listing
      from litalerts_competitor_observations o,
           lateral jsonb_array_elements(
             case when jsonb_typeof(o.evidence_json->'matchedListings') = 'array'
                  then o.evidence_json->'matchedListings'
                  else '[]'::jsonb end
           ) listing
      where listing->>'dispensaryName' = $1
      order by o.captured_at desc, o.id desc
      limit $2
    `,
    [competitorName, limit],
  )
  return result.rows.map((row) => {
    const raw = {
      url: row.listing?.url ?? null,
      listingName: row.listing?.listingName ?? null,
      category: row.listing?.category ?? null,
      brand: row.listing?.brand ?? null,
      dispensaryName: row.listing?.dispensaryName ?? null,
      subcategory: row.listing?.subcategory ?? null,
    }
    const attempt = tryParseLitalertsListing(raw.dispensaryName, raw.listingName)
    if (attempt.parsed) {
      return {
        observationId: row.observation_id,
        observedAt: row.observed_at,
        searchTerm: row.search_term,
        raw,
        // Fill in subcategory + brand-from-row when parsekit doesn't
        // emit them (parser parses listingName only; the LitAlerts
        // observation already gives us these for free).
        parsed: {
          ...attempt.parsed,
          brandNorm: attempt.parsed.brandNorm ?? (raw.brand ?? null),
          categoryNorm:
            attempt.parsed.categoryNorm && attempt.parsed.categoryNorm !== 'other'
              ? attempt.parsed.categoryNorm
              : raw.category ?? attempt.parsed.categoryNorm,
          subcategoryNorm: attempt.parsed.subcategoryNorm ?? raw.subcategory ?? null,
        },
        fuzzyHash: hashRawInput(row.listing),
        parserSource: 'parsekit',
        parserId: attempt.parserId,
        snapshotSha: attempt.snapshotSha,
      }
    }
    return {
      observationId: row.observation_id,
      observedAt: row.observed_at,
      searchTerm: row.search_term,
      raw,
      parsed: parseListingToFuzzy(row.listing ?? {}, row.search_term),
      fuzzyHash: hashRawInput(row.listing),
      parserSource: 'placeholder',
      parserId: attempt.parserId,
      snapshotSha: attempt.snapshotSha,
      placeholderReason: attempt.reason ?? undefined,
      placeholderDetail: attempt.failureDetail,
    }
  })
}
