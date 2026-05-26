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
  canonicalCategoryNorm,
  extractSignificantNameTokens,
  hashRawInput,
  parseListingToFuzzy,
  parseSizeProfile,
  sameSizeFamily,
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
  /**
   * LitAlerts dashboard imageUrl for this listing's product, sourced
   * from `litalerts_product_images` (populated by
   * `scripts/litalerts-backfill-product-images.mts`). Null if we have
   * no image captured for this productId yet.
   */
  imageUrl: string | null
  /** Which catalog variant this candidate scored best against. */
  matchedCatalogProductId: number | null
  /** Stable key for the size family the matched variant belongs to. */
  matchedSizeKey: string
  matchedSizeLabel: string
}

export interface CatalogVariant {
  catalogProductId: number
  name: string | null
  shortName: string | null
  tab: string | null
  sku: string | null
  sizeName: string | null
  sizeGNorm: number | null
  sizeMgNorm: number | null
  packCountNorm: number | null
  imageUrl: string | null
  price: number | null
  /** Stable key for grouping variants by their size family. */
  sizeKey: string
  sizeLabel: string
}

export interface SizeGroup {
  sizeKey: string
  sizeLabel: string
  variants: CatalogVariant[]
  /** Candidates whose best match was a variant in this size group. */
  candidates: MarketMatchCandidate[]
  /** Below-threshold candidates dropped from `candidates`. */
  suppressedCandidateCount: number
}

export interface GroupReviewBundle {
  catalogGroupId: number
  groupName: string
  brandName: string | null
  categoryName: string | null
  subcategoryName: string | null
  groupImageUrl: string | null
  catalogProfile: CatalogProfile
  liveVerdicts: Array<MarketMatchRow & { fuzzy: FuzzySkuRow; listingUrl: string | null; dispensaryName: string | null }>
  /** Size-grouped candidates (the new reviewer-efficient shape). */
  sizeGroups: SizeGroup[]
  /** Candidates whose best match had no associated catalog variant. */
  unmatchedCandidates: MarketMatchCandidate[]
  /** Flat tally across all size groups + unmatched. */
  visibleCandidateCount: number
  suppressedCandidateCount: number
  /** Threshold used to suppress (server echoes for the UI). */
  minScore: number
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
  /**
   * All `litalerts_partner_product` fuzzy_skus matching the group's
   * effective (override-aware) brand — the "total records" pool for
   * this group, regardless of category / size / name agreement.
   */
  parsedFuzzyCount: number
  /**
   * Subset of `parsedFuzzyCount` that ALSO matches the group's
   * canonical category family — the count surfaced in the
   * "N/total obs" pill on the review list as a quick "how much
   * signal does this group have before I even open it" tell.
   * Size + significant-token gates are NOT applied here (they'd
   * require per-row snapshot variant extraction); operators can
   * open the family to see the precise above-threshold count.
   */
  highQualityFuzzyCount: number
}

/**
 * List catalog groups eligible for market-data review (i.e., have at
 * least one non-expired LitAlerts observation).
 */
/**
 * Returns the distinct {brand,category,subcategory} values seen on
 * any catalog group that's eligible for review (has a LitAlerts
 * observation or any structured partner_product fuzzy in its
 * effective brand). Used by the Catalog → Market Data page to back
 * datalist-driven typeahead filters so reviewers pick from real
 * values instead of free-typing.
 *
 * Cheap because the eligibility predicate is the same one used by
 * listGroupsForReview, but we only project the three label columns
 * and group by them.
 */
export async function getMarketMatchesFilterOptions(
  db: Queryable,
): Promise<{ brands: string[]; categories: string[]; subcategories: string[] }> {
  // Strict "eligible group" predicate (matches listGroupsForReview)
  // requires joining ~3k catalog_groups against jsonb-expanded
  // products + observations, which is too expensive for a typeahead
  // source. Use the cheaper proxy "group has a brand_name whose
  // normalized form appears in the partner_product fuzzy index" —
  // i.e. there's at least one structured fuzzy on the same brand.
  // That's what 99% of the listGroupsForReview results actually
  // resolve to, so the dropdown matches what reviewers will see when
  // they pick a filter.
  const result = await db.query<{ kind: 'brand' | 'category' | 'subcategory'; value: string }>(
    `
      with brand_norms as (
        select distinct brand_norm
          from fuzzy_skus
         where source_kind = 'litalerts_partner_product'
           and brand_norm is not null
      ),
      eligible as (
        select cg.brand_name, cg.category_name, cg.subcategory_name
          from catalog_groups cg
          join brand_norms bn on bn.brand_norm = lower(trim(cg.brand_name))
         where cg.brand_name is not null
      )
      select 'brand'::text as kind, brand_name as value
        from eligible where brand_name is not null
       group by brand_name
       union all
      select 'category'::text as kind, category_name as value
        from eligible where category_name is not null
       group by category_name
       union all
      select 'subcategory'::text as kind, subcategory_name as value
        from eligible where subcategory_name is not null
       group by subcategory_name
       order by 1, 2
    `,
  )
  const brands: string[] = []
  const categories: string[] = []
  const subcategories: string[] = []
  for (const row of result.rows) {
    if (row.kind === 'brand') brands.push(row.value)
    else if (row.kind === 'category') categories.push(row.value)
    else if (row.kind === 'subcategory') subcategories.push(row.value)
  }
  return { brands, categories, subcategories }
}

