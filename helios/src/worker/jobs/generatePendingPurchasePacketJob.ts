import { randomUUID } from 'node:crypto'

import { z } from 'zod'

import {
  getHeliosPendingPurchaseSiteDealer,
  normalizeHeliosPendingPurchaseSiteDealerIds,
  type CatalogPendingPurchasesGenerateJobPayload,
  type JsonValue,
  type HeliosPendingPurchaseSiteDealer,
  type JobProgress,
} from '../../shared/contracts/index.js'
import { sha256 } from '../../shared/util/hash.js'
import { getPool } from '../../server/db/pool.js'
import {
  buildPendingPurchaseBrandAliasCandidates,
  buildPendingPurchaseParseRuleFingerprint,
  derivePendingPurchaseBrandKey,
  findPendingPurchaseExactParseRule,
  insertPendingPurchaseParseObservation,
  listPendingPurchaseMatchingBrandAliases,
  listPendingPurchaseRuntimeRulesForProfiles,
  markPendingPurchaseParseRuleMatched,
  normalizePendingPurchaseParserText,
  upsertPendingPurchaseBrandAlias,
  upsertPendingPurchaseBrandProfile,
  upsertPendingPurchaseParseRule,
  type PendingPurchaseBrandProfileRecord,
  type PendingPurchaseParseRuleRecord,
} from '../../server/db/queries/pendingPurchaseParserQueries.js'
import { withTransaction } from '../../server/db/tx.js'
import {
  persistPendingPurchasePacket,
  type PendingPurchasePacket,
} from '../../server/pendingPurchases/pendingPurchasePacketImport.js'
import { getWorkerEnv } from '../config/env.js'
import type { NormalizedCatalogGroupLiveState } from '../catalog/liveState.js'
import { RetryableWorkerError } from '../runtime/errors.js'
import type { JobHandlerContext } from '../runtime/jobRegistry.js'
import type { PricingMarketContext, ProductPricingMarketEvidence } from '../pricing/deterministicPricing.js'
import { buildPricingMarketContext } from '../pricing/litAlertsMarket.js'

const GENERIC_PLACEHOLDER_PRODUCT_NAMES = new Set(['preroll samples samples'])

const EXACT_REUSE_PRODUCT_IDS = new Map<string, number>([
  ['Pr(Pre-Roll Pack)-Anthem-Indica Blend-10PK-3.5g-I', 338655],
  ['SMACK Infused .5g Pre-Roll Blu Cookie Monster', 290165],
  ['SMACK Infused 1g Pre-Roll Blu Cookie Monster', 290203],
  ['SMACK Infused 1g Pre-Roll Cranberry Rozay', 290206],
  ['SMACK Infused 1g Pre-Roll Twisted Lime Kush', 290159],
])

const NAME_ALIASES = new Map<string, string>([
  ['Happy Purp', 'Happy Purps'],
  ['#JUAN-ROLL', '#Juan Roll'],
  ['Select Essentials', 'Select'],
])

const CURALEAF_CATEGORY_MAP = new Map<string, { category: string; subcategory: string | null }>([
  ['Pr(Pre-Roll)', { category: 'Pre-Rolls', subcategory: 'Infused' }],
  ['Pr(Pre-Roll Pack)', { category: 'Pre-Rolls', subcategory: null }],
  ['F(Whole Flower)', { category: 'Flower', subcategory: 'Pre-Packaged Flower' }],
  ['V(BRIQ)', { category: 'Vapes', subcategory: null }],
])

const PREVALENCE_MAP = new Map<string, string>([
  ['I', 'Indica'],
  ['S', 'Sativa'],
  ['H', 'Hybrid'],
])

const PENDING_PURCHASE_SOURCE_SYSTEM = 'metrc'

const DealerSetResultSchema = z.object({
  user: z.object({
    currentDealerId: z.coerce.number().int(),
    currentDealerName: z.string().nullable().optional(),
  }),
})

const PurchaseOrderListResponseSchema = z.object({
  data: z.array(z.object({
    id: z.coerce.number().int(),
  }).passthrough()).default([]),
  page: z.coerce.number().int().default(1),
  pageSize: z.coerce.number().int().default(50),
  totalCount: z.coerce.number().int().default(0),
}).passthrough()

const PurchaseOrderSummarySchema = z.object({
  id: z.coerce.number().int(),
  name: z.string().nullable().optional(),
}).passthrough()

const PurchaseOrderPositionSchema = z.object({
  discountProductPrice: z.coerce.number().nullable().optional(),
  distributorProduct: z.object({
    id: z.union([z.coerce.number().int(), z.string().trim().min(1)]).nullable().optional(),
    name: z.string().nullable().optional(),
    product: z.object({
      id: z.coerce.number().int().nullable().optional(),
      name: z.string().nullable().optional(),
    }).passthrough().nullable().optional(),
  }).passthrough().nullable().optional(),
  distributorProductQty: z.coerce.number().nullable().optional(),
  extendedAmount: z.coerce.number().nullable().optional(),
  id: z.coerce.number().int(),
  isTradeSample: z.boolean().nullable().optional(),
  orderPositionIntegrationData: z.object({
    wholesalePrice: z.coerce.number().nullable().optional(),
  }).passthrough().nullable().optional(),
  orderPositionQty: z.coerce.number().nullable().optional(),
  qty: z.coerce.number().nullable().optional(),
  suggestedProduct: PurchaseOrderSummarySchema.nullable().optional(),
}).passthrough()

const PurchaseOrderDetailSchema = z.object({
  deliveryDate: z.string().nullable().optional(),
  distributor: z.object({
    id: z.coerce.number().int().nullable().optional(),
    name: z.string().nullable().optional(),
  }).passthrough().nullable().optional(),
  distributorIntegration: z.object({
    id: z.coerce.number().int().nullable().optional(),
    name: z.string().nullable().optional(),
  }).passthrough().nullable().optional(),
  externalOrderId: z.string().nullable().optional(),
  financialStatus: z.object({
    name: z.string().nullable().optional(),
  }).passthrough().nullable().optional(),
  id: z.coerce.number().int(),
  orderStatus: z.object({
    name: z.string().nullable().optional(),
  }).passthrough().nullable().optional(),
  positions: z.array(PurchaseOrderPositionSchema).default([]),
}).passthrough()

const PurchaseSuggestionSchema = z.object({
  orderPositions: z.array(z.object({
    orderPositionId: z.coerce.number().int(),
    products: z.array(z.object({
      product: z.object({
        id: z.coerce.number().int(),
        name: z.string().nullable().optional(),
      }).passthrough().nullable().optional(),
      score: z.coerce.number().nullable().optional(),
    }).passthrough()).default([]),
  }).passthrough()).default([]),
}).passthrough()

const DistributorProductListSchema = z.object({
  data: z.array(z.object({
    distributor: z.object({ name: z.string().nullable().optional() }).passthrough().nullable().optional(),
    id: z.coerce.number().int(),
    name: z.string().nullable().optional(),
    price: z.coerce.number().nullable().optional(),
    product: z.object({
      id: z.coerce.number().int(),
      name: z.string().nullable().optional(),
    }).passthrough().nullable().optional(),
  }).passthrough()).default([]),
}).passthrough()

const ProductListShortSchema = z.object({
  data: z.array(z.object({
    id: z.coerce.number().int(),
    name: z.string().nullable().optional(),
  }).passthrough()).default([]),
}).passthrough()

const ProductDetailSchema = z.object({
  product: z.object({
    allowedSaleType: z.object({ name: z.string().nullable().optional() }).passthrough().nullable().optional(),
    id: z.coerce.number().int(),
    name: z.string().nullable().optional(),
    packOfSize: z.coerce.number().int().nullable().optional(),
    price: z.coerce.number().nullable().optional(),
    productGroupId: z.union([z.coerce.number().int(), z.string().trim().min(1)]),
    size: z.object({ name: z.string().nullable().optional() }).passthrough().nullable().optional(),
    tab: z.string().nullable().optional(),
  }).passthrough(),
}).passthrough()

const ProductGroupDetailSchema = z.object({
  brand: z.object({ name: z.string().nullable().optional() }).passthrough().nullable().optional(),
  category: z.object({ name: z.string().nullable().optional() }).passthrough().nullable().optional(),
  description: z.string().nullable().optional(),
  id: z.coerce.number().int(),
  images: z.array(z.object({ url: z.string().nullable().optional() }).passthrough()).default([]),
  name: z.string().nullable().optional(),
  strain: z.object({ name: z.string().nullable().optional() }).passthrough().nullable().optional(),
  subcategory: z.object({ name: z.string().nullable().optional() }).passthrough().nullable().optional(),
}).passthrough()

const PendingPurchaseLlmClassificationSchema = z.object({
  brand: z.string().trim().min(1),
  category: z.string().trim().min(1),
  confidence: z.coerce.number().min(0).max(1),
  groupName: z.string().trim().min(1),
  packCount: z.coerce.number().int().positive(),
  parserFeasibility: z.enum(['easy-rule-based', 'likely-llm-only', 'needs-more-context']),
  prevalence: z.string().trim().min(1).nullable().optional(),
  rationale: z.string().trim().min(1),
  size: z.string().trim().min(1),
  strainName: z.string().trim().nullable().optional(),
  subcategory: z.string().trim().min(1).nullable().optional(),
  variantName: z.string().trim().min(1),
  variantTab: z.string().trim().min(1).nullable().optional(),
  warningFlags: z.array(z.string().trim().min(1)).default([]),
}).passthrough()

const PendingPurchaseLlmBrandAliasCandidateSchema = z.object({
  aliasType: z.enum(['exact', 'prefix']),
  aliasValue: z.string().trim().min(1),
  confidence: z.coerce.number().min(0).max(1),
  rationale: z.string().trim().min(1),
  riskFlags: z.array(z.string().trim().min(1)).default([]),
}).passthrough()

const PendingPurchaseLlmExactNameRuleCandidateSchema = z.object({
  confidence: z.coerce.number().min(0).max(1),
  rationale: z.string().trim().min(1),
  rawName: z.string().trim().min(1),
  riskFlags: z.array(z.string().trim().min(1)).default([]),
  safeAutoPersist: z.boolean().default(false),
}).passthrough()

const PendingPurchaseLlmGeneralizedRuleCandidateSchema = z.object({
  confidence: z.coerce.number().min(0).max(1),
  matchPayload: z.preprocess(
    (value) => (value == null ? {} : value),
    z.record(z.string(), z.unknown()).default({}),
  ),
  normalizedMatchValue: z.string().trim().min(1).nullable().optional(),
  rationale: z.string().trim().min(1),
  riskFlags: z.array(z.string().trim().min(1)).default([]),
  ruleKind: z.enum(['prefix', 'regex', 'template']),
}).passthrough()

const PendingPurchaseLlmTeachingEnvelopeSchema = z.object({
  classification: PendingPurchaseLlmClassificationSchema,
  teaching: z.object({
    brandAliases: z.array(PendingPurchaseLlmBrandAliasCandidateSchema).default([]),
    exactNameRules: z.array(PendingPurchaseLlmExactNameRuleCandidateSchema).default([]),
    generalizedRules: z.array(PendingPurchaseLlmGeneralizedRuleCandidateSchema).default([]),
    riskFlags: z.array(z.string().trim().min(1)).default([]),
  }).default({
    brandAliases: [],
    exactNameRules: [],
    generalizedRules: [],
    riskFlags: [],
  }),
}).passthrough()

const ParsedProductNameSchema = z.object({
  brand: z.string().trim().min(1),
  category: z.string().trim().min(1),
  groupName: z.string().trim().min(1),
  packCount: z.coerce.number().int().positive(),
  prevalence: z.string().trim().min(1).nullable(),
  searchTerm: z.string().trim().min(1),
  size: z.string().trim().min(1),
  strainName: z.string().trim(),
  subcategory: z.string().trim(),
  variantName: z.string().trim().min(1),
  variantTab: z.string().trim().min(1),
})

const AUTO_CLASSIFIABLE_PENDING_PURCHASE_CATEGORIES = new Set([
  'Accessories',
  'Beverages',
  'Concentrates',
  'Edibles',
  'Flower',
  'Pre-Rolls',
  'Tinctures',
  'Topicals',
  'Vapes',
])

const LLM_FALLBACK_NAME_STOPWORDS = new Set([
  '1pk',
  'beverage',
  'brick',
  'distillate',
  'fast',
  'gummy',
  'mg',
  'pk',
  'thc',
  'vape',
])

const HIGH_RISK_LLM_RULE_FLAGS = new Set([
  'ambiguous-brand',
  'broad-inference',
  'conflicting-anchor',
  'needs-manual-review',
  'unverified-generalization',
])

const MAX_JOB_PROGRESS_LOG_ENTRIES = 200

interface PendingOrderSummary {
  deliveryDate: string | null
  distributor: string | null
  externalOrderId: string | null
  financialStatus: string | null
  orderId: number
  orderStatus: string | null
  siteDealerId: number
  siteKey: string
  siteLabel: string
  unresolvedPositionCount: number
}

interface PendingPositionGroup {
  distributorNames: Set<string>
  distributorProductId: string
  distributorProductName: string
  orderIds: Set<number>
  positions: z.infer<typeof PurchaseOrderPositionSchema>[]
  siteDealerId: number
  siteDealerName: string
  siteKey: string
  siteLabel: string
}

interface ParsedProductName {
  brand: string
  category: string
  groupName: string
  packCount: number
  prevalence: string | null
  searchTerm: string
  size: string
  strainName: string
  subcategory: string
  variantName: string
  variantTab: string
}

interface LiveProductSummary {
  allowedSaleType: string
  brand: string
  category: string
  description: string | null
  groupId: number
  groupName: string
  imageUrl: string | null
  packCount: number
  price: number | null
  productId: number
  productName: string
  size: string
  strain: string
  subcategory: string
  tab: string
}

interface ExactDistributorProductRow {
  distributorName: string | null
  distributorProductId: number
  name: string | null
  price: number | null
  productId: number | null
  productName: string | null
}

interface SuggestedProductCandidate {
  productId: number | null
  productName: string | null
  score: number | null
}

interface ResolvedCost {
  reason: string | null
  source: string | null
  value: number | null
}

interface BuildRowContext {
  cache: CatalogCache
  group: PendingPositionGroup
  stateDistributorProductRow: ExactDistributorProductRow | null
}

