import type { ValidationIssue } from '../../shared/contracts/index.js'
import {
  PRICING_BELOW_MARKET_TARGET_MULTIPLIER,
  PRICING_FALLBACK_TARGET_GM_PERCENT,
  PRICING_FAR_DISTANCE_MAX_MILES,
  PRICING_GM_FORMULA,
  PRICING_MID_DISTANCE_MAX_MILES,
  PRICING_NEAR_DISTANCE_MAX_MILES,
  PRICING_POST_TAX_MULTIPLIER,
  PRICING_PREFERRED_ENDING_POLICY,
  PRICING_TARGET_MAX_GM_PERCENT,
  PRICING_TARGET_MIN_GM_PERCENT,
} from '../../shared/domain/pricingGeneration.js'
import type { NormalizedCatalogGroupLiveState } from '../catalog/liveState.js'
import type { PricingFamilyContext, ProductPricingFamilyEvidence } from './familyPricing.js'

const PRICE_EPSILON = 0.009
const QUARTER_INCREMENT = 0.25

export type PricingDistanceBand = 'far' | 'mid' | 'near' | 'unknown' | 'very_far'

export interface ProductPricingMarketEvidence {
  averagePostTaxPrice: number | null
  averagePreTaxPrice: number | null
  dispensaryCount: number
  farAveragePostTaxPrice: number | null
  farAveragePreTaxPrice: number | null
  farListingCount: number
  listingCount: number
  medianPostTaxPrice: number | null
  medianPreTaxPrice: number | null
  pricingEligibleDispensaryCount: number
  pricingEligibleListingCount: number
  matchedListings: Array<{
    category: string | null
    distanceBand: PricingDistanceBand
    distanceMiles: number | null
    dispensaryName: string
    eligibleForPricing: boolean
    exclusionReason: string | null
    listingName: string
    matchTier: 'exact' | 'fallback' | 'weak'
    postTaxPrice: number
    preTaxPrice: number
    source: 'nearby' | 'statewide'
    url: string | null
  }>
  searchTerm: string
  source: 'mixed' | 'nearby' | 'statewide' | null
}

export interface PricingMarketContext {
  availability: 'disabled' | 'display_only' | 'error' | 'matched' | 'no_brand' | 'no_family_matches' | 'no_safe_matches' | 'unresolved_brand'
  note: string | null
  productEvidenceById: Record<number, ProductPricingMarketEvidence>
  searchTerm: string | null
}

export interface GeneratedPricingLineItem {
  action: 'keep-price' | 'lower-price' | 'raise-price' | 'set-price'
  baselinePrice: number | null
  currentGmPercent: number | null
  familyPricingEvidence: ProductPricingFamilyEvidence | null
  marketEvidence: ProductPricingMarketEvidence | null
  priceReason: string
  productId: number
  productName: string
  proposedGmPercent: number | null
  proposedPrice: number
  tab: string
  validationIssues: ValidationIssue[]
  wholesaleCost: number
}

export interface SkippedPricingProduct {
  currentPrice: number | null
  marketEvidence: ProductPricingMarketEvidence | null
  productId: number
  productName: string
  reason: string
  tab: string
  wholesaleCost: number | null
}

export interface GeneratedPricingPlan {
  familyContext: PricingFamilyContext | null
  generatedLineItems: GeneratedPricingLineItem[]
  marketContext: PricingMarketContext | null
  skippedProducts: SkippedPricingProduct[]
}

