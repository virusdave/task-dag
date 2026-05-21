// Server-side cost-basis collector for the white-label bulk-flower
// pricing editor. Scans Midtown + Bronx grouped inventory via Sweed,
// keeps every {brand, strain} flower SKU with pack size ≥ 14 g,
// picks the most-recent lot whose wholesaleCost ≥ $1 as the per-gram
// basis, and imputes a per-gram cost for catalogued SKUs whose only
// observed lots are trade samples / data-entry placeholders. The
// imputation rule is brand-scoped and non-recursive: a no-cost SKU
// inherits the average $/g of its sibling SKUs (same brand) that
// DO have an observed valid lot. If a brand has no valid peer the
// row is left unresolved (perGram=null) — it is surfaced in the
// editor as "no cost / no peer" and cannot be auto-priced.

import {
  CostBasisRefreshResponseSchema,
  WHITELABEL_MIN_COST_USD,
  WHITELABEL_MIN_PACK_GRAMS,
  WHITELABEL_SIZES,
  WHITELABEL_TAX_MULT,
  type CostBasisItem,
  type CostBasisRefreshResponse,
} from '../../shared/contracts/index.js'
import { callSweedRpcRaw } from '../../worker/sweed/rpc.js'
import { withSweedSession } from '../../worker/sweed/session.js'

interface SiteScope {
  readonly dealerId: number
  readonly label: string
}

const SITES: readonly SiteScope[] = [
  { dealerId: 210705, label: 'Midtown' },
  { dealerId: 210249, label: 'Bronx' },
]

const PAGE_SIZE = 200

interface GroupedInventoryRow {
  product?: { id?: unknown; name?: unknown; shortName?: unknown }
  productBrand?: { id?: unknown; name?: unknown } | null
  category?: { id?: unknown; name?: unknown } | null
  subcategory?: { id?: unknown; name?: unknown } | null
  items?: Array<{
    dateTimeReceived?: unknown
    wholesaleCost?: unknown
    availableQty?: unknown
    currentQty?: unknown
  }>
}

interface GroupedInventoryResponse {
  data?: GroupedInventoryRow[]
  totalCount?: number
}

interface LotEvidence {
  site: string
  productId: number
  productName: string
  brandName: string
  packLabel: string
  packGrams: number
  strainKey: string
  strainDisplay: string
  receivedAt: string
  wholesaleCost: number
  perGram: number
}

interface NoCostRow {
  site: string
  productId: number
  productName: string
  brandName: string
  packGrams: number
  packLabel: string
  strainKey: string
  strainDisplay: string
  lotCount: number
  lotCostsObserved: number[]
  latestReceivedAt: string | null
}

function parsePackWeight(productName: string): { grams: number | null; label: string | null } {
  const trimmed = productName.trim()
  const lbMatch = trimmed.match(/(?:^|\s)((\d+(?:\.\d+)?|\d+\/\d+)\s*(?:lb|lbs|pound|pounds))$/i)
  if (lbMatch) return { grams: fractionOrFloat(lbMatch[2]) * 453.592, label: lbMatch[1] }
  const ozMatch = trimmed.match(/(?:^|\s)((\d+(?:\.\d+)?|\d+\/\d+)\s*(?:oz|ounce|ounces))$/i)
  if (ozMatch) return { grams: fractionOrFloat(ozMatch[2]) * 28.3495, label: ozMatch[1] }
  const gMatch = trimmed.match(/(?:^|\s)((\d+(?:\.\d+)?)\s*(?:g|gr|gram|grams))$/i)
  if (gMatch) {
    const grams = Number(gMatch[2])
    return { grams: Number.isFinite(grams) ? grams : null, label: gMatch[1] }
  }
  return { grams: null, label: null }
}

function fractionOrFloat(token: string): number {
  if (token.includes('/')) {
    const [a, b] = token.split('/').map((x) => Number(x))
    if (Number.isFinite(a) && Number.isFinite(b) && b !== 0) return a / b
  }
  const n = Number(token)
  return Number.isFinite(n) ? n : NaN
}

function stripPackWeight(productName: string, label: string | null): string {
  if (!label) return productName
  const idx = productName.toLowerCase().indexOf(label.toLowerCase())
  let cleaned = productName
  if (idx >= 0) cleaned = productName.slice(0, idx) + productName.slice(idx + label.length)
  return cleaned.replace(/[\s\-_,]+/g, ' ').replace(/\s+/g, ' ').trim()
}

function isFlower(categoryName: string | null): boolean {
  if (!categoryName) return false
  const c = categoryName.toLowerCase()
  return c === 'flower' || c.startsWith('flower')
}

function asString(v: unknown): string | null {
  if (v === null || v === undefined) return null
  const s = String(v).trim()
  return s.length === 0 ? null : s
}

function asNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

async function pullGroupedInventory(site: SiteScope): Promise<{ evidence: LotEvidence[]; noCost: NoCostRow[] }> {
  const dealerSet = await callSweedRpcRaw<{ user?: { currentDealerId?: unknown } }>(
    'store.auth.dealer.set',
    { dealerId: site.dealerId },
  )
  if (Number(dealerSet.user?.currentDealerId) !== site.dealerId) {
    throw new Error(`[whitelabel-cost-basis] dealer.set mismatch: expected ${site.dealerId}, got ${dealerSet.user?.currentDealerId}`)
  }
  const probe = await callSweedRpcRaw<{ user?: { currentDealerId?: unknown } }>(
    'store.auth.initial.data.get',
  )
  if (Number(probe.user?.currentDealerId) !== site.dealerId) {
    throw new Error(`[whitelabel-cost-basis] initial.data.get confirm failed for ${site.label}`)
  }

  const evidence: LotEvidence[] = []
  const noCost: NoCostRow[] = []
  let page = 1
  let totalCount: number | null = null
  let scannedRows = 0
  while (true) {
    const resp = await callSweedRpcRaw<GroupedInventoryResponse>('store.inventory.item.list.grouped', {
      page,
      pageSize: PAGE_SIZE,
    })
    if (totalCount === null && typeof resp.totalCount === 'number') totalCount = resp.totalCount
    const rows = resp.data ?? []
    scannedRows += rows.length
    for (const row of rows) {
      const product = row.product ?? {}
      const productName = asString(product.name) ?? asString(product.shortName)
      const productId = asNumber(product.id)
      if (!productName || productId === null) continue
      const categoryName = asString(row.category?.name ?? null)
      if (!isFlower(categoryName)) continue
      const parse = parsePackWeight(productName)
      if (parse.grams === null || parse.grams < WHITELABEL_MIN_PACK_GRAMS - 0.01) continue
      const brand = asString(row.productBrand?.name ?? null) ?? '(no brand)'
      const strainDisplay = stripPackWeight(productName, parse.label)
      const strainKey = strainDisplay.toLowerCase()
      const lots = row.items ?? []
      let acceptedCount = 0
      const allCosts: number[] = []
      let latestReceived: string | null = null
      for (const lot of lots) {
        const receivedAt = asString(lot.dateTimeReceived)
        if (!receivedAt) continue
        if (latestReceived === null || receivedAt > latestReceived) latestReceived = receivedAt
        const cost = asNumber(lot.wholesaleCost)
        if (cost !== null) allCosts.push(cost)
        if (cost === null || cost < WHITELABEL_MIN_COST_USD) continue
        acceptedCount += 1
        evidence.push({
          site: site.label,
          productId,
          productName,
          brandName: brand,
          packLabel: parse.label ?? `${parse.grams}g`,
          packGrams: parse.grams,
          strainKey,
          strainDisplay,
          receivedAt,
          wholesaleCost: cost,
          perGram: cost / parse.grams,
        })
      }
      if (acceptedCount === 0) {
        noCost.push({
          site: site.label,
          productId,
          productName,
          brandName: brand,
          packGrams: parse.grams,
          packLabel: parse.label ?? `${parse.grams}g`,
          strainKey,
          strainDisplay,
          lotCount: lots.length,
          lotCostsObserved: allCosts,
          latestReceivedAt: latestReceived,
        })
      }
    }
    if (rows.length < PAGE_SIZE) break
    page += 1
    if (page > 200) break
  }
  if (totalCount !== null && scannedRows !== totalCount) {
    throw new Error(`[whitelabel-cost-basis] [${site.label}] paging incomplete: ${scannedRows}/${totalCount}`)
  }
  return { evidence, noCost }
}