interface PendingPurchaseLlmFallbackResult {
  brandProfile: PendingPurchaseBrandProfileRecord | null
  learnedRule: PendingPurchaseParseRuleRecord | null
  note: string
  parsed: ParsedProductName | null
  parserSource: 'llm-teacher'
  reviewFlag: string | null
}

interface PendingPurchaseParseResolution {
  brandProfile: PendingPurchaseBrandProfileRecord | null
  note: string | null
  parsed: ParsedProductName | null
  parserSource: 'database-rule' | 'hardcoded-parser' | 'llm-teacher' | 'unresolved'
  reviewFlag: string | null
  rule: PendingPurchaseParseRuleRecord | null
  ruleTrust: 'active' | 'provisional' | 'none'
}

interface PendingPurchasePricingSupport {
  evidence: ProductPricingMarketEvidence | null
  marketAvailability: PricingMarketContext['availability']
  marketNote: string | null
  marketSearchTerm: string | null
}

type GeneratedPendingPurchaseRow = PendingPurchasePacket['rows'][number]

export async function runCatalogPendingPurchasesGenerateJob(
  context: JobHandlerContext,
  payload: CatalogPendingPurchasesGenerateJobPayload,
): Promise<void> {
  const env = getWorkerEnv()
  if (!env.sweedAuthToken) {
    throw new Error('SWEED_AUTH_TOKEN is required for pending-purchase generation jobs.')
  }

  const sites = resolveSites(payload.siteDealerIds)
  const requestId = randomUUID()

  await updateJobProgress(context.id, {
    completed: 0,
    message: `Scanning ${sites.length} site${sites.length === 1 ? '' : 's'} for unresolved outstanding purchase lines.`,
    phase: 'Collecting outstanding purchase orders',
    phaseCount: 3,
    phaseIndex: 1,
    total: sites.length,
  })

  const liveCollection = await collectPendingPositions(context.id, payload.fromDate, payload.toDate, sites)
  const cache = new CatalogCache(env.sweedStateDealerId)

  await ensureDealerContext(env.sweedStateDealerId)
  const stateContext = await readCurrentDealerContext(env.sweedStateDealerId)

  const rows: GeneratedPendingPurchaseRow[] = []
  const totalGroups = liveCollection.groups.size
  await updateJobProgress(context.id, {
    completed: 0,
    message: totalGroups > 0
      ? `Resolving ${totalGroups} unresolved distributor product${totalGroups === 1 ? '' : 's'} into review rows.`
      : 'No unresolved distributor products were found. Preparing an empty review packet.',
    phase: 'Resolving catalog actions',
    phaseCount: 3,
    phaseIndex: 2,
    total: totalGroups > 0 ? totalGroups : null,
  })

  // Parallel processing with 20 concurrent workers
  const groupsArray = Array.from(liveCollection.groups.values())
  const CONCURRENCY_LIMIT = 20
  let processedGroups = 0
  
  const buildRow = async (group: PendingPositionGroup) => {
    const stateDistributorProductRow = await findExactDistributorProductRow(group)
    return buildGeneratedRow({ cache, group, stateDistributorProductRow })
  }
  
  // Process in batches of CONCURRENCY_LIMIT
  for (let i = 0; i < groupsArray.length; i += CONCURRENCY_LIMIT) {
    const batch = groupsArray.slice(i, i + CONCURRENCY_LIMIT)
    const batchResults = await Promise.all(batch.map(buildRow))
    rows.push(...batchResults)
    
    processedGroups += batch.length
    if (processedGroups === batch.length || processedGroups === totalGroups || processedGroups % 20 === 0) {
      await updateJobProgress(context.id, {
        completed: processedGroups,
        message: `Resolved ${processedGroups} of ${totalGroups} pending distributor product${totalGroups === 1 ? '' : 's'} (${CONCURRENCY_LIMIT} parallel workers).`,
        phase: 'Resolving catalog actions',
        phaseCount: 3,
        phaseIndex: 2,
        total: totalGroups > 0 ? totalGroups : null,
      })
    }
  }

  rows.sort((left, right) => {
    const siteComparison = left.siteLabel.localeCompare(right.siteLabel)
    if (siteComparison !== 0) {
      return siteComparison
    }
    return left.distributorProductName.localeCompare(right.distributorProductName)
  })

  const packet: PendingPurchasePacket = {
    generatedAt: new Date().toISOString(),
    orders: liveCollection.orders,
    packetTitle: buildPacketTitle(sites, payload.fromDate, payload.toDate),
    rows,
    siteKeys: sites.map((site) => site.siteKey),
    siteLabels: sites.map((site) => site.siteLabel),
    stateContext,
    summary: buildPacketSummary(rows, liveCollection.orders, payload.fromDate, payload.toDate),
  }

  await updateJobProgress(context.id, {
    completed: 1,
    message: `Saving ${rows.length} pending-purchase review row${rows.length === 1 ? '' : 's'} into Helios.`,
    phase: 'Persisting review packet',
    phaseCount: 3,
    phaseIndex: 3,
    total: 1,
  })

  await withTransaction(async (db) => {
    const result = await persistPendingPurchasePacket(db, {
      createdByUserId: payload.requestedByUserId ?? null,
      importFileName: null,
      jobId: context.id,
      packet,
      requestId,
      source: 'generated',
      sourcePath: null,
    })

    await db.query(
      `
        update job_queue
        set payload_json = jsonb_set(payload_json, '{pendingPurchasePacketId}', to_jsonb($2::bigint), true),
            updated_at = now()
        where id = $1
      `,
      [context.id, result.packetId],
    )
  })
}

class CatalogCache {
  private readonly productSearchCache = new Map<string, Array<{ id: number; name: string | null }>>()

  private readonly productSummaryCache = new Map<number, LiveProductSummary>()

  private readonly pricingSupportCache = new Map<string, Promise<PendingPurchasePricingSupport>>()

  public constructor(private readonly stateDealerId: number) {}

  public async searchProducts(query: string): Promise<Array<{ id: number; name: string | null }>> {
    const cacheKey = query.trim().toLowerCase()
    const cached = this.productSearchCache.get(cacheKey)
    if (cached) {
      return cached
    }

    const response = ProductListShortSchema.parse(
      await callSweedRpc(this.stateDealerId, 'store.product.list.short', { page: 1, pageSize: 100, query }),
    )
    const rows = response.data.map((row) => ({ id: row.id, name: row.name ?? null }))
    this.productSearchCache.set(cacheKey, rows)
    return rows
  }

  public async getProductSummary(productId: number): Promise<LiveProductSummary> {
    const cached = this.productSummaryCache.get(productId)
    if (cached) {
      return cached
    }

    const product = ProductDetailSchema.parse(
      await callSweedRpc(this.stateDealerId, 'store.product.get', { id: String(productId) }),
    ).product
    const groupId = Number(product.productGroupId)
    const group = ProductGroupDetailSchema.parse(
      await callSweedRpc(this.stateDealerId, 'store.product.group.get', { id: groupId }),
    )

    const summary: LiveProductSummary = {
      allowedSaleType: normalizeNonEmptyString(product.allowedSaleType?.name) ?? 'Medical and recreational',
      brand: normalizeNonEmptyString(group.brand?.name) ?? '',
      category: normalizeNonEmptyString(group.category?.name) ?? '',
      description: normalizeNonEmptyString(group.description),
      groupId,
      groupName: normalizeNonEmptyString(group.name) ?? '',
      imageUrl: normalizeNonEmptyString(group.images[0]?.url),
      packCount: normalizePositiveInt(product.packOfSize) ?? 1,
      price: normalizePrice(product.price),
      productId,
      productName: normalizeNonEmptyString(product.name) ?? '',
      size: normalizeNonEmptyString(product.size?.name) ?? '',
      strain: normalizeNonEmptyString(group.strain?.name) ?? '',
      subcategory: normalizeNonEmptyString(group.subcategory?.name) ?? '',
      tab: normalizeNonEmptyString(product.tab) ?? '',
    }
    this.productSummaryCache.set(productId, summary)
    return summary
  }

  public async getPendingPurchasePricingSupport(input: {
    brand: string
    category: string
    currentPrice: number | null
    groupName: string
    subcategory: string | null
    variantName: string
    variantTab: string
    wholesaleCost: number | null
  }): Promise<PendingPurchasePricingSupport> {
    const cacheKey = JSON.stringify({
      brand: input.brand,
      category: input.category,
      groupName: input.groupName,
      subcategory: input.subcategory,
      variantName: input.variantName,
      variantTab: input.variantTab,
    })
    const cached = this.pricingSupportCache.get(cacheKey)
    if (cached) {
      return cached
    }

    const pending = loadPendingPurchasePricingSupport(input).catch((error) => {
      this.pricingSupportCache.delete(cacheKey)
      throw error
    })
    this.pricingSupportCache.set(cacheKey, pending)
    return pending
  }
}