export function buildPricingMerchandisingContext(
  liveState: NormalizedCatalogGroupLiveState,
  marketContext: PricingMarketContext | null = null,
  familyContext: PricingFamilyContext | null = null,
) {
  return {
    brand: liveState.brand,
    category: liveState.category,
    currentDescription: liveState.currentDescription,
    familyPricingContext: familyContext
      ? {
          note: familyContext.note,
          preference: familyContext.preference,
          products: Object.entries(familyContext.productEvidenceById).map(([productId, evidence]) => ({
            anchorPrice: evidence.anchorPrice,
            candidateCount: evidence.candidateCount,
            laneLabel: evidence.laneLabel,
            note: evidence.note,
            productId: Number(productId),
            sourceGroupId: evidence.sourceGroupId,
            sourceGroupName: evidence.sourceGroupName,
            sourceProductId: evidence.sourceProductId,
            sourceProductName: evidence.sourceProductName,
            sourceTab: evidence.sourceTab,
          })),
        }
      : null,
    marketContext: marketContext
      ? {
          availability: marketContext.availability,
          note: marketContext.note,
          products: Object.entries(marketContext.productEvidenceById).map(([productId, evidence]) => ({
            averageCompetitorPostTaxPrice: evidence.averagePostTaxPrice,
            averageCompetitorPreTaxPrice: evidence.averagePreTaxPrice,
            dispensaryCount: evidence.dispensaryCount,
            farAverageCompetitorPostTaxPrice: evidence.farAveragePostTaxPrice,
            farAverageCompetitorPreTaxPrice: evidence.farAveragePreTaxPrice,
            farListingCount: evidence.farListingCount,
            listingCount: evidence.listingCount,
            medianCompetitorPostTaxPrice: evidence.medianPostTaxPrice,
            medianCompetitorPreTaxPrice: evidence.medianPreTaxPrice,
            pricingEligibleDispensaryCount: evidence.pricingEligibleDispensaryCount,
            pricingEligibleListingCount: evidence.pricingEligibleListingCount,
            productId: Number(productId),
            searchTerm: evidence.searchTerm,
            source: evidence.source,
          })),
          searchTerm: marketContext.searchTerm,
        }
      : null,
    productTabs: liveState.productTabs,
    products: liveState.products.map((product) => ({
      gmPercent: product.gmPercent,
      marketEvidence: marketContext?.productEvidenceById[product.productId]
        ? {
            averageCompetitorPostTaxPrice: marketContext.productEvidenceById[product.productId].averagePostTaxPrice,
            averageCompetitorPreTaxPrice: marketContext.productEvidenceById[product.productId].averagePreTaxPrice,
            dispensaryCount: marketContext.productEvidenceById[product.productId].dispensaryCount,
            farAverageCompetitorPostTaxPrice: marketContext.productEvidenceById[product.productId].farAveragePostTaxPrice,
            farAverageCompetitorPreTaxPrice: marketContext.productEvidenceById[product.productId].farAveragePreTaxPrice,
            farListingCount: marketContext.productEvidenceById[product.productId].farListingCount,
            listingCount: marketContext.productEvidenceById[product.productId].listingCount,
            medianCompetitorPostTaxPrice: marketContext.productEvidenceById[product.productId].medianPostTaxPrice,
            medianCompetitorPreTaxPrice: marketContext.productEvidenceById[product.productId].medianPreTaxPrice,
            pricingEligibleDispensaryCount: marketContext.productEvidenceById[product.productId].pricingEligibleDispensaryCount,
            pricingEligibleListingCount: marketContext.productEvidenceById[product.productId].pricingEligibleListingCount,
            source: marketContext.productEvidenceById[product.productId].source,
          }
        : null,
      name: product.name,
      price: product.price,
      productId: product.productId,
      tab: product.tab,
      wholesaleCost: product.wholesaleCost,
    })),
    subcategory: liveState.subcategory,
  }
}

