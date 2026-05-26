/**
 * Persistence layer for the Catalog → Market Data review workflow
 * (issue #18). Backs the REST surface in
 * `helios/src/server/routes/catalogMarketMatches.ts`.
 *
 * Read paths:
 *   - listGroupsNeedingReview(...) — paginated list of catalog groups
 *     ranked by "have un-verdicted candidates above 0.7" / "have any
 *     un-verdicted candidates" / "fully reviewed".
 *   - loadGroupReview(...) — for a single group, return the catalog
 *     side + all live verdicts + un-verdicted candidates ranked by
 *     scorer.
 *
 * Write paths:
 *   - upsertFuzzySkusForObservation(...) — lazy backfill: parse a
 *     LitAlerts observation's matched listings into fuzzy_skus,
 *     skipping duplicates by (source_kind, source_listing_id,
 *     parser_id, parser_version, raw_input_hash). Idempotent.
 *   - recordVerdict(...) — insert a new catalog_market_matches row
 *     and supersede any prior live row for the (group, fuzzy) pair.
 *     Atomic in a single transaction.
 */

import {
  hashRawInput,
  parseListingToFuzzy,
} from '../../../shared/marketMatch/listingParse.js'
import {
  applyVerdictPostFilter,
  scoreCatalogFuzzy,
  scoreCatalogFuzzyFactors,
  type CatalogProfile,
  type FuzzyProfile,
  type MarketMatchVerdict,
  type ScoreFactors,
} from '../../../shared/marketMatch/confidence.js'
import type { Queryable } from '../pool.js'

const LITALERTS_PARSER_ID = 'litalerts.partner.v1'
const LITALERTS_PARSER_VERSION = '0.1.0'

export interface FuzzySkuRow {
  id: number
  sourceKind: string
  sourceListingId: string
  rawInputJsonb: unknown
  parsedJsonb: unknown
  brandNorm: string | null
  categoryNorm: string | null
  subcategoryNorm: string | null
  sizeGNorm: number | null
  sizeMgNorm: number | null
  packCountNorm: number | null
  strainNorm: string | null
}

export interface MarketMatchRow {
  id: number
  catalogGroupId: number
  catalogProductId: number | null
  fuzzySkuId: number
  verdict: MarketMatchVerdict
  verdictSetAt: string
  verdictSetByUserId: string
  verdictSetVia: 'manual' | 'bulk' | 'imported' | 'system_inferred'
  confidenceAtVerdict: number | null
  notes: string | null
}

export interface MarketMatchCandidate {
  fuzzy: FuzzySkuRow
  rawScore: number
  finalScore: number
  factors: ScoreFactors
  liveVerdict: MarketMatchVerdict | null
  listingUrl: string | null
  dispensaryName: string | null
}

export interface GroupReviewBundle {
  catalogGroupId: number
  groupName: string
  brandName: string | null
  categoryName: string | null
  subcategoryName: string | null
  catalogProfile: CatalogProfile
  liveVerdicts: Array<MarketMatchRow & { fuzzy: FuzzySkuRow; listingUrl: string | null; dispensaryName: string | null }>
  candidates: MarketMatchCandidate[]
  observationCount: number
  hasParsedAnyObservation: boolean
}

export interface GroupSummaryRow {
  catalogGroupId: number
  groupName: string
  brandName: string | null
  categoryName: string | null
  subcategoryName: string | null
  observationCount: number
  liveVerdictCount: number
  parsedFuzzyCount: number
}

/**
 * List catalog groups eligible for market-data review (i.e., have at
 * least one non-expired LitAlerts observation).
 */