async function loadPendingPurchasePricingSupport(input: {
  brand: string
  category: string
  currentPrice: number | null
  groupName: string
  subcategory: string | null
  variantName: string
  variantTab: string
  wholesaleCost: number | null
}): Promise<PendingPurchasePricingSupport> {
  const syntheticLiveState = buildPendingPurchaseSyntheticLiveState(input)

  try {
    const marketContext = await buildPricingMarketContext(syntheticLiveState)
    return {
      evidence: marketContext.productEvidenceById[syntheticLiveState.products[0]?.productId ?? 1] ?? null,
      marketAvailability: marketContext.availability,
      marketNote: marketContext.note,
      marketSearchTerm: marketContext.searchTerm,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown Lit Alerts pricing error.'
    return {
      evidence: null,
      marketAvailability: 'error',
      marketNote: `Lit Alerts pricing support could not be loaded for ${input.variantName}: ${message}`,
      marketSearchTerm: null,
    }
  }
}

function buildPendingPurchaseSyntheticLiveState(input: {
  brand: string
  category: string
  currentPrice: number | null
  groupName: string
  subcategory: string | null
  variantName: string
  variantTab: string
  wholesaleCost: number | null
}): NormalizedCatalogGroupLiveState {
  const productId = 1
  const groupFullName = compactStrings([input.brand, input.groupName]).join(' ').trim() || input.groupName

  return {
    brand: input.brand,
    category: input.category,
    currentDescription: '',
    effects: [],
    flavorings: [],
    groupFullName,
    groupId: 1,
    groupName: input.groupName,
    imageUrl: null,
    productTabs: compactStrings([input.variantTab]),
    products: [{
      gmPercent: computeGmPercent(input.wholesaleCost, input.currentPrice),
      imageUrl: null,
      name: input.variantName,
      price: input.currentPrice,
      productId,
      shortName: null,
      sku: null,
      tab: input.variantTab,
      wholesaleCost: input.wholesaleCost,
    }],
    scents: [],
    strain: null,
    subcategory: input.subcategory,
    tags: [],
  }
}

async function collectPendingPositions(
  jobId: number,
  fromDate: string,
  toDate: string,
  sites: HeliosPendingPurchaseSiteDealer[],
): Promise<{ groups: Map<string, PendingPositionGroup>; orders: PendingOrderSummary[] }> {
  const groups = new Map<string, PendingPositionGroup>()
  const orders: PendingOrderSummary[] = []

  for (const [siteIndex, site] of sites.entries()) {
    await updateJobProgress(jobId, {
      completed: siteIndex,
      message: `Scanning ${site.siteLabel} for unresolved outstanding purchase lines.`,
      phase: 'Collecting outstanding purchase orders',
      phaseCount: 3,
      phaseIndex: 1,
      total: sites.length,
    })
    const siteOrders = await listOutstandingOrders(site.dealerId, fromDate, toDate)
    for (const orderSummary of siteOrders) {
      const order = PurchaseOrderDetailSchema.parse(
        await callSweedRpc(site.dealerId, 'store.purchase.order.get', { id: orderSummary.id }),
      )
      const suggestion = PurchaseSuggestionSchema.parse(
        await callSweedRpc(site.dealerId, 'store.distributor.product.suggestion', { orderId: orderSummary.id }),
      )
      const suggestionProducts = new Map<number, SuggestedProductCandidate[]>()
      const unresolvedPositionIds = new Set<number>()

      for (const suggestionRow of suggestion.orderPositions) {
        if (suggestionRow.products.length === 0) {
          unresolvedPositionIds.add(suggestionRow.orderPositionId)
        }
        suggestionProducts.set(
          suggestionRow.orderPositionId,
          suggestionRow.products.map((item) => ({
            productId: item.product?.id ?? null,
            productName: normalizeNonEmptyString(item.product?.name),
            score: normalizeFiniteNumber(item.score),
          })),
        )
      }

      let unresolvedCount = 0
      for (const position of order.positions) {
        const distributorProduct = position.distributorProduct ?? null
        const distributorProductId = normalizeDistributorProductId(distributorProduct?.id, position.id)
        const mappedProductName = normalizeText(distributorProduct?.product?.name)
        const hasGenericPlaceholderMapping = !position.suggestedProduct && GENERIC_PLACEHOLDER_PRODUCT_NAMES.has(mappedProductName)
        const isUnresolved = unresolvedPositionIds.has(position.id) || position.suggestedProduct == null || hasGenericPlaceholderMapping
        if (!isUnresolved) {
          continue
        }

        unresolvedCount += 1
        const key = `${site.siteKey}:${distributorProductId}`
        const existingGroup = groups.get(key)
        if (existingGroup) {
          existingGroup.positions.push(position)
          existingGroup.orderIds.add(order.id)
          const distributorName = normalizeNonEmptyString(order.distributor?.name)
          const distributorIntegrationName = normalizeNonEmptyString(order.distributorIntegration?.name)
          if (distributorName) {
            existingGroup.distributorNames.add(distributorName)
          }
          if (distributorIntegrationName) {
            existingGroup.distributorNames.add(distributorIntegrationName)
          }
        } else {
          const distributorNames = new Set<string>()
          const distributorName = normalizeNonEmptyString(order.distributor?.name)
          const distributorIntegrationName = normalizeNonEmptyString(order.distributorIntegration?.name)
          if (distributorName) {
            distributorNames.add(distributorName)
          }
          if (distributorIntegrationName) {
            distributorNames.add(distributorIntegrationName)
          }
          groups.set(key, {
            distributorNames,
            distributorProductId,
            distributorProductName: normalizeNonEmptyString(distributorProduct?.name) ?? `Distributor product ${distributorProductId}`,
            orderIds: new Set([order.id]),
            positions: [position],
            siteDealerId: site.dealerId,
            siteDealerName: site.dealerName,
            siteKey: site.siteKey,
            siteLabel: site.siteLabel,
          })
        }

        const existingRow = groups.get(key)
        if (existingRow) {
          const suggestions = suggestionProducts.get(position.id) ?? []
          ;(position as Record<string, unknown>).pendingPurchaseSuggestedProducts = suggestions
        }
      }

      orders.push({
        deliveryDate: normalizeDate(order.deliveryDate),
        distributor: normalizeNonEmptyString(order.distributor?.name),
        externalOrderId: normalizeNonEmptyString(order.externalOrderId),
        financialStatus: normalizeNonEmptyString(order.financialStatus?.name),
        orderId: order.id,
        orderStatus: normalizeNonEmptyString(order.orderStatus?.name),
        siteDealerId: site.dealerId,
        siteKey: site.siteKey,
        siteLabel: site.siteLabel,
        unresolvedPositionCount: unresolvedCount,
      })
    }

    await updateJobProgress(jobId, {
      completed: siteIndex + 1,
      message: `Scanned ${site.siteLabel}: ${siteOrders.length} outstanding order${siteOrders.length === 1 ? '' : 's'} checked.`,
      phase: 'Collecting outstanding purchase orders',
      phaseCount: 3,
      phaseIndex: 1,
      total: sites.length,
    })
  }

  return { groups, orders }
}

async function updateJobProgress(jobId: number, progress: JobProgress): Promise<void> {
  const progressLogEntry = JSON.stringify({
    createdAt: new Date().toISOString(),
    message: progress.message,
  })

  await getPool().query(
    `
      update job_queue
      set payload_json = (
            jsonb_set(
              jsonb_set(coalesce(payload_json, '{}'::jsonb), '{progress}', $2::jsonb, true),
              '{progressLog}',
              (
                select coalesce(jsonb_agg(entry order by ordinality asc), '[]'::jsonb)
                from (
                  select entry, ordinality
                  from (
                    select entry, ordinality
                    from jsonb_array_elements(coalesce(payload_json->'progressLog', '[]'::jsonb) || $3::jsonb) with ordinality as log_entries(entry, ordinality)
                    order by ordinality desc
                    limit ${MAX_JOB_PROGRESS_LOG_ENTRIES}
                  ) recent_entries
                ) trimmed_entries
              ),
              true
            )
          ),
          updated_at = now()
      where id = $1
    `,
    [jobId, JSON.stringify(progress), progressLogEntry],
  )
}

async function resolvePendingPurchaseParse(input: {
  cache: CatalogCache
  group: PendingPositionGroup
  resolvedCost: ResolvedCost
  rowInputSignature: string
  suggestionCandidates: SuggestedProductCandidate[]
}): Promise<PendingPurchaseParseResolution> {
  const observationRawRow = buildPendingPurchaseParserObservationRawRow(input)
  const normalizedDistributorProductName = normalizePendingPurchaseParserText(input.group.distributorProductName)
  const databaseMatch = await resolvePendingPurchaseDatabaseRule(input.group.distributorProductName)
  if (databaseMatch) {
    await withTransaction(async (db) => {
      await markPendingPurchaseParseRuleMatched(db, databaseMatch.rule.id)
      await insertPendingPurchaseParseObservation(db, {
        brandProfileId: databaseMatch.brandProfile.id,
        inference: {
          matchedAlias: databaseMatch.matchedAlias,
          parserSource: 'database-rule',
          ruleId: databaseMatch.rule.id,
          ruleKind: databaseMatch.rule.ruleKind,
          ruleState: databaseMatch.rule.state,
        },
        normalizedDistributorProductName,
        notes: `Resolved from ${databaseMatch.rule.state} ${databaseMatch.rule.ruleKind.replace('_', ' ')} rule #${databaseMatch.rule.id}.`,
        observationStatus: 'accepted',
        observationType: 'generation_parse',
        parseRuleId: databaseMatch.rule.id,
        rawDistributorProductName: input.group.distributorProductName,
        rawRow: observationRawRow,
        rowInputSignature: input.rowInputSignature,
        sourceSystem: PENDING_PURCHASE_SOURCE_SYSTEM,
      })
    })

    return {
      brandProfile: databaseMatch.brandProfile,
      note: `Reused ${databaseMatch.rule.state} learned parse rule for ${databaseMatch.brandProfile.displayBrandName}.`,
      parsed: databaseMatch.parsed,
      parserSource: 'database-rule',
      reviewFlag: databaseMatch.rule.state === 'provisional' ? 'Provisional learned parse rule' : null,
      rule: databaseMatch.rule,
      ruleTrust: databaseMatch.rule.state === 'active' ? 'active' : 'provisional',
    }
  }

  let parsed: ParsedProductName | null = null
  let parseError: string | null = null
  try {
    parsed = parseProductName(input.group.distributorProductName)
  } catch (error) {
    parseError = error instanceof Error ? error.message : 'Could not classify distributor product name.'
  }

  if (parsed) {
    const brandProfile = await withTransaction(async (db) => {
      const profile = await upsertPendingPurchaseBrandProfile(db, {
        displayBrandName: parsed.brand,
        metadata: { seededBy: 'hardcoded-parser' },
        sourceSystem: PENDING_PURCHASE_SOURCE_SYSTEM,
        taxonomyHints: {
          category: parsed.category,
          subcategory: parsed.subcategory || null,
        },
      })
      await upsertPendingPurchaseBrandAlias(db, {
        aliasType: 'exact',
        aliasValue: parsed.brand,
        brandProfileId: profile.id,
        confidence: 1,
        metadata: { seededBy: 'hardcoded-parser' },
        provenance: 'hardcoded-parser',
        status: 'active',
      })
      await insertPendingPurchaseParseObservation(db, {
        brandProfileId: profile.id,
        inference: toJsonValue({
          parserSource: 'hardcoded-parser',
          parsed,
        }),
        normalizedDistributorProductName,
        notes: 'Resolved with the existing deterministic pending-purchase parser.',
        observationStatus: 'accepted',
        observationType: 'generation_parse',
        rawDistributorProductName: input.group.distributorProductName,
        rawRow: observationRawRow,
        rowInputSignature: input.rowInputSignature,
        sourceSystem: PENDING_PURCHASE_SOURCE_SYSTEM,
      })
      return profile
    })

    return {
      brandProfile,
      note: null,
      parsed,
      parserSource: 'hardcoded-parser',
      reviewFlag: null,
      rule: null,
      ruleTrust: 'none',
    }
  }

  const llmFallback = await classifyPendingPurchaseNameWithLlmFallback({
    cache: input.cache,
    group: input.group,
    resolvedCost: input.resolvedCost,
    rowInputSignature: input.rowInputSignature,
    suggestionCandidates: input.suggestionCandidates,
  })
  if (llmFallback?.parsed) {
    return {
      brandProfile: llmFallback.brandProfile,
      note: llmFallback.note,
      parsed: llmFallback.parsed,
      parserSource: llmFallback.parserSource,
      reviewFlag: llmFallback.reviewFlag,
      rule: llmFallback.learnedRule,
      ruleTrust: llmFallback.learnedRule?.state === 'active'
        ? 'active'
        : llmFallback.learnedRule?.state === 'provisional'
          ? 'provisional'
          : 'none',
    }
  }

  const unresolvedNote = joinNotes([parseError, llmFallback?.note])
  await withTransaction(async (db) => {
    await insertPendingPurchaseParseObservation(db, {
      inference: {
        parseError,
        parserSource: 'unresolved',
      },
      normalizedDistributorProductName,
      notes: unresolvedNote,
      observationStatus: 'captured',
      observationType: 'generation_parse',
      rawDistributorProductName: input.group.distributorProductName,
      rawRow: observationRawRow,
      rowInputSignature: input.rowInputSignature,
      sourceSystem: PENDING_PURCHASE_SOURCE_SYSTEM,
    })
  })

  return {
    brandProfile: null,
    note: unresolvedNote,
    parsed: null,
    parserSource: 'unresolved',
    reviewFlag: null,
    rule: null,
    ruleTrust: 'none',
  }
}

async function resolvePendingPurchaseDatabaseRule(
  distributorProductName: string,
): Promise<{
  brandProfile: PendingPurchaseBrandProfileRecord
  matchedAlias: string | null
  parsed: ParsedProductName
  rule: PendingPurchaseParseRuleRecord
} | null> {
  const normalizedDistributorProductName = normalizePendingPurchaseParserText(distributorProductName)
  const exactMatch = await findPendingPurchaseExactParseRule(getPool(), {
    normalizedName: normalizedDistributorProductName,
    sourceSystem: PENDING_PURCHASE_SOURCE_SYSTEM,
  })
  if (exactMatch) {
    const parsed = readParsedProductNameFromJson(exactMatch.rule.parsedOutput)
    if (parsed) {
      return {
        brandProfile: exactMatch.brandProfile,
        matchedAlias: null,
        parsed,
        rule: exactMatch.rule,
      }
    }
  }

  const aliasMatches = await listPendingPurchaseMatchingBrandAliases(getPool(), {
    aliasCandidates: buildPendingPurchaseBrandAliasCandidates(distributorProductName),
    normalizedName: normalizedDistributorProductName,
    sourceSystem: PENDING_PURCHASE_SOURCE_SYSTEM,
  })
  if (aliasMatches.length === 0) {
    return null
  }

  const profileById = new Map(aliasMatches.map((match) => [match.brandProfile.id, match.brandProfile]))
  const aliasByProfileId = new Map(aliasMatches.map((match) => [match.brandProfile.id, match.alias.aliasValue]))
  const runtimeRules = await listPendingPurchaseRuntimeRulesForProfiles(getPool(), {
    brandProfileIds: [...profileById.keys()],
  })
  for (const rule of runtimeRules) {
    if (!doesPendingPurchaseRuleMatchName(rule, distributorProductName, normalizedDistributorProductName)) {
      continue
    }
    const parsed = readParsedProductNameFromJson(rule.parsedOutput)
    const brandProfile = profileById.get(rule.brandProfileId)
    if (!parsed || !brandProfile) {
      continue
    }
    return {
      brandProfile,
      matchedAlias: aliasByProfileId.get(rule.brandProfileId) ?? null,
      parsed,
      rule,
    }
  }

  return null
}

function buildPendingPurchaseParserObservationRawRow(input: {
  group: PendingPositionGroup
  resolvedCost: ResolvedCost
  suggestionCandidates: SuggestedProductCandidate[]
}): Record<string, JsonValue> {
  return {
    distributorNames: [...input.group.distributorNames].sort(),
    distributorProductId: input.group.distributorProductId,
    distributorProductName: input.group.distributorProductName,
    effectiveUnitCost: input.resolvedCost.value,
    effectiveUnitCostReason: input.resolvedCost.reason,
    orderIds: [...input.group.orderIds].sort((left, right) => left - right),
    positionIds: input.group.positions.map((position) => position.id).sort((left, right) => left - right),
    sampleLike: input.group.positions.some((position) => isSampleLike(position)),
    siteDealerId: input.group.siteDealerId,
    siteKey: input.group.siteKey,
    suggestionCandidates: toJsonValue(input.suggestionCandidates),
  }
}

function doesPendingPurchaseRuleMatchName(
  rule: PendingPurchaseParseRuleRecord,
  distributorProductName: string,
  normalizedDistributorProductName: string,
): boolean {
  if (rule.ruleKind === 'prefix') {
    const normalizedPrefix = rule.normalizedMatchValue
      ?? readPendingPurchaseJsonString(rule.matchPayload, 'normalizedPrefix')
      ?? normalizePendingPurchaseParserText(readPendingPurchaseJsonString(rule.matchPayload, 'prefix') ?? '')
    return normalizedPrefix.length > 0 && normalizedDistributorProductName.startsWith(normalizedPrefix)
  }

  if (rule.ruleKind === 'regex') {
    const pattern = readPendingPurchaseJsonString(rule.matchPayload, 'pattern')
      ?? readPendingPurchaseJsonString(rule.matchPayload, 'regex')
    if (!pattern) {
      return false
    }
    try {
      return new RegExp(pattern, 'i').test(distributorProductName)
    } catch {
      return false
    }
  }

  if (rule.ruleKind === 'template') {
    const normalizedPrefix = normalizePendingPurchaseParserText(readPendingPurchaseJsonString(rule.matchPayload, 'prefix') ?? '')
    const normalizedSuffix = normalizePendingPurchaseParserText(readPendingPurchaseJsonString(rule.matchPayload, 'suffix') ?? '')
    if (normalizedPrefix.length > 0 && !normalizedDistributorProductName.startsWith(normalizedPrefix)) {
      return false
    }
    if (normalizedSuffix.length > 0 && !normalizedDistributorProductName.endsWith(normalizedSuffix)) {
      return false
    }
    return normalizedPrefix.length > 0 || normalizedSuffix.length > 0
  }

  return false
}

function readParsedProductNameFromJson(value: JsonValue): ParsedProductName | null {
  const parsed = ParsedProductNameSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

function readPendingPurchaseJsonString(value: JsonValue, key: string): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null
  }
  const rawValue = (value as Record<string, JsonValue>)[key]
  return typeof rawValue === 'string' && rawValue.trim().length > 0 ? rawValue.trim() : null
}

function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

function validatePendingPurchaseParsedOutput(parsed: ParsedProductName): string[] {
  const issues: string[] = []
  if (!AUTO_CLASSIFIABLE_PENDING_PURCHASE_CATEGORIES.has(parsed.category)) {
    issues.push('Unsupported category')
  }
  if (parsed.packCount > 1 && !/\dx\s+/i.test(parsed.variantTab)) {
    issues.push('Missing multi-pack variant tab')
  }
  if (!normalizePendingPurchaseParserText(parsed.variantName).includes(normalizePendingPurchaseParserText(parsed.brand))) {
    issues.push('Variant name does not include brand')
  }
  return issues
}

