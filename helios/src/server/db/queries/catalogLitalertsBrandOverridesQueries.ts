/**
 * Catalog ↔ LitAlerts brand-mapping overrides (issue #20 follow-on).
 *
 * Heuristic brand matching (exact / case-insensitive / normalized /
 * token-overlap) gets us ~84% coverage but cannot resolve cases like
 *   "Grass Roots" ↔ "Grassroots (Curaleaf)"
 * where the brand display strings diverge across systems. This module
 * powers the operator-facing /catalog/brand-mapping page so a human can
 * pick the right LitAlerts brand from a dropdown of ALL NY brands and
 * persist that mapping in `catalog_litalerts_brand_overrides`. Lookups
 * later (e.g. Catalog → Market Data) prefer the override and fall back
 * to the heuristic when no row exists.
 *
 * The same `normalize`/`jaccard` shapes used by the one-off sanity
 * script (scripts/litalerts-brand-mapping-sanity.mts) are reproduced
 * here so the page's heuristic candidate column matches what the
 * operator saw in the static report.
 */

import type { Queryable } from '../pool.js'

export type MappingConfidence = 'override' | 'exact' | 'case-insensitive' | 'normalized' | 'token-overlap' | 'none'

export interface LitalertsBrandSummary {
  brandId: number
  name: string
  statesCsv: string | null
  productCount: number
  configCount: number
}

export interface CatalogBrandMappingRow {
  catalogBrandName: string
  catalogGroupCount: number
  /** Operator-confirmed mapping when present (incl. explicit-null = "no match exists"). */
  override: {
    litalertsBrandId: number | null
    litalertsBrandName: string | null
    setByUserId: string | null
    setAt: string
    notes: string | null
  } | null
  /** Heuristic candidate, only computed when no override row exists. */
  heuristic: {
    brandId: number
    name: string
    productCount: number
    configCount: number
    confidence: Exclude<MappingConfidence, 'override' | 'none'>
  } | null
  /**
   * Whichever is the *current* mapping to use for matching:
   *   - the override (if any), else
   *   - the heuristic (if any), else
   *   - none.
   */
  effective: {
    litalertsBrandId: number | null
    litalertsBrandName: string | null
    confidence: MappingConfidence
  }
}

export interface BrandMappingListResponse {
  rows: CatalogBrandMappingRow[]
  litalertsBrands: LitalertsBrandSummary[]
  totals: {
    catalogBrandCount: number
    overrideCount: number
    explicitNoMatchCount: number
    heuristicOnlyCount: number
    unmappedCount: number
  }
}

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/\b(co|company|cannabis|brands?|llc|inc|corp)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function tokenSet(s: string): Set<string> {
  return new Set(normalize(s).split(/\s+/).filter((t) => t.length >= 3))
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let intersection = 0
  for (const x of a) if (b.has(x)) intersection += 1
  return intersection / (a.size + b.size - intersection)
}

/**
 * Load:
 *   - every distinct catalog brand (+ its group count),
 *   - every NY LitAlerts brand (+ product/config volume),
 *   - any existing operator overrides,
 * and return one merged row per catalog brand with both the saved
 * override (if any) and the heuristic candidate (so the operator can
 * compare the system's guess to the truth).
 */