export async function listGroupsForReview(
  db: Queryable,
  options: { limit: number; offset: number; brandFilter?: string | null; unverdictedOnly?: boolean } = {
    limit: 50,
    offset: 0,
  },
): Promise<{ rows: GroupSummaryRow[]; totalCount: number }> {
  // A group qualifies for review if it has either:
  //   (a) at least one observation linked through its products
  //       (legacy free-text-parsed evidence path), or
  //   (b) at least one structured `litalerts_partner_product` fuzzy
  //       sku whose brand matches the group's brand (the path issue
  //       #20 cuts over to).
  // This way groups without observations still show up once the
  // structured ingest has populated fuzzy_skus for their brand.
  const clauses: string[] = ['(coalesce(go.observation_count, 0) > 0 or coalesce(gsf.structured_fuzzy_count, 0) > 0)']
  const values: unknown[] = []
  if (options.brandFilter) {
    values.push(options.brandFilter)
    clauses.push(`cg.brand_name = $${values.length}`)
  }
  if (options.unverdictedOnly) {
    clauses.push(`coalesce(gms.live_verdict_count, 0) = 0`)
  }
  const whereSql = `where ${clauses.join(' and ')}`

  const result = await db.query<{
    catalog_group_id: number
    group_name: string
    brand_name: string | null
    category_name: string | null
    subcategory_name: string | null
    observation_count: number
    live_verdict_count: number
    parsed_fuzzy_count: number
  }>(
    `
      with group_obs as (
        select
          cg.id as catalog_group_id,
          count(distinct o.id) filter (where o.id is not null) as observation_count
        from catalog_groups cg
        left join lateral (
          select state_json
          from catalog_group_snapshots cgs
          where cgs.catalog_group_id = cg.id
          order by cgs.created_at desc, cgs.id desc
          limit 1
        ) latest_snapshot on true
        left join lateral jsonb_array_elements(
          case
            when jsonb_typeof(latest_snapshot.state_json -> 'products') = 'array'
              then latest_snapshot.state_json -> 'products'
            else '[]'::jsonb
          end
        ) as product on true
        left join litalerts_competitor_observations o
          on (product ->> 'productId') ~ '^[0-9]+$'
         and (product ->> 'productId')::int = o.product_id
        group by cg.id
      ),
      group_match_stats as (
        select
          catalog_group_id,
          count(*) filter (where superseded_by_id is null) as live_verdict_count
        from catalog_market_matches
        group by catalog_group_id
      ),
      -- Resolve each catalog brand's effective LitAlerts brand-norm
      -- key, honoring operator-confirmed overrides over the raw
      -- catalog brand name. An explicit null override (operator
      -- recorded "no LitAlerts equivalent") yields zero rows so the
      -- structured-match path correctly skips it.
      brand_effective as (
        select cg.brand_name as catalog_brand_name,
               case
                 when ov.catalog_brand_name is not null and ov.litalerts_brand_id is null then null
                 when ov.litalerts_brand_name is not null then lower(trim(ov.litalerts_brand_name))
                 else lower(trim(cg.brand_name))
               end as effective_brand_norm
        from (select distinct brand_name from catalog_groups where brand_name is not null) cg
        left join catalog_litalerts_brand_overrides ov
          on ov.catalog_brand_name = cg.brand_name
      ),
      group_structured_fuzzy as (
        select cg.id as catalog_group_id,
               count(*) as structured_fuzzy_count
        from catalog_groups cg
        join brand_effective be on be.catalog_brand_name = cg.brand_name
        join fuzzy_skus fs
          on fs.source_kind = 'litalerts_partner_product'
         and fs.brand_norm = be.effective_brand_norm
        where cg.brand_name is not null and be.effective_brand_norm is not null
        group by cg.id
      )
      select
        cg.id as catalog_group_id,
        cg.group_name,
        cg.brand_name,
        cg.category_name,
        cg.subcategory_name,
        coalesce(go.observation_count, 0)::int as observation_count,
        coalesce(gms.live_verdict_count, 0)::int as live_verdict_count,
        coalesce(gsf.structured_fuzzy_count, 0)::int as parsed_fuzzy_count
      from catalog_groups cg
      left join group_obs go on go.catalog_group_id = cg.id
      left join group_match_stats gms on gms.catalog_group_id = cg.id
      left join group_structured_fuzzy gsf on gsf.catalog_group_id = cg.id
      ${whereSql}
      order by coalesce(go.observation_count, 0) desc,
               coalesce(gsf.structured_fuzzy_count, 0) desc,
               cg.id asc
      limit $${values.length + 1} offset $${values.length + 2}
    `,
    [...values, options.limit, options.offset],
  )

  const countResult = await db.query<{ count: number }>(
    `
      select count(distinct cg.id)::int as count
      from catalog_groups cg
      where (
        -- (a) the group has at least one observation through its products
        exists (
          select 1
          from catalog_group_snapshots cgs,
               lateral jsonb_array_elements(
                 case when jsonb_typeof(cgs.state_json -> 'products') = 'array'
                      then cgs.state_json -> 'products'
                      else '[]'::jsonb end
               ) product,
               litalerts_competitor_observations o
          where cgs.catalog_group_id = cg.id
            and (product ->> 'productId') ~ '^[0-9]+$'
            and o.product_id = (product ->> 'productId')::int
        )
        -- (b) or at least one structured fuzzy_sku matches the brand
        -- (preferring the operator-confirmed override if any; an
        -- explicit-null override correctly excludes this path so the
        -- group only shows up via (a) observations).
        or (
          cg.brand_name is not null
          and exists (
            select 1 from fuzzy_skus fs
            left join catalog_litalerts_brand_overrides ov
              on ov.catalog_brand_name = cg.brand_name
            where fs.source_kind = 'litalerts_partner_product'
              and fs.brand_norm = case
                when ov.catalog_brand_name is not null and ov.litalerts_brand_id is null then null
                when ov.litalerts_brand_name is not null then lower(trim(ov.litalerts_brand_name))
                else lower(trim(cg.brand_name))
              end
          )
        )
      )
      ${options.brandFilter ? `and cg.brand_name = $1` : ''}
    `,
    options.brandFilter ? [options.brandFilter] : [],
  )

  return {
    rows: result.rows.map((row) => ({
      catalogGroupId: row.catalog_group_id,
      groupName: row.group_name,
      brandName: row.brand_name,
      categoryName: row.category_name,
      subcategoryName: row.subcategory_name,
      observationCount: row.observation_count,
      liveVerdictCount: row.live_verdict_count,
      parsedFuzzyCount: row.parsed_fuzzy_count,
    })),
    totalCount: countResult.rows[0]?.count ?? 0,
  }
}