function isSafeToAutoPersistPendingPurchaseExactRule(input: {
  candidate: z.infer<typeof PendingPurchaseLlmExactNameRuleCandidateSchema>
  classification: z.infer<typeof PendingPurchaseLlmClassificationSchema>
  normalizedDistributorProductName: string
  parsed: ParsedProductName
  teachingRiskFlags: string[]
}): boolean {
  if (normalizePendingPurchaseParserText(input.candidate.rawName) !== input.normalizedDistributorProductName) {
    return false
  }
  if (input.classification.parserFeasibility !== 'easy-rule-based') {
    return false
  }
  if (input.classification.confidence < 0.88 || input.candidate.confidence < 0.9) {
    return false
  }
  if (validatePendingPurchaseParsedOutput(input.parsed).length > 0) {
    return false
  }
  for (const flag of [...input.classification.warningFlags, ...input.candidate.riskFlags, ...input.teachingRiskFlags]) {
    if (HIGH_RISK_LLM_RULE_FLAGS.has(flag)) {
      return false
    }
  }
  return input.candidate.safeAutoPersist || input.classification.confidence >= 0.94
}

async function buildGeneratedRow({
  cache,
  group,
  stateDistributorProductRow,
}: BuildRowContext): Promise<GeneratedPendingPurchaseRow> {
  const orderIds = [...group.orderIds].sort((left, right) => left - right)
  const positionIds = group.positions.map((position) => position.id).sort((left, right) => left - right)
  const resolvedCost = resolveEffectiveUnitCost(group.positions, stateDistributorProductRow)
  const sampleLike = group.positions.some((position) => isSampleLike(position))
  const suggestionCandidates = collectSuggestionCandidates(group.positions)
  const suggestionNote = formatSuggestionCandidateNote(suggestionCandidates)
  const existingDistributorLinks = describeExistingDistributorLinks(stateDistributorProductRow)
  const rowCacheKey = `${group.siteKey}:${group.distributorProductId}`
  const rowInputSignature = sha256(
    JSON.stringify({
      distributorProductId: group.distributorProductId,
      distributorProductName: group.distributorProductName,
      effectiveUnitCost: resolvedCost.value,
      orderIds,
      positionIds,
      sampleLike,
      siteDealerId: group.siteDealerId,
      siteKey: group.siteKey,
    }),
  )

  const parseResolution = await resolvePendingPurchaseParse({
    cache,
    group,
    resolvedCost,
    rowInputSignature,
    suggestionCandidates,
  })
  const parsed = parseResolution.parsed

  let reuse: LiveProductSummary | null = null
  let reuseReason: string | null = null
  if (stateDistributorProductRow?.productId) {
    reuse = await cache.getProductSummary(stateDistributorProductRow.productId)
    reuseReason = stateDistributorProductRow.productName
      ? `Current distributor product row ${stateDistributorProductRow.distributorProductId} already links to ${stateDistributorProductRow.productName}.`
      : `Current distributor product row ${stateDistributorProductRow.distributorProductId} already links to an existing variant.`
  } else if (parsed) {
    reuse = await exactReuseSummary(cache, group.distributorProductName, parsed)
    if (reuse) {
      reuseReason = `Exact live variant match found for ${reuse.productName}.`
    }
  }

  const anchors = parsed ? await familyAnchorProducts(cache, parsed) : []
  const anchorPrice = medianPrice(anchors)
  const primaryImage = reuse?.imageUrl ?? anchors.find((anchor) => anchor.imageUrl)?.imageUrl ?? null
  const currentDescription = reuse?.description ?? null
  const proposedDescription = null
  const proposedPrice = reuse?.price ?? recommendPendingPurchasePrice(resolvedCost.value, anchorPrice)
  const currentPrice = reuse?.price ?? anchorPrice ?? proposedPrice
  const currentPriceBasis = reuse
    ? 'exact live reuse'
    : anchorPrice !== null
      ? 'live family anchor'
      : proposedPrice !== null
        ? 'draft fallback'
        : null

  if (!parsed && !reuse) {
    return {
      actionType: 'needs-review',
      catalogAction: 'Review and classify this unresolved distributor product before proposing catalog create or mapping work.',
      currentDescription,
      currentPrice,
      currentPriceBasis,
      descriptionAction: 'needs-description-review',
      distributorProductId: group.distributorProductId,
      distributorProductName: group.distributorProductName,
      effectiveUnitCost: resolvedCost.value,
      effectiveUnitCostReason: resolvedCost.reason,
      effectiveUnitCostSource: resolvedCost.source,
      existingDistributorLinks,
      notes: joinNotes([
        parseResolution.note,
        reuseReason,
        resolvedCost.reason,
        suggestionNote,
      ]),
      orderIds,
      positionIds,
      primaryImageNote: primaryImage ? 'Borrowed from the nearest live family image because no first-class generated image pass exists yet.' : 'No live family image was available.',
      primaryImageSource: primaryImage ? 'live family anchor' : null,
      primaryImageUrl: primaryImage,
      publicSources: [],
      pricingAction: classifyPricingAction(currentPrice, proposedPrice),
      pricingReason: buildPricingReason({ anchorPrice, currentPriceBasis, proposedPrice, resolvedCost: resolvedCost.value }),
      proposedDescription,
      proposedPrice,
      reviewerNotes: joinNotes([
        parseResolution.note,
        reuseReason,
        resolvedCost.reason,
        suggestionNote,
      ]),
      reviewFlags: compactStrings([
        'Needs manual classification',
        proposedPrice === null ? 'Needs manual price' : null,
        !primaryImage ? 'Needs image review' : null,
        parseResolution.reviewFlag,
      ]),
      parserBrandProfileId: parseResolution.brandProfile?.id ?? null,
      parserRuleId: parseResolution.rule?.id ?? null,
      parserRuleState: parseResolution.rule?.state ?? null,
      parserSource: parseResolution.parserSource,
      parserTrustLevel: parseResolution.ruleTrust,
      rowCacheKey,
      rowInputSignature,
      sampleLike,
      siteDealerId: group.siteDealerId,
      siteDealerName: group.siteDealerName,
      siteKey: group.siteKey,
      siteLabel: group.siteLabel,
      suggestionCandidates,
      targetBrand: '',
      targetGroupName: '',
      targetPackCount: null,
      targetPrevalence: '',
      targetSize: '',
      targetStrain: '',
      targetVariantName: group.distributorProductName,
      targetVariantTab: '',
      unresolvedReason: 'Name parser could not confidently classify this distributor product.',
    }
  }

  const target = reuse ?? {
    allowedSaleType: 'Medical and recreational',
    brand: parsed?.brand ?? '',
    category: parsed?.category ?? '',
    description: null,
    groupId: null,
    groupName: parsed?.groupName ?? '',
    imageUrl: primaryImage,
    packCount: parsed?.packCount ?? 1,
    price: proposedPrice,
    productId: null,
    productName: parsed?.variantName ?? group.distributorProductName,
    size: parsed?.size ?? '',
    strain: parsed?.strainName ?? '',
    subcategory: parsed?.subcategory ?? '',
    tab: parsed?.variantTab ?? '',
  }
  const pricingSupport = await cache.getPendingPurchasePricingSupport({
    brand: target.brand,
    category: target.category,
    currentPrice,
    groupName: target.groupName || target.productName,
    subcategory: normalizeNonEmptyString(target.subcategory),
    variantName: target.productName,
    variantTab: target.tab,
    wholesaleCost: resolvedCost.value,
  })
  const publicSources = [...new Set(
    (pricingSupport.evidence?.matchedListings ?? [])
      .map((listing) => normalizeNonEmptyString(listing.url))
      .filter((url): url is string => url !== null),
  )]

  const actionType = reuse ? 'mapping-only' : 'catalog-create'
  const catalogAction = reuse
    ? `Map existing purchase distributor product ${group.distributorProductId} onto existing variant ${target.productName} and avoid creating a duplicate catalog row.`
    : `Create new ${target.productName} under ${target.category}${target.subcategory ? ` / ${target.subcategory}` : ''}, then link the existing purchase distributor product to the created variant.`
  const pricingReason = buildPricingReason({
    anchorPrice,
    currentPriceBasis,
    proposedPrice,
    resolvedCost: resolvedCost.value,
  })
  const reviewerNotes = joinNotes([
    parseResolution.note,
    reuseReason,
    resolvedCost.reason,
    !reuse && anchors.length > 0
      ? `Family anchor median uses ${anchors.length} live ${target.brand} row${anchors.length === 1 ? '' : 's'} in the same size/category lane.`
      : null,
    suggestionNote,
  ])
  const reviewFlags = compactStrings([
    parseResolution.reviewFlag,
    !reuse && proposedDescription === null ? 'Needs description review' : null,
    proposedPrice === null ? 'Needs manual price' : null,
    !reuse && anchors.length === 0 ? 'No live family anchor' : null,
    !primaryImage ? 'Needs image review' : null,
    pricingSupport.marketAvailability === 'error' ? 'Pricing evidence lookup failed' : null,
  ])

  return {
    actionType,
    allowedSaleType: target.allowedSaleType,
    anchorPrice,
    averageCompetitorPostTaxPrice: pricingSupport.evidence?.averagePostTaxPrice ?? null,
    averageCompetitorPrice: pricingSupport.evidence?.averagePreTaxPrice ?? null,
    catalogAction,
    competitorMedianPostTaxPrice: pricingSupport.evidence?.medianPostTaxPrice ?? null,
    currentDescription,
    currentGmPercent: computeGmPercent(resolvedCost.value, currentPrice),
    currentPrice,
    currentPriceBasis,
    descriptionAction: reuse ? 'reuse-live-catalog' : 'needs-description-review',
    distributorProductId: group.distributorProductId,
    distributorProductName: group.distributorProductName,
    effectiveUnitCost: resolvedCost.value,
    effectiveUnitCostReason: resolvedCost.reason,
    effectiveUnitCostSource: resolvedCost.source,
    expectedCategory: target.category,
    expectedSubcategory: target.subcategory,
    existingDistributorLinks,
    gmPercent: computeGmPercent(resolvedCost.value, proposedPrice),
    marketAdvicePosture: pricingSupport.marketAvailability,
    marketAdviceSummary: pricingSupport.marketNote,
    marketNote: pricingSupport.marketNote,
    marketSearchTerm: pricingSupport.marketSearchTerm,
    notes: reviewerNotes,
    orderIds,
    positionIds,
    pricingEvidenceNote: pricingSupport.marketNote,
    pricingMarketEvidence: pricingSupport.evidence ? toJsonValue(pricingSupport.evidence) : null,
    primaryImageNote: primaryImage
      ? reuse
        ? 'Primary image comes from the live exact reusable variant.'
        : 'Primary image comes from the nearest live family anchor.'
      : 'No live reusable or family image was available.',
    primaryImageSource: primaryImage
      ? reuse
        ? 'exact live reuse'
        : 'live family anchor'
      : null,
    primaryImageUrl: primaryImage,
    publicSources,
    pricingAction: classifyPricingAction(currentPrice, proposedPrice),
    pricingReason,
    parserBrandProfileId: parseResolution.brandProfile?.id ?? null,
    parserRuleId: parseResolution.rule?.id ?? null,
    parserRuleState: parseResolution.rule?.state ?? null,
    parserSource: parseResolution.parserSource,
    parserTrustLevel: parseResolution.ruleTrust,
    proposedDescription,
    proposedPrice,
    reviewFlags,
    reviewerNotes,
    reuseGroupId: reuse?.groupId ?? null,
    reuseProductId: reuse?.productId ?? null,
    reuseProductName: reuse?.productName ?? '',
    rowCacheKey,
    rowInputSignature,
    sampleLike,
    siteDealerId: group.siteDealerId,
    siteDealerName: group.siteDealerName,
    siteKey: group.siteKey,
    siteLabel: group.siteLabel,
    suggestionCandidates,
    stateDistributorProductId: stateDistributorProductRow?.distributorProductId ?? null,
    targetBrand: target.brand,
    targetGroupName: target.groupName,
    targetPackCount: target.packCount,
    targetPrevalence: reuse?.strain ? null : parsed?.prevalence ?? null,
    targetSize: target.size,
    targetStrain: reuse?.strain ?? parsed?.strainName ?? '',
    targetVariantName: target.productName,
    targetVariantTab: target.tab,
  }
}

async function listOutstandingOrders(dealerId: number, fromDate: string, toDate: string): Promise<Array<{ id: number }>> {
  const orders: Array<{ id: number }> = []
  let page = 1
  const pageSize = 50

  while (true) {
    const response = PurchaseOrderListResponseSchema.parse(
      await callSweedRpc(dealerId, 'store.purchase.order.list', {
        fromDate,
        orderStatusId: 2,
        page,
        pageSize,
        toDate,
      }),
    )

    orders.push(...response.data.map((row) => ({ id: row.id })))
    if (orders.length >= response.totalCount || response.data.length < pageSize) {
      return orders
    }
    page += 1
  }
}

async function findExactDistributorProductRow(group: PendingPositionGroup): Promise<ExactDistributorProductRow | null> {
  const env = getWorkerEnv()
  const response = DistributorProductListSchema.parse(
    await callSweedRpc(env.sweedStateDealerId, 'store.distributor.product.list', {
      page: 1,
      pageSize: 100,
      query: group.distributorProductName,
    }),
  )

  const exactRows = response.data.filter((row) => {
    const rowName = normalizeNonEmptyString(row.name)
    if (rowName !== group.distributorProductName) {
      return false
    }
    const rowDistributorName = normalizeNonEmptyString(row.distributor?.name)
    if (!rowDistributorName) {
      return false
    }
    for (const distributorName of group.distributorNames) {
      if (sameDistributorName(rowDistributorName, distributorName)) {
        return true
      }
    }
    return false
  })

  let expectedRow: z.infer<typeof DistributorProductListSchema>['data'][number] | null = null
  for (const row of exactRows) {
    if (String(row.id) === group.distributorProductId) {
      expectedRow = row
      const productName = normalizeNonEmptyString(row.product?.name)
      if (row.product?.id && !GENERIC_PLACEHOLDER_PRODUCT_NAMES.has(normalizeText(productName))) {
        return {
          distributorName: normalizeNonEmptyString(row.distributor?.name),
          distributorProductId: row.id,
          name: normalizeNonEmptyString(row.name),
          price: normalizePrice(row.price),
          productId: row.product.id,
          productName,
        }
      }
      break
    }
  }

  for (const row of exactRows) {
    const productName = normalizeNonEmptyString(row.product?.name)
    if (!row.product?.id || GENERIC_PLACEHOLDER_PRODUCT_NAMES.has(normalizeText(productName))) {
      continue
    }
    return {
      distributorName: normalizeNonEmptyString(row.distributor?.name),
      distributorProductId: row.id,
      name: normalizeNonEmptyString(row.name),
      price: normalizePrice(row.price),
      productId: row.product.id,
      productName,
    }
  }

  if (!expectedRow) {
    return null
  }

  return {
    distributorName: normalizeNonEmptyString(expectedRow.distributor?.name),
    distributorProductId: expectedRow.id,
    name: normalizeNonEmptyString(expectedRow.name),
    price: normalizePrice(expectedRow.price),
    productId: null,
    productName: null,
  }
}