export function buildPricingPlan(
  liveState: NormalizedCatalogGroupLiveState,
  marketContext: PricingMarketContext | null = null,
  familyContext: PricingFamilyContext | null = null,
): GeneratedPricingPlan {
  const generatedLineItems: GeneratedPricingLineItem[] = []
  const skippedProducts: SkippedPricingProduct[] = []

  for (const product of liveState.products) {
    const familyPricingEvidence = familyContext?.productEvidenceById[product.productId] ?? null
    const marketEvidence = marketContext?.productEvidenceById[product.productId] ?? null
    if (product.wholesaleCost === null || product.wholesaleCost <= 0) {
      skippedProducts.push({
        currentPrice: product.price,
        marketEvidence,
        productId: product.productId,
        productName: product.name,
        reason: 'Skipped because there is no usable wholesale cost in the persisted live snapshot.',
        tab: product.tab,
        wholesaleCost: product.wholesaleCost,
      })
      continue
    }

    const minimumPrice = minimumPriceForGm(product.wholesaleCost, PRICING_TARGET_MIN_GM_PERCENT)
    const maximumPrice = maximumPriceForGm(product.wholesaleCost, PRICING_TARGET_MAX_GM_PERCENT)

    if (minimumPrice > maximumPrice + PRICE_EPSILON) {
      skippedProducts.push({
        currentPrice: product.price,
        marketEvidence,
        productId: product.productId,
        productName: product.name,
        reason: 'Skipped because the current wholesale cost does not yield a valid target margin band.',
        tab: product.tab,
        wholesaleCost: product.wholesaleCost,
      })
      continue
    }

    if (product.price === null || product.price <= 0) {
      const proposedPrice = chooseProposedPrice(minimumPrice, maximumPrice, marketEvidence, familyPricingEvidence)
      generatedLineItems.push({
        action: 'set-price',
        baselinePrice: product.price,
        currentGmPercent: null,
        familyPricingEvidence,
        marketEvidence,
        priceReason: buildGeneratedPriceReason({
          action: 'set-price',
          currentGmPercent: null,
          familyContext,
          familyPricingEvidence,
          marketEvidence,
          maximumPrice,
          minimumPrice,
          product,
          proposedPrice,
        }),
        productId: product.productId,
        productName: product.name,
        proposedGmPercent: gmPercent(product.wholesaleCost, proposedPrice),
        proposedPrice,
        tab: product.tab,
        validationIssues: [],
        wholesaleCost: product.wholesaleCost,
      })
      continue
    }

    const currentGmPercent = gmPercent(product.wholesaleCost, product.price)
    const proposedPrice = chooseProposedPrice(minimumPrice, maximumPrice, marketEvidence, familyPricingEvidence)
    generatedLineItems.push({
      action: determineGeneratedAction(product.price, proposedPrice),
      baselinePrice: product.price,
      currentGmPercent,
      familyPricingEvidence,
      marketEvidence,
      priceReason: buildGeneratedPriceReason({
        action: determineGeneratedAction(product.price, proposedPrice),
        currentGmPercent,
        familyContext,
        familyPricingEvidence,
        marketEvidence,
        maximumPrice,
        minimumPrice,
        product,
        proposedPrice,
      }),
      productId: product.productId,
      productName: product.name,
      proposedGmPercent: gmPercent(product.wholesaleCost, proposedPrice),
      proposedPrice,
      tab: product.tab,
      validationIssues: [],
      wholesaleCost: product.wholesaleCost,
    })
  }

  return { familyContext, generatedLineItems, marketContext, skippedProducts }
}

export function serializePricingPlan(plan: GeneratedPricingPlan) {
  return {
    generatedProducts: plan.generatedLineItems.map((lineItem) => ({
      action: lineItem.action,
      currentGmPercent: lineItem.currentGmPercent,
      currentPrice: lineItem.baselinePrice,
      familyPricingEvidence: lineItem.familyPricingEvidence,
      marketEvidence: lineItem.marketEvidence,
      priceReason: lineItem.priceReason,
      productId: lineItem.productId,
      productName: lineItem.productName,
      proposedGmPercent: lineItem.proposedGmPercent,
      proposedPrice: lineItem.proposedPrice,
      tab: lineItem.tab,
      validationIssues: lineItem.validationIssues,
      wholesaleCost: lineItem.wholesaleCost,
    })),
    pricingRules: {
      gmFormula: PRICING_GM_FORMULA,
      postTaxMultiplier: PRICING_POST_TAX_MULTIPLIER,
      preferredSnapPolicy: PRICING_PREFERRED_ENDING_POLICY,
      targetMaxPercent: PRICING_TARGET_MAX_GM_PERCENT,
      targetMinPercent: PRICING_TARGET_MIN_GM_PERCENT,
    },
    familyContext: plan.familyContext,
    marketContext: plan.marketContext,
    skippedProducts: plan.skippedProducts,
    summary: {
      generatedLineItemCount: plan.generatedLineItems.length,
      skippedProductCount: plan.skippedProducts.length,
    },
  }
}