export async function loadCatalogBrandMappings(db: Queryable): Promise<BrandMappingListResponse> {
  const [catalogResult, litalertsResult, overrideResult] = await Promise.all([
    db.query<{ brand_name: string; group_count: string }>(
      `select brand_name, count(*)::text as group_count
         from catalog_groups
         where brand_name is not null and length(trim(brand_name)) > 0
         group by brand_name
         order by lower(brand_name) asc`,
    ),
    db.query<{
      brand_id: string
      name: string
      states_csv: string | null
      product_count: string
      config_count: string
    }>(
      `select lb.brand_id::text as brand_id,
              lb.name,
              lb.states_csv,
              coalesce(p.product_count, 0)::text as product_count,
              coalesce(p.config_count, 0)::text as config_count
         from litalerts_brands lb
         left join (
           select brand_id,
                  count(distinct product_id) as product_count,
                  count(*) as config_count
             from litalerts_products
             where state_code = 'NY'
             group by brand_id
         ) p on p.brand_id = lb.brand_id
         where lb.state_code = 'NY'
         order by lb.name asc`,
    ),
    db.query<{
      catalog_brand_name: string
      litalerts_brand_id: string | null
      litalerts_brand_name: string | null
      set_by_user_id: string | null
      set_at: string
      notes: string | null
    }>(
      `select catalog_brand_name,
              litalerts_brand_id::text as litalerts_brand_id,
              litalerts_brand_name,
              set_by_user_id,
              set_at::text as set_at,
              notes
         from catalog_litalerts_brand_overrides`,
    ),
  ])

  const litalertsBrands: LitalertsBrandSummary[] = litalertsResult.rows.map((r) => ({
    brandId: Number(r.brand_id),
    name: r.name,
    statesCsv: r.states_csv,
    productCount: Number(r.product_count),
    configCount: Number(r.config_count),
  }))

  const lbById = new Map<number, LitalertsBrandSummary>()
  const lbByExact = new Map<string, LitalertsBrandSummary>()
  const lbByLower = new Map<string, LitalertsBrandSummary>()
  const lbByNorm = new Map<string, LitalertsBrandSummary>()
  for (const lb of litalertsBrands) {
    lbById.set(lb.brandId, lb)
    lbByExact.set(lb.name, lb)
    lbByLower.set(lb.name.toLowerCase().trim(), lb)
    lbByNorm.set(normalize(lb.name), lb)
  }

  const overridesByCatalog = new Map<string, (typeof overrideResult.rows)[number]>()
  for (const o of overrideResult.rows) {
    overridesByCatalog.set(o.catalog_brand_name, o)
  }

  const rows: CatalogBrandMappingRow[] = catalogResult.rows.map((c) => {
    const catalogBrandName = c.brand_name
    const overrideRaw = overridesByCatalog.get(catalogBrandName)
    const override = overrideRaw
      ? {
          litalertsBrandId: overrideRaw.litalerts_brand_id != null ? Number(overrideRaw.litalerts_brand_id) : null,
          litalertsBrandName: overrideRaw.litalerts_brand_name,
          setByUserId: overrideRaw.set_by_user_id,
          setAt: overrideRaw.set_at,
          notes: overrideRaw.notes,
        }
      : null

    // Heuristic candidate (shown for context, even when override exists,
    // so the operator can see when their override differs from the
    // system guess).
    let heuristic: CatalogBrandMappingRow['heuristic'] = null
    const exact = lbByExact.get(catalogBrandName)
    if (exact) {
      heuristic = {
        brandId: exact.brandId,
        name: exact.name,
        productCount: exact.productCount,
        configCount: exact.configCount,
        confidence: 'exact',
      }
    } else {
      const lower = lbByLower.get(catalogBrandName.toLowerCase().trim())
      if (lower) {
        heuristic = {
          brandId: lower.brandId,
          name: lower.name,
          productCount: lower.productCount,
          configCount: lower.configCount,
          confidence: 'case-insensitive',
        }
      } else {
        const norm = lbByNorm.get(normalize(catalogBrandName))
        if (norm) {
          heuristic = {
            brandId: norm.brandId,
            name: norm.name,
            productCount: norm.productCount,
            configCount: norm.configCount,
            confidence: 'normalized',
          }
        } else {
          const cTokens = tokenSet(catalogBrandName)
          if (cTokens.size > 0) {
            let best: { lb: LitalertsBrandSummary; score: number } | null = null
            for (const lb of litalertsBrands) {
              const score = jaccard(cTokens, tokenSet(lb.name))
              if (score >= 0.5 && (!best || score > best.score)) best = { lb, score }
            }
            if (best) {
              heuristic = {
                brandId: best.lb.brandId,
                name: best.lb.name,
                productCount: best.lb.productCount,
                configCount: best.lb.configCount,
                confidence: 'token-overlap',
              }
            }
          }
        }
      }
    }

    let effective: CatalogBrandMappingRow['effective']
    if (override) {
      effective = {
        litalertsBrandId: override.litalertsBrandId,
        litalertsBrandName:
          override.litalertsBrandId != null
            ? lbById.get(override.litalertsBrandId)?.name ?? override.litalertsBrandName
            : null,
        confidence: 'override',
      }
    } else if (heuristic) {
      effective = {
        litalertsBrandId: heuristic.brandId,
        litalertsBrandName: heuristic.name,
        confidence: heuristic.confidence,
      }
    } else {
      effective = { litalertsBrandId: null, litalertsBrandName: null, confidence: 'none' }
    }

    return {
      catalogBrandName,
      catalogGroupCount: Number(c.group_count),
      override,
      heuristic,
      effective,
    }
  })

  const totals = {
    catalogBrandCount: rows.length,
    overrideCount: rows.filter((r) => r.override != null && r.override.litalertsBrandId != null).length,
    explicitNoMatchCount: rows.filter((r) => r.override != null && r.override.litalertsBrandId == null).length,
    heuristicOnlyCount: rows.filter((r) => r.override == null && r.heuristic != null).length,
    unmappedCount: rows.filter((r) => r.override == null && r.heuristic == null).length,
  }

  return { rows, litalertsBrands, totals }
}

