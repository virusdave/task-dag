import type { QueryResultRow } from 'pg'

import type { Queryable } from '../../server/db/pool.js'

const MAX_INPUT_ROWS = 85
const MAX_BRAND_KEYS = 120
const MAX_BRAND_DIRECTORY_ROWS = 2_000
const MAX_BRAND_CANDIDATES_PER_ROW = 8
const MAX_PRODUCTS_PER_BRAND = 10
const MAX_GLOBAL_PRODUCTS = MAX_BRAND_KEYS * MAX_PRODUCTS_PER_BRAND
const MAX_RECENT_OBSERVATIONS_PER_BRAND = 50
const MAX_CANDIDATES_PER_ROW = 5
const MAX_CONTEXT_CHARS_PER_ROW = 8_000

export interface PendingPurchaseEvidenceRowDescriptor {
  readonly rowKey: string
  readonly siteDealerId: number
  readonly distributorProductId: string
  readonly distributorProductName: string
  readonly brandNames: readonly string[]
}

export interface PendingPurchasePriorOutcomeEvidence {
  readonly distributorProductId: string
  readonly distributorProductName: string
  readonly targetBrand: string | null
  readonly targetCategory: string | null
  readonly targetSubcategory: string | null
  readonly targetGroupName: string | null
  readonly targetVariantName: string | null
  readonly targetVariantTab: string | null
  readonly targetStrainName: string | null
  readonly targetSize: string | null
  readonly targetPackCount: number | null
  readonly observedAt: string
}

export interface PendingPurchaseMarketCandidateEvidence {
  readonly litalertsProductId: string
  readonly brandName: string | null
  readonly productName: string
  readonly category: string | null
  readonly amount: string | null
  readonly units: string | null
  readonly observedAt: string
  readonly freshness: 'preferred-48h' | 'stale-newest-available'
}

export interface PendingPurchaseMarketBrandEvidence {
  readonly litalertsBrandId: string
  readonly brandName: string
  readonly observedAt: string
  readonly freshness: 'preferred-48h' | 'stale-newest-available'
}

export interface PendingPurchaseRowClassificationEvidence {
  readonly priorOutcome: PendingPurchasePriorOutcomeEvidence | null
  readonly marketBrandCandidates: readonly PendingPurchaseMarketBrandEvidence[]
  readonly marketCandidates: readonly PendingPurchaseMarketCandidateEvidence[]
}

interface PriorRow extends QueryResultRow {
  readonly source_row_key: string
  readonly distributor_product_id: string
  readonly distributor_product_name: string
  readonly target_brand: string | null
  readonly expected_category: string | null
  readonly expected_subcategory: string | null
  readonly target_group_name: string | null
  readonly target_variant_name: string | null
  readonly target_variant_tab: string | null
  readonly target_strain_name: string | null
  readonly target_size: string | null
  readonly target_pack_count: number | null
  readonly updated_at: Date
}

interface BrandRow extends QueryResultRow {
  readonly brand_id: string
  readonly name: string
  readonly last_seen_at: Date
}

interface ProductRow extends QueryResultRow {
  readonly product_id: string
  readonly brand_id: string | null
  readonly brand_name: string | null
  readonly product_name: string
  readonly category: string | null
  readonly amount: string | null
  readonly units: string | null
  readonly observed_at: Date
}