/**
 * Load a single catalog group's review bundle. Lazy-parses any
 * observations whose matched listings haven't been turned into
 * fuzzy_skus yet.
 */
export async function loadGroupReview(db: Queryable, catalogGroupId: number): Promise<GroupReviewBundle | null> {
  const groupResult = await db.query<{
    id: number
    group_name: string
    brand_name: string | null
    category_name: string | null
    subcategory_name: string | null
  }>(
    `select id, group_name, brand_name, category_name, subcategory_name
     from catalog_groups
     where id = $1`,
    [catalogGroupId],
  )
  const group = groupResult.rows[0]
  if (!group) return null

  // Find observations for any product in this group.
  const obsResult = await db.query<{
    id: number
    product_id: number
    evidence_json: unknown
    captured_at: string
  }>(
    `
      with snapshot_products as (
        select distinct (product ->> 'productId')::int as product_id
        from catalog_groups cg
        left join lateral (
          select state_json
          from catalog_group_snapshots cgs
          where cgs.catalog_group_id = cg.id
          order by cgs.created_at desc, cgs.id desc
          limit 1
        ) latest_snapshot on true
        cross join lateral jsonb_array_elements(
          case
            when jsonb_typeof(latest_snapshot.state_json -> 'products') = 'array'
              then latest_snapshot.state_json -> 'products'
            else '[]'::jsonb
          end
        ) as product
        where cg.id = $1
          and (product ->> 'productId') ~ '^[0-9]+$'
      )
      select distinct on (o.product_id)
        o.id, o.product_id, o.evidence_json, o.captured_at::text
      from litalerts_competitor_observations o
      join snapshot_products sp on sp.product_id = o.product_id
      where o.evidence_json is not null
      order by o.product_id, o.captured_at desc
    `,
    [catalogGroupId],
  )

  // Lazy backfill: ensure each observation's matched listings are in fuzzy_skus.
  for (const obs of obsResult.rows) {
    await upsertFuzzySkusForObservation(db, obs.id, obs.evidence_json, obs.captured_at)
  }

  // Pull fuzzy_skus from two sources:
  //   1. observation-derived rows (legacy free-text-parsed path) for
  //      THIS group's matched observations, and
  //   2. structured `litalerts_partner_product` rows for the group's
  //      brand — these come from the LitAlerts partner-API ingest
  //      (issue #20) and carry pre-parsed brand / category / size
  //      so they don't need text parsing at all.
  // Source (2) supersedes (1) in practice; (1) is retained until
  // the legacy observation-based scoring is decommissioned.
  const obsIds = obsResult.rows.map((row) => String(row.id))
  const fuzzyRows: Array<{
    id: number
    source_kind: string
    source_listing_id: string
    raw_input_jsonb: unknown
    parsed_jsonb: unknown
    brand_norm: string | null
    category_norm: string | null
    subcategory_norm: string | null
    size_g_norm: string | null
    size_mg_norm: string | null
    pack_count_norm: number | null
    strain_norm: string | null
  }> = []

  if (obsIds.length > 0) {
    const obsFuzzy = await db.query<typeof fuzzyRows[number]>(
      `select id, source_kind, source_listing_id, raw_input_jsonb, parsed_jsonb,
              brand_norm, category_norm, subcategory_norm,
              size_g_norm::text, size_mg_norm::text, pack_count_norm, strain_norm
       from fuzzy_skus
       where source_kind = 'litalerts_competitor_observation'
         and source_listing_id like any($1::text[])`,
      [obsIds.map((id) => `${id}:%`)],
    )
    fuzzyRows.push(...obsFuzzy.rows)
  }

  if (group.brand_name) {
    // Resolve effective brand-norm via override table; explicit-null
    // override means "no LitAlerts equivalent" so skip the structured
    // pull entirely.
    const overrideLookup = await db.query<{ litalerts_brand_id: string | null; litalerts_brand_name: string | null }>(
      `select litalerts_brand_id::text as litalerts_brand_id, litalerts_brand_name
         from catalog_litalerts_brand_overrides
        where catalog_brand_name = $1`,
      [group.brand_name],
    )
    let effectiveBrandNorm: string | null = group.brand_name.toLowerCase().trim()
    if (overrideLookup.rows.length > 0) {
      const ov = overrideLookup.rows[0]
      if (ov.litalerts_brand_id == null) {
        effectiveBrandNorm = null
      } else if (ov.litalerts_brand_name) {
        effectiveBrandNorm = ov.litalerts_brand_name.toLowerCase().trim()
      }
    }
    if (effectiveBrandNorm != null) {
      const structuredFuzzy = await db.query<typeof fuzzyRows[number]>(
        `select id, source_kind, source_listing_id, raw_input_jsonb, parsed_jsonb,
                brand_norm, category_norm, subcategory_norm,
                size_g_norm::text, size_mg_norm::text, pack_count_norm, strain_norm
         from fuzzy_skus
         where source_kind = 'litalerts_partner_product'
           and brand_norm = $1
         order by created_at desc
         limit 500`,
        [effectiveBrandNorm],
      )
      fuzzyRows.push(...structuredFuzzy.rows)
    }
  }

  const fuzzyResult = { rows: fuzzyRows }

  const fuzzies: FuzzySkuRow[] = fuzzyResult.rows.map((row) => ({
    id: row.id,
    sourceKind: row.source_kind,
    sourceListingId: row.source_listing_id,
    rawInputJsonb: row.raw_input_jsonb,
    parsedJsonb: row.parsed_jsonb,
    brandNorm: row.brand_norm,
    categoryNorm: row.category_norm,
    subcategoryNorm: row.subcategory_norm,
    sizeGNorm: row.size_g_norm != null ? Number.parseFloat(row.size_g_norm) : null,
    sizeMgNorm: row.size_mg_norm != null ? Number.parseFloat(row.size_mg_norm) : null,
    packCountNorm: row.pack_count_norm,
    strainNorm: row.strain_norm,
  }))

  // Load live (non-superseded) verdicts for this group.
  const verdictResult = await db.query<{
    id: number
    catalog_group_id: number
    catalog_product_id: number | null
    fuzzy_sku_id: number
    verdict: MarketMatchVerdict
    verdict_set_at: string
    verdict_set_by_user_id: string
    verdict_set_via: 'manual' | 'bulk' | 'imported' | 'system_inferred'
    confidence_at_verdict: string | null
    notes: string | null
  }>(
    `select id, catalog_group_id, catalog_product_id, fuzzy_sku_id, verdict,
            verdict_set_at::text, verdict_set_by_user_id, verdict_set_via,
            confidence_at_verdict::text, notes
     from catalog_market_matches
     where catalog_group_id = $1 and superseded_by_id is null
     order by verdict_set_at desc, id desc`,
    [catalogGroupId],
  )

  const fuzzyById = new Map(fuzzies.map((fuzzy) => [fuzzy.id, fuzzy]))
  const verdictByFuzzy = new Map<number, MarketMatchVerdict>()
  for (const row of verdictResult.rows) {
    verdictByFuzzy.set(row.fuzzy_sku_id, row.verdict)
  }

  const catalogProfile: CatalogProfile = {
    brandNorm: group.brand_name,
    categoryNorm: group.category_name,
    subcategoryNorm: group.subcategory_name,
    sizeGNorm: null,
    sizeMgNorm: null,
    packCountNorm: null,
    strainNorm: null,
  }

  const liveVerdicts = verdictResult.rows
    .map((row) => {
      const fuzzy = fuzzyById.get(row.fuzzy_sku_id)
      if (!fuzzy) return null
      const listing = fuzzy.rawInputJsonb as { url?: string | null; dispensaryName?: string | null } | null
      return {
        id: row.id,
        catalogGroupId: row.catalog_group_id,
        catalogProductId: row.catalog_product_id,
        fuzzySkuId: row.fuzzy_sku_id,
        verdict: row.verdict,
        verdictSetAt: row.verdict_set_at,
        verdictSetByUserId: row.verdict_set_by_user_id,
        verdictSetVia: row.verdict_set_via,
        confidenceAtVerdict: row.confidence_at_verdict != null ? Number.parseFloat(row.confidence_at_verdict) : null,
        notes: row.notes,
        fuzzy,
        listingUrl: listing?.url ?? null,
        dispensaryName: listing?.dispensaryName ?? null,
      }
    })
    .filter((row): row is NonNullable<typeof row> => row !== null)

  const candidates: MarketMatchCandidate[] = fuzzies
    .filter((fuzzy) => !verdictByFuzzy.has(fuzzy.id))
    .map((fuzzy) => {
      const fuzzyProfile: FuzzyProfile = {
        brandNorm: fuzzy.brandNorm,
        categoryNorm: fuzzy.categoryNorm,
        subcategoryNorm: fuzzy.subcategoryNorm,
        sizeGNorm: fuzzy.sizeGNorm,
        sizeMgNorm: fuzzy.sizeMgNorm,
        packCountNorm: fuzzy.packCountNorm,
        strainNorm: fuzzy.strainNorm,
      }
      // Heuristic brand-alias rescue: the v1 inline parser rarely
      // extracts brand from a bare listing-name string, so a strict
      // brand match would zero out the score. When the fuzzy side
      // has no brand AND the listing text contains the catalog
      // brand as a substring, treat them as alias-equivalent.
      const listing = fuzzy.rawInputJsonb as { url?: string | null; dispensaryName?: string | null; listingName?: string | null } | null
      const brandAliasMatch =
        catalogProfile.brandNorm !== null
        && fuzzy.brandNorm === null
        && typeof listing?.listingName === 'string'
        && listing.listingName.toLowerCase().includes(catalogProfile.brandNorm.toLowerCase())
      const factors = scoreCatalogFuzzyFactors(catalogProfile, fuzzyProfile, { brandAliasMatch })
      const rawScore = Math.max(0, factors.brand * factors.category * factors.subcategory * factors.size * factors.pack * factors.strain)
      const finalScore = applyVerdictPostFilter(rawScore, null)
      return {
        fuzzy,
        rawScore,
        finalScore,
        factors,
        liveVerdict: null,
        listingUrl: listing?.url ?? null,
        dispensaryName: listing?.dispensaryName ?? null,
      }
    })
    .sort((left, right) => right.finalScore - left.finalScore)

  return {
    catalogGroupId,
    groupName: group.group_name,
    brandName: group.brand_name,
    categoryName: group.category_name,
    subcategoryName: group.subcategory_name,
    catalogProfile,
    liveVerdicts,
    candidates,
    observationCount: obsResult.rows.length,
    hasParsedAnyObservation: fuzzies.length > 0,
  }
}