/**
 * Upsert one operator override. Pass `litalertsBrandId === null` to
 * persist the explicit "no LitAlerts equivalent" verdict; the row will
 * still exist (so the page knows the operator has reviewed it).
 */
export async function upsertBrandOverride(
  db: Queryable,
  input: {
    catalogBrandName: string
    litalertsBrandId: number | null
    setByUserId: string
    notes?: string | null
  },
): Promise<CatalogBrandMappingRow> {
  // Look up the LitAlerts brand name for denorm storage so a later
  // rename / soft-delete on the LitAlerts side still leaves the page
  // showing something humane.
  let litalertsBrandName: string | null = null
  if (input.litalertsBrandId != null) {
    const lookup = await db.query<{ name: string }>(
      `select name from litalerts_brands where brand_id = $1 and state_code = 'NY' limit 1`,
      [input.litalertsBrandId],
    )
    litalertsBrandName = lookup.rows[0]?.name ?? null
  }

  await db.query(
    `insert into catalog_litalerts_brand_overrides
       (catalog_brand_name, litalerts_brand_id, litalerts_brand_name, set_by_user_id, set_at, notes)
     values ($1, $2, $3, $4, now(), $5)
     on conflict (catalog_brand_name) do update set
       litalerts_brand_id   = excluded.litalerts_brand_id,
       litalerts_brand_name = excluded.litalerts_brand_name,
       set_by_user_id       = excluded.set_by_user_id,
       set_at               = now(),
       notes                = excluded.notes`,
    [input.catalogBrandName, input.litalertsBrandId, litalertsBrandName, input.setByUserId, input.notes ?? null],
  )

  // Return the freshly merged row so the client can update in place
  // without a full list reload.
  const fresh = await loadCatalogBrandMappings(db)
  const row = fresh.rows.find((r) => r.catalogBrandName === input.catalogBrandName)
  if (!row) {
    // Shouldn't happen — the override was just upserted, but the brand
    // might not exist in catalog_groups anymore. Synthesize a row.
    return {
      catalogBrandName: input.catalogBrandName,
      catalogGroupCount: 0,
      override: {
        litalertsBrandId: input.litalertsBrandId,
        litalertsBrandName,
        setByUserId: input.setByUserId,
        setAt: new Date().toISOString(),
        notes: input.notes ?? null,
      },
      heuristic: null,
      effective: {
        litalertsBrandId: input.litalertsBrandId,
        litalertsBrandName,
        confidence: 'override',
      },
    }
  }
  return row
}

/**
 * Delete an operator override (returns to heuristic-only state).
 */
export async function deleteBrandOverride(db: Queryable, catalogBrandName: string): Promise<void> {
  await db.query(`delete from catalog_litalerts_brand_overrides where catalog_brand_name = $1`, [catalogBrandName])
}
