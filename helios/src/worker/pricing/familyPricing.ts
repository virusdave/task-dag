import type { QueryResultRow } from 'pg'

import {
  PRICING_POST_TAX_MULTIPLIER,
  PRICING_TARGET_MAX_GM_PERCENT,
  PRICING_TARGET_MIN_GM_PERCENT,
} from '../../shared/domain/pricingGeneration.js'
import { getPool } from '../../server/db/pool.js'
import {
  NormalizedCatalogGroupLiveStateSchema,
  type NormalizedCatalogGroupLiveState,
  type NormalizedCatalogProductLiveState,
} from '../catalog/liveState.js'

const FAMILY_PRICING_DENY_BRANDS = new Set(['dank', 'leal'])
const FAMILY_PRICE_CLUSTER_EPSILON = 0.5

interface CandidateCatalogGroupRow extends QueryResultRow {
  group_name: string
  id: number
  live_state_json: unknown
}

interface FamilyAnchorCandidate {
  groupId: number
  groupName: string
  price: number
  productId: number
  productName: string
  tab: string
}

export interface ProductPricingFamilyEvidence {
  anchorPrice: number
  candidateCount: number
  laneLabel: string
  note: string
  sourceGroupId: number
  sourceGroupName: string
  sourceProductId: number
  sourceProductName: string
  sourceTab: string
}

export interface PricingFamilyContext {
  note: string | null
  preference: 'allow' | 'deny' | 'none'
  productEvidenceById: Record<number, ProductPricingFamilyEvidence>
}

export async function buildPricingFamilyContext(
  liveState: NormalizedCatalogGroupLiveState,
): Promise<PricingFamilyContext> {
  const deniedContext = buildExplicitDenyContext(liveState.brand)
  if (deniedContext) {
    return deniedContext
  }

  if (!liveState.brand || !liveState.category) {
    return {
      note: 'Family pricing inference is unavailable because the live group is missing a brand or category.',
      preference: 'none',
      productEvidenceById: {},
    }
  }

  const result = await getPool().query<CandidateCatalogGroupRow>(
    `
      select id, group_name, live_state_json
      from catalog_groups
      where deleted_at is null
        and brand_name = $1
        and category_name is not distinct from $2
    `,
    [liveState.brand, liveState.category],
  )

  const candidateStates = result.rows.flatMap((row) => {
    try {
      const parsedLiveState = NormalizedCatalogGroupLiveStateSchema.parse(row.live_state_json)
      if (parsedLiveState.groupId === liveState.groupId) {
        return []
      }
      return [{
        groupId: row.id,
        groupName: row.group_name,
        liveState: parsedLiveState,
      }]
    } catch {
      return []
    }
  })

  return derivePricingFamilyContext(liveState, candidateStates)
}

export function derivePricingFamilyContext(
  liveState: NormalizedCatalogGroupLiveState,
  candidateStates: Array<{
    groupId: number
    groupName: string
    liveState: NormalizedCatalogGroupLiveState
  }>,
): PricingFamilyContext {
  const deniedContext = buildExplicitDenyContext(liveState.brand)
  if (deniedContext) {
    return deniedContext
  }

  if (!liveState.brand || !liveState.category) {
    return {
      note: 'Family pricing inference is unavailable because the live group is missing a brand or category.',
      preference: 'none',
      productEvidenceById: {},
    }
  }

  const candidatesByLane = new Map<string, FamilyAnchorCandidate[]>()

  for (const candidateState of candidateStates) {
    for (const candidateProduct of candidateState.liveState.products) {
      if (!isUsableFamilyAnchor(candidateProduct)) {
        continue
      }
      const candidatePrice = candidateProduct.price
      if (candidatePrice === null) {
        continue
      }

      const lane = buildFamilyLane(candidateState.liveState, candidateProduct)
      const existing = candidatesByLane.get(lane.key)
      const anchorCandidate: FamilyAnchorCandidate = {
        groupId: candidateState.groupId,
        groupName: candidateState.groupName,
        price: candidatePrice,
        productId: candidateProduct.productId,
        productName: candidateProduct.name,
        tab: candidateProduct.tab,
      }
      if (existing) {
        existing.push(anchorCandidate)
      } else {
        candidatesByLane.set(lane.key, [anchorCandidate])
      }
    }
  }

  const productEvidenceById: Record<number, ProductPricingFamilyEvidence> = {}
  for (const product of liveState.products) {
    const lane = buildFamilyLane(liveState, product)
    const evidence = buildProductFamilyEvidence(lane.label, candidatesByLane.get(lane.key) ?? [])
    if (evidence) {
      productEvidenceById[product.productId] = evidence
    }
  }

  const evidenceCount = Object.keys(productEvidenceById).length
  if (evidenceCount === 0) {
    return {
      note: `Current live ${liveState.brand} pricing does not show a strong same-lane family anchor for this pricing family, so Helios falls back to market or GM-band pricing instead.`,
      preference: 'none',
      productEvidenceById,
    }
  }

  return {
    note: `Current live ${liveState.brand} pricing shows a reusable same-lane family anchor for ${evidenceCount} SKU${evidenceCount === 1 ? '' : 's'}, so Helios can hold that shared family price when near/mid market evidence is thin.`,
    preference: 'allow',
    productEvidenceById,
  }
}