/** Optional, bounded evidence for the initial classifier. Provider failures degrade to empty evidence. */
export async function loadPendingPurchaseClassificationEvidence(
  db: Queryable,
  descriptors: readonly PendingPurchaseEvidenceRowDescriptor[],
): Promise<Map<string, PendingPurchaseRowClassificationEvidence>> {
  if (descriptors.length > MAX_INPUT_ROWS) {
    throw new Error(`Classification evidence loader received ${descriptors.length} rows (limit ${MAX_INPUT_ROWS}); batch by classifier chunk.`)
  }
  const rows = descriptors
  const output = new Map<string, {
    priorOutcome: PendingPurchasePriorOutcomeEvidence | null
    marketBrandCandidates: PendingPurchaseMarketBrandEvidence[]
    marketCandidates: PendingPurchaseMarketCandidateEvidence[]
  }>(rows.map((row) => [row.rowKey, {
    priorOutcome: null,
    marketBrandCandidates: [],
    marketCandidates: [],
  }]))
  const [priorRows, marketRows] = await Promise.all([
    loadPriorRows(db, rows).catch((error: unknown) => {
      warnUnavailable('prior packet', error)
      return []
    }),
    loadMarketRows(db, rows).catch((error: unknown) => {
      warnUnavailable('LitAlerts', error)
      return { brands: [] as BrandRow[], products: [] as ProductRow[] }
    }),
  ])

  for (const prior of priorRows) {
    const current = output.get(prior.source_row_key)
    if (current === undefined || current.priorOutcome !== null) continue
    current.priorOutcome = {
      distributorProductId: prior.distributor_product_id,
      distributorProductName: prior.distributor_product_name,
      targetBrand: prior.target_brand,
      targetCategory: prior.expected_category,
      targetSubcategory: prior.expected_subcategory,
      targetGroupName: prior.target_group_name,
      targetVariantName: prior.target_variant_name,
      targetVariantTab: prior.target_variant_tab,
      targetStrainName: prior.target_strain_name,
      targetSize: prior.target_size,
      targetPackCount: prior.target_pack_count,
      observedAt: prior.updated_at.toISOString(),
    }
  }

  for (const descriptor of rows) {
    const preferredBrandNames = new Set(descriptor.brandNames.map(normalize))
    const brandCandidates = marketRows.brands
      .map((brand) => ({
        brand,
        score: preferredBrandNames.has(normalize(brand.name))
          ? 2
          : similarityScore(descriptor.distributorProductName, brand.name),
      }))
      .filter(({ score }) => score > 0)
      .sort((left, right) => right.score - left.score || right.brand.last_seen_at.getTime() - left.brand.last_seen_at.getTime())
      .slice(0, MAX_BRAND_CANDIDATES_PER_ROW)
      .map(({ brand }) => ({
        litalertsBrandId: brand.brand_id,
        brandName: brand.name,
        observedAt: brand.last_seen_at.toISOString(),
        freshness: freshnessOf(brand.last_seen_at),
      }))
    const brandIds = new Set(brandCandidates.map((brand) => brand.litalertsBrandId))
    const productByConfiguration = new Map<string, ProductRow>()
    for (const product of marketRows.products) {
      if (product.brand_id === null || !brandIds.has(product.brand_id)) continue
      const key = `${product.product_id}:${product.amount ?? ''}:${product.units ?? ''}`
      const existing = productByConfiguration.get(key)
      if (existing === undefined || existing.observed_at < product.observed_at) {
        productByConfiguration.set(key, product)
      }
    }
    const candidates = [...productByConfiguration.values()]
      .map((product) => ({ product, score: similarityScore(descriptor.distributorProductName, product.product_name) }))
      .sort((left, right) => right.score - left.score || right.product.observed_at.getTime() - left.product.observed_at.getTime())
      .slice(0, MAX_CANDIDATES_PER_ROW)
      .map(({ product }) => ({
        litalertsProductId: product.product_id,
        brandName: product.brand_name,
        productName: product.product_name,
        category: product.category,
        amount: product.amount,
        units: product.units,
        observedAt: product.observed_at.toISOString(),
        freshness: freshnessOf(product.observed_at),
      }))
    const current = output.get(descriptor.rowKey)
    if (
      current !== undefined
      && JSON.stringify({ brandCandidates, candidates }).length <= MAX_CONTEXT_CHARS_PER_ROW
    ) {
      current.marketBrandCandidates = brandCandidates
      current.marketCandidates = candidates
    }
  }
  return output
}