async function exactReuseSummary(
  cache: CatalogCache,
  distributorProductName: string,
  parsed: ParsedProductName,
): Promise<LiveProductSummary | null> {
  const exactProductId = EXACT_REUSE_PRODUCT_IDS.get(distributorProductName)
  if (exactProductId) {
    return cache.getProductSummary(exactProductId)
  }

  const exactCompact = compactText(parsed.variantName)
  const rows = await cache.searchProducts(parsed.variantName)
  for (const row of rows) {
    if (compactText(row.name) === exactCompact) {
      return cache.getProductSummary(row.id)
    }
  }
  return null
}

async function familyAnchorProducts(cache: CatalogCache, parsed: ParsedProductName): Promise<LiveProductSummary[]> {
  const rows = await cache.searchProducts(parsed.brand)
  const anchors: LiveProductSummary[] = []

  for (const row of rows) {
    const summary = await cache.getProductSummary(row.id)
    if (summary.category !== parsed.category) {
      continue
    }
    if ((summary.subcategory || '') !== parsed.subcategory) {
      continue
    }
    if (summary.size !== parsed.size) {
      continue
    }
    if ((summary.packCount || 1) !== parsed.packCount) {
      continue
    }
    anchors.push(summary)
  }

  return anchors
}

function resolveEffectiveUnitCost(
  positions: z.infer<typeof PurchaseOrderPositionSchema>[],
  stateDistributorProductRow: ExactDistributorProductRow | null,
): ResolvedCost {
  for (const position of positions) {
    const directCost = normalizePrice(position.discountProductPrice)
    if (directCost !== null && directCost > 0.05) {
      return {
        reason: 'Effective cost comes from the live purchase unit price on a paid companion line.',
        source: 'purchase-order',
        value: directCost,
      }
    }

    const metrcCost = readMetrcUnitCost(position)
    if (metrcCost !== null && metrcCost > 0.05) {
      return {
        reason: 'Effective cost comes from live Metrc wholesale on a paid companion line.',
        source: 'purchase-order-metrc',
        value: metrcCost,
      }
    }
  }

  const distributorProductPrice = stateDistributorProductRow?.price ?? null
  if (distributorProductPrice !== null) {
    return {
      reason: `Falling back to existing distributor-product price on row ${stateDistributorProductRow?.distributorProductId ?? 'unknown'}.`,
      source: 'distributor-product',
      value: distributorProductPrice,
    }
  }

  for (const position of positions) {
    const directCost = normalizePrice(position.discountProductPrice)
    if (directCost !== null) {
      return {
        reason: 'Only nominal sample pricing was visible on the live purchase row, so the packet keeps that as a weak cost reference.',
        source: 'sample-reference',
        value: directCost,
      }
    }

    const metrcCost = readMetrcUnitCost(position)
    if (metrcCost !== null) {
      return {
        reason: 'Only nominal Metrc wholesale was visible on the live purchase row, so the packet keeps that as a weak cost reference.',
        source: 'sample-reference-metrc',
        value: metrcCost,
      }
    }
  }

  return {
    reason: 'Current live purchase rows did not expose a usable wholesale cost, and no linked distributor-product price was available.',
    source: null,
    value: null,
  }
}

function recommendPendingPurchasePrice(cost: number | null, anchorPrice: number | null): number | null {
  if (anchorPrice !== null && cost !== null) {
    return roundToHalf(Math.max(anchorPrice, minimumGmFloorPrice(cost)))
  }
  if (anchorPrice !== null) {
    return roundToHalf(anchorPrice)
  }
  if (cost !== null) {
    return roundToHalf(minimumGmFloorPrice(cost))
  }
  return null
}

function buildPricingReason(input: {
  anchorPrice: number | null
  currentPriceBasis: string | null
  proposedPrice: number | null
  resolvedCost: number | null
}): string | null {
  const parts = compactStrings([
    input.currentPriceBasis ? `Current price basis: ${input.currentPriceBasis}.` : null,
    input.anchorPrice !== null ? `Live family anchor median: ${formatCurrency(input.anchorPrice)}.` : null,
    input.resolvedCost !== null
      ? `Cost basis: ${formatCurrency(input.resolvedCost)} with a 55% GM floor of ${formatCurrency(minimumGmFloorPrice(input.resolvedCost))}.`
      : 'Cost basis is unresolved, so this price is only a soft draft.',
    input.proposedPrice !== null ? `Draft proposal: ${formatCurrency(input.proposedPrice)}.` : null,
  ])
  return parts.length > 0 ? parts.join(' ') : null
}

function buildPacketTitle(
  sites: HeliosPendingPurchaseSiteDealer[],
  fromDate: string,
  toDate: string,
): string {
  const siteLabel = sites.length === 1 ? `${sites[0].siteLabel} ` : ''
  return `${siteLabel}Pending Catalog Update Proposal (${fromDate} to ${toDate})`
}

function buildPacketSummary(
  rows: GeneratedPendingPurchaseRow[],
  orders: PendingOrderSummary[],
  fromDate: string,
  toDate: string,
): Record<string, unknown> {
  const actionCounts: Record<string, number> = {}
  const siteCounts: Record<string, number> = {}
  let sampleLikeCount = 0

  for (const row of rows) {
    const actionType = typeof row.actionType === 'string' ? row.actionType : 'unknown'
    actionCounts[actionType] = (actionCounts[actionType] ?? 0) + 1
    const siteKey = typeof row.siteKey === 'string' ? row.siteKey : 'unknown'
    siteCounts[siteKey] = (siteCounts[siteKey] ?? 0) + 1
    if (row.sampleLike === true) {
      sampleLikeCount += 1
    }
  }

  return {
    actionCounts,
    fromDate,
    orderCount: orders.length,
    rowCount: rows.length,
    sampleLikeCount,
    siteCounts,
    toDate,
  }
}

function resolveSites(siteDealerIds: number[]): HeliosPendingPurchaseSiteDealer[] {
  const normalizedSiteDealerIds = normalizeHeliosPendingPurchaseSiteDealerIds(siteDealerIds)
  const effectiveDealerIds = normalizedSiteDealerIds.length > 0
    ? normalizedSiteDealerIds
    : [210249, 210705]

  return effectiveDealerIds
    .map((dealerId) => getHeliosPendingPurchaseSiteDealer(dealerId))
    .filter((site): site is HeliosPendingPurchaseSiteDealer => site !== null)
}

export function parseProductName(name: string): ParsedProductName {
  const normalized = name.trim()
  const lowered = normalized.toLowerCase()
  if (normalized.startsWith('Pr(') || normalized.startsWith('F(') || normalized.startsWith('V(')) {
    return normalizeAndValidateParsedProductName(parseCuraleafName(normalized), normalized)
  }
  if (lowered.startsWith('bytes')) {
    return normalizeAndValidateParsedProductName(parseBytesName(normalized), normalized)
  }
  if (lowered.startsWith('outrankd')) {
    return normalizeAndValidateParsedProductName(parseOutrankdName(normalized), normalized)
  }
  if (lowered.startsWith('the gram')) {
    return normalizeAndValidateParsedProductName(parseTheGramName(normalized), normalized)
  }
  if (lowered.startsWith('moonlit-')) {
    return normalizeAndValidateParsedProductName(parseMoonlitName(normalized), normalized)
  }
  if (lowered.startsWith('smartbud')) {
    return normalizeAndValidateParsedProductName(parseSmartbudName(normalized), normalized)
  }
  if (normalized.startsWith('1O-PR-H26-')) {
    return normalizeAndValidateParsedProductName(parseHerbCodeName(normalized), normalized)
  }
  if (lowered.startsWith("jenny's") || lowered.startsWith('jennys ')) {
    return normalizeAndValidateParsedProductName(parseJennysName(normalized), normalized)
  }
  if (lowered.startsWith('posh puff')) {
    return normalizeAndValidateParsedProductName(parsePoshPuffName(normalized), normalized)
  }
  if (lowered.startsWith('layup')) {
    return normalizeAndValidateParsedProductName(parseLayUpName(normalized), normalized)
  }
  if (lowered.startsWith('cannabals')) {
    return normalizeAndValidateParsedProductName(parseCannabalsName(normalized), normalized)
  }
  return normalizeAndValidateParsedProductName(parseHrBotanicalName(normalized), normalized)
}