export function formatPricingPlanText(
  liveState: NormalizedCatalogGroupLiveState,
  plan: GeneratedPricingPlan,
): string {
  const lines: string[] = [
    `${liveState.groupFullName}`,
    `Generated ${plan.generatedLineItems.length} pricing review rows.`,
    `Skipped ${plan.skippedProducts.length} products.`,
  ]

  if (plan.generatedLineItems.length > 0) {
    lines.push('', 'Generated products:')
    for (const lineItem of plan.generatedLineItems) {
      const marketEvidenceText = lineItem.marketEvidence
        ? lineItem.marketEvidence.averagePostTaxPrice === null
          ? lineItem.marketEvidence.farAveragePostTaxPrice === null
            ? ` display-only market pool with ${lineItem.marketEvidence.listingCount} listing${lineItem.marketEvidence.listingCount === 1 ? '' : 's'};`
            : ` far-only market pressure avg ${formatMoney(lineItem.marketEvidence.farAveragePostTaxPrice)} from ${lineItem.marketEvidence.farListingCount} far listing${lineItem.marketEvidence.farListingCount === 1 ? '' : 's'};`
          : ` market avg ${formatMoney(lineItem.marketEvidence.averagePostTaxPrice)} from ${lineItem.marketEvidence.pricingEligibleListingCount} near/mid listing${lineItem.marketEvidence.pricingEligibleListingCount === 1 ? '' : 's'};`
        : ''
      lines.push(
        `- ${lineItem.productName} [${lineItem.tab}] (#${lineItem.productId}): ` +
          `${lineItem.action} ${formatOptionalMoney(lineItem.baselinePrice)} -> $${formatMoney(lineItem.proposedPrice)} ` +
          `(GM ${formatOptionalPercent(lineItem.currentGmPercent)} -> ${formatOptionalPercent(lineItem.proposedGmPercent)}). ` +
          `${lineItem.priceReason}${marketEvidenceText}`,
      )
    }
  }

  if (plan.skippedProducts.length > 0) {
    lines.push('', 'Skipped products:')
    for (const product of plan.skippedProducts) {
      const marketEvidenceText = product.marketEvidence
        ? product.marketEvidence.averagePostTaxPrice === null
          ? product.marketEvidence.farAveragePostTaxPrice === null
            ? ` display-only market pool with ${product.marketEvidence.listingCount} listing${product.marketEvidence.listingCount === 1 ? '' : 's'}.`
            : ` far-only market pressure avg $${formatMoney(product.marketEvidence.farAveragePostTaxPrice)} from ${product.marketEvidence.farListingCount} far listing${product.marketEvidence.farListingCount === 1 ? '' : 's'}.`
          : ` market avg $${formatMoney(product.marketEvidence.averagePostTaxPrice)} from ${product.marketEvidence.pricingEligibleListingCount} near/mid listing${product.marketEvidence.pricingEligibleListingCount === 1 ? '' : 's'}.`
        : ''
      lines.push(
        `- ${product.productName} [${product.tab}] (#${product.productId}): ` +
          `price ${formatOptionalMoney(product.currentPrice)}, cost ${formatOptionalMoney(product.wholesaleCost)}. ${product.reason}${marketEvidenceText}`,
      )
    }
  }

  return lines.join('\n')
}

function gmPercent(cost: number, price: number): number {
  return roundPrice((1 - (PRICING_POST_TAX_MULTIPLIER * cost) / price) * 100)
}

function minimumPriceForGm(cost: number, gmPercentTarget: number): number {
  return roundUpToQuarter((PRICING_POST_TAX_MULTIPLIER * cost) / (1 - gmPercentTarget / 100))
}

function maximumPriceForGm(cost: number, gmPercentTarget: number): number {
  return roundDownToQuarter((PRICING_POST_TAX_MULTIPLIER * cost) / (1 - gmPercentTarget / 100))
}