function buildExplicitDenyContext(brand: string | null): PricingFamilyContext | null {
  const brandKey = normalizePricingKey(brand)
  if (!brandKey || !FAMILY_PRICING_DENY_BRANDS.has(brandKey)) {
    return null
  }

  return {
    note: `${brand} is explicitly excluded from family pricing.`,
    preference: 'deny',
    productEvidenceById: {},
  }
}

function buildProductFamilyEvidence(
  laneLabel: string,
  candidates: FamilyAnchorCandidate[],
): ProductPricingFamilyEvidence | null {
  if (candidates.length < 2) {
    return null
  }

  const pricesByExactValue = new Map<string, FamilyAnchorCandidate[]>()
  for (const candidate of candidates) {
    const priceKey = candidate.price.toFixed(2)
    const existing = pricesByExactValue.get(priceKey)
    if (existing) {
      existing.push(candidate)
    } else {
      pricesByExactValue.set(priceKey, [candidate])
    }
  }

  const exactClusters = Array.from(pricesByExactValue.values()).sort(compareCandidateClusters)
  const exactCluster = exactClusters[0] ?? []
  if (exactCluster.length >= 2) {
    const anchor = chooseAnchorCandidate(exactCluster)
    return {
      anchorPrice: anchor.price,
      candidateCount: exactCluster.length,
      laneLabel,
      note: `${exactCluster.length} live same-brand ${laneLabel} rows already sit at ${formatMoney(anchor.price)}, so Helios keeps this family lane aligned when near/mid comps are unavailable.`,
      sourceGroupId: anchor.groupId,
      sourceGroupName: anchor.groupName,
      sourceProductId: anchor.productId,
      sourceProductName: anchor.productName,
      sourceTab: anchor.tab,
    }
  }

  const sortedCandidates = [...candidates].sort((left, right) => left.price - right.price)
  const medianPrice = sortedCandidates[Math.floor(sortedCandidates.length / 2)]?.price ?? null
  if (medianPrice === null) {
    return null
  }

  const clusteredCandidates = sortedCandidates.filter((candidate) => Math.abs(candidate.price - medianPrice) <= FAMILY_PRICE_CLUSTER_EPSILON)
  if (clusteredCandidates.length < 2) {
    return null
  }

  const anchor = chooseAnchorCandidate(clusteredCandidates)
  return {
    anchorPrice: anchor.price,
    candidateCount: clusteredCandidates.length,
    laneLabel,
    note: `${clusteredCandidates.length} live same-brand ${laneLabel} rows cluster around ${formatMoney(anchor.price)}, so Helios treats that as the current family anchor when near/mid comps are unavailable.`,
    sourceGroupId: anchor.groupId,
    sourceGroupName: anchor.groupName,
    sourceProductId: anchor.productId,
    sourceProductName: anchor.productName,
    sourceTab: anchor.tab,
  }
}

function chooseAnchorCandidate(candidates: FamilyAnchorCandidate[]): FamilyAnchorCandidate {
  return [...candidates].sort((left, right) => {
    if (left.price !== right.price) {
      return left.price - right.price
    }
    if (left.groupName !== right.groupName) {
      return left.groupName.localeCompare(right.groupName)
    }
    if (left.productName !== right.productName) {
      return left.productName.localeCompare(right.productName)
    }
    return left.productId - right.productId
  })[0] as FamilyAnchorCandidate
}