async function classifyPendingPurchaseNameWithLlmFallback(input: {
  cache: CatalogCache
  group: PendingPositionGroup
  resolvedCost: ResolvedCost
  rowInputSignature: string
  suggestionCandidates: SuggestedProductCandidate[]
}): Promise<PendingPurchaseLlmFallbackResult | null> {
  const env = getWorkerEnv()
  if (!env.bedrockMantleBearerToken) {
    return null
  }

  try {
    const anchors = await findPendingPurchaseLlmAnchors(input.cache, input.group.distributorProductName)
    const normalizedDistributorProductName = normalizePendingPurchaseParserText(input.group.distributorProductName)
    const observationRawRow = buildPendingPurchaseParserObservationRawRow(input)
    const response = await fetch(`${env.bedrockMantleBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.bedrockMantleBearerToken}`,
      },
      body: JSON.stringify({
        model: 'google.gemma-3-27b-it',
        temperature: 0.1,
        max_tokens: 1200,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: [
              'You classify a single unresolved Freshly Baked NYC pending-purchase row into a strict catalog taxonomy and teach reusable parsing knowledge.',
              'Return only valid JSON with the exact top-level shape {"classification": {...}, "teaching": {...}}.',
              'The classification object must include: brand, category, subcategory, groupName, variantName, variantTab, size, packCount, strainName, prevalence, confidence, parserFeasibility, rationale, warningFlags.',
              'The teaching object must include: brandAliases, exactNameRules, generalizedRules, riskFlags.',
              'Each brandAliases item must include: aliasType, aliasValue, confidence, rationale, riskFlags.',
              'Each exactNameRules item must include: rawName, confidence, rationale, safeAutoPersist, riskFlags.',
              'Each generalizedRules item must include: ruleKind, normalizedMatchValue, matchPayload, confidence, rationale, riskFlags.',
              'Use parserFeasibility only from: easy-rule-based, needs-more-context, likely-llm-only.',
              'Use null for subcategory or prevalence when not applicable.',
              'Use aliasType only from: exact, prefix.',
              'Use ruleKind only from: prefix, regex, template.',
              'Never use generic words like Beverage, Vape, or Gummy Brick by themselves as the full groupName when a flavor, cultivar, or family differentiator is present.',
              'If live anchor examples for the same brand and family are provided, follow their packCount, size, and variantTab pattern unless the raw input clearly contradicts them.',
              'For beverage and edible flavors, strainName is usually empty unless the name clearly represents a cultivar lane.',
              'Keep canonical naming customer-facing and normalized instead of copying raw punctuation.',
              'Only mark safeAutoPersist true for narrow exact-name reuse on the exact raw row, never for broad generalized rules.',
              'If you suggest a broader prefix, regex, or template rule, be conservative and include a risk flag unless it is very clearly safe.',
            ].join(' '),
          },
          {
            role: 'user',
            content: JSON.stringify({
              row: {
                distributorProductName: input.group.distributorProductName,
                distributorProductId: input.group.distributorProductId,
                distributorNames: [...input.group.distributorNames].sort(),
                orderIds: [...input.group.orderIds].sort((left, right) => left - right),
                positionIds: input.group.positions.map((position) => position.id).sort((left, right) => left - right),
                resolvedCost: input.resolvedCost.value,
                resolvedCostReason: input.resolvedCost.reason,
                sampleLike: input.group.positions.some((position) => isSampleLike(position)),
                suggestionCandidates: input.suggestionCandidates,
              },
              taxonomyHints: {
                categories: [...AUTO_CLASSIFIABLE_PENDING_PURCHASE_CATEGORIES].sort(),
                variantNameRule: 'Usually <Brand> <GroupName> <VariantTab>',
              },
              liveAnchors: anchors,
            }, null, 2),
          },
        ],
      }),
      signal: AbortSignal.timeout(env.llmRequestTimeoutMs),
    })

    const rawResponseText = await response.text()
    if (!response.ok) {
      return {
        brandProfile: null,
        learnedRule: null,
        note: `Bedrock fallback classification failed with HTTP ${response.status}; keeping manual review.`,
        parsed: null,
        parserSource: 'llm-teacher',
        reviewFlag: null,
      }
    }

    const content = extractChatCompletionContent(rawResponseText)
    const parsedEnvelope = PendingPurchaseLlmTeachingEnvelopeSchema.parse(JSON.parse(content))
    const normalizedClassification = normalizePendingPurchaseLlmClassification(parsedEnvelope.classification)
    if (!normalizedClassification) {
      await withTransaction(async (db) => {
        await insertPendingPurchaseParseObservation(db, {
          inference: toJsonValue({
            classification: parsedEnvelope.classification,
            parserSource: 'llm-teacher',
            teaching: parsedEnvelope.teaching,
          }),
          normalizedDistributorProductName,
          notes: 'Bedrock teacher classification returned a shape that is still too risky for automatic parser reuse.',
          observationStatus: 'captured',
          observationType: 'llm_inference',
          rawDistributorProductName: input.group.distributorProductName,
          rawRow: observationRawRow,
          rowInputSignature: input.rowInputSignature,
          sourceSystem: PENDING_PURCHASE_SOURCE_SYSTEM,
        })
      })
      return {
        brandProfile: null,
        learnedRule: null,
        note: 'Bedrock fallback classification returned a shape that is still too risky for auto-classification; keeping manual review.',
        parsed: null,
        parserSource: 'llm-teacher',
        reviewFlag: null,
      }
    }

    const profileAndRule = await withTransaction(async (db) => {
      const brandProfile = await upsertPendingPurchaseBrandProfile(db, {
        displayBrandName: normalizedClassification.brand,
        metadata: {
          learnedBy: 'llm-teacher',
          sourceDistributorProductName: input.group.distributorProductName,
        },
        normalizedBrandKey: derivePendingPurchaseBrandKey(normalizedClassification.brand),
        sourceSystem: PENDING_PURCHASE_SOURCE_SYSTEM,
        taxonomyHints: {
          category: normalizedClassification.category,
          subcategory: normalizedClassification.subcategory || null,
        },
      })

      await upsertPendingPurchaseBrandAlias(db, {
        aliasType: 'exact',
        aliasValue: normalizedClassification.brand,
        brandProfileId: brandProfile.id,
        confidence: parsedEnvelope.classification.confidence,
        metadata: { learnedBy: 'llm-teacher', rationale: parsedEnvelope.classification.rationale },
        provenance: 'llm-teacher',
        status: 'provisional',
      })

      for (const alias of parsedEnvelope.teaching.brandAliases) {
        await upsertPendingPurchaseBrandAlias(db, {
          aliasType: alias.aliasType,
          aliasValue: alias.aliasValue,
          brandProfileId: brandProfile.id,
          confidence: alias.confidence,
          metadata: { rationale: alias.rationale, riskFlags: alias.riskFlags },
          provenance: 'llm-teacher',
          status: alias.aliasType === 'exact' && alias.confidence >= 0.85 && alias.riskFlags.every((flag) => !HIGH_RISK_LLM_RULE_FLAGS.has(flag))
            ? 'provisional'
            : 'draft',
        })
      }

      const exactCandidates = parsedEnvelope.teaching.exactNameRules.length > 0
        ? parsedEnvelope.teaching.exactNameRules
        : [{
            confidence: parsedEnvelope.classification.confidence,
            rationale: parsedEnvelope.classification.rationale,
            rawName: input.group.distributorProductName,
            riskFlags: parsedEnvelope.teaching.riskFlags,
            safeAutoPersist: false,
          }]
      let learnedRule: PendingPurchaseParseRuleRecord | null = null

      for (const candidate of exactCandidates) {
        const ruleState = isSafeToAutoPersistPendingPurchaseExactRule({
          candidate,
          classification: parsedEnvelope.classification,
          normalizedDistributorProductName,
          parsed: normalizedClassification,
          teachingRiskFlags: parsedEnvelope.teaching.riskFlags,
        })
          ? 'provisional'
          : 'draft'
        const rule = await upsertPendingPurchaseParseRule(db, {
          brandProfileId: brandProfile.id,
          confidence: candidate.confidence,
          matchPayload: toJsonValue({
            rawName: candidate.rawName,
            rationale: candidate.rationale,
          }),
          normalizedMatchValue: normalizePendingPurchaseParserText(candidate.rawName),
          parsedOutput: toJsonValue(normalizedClassification),
          provenance: 'llm-teacher',
          riskFlags: candidate.riskFlags,
          ruleFingerprint: buildPendingPurchaseParseRuleFingerprint({
            brandProfileNormalizedKey: brandProfile.normalizedBrandKey,
            matchPayload: toJsonValue({ rawName: candidate.rawName }),
            normalizedMatchValue: normalizePendingPurchaseParserText(candidate.rawName),
            parsedOutput: toJsonValue(normalizedClassification),
            ruleKind: 'exact_name',
            sourceSystem: PENDING_PURCHASE_SOURCE_SYSTEM,
          }),
          ruleKind: 'exact_name',
          source: 'llm-teacher',
          state: ruleState,
          validation: {
            localValidationIssues: validatePendingPurchaseParsedOutput(normalizedClassification),
            teacherRationale: candidate.rationale,
          },
        })
        if (learnedRule === null || (learnedRule.state !== 'provisional' && rule.state === 'provisional')) {
          learnedRule = rule
        }
      }

      for (const candidate of parsedEnvelope.teaching.generalizedRules) {
        await upsertPendingPurchaseParseRule(db, {
          brandProfileId: brandProfile.id,
          confidence: candidate.confidence,
          matchPayload: toJsonValue(candidate.matchPayload),
          normalizedMatchValue: candidate.normalizedMatchValue ?? null,
          parsedOutput: toJsonValue(normalizedClassification),
          provenance: 'llm-teacher',
          riskFlags: candidate.riskFlags,
          ruleFingerprint: buildPendingPurchaseParseRuleFingerprint({
            brandProfileNormalizedKey: brandProfile.normalizedBrandKey,
            matchPayload: toJsonValue(candidate.matchPayload),
            normalizedMatchValue: candidate.normalizedMatchValue ?? null,
            parsedOutput: toJsonValue(normalizedClassification),
            ruleKind: candidate.ruleKind,
            sourceSystem: PENDING_PURCHASE_SOURCE_SYSTEM,
          }),
          ruleKind: candidate.ruleKind,
          source: 'llm-teacher',
          state: 'draft',
          validation: {
            teacherRationale: candidate.rationale,
          },
        })
      }

      await insertPendingPurchaseParseObservation(db, {
        brandProfileId: brandProfile.id,
        inference: toJsonValue({
          classification: parsedEnvelope.classification,
          learnedRuleId: learnedRule?.id ?? null,
          parserSource: 'llm-teacher',
          teaching: parsedEnvelope.teaching,
        }),
        normalizedDistributorProductName,
        notes: parsedEnvelope.classification.rationale,
        observationStatus: learnedRule?.state === 'provisional' ? 'accepted' : 'captured',
        observationType: 'llm_inference',
        parseRuleId: learnedRule?.id ?? null,
        rawDistributorProductName: input.group.distributorProductName,
        rawRow: observationRawRow,
        rowInputSignature: input.rowInputSignature,
        sourceSystem: PENDING_PURCHASE_SOURCE_SYSTEM,
      })

      return { brandProfile, learnedRule }
    })

    const warningText = parsedEnvelope.classification.warningFlags.length > 0
      ? ` Warnings: ${parsedEnvelope.classification.warningFlags.join('; ')}.`
      : ''
    const learningText = profileAndRule.learnedRule?.state === 'provisional'
      ? ' Auto-learned a provisional exact-name parse rule for this row.'
      : ' Stored reusable parsing observations for later corroboration.'
    return {
      brandProfile: profileAndRule.brandProfile,
      learnedRule: profileAndRule.learnedRule,
      note: `Bedrock teacher classification used after parser failure (confidence ${parsedEnvelope.classification.confidence.toFixed(2)}; ${parsedEnvelope.classification.rationale}).${warningText}${learningText}`,
      parsed: normalizedClassification,
      parserSource: 'llm-teacher',
      reviewFlag: profileAndRule.learnedRule?.state === 'provisional'
        ? 'Auto-learned provisional parse rule'
        : 'LLM teacher classification',
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error'
    return {
      brandProfile: null,
      learnedRule: null,
      note: `Bedrock fallback classification failed (${message}); keeping manual review.`,
      parsed: null,
      parserSource: 'llm-teacher',
      reviewFlag: null,
    }
  }
}

async function findPendingPurchaseLlmAnchors(
  cache: CatalogCache,
  distributorProductName: string,
): Promise<Array<Record<string, unknown>>> {
  const nameParts = distributorProductName.split(/\s*-\s*/).map((part) => part.trim()).filter((part) => part.length > 0)
  const brandGuess = nameParts[0] ?? distributorProductName
  const familyTokens = extractPendingPurchaseFamilyTokens(distributorProductName)
  const rows = await cache.searchProducts(brandGuess)
  const scored: Array<{ score: number; summary: LiveProductSummary }> = []

  for (const row of rows) {
    const summary = await cache.getProductSummary(row.id)
    if (normalizeText(summary.brand) !== normalizeText(brandGuess)) {
      continue
    }
    const score = scorePendingPurchaseAnchor(summary, familyTokens)
    if (score <= 0) {
      continue
    }
    scored.push({ score, summary })
  }

  return scored
    .sort((left, right) => right.score - left.score || left.summary.productName.localeCompare(right.summary.productName))
    .slice(0, 5)
    .map(({ summary }) => ({
      brand: summary.brand,
      category: summary.category,
      groupName: summary.groupName,
      packCount: summary.packCount,
      price: summary.price,
      productName: summary.productName,
      size: summary.size,
      strain: summary.strain,
      subcategory: summary.subcategory || null,
      tab: summary.tab,
    }))
}

function normalizePendingPurchaseLlmClassification(
  classification: z.infer<typeof PendingPurchaseLlmClassificationSchema>,
): ParsedProductName | null {
  if (!AUTO_CLASSIFIABLE_PENDING_PURCHASE_CATEGORIES.has(classification.category)) {
    return null
  }
  if (classification.confidence < 0.8) {
    return null
  }
  if (classification.parserFeasibility === 'needs-more-context') {
    return null
  }

  const normalizedSize = normalizeSizeText(classification.size) ?? classification.size
  const repairedTab = normalizeNonEmptyString(classification.variantTab)
    ?? (classification.packCount > 1 ? `${classification.packCount}x ${normalizedSize}` : normalizedSize)

  const draft: ParsedProductName = {
    brand: classification.brand,
    category: classification.category,
    groupName: classification.groupName,
    packCount: classification.packCount,
    prevalence: normalizeNonEmptyString(classification.prevalence),
    searchTerm: classification.groupName,
    size: normalizedSize,
    strainName: normalizeNonEmptyString(classification.strainName) ?? '',
    subcategory: normalizeNonEmptyString(classification.subcategory) ?? '',
    variantName: classification.variantName,
    variantTab: repairedTab,
  }

  try {
    return normalizeAndValidateParsedProductName(draft, classification.variantName)
  } catch {
    return null
  }
}

function parseHrBotanicalName(name: string): ParsedProductName {
  const cleaned = name.replace('#JUAN-ROLL', '#Juan Roll').replace('Pre-roll', 'Preroll')
  const lowered = cleaned.toLowerCase()

  let brand: string
  if (cleaned.startsWith('#Juan Roll')) {
    brand = '#Juan Roll'
  } else if (cleaned.startsWith('Revert ')) {
    brand = 'Revert Cannabis'
  } else if (cleaned.startsWith('Ichi Roll')) {
    brand = 'Ichi Roll'
  } else if (cleaned.startsWith('Chopsticks') || cleaned.startsWith('Chopstix')) {
    brand = 'Chopsticks'
  } else if (cleaned.startsWith('O-Yeah')) {
    brand = 'O-YEAH!'
  } else if (cleaned.startsWith('SMACK')) {
    brand = 'Smack'
  } else if (cleaned.startsWith('STATE OF MIND') || cleaned.startsWith('State of Mind')) {
    brand = 'State of Mind'
  } else if (cleaned.startsWith('Sushi Hash')) {
    brand = 'Sushi Hash'
  } else {
    throw new Error(`Unhandled HR Botanical product name: ${name}`)
  }

  const prevalence = derivePrevalence(cleaned)
  const isInfused = !lowered.includes('uninfused') && ['infused', 'live resin', 'rosin', 'hash hole'].some((token) => lowered.includes(token))
  const isRevertGummy = cleaned.startsWith('Revert Edible Gummy ')
  const category = isRevertGummy ? 'Edibles' : 'Pre-Rolls'
  const subcategory = isRevertGummy ? 'Chews/Gummies' : isInfused ? 'Infused' : ''

  let packCount = 1
  let size = isRevertGummy ? '100mg' : '1g'
  if (/\b4\s*pk|4-pack|4pk\b/i.test(cleaned)) {
    packCount = 4
    size = '1g'
  } else if (/\b5[-\s]*pack|5pk\b/i.test(cleaned)) {
    packCount = 5
    size = '0.5g'
  } else if (/\b2\s*pack|2-pack\b/i.test(cleaned)) {
    packCount = 2
    size = '0.5g'
  } else if (/\.5g|0\.5g/i.test(cleaned)) {
    size = '0.5g'
  }

  let cultivarSource = cleaned
  if (cleaned.includes('|')) {
    const parts = cleaned.split('|').map((part) => part.trim()).filter((part) => part.length > 0)
    cultivarSource = parts[parts.length - 1] ?? cleaned
  } else if (isRevertGummy) {
    cultivarSource = cleaned.replace(/^Revert Edible Gummy\s+/i, '').replace(/\s+100mg$/i, '')
  } else if (brand === 'Revert Cannabis' && cleaned.includes('Ground Flower Pre Roll 2 Pack')) {
    cultivarSource = cleaned.replace(/^Revert Distillate Infused Ground Flower Pre Roll 2 Pack\s+/i, '')
  } else if (brand === 'Revert Cannabis' && cleaned.includes('Pre Roll')) {
    cultivarSource = cleaned.replace(/^Revert Pre Roll\s+/i, '').replace(/\s+(?:\.5g|0\.5g)$/i, '')
  } else if ((brand === '#Juan Roll' || brand === 'Ichi Roll') && cleaned.includes('-')) {
    const parts = cleaned.split('-')
    cultivarSource = parts[parts.length - 1] ?? cleaned
  } else if (brand === 'Chopsticks') {
    cultivarSource = cleaned.replace(/^.*?2-Pack\s+/i, '')
  } else if (brand === 'O-YEAH!') {
    cultivarSource = cleaned.replace(/^.*?\(2\.5g\)\s*/i, '')
  } else if (brand === 'Smack') {
    cultivarSource = cleaned.replace(/^.*?(?:Preroll|Pre-Roll)\s+/i, '')
  } else if (brand === 'State of Mind' && cleaned.includes('5-Pack')) {
    cultivarSource = cleaned.replace(/^.*?\(2\.5g\)\s*/i, '')
  } else if (brand === 'Sushi Hash') {
    cultivarSource = cleaned.replace(/^.*?(?:\(2\.5g\)|Single)\s*/i, '')
  } else if (cleaned.includes('-')) {
    const parts = cleaned.split('-')
    cultivarSource = parts[parts.length - 1] ?? cleaned
  }

  let cultivar = cleanCultivar(cultivarSource)
  cultivar = cultivar.replace(/^\(?\d+(?:\.\d+)?g\)?\s+/i, '').replace(/^Pack\s+/i, '')
  cultivar = cleanCultivar(cultivar)

  const variantTab = packCount > 1 ? `${packCount}x ${size}` : size
  if (isRevertGummy) {
    const groupName = `${cultivar} Gummy`
    return {
      brand,
      category,
      groupName,
      packCount,
      prevalence,
      searchTerm: cultivar,
      size,
      strainName: '',
      subcategory,
      variantName: `${brand} ${groupName} ${size}`,
      variantTab,
    }
  }

  return {
    brand,
    category,
    groupName: cultivar,
    packCount,
    prevalence,
    searchTerm: cultivar,
    size,
    strainName: cultivar,
    subcategory,
    variantName: packCount > 1 ? `${brand} ${cultivar} ${variantTab}` : `${brand} ${cultivar} ${size}`,
    variantTab,
  }
}