function chooseProposedPrice(
  minimumPrice: number,
  maximumPrice: number,
  marketEvidence: ProductPricingMarketEvidence | null,
  familyPricingEvidence: ProductPricingFamilyEvidence | null,
): number {
  const marketAveragePostTaxPrice = marketEvidence?.averagePostTaxPrice ?? null
  if (marketAveragePostTaxPrice !== null) {
    const belowCompetitorTarget = choosePreferredBelowMarketPrice(marketAveragePostTaxPrice)
    if (belowCompetitorTarget < minimumPrice - PRICE_EPSILON) {
      return belowCompetitorTarget
    }
    if (belowCompetitorTarget > maximumPrice + PRICE_EPSILON) {
      return maximumPrice
    }
    return belowCompetitorTarget
  }

  const farAveragePostTaxPrice = marketEvidence?.farAveragePostTaxPrice ?? null
  if (farAveragePostTaxPrice !== null) {
    return clampPriceToManagedBand(choosePreferredBelowMarketPrice(farAveragePostTaxPrice), minimumPrice, maximumPrice)
  }

  if (familyPricingEvidence) {
    return clampPriceToManagedBand(familyPricingEvidence.anchorPrice, minimumPrice, maximumPrice)
  }

  return choosePreferredFallbackBandPrice(minimumPrice, maximumPrice)
}

function choosePreferredFallbackBandPrice(minimumPrice: number, maximumPrice: number): number {
  const fallbackTarget = fallbackPriceForGm(minimumPrice, maximumPrice)
  let bestCandidate = minimumPrice
  let bestDistance = Math.abs(bestCandidate - fallbackTarget)
  let bestPreferred = hasPreferredEnding(bestCandidate)

  for (let candidate = minimumPrice; candidate <= maximumPrice + PRICE_EPSILON; candidate = roundPrice(candidate + QUARTER_INCREMENT)) {
    const distance = Math.abs(candidate - fallbackTarget)
    const preferredEnding = hasPreferredEnding(candidate)
    if (distance < bestDistance - PRICE_EPSILON) {
      bestCandidate = candidate
      bestDistance = distance
      bestPreferred = preferredEnding
      continue
    }
    if (Math.abs(distance - bestDistance) <= PRICE_EPSILON && preferredEnding && !bestPreferred) {
      bestCandidate = candidate
      bestDistance = distance
      bestPreferred = true
      continue
    }
    if (
      Math.abs(distance - bestDistance) <= PRICE_EPSILON
      && preferredEnding === bestPreferred
      && candidate > bestCandidate
    ) {
      bestCandidate = candidate
      bestDistance = distance
      bestPreferred = preferredEnding
    }
  }

  return bestCandidate
}

function choosePreferredBelowMarketPrice(averagePostTaxPrice: number): number {
  const marketTarget = averagePostTaxPrice * PRICING_BELOW_MARKET_TARGET_MULTIPLIER
  const roundedTarget = roundDownToQuarter(marketTarget)
  if (hasPreferredEnding(roundedTarget)) {
    return roundedTarget
  }

  let fallback = roundedTarget
  for (let candidate = roundedTarget; candidate > PRICE_EPSILON; candidate = roundPrice(candidate - QUARTER_INCREMENT)) {
    if (hasPreferredEnding(candidate)) {
      return candidate
    }
    fallback = candidate
  }

  return fallback
}

function fallbackPriceForGm(minimumPrice: number, maximumPrice: number): number {
  const bandWidth = maximumPrice - minimumPrice
  const fallbackOffset = (PRICING_FALLBACK_TARGET_GM_PERCENT - PRICING_TARGET_MIN_GM_PERCENT)
    / (PRICING_TARGET_MAX_GM_PERCENT - PRICING_TARGET_MIN_GM_PERCENT)
  return roundPrice(minimumPrice + bandWidth * fallbackOffset)
}

function clampPriceToManagedBand(price: number, minimumPrice: number, maximumPrice: number): number {
  if (price < minimumPrice - PRICE_EPSILON) {
    return minimumPrice
  }
  if (price > maximumPrice + PRICE_EPSILON) {
    return maximumPrice
  }
  return roundPrice(price)
}

