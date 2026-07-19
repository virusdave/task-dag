import type { Queryable } from '../../server/db/pool.js'
import { vendorBrandAssociationsSchemaApplied } from '../../server/db/pendingMigrations.js'

const MAX_ASSOCIATIONS = 5_000
const MAX_PURCHASE_REFS = 1_000
const MAX_MANIFEST_LINES = 10_000
const MAX_HISTORY_BRANDS = 500
const MAX_HISTORY_LINES_PER_BRAND = 200

interface VendorAssociationRow {
  vendor_id: number | string
  vendor_name: string
  brand_name: string
  is_primary: boolean
}

interface ManifestLineRow {
  dealer_id: number | string
  po_id: string
  brand_name: string | null
  category_name: string | null
}

interface CategoryObservationRow {
  brand_name: string
  category_name: string
  observation_count: number | string
}

export interface PendingPurchaseVendorEvidenceRow {
  readonly rowKey: string
  readonly purchaseRefs: readonly { dealerId: number; poId: string }[]
  readonly parsedBrand: string | null
  readonly parsedCategory: string | null
  readonly explicitBrandOverride: string | null
}

export interface PendingPurchaseVendorEvidence {
  readonly status: 'matched' | 'unknown' | 'conflicting' | 'explicit-override'
  readonly vendorId: number | null
  readonly vendorName: string | null
  readonly confidence: 'high' | 'medium' | 'none'
  readonly allowedBrandNames: readonly string[]
  readonly allowedCatalogProductIds: readonly number[]
  readonly evidence: readonly string[]
}

interface VendorAssociation {
  vendorId: number
  vendorName: string
  brandName: string
  isPrimary: boolean
}

interface ManifestLine {
  dealerId: number
  poId: string
  brandName: string | null
  categoryName: string | null
}

interface CategoryObservation {
  brandName: string
  categoryName: string
  count: number
}

function key(value: string): string {
  return value.trim().toLocaleLowerCase('en-US')
}

function purchaseKey(dealerId: number, poId: string): string {
  return `${dealerId}\u0000${poId}`
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Map(values.map((value) => [key(value), value.trim()])).values()]
    .filter((value) => value.length > 0)
    .sort((left, right) => left.localeCompare(right))
}