function parseCuraleafName(name: string): ParsedProductName {
  const match = /^(Pr\(Pre-Roll(?: Pack)?\)|F\(Whole Flower\)|V\(BRIQ\))-(.+)$/.exec(name)
  if (!match) {
    throw new Error(`Unhandled Curaleaf product name: ${name}`)
  }

  const mapping = CURALEAF_CATEGORY_MAP.get(match[1])
  if (!mapping) {
    throw new Error(`Unhandled Curaleaf product type: ${match[1]}`)
  }

  const parts = match[2].split('-').map((part) => part.trim()).filter((part) => part.length > 0)
  if (parts.length < 3) {
    throw new Error(`Unhandled Curaleaf product name: ${name}`)
  }

  const brandToken = parts[0]
  let modifierTokens = parts.slice(1, -2)
  const sizeToken = parts[parts.length - 2]
  const prevalenceToken = parts[parts.length - 1]
  const packToken = modifierTokens.find((token) => /^\d+PK$/i.test(token)) ?? null
  if (packToken) {
    modifierTokens = modifierTokens.filter((token) => token !== packToken)
  }

  let brand = brandToken
  if (brandToken === 'Grassroots') {
    brand = 'Grass Roots'
  }
  if (brandToken === 'Anthem' && modifierTokens[0] === 'Bold') {
    modifierTokens = modifierTokens.slice(1)
    mapping.subcategory = 'Infused'
  }
  if (brandToken === 'Grassroots' && modifierTokens[0] === 'Dark Heart') {
    modifierTokens = modifierTokens.slice(1)
  }
  if (brandToken === 'Select' && modifierTokens[0] === 'Essentials') {
    modifierTokens = modifierTokens.slice(1)
  }

  const groupName = cleanCultivar(modifierTokens.join('-').replace('Diamond Infused', '').replace('Glass Tip Infused', '').trim())
  const prevalence = PREVALENCE_MAP.get(prevalenceToken) ?? null

  if (mapping.category === 'Pre-Rolls') {
    const packCount = packToken ? Number.parseInt(packToken.replace(/PK/i, ''), 10) : 1
    const grams = Number.parseFloat(sizeToken.replace('g', ''))
    const size = packCount > 1 ? formatGrams(grams / packCount) : formatGrams(grams)
    const variantTab = packCount > 1 ? `${packCount}x ${size}` : size
    return {
      brand,
      category: mapping.category,
      groupName,
      packCount,
      prevalence,
      searchTerm: cleanCultivar(groupName.replace('Essentials Briq ', '')),
      size,
      strainName: groupName,
      subcategory: mapping.subcategory ?? '',
      variantName: packCount > 1 ? `${brand} ${groupName} ${variantTab}` : `${brand} ${groupName} ${size}`,
      variantTab,
    }
  }

  if (mapping.category === 'Vapes') {
    const groupLabel = brand === 'Select' ? `Essentials Briq ${groupName}` : groupName
    return {
      brand,
      category: mapping.category,
      groupName: groupLabel,
      packCount: 1,
      prevalence,
      searchTerm: cleanCultivar(groupName),
      size: sizeToken,
      strainName: groupName,
      subcategory: mapping.subcategory ?? '',
      variantName: brand === 'Select' ? `${brand} Essentials Briq ${groupName} ${sizeToken}` : `${brand} ${groupName} ${sizeToken}`,
      variantTab: sizeToken,
    }
  }

  return {
    brand,
    category: mapping.category,
    groupName,
    packCount: 1,
    prevalence,
    searchTerm: cleanCultivar(groupName),
    size: sizeToken,
    strainName: groupName,
    subcategory: mapping.subcategory ?? '',
    variantName: `${brand} ${groupName} ${sizeToken}`,
    variantTab: sizeToken,
  }
}

function parseBytesName(name: string): ParsedProductName {
  const match = /^Bytes\s*-\s*(.+?)\s*-\s*Edibles\s*-\s*(\d+)\s*$/i.exec(name)
  if (!match) {
    throw new Error(`Unhandled Bytes product name: ${name}`)
  }

  const packCount = Number.parseInt(match[2], 10)
  const size = '10mg'
  const cultivar = cleanCultivar(match[1])
  const variantTab = `${packCount}x ${size}`
  return {
    brand: 'Bytes',
    category: 'Edibles',
    groupName: cultivar,
    packCount,
    prevalence: null,
    searchTerm: cultivar,
    size,
    strainName: '',
    subcategory: 'Chews/Gummies',
    variantName: `Bytes ${cultivar} ${variantTab}`,
    variantTab,
  }
}

function parseOutrankdName(name: string): ParsedProductName {
  const match = /^Outrankd\s*-\s*(.+?)\s*-\s*Disposable Vape\s*-\s*(\d+(?:\.\d+)?)g\s*$/i.exec(name)
  if (!match) {
    throw new Error(`Unhandled Outrankd product name: ${name}`)
  }
  const cultivar = cleanCultivar(match[1])
  const size = formatGrams(Number.parseFloat(match[2]))
  return {
    brand: 'Outrankd',
    category: 'Vapes',
    groupName: cultivar,
    packCount: 1,
    prevalence: null,
    searchTerm: cultivar,
    size,
    strainName: cultivar,
    subcategory: '',
    variantName: `Outrankd ${cultivar} ${size}`,
    variantTab: size,
  }
}

function parseTheGramName(name: string): ParsedProductName {
  const match = /^The Gram\s*-\s*(.+?)\s*-\s*Flower\s*-\s*(\d+(?:\.\d+)?)g\s*$/i.exec(name)
  if (!match) {
    throw new Error(`Unhandled The Gram product name: ${name}`)
  }
  const cultivar = cleanCultivar(match[1])
  const size = formatGrams(Number.parseFloat(match[2]))
  return {
    brand: 'The Gram',
    category: 'Pre-Rolls',
    groupName: cultivar,
    packCount: 1,
    prevalence: null,
    searchTerm: cultivar,
    size,
    strainName: cultivar,
    subcategory: '',
    variantName: `The Gram ${cultivar} ${size}`,
    variantTab: size,
  }
}

function parseMoonlitName(name: string): ParsedProductName {
  const match = /^MOONLIT-\s*(.+?)\s+(\d+(?:\.\d+)?)\s*G\s+INFUSED\s+PREROLL\s*$/i.exec(name)
  if (!match) {
    throw new Error(`Unhandled Moonlit product name: ${name}`)
  }
  const rawCultivar = match[1].trim()
  const cultivar = cleanCultivar(rawCultivar === rawCultivar.toUpperCase() ? toTitleCase(rawCultivar) : rawCultivar)
  const size = formatGrams(Number.parseFloat(match[2]))
  return {
    brand: 'Moonlit Hash Co',
    category: 'Pre-Rolls',
    groupName: cultivar,
    packCount: 1,
    prevalence: null,
    searchTerm: cultivar,
    size,
    strainName: cultivar,
    subcategory: 'Infused',
    variantName: `Moonlit Hash Co ${cultivar} ${size}`,
    variantTab: size,
  }
}

function parseSmartbudName(name: string): ParsedProductName {
  const match = /^Smartbud\s*-\s*(\d+)Pk\s+Preroll\s*-\s*(.+?)\s*-\s*(\d+(?:\.\d+)?)g\s*$/i.exec(name)
  if (!match) {
    throw new Error(`Unhandled Smartbud product name: ${name}`)
  }
  const packCount = Number.parseInt(match[1], 10)
  const totalGrams = Number.parseFloat(match[3])
  const cultivar = cleanCultivar(match[2])
  const size = formatGrams(totalGrams / packCount)
  const variantTab = `${packCount}x ${size}`
  return {
    brand: 'Smartbud',
    category: 'Pre-Rolls',
    groupName: cultivar,
    packCount,
    prevalence: null,
    searchTerm: cultivar,
    size,
    strainName: cultivar,
    subcategory: '',
    variantName: `Smartbud ${cultivar} ${variantTab}`,
    variantTab,
  }
}

function parseHerbCodeName(name: string): ParsedProductName {
  const cultivar = new Map<string, string>([
    ['1O-PR-H26-DBUR', 'Donny Burger'],
    ['1O-PR-H26-SDSL', 'Sour Diesel'],
    ['1O-PR-H26-WIOG', 'WiFi OG'],
  ]).get(name)
  if (!cultivar) {
    throw new Error(`Unhandled Herb coded product name: ${name}`)
  }

  return {
    brand: 'Herb',
    category: 'Pre-Rolls',
    groupName: cultivar,
    packCount: 1,
    prevalence: null,
    searchTerm: cultivar,
    size: '1g',
    strainName: cultivar,
    subcategory: '',
    variantName: `Herb ${cultivar} 1g`,
    variantTab: '1g',
  }
}

function parseJennysName(name: string): ParsedProductName {
  const match = /^Jenny'?s\s+J\s+(\d+(?:\.\d+)?)\s*g\s+(.+?)\s+Pre[-\s]?Roll\s*$/i.exec(name)
  if (!match) {
    throw new Error(`Unhandled Jenny's product name: ${name}`)
  }
  const size = formatGrams(Number.parseFloat(match[1]))
  const cultivar = cleanCultivar(match[2])
  return {
    brand: "Jenny's",
    category: 'Pre-Rolls',
    groupName: cultivar,
    packCount: 1,
    prevalence: null,
    searchTerm: cultivar,
    size,
    strainName: cultivar,
    subcategory: '',
    variantName: `Jenny's ${cultivar} ${size}`,
    variantTab: size,
  }
}

function parsePoshPuffName(name: string): ParsedProductName {
  const match = /^Posh\s+Puff\s+(\.?\d+(?:\.\d+)?)\s*g\s+(.+?)\s+Vapes?\s*$/i.exec(name)
  if (!match) {
    throw new Error(`Unhandled Posh Puff product name: ${name}`)
  }
  const sizeText = match[1].startsWith('.') ? `0${match[1]}` : match[1]
  const size = formatGrams(Number.parseFloat(sizeText))
  const cultivar = cleanCultivar(match[2])
  const groupName = `Posh Puff ${cultivar}`
  return {
    brand: "Jenny's",
    category: 'Vapes',
    groupName,
    packCount: 1,
    prevalence: null,
    searchTerm: cultivar,
    size,
    strainName: cultivar,
    subcategory: 'All In One / Disposable',
    variantName: `Jenny's ${groupName} ${size}`,
    variantTab: size,
  }
}

function parseLayUpName(name: string): ParsedProductName {
  const match = /^LayUp\s*-\s*Beverage\s*-\s*(.+?)\s*-\s*(\d+)\s*(?:MG\s*THC|mg)\s*$/i.exec(name)
  if (!match) {
    throw new Error(`Unhandled LayUp product name: ${name}`)
  }
  const flavor = cleanCultivar(match[1])
  const milligrams = Number.parseInt(match[2], 10)
  const size = `${milligrams}mg`
  return {
    brand: 'LayUp',
    category: 'Beverages',
    groupName: flavor,
    packCount: 1,
    prevalence: null,
    searchTerm: flavor,
    size,
    strainName: '',
    subcategory: '',
    variantName: `LayUp ${flavor} ${size}`,
    variantTab: size,
  }
}

function parseCannabalsName(name: string): ParsedProductName {
  const parts = name.split(/\s*-\s*/).map((part) => part.trim()).filter((part) => part.length > 0)
  if (parts.length < 3 || !/^cannabals$/i.test(parts[0])) {
    throw new Error(`Unhandled Cannabals product name: ${name}`)
  }
  const family = parts[1]
  const lowerFamily = family.toLowerCase()

  if (lowerFamily.includes('chubby puff')) {
    const sizePart = parts[parts.length - 1]
    const sizeMatch = /^(\d+(?:\.\d+)?)\s*g$/i.exec(sizePart)
    if (!sizeMatch) {
      throw new Error(`Unhandled Cannabals Chubby Puff product name: ${name}`)
    }
    const size = formatGrams(Number.parseFloat(sizeMatch[1]))
    const cultivar = cleanCultivar(parts.slice(2, -1).join(' ').trim())
    if (!cultivar) {
      throw new Error(`Unhandled Cannabals Chubby Puff product name: ${name}`)
    }
    const groupName = `Chubby Puff ${cultivar}`
    return {
      brand: 'Cannabals',
      category: 'Vapes',
      groupName,
      packCount: 1,
      prevalence: null,
      searchTerm: cultivar,
      size,
      strainName: cultivar,
      subcategory: 'All In One / Disposable',
      variantName: `Cannabals ${groupName} ${size}`,
      variantTab: size,
    }
  }

  if (lowerFamily.includes('gummy brick')) {
    let cultivar: string | null = null
    let dosageText: string | null = null
    let packCount = 10
    for (const part of parts.slice(2)) {
      const packMatch = /^(\d+)\s*pk$/i.exec(part)
      if (packMatch) {
        packCount = Number.parseInt(packMatch[1], 10) === 1 ? 10 : Number.parseInt(packMatch[1], 10)
        continue
      }
      const dosageMatch = /^(\d+)\s*(?:MG\s*THC|mg(?:\s*THC)?)$/i.exec(part)
      if (dosageMatch) {
        dosageText = `${dosageMatch[1]}mg`
        continue
      }
      if (/distillate|fast[-\s]acting/i.test(part)) {
        continue
      }
      cultivar = cleanCultivar(part)
    }
    if (!cultivar || !dosageText) {
      throw new Error(`Unhandled Cannabals Gummy Brick product name: ${name}`)
    }
    const totalMg = Number.parseInt(dosageText, 10)
    const perPieceMg = packCount > 0 && totalMg % packCount === 0 ? totalMg / packCount : 10
    const size = `${perPieceMg}mg`
    const variantTab = `${packCount}x ${size}`
    const groupName = `${cultivar} Gummy Brick`
    return {
      brand: 'Cannabals',
      category: 'Edibles',
      groupName,
      packCount,
      prevalence: null,
      searchTerm: cultivar,
      size,
      strainName: '',
      subcategory: '',
      variantName: `Cannabals ${groupName} ${variantTab}`,
      variantTab,
    }
  }

  throw new Error(`Unhandled Cannabals family: ${name}`)
}