function buildGeneratedPriceReason(input: {
  action: 'keep-price' | 'lower-price' | 'raise-price' | 'set-price'
  currentGmPercent: number | null
  familyContext: PricingFamilyContext | null
  familyPricingEvidence: ProductPricingFamilyEvidence | null
  marketEvidence: ProductPricingMarketEvidence | null
  maximumPrice: number
  minimumPrice: number
  product: NormalizedCatalogGroupLiveState['products'][number]
  proposedPrice: number
}): string {
  const marketEvidence = input.marketEvidence
  const marketAveragePostTaxPrice = marketEvidence?.averagePostTaxPrice ?? null
  const marketAveragePreTaxPrice = marketEvidence?.averagePreTaxPrice ?? null
  const farAveragePostTaxPrice = marketEvidence?.farAveragePostTaxPrice ?? null
  const farAveragePreTaxPrice = marketEvidence?.farAveragePreTaxPrice ?? null
  if (marketAveragePostTaxPrice !== null && marketAveragePreTaxPrice !== null) {
    const belowMarketTarget = choosePreferredBelowMarketPrice(marketAveragePostTaxPrice)
    if (input.action === 'keep-price' && input.product.price !== null) {
      return (
        `Near and mid public average for this SKU family is $${formatMoney(marketAveragePreTaxPrice)} pre-tax ` +
        `($${formatMoney(marketAveragePostTaxPrice)} post-tax), and the preferred quarter-step target still lands on ` +
        `the current $${formatMoney(input.product.price)} after fresh market review, so the draft keeps the live price.`
      )
    }
    if (belowMarketTarget < input.minimumPrice - PRICE_EPSILON) {
      return (
        `Near and mid public average for this SKU family is $${formatMoney(marketAveragePreTaxPrice)} pre-tax ` +
        `($${formatMoney(marketAveragePostTaxPrice)} post-tax), so the draft targets $${formatMoney(input.proposedPrice)} ` +
        `a few percent below market even though that sits below the ${PRICING_TARGET_MIN_GM_PERCENT}% GM floor.`
      )
    }

    if (belowMarketTarget > input.maximumPrice + PRICE_EPSILON) {
      return (
        `Near and mid public average for this SKU family is $${formatMoney(marketAveragePreTaxPrice)} pre-tax ` +
        `($${formatMoney(marketAveragePostTaxPrice)} post-tax), so the draft caps at $${formatMoney(input.proposedPrice)} ` +
        `to stay inside the managed ${PRICING_TARGET_MIN_GM_PERCENT}%-${PRICING_TARGET_MAX_GM_PERCENT}% GM band while remaining below market.`
      )
    }

    return (
      `Near and mid public average for this SKU family is $${formatMoney(marketAveragePreTaxPrice)} pre-tax ` +
      `($${formatMoney(marketAveragePostTaxPrice)} post-tax), so the draft targets $${formatMoney(input.proposedPrice)} ` +
      `a few percent below that weighted neighborhood average while staying inside the managed GM band.`
    )
  }

  if (farAveragePostTaxPrice !== null && farAveragePreTaxPrice !== null) {
    const belowFarTarget = choosePreferredBelowMarketPrice(farAveragePostTaxPrice)
    if (input.action === 'keep-price' && input.product.price !== null) {
      return (
        `No near or mid public comps were available, but ${marketEvidence?.farListingCount ?? 0} far public listing${marketEvidence?.farListingCount === 1 ? '' : 's'} ` +
        `averaged $${formatMoney(farAveragePreTaxPrice)} pre-tax ($${formatMoney(farAveragePostTaxPrice)} post-tax). ` +
        `That far-only market-pressure check still snaps back to the current $${formatMoney(input.product.price)} inside the managed ${PRICING_TARGET_MIN_GM_PERCENT}%-${PRICING_TARGET_MAX_GM_PERCENT}% GM band.`
      )
    }
    if (belowFarTarget < input.minimumPrice - PRICE_EPSILON) {
      return (
        `No near or mid public comps were available, but ${marketEvidence?.farListingCount ?? 0} far public listing${marketEvidence?.farListingCount === 1 ? '' : 's'} ` +
        `averaged $${formatMoney(farAveragePreTaxPrice)} pre-tax ($${formatMoney(farAveragePostTaxPrice)} post-tax). ` +
        `That far-only market pressure would push below the ${PRICING_TARGET_MIN_GM_PERCENT}% GM floor, so the draft stops at $${formatMoney(input.proposedPrice)} to stay inside the managed band.`
      )
    }
    if (belowFarTarget > input.maximumPrice + PRICE_EPSILON) {
      return (
        `No near or mid public comps were available, but ${marketEvidence?.farListingCount ?? 0} far public listing${marketEvidence?.farListingCount === 1 ? '' : 's'} ` +
        `averaged $${formatMoney(farAveragePreTaxPrice)} pre-tax ($${formatMoney(farAveragePostTaxPrice)} post-tax). ` +
        `That far-only market pressure would overshoot the managed GM band, so the draft caps at $${formatMoney(input.proposedPrice)} inside the ${PRICING_TARGET_MIN_GM_PERCENT}%-${PRICING_TARGET_MAX_GM_PERCENT}% range.`
      )
    }
    return (
      `No near or mid public comps were available, but ${marketEvidence?.farListingCount ?? 0} far public listing${marketEvidence?.farListingCount === 1 ? '' : 's'} ` +
      `averaged $${formatMoney(farAveragePreTaxPrice)} pre-tax ($${formatMoney(farAveragePostTaxPrice)} post-tax), so the draft uses that far-only market pressure ` +
      `to target $${formatMoney(input.proposedPrice)} a few percent below the far comp average while staying inside the managed GM band.`
    )
  }

  if (input.familyPricingEvidence) {
    if (input.action === 'keep-price' && input.product.price !== null) {
      return (
        `No near or mid public competitor average was available, so Helios reused current live family pricing from ` +
        `${input.familyPricingEvidence.sourceProductName} [${input.familyPricingEvidence.sourceTab}] at $${formatMoney(input.familyPricingEvidence.anchorPrice)}. ` +
        `That same-brand lane anchor already matches the current $${formatMoney(input.product.price)} for this SKU, so the draft keeps the live price.`
      )
    }
    const anchorClampNote = Math.abs(input.familyPricingEvidence.anchorPrice - input.proposedPrice) > PRICE_EPSILON
      ? ` The shared family anchor was clamped into the managed ${PRICING_TARGET_MIN_GM_PERCENT}%-${PRICING_TARGET_MAX_GM_PERCENT}% GM band for this SKU.`
      : ''
    return (
      `No near or mid public competitor average was available, so the draft reuses current live family pricing from ` +
      `${input.familyPricingEvidence.sourceProductName} [${input.familyPricingEvidence.sourceTab}] at $${formatMoney(input.familyPricingEvidence.anchorPrice)} ` +
      `to keep the ${input.familyPricingEvidence.laneLabel} lane aligned across this brand.${anchorClampNote}`
    )
  }

  if (input.marketEvidence && input.marketEvidence.listingCount > 0) {
    const bandSummary = summarizeDistanceBands(input.marketEvidence)
    if (input.action === 'keep-price' && input.product.price !== null) {
      return (
        `Only ${bandSummary} public listings surfaced for this SKU family, so the draft ignores those long-distance comps ` +
        `for pricing and keeps the current $${formatMoney(input.product.price)} because the managed ${PRICING_FALLBACK_TARGET_GM_PERCENT}% ` +
        `fallback target already snaps back to the live quarter-step price.`
      )
    }
    return (
      `Only ${bandSummary} public listings surfaced for this SKU family, so the draft ignores those long-distance comps ` +
      `for pricing and falls back to the ${PRICING_FALLBACK_TARGET_GM_PERCENT}% GM target.`
    )
  }

  if (input.action === 'set-price') {
    const familyNote = input.familyContext?.note ? ` ${input.familyContext.note}` : ''
    return (
      `No usable live price was recorded for this SKU, so the draft sets it to $${formatMoney(input.proposedPrice)} ` +
      `from the current cost using the initial ${PRICING_FALLBACK_TARGET_GM_PERCENT}% GM fallback target inside the managed band.${familyNote}`
    )
  }

  if (input.action === 'keep-price' && input.product.price !== null) {
    const familyNote = input.familyContext?.note ? ` ${input.familyContext.note}` : ''
    return (
      `Fresh repricing still lands on the current $${formatMoney(input.product.price)} from the latest cost snapshot, ` +
      `so the draft keeps the live price after rerunning the managed-band calculation.${familyNote}`
    )
  }

  if (input.action === 'raise-price' && input.currentGmPercent !== null) {
    const familyNote = input.familyContext?.note ? ` ${input.familyContext.note}` : ''
    return (
      `Current GM is ${formatPercent(input.currentGmPercent)}%, below the ${PRICING_TARGET_MIN_GM_PERCENT}% floor, so the draft raises ` +
      `this SKU to $${formatMoney(input.proposedPrice)} toward the initial ${PRICING_FALLBACK_TARGET_GM_PERCENT}% GM fallback target.${familyNote}`
    )
  }

  if (input.currentGmPercent !== null) {
    const familyNote = input.familyContext?.note ? ` ${input.familyContext.note}` : ''
    return (
      `Current GM is ${formatPercent(input.currentGmPercent)}%, above the ${PRICING_TARGET_MAX_GM_PERCENT}% ceiling, so the draft lowers ` +
      `this SKU to $${formatMoney(input.proposedPrice)} toward the initial ${PRICING_FALLBACK_TARGET_GM_PERCENT}% GM fallback target.${familyNote}`
    )
  }

  return `Drafted $${formatMoney(input.proposedPrice)} from the current cost.`
}