export function inferPendingPurchaseVendorEvidence(input: {
  readonly rows: readonly PendingPurchaseVendorEvidenceRow[]
  readonly associations: readonly VendorAssociation[]
  readonly manifestLines: readonly ManifestLine[]
  readonly categoryObservations: readonly CategoryObservation[]
}): Map<string, PendingPurchaseVendorEvidence> {
  const primaryByBrand = new Map<string, VendorAssociation>()
  const associationsByBrand = new Map<string, VendorAssociation[]>()
  const associationsByVendor = new Map<number, VendorAssociation[]>()
  for (const association of input.associations) {
    const brandAssociations = associationsByBrand.get(key(association.brandName)) ?? []
    brandAssociations.push(association)
    associationsByBrand.set(key(association.brandName), brandAssociations)
    const vendorAssociations = associationsByVendor.get(association.vendorId) ?? []
    vendorAssociations.push(association)
    associationsByVendor.set(association.vendorId, vendorAssociations)
    if (association.isPrimary) primaryByBrand.set(key(association.brandName), association)
  }

  const manifestByPurchase = new Map<string, ManifestLine[]>()
  for (const line of input.manifestLines) {
    const purchase = purchaseKey(line.dealerId, line.poId)
    const lines = manifestByPurchase.get(purchase) ?? []
    lines.push(line)
    manifestByPurchase.set(purchase, lines)
  }

  const rowsByPurchase = new Map<string, PendingPurchaseVendorEvidenceRow[]>()
  for (const row of input.rows) {
    for (const ref of row.purchaseRefs) {
      const purchase = purchaseKey(ref.dealerId, ref.poId)
      const rows = rowsByPurchase.get(purchase) ?? []
      rows.push(row)
      rowsByPurchase.set(purchase, rows)
    }
  }

  const categoryBrands = new Map<string, Set<string>>()
  for (const observation of input.categoryObservations) {
    if (observation.count <= 0) continue
    for (const association of associationsByBrand.get(key(observation.brandName)) ?? []) {
      const categoryKey = `${association.vendorId}\u0000${key(observation.categoryName)}`
      const brands = categoryBrands.get(categoryKey) ?? new Set<string>()
      brands.add(key(association.brandName))
      categoryBrands.set(categoryKey, brands)
    }
  }

  const result = new Map<string, PendingPurchaseVendorEvidence>()
  for (const row of input.rows) {
    if (row.explicitBrandOverride !== null) {
      result.set(row.rowKey, {
        status: 'explicit-override',
        vendorId: null,
        vendorName: null,
        confidence: 'high',
        allowedBrandNames: [row.explicitBrandOverride],
        allowedCatalogProductIds: [],
        evidence: [`Explicit distributor-brand override pins this line to “${row.explicitBrandOverride}”.`],
      })
      continue
    }

    const vendorEvidence = new Map<number, { association: VendorAssociation; sources: Set<string>; manifest: boolean }>()
    const addBrand = (brand: string | null, source: string, manifest: boolean): void => {
      if (brand === null) return
      const association = primaryByBrand.get(key(brand))
      if (association === undefined) return
      const existing = vendorEvidence.get(association.vendorId) ?? {
        association,
        sources: new Set<string>(),
        manifest: false,
      }
      existing.sources.add(`${source} brand “${association.brandName}” maps to ${association.vendorName}.`)
      existing.manifest ||= manifest
      vendorEvidence.set(association.vendorId, existing)
    }

    addBrand(row.parsedBrand, 'This line’s parsed', false)
    for (const ref of row.purchaseRefs) {
      const purchase = purchaseKey(ref.dealerId, ref.poId)
      for (const line of manifestByPurchase.get(purchase) ?? []) {
        addBrand(line.brandName, `Purchase ${ref.poId} manifest`, true)
      }
      for (const sibling of rowsByPurchase.get(purchase) ?? []) {
        if (sibling.rowKey !== row.rowKey) {
          addBrand(sibling.parsedBrand, `Purchase ${ref.poId} sibling line’s parsed`, false)
        }
      }
    }

    if (vendorEvidence.size === 0) {
      result.set(row.rowKey, {
        status: 'unknown',
        vendorId: null,
        vendorName: null,
        confidence: 'none',
        allowedBrandNames: [],
        allowedCatalogProductIds: [],
        evidence: ['No canonical vendor could be inferred from known brands in this purchase.'],
      })
      continue
    }
    if (vendorEvidence.size > 1) {
      result.set(row.rowKey, {
        status: 'conflicting',
        vendorId: null,
        vendorName: null,
        confidence: 'none',
        allowedBrandNames: [],
        allowedCatalogProductIds: [],
        evidence: [...vendorEvidence.values()].flatMap((value) => [...value.sources]).sort(),
      })
      continue
    }

    const matched = [...vendorEvidence.values()][0]!
    const vendorAssociations = associationsByVendor.get(matched.association.vendorId) ?? []
    let allowed = vendorAssociations.map((association) => association.brandName)
    const parsedAssociation = row.parsedBrand === null ? undefined : primaryByBrand.get(key(row.parsedBrand))
    if (parsedAssociation?.vendorId === matched.association.vendorId) {
      allowed = [parsedAssociation.brandName]
    } else if (row.parsedCategory !== null) {
      const specialized = categoryBrands.get(
        `${matched.association.vendorId}\u0000${key(row.parsedCategory)}`,
      )
      if (specialized !== undefined && specialized.size > 0) {
        allowed = vendorAssociations
          .filter((association) => specialized.has(key(association.brandName)))
          .map((association) => association.brandName)
      }
    }

    const allowedBrandNames = uniqueSorted(allowed)
    const specializationEvidence =
      parsedAssociation === undefined
      && row.parsedCategory !== null
      && allowedBrandNames.length < vendorAssociations.length
        ? [`Observed ${row.parsedCategory} purchase history narrows this vendor to ${allowedBrandNames.join(', ')}.`]
        : []
    result.set(row.rowKey, {
      status: 'matched',
      vendorId: matched.association.vendorId,
      vendorName: matched.association.vendorName,
      confidence: matched.manifest ? 'high' : 'medium',
      allowedBrandNames,
      allowedCatalogProductIds: [],
      evidence: [...matched.sources].sort().concat(specializationEvidence),
    })
  }
  return result
}

