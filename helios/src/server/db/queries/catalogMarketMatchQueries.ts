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
} from '../../../shared/marketMatch/listingParse.js'
import {
  scoreCatalogFuzzy,
  type CatalogProfile,
  type MarketMatchVerdict,
} from '../../../shared/marketMatch/confidence.js'
import {
  scoreFuzzyCandidate,
  type CatalogVariant,
  type FuzzySkuRow,
  type MarketMatchCandidate,
  type VariantScoringTarget,
} from '../../marketMatch/candidateScoring.js'
import type { Queryable } from '../pool.js'

const LITALERTS_PARSER_ID = 'litalerts.partner.v1'
const LITALERTS_PARSER_VERSION = '0.1.0'

// FuzzySkuRow / CatalogVariant / MarketMatchCandidate + the pure per-fuzzy
// scorer now live in the pure `candidateScoring` module so the SAME matching
// powers both this per-group review bundle and the brand-categorical-family
// audit surface (issue #58 T2). Re-exported here (they are imported for local
// use above) so existing importers of these types are unaffected.
export type { FuzzySkuRow, CatalogVariant, MarketMatchCandidate }

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
  liveVerdicts: Array<MarketMatchRow & { fuzzy: FuzzySkuRow; listingUrl: string | null; dispensaryName: string | null; imageUrl: string | null }>
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
      -- A catalog brand counts as eligible if EITHER its lowercased
      -- name appears as a partner_product brand_norm OR an operator
      -- override pins its litalerts_brand_id. The override path
      -- matters for brands like "Dank" whose canonical LitAlerts
      -- name diverges from the raw catalog spelling.
      eligible as (
        select cg.brand_name, cg.category_name, cg.subcategory_name
          from catalog_groups cg
          left join brand_norms bn on bn.brand_norm = lower(trim(cg.brand_name))
          left join catalog_litalerts_brand_overrides ov on ov.catalog_brand_name = cg.brand_name
         where cg.brand_name is not null
           and (bn.brand_norm is not null or ov.litalerts_brand_id is not null)
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
      -- Resolve each catalog brand to the *set* of LitAlerts
      -- brand_norm spellings that should count toward its match
      -- universe. Honoring operator overrides:
      --   - No override row → use lowercased catalog brand_name as
      --     a single-spelling guess (legacy heuristic).
      --   - Override with litalerts_brand_id IS NULL → operator said
      --     "no LitAlerts equivalent"; yields zero rows so the
      --     structured-match path correctly skips this brand.
      --   - Override with litalerts_brand_id IS NOT NULL → expand
      --     to every brand_name spelling observed in
      --     litalerts_products for that brand_id. This is critical
      --     because LitAlerts itself ships the same brand_id
      --     (e.g. 4133 = "Dank By Definition.") under ~10 different
      --     free-text brand_name spellings ("Dank", "Dank by
      --     definition.", "Dank. by definition", etc.), and
      --     fuzzy_skus.brand_norm carries the spelling, not the id.
      --     Without this explosion the catalog → market-data review
      --     surface would only see the one spelling that happened
      --     to exactly equal lower(trim(ov.litalerts_brand_name))
      --     and report 0 obs for every other spelling.
      --   - Override with litalerts_brand_id IS NULL but
      --     litalerts_brand_name set → single norm from the name
      --     (legacy path for overrides written before brand_id was
      --     captured).
      brand_effective as (
        select cg.brand_name as catalog_brand_name,
               lower(trim(cg.brand_name)) as effective_brand_norm
          from (select distinct brand_name from catalog_groups where brand_name is not null) cg
         where not exists (
           select 1 from catalog_litalerts_brand_overrides ov
            where ov.catalog_brand_name = cg.brand_name
         )
        union
        select ov.catalog_brand_name,
               lower(trim(lp.brand_name)) as effective_brand_norm
          from catalog_litalerts_brand_overrides ov
          join litalerts_products lp on lp.brand_id = ov.litalerts_brand_id
         where ov.litalerts_brand_id is not null
           and lp.brand_name is not null
           and length(trim(lp.brand_name)) > 0
        union
        select ov.catalog_brand_name,
               lower(trim(ov.litalerts_brand_name)) as effective_brand_norm
          from catalog_litalerts_brand_overrides ov
         where ov.litalerts_brand_id is null
           and ov.litalerts_brand_name is not null
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
        -- brand_effective is now multi-row per catalog brand (one
        -- row per effective brand_norm spelling). Sum the per-norm
        -- fuzzy counts to get the true per-group total.
        select cg.id as catalog_group_id,
               sum(bfc.cnt)::bigint as structured_fuzzy_count
        from catalog_groups cg
        join brand_effective be on be.catalog_brand_name = cg.brand_name
        join brand_fuzzy_count bfc on bfc.brand_norm = be.effective_brand_norm
        where cg.brand_name is not null and be.effective_brand_norm is not null
        group by cg.id
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
// ---------------------------------------------------------------------------
// Shared override-expansion + structured-fuzzy-fetch helpers (issue #58 T2).
//
// Extracted from `loadGroupReview` so the per-catalog-group review bundle AND
// the brand-categorical-family audit surface resolve brands and fetch LitAlerts
// partner_product candidates through exactly one code path — the diagnostic can
// only claim "this is how the REAL matcher matched it" if there is no drift.
// ---------------------------------------------------------------------------

/** Operator's mapping intent for one raw catalog brand spelling. */
export type BrandMappingState = 'mapped' | 'operator-says-none' | 'unmapped'

export interface BrandSpellingMapping {
  /** The raw catalog brand spelling that was resolved. */
  rawBrandName: string
  state: BrandMappingState
  litalertsBrandId: number | null
  litalertsBrandName: string | null
}

export interface EffectiveBrandMapping {
  /**
   * Every LitAlerts `brand_norm` spelling that counts as this brand — the hard
   * brand filter for the structured fuzzy fetch AND the alias set the scorer
   * grants the brand factor for. Empty when every spelling is an explicit-null
   * override (operator said "no LitAlerts equivalent").
   */
  norms: string[]
  /**
   * Representative norm used as the catalog side's brand for scoring. Null when
   * there is no usable brand (all spellings explicit-null / no brand).
   */
  representativeNorm: string | null
  /** Per raw spelling mapping state, surfaced in the audit UI. */
  perSpelling: BrandSpellingMapping[]
}

/**
 * Resolve a set of raw catalog brand spellings to their override-aware
 * effective LitAlerts brand norms + mapping states.
 *
 * Runs the SAME single-brand override lookup `loadGroupReview` used inline,
 * once per distinct raw spelling, then UNIONs the results. Overrides key on the
 * EXACT raw `catalog_brand_name`, whereas a brand-categorical-family folds
 * case/whitespace variants into one `familyBrandKey`, so a family may carry
 * several raw spellings that map differently — hence the multi-spelling union
 * and the per-spelling states. For a single spelling (the group path) the
 * behaviour is identical to the original inline block.
 */
export async function resolveEffectiveBrandMapping(
  db: Queryable,
  rawBrandNames: ReadonlyArray<string | null>,
): Promise<EffectiveBrandMapping> {
  const seen = new Set<string>()
  const distinctRaw: string[] = []
  for (const raw of rawBrandNames) {
    if (raw == null) continue
    if (seen.has(raw)) continue
    seen.add(raw)
    distinctRaw.push(raw)
  }

  const normSet = new Set<string>()
  const perSpelling: BrandSpellingMapping[] = []
  let representativeNorm: string | null = null

  for (const rawBrandName of distinctRaw) {
    // Unmapped fallback norm (mirrors loadGroupReview's initial
    // `effectiveBrandNorm = group.brand_name.toLowerCase().trim()`).
    const base = rawBrandName.toLowerCase().trim()
    // Single round-trip: operator override + expansion of the override's
    // brand_id to every brand_name spelling seen in litalerts_products. This
    // is the exact query the inline block used.
    const overrideLookup = await db.query<{
      has_override: boolean
      litalerts_brand_id: string | null
      litalerts_brand_name: string | null
      brand_norms: string[] | null
    }>(
      `
        with ov as (
          select litalerts_brand_id, litalerts_brand_name
            from catalog_litalerts_brand_overrides
           where catalog_brand_name = $1
           limit 1
        )
        select
          exists (select 1 from ov) as has_override,
          (select litalerts_brand_id::text from ov) as litalerts_brand_id,
          (select litalerts_brand_name from ov) as litalerts_brand_name,
          (
            select array_agg(distinct lower(trim(brand_name)))
              from litalerts_products
             where brand_id = (select litalerts_brand_id from ov)
               and brand_name is not null
               and length(trim(brand_name)) > 0
          ) as brand_norms
      `,
      [rawBrandName],
    )
    const ov = overrideLookup.rows[0]

    let spellingNorms: string[] = []
    let spellingRep: string | null = base
    let state: BrandMappingState = 'unmapped'
    let litalertsBrandId: number | null = null
    let litalertsBrandName: string | null = null

    if (ov?.has_override) {
      if (ov.litalerts_brand_id == null && ov.litalerts_brand_name == null) {
        // Explicit-null override → operator said "no LitAlerts equivalent".
        state = 'operator-says-none'
        spellingNorms = []
        spellingRep = null
      } else if (ov.litalerts_brand_id != null) {
        // Pin by id → expand to every spelling for this brand_id.
        state = 'mapped'
        litalertsBrandId = Number(ov.litalerts_brand_id)
        litalertsBrandName = ov.litalerts_brand_name
        spellingNorms = ov.brand_norms ?? []
        spellingRep = ov.litalerts_brand_name
          ? ov.litalerts_brand_name.toLowerCase().trim()
          : (spellingNorms[0] ?? base)
      } else if (ov.litalerts_brand_name) {
        // Pin by name only (legacy / no id captured) → single norm.
        state = 'mapped'
        litalertsBrandName = ov.litalerts_brand_name
        spellingNorms = []
        spellingRep = ov.litalerts_brand_name.toLowerCase().trim()
      }
    }
    // Post-processing mirror: if the spelling produced no explicit norm set
    // but has a representative, its norm IS that representative.
    if (spellingNorms.length === 0 && spellingRep != null) {
      spellingNorms = [spellingRep]
    }

    for (const n of spellingNorms) normSet.add(n.toLowerCase().trim())
    if (representativeNorm == null && spellingRep != null) representativeNorm = spellingRep
    perSpelling.push({ rawBrandName, state, litalertsBrandId, litalertsBrandName })
  }

  return { norms: Array.from(normSet), representativeNorm, perSpelling }
}

/** One `fuzzy_skus` partner row as fetched for scoring / audit. */
export interface PartnerFuzzyFetchRow {
  id: number
  source_kind: string
  source_listing_id: string
  raw_input_jsonb: unknown
  brand_norm: string | null
  category_norm: string | null
  subcategory_norm: string | null
  size_g_norm: string | null
  size_mg_norm: string | null
  pack_count_norm: number | null
  strain_norm: string | null
  image_url: string | null
  source_captured_at: string | null
  /** Dedup-mode only: total pre-dedup rows matching the filter (per row, constant). */
  raw_row_count?: number
  /** Dedup-mode only: distinct source_listing_id count matching the filter. */
  deduped_count?: number
}

export interface PartnerFuzzyFetchParams {
  /** Effective (override-aware) brand norms — the hard brand filter. */
  brandNorms: string[]
  /** Canonical category family, or null to skip the category filter. */
  categoryCanonical: string | null
  /** Catalog-side variant grams for the size prefilter (g↔g). */
  grams: number[]
  /** Catalog-side variant mgs for the size prefilter (mg↔mg). */
  mgs: number[]
  /**
   * ILIKE patterns for the name-token prefilter. Empty array skips the filter
   * (same semantics as the JS gate when there are no significant tokens).
   */
  tokenPatterns: string[]
  /**
   * When true, dedup to the latest row per `source_listing_id` (the family
   * audit's fix for the ~57% duplicate-row artifact) and include the pricing /
   * stock / retailer fields + `source_captured_at`. When false, reproduce
   * loadGroupReview's exact projection (top rows by `created_at desc`).
   */
  dedupLatestPerListing: boolean
  limit: number
}

/**
 * Fetch structured `litalerts_partner_product` fuzzy_skus that pass the hard
 * brand / category-alias / size / name-token prefilters. Two modes:
 *   - `dedupLatestPerListing: false` (the per-group review path) reproduces
 *     loadGroupReview's original query exactly.
 *   - `dedupLatestPerListing: true` (the family audit path) dedups to the
 *     latest row per source_listing_id — deliberately diverging from the group
 *     path so a listing captured 2-4× isn't triple-counted — and carries the
 *     price/stock/retailer context the audit surfaces. The dedup sort runs on
 *     the NARROW `fs.id` key only, joining the wide `raw_input_jsonb` back for
 *     survivors (canon DB rule: never sort wide rows).
 */
export async function fetchPartnerFuzzyCandidates(
  db: Queryable,
  params: PartnerFuzzyFetchParams,
): Promise<PartnerFuzzyFetchRow[]> {
  // Shared hard-filter predicate — identical for both modes.
  const whereSql = `
    fs.source_kind = 'litalerts_partner_product'
    and fs.brand_norm = any($1::text[])
    and (
      $3::boolean
      or (fs.category_norm is not null and fs.category_norm = any($2::text[]))
    )
    and (
      $4::boolean
      or (
        cardinality($5::numeric[]) > 0
        and fs.size_g_norm is not null
        and exists (
          select 1 from unnest($5::numeric[]) as t(g)
           where abs(fs.size_g_norm - t.g) <= greatest(0.05, t.g * 0.08)
        )
      )
      or (
        cardinality($6::numeric[]) > 0
        and fs.size_mg_norm is not null
        and exists (
          select 1 from unnest($6::numeric[]) as t(mg)
           where abs(fs.size_mg_norm - t.mg) <= greatest(5, t.mg * 0.08)
        )
      )
    )
    and (
      cardinality($7::text[]) = 0
      or lower(fs.raw_input_jsonb->>'listingName') like any($7::text[])
    )`

  // raw_input_jsonb projection. The group path keeps the original 7-field
  // shape; the family path adds price/stock/retailer context to SURFACE it.
  const rawJsonFields = params.dedupLatestPerListing
    ? `jsonb_build_object(
         'listingName',    fs.raw_input_jsonb->>'listingName',
         'url',            fs.raw_input_jsonb->>'url',
         'dispensaryName', fs.raw_input_jsonb->>'dispensaryName',
         'brand',          fs.raw_input_jsonb->>'brand',
         'category',       fs.raw_input_jsonb->>'category',
         'productId',      fs.raw_input_jsonb->>'productId',
         'imageUrl',       fs.raw_input_jsonb->>'imageUrl',
         'normalPrice',    fs.raw_input_jsonb->>'normalPrice',
         'salePrice',      fs.raw_input_jsonb->>'salePrice',
         'currentStock',   fs.raw_input_jsonb->>'currentStock',
         'retailerId',     fs.raw_input_jsonb->>'retailerId'
       )`
    : `jsonb_build_object(
         'listingName',    fs.raw_input_jsonb->>'listingName',
         'url',            fs.raw_input_jsonb->>'url',
         'dispensaryName', fs.raw_input_jsonb->>'dispensaryName',
         'brand',          fs.raw_input_jsonb->>'brand',
         'category',       fs.raw_input_jsonb->>'category',
         'productId',      fs.raw_input_jsonb->>'productId',
         'imageUrl',       fs.raw_input_jsonb->>'imageUrl'
       )`

  const imageJoinSql = `
    left join litalerts_product_images lpi
      on lpi.state_code = 'NY'
     and lpi.product_id = case
           when fs.raw_input_jsonb->>'productId' ~ '^[0-9]+$'
             then (fs.raw_input_jsonb->>'productId')::bigint
         end`

  const imageColSql = `coalesce(nullif(fs.raw_input_jsonb->>'imageUrl', ''), lpi.image_url)`

  const sql = params.dedupLatestPerListing
    ? `
        with matched as (
          select fs.id, fs.source_listing_id, fs.source_captured_at
            from fuzzy_skus fs
           where ${whereSql}
        ),
        latest as (
          select distinct on (source_listing_id) id
            from matched
           order by source_listing_id, source_captured_at desc nulls last, id desc
        ),
        counts as (
          select (select count(*) from matched)::int as raw_row_count,
                 (select count(*) from latest)::int  as deduped_count
        )
        select fs.id, fs.source_kind, fs.source_listing_id,
               ${rawJsonFields} as raw_input_jsonb,
               fs.brand_norm, fs.category_norm, fs.subcategory_norm,
               fs.size_g_norm::text, fs.size_mg_norm::text, fs.pack_count_norm, fs.strain_norm,
               ${imageColSql} as image_url,
               -- ISO-8601 UTC (with trailing Z) so the client's new Date(...)
               -- parses it cross-browser; ::text yields a space-separated,
               -- Safari-unparseable string. Lexicographic min/max downstream
               -- stays valid (fixed-width, zero-padded).
               to_char(fs.source_captured_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as source_captured_at,
               counts.raw_row_count, counts.deduped_count
          from latest
          join fuzzy_skus fs on fs.id = latest.id
          cross join counts
          ${imageJoinSql}
         order by fs.source_captured_at desc nulls last, fs.id desc
         limit ${params.limit}`
    : `
        select fs.id, fs.source_kind, fs.source_listing_id,
               ${rawJsonFields} as raw_input_jsonb,
               fs.brand_norm, fs.category_norm, fs.subcategory_norm,
               fs.size_g_norm::text, fs.size_mg_norm::text, fs.pack_count_norm, fs.strain_norm,
               ${imageColSql} as image_url,
               fs.source_captured_at::text as source_captured_at
          from fuzzy_skus fs
          ${imageJoinSql}
         where ${whereSql}
         order by fs.created_at desc
         limit ${params.limit}`

  const result = await db.query<PartnerFuzzyFetchRow>(sql, [
    params.brandNorms,
    params.categoryCanonical ? buildCategoryAliasList(params.categoryCanonical) : [],
    params.categoryCanonical === null,
    params.grams.length === 0 && params.mgs.length === 0,
    params.grams,
    params.mgs,
    params.tokenPatterns,
  ])
  return result.rows
}

export async function loadGroupReview(
  db: Queryable,
  catalogGroupId: number,
  options: { minScore?: number; includeLegacy?: boolean } = {},
): Promise<GroupReviewBundle | null> {
  // The server no longer suppresses candidates by score — it returns
  // the top N candidates per size group regardless of threshold, and
  // the SPA's confidence slider does the visible/hidden split on the
  // client (so moving the slider is instant + reactive instead of a
  // 1-2s round-trip-and-rerank).
  //
  // The `minScore` query param is still accepted (defaults to 0.70)
  // and echoed back in the bundle as a *suggested* default slider
  // value for the client, but it does NOT gate any candidate from
  // the response. `suppressedCandidateCount` is consequently always
  // zero in new responses; the SPA computes its own
  // visible/suppressed split from the candidate list + slider value.
  //
  // Cap per size group so a brand with hundreds of low-quality
  // partner-API rows can't blow up the payload. 25 is enough for the
  // reviewer to drag the slider from 1.00 down to 0 and watch new
  // candidates appear without round-tripping.
  const TOP_N_PER_SIZE_GROUP = 25
  const TOP_N_UNMATCHED = 25
  const SUGGESTED_DEFAULT_MIN_SCORE = 0.70
  const minScore = Math.min(1, Math.max(0, options.minScore ?? SUGGESTED_DEFAULT_MIN_SCORE))
  const includeLegacy = options.includeLegacy === true
  // Phase A — parallelise everything that only needs `catalogGroupId`:
  //   1. the group row itself,
  //   2. its latest snapshot (for variant metadata + group image),
  //   3. all live verdicts on the group (for the verdict overlay).
  // Each one is its own ~32ms Tiger Cloud round-trip; running them
  // serially used to add ~100ms of pointless wall-clock to every
  // bundle load. Promise.all collapses them into a single phase.
  const [groupResult, snapshotResult, verdictResult] = await Promise.all([
    db.query<{
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
    ),
    db.query<{ state_json: unknown }>(
      `select state_json
         from catalog_group_snapshots
        where catalog_group_id = $1
        order by created_at desc, id desc
        limit 1`,
      [catalogGroupId],
    ),
    db.query<{
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
    ),
  ])
  const group = groupResult.rows[0]
  if (!group) return null
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
          ),
          latest as (
            -- Dedupe to the latest observation id per product on NARROW
            -- columns first, then join the wide evidence_json back below
            -- for only the surviving rows, instead of carrying ~15 kB of
            -- evidence_json per row through the DISTINCT ON sort. o.id is
            -- the PK; result identical modulo the pre-existing tie pick.
            select distinct on (o.product_id) o.id
            from litalerts_competitor_observations o
            join snapshot_products sp on sp.product_id = o.product_id
            where o.evidence_json is not null
            order by o.product_id, o.captured_at desc
          )
          select o.id, o.product_id, o.evidence_json, o.captured_at::text
          from latest l
          join litalerts_competitor_observations o on o.id = l.id
          order by o.product_id
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
  // Row shape pulled from `fuzzy_skus`. The on-the-wire payload is
  // deliberately tight:
  //   - `parsed_jsonb` was previously selected but never read, so we
  //     don't pull it any more (saved ~30% of the row bytes on the
  //     structured-fuzzy hot path).
  //   - `raw_input_jsonb` is projected at the SQL layer to just the
  //     6 fields the SPA + scorer actually consume (listingName / url
  //     / dispensaryName / brand / category / productId). The raw
  //     LitAlerts JSON has dozens of fields per row we never look at.
  //   - `image_url` is decorated via a LEFT JOIN against
  //     `litalerts_product_images` so we don't pay a separate
  //     round-trip after scoring.
  const fuzzyRows: Array<{
    id: number
    source_kind: string
    source_listing_id: string
    raw_input_jsonb: unknown
    brand_norm: string | null
    category_norm: string | null
    subcategory_norm: string | null
    size_g_norm: string | null
    size_mg_norm: string | null
    pack_count_norm: number | null
    strain_norm: string | null
    image_url: string | null
  }> = []

  if (obsIds.length > 0) {
    const obsFuzzy = await db.query<typeof fuzzyRows[number]>(
      `select id, source_kind, source_listing_id,
              jsonb_build_object(
                'listingName',    raw_input_jsonb->>'listingName',
                'url',            raw_input_jsonb->>'url',
                'dispensaryName', raw_input_jsonb->>'dispensaryName',
                'brand',          raw_input_jsonb->>'brand',
                'category',       raw_input_jsonb->>'category',
                'productId',      raw_input_jsonb->>'productId'
              ) as raw_input_jsonb,
              brand_norm, category_norm, subcategory_norm,
              size_g_norm::text, size_mg_norm::text, pack_count_norm, strain_norm,
              null::text as image_url
       from fuzzy_skus
       where source_kind = 'litalerts_competitor_observation'
         and source_listing_id like any($1::text[])`,
      [obsIds.map((id) => `${id}:%`)],
    )
    fuzzyRows.push(...obsFuzzy.rows)
  }

  // Resolve the catalog's effective brand (override-aware) once, via the
  // shared helper (see resolveEffectiveBrandMapping). Used both to fetch
  // structured fuzzies (hard brand filter) AND as the catalog brand we score
  // against, so the scorer doesn't reject a legitimate override-mapped row just
  // because the raw catalog brand name (e.g. "Grass Roots") differs from the
  // LitAlerts brand name (e.g. "Grassroots (Curaleaf)"). A group has exactly
  // one raw brand spelling, so this is behaviourally identical to the original
  // inline single-brand block.
  const brandMapping = await resolveEffectiveBrandMapping(db, [group.brand_name])
  const effectiveBrandNorms: string[] = brandMapping.norms
  const effectiveBrandNorm: string | null = brandMapping.representativeNorm
  // Set form for O(1) per-fuzzy "is this brand_norm one of the expanded
  // spellings for our catalog brand?" lookup during scoring.
  const effectiveBrandSet = new Set(effectiveBrandNorms.map((n) => n.toLowerCase().trim()))

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

  // Pre-compute the catalog group's significant-token set once. We
  // use the same token set both as a server-side hard-gate during
  // scoring (HARD GATE #2 below) AND as a SQL pre-filter on the
  // structured fuzzy fetch — having pulled all brand+category+size
  // matches we'd previously be transferring 1000+ rows over the
  // wire just to discard ~95% of them at the JS-side token gate.
  // Pushing the substring filter into SQL turns "brand+category+
  // size matched rows" from ~1700 → ~40 for a typical brand and
  // drops the wire payload to a few KB.
  const groupNameTokens = extractSignificantNameTokens(group.group_name, {
    brandText: effectiveBrandNorm ?? group.brand_name,
    categoryText: catalogCategoryCanonical ?? group.category_name,
  })
  // ILIKE patterns for the SQL pre-filter. extractSignificantNameTokens
  // splits on [^a-z0-9]+ so tokens are always plain alphanumerics —
  // no need to escape LIKE wildcard characters (%/_) in them.
  const groupNameTokenPatterns = Array.from(groupNameTokens).map((t) => `%${t}%`)

  if (effectiveBrandNorms.length > 0) {
    // Hard brand / category-alias / size / name-token prefilters live in the
    // shared fetchPartnerFuzzyCandidates helper (dedup off + original 7-field
    // projection + top-1000-by-created_at = the exact original group query).
    const structuredFuzzy = await fetchPartnerFuzzyCandidates(db, {
      brandNorms: effectiveBrandNorms,
      categoryCanonical: catalogCategoryCanonical,
      grams: variantGrams,
      mgs: variantMgs,
      tokenPatterns: groupNameTokenPatterns,
      dedupLatestPerListing: false,
      limit: 1000,
    })
    fuzzyRows.push(...structuredFuzzy)
  }

  const fuzzyResult = { rows: fuzzyRows }

  const fuzzies: FuzzySkuRow[] = fuzzyResult.rows.map((row) => ({
    id: row.id,
    sourceKind: row.source_kind,
    sourceListingId: row.source_listing_id,
    rawInputJsonb: row.raw_input_jsonb,
    brandNorm: row.brand_norm,
    categoryNorm: row.category_norm,
    subcategoryNorm: row.subcategory_norm,
    sizeGNorm: row.size_g_norm != null ? Number.parseFloat(row.size_g_norm) : null,
    sizeMgNorm: row.size_mg_norm != null ? Number.parseFloat(row.size_mg_norm) : null,
    packCountNorm: row.pack_count_norm,
    strainNorm: row.strain_norm,
  }))
  // Side-map: fuzzy_sku.id → cached LitAlerts image URL, decorated
  // straight from the SQL LEFT JOIN above so we don't have to issue
  // a separate `litalerts_product_images` SELECT after scoring.
  // Legacy `litalerts_competitor_observation` fuzzies always get
  // null here (the JOIN is keyed on `raw_input_jsonb->>'productId'`
  // which those rows don't carry).
  const imageByFuzzyId = new Map<number, string>()
  for (const row of fuzzyResult.rows) {
    if (row.image_url != null) imageByFuzzyId.set(row.id, row.image_url)
  }

  // verdictResult was loaded up-front in Phase A above (parallel
  // with the group/snapshot reads) so we don't pay an extra RTT
  // for it here.

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
  // `groupNameTokens` was computed earlier (before the structured
  // fuzzy fetch) so the same token set could double as a SQL
  // pre-filter. Reused here as the scorer's HARD GATE #2 input.

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
        // Decorate the verdict row with the per-product image too, so
        // downstream consumers (effectiveListingFromFuzzy in
        // loadEffectiveMarketListingsForGroup, the catalog/market-data
        // SPA) don't have to re-issue the LEFT JOIN they already ran
        // alongside the fuzzy fetch.
        imageUrl: imageByFuzzyId.get(row.fuzzy_sku_id) ?? null,
      }
    })
    .filter((row): row is NonNullable<typeof row> => row !== null)

  // Per-variant scoring targets: each catalog variant scored against every
  // fuzzy, sharing this group's name tokens for HARD GATE #2. The `null` arm is
  // used when the group has no parseable variants (fall back to group-level
  // profile scoring) so the page stays useful for un-populated groups.
  const scoringVariantTargets: VariantScoringTarget[] =
    catalogVariants.length > 0
      ? catalogVariants.map((v) => ({
          variant: v,
          profile: {
            brandNorm: catalogProfile.brandNorm,
            categoryNorm: catalogProfile.categoryNorm,
            subcategoryNorm: catalogProfile.subcategoryNorm,
            sizeGNorm: v.sizeGNorm,
            sizeMgNorm: v.sizeMgNorm,
            packCountNorm: v.packCountNorm,
            strainNorm: null,
            nameTokens: variantNameTokensById.get(v.catalogProductId) ?? catalogProfile.nameTokens,
          },
          gate2Tokens: groupNameTokens,
        }))
      : [{ variant: null, profile: catalogProfile, gate2Tokens: groupNameTokens }]

  // Score every un-verdicted fuzzy against EVERY catalog variant and keep the
  // best (variant, score) pair per fuzzy, via the shared pure scorer (see
  // scoreFuzzyCandidate — same function powers the family audit surface).
  const scoredAll = fuzzies
    .filter((fuzzy) => !verdictByFuzzy.has(fuzzy.id))
    .map((fuzzy) =>
      scoreFuzzyCandidate(fuzzy, {
        effectiveBrandSet,
        catalogBrandNorm: catalogProfile.brandNorm,
        catalogCategoryCanonical,
        brandTextForTokens: effectiveBrandNorm ?? group.brand_name,
        categoryTextForTokens: catalogCategoryCanonical ?? group.category_name,
        variantTargets: scoringVariantTargets,
        imageByFuzzyId,
      }),
    )
    .filter((c): c is MarketMatchCandidate => c !== null)

  // Rank-then-cap: the SPA needs the full ranked window for the
  // client-side slider to work, but the payload still needs to be
  // bounded. Sort everything by score descending, then bucket by
  // matched-variant size group and truncate to TOP_N_PER_SIZE_GROUP
  // (and the no-matched-variant bucket to TOP_N_UNMATCHED).
  // suppressedCandidateCount is always 0 in the new contract — the
  // client computes its own visible/hidden split from finalScore vs
  // the current slider value.
  const allRanked = [...scoredAll].sort((a, b) => b.finalScore - a.finalScore)

  const sizeGroupsMap = new Map<
    string,
    { sizeKey: string; sizeLabel: string; variants: CatalogVariant[]; candidates: MarketMatchCandidate[] }
  >()
  for (const variant of catalogVariants) {
    if (!sizeGroupsMap.has(variant.sizeKey)) {
      sizeGroupsMap.set(variant.sizeKey, {
        sizeKey: variant.sizeKey,
        sizeLabel: variant.sizeLabel,
        variants: [],
        candidates: [],
      })
    }
    sizeGroupsMap.get(variant.sizeKey)!.variants.push(variant)
  }
  const unmatchedCandidates: MarketMatchCandidate[] = []
  for (const c of allRanked) {
    if (c.matchedSizeKey === 'unsized' || !sizeGroupsMap.has(c.matchedSizeKey)) {
      if (unmatchedCandidates.length < TOP_N_UNMATCHED) unmatchedCandidates.push(c)
    } else {
      const bucket = sizeGroupsMap.get(c.matchedSizeKey)!
      if (bucket.candidates.length < TOP_N_PER_SIZE_GROUP) bucket.candidates.push(c)
    }
  }

  const sizeGroups: SizeGroup[] = Array.from(sizeGroupsMap.values())
    .map((g) => ({
      sizeKey: g.sizeKey,
      sizeLabel: g.sizeLabel,
      variants: g.variants,
      candidates: g.candidates,
      suppressedCandidateCount: 0,
    }))
    .sort((a, b) => sizeGroupSortKey(a.sizeKey) - sizeGroupSortKey(b.sizeKey))

  // Total candidate count = everything we returned to the client
  // (capped). Kept as `visibleCandidateCount` for response-shape
  // backward compatibility; old SPA builds that summed visible +
  // suppressed still get a coherent total.
  const totalReturned =
    sizeGroups.reduce((sum, g) => sum + g.candidates.length, 0) + unmatchedCandidates.length

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
    visibleCandidateCount: totalReturned,
    suppressedCandidateCount: 0,
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