function normalizeSizeText(value: string | null | undefined): string | null {
  if (!value) {
    return null
  }
  const trimmed = value.trim()
  if (trimmed.length === 0) {
    return null
  }
  const gramMatch = /^\.?(\d+(?:\.\d+)?)\s*g$/i.exec(trimmed)
  if (gramMatch) {
    const text = trimmed.startsWith('.') ? `0.${gramMatch[1]}` : gramMatch[1]
    return formatGrams(Number.parseFloat(text))
  }
  const halfMatch = /^\.(\d+)$/.exec(trimmed)
  if (halfMatch) {
    return formatGrams(Number.parseFloat(`0.${halfMatch[1]}`))
  }
  const mgMatch = /^(\d+)\s*mg$/i.exec(trimmed)
  if (mgMatch) {
    return `${Number.parseInt(mgMatch[1], 10)}mg`
  }
  return trimmed
}

function normalizeAndValidateParsedProductName(parsed: ParsedProductName, rawName: string): ParsedProductName {
  const normalizedSize = normalizeSizeText(parsed.size) ?? parsed.size
  let normalizedTab = normalizeSizeText(parsed.variantTab) ?? parsed.variantTab
  if (parsed.packCount > 1) {
    if (!/^\d+x\s+/i.test(normalizedTab)) {
      normalizedTab = `${parsed.packCount}x ${normalizedSize}`
    }
  } else if (!normalizedTab || normalizedTab.length === 0) {
    normalizedTab = normalizedSize
  }

  const normalizedVariantName = parsed.variantName.replace(/(^|[^\d])\.(\d)/g, '$10.$2')

  const result: ParsedProductName = {
    ...parsed,
    size: normalizedSize,
    variantTab: normalizedTab,
    variantName: normalizedVariantName,
  }

  const issues = collectSemanticParserIssues(result)
  if (issues.length > 0) {
    throw new Error(`Semantically invalid parser output for "${rawName}": ${issues.join('; ')}`)
  }

  return result
}

function collectSemanticParserIssues(parsed: ParsedProductName): string[] {
  const issues: string[] = []
  if (!parsed.brand || parsed.brand.length === 0) {
    issues.push('missing brand')
  }
  if (!parsed.category || parsed.category.length === 0) {
    issues.push('missing category')
  }
  if (!parsed.variantTab || parsed.variantTab.length === 0) {
    issues.push('missing variantTab')
  }
  if (!parsed.size || parsed.size.length === 0) {
    issues.push('missing size')
  }
  const loweredVariantName = parsed.variantName.trim().toLowerCase()
  const genericLeafTokens = ['vape', 'vapes', 'pre-roll', 'preroll', 'gummy', 'beverage']
  if (genericLeafTokens.some((token) => loweredVariantName === token || loweredVariantName === `${token}s`)) {
    issues.push(`generic variantName "${parsed.variantName}"`)
  }
  const loweredGroup = parsed.groupName.trim().toLowerCase()
  const isGenericGroup = genericLeafTokens.includes(loweredGroup)
  if (isGenericGroup) {
    issues.push(`generic groupName "${parsed.groupName}"`)
  }
  return issues
}

function cleanCultivar(text: string): string {
  const trimmed = text.trim().replace(/\s*\((?:I|S|H)\)\s*$/i, '')
  return NAME_ALIASES.get(trimmed) ?? trimmed
}

function derivePrevalence(text: string): string | null {
  const match = /\((I|S|H)\)\s*$/i.exec(text.trim())
  if (!match) {
    return null
  }
  return PREVALENCE_MAP.get(match[1].toUpperCase()) ?? null
}

function readMetrcUnitCost(position: z.infer<typeof PurchaseOrderPositionSchema>): number | null {
  const wholesalePrice = normalizeFiniteNumber(position.orderPositionIntegrationData?.wholesalePrice)
  const quantity = normalizeFiniteNumber(position.orderPositionQty)
    ?? normalizeFiniteNumber(position.distributorProductQty)
    ?? normalizeFiniteNumber(position.qty)
  if (wholesalePrice === null || quantity === null || quantity <= 0) {
    return null
  }
  return roundMoney(wholesalePrice / quantity)
}

function isSampleLike(position: z.infer<typeof PurchaseOrderPositionSchema>): boolean {
  if (position.isTradeSample === true) {
    return true
  }
  const directCost = normalizeFiniteNumber(position.discountProductPrice)
  if (directCost !== null && directCost <= 0.05) {
    return true
  }
  const wholesalePrice = normalizeFiniteNumber(position.orderPositionIntegrationData?.wholesalePrice)
  return wholesalePrice !== null && wholesalePrice <= 0.05
}

function minimumGmFloorPrice(cost: number): number {
  return Math.ceil(((1.13 * cost) / 0.45) * 4) / 4
}

function computeGmPercent(cost: number | null, price: number | null): number | null {
  if (cost === null || price === null || price <= 0) {
    return null
  }
  return roundMoney((1 - (1.13 * cost) / price) * 100)
}

function classifyPricingAction(currentPrice: number | null, proposedPrice: number | null): string | null {
  if (proposedPrice === null) {
    return null
  }
  if (currentPrice === null) {
    return 'set-price'
  }
  if (Math.abs(currentPrice - proposedPrice) < 0.01) {
    return 'keep-price'
  }
  return proposedPrice > currentPrice ? 'raise-price' : 'lower-price'
}

function medianPrice(anchors: LiveProductSummary[]): number | null {
  const prices = anchors
    .map((anchor) => anchor.price)
    .filter((price): price is number => price !== null)
    .sort((left, right) => left - right)

  if (prices.length === 0) {
    return null
  }

  const midpoint = Math.floor(prices.length / 2)
  if (prices.length % 2 === 1) {
    return prices[midpoint]
  }

  return roundMoney((prices[midpoint - 1] + prices[midpoint]) / 2)
}

function roundToHalf(value: number): number {
  return Math.ceil((value - 1e-9) * 2) / 2
}

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100
}

function formatGrams(value: number): string {
  return `${Number.parseFloat(value.toFixed(2))}g`
}

function formatCurrency(value: number): string {
  return `$${value.toFixed(2)}`
}

function normalizeDistributorProductId(value: string | number | null | undefined, positionId: number): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value)
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    return value.trim()
  }
  return `position-${positionId}`
}

function normalizePrice(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? roundMoney(value) : null
}

function normalizePositiveInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null
}

function normalizeFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function normalizeNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function normalizeDate(value: string | null | undefined): string | null {
  if (!value || value.length < 10) {
    return null
  }
  return value.slice(0, 10)
}

function compactText(value: string | null | undefined): string {
  return normalizeText(value)
}

function normalizeText(value: string | null | undefined): string {
  return (value ?? '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

function sameDistributorName(left: string | null, right: string | null): boolean {
  const leftTokens = normalizeNameTokens(left)
  const rightTokens = normalizeNameTokens(right)
  if (leftTokens.length === 0 || rightTokens.length === 0) {
    return false
  }
  return leftTokens.join(' ') === rightTokens.join(' ')
}

function normalizeNameTokens(value: string | null): string[] {
  const tokens = (value ?? '').toLowerCase().match(/[a-z0-9]+/g) ?? []
  const dropTokens = new Set(['llc', 'inc', 'ltd', 'co', 'company', 'corp', 'corporation'])
  return tokens.filter((token) => !dropTokens.has(token))
}

function compactStrings(values: Array<string | null | undefined>): string[] {
  return values.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
}

function extractPendingPurchaseFamilyTokens(value: string): string[] {
  return Array.from(new Set(
    normalizeText(value)
      .split(' ')
      .filter((token) => token.length >= 3 && !LLM_FALLBACK_NAME_STOPWORDS.has(token) && !/^\d/.test(token)),
  ))
}

function scorePendingPurchaseAnchor(summary: LiveProductSummary, familyTokens: string[]): number {
  const haystack = normalizeText([summary.groupName, summary.productName, summary.strain, summary.tab].join(' '))
  let score = 0
  for (const token of familyTokens) {
    if (haystack.includes(token)) {
      score += 1
    }
  }
  return score
}

function joinNotes(values: Array<string | null | undefined>): string | null {
  const parts = compactStrings(values)
  return parts.length > 0 ? parts.join(' ') : null
}

function collectSuggestionCandidates(
  positions: z.infer<typeof PurchaseOrderPositionSchema>[],
): SuggestedProductCandidate[] {
  const bestByKey = new Map<string, SuggestedProductCandidate>()

  for (const position of positions) {
    const row = readPositionRecord(position)
    const candidates = Array.isArray(row.pendingPurchaseSuggestedProducts)
      ? row.pendingPurchaseSuggestedProducts
      : []

    for (const candidate of candidates) {
      if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
        continue
      }

      const record = candidate as Record<string, unknown>
      const productId = normalizePositiveInt(record.productId)
      const productName = normalizeNonEmptyString(record.productName)
      const score = normalizeFiniteNumber(record.score)
      if (productId === null && productName === null) {
        continue
      }

      const key = productId !== null ? `id:${productId}` : `name:${normalizeText(productName)}`
      const existing = bestByKey.get(key)
      if (!existing || compareSuggestionCandidateScore(score, existing.score) > 0) {
        bestByKey.set(key, { productId, productName, score })
      }
    }
  }

  return [...bestByKey.values()]
    .sort((left, right) => compareSuggestionCandidateScore(right.score, left.score))
    .slice(0, 3)
}

function compareSuggestionCandidateScore(left: number | null, right: number | null): number {
  if (left === right) {
    return 0
  }
  if (left === null) {
    return -1
  }
  if (right === null) {
    return 1
  }
  return left - right
}

function formatSuggestionCandidateNote(candidates: SuggestedProductCandidate[]): string | null {
  if (candidates.length === 0) {
    return null
  }

  const parts = candidates.map((candidate) => {
    const label = candidate.productName ?? (candidate.productId !== null ? `product ${candidate.productId}` : 'unknown product')
    const idSuffix = candidate.productId !== null ? ` (product ${candidate.productId})` : ''
    const scoreSuffix = candidate.score !== null ? `, score ${candidate.score}` : ''
    return `${label}${idSuffix}${scoreSuffix}`
  })
  return `Top suggestion candidates: ${parts.join('; ')}.`
}

function describeExistingDistributorLinks(row: ExactDistributorProductRow | null): string | null {
  if (!row) {
    return null
  }
  if (row.productId !== null) {
    const productLabel = row.productName ?? `product ${row.productId}`
    return `${row.distributorName ?? 'State distributor row'} ${row.distributorProductId} already links to ${productLabel}.`
  }
  return `${row.distributorName ?? 'State distributor row'} ${row.distributorProductId} exists without a linked catalog variant yet.`
}

function readPositionRecord(
  position: z.infer<typeof PurchaseOrderPositionSchema>,
): Record<string, unknown> {
  return typeof position === 'object' && position !== null ? position as Record<string, unknown> : {}
}

function toTitleCase(value: string): string {
  return value
    .toLowerCase()
    .split(/\s+/)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(' ')
}

function extractChatCompletionContent(rawResponseText: string): string {
  const parsedResponse = JSON.parse(rawResponseText) as {
    choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }>
  }
  const content = parsedResponse.choices?.[0]?.message?.content
  if (typeof content === 'string' && content.trim().length > 0) {
    return content
  }
  if (Array.isArray(content)) {
    const joined = content.map((part) => typeof part?.text === 'string' ? part.text : '').join('').trim()
    if (joined.length > 0) {
      return joined
    }
  }
  throw new Error('Bedrock fallback classification returned no content.')
}

async function callSweedRpc<TResult>(dealerId: number, name: string, params: Record<string, unknown>): Promise<TResult> {
  await ensureDealerContext(dealerId)
  return callSweedRpcRaw(name, params)
}

async function readCurrentDealerContext(dealerId: number): Promise<Record<string, unknown>> {
  const result = DealerSetResultSchema.parse(await callDealerSet(dealerId))
  return {
    dealerId: result.user.currentDealerId,
    dealerName: result.user.currentDealerName ?? `dealer ${result.user.currentDealerId}`,
  }
}

async function ensureDealerContext(dealerId: number): Promise<void> {
  const result = DealerSetResultSchema.parse(await callDealerSet(dealerId))
  if (result.user.currentDealerId !== dealerId) {
    throw new Error(
      `Sweed dealer context mismatch. Expected ${dealerId}, got ${result.user.currentDealerId} ${result.user.currentDealerName ?? ''}`.trim(),
    )
  }
}

async function callDealerSet(dealerId: number): Promise<unknown> {
  return callSweedRpcRaw('store.auth.dealer.set', { dealerId })
}

async function callSweedRpcRaw<TResult>(name: string, params: Record<string, unknown>): Promise<TResult> {
  const env = getWorkerEnv()
  if (!env.sweedAuthToken) {
    throw new Error('SWEED_AUTH_TOKEN is required for pending-purchase generation jobs.')
  }

  let response: Response
  try {
    response = await fetch(env.sweedApiUrl, {
      body: JSON.stringify({
        auth: env.sweedAuthToken,
        id: randomUUID(),
        name,
        params,
      }),
      headers: {
        'content-type': 'application/json',
        'user-agent': 'helios-worker/1.0',
      },
      method: 'POST',
      signal: AbortSignal.timeout(env.sweedRequestTimeoutMs),
    })
  } catch (error) {
    throw new RetryableWorkerError(buildTransportErrorMessage(name, error))
  }

  const responseText = await response.text()
  if (!response.ok) {
    const message = `${name} returned HTTP ${response.status}: ${truncate(responseText)}`
    if (response.status === 403 || response.status === 429 || (response.status >= 500 && response.status <= 504)) {
      throw new RetryableWorkerError(message)
    }
    throw new Error(message)
  }

  const envelope = JSON.parse(responseText) as { error?: { message?: string }; result?: TResult }
  if (envelope.error) {
    throw new Error(`${name} failed: ${envelope.error.message ?? 'Unknown Sweed RPC error.'}`)
  }
  if (envelope.result === undefined) {
    throw new Error(`${name} returned no result payload.`)
  }
  return envelope.result
}

function buildTransportErrorMessage(name: string, error: unknown): string {
  if (error instanceof Error && error.message) {
    return `${name} transport failed: ${error.message}`
  }
  return `${name} transport failed.`
}

function truncate(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (normalized.length <= 240) {
    return normalized
  }
  return `${normalized.slice(0, 239)}...`
}