export async function loadPendingPurchaseVendorEvidence(
  db: Queryable,
  rows: readonly PendingPurchaseVendorEvidenceRow[],
): Promise<Map<string, PendingPurchaseVendorEvidence>> {
  if (!(await vendorBrandAssociationsSchemaApplied(db))) {
    console.warn(
      '[pending-purchase] Vendor evidence is unavailable until migration 104_vendor_brand_associations is applied.',
    )
    return new Map(rows.map((row) => [row.rowKey, {
      status: 'unknown' as const,
      vendorId: null,
      vendorName: null,
      confidence: 'none' as const,
      allowedBrandNames: [],
      allowedCatalogProductIds: [],
      evidence: ['Vendor evidence is unavailable because the canonical vendor directory migration is pending.'],
    }]))
  }

  const refs = new Map<string, { dealerId: number; poId: string }>()
  for (const row of rows) {
    for (const ref of row.purchaseRefs) refs.set(purchaseKey(ref.dealerId, ref.poId), ref)
  }
  if (refs.size > MAX_PURCHASE_REFS) {
    throw new Error(`Pending-purchase vendor evidence received ${refs.size} purchase references (limit ${MAX_PURCHASE_REFS}).`)
  }

  const [associationsResult, manifestResult] = await Promise.all([
    db.query<VendorAssociationRow>(
      `select a.vendor_id, v.name as vendor_name, a.brand_name, a.is_primary
         from vendor_brand_associations a
         join vendors v on v.id = a.vendor_id
        order by a.vendor_id, lower(a.brand_name), a.id
        limit $1`,
      [MAX_ASSOCIATIONS + 1],
    ),
    refs.size === 0
      ? Promise.resolve({ rows: [] as ManifestLineRow[] })
      : db.query<ManifestLineRow>(
          `with requested as (
             select "dealerId", "poId"
               from jsonb_to_recordset($1::jsonb) as x("dealerId" bigint, "poId" text)
           )
           select l.dealer_id, l.po_id, l.brand_name, l.category_name
             from requested r
             join sweed_purchase_line_items l
               on l.dealer_id = r."dealerId" and l.po_id = r."poId"
            where l.brand_name is not null
            order by l.dealer_id, l.po_id, l.line_index
            limit $2`,
          [JSON.stringify([...refs.values()]), MAX_MANIFEST_LINES + 1],
        ),
  ])
  if (associationsResult.rows.length > MAX_ASSOCIATIONS) {
    throw new Error(`Canonical vendor associations exceed the ${MAX_ASSOCIATIONS} row safety limit.`)
  }
  if (manifestResult.rows.length > MAX_MANIFEST_LINES) {
    throw new Error(`Pending-purchase manifest evidence exceeds the ${MAX_MANIFEST_LINES} line safety limit.`)
  }

  const associations: VendorAssociation[] = associationsResult.rows.map((association) => ({
    vendorId: Number(association.vendor_id),
    vendorName: association.vendor_name,
    brandName: association.brand_name,
    isPrimary: association.is_primary,
  }))
  const manifestLines: ManifestLine[] = manifestResult.rows.map((line) => ({
    dealerId: Number(line.dealer_id),
    poId: line.po_id,
    brandName: line.brand_name,
    categoryName: line.category_name,
  }))

  const preliminary = inferPendingPurchaseVendorEvidence({
    rows,
    associations,
    manifestLines,
    categoryObservations: [],
  })
  const matchedVendorIds = new Set(
    [...preliminary.values()]
      .map((evidence) => evidence.vendorId)
      .filter((vendorId): vendorId is number => vendorId !== null),
  )
  const historyBrands = uniqueSorted(
    associations
      .filter((association) => matchedVendorIds.has(association.vendorId))
      .map((association) => association.brandName),
  )
  if (historyBrands.length === 0) return preliminary
  if (historyBrands.length > MAX_HISTORY_BRANDS) {
    throw new Error(
      `Pending-purchase vendor history requires ${historyBrands.length} brands (limit ${MAX_HISTORY_BRANDS}). Split the packet.`,
    )
  }

  const historyResult = await db.query<CategoryObservationRow>(
    `with requested_brands as (
       select "brandName" as brand_name
         from jsonb_to_recordset($1::jsonb) as x("brandName" text)
     ), sampled as (
       select requested_brands.brand_name, observed.category_name
         from requested_brands
         cross join lateral (
           select source.category_name
             from (
               select l.category_name
                 from sweed_purchase_line_items l
                where l.brand_name = requested_brands.brand_name
                limit $2
             ) source
            where source.category_name is not null
              and btrim(source.category_name) <> ''
         ) observed
     )
     select brand_name, category_name, count(*)::int as observation_count
       from sampled
      group by brand_name, category_name
      order by lower(brand_name), lower(category_name)`,
    [JSON.stringify(historyBrands.map((brandName) => ({ brandName }))), MAX_HISTORY_LINES_PER_BRAND],
  )
  return inferPendingPurchaseVendorEvidence({
    rows,
    associations,
    manifestLines,
    categoryObservations: historyResult.rows.map((observation) => ({
      brandName: observation.brand_name,
      categoryName: observation.category_name,
      count: Number(observation.observation_count),
    })),
  })
}