function compareCandidateClusters(left: FamilyAnchorCandidate[], right: FamilyAnchorCandidate[]): number {
  if (left.length !== right.length) {
    return right.length - left.length
  }
  const leftPrice = chooseAnchorCandidate(left).price
  const rightPrice = chooseAnchorCandidate(right).price
  return leftPrice - rightPrice
}

function buildFamilyLane(
  liveState: NormalizedCatalogGroupLiveState,
  product: NormalizedCatalogProductLiveState,
): { key: string; label: string } {
  const categoryKey = normalizePricingKey(liveState.category) || 'uncategorized'
  const laneKey = inferFamilyLaneKey(liveState, product)
  const variantKey = normalizePricingKey(product.tab) || 'unknown-size'
  const laneLabel = [inferFamilyLaneLabel(liveState, product), product.tab].filter((value) => value.length > 0).join(' · ')

  return {
    key: `${categoryKey}|${laneKey}|${variantKey}`,
    label: laneLabel || product.tab,
  }
}

function inferFamilyLaneLabel(
  liveState: NormalizedCatalogGroupLiveState,
  product: NormalizedCatalogProductLiveState,
): string {
  const inferred = inferFamilyLaneKey(liveState, product)
    .split('|')
    .map((part) => part.replace(/-/g, ' '))
    .join(' ')
    .trim()

  return inferred.length > 0 ? inferred : normalizeInlineText(liveState.subcategory) || normalizeInlineText(liveState.category)
}

function inferFamilyLaneKey(
  liveState: NormalizedCatalogGroupLiveState,
  product: NormalizedCatalogProductLiveState,
): string {
  const categoryKey = normalizePricingKey(liveState.category)
  const subcategoryKey = normalizePricingKey(liveState.subcategory)
  const combinedText = normalizePricingKey(`${liveState.groupFullName} ${product.name} ${product.tab}`)

  if (categoryKey === 'vapes' || categoryKey === 'vaporizers') {
    const deviceKey = subcategoryKey?.includes('disposable') || combinedText.includes('disposable') || combinedText.includes('all in one') || combinedText.includes('aio')
      ? 'disposable'
      : subcategoryKey?.includes('pod') || combinedText.includes('pod')
        ? 'pod'
        : subcategoryKey?.includes('cartridge') || combinedText.includes('cartridge') || combinedText.includes('cart') || combinedText.includes('510')
          ? 'cartridge'
          : 'vape'
    const extractKey = combinedText.includes('live rosin') || combinedText.includes('solventless')
      ? 'live-rosin'
      : combinedText.includes('live resin')
        ? 'live-resin'
        : combinedText.includes('liquid diamonds')
          ? 'liquid-diamonds'
          : 'standard'
    return `${deviceKey}|${extractKey}`
  }

  if (categoryKey === 'pre rolls' || categoryKey === 'prerolls') {
    const prerollLane = combinedText.includes('infused') || combinedText.includes('hash hole') || combinedText.includes('hash-hole')
      ? 'infused'
      : 'standard'
    return subcategoryKey ? `${subcategoryKey}|${prerollLane}` : prerollLane
  }

  return subcategoryKey || 'default'
}

function normalizePricingKey(value: string | null | undefined): string {
  return normalizeInlineText(value)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function normalizeInlineText(value: string | null | undefined): string {
  return String(value ?? '')
    .split(/\s+/)
    .filter((part) => part.length > 0)
    .join(' ')
    .trim()
}

function formatMoney(value: number): string {
  return `$${value.toFixed(2)}`
}

function gmPercent(cost: number, price: number): number {
  return Math.round((1 - (PRICING_POST_TAX_MULTIPLIER * cost) / price) * 10000) / 100
}

export function isUsableFamilyAnchor(product: NormalizedCatalogProductLiveState): boolean {
  if (product.price === null || product.price <= 0) {
    return false
  }
  if (product.wholesaleCost === null || product.wholesaleCost <= 0) {
    return true
  }

  const grossMarginPercent = gmPercent(product.wholesaleCost, product.price)
  return grossMarginPercent >= PRICING_TARGET_MIN_GM_PERCENT && grossMarginPercent <= PRICING_TARGET_MAX_GM_PERCENT
}