/**
 * Parse one observation's matched listings into fuzzy_skus. Skips
 * duplicates via the (source_kind, source_listing_id, parser_id,
 * parser_version, raw_input_hash) unique key. Idempotent.
 */
export async function upsertFuzzySkusForObservation(
  db: Queryable,
  observationId: number,
  evidenceJson: unknown,
  capturedAt: string,
): Promise<number> {
  const evidence = evidenceJson as {
    matchedListings?: Array<{
      url?: string | null
      listingName?: string | null
      category?: string | null
      subcategory?: string | null
      brand?: string | null
      dispensaryName?: string | null
    }>
    searchTerm?: string | null
  }
  const listings = evidence?.matchedListings ?? []
  let inserted = 0
  for (const listing of listings) {
    if (!listing.listingName) continue
    const parsed = parseListingToFuzzy(listing, evidence.searchTerm)
    const sourceListingId = `${observationId}:${listing.url ?? listing.listingName}`
    const rawInputHash = hashRawInput(listing)
    const result = await db.query<{ id: number }>(
      `
        insert into fuzzy_skus (
          source_kind, source_listing_id, source_captured_at,
          raw_input_jsonb, raw_input_hash,
          parser_id, parser_version, parsed_jsonb,
          brand_norm, category_norm, subcategory_norm,
          size_g_norm, size_mg_norm, pack_count_norm, strain_norm
        ) values (
          'litalerts_competitor_observation', $1, $2,
          $3::jsonb, $4,
          $5, $6, $7::jsonb,
          $8, $9, $10,
          $11, $12, $13, $14
        )
        on conflict on constraint fuzzy_skus_source_kind_source_listing_id_parser_id_parser_v_key do nothing
        returning id
      `,
      [
        sourceListingId,
        capturedAt,
        JSON.stringify(listing),
        rawInputHash,
        LITALERTS_PARSER_ID,
        LITALERTS_PARSER_VERSION,
        JSON.stringify(parsed),
        parsed.brandNorm,
        parsed.categoryNorm,
        parsed.subcategoryNorm,
        parsed.sizeGNorm,
        parsed.sizeMgNorm,
        parsed.packCountNorm,
        parsed.strainNorm,
      ],
    )
    if (result.rows.length > 0) inserted += 1
  }
  return inserted
}