export async function listGroupsForReview(
  db: Queryable,
  options: {
    limit: number
    offset: number
    brandFilter?: string | null
    categoryFilter?: string | null
    subcategoryFilter?: string | null
    unverdictedOnly?: boolean
  } = {
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
  if (options.categoryFilter) {
    values.push(options.categoryFilter)
    clauses.push(`cg.category_name = $${values.length}`)
  }
  if (options.subcategoryFilter) {
    values.push(options.subcategoryFilter)
    clauses.push(`cg.subcategory_name = $${values.length}`)
  }
  if (options.unverdictedOnly) {
    // Anti-join against the partial index
    // `catalog_market_matches_group_idx (catalog_group_id) where
    // superseded_by_id is null` rather than filtering on
    // `coalesce(gms.live_verdict_count, 0) = 0`. The coalesce-of-
    // left-join pattern makes Postgres badly underestimate the
    // result size (~10 rows vs ~3000) and pick a Nested Loop Left
    // Join for the structured_fuzzy lookup downstream, which
    // re-executes the per-brand aggregate 3000+ times and blows
    // the query out to ~3s. NOT EXISTS uses the index directly and
    // gives the planner a usable selectivity estimate.
    clauses.push(`not exists (
      select 1 from catalog_market_matches m
      where m.catalog_group_id = cg.id and m.superseded_by_id is null
    )`)
  }
  const whereSql = `where ${clauses.join(' and ')}`

  // One round-trip: window-function total_count over the filtered set
  // so we don't pay a second seq-scan / aggregation for the
  // pagination total. The page is limit/offset-paginated, so this is
  // the standard "fetch one page + total" pattern.
  const result = await db.query<{
    catalog_group_id: number
    group_name: string
    brand_name: string | null
    category_name: string | null
    subcategory_name: string | null
    observation_count: number
    live_verdict_count: number
    parsed_fuzzy_count: number
    high_quality_fuzzy_count: number
    total_count: number
  }>(
    `
      with group_obs as (
        -- Use cg.live_state_json directly instead of looking up the
        -- latest catalog_group_snapshots row. live_state_json is kept
        -- in sync by the reconcile/sync pipeline (see
        -- reviewPacketImport.ts), and skipping the snapshot lookup
        -- saves a 12k-buffer index scan + TOAST detoast per group.
        select
          cg.id as catalog_group_id,
          count(distinct o.id) filter (where o.id is not null) as observation_count
        from catalog_groups cg
        left join lateral jsonb_array_elements(
          case
            when jsonb_typeof(cg.live_state_json -> 'products') = 'array'
              then cg.live_state_json -> 'products'
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
      -- Pre-aggregate fuzzy counts ONCE per (brand_norm) and per
      -- (brand_norm, category_norm). Without this pre-aggregation,
      -- joining catalog_groups (3k rows, ~13 groups per brand)
      -- directly against fuzzy_skus (361k partner_product rows)
      -- exploded into a 711k / 2.88M-row hash join that took 6+
      -- seconds just to compute count(*) per group. The pre-aggregate
      -- collapses fuzzy_skus to ~230 brand rows / ~1k (brand,category)
      -- rows before fanning out across catalog_groups, dropping the
      -- per-CTE cost from seconds to milliseconds.
      brand_fuzzy_count as (
        select brand_norm, count(*)::bigint as cnt
        from fuzzy_skus
        where source_kind = 'litalerts_partner_product'
          and brand_norm is not null
        group by brand_norm
      ),
      brand_category_fuzzy_count as (
        select brand_norm, category_norm, count(*)::bigint as cnt
        from fuzzy_skus
        where source_kind = 'litalerts_partner_product'
          and brand_norm is not null
        group by brand_norm, category_norm
      ),
      group_structured_fuzzy as (
        select cg.id as catalog_group_id,
               bfc.cnt as structured_fuzzy_count
        from catalog_groups cg
        join brand_effective be on be.catalog_brand_name = cg.brand_name
        join brand_fuzzy_count bfc on bfc.brand_norm = be.effective_brand_norm
        where cg.brand_name is not null and be.effective_brand_norm is not null
      ),
      -- Map each catalog group's raw category to a canonical alias
      -- array. Mirrors canonicalCategoryNorm() in shared/marketMatch/
      -- listingParse.ts — keep these two in sync. Used by the
      -- high-quality count below so a Flower catalog group only counts
      -- 'flower'/'flowers'/'bud' rows, not accessories or pre-rolls.
      catalog_category_aliases as (
        select cg.id as catalog_group_id,
               case
                 when cg.category_name is null then array[]::text[]
                 when lower(regexp_replace(trim(cg.category_name), '[-_/]+', ' ', 'g'))
                      in ('flower','flowers','bud','buds')
                   then array['flower','flowers','bud','buds']
                 when lower(regexp_replace(trim(cg.category_name), '[-_/]+', ' ', 'g'))
                      in ('pre roll','pre rolls','preroll','prerolls','joints','joint',
                          'pre rolled','prerolled','pre rolled joint','prerolled joint')
                   then array['pre-roll','pre-rolls','pre roll','pre rolls','preroll','prerolls','joints','joint']
                 when lower(regexp_replace(trim(cg.category_name), '[-_/]+', ' ', 'g'))
                      in ('vape','vapes','vaporizer','vaporizers','cartridge','cartridges',
                          'cart','carts','disposable','disposables','pod','pods','vape pen','vape pens')
                   then array['vape','vapes','vaporizer','vaporizers','cartridge','cartridges',
                              'cart','carts','disposable','disposables','pod','pods','vape pen','vape pens']
                 when lower(regexp_replace(trim(cg.category_name), '[-_/]+', ' ', 'g'))
                      in ('edible','edibles','gummy','gummies','chocolate','chocolates',
                          'mint','mints','lozenge','lozenges','candy','candies',
                          'beverage','beverages','drink','drinks')
                   then array['edible','edibles','gummy','gummies','chocolate','chocolates',
                              'mint','mints','lozenge','lozenges','candy','candies',
                              'beverage','beverages','drink','drinks']
                 when lower(regexp_replace(trim(cg.category_name), '[-_/]+', ' ', 'g'))
                      in ('concentrate','concentrates','extract','extracts',
                          'live resin','rosin','shatter','wax','badder','budder','sauce',
                          'distillate','diamonds','hash')
                   then array['concentrate','concentrates','extract','extracts',
                              'live resin','rosin','shatter','wax','badder','budder','sauce',
                              'distillate','diamonds','hash']
                 when lower(regexp_replace(trim(cg.category_name), '[-_/]+', ' ', 'g'))
                      in ('tincture','tinctures','sublingual','sublinguals')
                   then array['tincture','tinctures','sublingual','sublinguals']
                 when lower(regexp_replace(trim(cg.category_name), '[-_/]+', ' ', 'g'))
                      in ('topical','topicals','cream','creams','salve','salves','balm','balms')
                   then array['topical','topicals','cream','creams','salve','salves','balm','balms']
                 when lower(regexp_replace(trim(cg.category_name), '[-_/]+', ' ', 'g'))
                      in ('accessory','accessories','rolling paper','rolling papers','paper','papers',
                          'lighter','lighters','grinder','grinders','pipe','pipes','bong','bongs',
                          'apparel','merch','merchandise')
                   then array['accessory','accessories','rolling paper','rolling papers','paper','papers',
                              'lighter','lighters','grinder','grinders','pipe','pipes','bong','bongs',
                              'apparel','merch','merchandise']
                 when lower(regexp_replace(trim(cg.category_name), '[-_/]+', ' ', 'g'))
                      in ('clone','clones','cutting','cuttings')
                   then array['clone','clones','cutting','cuttings']
                 when lower(regexp_replace(trim(cg.category_name), '[-_/]+', ' ', 'g'))
                      in ('seed','seeds')
                   then array['seed','seeds']
                 else array[lower(trim(cg.category_name))]
               end as category_aliases
        from catalog_groups cg
      ),
      group_high_quality_fuzzy as (
        select cg.id as catalog_group_id,
               coalesce(sum(bcc.cnt), 0)::bigint as high_quality_fuzzy_count
        from catalog_groups cg
        join brand_effective be on be.catalog_brand_name = cg.brand_name
        join catalog_category_aliases cca on cca.catalog_group_id = cg.id
        left join brand_category_fuzzy_count bcc
          on bcc.brand_norm = be.effective_brand_norm
         and (cardinality(cca.category_aliases) = 0
              or bcc.category_norm = any(cca.category_aliases))
        where cg.brand_name is not null and be.effective_brand_norm is not null
        group by cg.id
        having coalesce(sum(bcc.cnt), 0) > 0
      )
      , filtered as (
        select
          cg.id as catalog_group_id,
          cg.group_name,
          cg.brand_name,
          cg.category_name,
          cg.subcategory_name,
          coalesce(go.observation_count, 0)::int as observation_count,
          coalesce(gms.live_verdict_count, 0)::int as live_verdict_count,
          coalesce(gsf.structured_fuzzy_count, 0)::int as parsed_fuzzy_count,
          coalesce(ghq.high_quality_fuzzy_count, 0)::int as high_quality_fuzzy_count
        from catalog_groups cg
        left join group_obs go on go.catalog_group_id = cg.id
        left join group_match_stats gms on gms.catalog_group_id = cg.id
        left join group_structured_fuzzy gsf on gsf.catalog_group_id = cg.id
        left join group_high_quality_fuzzy ghq on ghq.catalog_group_id = cg.id
        ${whereSql}
      )
      select
        catalog_group_id,
        group_name,
        brand_name,
        category_name,
        subcategory_name,
        observation_count,
        live_verdict_count,
        parsed_fuzzy_count,
        high_quality_fuzzy_count,
        (count(*) over ())::int as total_count
      from filtered
      order by high_quality_fuzzy_count desc,
               observation_count desc,
               parsed_fuzzy_count desc,
               catalog_group_id asc
      limit $${values.length + 1} offset $${values.length + 2}
    `,
    [...values, options.limit, options.offset],
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
      highQualityFuzzyCount: row.high_quality_fuzzy_count,
    })),
    totalCount: result.rows[0]?.total_count ?? 0,
  }
}