async function loadPriorRows(db: Queryable, rows: readonly PendingPurchaseEvidenceRowDescriptor[]): Promise<PriorRow[]> {
  const result = await db.query<PriorRow>(`
    with input_rows as (
      select * from jsonb_to_recordset($1::jsonb)
        as r(row_key text, site_dealer_id bigint, distributor_product_id text, distributor_product_name text)
    ), matches as (
      select i.row_key as source_row_key, 0 as match_rank, p.id as row_id
      from input_rows i
      join pending_purchase_rows p
        on p.distributor_product_id = i.distributor_product_id
      where p.approval_status = 'approved' or p.last_apply_status = 'applied'

      union all

      select i.row_key as source_row_key, 1 as match_rank, p.id as row_id
      from input_rows i
      join pending_purchase_rows p
        on p.site_dealer_id = i.site_dealer_id
       and lower(p.distributor_product_name) = lower(i.distributor_product_name)
       and p.distributor_product_id is distinct from i.distributor_product_id
      where p.approval_status = 'approved' or p.last_apply_status = 'applied'
    ), ranked as (
      select matches.source_row_key, p.distributor_product_id, p.distributor_product_name,
        case when p.edited_structured_fields ? 'targetBrand'
          then p.edited_structured_fields ->> 'targetBrand' else p.target_brand end as target_brand,
        case when p.edited_structured_fields ? 'expectedCategory'
          then p.edited_structured_fields ->> 'expectedCategory' else p.expected_category end as expected_category,
        case when p.edited_structured_fields ? 'expectedSubcategory'
          then p.edited_structured_fields ->> 'expectedSubcategory' else p.expected_subcategory end as expected_subcategory,
        case when p.edited_structured_fields ? 'targetGroupName'
          then p.edited_structured_fields ->> 'targetGroupName' else p.target_group_name end as target_group_name,
        case when p.edited_structured_fields ? 'targetVariantName'
          then p.edited_structured_fields ->> 'targetVariantName' else p.target_variant_name end as target_variant_name,
        case when p.edited_structured_fields ? 'targetVariantTab'
          then p.edited_structured_fields ->> 'targetVariantTab'
          else p.raw_row_json ->> 'targetVariantTab' end as target_variant_tab,
        case when p.edited_structured_fields ? 'targetStrainName'
          then p.edited_structured_fields ->> 'targetStrainName'
          else p.raw_row_json ->> 'targetStrain' end as target_strain_name,
        case when p.edited_structured_fields ? 'targetSize'
          then p.edited_structured_fields ->> 'targetSize'
          else nullif(p.raw_row_json ->> 'targetSize', '') end as target_size,
        case
          when p.edited_structured_fields ? 'targetPackCount'
            and p.edited_structured_fields ->> 'targetPackCount' ~ '^[1-9][0-9]*$'
            then (p.edited_structured_fields ->> 'targetPackCount')::integer
          when not (p.edited_structured_fields ? 'targetPackCount')
            and p.raw_row_json ->> 'targetPackCount' ~ '^[1-9][0-9]*$'
            then (p.raw_row_json ->> 'targetPackCount')::integer
          else null
        end as target_pack_count,
        p.updated_at,
        row_number() over (
          partition by matches.source_row_key
          order by matches.match_rank asc, p.updated_at desc, p.id desc
        ) as rank
      from matches
      join pending_purchase_rows p on p.id = matches.row_id
    ) select source_row_key, distributor_product_id, distributor_product_name, target_brand,
      expected_category, expected_subcategory, target_group_name, target_variant_name,
      target_variant_tab, target_strain_name, target_size, target_pack_count, updated_at
      from ranked where rank = 1 limit $2
  `, [JSON.stringify(rows.map((row) => ({
    row_key: row.rowKey,
    site_dealer_id: row.siteDealerId,
    distributor_product_id: row.distributorProductId,
    distributor_product_name: row.distributorProductName,
  }))), MAX_INPUT_ROWS])
  return result.rows
}