/**
 * Record a verdict. Inserts a new catalog_market_matches row and
 * (in the same transaction) sets the prior live row's
 * superseded_by_id / superseded_at so the partial-unique index
 * stays satisfied.
 */
export async function recordVerdict(
  db: Queryable,
  input: {
    catalogGroupId: number
    catalogProductId?: number | null
    fuzzySkuId: number
    verdict: MarketMatchVerdict
    verdictSetByUserId: string
    verdictSetVia: 'manual' | 'bulk' | 'imported' | 'system_inferred'
    confidenceAtVerdict?: number | null
    notes?: string | null
  },
): Promise<MarketMatchRow> {
  const inserted = await db.query<{
    id: number
    catalog_group_id: number
    catalog_product_id: number | null
    fuzzy_sku_id: number
    verdict: MarketMatchVerdict
    verdict_set_at: string
    verdict_set_by_user_id: string
    verdict_set_via: 'manual' | 'bulk' | 'imported' | 'system_inferred'
    confidence_at_verdict: string | null
    notes: string | null
  }>(
    `
      insert into catalog_market_matches (
        catalog_group_id, catalog_product_id, fuzzy_sku_id,
        verdict, verdict_set_by_user_id, verdict_set_via,
        confidence_at_verdict, notes
      ) values ($1, $2, $3, $4, $5, $6, $7, $8)
      returning id, catalog_group_id, catalog_product_id, fuzzy_sku_id,
                verdict, verdict_set_at::text, verdict_set_by_user_id, verdict_set_via,
                confidence_at_verdict::text, notes
    `,
    [
      input.catalogGroupId,
      input.catalogProductId ?? null,
      input.fuzzySkuId,
      input.verdict,
      input.verdictSetByUserId,
      input.verdictSetVia,
      input.confidenceAtVerdict ?? null,
      input.notes ?? null,
    ],
  )
  const newRow = inserted.rows[0]!

  await db.query(
    `
      update catalog_market_matches
         set superseded_by_id = $1, superseded_at = now()
       where catalog_group_id = $2
         and fuzzy_sku_id = $3
         and id <> $1
         and superseded_by_id is null
    `,
    [newRow.id, input.catalogGroupId, input.fuzzySkuId],
  )

  return {
    id: newRow.id,
    catalogGroupId: newRow.catalog_group_id,
    catalogProductId: newRow.catalog_product_id,
    fuzzySkuId: newRow.fuzzy_sku_id,
    verdict: newRow.verdict,
    verdictSetAt: newRow.verdict_set_at,
    verdictSetByUserId: newRow.verdict_set_by_user_id,
    verdictSetVia: newRow.verdict_set_via,
    confidenceAtVerdict: newRow.confidence_at_verdict != null ? Number.parseFloat(newRow.confidence_at_verdict) : null,
    notes: newRow.notes,
  }
}

export { scoreCatalogFuzzy }