/**
 * Load a single catalog group's review bundle, organized by size
 * family with per-variant photos and confidence-thresholded
 * candidates.
 *
 * Reviewer-efficiency rules baked in here (issue #20 redesign):
 *   1. Default to structured `litalerts_partner_product` fuzzy_skus
 *      only. The legacy observation-derived path is what made the
 *      Review button take many seconds (lazy upserting matched
 *      listings on every click); pass `includeLegacy: true` to opt
 *      back in.
 *   2. Pre-filter structured fuzzies by brand + category at the SQL
 *      level so we don't score 500 accessories against a flower
 *      catalog variant just to throw them away in Node.
 *   3. Score each surviving fuzzy against every catalog variant in
 *      the group (parsed from the latest snapshot's `products[]`)
 *      and keep the best-scoring variant assignment per fuzzy.
 *   4. Suppress candidates whose best score is below `minScore`
 *      (default 0.70) — they're returned only as a count, not as
 *      rows. The UI presents them as "auto no-match (hidden)".
 *   5. Group surviving candidates by the matched variant's size
 *      family ("1g", "3.5g", "100mg", etc.) so the reviewer works
 *      one size at a time.
 */
export async function loadGroupReview(
  db: Queryable,
  catalogGroupId: number,
  options: { minScore?: number; includeLegacy?: boolean } = {},
): Promise<GroupReviewBundle | null> {
  // Clamp the visibility floor to 0.70. Anything below that is treated
  // as "auto no-match (hidden)" — sub-0.70 candidates require at most
  // one of {brand, category, size} disagreeing to be misleading, and
  // the operator has reported (correctly) that the page was unusable
  // when we let lower-confidence matches through.
  const MIN_VISIBLE_SCORE = 0.70
  const minScore = Math.min(1, Math.max(MIN_VISIBLE_SCORE, options.minScore ?? MIN_VISIBLE_SCORE))
  const includeLegacy = options.includeLegacy === true
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

  // Load the latest snapshot's state_json so we can extract product
  // variants + their imageUrls without a Sweed round-trip.
  const snapshotResult = await db.query<{ state_json: unknown }>(
    `select state_json
       from catalog_group_snapshots
      where catalog_group_id = $1
      order by created_at desc, id desc
      limit 1`,
    [catalogGroupId],
  )
  const snapshotState = snapshotResult.rows[0]?.state_json as
    | {
        imageUrl?: string | null
        images?: Array<{ url?: string | null }> | null
        products?: Array<{
          productId?: number
          sku?: string | null
          name?: string | null
          shortName?: string | null
          tab?: string | null
          sizeName?: string | null
          price?: number | null
          imageUrl?: string | null
          images?: Array<{ url?: string | null }> | null
        }> | null
      }
    | null

  const groupImageUrl =
    snapshotState?.imageUrl
    ?? snapshotState?.images?.find((i) => i?.url)?.url
    ?? null

  const catalogVariants: CatalogVariant[] = (snapshotState?.products ?? [])
    .map((p) => {
      if (typeof p?.productId !== 'number') return null
      // Prefer the explicit sizeName / tab field for size parsing;
      // fall back to the variant name. This keeps "Cookies 1g" and
      // a sizeName of "1g" both producing sizeGNorm=1.
      const sizeSourceText = [p.sizeName, p.tab, p.name]
        .filter((s): s is string => typeof s === 'string' && s.length > 0)
        .join(' ')
      const sp = parseSizeProfile(sizeSourceText)
      const variantImage =
        p.imageUrl
        ?? p.images?.find((i) => i?.url)?.url
        ?? groupImageUrl
      const { sizeKey, sizeLabel } = makeSizeKey(sp.sizeGNorm, sp.sizeMgNorm, p.tab ?? p.sizeName ?? null)
      const variant: CatalogVariant = {
        catalogProductId: p.productId,
        name: p.name ?? null,
        shortName: p.shortName ?? null,
        tab: p.tab ?? null,
        sku: p.sku ?? null,
        sizeName: p.sizeName ?? p.tab ?? null,
        sizeGNorm: sp.sizeGNorm,
        sizeMgNorm: sp.sizeMgNorm,
        packCountNorm: sp.packCountNorm,
        imageUrl: variantImage ?? null,
        price: typeof p.price === 'number' ? p.price : null,
        sizeKey,
        sizeLabel,
      }
      return variant
    })
    .filter((v): v is CatalogVariant => v !== null)

  // Find observations for any product in this group (legacy path).
  const obsResult = includeLegacy
    ? await db.query<{
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
    : { rows: [] as Array<{ id: number; product_id: number; evidence_json: unknown; captured_at: string }> }

  // Lazy backfill: ensure each observation's matched listings are in fuzzy_skus.
  if (includeLegacy) {
    for (const obs of obsResult.rows) {
      await upsertFuzzySkusForObservation(db, obs.id, obs.evidence_json, obs.captured_at)
    }
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

  // Resolve the catalog's effective brand (override-aware) once. Used
  // both to fetch structured fuzzies (hard brand filter) AND as the
  // catalog brand we score against, so the scorer doesn't reject a
  // legitimate override-mapped row just because the raw catalog brand
  // name (e.g. "Grass Roots") differs from the LitAlerts brand name
  // (e.g. "Grassroots (Curaleaf)").
  let effectiveBrandNorm: string | null = group.brand_name
    ? group.brand_name.toLowerCase().trim()
    : null
  if (group.brand_name) {
    const overrideLookup = await db.query<{ litalerts_brand_id: string | null; litalerts_brand_name: string | null }>(
      `select litalerts_brand_id::text as litalerts_brand_id, litalerts_brand_name
         from catalog_litalerts_brand_overrides
        where catalog_brand_name = $1`,
      [group.brand_name],
    )
    if (overrideLookup.rows.length > 0) {
      const ov = overrideLookup.rows[0]
      if (ov.litalerts_brand_id == null) {
        // Explicit-null override means "no LitAlerts equivalent"; skip
        // structured pull entirely and zero brand for scoring.
        effectiveBrandNorm = null
      } else if (ov.litalerts_brand_name) {
        effectiveBrandNorm = ov.litalerts_brand_name.toLowerCase().trim()
      }
    }
  }

  // Canonicalize the catalog group's category to one of {flower,
  // preroll, vape, edible, accessory, …}. We require the LitAlerts
  // category to canonicalize to the *same* family below — no more
  // "category_norm is null" escape hatch that let accessory rows
  // through into flower review queues.
  const catalogCategoryCanonical = canonicalCategoryNorm(group.category_name)

  // Variant size families: the SQL pre-filter collects all variant
  // grams + mgs (after canonical size parsing) so we can fetch only
  // rows whose size could plausibly belong to one of this group's
  // variants. When the group has no parseable variants we skip the
  // size predicate (no families to compare against).
  const variantGrams = Array.from(
    new Set(
      catalogVariants
        .map((v) => v.sizeGNorm)
        .filter((g): g is number => typeof g === 'number'),
    ),
  )
  const variantMgs = Array.from(
    new Set(
      catalogVariants
        .map((v) => v.sizeMgNorm)
        .filter((mg): mg is number => typeof mg === 'number'),
    ),
  )
  const hasAnyVariantSize = variantGrams.length > 0 || variantMgs.length > 0

  if (effectiveBrandNorm != null) {
    // HARD filters at the SQL layer:
    //   - brand_norm must match the effective (override-aware) brand
    //   - if the catalog group has a canonical category, the LitAlerts
    //     row must canonicalize to that same family (we recompute on
    //     read so we don't have to re-run the fuzzy backfill to pick
    //     up alias additions)
    //   - if the catalog group has any size-bearing variants, the
    //     LitAlerts row's size must be within ±max(epsilon, 8%) of at
    //     least one of those sizes (g↔g, mg↔mg; never cross-unit)
    const structuredFuzzy = await db.query<typeof fuzzyRows[number]>(
      `select id, source_kind, source_listing_id, raw_input_jsonb, parsed_jsonb,
              brand_norm, category_norm, subcategory_norm,
              size_g_norm::text, size_mg_norm::text, pack_count_norm, strain_norm
       from fuzzy_skus
       where source_kind = 'litalerts_partner_product'
         and brand_norm = $1
         and (
           -- No catalog category set → don't filter by category.
           $3::boolean
           or (
             category_norm is not null
             and category_norm = any($2::text[])
           )
         )
         and (
           -- No variant sizes → don't filter by size.
           $4::boolean
           or (
             cardinality($5::numeric[]) > 0
             and size_g_norm is not null
             and exists (
               select 1
                 from unnest($5::numeric[]) as t(g)
                where abs(size_g_norm - t.g) <= greatest(0.05, t.g * 0.08)
             )
           )
           or (
             cardinality($6::numeric[]) > 0
             and size_mg_norm is not null
             and exists (
               select 1
                 from unnest($6::numeric[]) as t(mg)
                where abs(size_mg_norm - t.mg) <= greatest(5, t.mg * 0.08)
             )
           )
         )
       order by created_at desc
       limit 1000`,
      [
        effectiveBrandNorm,
        // Category aliases: send every raw LA category string that
        // canonicalizes to our canonical family. Cheap because the
        // alias set is tiny; correct because we don't need to
        // re-backfill category_norm on every alias change.
        catalogCategoryCanonical
          ? buildCategoryAliasList(catalogCategoryCanonical)
          : [],
        // SKIP-CATEGORY-FILTER flag.
        catalogCategoryCanonical === null,
        // SKIP-SIZE-FILTER flag.
        !hasAnyVariantSize,
        variantGrams,
        variantMgs,
      ],
    )
    fuzzyRows.push(...structuredFuzzy.rows)
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

  // Use the effective (override-aware) brand for scoring. The scorer
  // compares this string for case-insensitive equality against the
  // fuzzy's brand_norm; using the raw catalog name here would zero
  // the brand factor for legitimate override-mapped rows (the
  // "Grass Roots → Grassroots (Curaleaf)" case).
  // Pre-compute the catalog group's significant-token set once. Each
  // candidate listing must share at least one of these tokens with
  // its product/variant name — otherwise it's just "same brand, same
  // category, same size" which is exactly the failure mode that
  // surfaced accessories as candidates for ATF.
  const groupNameTokens = extractSignificantNameTokens(group.group_name, {
    brandText: effectiveBrandNorm ?? group.brand_name,
    categoryText: catalogCategoryCanonical ?? group.category_name,
  })

  const catalogProfile: CatalogProfile = {
    brandNorm: effectiveBrandNorm ?? group.brand_name,
    // Score against the canonical category so "Flowers" vs "Flower"
    // doesn't accidentally zero an otherwise good match.
    categoryNorm: catalogCategoryCanonical ?? group.category_name,
    subcategoryNorm: group.subcategory_name,
    sizeGNorm: null,
    sizeMgNorm: null,
    packCountNorm: null,
    strainNorm: null,
    nameTokens: Array.from(groupNameTokens),
  }

  // Pre-compute per-variant significant tokens once (variants are
  // iterated for every fuzzy below; doing it inside the loop would
  // re-tokenize the same strings ~N×variants×fuzzies times).
  const variantNameTokensById = new Map<number, string[]>()
  for (const v of catalogVariants) {
    const tokens = extractSignificantNameTokens(
      [v.name, v.shortName].filter((s): s is string => !!s).join(' '),
      {
        brandText: effectiveBrandNorm ?? group.brand_name,
        categoryText: catalogCategoryCanonical ?? group.category_name,
      },
    )
    variantNameTokensById.set(v.catalogProductId, Array.from(tokens))
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

  // Score every un-verdicted fuzzy against EVERY catalog variant and
  // keep the best (variant, score) pair per fuzzy. Bucket below
  // `minScore` matches as "suppressed" (returned as a count only).
  // When the group has no parsable variants at all, fall back to
  // group-level profile scoring so we still surface candidates — the
  // accessory-flood case in particular hinges on category mismatch,
  // which both per-variant and group-level scoring catch identically.
  const scoredAll = fuzzies
    .filter((fuzzy) => !verdictByFuzzy.has(fuzzy.id))
    .map((fuzzy) => {
      // Re-canonicalize the fuzzy's category on read so alias changes
      // in canonicalCategoryNorm() don't require a backfill rerun.
      const fuzzyCategoryCanonical = canonicalCategoryNorm(fuzzy.categoryNorm)
      const listing = fuzzy.rawInputJsonb as
        | { url?: string | null; dispensaryName?: string | null; listingName?: string | null }
        | null

      // Live-extract pack_count and significant tokens from the
      // raw listingName instead of reading the DB columns — the
      // partner_product ingest (litalerts-products-to-fuzzy-skus.mts)
      // hardcodes pack_count_norm / strain_norm to NULL, so for the
      // ~361k structured rows the persisted columns carry no signal.
      // Tokenizing here costs ~1 μs per fuzzy and lets the existing
      // scorer differentiate "Ayrloom Lemonade" from "Ayrloom
      // Honeycrisp" by their distinguishing tokens. The legacy
      // observation-derived rows DO have these columns populated, so
      // we prefer the DB value when present and only fall back to
      // listingName parsing.
      const listingParsedSize = listing?.listingName
        ? parseSizeProfile(listing.listingName)
        : null
      const fuzzyNameTokens = Array.from(
        extractSignificantNameTokens(
          [listing?.listingName, fuzzy.strainNorm].filter((s): s is string => !!s).join(' '),
          {
            brandText: effectiveBrandNorm ?? group.brand_name,
            categoryText: catalogCategoryCanonical ?? group.category_name,
          },
        ),
      )

      const fuzzyProfile: FuzzyProfile = {
        brandNorm: fuzzy.brandNorm,
        categoryNorm: fuzzyCategoryCanonical ?? fuzzy.categoryNorm,
        subcategoryNorm: fuzzy.subcategoryNorm,
        sizeGNorm: fuzzy.sizeGNorm,
        sizeMgNorm: fuzzy.sizeMgNorm,
        packCountNorm: fuzzy.packCountNorm ?? listingParsedSize?.packCountNorm ?? null,
        strainNorm: fuzzy.strainNorm,
        nameTokens: fuzzyNameTokens,
      }
      // Heuristic brand-alias rescue (preserved from the legacy
      // observation path): if the fuzzy has no brand AND the listing
      // text mentions the catalog brand, treat them as alias-equivalent.
      const brandAliasMatch =
        catalogProfile.brandNorm !== null
        && fuzzy.brandNorm === null
        && typeof listing?.listingName === 'string'
        && listing.listingName.toLowerCase().includes(catalogProfile.brandNorm.toLowerCase())

      // HARD GATE #1 — category. The SQL prefilter already enforces
      // this for structured rows, but legacy observation rows go
      // through unfiltered, so we re-check here. Either side null is
      // tolerated (some legacy listings don't have a parsed category).
      if (catalogCategoryCanonical && fuzzyCategoryCanonical && fuzzyCategoryCanonical !== catalogCategoryCanonical) {
        return null
      }

      // HARD GATE #2 — shared significant name token between the
      // catalog group/variant and the listing. Stops "Dank by
      // Definition 3.5g Flower XXX" from matching "Dank by Definition
      // 3.5g Flower YYY" when the strain names share no characters.
      // Skipped when the catalog group has zero significant tokens
      // (e.g. group name is just the brand) — we have nothing to
      // require a shared token *with*. We reuse `fuzzyNameTokens`
      // computed above to avoid re-tokenizing the same listingName.
      if (groupNameTokens.size > 0) {
        let shares = false
        for (const tok of fuzzyNameTokens) {
          if (groupNameTokens.has(tok)) { shares = true; break }
        }
        if (!shares) return null
      }

      // Per-variant scoring loop. The `sizeKey: 'unsized'` arm is
      // used when the catalog has no parsable variants — keeps the
      // page useful for groups that haven't been fully populated yet.
      const variantTargets: Array<CatalogVariant | null> =
        catalogVariants.length > 0 ? catalogVariants : [null]
      let bestPick: {
        variant: CatalogVariant | null
        factors: ScoreFactors
        rawScore: number
        finalScore: number
      } | null = null
      for (const variant of variantTargets) {
        // HARD GATE #3 — per-variant size family match. A 1g pre-roll
        // listing should never be scored against a 3.5g flower
        // variant. SQL already filtered to "could plausibly belong to
        // SOME variant of this group"; here we enforce per-variant.
        if (variant
            && (typeof variant.sizeGNorm === 'number' || typeof variant.sizeMgNorm === 'number')
            && (typeof fuzzy.sizeGNorm === 'number' || typeof fuzzy.sizeMgNorm === 'number')) {
          if (!sameSizeFamily(
            { sizeGNorm: variant.sizeGNorm, sizeMgNorm: variant.sizeMgNorm },
            { sizeGNorm: fuzzy.sizeGNorm, sizeMgNorm: fuzzy.sizeMgNorm },
          )) {
            continue
          }
        }
        const profile: CatalogProfile = variant
          ? {
              brandNorm: catalogProfile.brandNorm,
              categoryNorm: catalogProfile.categoryNorm,
              subcategoryNorm: catalogProfile.subcategoryNorm,
              sizeGNorm: variant.sizeGNorm,
              sizeMgNorm: variant.sizeMgNorm,
              packCountNorm: variant.packCountNorm,
              strainNorm: null,
              nameTokens: variantNameTokensById.get(variant.catalogProductId) ?? catalogProfile.nameTokens,
            }
          : catalogProfile
        const factors = scoreCatalogFuzzyFactors(profile, fuzzyProfile, { brandAliasMatch })
        const rawScore = Math.max(
          0,
          factors.brand
            * factors.category
            * factors.subcategory
            * factors.size
            * factors.pack
            * factors.strain
            * factors.nameOverlap,
        )
        const finalScore = applyVerdictPostFilter(rawScore, null)
        if (!bestPick || finalScore > bestPick.finalScore) {
          bestPick = { variant, factors, rawScore, finalScore }
        }
      }
      if (!bestPick) return null
      const { variant, factors, rawScore, finalScore } = bestPick
      const matchedKey = variant
        ? { sizeKey: variant.sizeKey, sizeLabel: variant.sizeLabel, productId: variant.catalogProductId }
        : { sizeKey: 'unsized', sizeLabel: 'No variant', productId: null }
      const candidate: MarketMatchCandidate = {
        fuzzy,
        rawScore,
        finalScore,
        factors,
        liveVerdict: null,
        listingUrl: listing?.url ?? null,
        dispensaryName: listing?.dispensaryName ?? null,
        imageUrl: null,
        matchedCatalogProductId: matchedKey.productId,
        matchedSizeKey: matchedKey.sizeKey,
        matchedSizeLabel: matchedKey.sizeLabel,
      }
      return candidate
    })
    .filter((c): c is MarketMatchCandidate => c !== null)

  // Decorate each candidate with the LitAlerts dashboard imageUrl
  // we've cached in `litalerts_product_images` (populated by
  // `scripts/litalerts-backfill-product-images.mts`). Single batch
  // query keyed on the productId encoded in raw_input_jsonb for
  // structured `litalerts_partner_product` fuzzies; legacy
  // `litalerts_competitor_observation` fuzzies don't carry productId
  // so they stay imageUrl=null until they're re-ingested structured.
  const productIds: number[] = []
  for (const c of scoredAll) {
    const raw = c.fuzzy.rawInputJsonb as { productId?: number | string } | null
    const pid = typeof raw?.productId === 'number'
      ? raw.productId
      : typeof raw?.productId === 'string' && /^\d+$/.test(raw.productId)
        ? Number.parseInt(raw.productId, 10)
        : null
    if (pid !== null && !Number.isNaN(pid)) productIds.push(pid)
  }
  if (productIds.length > 0) {
    const imgResult = await db.query<{ product_id: string; image_url: string }>(
      `select product_id::text, image_url
         from litalerts_product_images
        where state_code = 'NY'
          and product_id = any($1::bigint[])`,
      [Array.from(new Set(productIds))],
    )
    const imageByPid = new Map<number, string>()
    for (const r of imgResult.rows) {
      imageByPid.set(Number.parseInt(r.product_id, 10), r.image_url)
    }
    for (const c of scoredAll) {
      const raw = c.fuzzy.rawInputJsonb as { productId?: number | string } | null
      const pid = typeof raw?.productId === 'number'
        ? raw.productId
        : typeof raw?.productId === 'string' && /^\d+$/.test(raw.productId)
          ? Number.parseInt(raw.productId, 10)
          : null
      if (pid !== null && imageByPid.has(pid)) {
        c.imageUrl = imageByPid.get(pid) ?? null
      }
    }
  }

  // Split visible vs suppressed by threshold.
  const visible: MarketMatchCandidate[] = []
  let suppressedTotal = 0
  for (const c of scoredAll) {
    if (c.finalScore >= minScore) visible.push(c)
    else suppressedTotal += 1
  }
  visible.sort((a, b) => b.finalScore - a.finalScore)

  // Bucket visible candidates by size group; surface unmatched
  // (no catalog variants parsed) separately so the UI can still
  // render them at the bottom.
  const sizeGroupsMap = new Map<
    string,
    { sizeKey: string; sizeLabel: string; variants: CatalogVariant[]; candidates: MarketMatchCandidate[]; suppressedCount: number }
  >()
  for (const variant of catalogVariants) {
    if (!sizeGroupsMap.has(variant.sizeKey)) {
      sizeGroupsMap.set(variant.sizeKey, {
        sizeKey: variant.sizeKey,
        sizeLabel: variant.sizeLabel,
        variants: [],
        candidates: [],
        suppressedCount: 0,
      })
    }
    sizeGroupsMap.get(variant.sizeKey)!.variants.push(variant)
  }
  const unmatchedCandidates: MarketMatchCandidate[] = []
  for (const c of visible) {
    if (c.matchedSizeKey === 'unsized' || !sizeGroupsMap.has(c.matchedSizeKey)) {
      unmatchedCandidates.push(c)
    } else {
      sizeGroupsMap.get(c.matchedSizeKey)!.candidates.push(c)
    }
  }
  // Per-size-group suppressed counts.
  for (const c of scoredAll) {
    if (c.finalScore >= minScore) continue
    const bucket = sizeGroupsMap.get(c.matchedSizeKey)
    if (bucket) bucket.suppressedCount += 1
  }

  const sizeGroups: SizeGroup[] = Array.from(sizeGroupsMap.values())
    .map((g) => ({
      sizeKey: g.sizeKey,
      sizeLabel: g.sizeLabel,
      variants: g.variants,
      candidates: g.candidates,
      suppressedCandidateCount: g.suppressedCount,
    }))
    .sort((a, b) => sizeGroupSortKey(a.sizeKey) - sizeGroupSortKey(b.sizeKey))

  return {
    catalogGroupId,
    groupName: group.group_name,
    brandName: group.brand_name,
    categoryName: group.category_name,
    subcategoryName: group.subcategory_name,
    groupImageUrl,
    catalogProfile,
    liveVerdicts,
    sizeGroups,
    unmatchedCandidates,
    visibleCandidateCount: visible.length,
    suppressedCandidateCount: suppressedTotal,
    minScore,
    observationCount: obsResult.rows.length,
    hasParsedAnyObservation: fuzzies.length > 0,
  }
}

/**
 * Stable size-group key + display label.
 * "1g", "3.5g", "100mg", "1oz", "unsized" etc.
 */
/**
 * Inverse of canonicalCategoryNorm() — every raw LitAlerts/Sweed
 * category string that we know canonicalizes to the given family.
 * Used to seed the structured-fuzzy SQL prefilter's category alias
 * IN-list without having to re-run the fuzzy backfill every time the
 * canonical alias table changes.
 */
function buildCategoryAliasList(canonical: string): string[] {
  const candidates: string[] = [
    canonical,
    `${canonical}s`,
    canonical.charAt(0).toUpperCase() + canonical.slice(1),
  ]
  // Family-specific raw aliases — keep this set conservative; the
  // scorer's hard category gate re-verifies on read after fetch.
  const FAMILY_ALIASES: Record<string, string[]> = {
    flower: ['flower', 'flowers', 'bud', 'buds'],
    preroll: ['pre-roll', 'pre-rolls', 'pre roll', 'pre rolls', 'preroll', 'prerolls', 'joints', 'joint'],
    concentrate: [
      'concentrate', 'concentrates', 'extract', 'extracts',
      'live resin', 'rosin', 'shatter', 'wax', 'badder', 'budder', 'sauce',
      'distillate', 'diamonds', 'hash',
    ],
    vape: [
      'vape', 'vapes', 'vaporizer', 'vaporizers', 'cartridge', 'cartridges',
      'cart', 'carts', 'disposable', 'disposables', 'pod', 'pods', 'vape pen', 'vape pens',
    ],
    edible: [
      'edible', 'edibles', 'gummy', 'gummies', 'chocolate', 'chocolates',
      'mint', 'mints', 'lozenge', 'lozenges', 'candy', 'candies',
      'beverage', 'beverages', 'drink', 'drinks',
    ],
    tincture: ['tincture', 'tinctures', 'sublingual', 'sublinguals'],
    topical: ['topical', 'topicals', 'cream', 'creams', 'salve', 'salves', 'balm', 'balms'],
    accessory: [
      'accessory', 'accessories', 'rolling paper', 'rolling papers', 'paper', 'papers',
      'lighter', 'lighters', 'grinder', 'grinders', 'pipe', 'pipes', 'bong', 'bongs',
      'apparel', 'merch', 'merchandise',
    ],
    clone: ['clone', 'clones', 'cutting', 'cuttings'],
    seed: ['seed', 'seeds'],
  }
  const family = FAMILY_ALIASES[canonical] ?? []
  return Array.from(new Set([...candidates, ...family])).map((s) => s.toLowerCase().trim())
}

function makeSizeKey(
  sizeGNorm: number | null,
  sizeMgNorm: number | null,
  fallbackLabel: string | null,
): { sizeKey: string; sizeLabel: string } {
  if (sizeGNorm != null && sizeGNorm > 0) {
    const rounded = Math.round(sizeGNorm * 1000) / 1000
    return { sizeKey: `g:${rounded}`, sizeLabel: `${stripTrailingZeros(rounded)}g` }
  }
  if (sizeMgNorm != null && sizeMgNorm > 0) {
    const rounded = Math.round(sizeMgNorm * 10) / 10
    return { sizeKey: `mg:${rounded}`, sizeLabel: `${stripTrailingZeros(rounded)}mg` }
  }
  if (fallbackLabel && fallbackLabel.trim().length > 0) {
    const label = fallbackLabel.trim()
    return { sizeKey: `label:${label.toLowerCase()}`, sizeLabel: label }
  }
  return { sizeKey: 'unsized', sizeLabel: 'Unsized' }
}

function stripTrailingZeros(n: number): string {
  return n.toString().replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')
}

function sizeGroupSortKey(sizeKey: string): number {
  // Sort grams ascending, then mg ascending, then label/unsized last.
  if (sizeKey.startsWith('g:')) return Number.parseFloat(sizeKey.slice(2))
  if (sizeKey.startsWith('mg:')) return 1000 + Number.parseFloat(sizeKey.slice(3))
  if (sizeKey === 'unsized') return Number.POSITIVE_INFINITY
  return 100_000
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