async function loadMarketRows(db: Queryable, rows: readonly PendingPurchaseEvidenceRowDescriptor[]): Promise<{ brands: BrandRow[]; products: ProductRow[] }> {
  const brandResult = await db.query<BrandRow>(`
    select brand_id::text as brand_id, name, last_seen_at from litalerts_brands
    where state_code = 'NY'
    order by last_seen_at desc limit $1
  `, [MAX_BRAND_DIRECTORY_ROWS])
  const brandIds = selectProductBrandIds(rows, brandResult.rows)
  if (brandIds.length === 0) return { brands: brandResult.rows, products: [] }
  const productResult = await db.query<ProductRow>(`
        with selected as (
          select candidate.observation_id
          from unnest($1::bigint[]) brand(brand_id)
          cross join lateral (
            select observation_id
            from (
              select distinct on (product_id, amount, units)
                observation_id, product_id, amount, units, observed_at
              from (
                select observation_id, product_id, amount, units, observed_at
                from litalerts_products
                where brand_id = brand.brand_id and state_code = 'NY'
                order by observed_at desc
                limit $4
              ) recent
              order by product_id, amount, units, observed_at desc
            ) latest_configurations
            order by observed_at desc
            limit $2
          ) candidate
          limit $3
        ) select p.product_id::text as product_id, p.brand_id::text as brand_id, p.brand_name,
          p.product_name, p.category, p.amount, p.units, p.observed_at
        from selected s join litalerts_products p on p.observation_id = s.observation_id
        order by p.observed_at desc
  `, [
    brandIds,
    MAX_PRODUCTS_PER_BRAND,
    MAX_GLOBAL_PRODUCTS,
    MAX_RECENT_OBSERVATIONS_PER_BRAND,
  ])
  return { brands: brandResult.rows, products: productResult.rows }
}

function selectProductBrandIds(
  rows: readonly PendingPurchaseEvidenceRowDescriptor[],
  brands: readonly BrandRow[],
): string[] {
  const selected = new Set<string>()
  const rankedByRow = rows.map((row) => {
    const preferredBrandNames = new Set(row.brandNames.map(normalize))
    return brands
      .map((brand) => ({
        brand,
        score: preferredBrandNames.has(normalize(brand.name))
          ? 2
          : similarityScore(row.distributorProductName, brand.name),
      }))
      .filter(({ score }) => score > 0)
      .sort((left, right) => right.score - left.score || right.brand.last_seen_at.getTime() - left.brand.last_seen_at.getTime())
      .slice(0, MAX_BRAND_CANDIDATES_PER_ROW)
  })
  // Allocate one candidate to each row before taking a second candidate for
  // any row, so a large first chunk cannot consume the packet-wide brand cap.
  for (let rank = 0; rank < MAX_BRAND_CANDIDATES_PER_ROW; rank += 1) {
    for (const candidates of rankedByRow) {
      const candidate = candidates[rank]
      if (candidate === undefined) continue
      selected.add(candidate.brand.brand_id)
      if (selected.size >= MAX_BRAND_KEYS) return [...selected]
    }
  }
  return [...selected]
}

function warnUnavailable(label: string, error: unknown): void {
  console.warn(`[pending-purchase] Optional ${label} classification evidence unavailable: ${error instanceof Error ? error.message : String(error)}`)
}

function normalize(value: string): string { return value.trim().toLocaleLowerCase('en-US') }
function freshnessOf(observedAt: Date): 'preferred-48h' | 'stale-newest-available' {
  return Date.now() - observedAt.getTime() <= 48 * 60 * 60 * 1000
    ? 'preferred-48h'
    : 'stale-newest-available'
}

function similarityScore(left: string, right: string): number {
  const leftTokens = new Set(normalize(left).split(/[^a-z0-9]+/).filter(Boolean))
  const rightTokens = new Set(normalize(right).split(/[^a-z0-9]+/).filter(Boolean))
  let overlap = 0
  for (const token of leftTokens) if (rightTokens.has(token)) overlap += 1
  return overlap / Math.max(1, new Set([...leftTokens, ...rightTokens]).size)
}