function buildItemsFromEvidence(
  evidence: LotEvidence[],
  noCost: NoCostRow[],
): CostBasisItem[] {
  // 1) Group observed-cost evidence by {brand, strainKey}.
  const observedByKey = new Map<string, LotEvidence[]>()
  for (const e of evidence) {
    const k = `${e.brandName.toLowerCase()}||${e.strainKey}`
    const arr = observedByKey.get(k)
    if (arr) arr.push(e)
    else observedByKey.set(k, [e])
  }

  // 2) Group no-cost rows by {brand, strainKey} too (de-dupe across sites).
  const noCostByKey = new Map<string, NoCostRow[]>()
  for (const n of noCost) {
    const k = `${n.brandName.toLowerCase()}||${n.strainKey}`
    if (observedByKey.has(k)) continue
    const arr = noCostByKey.get(k)
    if (arr) arr.push(n)
    else noCostByKey.set(k, [n])
  }

  // 3) Brand-average per-gram from observed-cost rows only (non-recursive).
  const brandAverages = new Map<string, { sum: number; n: number; peerStrains: Set<string> }>()
  for (const [, lots] of observedByKey) {
    const sorted = [...lots].sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))
    const best = sorted[0]
    const brandKey = best.brandName.toLowerCase()
    const bucket = brandAverages.get(brandKey) ?? { sum: 0, n: 0, peerStrains: new Set<string>() }
    bucket.sum += best.perGram
    bucket.n += 1
    bucket.peerStrains.add(best.strainDisplay)
    brandAverages.set(brandKey, bucket)
  }

  const items: CostBasisItem[] = []

  for (const [, lots] of observedByKey) {
    const sorted = [...lots].sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))
    const best = sorted[0]
    items.push({
      brand: best.brandName,
      strainShort: best.strainDisplay
        .replace(new RegExp(`^${escapeRegex(best.brandName)}\\s+`, 'i'), '')
        .trim() || best.strainDisplay,
      strainDisplay: best.strainDisplay,
      sites: Array.from(new Set(lots.map((l) => l.site))).sort(),
      perGram: best.perGram,
      imputed: false,
      imputationSource: null,
      best: {
        packGrams: best.packGrams,
        packLabel: best.packLabel,
        wholesaleCost: best.wholesaleCost,
        perGram: best.perGram,
        receivedAt: best.receivedAt,
        site: best.site,
      },
      totalLots: lots.length,
      lots: sorted.map((l) => ({
        site: l.site,
        packGrams: l.packGrams,
        packLabel: l.packLabel,
        wholesaleCost: l.wholesaleCost,
        perGram: l.perGram,
        receivedAt: l.receivedAt,
      })),
      observedLotCosts: sorted.map((l) => l.wholesaleCost),
    })
  }

  for (const [, rows] of noCostByKey) {
    const first = rows[0]
    const brandKey = first.brandName.toLowerCase()
    const peers = brandAverages.get(brandKey)
    const sitesSet = new Set(rows.map((r) => r.site))
    if (peers && peers.n > 0) {
      const imputedPerGram = peers.sum / peers.n
      items.push({
        brand: first.brandName,
        strainShort: first.strainDisplay
          .replace(new RegExp(`^${escapeRegex(first.brandName)}\\s+`, 'i'), '')
          .trim() || first.strainDisplay,
        strainDisplay: first.strainDisplay,
        sites: Array.from(sitesSet).sort(),
        perGram: imputedPerGram,
        imputed: true,
        imputationSource: {
          kind: 'brand-average',
          peerCount: peers.n,
          peerStrains: Array.from(peers.peerStrains).sort(),
        },
        best: null,
        totalLots: 0,
        lots: [],
        observedLotCosts: rows.flatMap((r) => r.lotCostsObserved),
      })
    } else {
      items.push({
        brand: first.brandName,
        strainShort: first.strainDisplay
          .replace(new RegExp(`^${escapeRegex(first.brandName)}\\s+`, 'i'), '')
          .trim() || first.strainDisplay,
        strainDisplay: first.strainDisplay,
        sites: Array.from(sitesSet).sort(),
        perGram: null,
        imputed: false,
        imputationSource: null,
        best: null,
        totalLots: 0,
        lots: [],
        observedLotCosts: rows.flatMap((r) => r.lotCostsObserved),
      })
    }
  }

  items.sort((a, b) => {
    if (a.brand.toLowerCase() !== b.brand.toLowerCase())
      return a.brand.toLowerCase().localeCompare(b.brand.toLowerCase())
    return a.strainDisplay.toLowerCase().localeCompare(b.strainDisplay.toLowerCase())
  })

  return items
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export async function collectFlowerCostBasis(): Promise<CostBasisRefreshResponse> {
  const generatedAt = new Date().toISOString()
  const allEvidence: LotEvidence[] = []
  const allNoCost: NoCostRow[] = []
  await withSweedSession(async () => {
    for (const site of SITES) {
      const r = await pullGroupedInventory(site)
      allEvidence.push(...r.evidence)
      allNoCost.push(...r.noCost)
    }
  })
  const items = buildItemsFromEvidence(allEvidence, allNoCost)
  return CostBasisRefreshResponseSchema.parse({
    generatedAt,
    minPackGrams: WHITELABEL_MIN_PACK_GRAMS,
    minCostUsd: WHITELABEL_MIN_COST_USD,
    taxMult: WHITELABEL_TAX_MULT,
    defaultGmBySize: {
      quarterLb: WHITELABEL_SIZES[0].defaultGm,
      halfLb: WHITELABEL_SIZES[1].defaultGm,
      lb: WHITELABEL_SIZES[2].defaultGm,
    },
    items,
  })
}