export function makeSizeKey(
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

/**
 * Default minimum score for an unreviewed candidate to be auto-
 * promoted into the "effective" listings set surfaced on the catalog
 * detail page and (later) in the pricing comp pool.
 *
 * Calibrated against the spot-check that "the top page of items being
 * displayed were either all exact match or family match, which will
 * generally be good enough to establish pricing on" — i.e. the
 * existing 0.70 threshold the review UI already uses.
 */
export const EFFECTIVE_AUTO_PROMOTE_THRESHOLD = 0.7

/**
 * One marketplace listing as it should appear to the catalog-detail
 * page and to downstream pricing aggregation, sourced from a
 * verdict-applied or auto-promoted catalog_market_matches /
 * fuzzy_skus row.
 *
 * Shape is a strict subset of GroupProductMarketEvidence's
 * `matchedListings` element so consumers can splice it in without
 * any per-source translation.
 */
export interface EffectiveMarketListing {
  catalogProductId: number | null
  dispensaryName: string
  listingName: string
  category: string | null
  preTaxPrice: number | null
  postTaxPrice: number | null
  url: string | null
  /**
   * Per-product image URL, sourced (in order of preference) from the
   * LitAlerts partner-API `imageURL` field on the originating
   * `/v1/brands/:id/products` row, or — for legacy scraped rows that
   * predate the partner-API cutover — from the
   * `litalerts_product_images` LEFT JOIN. Null when neither source
   * has an image for this productId.
   */
  imageUrl: string | null
  matchTier: 'exact' | 'fallback' | 'weak'
  source: 'nearby' | 'statewide'
  distanceBand: 'near' | 'mid' | 'far' | 'very_far' | 'unknown'
  distanceMiles: number | null
  eligibleForPricing: boolean
  exclusionReason: string | null
  /** Why this listing was included (review verdict or auto-promote). */
  inclusionReason: 'reviewed_exact' | 'reviewed_brand_family' | 'auto_promoted'
  /** Score used for inclusion (null for hand-reviewed rows). */
  finalScore: number | null
}

export interface EffectiveMarketListingsBundle {
  byProductId: Map<number, EffectiveMarketListing[]>
  unmatchedListings: EffectiveMarketListing[]
  autoPromoteThreshold: number
  reviewedCount: number
  autoPromotedCount: number
}

/**
 * Return the "effective" marketplace listings for a catalog group:
 *   - Live reviewed exact/brand_family verdicts (never `no_match`).
 *   - Unreviewed candidates whose finalScore >= autoPromoteThreshold.
 *
 * Internally piggy-backs on loadGroupReview so brand-override
 * expansion, hard category/size/name gates, and scoring stay in one
 * place — there is exactly one definition of "what counts as a
 * match for this catalog group" in the system.
 *
 * Listings are bucketed by matchedCatalogProductId so callers can
 * splice them into per-product evidence. Listings whose match had no
 * associated catalog variant (e.g. groups whose snapshot has no
 * parseable variants) land in `unmatchedListings`.
 */
export async function loadEffectiveMarketListingsForGroup(
  db: Queryable,
  catalogGroupId: number,
  options: { autoPromoteThreshold?: number } = {},
): Promise<EffectiveMarketListingsBundle | null> {
  const threshold = Math.min(
    1,
    Math.max(0, options.autoPromoteThreshold ?? EFFECTIVE_AUTO_PROMOTE_THRESHOLD),
  )
  const bundle = await loadGroupReview(db, catalogGroupId, {})
  if (!bundle) return null

  const byProductId = new Map<number, EffectiveMarketListing[]>()
  const unmatchedListings: EffectiveMarketListing[] = []
  let reviewedCount = 0
  let autoPromotedCount = 0

  const push = (listing: EffectiveMarketListing): void => {
    if (listing.catalogProductId === null) {
      unmatchedListings.push(listing)
      return
    }
    const cur = byProductId.get(listing.catalogProductId) ?? []
    cur.push(listing)
    byProductId.set(listing.catalogProductId, cur)
  }

  // 1) Reviewed exact / brand_family verdicts. `no_match` is the
  // operator's explicit "this row is junk, never use it" — respect
  // that even if the scorer thinks it's high quality.
  for (const v of bundle.liveVerdicts) {
    if (v.verdict === 'no_match') continue
    const reason: EffectiveMarketListing['inclusionReason'] =
      v.verdict === 'exact' ? 'reviewed_exact' : 'reviewed_brand_family'
    const tier: EffectiveMarketListing['matchTier'] =
      v.verdict === 'exact' ? 'exact' : 'fallback'
    const listing = effectiveListingFromFuzzy({
      fuzzy: v.fuzzy,
      catalogProductId: v.catalogProductId,
      matchTier: tier,
      inclusionReason: reason,
      finalScore: v.confidenceAtVerdict,
      listingUrl: v.listingUrl,
      dispensaryName: v.dispensaryName,
      imageUrl: v.imageUrl,
    })
    if (listing) {
      reviewedCount += 1
      push(listing)
    }
  }

  // 2) Unreviewed candidates above the auto-promote threshold.
  const seenFuzzyIds = new Set(bundle.liveVerdicts.map((v) => v.fuzzySkuId))
  const allCandidates = [
    ...bundle.sizeGroups.flatMap((g) => g.candidates),
    ...bundle.unmatchedCandidates,
  ]
  for (const c of allCandidates) {
    if (seenFuzzyIds.has(c.fuzzy.id)) continue
    if (!Number.isFinite(c.finalScore) || c.finalScore < threshold) continue
    const listing = effectiveListingFromFuzzy({
      fuzzy: c.fuzzy,
      catalogProductId: c.matchedCatalogProductId,
      // Auto-promoted candidates land as 'fallback' tier — they're
      // good enough to feed pricing but they didn't get an explicit
      // "exact" verdict from a human.
      matchTier: 'fallback',
      inclusionReason: 'auto_promoted',
      finalScore: c.finalScore,
      listingUrl: c.listingUrl,
      dispensaryName: c.dispensaryName,
      imageUrl: c.imageUrl,
    })
    if (listing) {
      autoPromotedCount += 1
      push(listing)
    }
  }

  return {
    byProductId,
    unmatchedListings,
    autoPromoteThreshold: threshold,
    reviewedCount,
    autoPromotedCount,
  }
}

/**
 * Project a fuzzy_sku + verdict/candidate context into the wire
 * shape used by `GroupProductMarketEvidence.matchedListings`. Falls
 * back to NaN/null prices when raw_input_jsonb has no usable price
 * (the caller filters those out before averaging).
 */
function effectiveListingFromFuzzy(args: {
  fuzzy: FuzzySkuRow
  catalogProductId: number | null
  matchTier: 'exact' | 'fallback' | 'weak'
  inclusionReason: EffectiveMarketListing['inclusionReason']
  finalScore: number | null
  listingUrl: string | null
  dispensaryName: string | null
  /**
   * Per-product image URL, already coalesced from
   * raw_input_jsonb.imageUrl OR the litalerts_product_images LEFT
   * JOIN by the upstream fuzzy fetch (see imageByFuzzyId in
   * loadGroupReview). Null when no image is available for this
   * productId.
   */
  imageUrl: string | null
}): EffectiveMarketListing | null {
  const raw = (args.fuzzy.rawInputJsonb ?? {}) as {
    listingName?: string | null
    category?: string | null
    salePrice?: number | string | null
    normalPrice?: number | string | null
    dispensaryName?: string | null
    url?: string | null
    imageUrl?: string | null
  }
  const listingName = typeof raw.listingName === 'string' ? raw.listingName : null
  if (!listingName) return null

  const preTaxRaw = parseLooseNumber(raw.salePrice) ?? parseLooseNumber(raw.normalPrice)
  const preTaxPrice = preTaxRaw !== null && preTaxRaw > 0 ? Math.round(preTaxRaw * 100) / 100 : null
  // Mirror litAlertsMarket.ts's PRICING_POST_TAX_MULTIPLIER (1.13).
  const postTaxPrice = preTaxPrice !== null ? Math.round(preTaxPrice * 1.13 * 100) / 100 : null

  // Prefer the coalesced upstream value (which already considered the
  // legacy scrape-table fallback); fall back to raw.imageUrl as a
  // belt-and-suspenders default for code paths that bypass the
  // upstream decoration.
  const imageUrl =
    args.imageUrl
    ?? (typeof raw.imageUrl === 'string' && raw.imageUrl.length > 0 ? raw.imageUrl : null)

  return {
    catalogProductId: args.catalogProductId,
    dispensaryName: args.dispensaryName ?? (typeof raw.dispensaryName === 'string' ? raw.dispensaryName : '—'),
    listingName,
    category: typeof raw.category === 'string' ? raw.category : null,
    preTaxPrice,
    postTaxPrice,
    url: args.listingUrl ?? (typeof raw.url === 'string' ? raw.url : null),
    imageUrl,
    matchTier: args.matchTier,
    // Partner-product fuzzies don't carry geo distance, so we surface
    // 'statewide' / 'unknown' rather than fabricate a near/mid band.
    source: 'statewide',
    distanceBand: 'unknown',
    distanceMiles: null,
    // A reviewed exact/family verdict OR an auto-promoted high-score
    // candidate is eligible for pricing in this surface. Downstream
    // pricing aggregation can re-gate on its own rules if needed.
    eligibleForPricing: preTaxPrice !== null && preTaxPrice > 0,
    exclusionReason: preTaxPrice !== null && preTaxPrice > 0 ? null : 'No usable price on LitAlerts row',
    inclusionReason: args.inclusionReason,
    finalScore: args.finalScore,
  }
}

export function parseLooseNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') {
    const trimmed = v.trim()
    if (trimmed.length === 0) return null
    const n = Number.parseFloat(trimmed)
    return Number.isFinite(n) ? n : null
  }
  return null
}