function determineGeneratedAction(
  currentPrice: number,
  proposedPrice: number,
): GeneratedPricingLineItem['action'] {
  if (Math.abs(proposedPrice - currentPrice) < PRICE_EPSILON) {
    return 'keep-price'
  }
  return proposedPrice > currentPrice ? 'raise-price' : 'lower-price'
}

function hasPreferredEnding(value: number): boolean {
  const cents = Math.round((value - Math.floor(value)) * 100)
  return cents === 0 || cents === 50
}

function roundUpToQuarter(value: number): number {
  return roundPrice(Math.ceil(value / QUARTER_INCREMENT - 1e-9) * QUARTER_INCREMENT)
}

function roundDownToQuarter(value: number): number {
  return roundPrice(Math.floor(value / QUARTER_INCREMENT + 1e-9) * QUARTER_INCREMENT)
}

function roundPrice(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100
}

function formatMoney(value: number): string {
  return value.toFixed(2)
}

function formatOptionalMoney(value: number | null): string {
  return value === null ? 'n/a' : `$${formatMoney(value)}`
}

function formatPercent(value: number): string {
  return value.toFixed(2)
}

function formatOptionalPercent(value: number | null): string {
  return value === null ? 'n/a' : `${formatPercent(value)}%`
}

function summarizeDistanceBands(marketEvidence: ProductPricingMarketEvidence): string {
  const counts = marketEvidence.matchedListings.reduce<Record<PricingDistanceBand, number>>(
    (summary, listing) => ({
      ...summary,
      [listing.distanceBand]: summary[listing.distanceBand] + 1,
    }),
    { far: 0, mid: 0, near: 0, unknown: 0, very_far: 0 },
  )

  const parts: string[] = []
  if (counts.near > 0) {
    parts.push(`${counts.near} near (<=${PRICING_NEAR_DISTANCE_MAX_MILES.toFixed(1)}mi)`)
  }
  if (counts.mid > 0) {
    parts.push(`${counts.mid} mid (<=${PRICING_MID_DISTANCE_MAX_MILES.toFixed(1)}mi)`)
  }
  if (counts.far > 0) {
    parts.push(`${counts.far} far (<${PRICING_FAR_DISTANCE_MAX_MILES.toFixed(0)}mi)`)
  }
  if (counts.very_far > 0) {
    parts.push(`${counts.very_far} very-far (> ${PRICING_FAR_DISTANCE_MAX_MILES.toFixed(0)}mi)`)
  }
  if (counts.unknown > 0) {
    parts.push(`${counts.unknown} unknown-distance`)
  }

  return parts.join(', ')
}
