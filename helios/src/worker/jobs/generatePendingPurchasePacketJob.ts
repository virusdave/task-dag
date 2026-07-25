import { randomUUID } from 'node:crypto'

import { z } from 'zod'

import {
  getHeliosPendingPurchaseSiteDealer,
  normalizeHeliosPendingPurchaseSiteDealerIds,
  PENDING_PURCHASE_CLASSIFIER_SCHEMA_VERSION,
  type CatalogPendingPurchasesGenerateJobPayload,
  type JsonValue,
  type HeliosPendingPurchaseSiteDealer,
  type JobProgress,
} from '../../shared/contracts/index.js'
import { sha256 } from '../../shared/util/hash.js'
import { getPool, type Queryable } from '../../server/db/pool.js'
import {
  buildPendingPurchaseBrandAliasCandidates,
  buildPendingPurchaseParseRuleFingerprint,
  derivePendingPurchaseBrandKey,
  findPendingPurchaseExactParseRule,
  insertPendingPurchaseParseObservation,
  listPendingPurchaseDistributorBrandAliases,
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
  getPendingPurchaseHintExtractionProgress,
  loadExtractedPendingPurchaseHintFactsForBundle,
  loadExtractedPendingPurchaseHintGlossaryForBundle,
  loadPendingPurchaseHintOperatorNotesForBundle,
} from '../../server/db/queries/pendingPurchaseHintQueries.js'
import { getHintDocumentStore } from '../../server/pendingPurchases/pendingPurchaseHintStore.js'
import {
  persistPendingPurchasePacket,
  type PendingPurchasePacket,
} from '../../server/pendingPurchases/pendingPurchasePacketImport.js'
import {
  classifyPendingPurchasePacketWithLlm,
  isPendingPurchaseClassifierAvailable,
  type ClassifierAllowedTaxonomy,
  type ClassifierCatalogCandidate,
  type ClassifierGlossaryEntry,
  type ClassifierHintFact,
  type ClassifierOperatorGuidance,
  type ClassifierRowInput,
  type ClassifierSweedSuggestion,
  type ClassifierVendorEvidence,
} from '../pendingPurchases/classifyPendingPurchasePacket.js'
import { loadPendingPurchaseClassificationEvidence } from '../pendingPurchases/loadPendingPurchaseClassificationEvidence.js'
import {
  loadPendingPurchaseVendorEvidence,
} from '../pendingPurchases/pendingPurchaseVendorEvidence.js'
import {
  reconcilePendingPurchaseDrafts,
  type ReconciledPendingPurchaseClassification,
  type ReconciledSuggestionCandidate,
  type ReconcilerCatalogCandidate,
} from '../pendingPurchases/reconcilePendingPurchaseDrafts.js'
import { getWorkerEnv } from '../config/env.js'
import type { NormalizedCatalogGroupLiveState } from '../catalog/liveState.js'
import { isRetryableWorkerError, RetryableWorkerError } from '../runtime/errors.js'
import type { JobHandlerContext } from '../runtime/jobRegistry.js'
import { readSweedDealerContext } from '../sweed/client.js'
import {
  callSweedRpc as callSharedSweedRpc,
  ensureDealerContext as ensureSharedDealerContext,
} from '../sweed/rpc.js'
import type { PricingMarketContext, ProductPricingMarketEvidence } from '../pricing/deterministicPricing.js'
import { buildPricingMarketContext } from '../pricing/litAlertsMarket.js'
import { enqueueMarketRefreshForProducts } from '../litalerts/enqueueMarketRefresh.js'
import { isRetiredRecordName } from './screensCarouselHelpers.js'
import { parseWith } from '../../lib/parsekit/engine.js'
import { getParserRegistry } from '../../lib/parsekit/node/parserRegistry.js'
import type { CompiledParser, CompiledRelease } from '../../lib/parsekit/types.js'
import { insertParsekitReverseShadowEvent } from '../../server/db/queries/parsekitReverseShadowQueries.js'

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

const PendingPurchaseBrandRowSchema = z.object({
  enabled: z.boolean().optional(),
  id: z.coerce.number().int().positive(),
  name: z.string().trim().min(1),
}).passthrough()

export const PendingPurchaseBrandListSchema = z.union([
  z.array(PendingPurchaseBrandRowSchema),
  z.object({ data: z.array(PendingPurchaseBrandRowSchema).default([]) }).passthrough().transform((value) => value.data),
])

const PENDING_PURCHASE_BRAND_PAGE_SIZE = 200
const MAX_PENDING_PURCHASE_LIVE_BRANDS = 10_000

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

/**
 * LLM teachers (especially Gemma 3 27b) frequently emit confidence as a
 * percentage (e.g. `90`) instead of the documented 0-1 probability. We
 * want a single bad confidence value not to nuke the entire envelope
 * and dump the row into `unresolved`, since the *classification* is
 * usually still correct. Preprocess: clamp anything > 1 by dividing by
 * 100 (and clamp the result into [0,1]).
 */
const LlmConfidenceSchema = z.preprocess((value) => {
  if (typeof value === 'string') {
    const trimmed = value.trim().replace(/%$/u, '')
    const parsed = Number(trimmed)
    if (!Number.isFinite(parsed)) return value
    value = parsed
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) return value
  if (value > 1) return Math.min(value / 100, 1)
  if (value < 0) return 0
  return value
}, z.number().min(0).max(1))

/**
 * Same defensiveness for size: the LLM sometimes returns `3.5` (a
 * number, no unit) for a 3.5g flower jar. Coerce numbers to strings so
 * downstream normalization (`normalizePendingPurchaseLlmClassification`)
 * can re-attach the unit via the parsed size token.
 */
const LlmSizeSchema = z.preprocess((value) => {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return value
}, z.string().trim().min(1))

/**
 * Many of the classification fields are typed as `string | null`
 * ("not applicable" → null), but the LLM occasionally emits a number
 * (e.g. `prevalence: 0.5`, `strainName: 3`, `variantTab: 1`) — a
 * single off-shape value used to nuke the entire envelope and dump
 * the row into manual review. Treat any non-string non-null shape as
 * `null` ("the model couldn't name this; let downstream fall back").
 * Empty / whitespace-only strings also collapse to null.
 */
const LlmLooseNullableStringSchema = z.preprocess((value) => {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : null
  }
  // numbers, booleans, objects, arrays — the LLM picked the wrong
  // type for a nullable-string field. Don't crash the row; treat as
  // "no value" so the downstream normalizer can fall back.
  return null
}, z.string().nullable())

const PendingPurchaseLlmClassificationSchema = z.object({
  brand: z.string().trim().min(1),
  category: z.string().trim().min(1),
  confidence: LlmConfidenceSchema,
  groupName: z.string().trim().min(1),
  packCount: z.coerce.number().int().positive(),
  parserFeasibility: z.enum(['easy-rule-based', 'likely-llm-only', 'needs-more-context']),
  prevalence: LlmLooseNullableStringSchema,
  rationale: z.string().trim().min(1),
  size: LlmSizeSchema,
  strainName: LlmLooseNullableStringSchema,
  subcategory: LlmLooseNullableStringSchema,
  /**
   * The LLM frequently emits `variantName: null` for canonical-size
   * categories like Flower where the variant name is "just the size"
   * (e.g. for "Herb 3.5g Durban Poison" the model returns null instead
   * of "3.5g"). Accept null/missing here; the downstream normalizer
   * derives the canonical variant name from variantTab/size + category.
   */
  variantName: LlmLooseNullableStringSchema,
  variantTab: LlmLooseNullableStringSchema,
  warningFlags: z.array(z.string().trim().min(1)).default([]),
}).passthrough()

const PendingPurchaseLlmBrandAliasCandidateSchema = z.object({
  aliasType: z.enum(['exact', 'prefix']),
  aliasValue: z.string().trim().min(1),
  confidence: LlmConfidenceSchema,
  rationale: z.string().trim().min(1),
  riskFlags: z.array(z.string().trim().min(1)).default([]),
}).passthrough()

const PendingPurchaseLlmExactNameRuleCandidateSchema = z.object({
  confidence: LlmConfidenceSchema,
  rationale: z.string().trim().min(1),
  rawName: z.string().trim().min(1),
  riskFlags: z.array(z.string().trim().min(1)).default([]),
  safeAutoPersist: z.boolean().default(false),
}).passthrough()

const PendingPurchaseLlmGeneralizedRuleCandidateSchema = z.object({
  confidence: LlmConfidenceSchema,
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
  parserSource: 'database-rule' | 'distributor-override' | 'hardcoded-parser' | 'llm-teacher' | 'unresolved'
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

/**
 * Collected, reusable context for one pending-purchase generation run:
 * the live outstanding-position groups + order summaries, the catalog
 * cache, and the state-dealer context. Carved out of
 * `runCatalogPendingPurchasesGenerateJob` (Stage 1 / C1) so later stages
 * can drive the collection phase independently of how rows are built.
 */
interface PendingPurchaseGenerationContext {
  cache: CatalogCache
  liveCollection: { groups: Map<string, PendingPositionGroup>; orders: PendingOrderSummary[] }
  stateContext: Record<string, unknown>
}

export async function runCatalogPendingPurchasesGenerateJob(
  context: JobHandlerContext,
  payload: CatalogPendingPurchasesGenerateJobPayload,
): Promise<void> {
  const env = getWorkerEnv()
  const hasCredentials = env.sweedLoginEmail !== null && env.sweedLoginPassword !== null
  if (!hasCredentials && !env.sweedAuthToken) {
    throw new Error(
      'Sweed auth is not configured; pending-purchase generation requires SWEED_LOGIN_EMAIL+SWEED_LOGIN_PASSWORD or SWEED_AUTH_TOKEN.',
    )
  }

  // The prospective LLM classifier is the driving path (C8a). It is NOT a
  // best-effort enhancement: parsekit + the legacy heuristics run alongside it
  // only for the 3-way comparison, never as a fallback (operator decision — no
  // legacy fallback). Fail loud BEFORE the expensive Sweed collection phase
  // when the Bedrock token is missing rather than silently degrading.
  if (!isPendingPurchaseClassifierAvailable()) {
    throw new Error(
      'Pending-purchase generation requires the prospective LLM classifier, but no Bedrock token is configured (BEDROCK_MANTLE_BEARER_TOKEN). This path has no legacy fallback; configure the token and retry.',
    )
  }

  const sites = resolveSites(payload.siteDealerIds)
  const purchaseOrderNumber = normalizeNonEmptyString(payload.purchaseOrderNumber)
  const hintBundleId = normalizeNonEmptyString(payload.hintBundleId)
  const requestId = randomUUID()

  const generationContext = await collectPendingPurchaseContext({
    fromDate: payload.fromDate,
    jobId: context.id,
    purchaseOrderNumber,
    sites,
    stateDealerId: env.sweedStateDealerId,
    toDate: payload.toDate,
  })

  const packet = await buildPendingPurchasePacket({
    context: generationContext,
    fromDate: payload.fromDate,
    hintBundleId,
    jobId: context.id,
    sites,
    stateDealerId: env.sweedStateDealerId,
    toDate: payload.toDate,
  })

  await persistGeneratedPendingPurchasePacket({
    jobId: context.id,
    packet,
    requestId,
    requestedByUserId: payload.requestedByUserId ?? null,
  })
}

/**
 * Phase 1 — collect the run context. Scans the selected sites for
 * unresolved outstanding purchase positions, fails fast when a requested
 * single purchase order is not found, then prepares the catalog cache and
 * state-dealer context. No rows are built here; the result feeds
 * `buildPendingPurchasePacket`.
 */
async function collectPendingPurchaseContext(input: {
  fromDate: string
  jobId: number
  purchaseOrderNumber: string | null
  sites: HeliosPendingPurchaseSiteDealer[]
  stateDealerId: number
  toDate: string
}): Promise<PendingPurchaseGenerationContext> {
  const { fromDate, jobId, purchaseOrderNumber, sites, stateDealerId, toDate } = input

  await updateJobProgress(jobId, {
    completed: 0,
    message: purchaseOrderNumber
      ? `Scanning ${sites.length} site${sites.length === 1 ? '' : 's'} for outstanding purchase order ${purchaseOrderNumber}.`
      : `Scanning ${sites.length} site${sites.length === 1 ? '' : 's'} for unresolved outstanding purchase lines.`,
    phase: 'Collecting outstanding purchase orders',
    phaseCount: 3,
    phaseIndex: 1,
    total: sites.length,
  })

  const liveCollection = await collectPendingPositions(jobId, fromDate, toDate, sites, purchaseOrderNumber)

  if (purchaseOrderNumber && liveCollection.orders.length === 0) {
    throw new Error(
      `No outstanding purchase order matching "${purchaseOrderNumber}" was found on the selected site(s) between ${fromDate} and ${toDate}. Check the purchase number, the selected site, and the date range.`,
    )
  }

  const cache = new CatalogCache(stateDealerId)

  await ensureDealerContext(stateDealerId)
  const stateContext = await readCurrentDealerContext(stateDealerId)

  return { cache, liveCollection, stateContext }
}

/**
 * Phase 2 — turn the collected context into the persistable packet. The
 * per-row classification is DRIVEN by the prospective LLM classifier (C4) +
 * the deterministic reconciler (C5) via `buildLlmDrivenPendingPurchaseRows`
 * (C8a). Parsekit + the legacy heuristics still run per row for the 3-way
 * comparison record (operator kept parsekit alive; NO deletion). Everything
 * else here — packet title/summary, site keys, ordering, state context — is
 * generic packet assembly.
 */
async function buildPendingPurchasePacket(input: {
  context: PendingPurchaseGenerationContext
  fromDate: string
  hintBundleId: string | null
  jobId: number
  sites: HeliosPendingPurchaseSiteDealer[]
  stateDealerId: number
  toDate: string
}): Promise<PendingPurchasePacket> {
  const { context, fromDate, hintBundleId, jobId, sites, stateDealerId, toDate } = input
  const { cache, liveCollection, stateContext } = context

  const built = await buildLlmDrivenPendingPurchaseRows({
    cache,
    db: getPool(),
    groups: liveCollection.groups,
    hintBundleId,
    jobId,
    stateDealerId,
  })

  const summary = {
    ...buildPacketSummary(built.rows, liveCollection.orders, fromDate, toDate),
    classifier: built.provenance,
  }

  return {
    generatedAt: new Date().toISOString(),
    orders: liveCollection.orders,
    packetTitle: buildPacketTitle(sites, fromDate, toDate),
    rows: built.rows,
    siteKeys: sites.map((site) => site.siteKey),
    siteLabels: sites.map((site) => site.siteLabel),
    stateContext: {
      ...stateContext,
      classifier: built.provenance,
    },
    summary,
  }
}

/**
 * The legacy rule-based row builder seam. Resolves each unresolved
 * distributor-product group into a review row via the deterministic
 * hardcoded-parser / DB-rule / LLM-teacher pipeline (`buildGeneratedRow`),
 * then applies the family-average cost fallback and the stable display
 * ordering.
 *
 * This is the ONE seam isolating the legacy classifier (decision 4: go
 * direct). Stage 8 / C8 replaces the call site in
 * `buildPendingPurchasePacket` with the validated prospective LLM path and
 * deletes this function outright — it is NOT a preserved fallback. A
 * short dev-only shadow comparison during validation is fine, but it does
 * not ship as a permanent mode toggle. See
 * docs/designs/prospective-pending-purchase-classifier.md (Integration
 * seams).
 */
async function buildLegacyPendingPurchaseRows(input: {
  cache: CatalogCache
  groups: Map<string, PendingPositionGroup>
  jobId: number
}): Promise<GeneratedPendingPurchaseRow[]> {
  const { cache, groups, jobId } = input

  const rows: GeneratedPendingPurchaseRow[] = []
  const totalGroups = groups.size
  await updateJobProgress(jobId, {
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
  const groupsArray = Array.from(groups.values())
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
      await updateJobProgress(jobId, {
        completed: processedGroups,
        message: `Resolved ${processedGroups} of ${totalGroups} pending distributor product${totalGroups === 1 ? '' : 's'} (${CONCURRENCY_LIMIT} parallel workers).`,
        phase: 'Resolving catalog actions',
        phaseCount: 3,
        phaseIndex: 2,
        total: totalGroups > 0 ? totalGroups : null,
      })
    }
  }

  // Wave 2: substitute family-average wholesale cost into any row whose own
  // cost basis was a trade sample or sub-$1 nominal reference. Must run after
  // every row's brand/category/size/pack-count is known so the family-key
  // bucketing has a complete population to draw from.
  applyFamilyAverageCostFallback(rows)

  rows.sort((left, right) => {
    const siteComparison = left.siteLabel.localeCompare(right.siteLabel)
    if (siteComparison !== 0) {
      return siteComparison
    }
    return left.distributorProductName.localeCompare(right.distributorProductName)
  })

  return rows
}

// ── C8a: prospective-LLM driving path ────────────────────────────────────────
//
// The generate job is now DRIVEN by the event-level LLM classifier (C4) behind
// the deterministic reconciler / safety gate (C5). Parsekit + the legacy
// heuristics still run per row (via `computePendingPurchaseParseComparison`) so
// the Config → Parsing → Purchases reverse-shadow scorecard keeps getting new
// events AND every packet row carries a 3-way comparison (LLM vs parsekit vs
// legacy) in its `raw_row_json.threeWayComparison` for the C8b ETL Details page.
// Operator decision: parsekit is KEPT ALIVE; the LLM never falls back to the
// legacy row-builder.

const LLM_CLASSIFIER_MAX_ROWS_PER_CALL = 80
const CANDIDATE_SEARCH_HITS_PER_ROW = 25
const CANDIDATE_BRAND_HITS_PER_ROW = 40
const MAX_CLASSIFIER_CANDIDATES_PER_CALL = 2000
const MAX_RECONCILER_CANDIDATES = 4000
const MAX_CLASSIFIER_HINT_FACTS = 5000

// The generate job is frequently enqueued by the same operator action that just
// added a hint document, moments before the async C3 hint-extraction job has
// finished. When documents are still mid-extraction, defer generation by this
// long rather than failing the packet. Bounded by the worker loop's max-attempts
// budget (RetryableWorkerError), so a genuinely stuck extraction dead-letters
// instead of deferring forever. Observed extraction latency is a few-to-~20s, so
// this resolves within the first retry or two.
const HINT_EXTRACTION_RETRY_DELAY_MS = 10_000
const GROUP_CONTEXT_CONCURRENCY = 20

interface PendingPurchaseClassifierProvenance {
  available: boolean
  model: string | null
  promptVersion: string | null
  reconcilerVersion: string | null
  hintBundleId: string | null
  hintFactCount: number
  operatorNoteDocuments: Array<{
    contentSha256: string
    hintDocumentId: string
    sourceLabel: string | null
  }>
  glossaryEntryCount: number
  catalogCandidateCount: number
  classifierCalls: number
  rowCount: number
}

interface LlmDrivenBuildResult {
  rows: GeneratedPendingPurchaseRow[]
  provenance: PendingPurchaseClassifierProvenance
}

interface PendingPurchaseGroupContext {
  group: PendingPositionGroup
  stateDistributorProductRow: ExactDistributorProductRow | null
  resolvedCost: ResolvedCost
  sampleLike: boolean
  suggestionCandidates: SuggestedProductCandidate[]
  rowInputSignature: string
  parseComparison: PendingPurchaseParseComparison
  classifierRow: ClassifierRowInput
  vendorEvidence: ClassifierVendorEvidence
  pinnedDistributorBrand: string | null
  enrichmentCandidateIds: number[]
  relevantCandidateIds: number[]
}

interface CandidatePoolEntry {
  classifier: ClassifierCatalogCandidate
  reconciler: ReconcilerCatalogCandidate
  enrichment: boolean
}

const PendingPurchaseCategoryRowSchema = z.object({
  name: z.string().nullable().optional(),
  subcategories: z.array(z.object({
    name: z.string().nullable().optional(),
  }).passthrough()).default([]),
}).passthrough()

// Sweed's `store.product.category.list` returns a BARE ARRAY of categories;
// some deployments / back-compat paths wrap it as `{ data: [...] }`. Accept
// both shapes and always yield the array — this mirrors the robust helpers the
// sibling jobs already use for the very same RPC (CategoryListResponseSchema in
// configWorkersCatalogRefreshJob, ListResponseSchema in
// applyPendingPurchaseRequestJob). The object-only schema this replaced threw a
// raw "expected object, received array" the first time the prospective
// classifier path invoked this RPC (packet-generation job for PO 159659).
export const PendingPurchaseCategoryListSchema = z.union([
  z.array(PendingPurchaseCategoryRowSchema),
  z
    .object({ data: z.array(PendingPurchaseCategoryRowSchema).default([]) })
    .passthrough()
    .transform((value) => value.data),
])

/**
 * Build the allowed taxonomy for C4/C5: the auto-classifiable top-level
 * categories, plus the live union of every enabled subcategory name Sweed
 * reports. Read-only; a failure bubbles up so the job retries rather than
 * silently shipping an all-`needs-review` packet from an empty subcategory set.
 */
async function loadPendingPurchaseAllowedTaxonomy(stateDealerId: number): Promise<ClassifierAllowedTaxonomy> {
  const categories = PendingPurchaseCategoryListSchema.parse(
    await callSweedRpc(stateDealerId, 'store.product.category.list', {}),
  )
  // Fail loud on an empty taxonomy rather than silently shipping an
  // all-`needs-review` packet built from an empty subcategory allow-list. The
  // union schema above accepts `{}`/`[]` (back-compat with the wrapped shape),
  // so this guard, not the parse, enforces the non-empty invariant.
  if (categories.length === 0) {
    throw new Error(
      'Sweed `store.product.category.list` returned no categories; refusing to classify pending purchases against an empty taxonomy.',
    )
  }
  const subcategories = new Set<string>()
  for (const category of categories) {
    for (const subcategory of category.subcategories) {
      const name = normalizeNonEmptyString(subcategory.name)
      if (name !== null) {
        subcategories.add(name)
      }
    }
  }
  return {
    categories: [...AUTO_CLASSIFIABLE_PENDING_PURCHASE_CATEGORIES],
    subcategories: [...subcategories],
  }
}

export async function collectPendingPurchaseLiveBrands(
  fetchPage: (page: number, pageSize: number) => Promise<unknown>,
): Promise<Array<{
  brandName: string
  sweedBrandId: number
}>> {
  const brands: Array<z.infer<typeof PendingPurchaseBrandRowSchema>> = []
  const seenIds = new Set<number>()
  let page = 1
  while (true) {
    const pageRows = PendingPurchaseBrandListSchema.parse(
      await fetchPage(page, PENDING_PURCHASE_BRAND_PAGE_SIZE),
    )
    let newRows = 0
    for (const brand of pageRows) {
      if (seenIds.has(brand.id)) continue
      seenIds.add(brand.id)
      brands.push(brand)
      newRows += 1
      if (brands.length > MAX_PENDING_PURCHASE_LIVE_BRANDS) {
        throw new Error(
          `Sweed brand directory exceeds the ${MAX_PENDING_PURCHASE_LIVE_BRANDS} brand safety limit.`,
        )
      }
    }
    if (pageRows.length === 0 || newRows === 0) break
    page += 1
  }
  const active = brands.filter((brand) => brand.enabled !== false && !isRetiredRecordName(brand.name))
  if (active.length === 0) {
    throw new Error(
      'Sweed `store.product.brand.list` returned no active brands; refusing to classify pending purchases against an empty brand directory.',
    )
  }
  if (active.length !== brands.length) {
    console.warn(`[pending-purchase] Skipped ${brands.length - active.length} disabled or retired Sweed brand(s).`)
  }
  return active.map((brand) => ({ brandName: brand.name, sweedBrandId: brand.id }))
}

async function loadPendingPurchaseLiveBrands(stateDealerId: number): Promise<Array<{
  brandName: string
  sweedBrandId: number
}>> {
  return collectPendingPurchaseLiveBrands((page, pageSize) =>
    callSweedRpc(stateDealerId, 'store.product.brand.list', { page, pageSize }),
  )
}

/**
 * C8a driving path. Turns the collected distributor-product groups into review
 * rows via one (or a few, chunked) event-level LLM classification pass(es),
 * validated by the deterministic reconciler, then composes the deterministic
 * pricing / market-evidence fields Helios owns. Parsekit + legacy run alongside
 * per row for the 3-way comparison record.
 */
async function buildLlmDrivenPendingPurchaseRows(input: {
  cache: CatalogCache
  db: Queryable
  groups: Map<string, PendingPositionGroup>
  hintBundleId: string | null
  jobId: number
  stateDealerId: number
}): Promise<LlmDrivenBuildResult> {
  const { cache, db, groups, hintBundleId, jobId, stateDealerId } = input

  const groupsArray = [...groups.values()]
  const totalGroups = groupsArray.length

  const emptyProvenance = (): PendingPurchaseClassifierProvenance => ({
    available: true,
    model: null,
    promptVersion: null,
    reconcilerVersion: null,
    hintBundleId,
    hintFactCount: 0,
    operatorNoteDocuments: [],
    glossaryEntryCount: 0,
    catalogCandidateCount: 0,
    classifierCalls: 0,
    rowCount: 0,
  })

  await updateJobProgress(jobId, {
    completed: 0,
    message: totalGroups > 0
      ? `Preparing ${totalGroups} unresolved distributor product${totalGroups === 1 ? '' : 's'} for the prospective classifier.`
      : 'No unresolved distributor products were found. Preparing an empty review packet.',
    phase: 'Resolving catalog actions',
    phaseCount: 3,
    phaseIndex: 2,
    total: totalGroups > 0 ? totalGroups : null,
  })

  if (totalGroups === 0) {
    // Nothing to classify — skip C4/C5 (both throw on zero rows) and ship the
    // empty packet exactly like the legacy path did. Still load the attached
    // evidence so its exact operator-note snapshot remains available from the
    // resulting packet even though no row needed classification.
    const evidence = await buildClassifierHintFacts(db, hintBundleId)
    return {
      rows: [],
      provenance: {
        ...emptyProvenance(),
        glossaryEntryCount: evidence.glossaryEntries.length,
        hintFactCount: evidence.hintFacts.length,
        operatorNoteDocuments: evidence.operatorNoteDocuments,
      },
    }
  }

  // ── Phase A: per-group context (parallel) ───────────────────────────────
  let contexts = await mapWithConcurrency(groupsArray, GROUP_CONTEXT_CONCURRENCY, (group) =>
    buildPendingPurchaseGroupContext(cache, group),
  )

  const vendorEvidenceByRow = await loadPendingPurchaseVendorEvidence(
    db,
    contexts.map((ctx) => ({
      rowKey: ctx.classifierRow.rowKey,
      purchaseRefs: [...ctx.group.orderIds].map((orderId) => ({
        dealerId: ctx.group.siteDealerId,
        poId: String(orderId),
      })),
      parsedBrand: normalizeNonEmptyString(ctx.parseComparison.winner?.brand),
      parsedCategory: normalizeNonEmptyString(ctx.parseComparison.winner?.category),
      explicitBrandOverride: ctx.pinnedDistributorBrand,
    })),
  )
  contexts = contexts.map((ctx) => {
    const vendorEvidence = vendorEvidenceByRow.get(ctx.classifierRow.rowKey)
    if (vendorEvidence === undefined) {
      throw new Error(`Vendor evidence returned no result for row "${ctx.classifierRow.rowKey}".`)
    }
    return {
      ...ctx,
      vendorEvidence,
      classifierRow: { ...ctx.classifierRow, vendorEvidence },
    }
  })

  // ── Phase B: hint facts + allowed taxonomy ──────────────────────────────
  const { hintFacts, glossaryEntries, operatorGuidance, operatorNoteDocuments } = await buildClassifierHintFacts(
    db,
    hintBundleId,
  )
  const allowedTaxonomy = await loadPendingPurchaseAllowedTaxonomy(stateDealerId)
  const liveSweedBrands = await loadPendingPurchaseLiveBrands(stateDealerId)

  // ── Phase C: catalog candidate pool ─────────────────────────────────────
  const candidatePool = await buildPendingPurchaseCandidatePool(cache, contexts)
  contexts = contexts.map((ctx) => {
    const allowedCatalogProductIds = ctx.vendorEvidence.allowedBrandNames.length === 0
      ? []
      : ctx.relevantCandidateIds.filter((productId) => {
          const candidate = candidatePool.get(productId)?.classifier
          return candidate !== undefined && candidateMatchesVendorEvidence(candidate, ctx.vendorEvidence)
        })
    const vendorEvidence = { ...ctx.vendorEvidence, allowedCatalogProductIds }
    return { ...ctx, vendorEvidence, classifierRow: { ...ctx.classifierRow, vendorEvidence } }
  })

  // ── Phase D: chunked classify → single reconcile ────────────────────────
  const chunks = chunkGroupContextsForClassifier(contexts)
  const allDrafts: PendingPurchaseLlmDraftRowLike[] = []
  let model: string | null = null
  let promptVersion: string | null = null
  let classifierCalls = 0

  for (const [chunkIndex, chunk] of chunks.entries()) {
    await updateJobProgress(jobId, {
      completed: chunkIndex,
      message: `Classifying delivery event ${chunkIndex + 1} of ${chunks.length} (${chunk.length} line${chunk.length === 1 ? '' : 's'}) with the prospective LLM classifier.`,
      phase: 'Resolving catalog actions',
      phaseCount: 3,
      phaseIndex: 2,
      total: chunks.length,
    })

    const catalogCandidates = selectClassifierCandidatesForChunk(chunk, candidatePool)
    const classificationEvidence = await loadPendingPurchaseClassificationEvidence(
      db,
      chunk.map((ctx) => ({
        rowKey: ctx.classifierRow.rowKey,
        siteDealerId: ctx.group.siteDealerId,
        distributorProductId: ctx.classifierRow.distributorProductId,
        distributorProductName: ctx.classifierRow.distributorProductName,
        brandNames: [...ctx.vendorEvidence.allowedBrandNames, ctx.parseComparison.winner?.brand ?? '']
          .filter((name) => name.trim().length > 0),
      })),
      liveSweedBrands,
    )
    const offeredCandidateIds = new Set(catalogCandidates.map((candidate) => candidate.productId))
    const chunkRows = chunk.map((ctx) => ({
      ...ctx.classifierRow,
      classificationEvidence: classificationEvidence.get(ctx.classifierRow.rowKey),
      vendorEvidence: {
        ...ctx.classifierRow.vendorEvidence,
        allowedCatalogProductIds: ctx.classifierRow.vendorEvidence.allowedCatalogProductIds.filter(
          (productId) => offeredCandidateIds.has(productId),
        ),
      },
    }))
    const chunkResult = await classifyPendingPurchasePacketWithLlm({
      db,
      eventDescription: describeClassifierEvent(chunk),
      rows: chunkRows,
      catalogCandidates,
      hintFacts,
      glossaryEntries,
      operatorGuidance,
      allowedTaxonomy,
    })

    classifierCalls += chunkResult.classifierCalls
    if (model === null) {
      model = chunkResult.model
      promptVersion = chunkResult.promptVersion
    } else if (chunkResult.model !== model || chunkResult.promptVersion !== promptVersion) {
      // A model/prompt switch mid-packet would make the merged envelope
      // internally inconsistent. Fail loud rather than persist a mixed packet.
      throw new Error(
        `Classifier returned inconsistent provenance across chunks (${model}@${promptVersion} vs ${chunkResult.model}@${chunkResult.promptVersion}); regenerate the packet.`,
      )
    }
    allDrafts.push(...chunkResult.drafts)
  }

  const mergedClassifierResult = {
    schemaVersion: PENDING_PURCHASE_CLASSIFIER_SCHEMA_VERSION,
    model: model ?? '',
    promptVersion: promptVersion ?? '',
    drafts: allDrafts,
  }

  const reconcileResult = reconcilePendingPurchaseDrafts({
    classifierResult: mergedClassifierResult,
    rows: contexts.map((ctx) => ctx.classifierRow),
    catalogCandidates: selectReconcilerCandidates(candidatePool),
    allowedTaxonomy,
  })

  const classificationByRowKey = new Map(
    reconcileResult.classifications.map((classification) => [classification.rowKey, classification]),
  )

  // ── Phase E: compose deterministic rows ─────────────────────────────────
  const rows = await mapWithConcurrency(contexts, GROUP_CONTEXT_CONCURRENCY, async (ctx) => {
    const classification = classificationByRowKey.get(ctx.classifierRow.rowKey)
    if (classification === undefined) {
      // Reconciler guarantees one classification per input row; belt-and-braces.
      throw new Error(`Reconciler returned no classification for row "${ctx.classifierRow.rowKey}".`)
    }
    return composePendingPurchaseRowFromReconciled({ cache, ctx, classification })
  })

  // Family-average cost fallback must see the WHOLE packet population.
  applyFamilyAverageCostFallback(rows)

  rows.sort((left, right) => {
    const siteComparison = left.siteLabel.localeCompare(right.siteLabel)
    if (siteComparison !== 0) {
      return siteComparison
    }
    return left.distributorProductName.localeCompare(right.distributorProductName)
  })

  return {
    rows,
    provenance: {
      available: true,
      model: reconcileResult.model,
      promptVersion: reconcileResult.promptVersion,
      reconcilerVersion: reconcileResult.reconcilerVersion,
      hintBundleId,
      hintFactCount: hintFacts.length,
      operatorNoteDocuments,
      glossaryEntryCount: glossaryEntries.length,
      catalogCandidateCount: candidatePool.size,
      classifierCalls,
      rowCount: rows.length,
    },
  }
}

// The classifier's drafts are already schema-validated; we only need a
// structural handle for merging chunk outputs before handing them back to C5.
type PendingPurchaseLlmDraftRowLike = Awaited<
  ReturnType<typeof classifyPendingPurchasePacketWithLlm>
>['drafts'][number]

async function mapWithConcurrency<TItem, TResult>(
  items: readonly TItem[],
  limit: number,
  fn: (item: TItem) => Promise<TResult>,
): Promise<TResult[]> {
  const results: TResult[] = new Array<TResult>(items.length)
  for (let start = 0; start < items.length; start += limit) {
    const batch = items.slice(start, start + limit)
    const batchResults = await Promise.all(batch.map((item) => fn(item)))
    for (const [offset, value] of batchResults.entries()) {
      results[start + offset] = value
    }
  }
  return results
}

async function buildPendingPurchaseGroupContext(
  cache: CatalogCache,
  group: PendingPositionGroup,
): Promise<PendingPurchaseGroupContext> {
  const stateDistributorProductRow = await findExactDistributorProductRow(group)
  const resolvedCost = resolveEffectiveUnitCost(group.positions, stateDistributorProductRow)
  const sampleLike = group.positions.some((position) => isSampleLike(position))
  const suggestionCandidates = collectSuggestionCandidates(group.positions)
  const knownDistributorName = stateDistributorProductRow?.distributorName ?? null
  const orderIds = [...group.orderIds].sort((left, right) => left - right)
  const positionIds = group.positions.map((position) => position.id).sort((left, right) => left - right)

  const rowInputSignature = sha256(
    JSON.stringify({
      distributorProductId: group.distributorProductId,
      distributorProductName: group.distributorProductName,
      effectiveUnitCost: resolvedCost.value,
      knownDistributorName,
      orderIds,
      positionIds,
      sampleLike,
      siteDealerId: group.siteDealerId,
      siteKey: group.siteKey,
    }),
  )

  // Parsekit + legacy shadow. Runs for EVERY group (keeps the reverse-shadow
  // scorecard live) and yields the parsekit/legacy legs of the 3-way record.
  const parseComparison = computePendingPurchaseParseComparison(group.distributorProductName)

  // Distributor-brand override (operator-curated white-label pins). Surfaced as
  // a review flag when it disagrees with the model; never silently rewritten.
  const override = await resolveDistributorBrandOverride(group.distributorNames)
  const pinnedDistributorBrand = override.status === 'matched'
    ? override.brandProfile.displayBrandName
    : null

  const sweedSuggestions: ClassifierSweedSuggestion[] = suggestionCandidates
    .filter((candidate): candidate is SuggestedProductCandidate & { productId: number } => candidate.productId !== null)
    .map((candidate) => ({
      productId: candidate.productId,
      productName: candidate.productName,
      score: candidate.score,
    }))

  const classifierRow: ClassifierRowInput = {
    rowKey: `${group.siteKey}:${group.distributorProductId}`,
    distributorProductId: group.distributorProductId,
    distributorProductName: group.distributorProductName,
    distributorNames: [...group.distributorNames].sort(),
    quantity: sumPositionQuantity(group.positions),
    unitCost: resolvedCost.value,
    currentDistributorLinkProductId: stateDistributorProductRow?.productId ?? null,
    sweedSuggestions,
    vendorEvidence: {
      status: 'unknown',
      vendorId: null,
      vendorName: null,
      confidence: 'none',
      allowedBrandNames: [],
      allowedCatalogProductIds: [],
      evidence: [],
    },
  }

  const enrichmentCandidateIds: number[] = []
  if (stateDistributorProductRow?.productId) {
    enrichmentCandidateIds.push(stateDistributorProductRow.productId)
  }
  for (const suggestion of sweedSuggestions) {
    enrichmentCandidateIds.push(suggestion.productId)
  }
  // EXACT_REUSE_PRODUCT_IDS: operator-pinned exact name → productId reuse. Add
  // it to the candidate pool so it is available for pinning/duplicate context.
  const exactReuseId = EXACT_REUSE_PRODUCT_IDS.get(group.distributorProductName)
  if (exactReuseId !== undefined) {
    enrichmentCandidateIds.push(exactReuseId)
  }

  const searchCandidateIds = await collectSearchCandidateIds(cache, group.distributorProductName, parseComparison)

  const relevantCandidateIds = dedupePositiveInts([...enrichmentCandidateIds, ...searchCandidateIds])

  return {
    group,
    stateDistributorProductRow,
    resolvedCost,
    sampleLike,
    suggestionCandidates,
    rowInputSignature,
    parseComparison,
    classifierRow,
    vendorEvidence: classifierRow.vendorEvidence,
    pinnedDistributorBrand,
    enrichmentCandidateIds: dedupePositiveInts(enrichmentCandidateIds),
    relevantCandidateIds,
  }
}

function sumPositionQuantity(positions: z.infer<typeof PurchaseOrderPositionSchema>[]): number | null {
  let total = 0
  let sawValue = false
  for (const position of positions) {
    const qty = normalizeFiniteNumber(position.orderPositionQty)
      ?? normalizeFiniteNumber(position.distributorProductQty)
      ?? normalizeFiniteNumber(position.qty)
    if (qty !== null) {
      total += qty
      sawValue = true
    }
  }
  return sawValue ? total : null
}

async function collectSearchCandidateIds(
  cache: CatalogCache,
  distributorProductName: string,
  parseComparison: PendingPurchaseParseComparison,
): Promise<number[]> {
  const ids: number[] = []
  try {
    const nameHits = await cache.searchProducts(distributorProductName)
    for (const hit of nameHits.slice(0, CANDIDATE_SEARCH_HITS_PER_ROW)) {
      ids.push(hit.id)
    }
  } catch {
    // A search miss is non-fatal — the row just gets fewer candidate/dup
    // context rows; the classifier still runs.
  }

  const brand = parseComparison.winner?.brand ?? null
  if (brand !== null && brand.trim().length > 0) {
    try {
      const brandHits = await cache.searchProducts(brand)
      for (const hit of brandHits.slice(0, CANDIDATE_BRAND_HITS_PER_ROW)) {
        ids.push(hit.id)
      }
    } catch {
      // non-fatal (see above)
    }
  }
  return dedupePositiveInts(ids)
}

function dedupePositiveInts(values: readonly number[]): number[] {
  const seen = new Set<number>()
  const out: number[] = []
  for (const value of values) {
    if (Number.isFinite(value) && value > 0 && !seen.has(value)) {
      seen.add(value)
      out.push(value)
    }
  }
  return out
}

/**
 * Fetch + shape every distinct candidate product referenced by any group.
 * Enrichment candidates (the row's current distributor link + Sweed
 * suggestions + operator-pinned exact reuse) are ALWAYS included — the
 * reconciler force-downgrades a row to needs-review when its link product is
 * absent from the candidate set, so completeness there is a correctness gate,
 * not a recall knob. Raw-name / brand search hits fill the remaining budget for
 * duplicate detection + model context only.
 */
async function buildPendingPurchaseCandidatePool(
  cache: CatalogCache,
  contexts: readonly PendingPurchaseGroupContext[],
): Promise<Map<number, CandidatePoolEntry>> {
  const enrichmentIds = new Set<number>()
  const searchIds = new Set<number>()
  for (const ctx of contexts) {
    for (const id of ctx.enrichmentCandidateIds) {
      enrichmentIds.add(id)
    }
    for (const id of ctx.relevantCandidateIds) {
      if (!ctx.enrichmentCandidateIds.includes(id)) {
        searchIds.add(id)
      }
    }
  }

  // Enrichment first (unconditional), then search hits up to the cap.
  const orderedIds: number[] = [...enrichmentIds]
  for (const id of searchIds) {
    if (orderedIds.length >= MAX_RECONCILER_CANDIDATES) {
      break
    }
    orderedIds.push(id)
  }

  const pool = new Map<number, CandidatePoolEntry>()
  const summaries = await mapWithConcurrency(orderedIds, GROUP_CONTEXT_CONCURRENCY, async (productId) => {
    try {
      const summary = await cache.getProductSummary(productId)
      return { productId, summary }
    } catch {
      // A candidate may point at a product deleted/hidden upstream; skip it.
      return { productId, summary: null }
    }
  })

  for (const { productId, summary } of summaries) {
    if (summary === null) {
      continue
    }
    const entry = toCandidatePoolEntry(summary)
    if (entry === null) {
      continue
    }
    entry.enrichment = enrichmentIds.has(productId)
    pool.set(productId, entry)
  }

  return pool
}

function toCandidatePoolEntry(summary: LiveProductSummary): CandidatePoolEntry | null {
  const productName = normalizeNonEmptyString(summary.productName)
  if (productName === null) {
    // A live product with no name cannot be a validated reuse target
    // (ReconciledReuseSnapshot.productName is non-null); do not offer it.
    return null
  }
  const classifier: ClassifierCatalogCandidate = {
    productId: summary.productId,
    productName,
    brand: normalizeNonEmptyString(summary.brand),
    category: normalizeNonEmptyString(summary.category),
    subcategory: normalizeNonEmptyString(summary.subcategory),
    groupName: normalizeNonEmptyString(summary.groupName),
    variantTab: normalizeNonEmptyString(summary.tab),
    strain: normalizeNonEmptyString(summary.strain),
    size: normalizeNonEmptyString(summary.size),
    packCount: summary.packCount > 0 ? summary.packCount : null,
  }
  const reconciler: ReconcilerCatalogCandidate = {
    ...classifier,
    groupId: summary.groupId > 0 ? summary.groupId : null,
  }
  return { classifier, reconciler, enrichment: false }
}

function selectClassifierCandidatesForChunk(
  chunk: readonly PendingPurchaseGroupContext[],
  pool: ReadonlyMap<number, CandidatePoolEntry>,
): ClassifierCatalogCandidate[] {
  const enrichment: ClassifierCatalogCandidate[] = []
  const search: ClassifierCatalogCandidate[] = []
  const seen = new Set<number>()
  for (const ctx of chunk) {
    for (const id of ctx.relevantCandidateIds) {
      if (seen.has(id)) {
        continue
      }
      const entry = pool.get(id)
      if (entry === undefined) {
        continue
      }
      if (ctx.enrichmentCandidateIds.includes(id) || entry.enrichment) {
        seen.add(id)
        enrichment.push(entry.classifier)
      } else if (candidateMatchesVendorEvidence(entry.classifier, ctx.vendorEvidence)) {
        seen.add(id)
        search.push(entry.classifier)
      }
    }
  }
  return [...enrichment, ...search].slice(0, MAX_CLASSIFIER_CANDIDATES_PER_CALL)
}

function candidateMatchesVendorEvidence(
  candidate: ClassifierCatalogCandidate,
  evidence: ClassifierVendorEvidence,
): boolean {
  if (evidence.allowedBrandNames.length === 0) return true
  if (candidate.brand === null) return false
  const brandKey = candidate.brand.trim().toLocaleLowerCase('en-US')
  return evidence.allowedBrandNames.some(
    (brand) => brand.trim().toLocaleLowerCase('en-US') === brandKey,
  )
}

function formatVendorEvidenceNote(evidence: ClassifierVendorEvidence): string {
  const subject = evidence.vendorName === null
    ? evidence.status === 'explicit-override' ? 'Explicit brand override' : 'Vendor evidence'
    : `Vendor evidence for ${evidence.vendorName}`
  const allowed = evidence.allowedBrandNames.length > 0
    ? ` Allowed brands: ${evidence.allowedBrandNames.join(', ')}.`
    : ''
  const confidence = evidence.confidence === 'none' ? 'no confidence' : `${evidence.confidence} confidence`
  return `${subject} (${confidence}): ${evidence.evidence.join(' ')}${allowed}`
}

export function downgradeExplicitBrandConflict(input: {
  classification: ReconciledPendingPurchaseClassification
  explicitBrand: string
  catalogAction: string
  additionalCandidates: readonly ReconciledSuggestionCandidate[]
}): ReconciledPendingPurchaseClassification {
  const suggestions = new Map(
    input.classification.suggestionCandidates.map((candidate) => [candidate.productId, candidate]),
  )
  if (input.classification.reuseProductId !== null) {
    suggestions.set(input.classification.reuseProductId, {
      productId: input.classification.reuseProductId,
      productName: input.classification.reuseProductName,
      score: null,
    })
  }
  for (const candidate of input.additionalCandidates) suggestions.set(candidate.productId, candidate)
  return {
    ...input.classification,
    actionType: 'needs-review',
    catalogAction: input.catalogAction,
    mappingStatus: 'needs_review',
    reuseProductId: null,
    reuseProductName: null,
    reuseGroupId: null,
    validatedReuseSnapshot: null,
    targetBrand: input.explicitBrand,
    suggestionCandidates: [...suggestions.values()],
  }
}

function selectReconcilerCandidates(
  pool: ReadonlyMap<number, CandidatePoolEntry>,
): ReconcilerCatalogCandidate[] {
  const enrichment: ReconcilerCatalogCandidate[] = []
  const search: ReconcilerCatalogCandidate[] = []
  for (const entry of pool.values()) {
    if (entry.enrichment) {
      enrichment.push(entry.reconciler)
    } else {
      search.push(entry.reconciler)
    }
  }
  // Enrichment candidates (every row's current distributor link + Sweed
  // suggestions + operator pins) MUST all reach the reconciler: a missing link
  // candidate force-downgrades that row to needs-review. If enrichment alone
  // exceeds the cap, silently slicing it would spuriously downgrade rows — fail
  // loud instead of degrading (this path has no legacy fallback). Reaching this
  // needs >MAX_RECONCILER_CANDIDATES distinct enrichment products in one packet.
  if (enrichment.length > MAX_RECONCILER_CANDIDATES) {
    throw new Error(
      `Reconciler enrichment candidate set (${enrichment.length}) exceeds the ${MAX_RECONCILER_CANDIDATES} cap; raise MAX_RECONCILER_CANDIDATES or split the packet — slicing would spuriously downgrade rows.`,
    )
  }
  return [...enrichment, ...search].slice(0, MAX_RECONCILER_CANDIDATES)
}

/**
 * Chunk the group contexts on delivery boundaries (site + distributor), then
 * sub-chunk any single delivery larger than the per-call row cap so the model
 * sees as much of one real delivery as possible in a single call.
 */
function chunkGroupContextsForClassifier(
  contexts: readonly PendingPurchaseGroupContext[],
): PendingPurchaseGroupContext[][] {
  const byDelivery = new Map<string, PendingPurchaseGroupContext[]>()
  for (const ctx of contexts) {
    const distributorKey = [...ctx.group.distributorNames].map((name) => name.toLowerCase()).sort().join('|')
    const key = `${ctx.group.siteKey}\u0001${distributorKey}`
    const bucket = byDelivery.get(key)
    if (bucket === undefined) {
      byDelivery.set(key, [ctx])
    } else {
      bucket.push(ctx)
    }
  }

  const chunks: PendingPurchaseGroupContext[][] = []
  for (const delivery of byDelivery.values()) {
    for (let start = 0; start < delivery.length; start += LLM_CLASSIFIER_MAX_ROWS_PER_CALL) {
      chunks.push(delivery.slice(start, start + LLM_CLASSIFIER_MAX_ROWS_PER_CALL))
    }
  }
  return chunks
}

function describeClassifierEvent(chunk: readonly PendingPurchaseGroupContext[]): string {
  const site = chunk[0]?.group.siteLabel ?? 'unknown site'
  const distributors = [...new Set(chunk.flatMap((ctx) => [...ctx.group.distributorNames]))].sort()
  const distributorLabel = distributors.length > 0 ? distributors.join(', ') : 'unknown distributor'
  return `${site} — ${distributorLabel} delivery, ${chunk.length} unresolved line${chunk.length === 1 ? '' : 's'}.`
}

/**
 * Hint evidence for one classifier call, split by kind: product `hintFacts`
 * and interpretation-only `glossaryEntries` (cited acronym/abbreviation
 * expansions) — both inert, cited, and UNTRUSTED — plus `operatorGuidance`, the
 * verbatim text of `operator_note` documents. Operator notes are authored only
 * by the authenticated operator, so unlike facts/glossary they are TRUSTED
 * guidance the classifier may follow; the classifier presents each on a
 * separate field so the prompt can describe their distinct trust roles.
 */
export interface ClassifierHintEvidence {
  readonly hintFacts: ClassifierHintFact[]
  readonly glossaryEntries: ClassifierGlossaryEntry[]
  readonly operatorGuidance: ClassifierOperatorGuidance[]
  readonly operatorNoteDocuments: Array<{
    contentSha256: string
    hintDocumentId: string
    sourceLabel: string | null
  }>
}

export async function buildClassifierHintFacts(
  db: Queryable,
  hintBundleId: string | null,
): Promise<ClassifierHintEvidence> {
  if (hintBundleId === null) {
    return { hintFacts: [], glossaryEntries: [], operatorGuidance: [], operatorNoteDocuments: [] }
  }

  // Close the enqueue race: the generate job is frequently queued by the same
  // operator action that just added a hint document, before the async C3
  // extraction job has written its facts. If any document is still awaiting
  // extraction, defer this job (retry shortly) instead of failing the whole
  // packet. RetryableWorkerError bounds the deferral to the worker loop's
  // max-attempts budget, so a genuinely stuck extraction dead-letters rather
  // than looping forever.
  const progress = await getPendingPurchaseHintExtractionProgress(db, hintBundleId)

  // An attached bundle id that resolves to ZERO documents is an operator error
  // (a missing / fully-removed / mistyped bundle), not a legitimately
  // empty-facts bundle. Fail loud so it is fixed rather than silently ignored.
  if (progress.total === 0) {
    throw new Error(
      `Hint bundle "${hintBundleId}" has no documents; it is missing or was fully removed. Attach a valid hint bundle or clear it before generating.`,
    )
  }

  if (progress.pending > 0) {
    throw new RetryableWorkerError(
      `Hint bundle "${hintBundleId}" still has ${progress.pending} of ${progress.total} document(s) awaiting extraction; deferring generation until extraction completes.`,
      { delayMs: HINT_EXTRACTION_RETRY_DELAY_MS },
    )
  }

  const [bundleFacts, bundleGlossary, operatorNotePointers] = await Promise.all([
    loadExtractedPendingPurchaseHintFactsForBundle(db, hintBundleId),
    loadExtractedPendingPurchaseHintGlossaryForBundle(db, hintBundleId),
    loadPendingPurchaseHintOperatorNotesForBundle(db, hintBundleId),
  ])

  // Read the verbatim text of every operator note. An operator note is TRUSTED
  // guidance that must reach C4 even when C3 extracted 0 facts / 0 glossary from
  // it (the #69 failure: free-text notes like "MZ is Moony Zooties, an existing
  // brand" extracted to nothing and were dropped). A blob read / integrity
  // failure is fatal — generating without the operator's guidance would silently
  // recreate the incident — so let it propagate rather than degrade.
  const store = getHintDocumentStore()
  const operatorGuidance: ClassifierOperatorGuidance[] = await Promise.all(
    operatorNotePointers.map(async (note) => {
      const blob = await store.read(note.pointer)
      return {
        hintDocumentId: note.hintDocumentId,
        sourceLabel: note.sourceLabel,
        text: blob.text,
      }
    }),
  )

  if (bundleFacts.length === 0 && bundleGlossary.length === 0 && operatorGuidance.length === 0) {
    // Every document reached a terminal state but none produced usable
    // classifier evidence — no product fact, no glossary/acronym expansion
    // (FreshlyBakedNYC/automation#69), AND no operator note — or extraction
    // failed/skipped. This is NOT the enqueue race. Rather than abort the
    // operator's whole packet run, degrade gracefully: generate WITHOUT hint
    // evidence and warn, so a hint that produced nothing usable can never block
    // generation.
    console.warn(
      `[pending-purchase] Hint bundle "${hintBundleId}" produced no usable classifier evidence ` +
        `(documents: ${progress.total}, extracted: ${progress.extracted}, failed: ${progress.failed}, ` +
        `skipped: ${progress.skipped}); generating without hint evidence.`,
    )
    return { hintFacts: [], glossaryEntries: [], operatorGuidance: [], operatorNoteDocuments: [] }
  }
  if (bundleFacts.length > MAX_CLASSIFIER_HINT_FACTS) {
    throw new Error(
      `Hint bundle "${hintBundleId}" has ${bundleFacts.length} facts (limit ${MAX_CLASSIFIER_HINT_FACTS}). Trim the bundle.`,
    )
  }
  if (bundleGlossary.length > MAX_CLASSIFIER_HINT_FACTS) {
    throw new Error(
      `Hint bundle "${hintBundleId}" has ${bundleGlossary.length} glossary entries (limit ${MAX_CLASSIFIER_HINT_FACTS}). Trim the bundle.`,
    )
  }
  return {
    hintFacts: bundleFacts.map((bundleFact) => ({
      citedId: `${bundleFact.hintDocumentId}#${bundleFact.fact.factId}`,
      hintDocumentId: bundleFact.hintDocumentId,
      factId: bundleFact.fact.factId,
      kind: bundleFact.kind,
      intent: bundleFact.intent,
      fact: bundleFact.fact,
    })),
    glossaryEntries: bundleGlossary.map((bundleEntry) => ({
      citedId: `${bundleEntry.hintDocumentId}#${bundleEntry.entry.factId}`,
      hintDocumentId: bundleEntry.hintDocumentId,
      factId: bundleEntry.entry.factId,
      term: bundleEntry.entry.term,
      expansion: bundleEntry.entry.expansion,
      note: bundleEntry.entry.note,
    })),
    operatorGuidance,
    operatorNoteDocuments: operatorNotePointers.map((note) => ({
      contentSha256: note.pointer.contentSha256,
      hintDocumentId: note.hintDocumentId,
      sourceLabel: note.sourceLabel,
    })),
  }
}

/**
 * Compose one persistable review row from a reconciled classification, applying
 * the deterministic pricing / market-evidence / anchor logic Helios owns (the
 * reconciler is pure and computes none of that). Also attaches the 3-way
 * comparison record + LLM provenance to `raw_row_json`.
 */
async function composePendingPurchaseRowFromReconciled(input: {
  cache: CatalogCache
  ctx: PendingPurchaseGroupContext
  classification: ReconciledPendingPurchaseClassification
}): Promise<GeneratedPendingPurchaseRow> {
  const { cache, ctx } = input
  let classification = input.classification
  // The 3-way comparison's "llm" leg must reflect what the model + reconciler
  // actually produced, before any operator-pin override below, so the C8b ETL
  // page can audit the true LLM decision (the pin is surfaced separately via
  // the row's notes/actionType).
  const llmClassificationForComparison = input.classification
  const { group, resolvedCost, sampleLike, suggestionCandidates } = ctx

  const orderIds = [...group.orderIds].sort((left, right) => left - right)
  const positionIds = group.positions.map((position) => position.id).sort((left, right) => left - right)
  const rowCacheKey = `${group.siteKey}:${group.distributorProductId}`
  const suggestionNote = formatSuggestionCandidateNote(suggestionCandidates)
  const existingDistributorLinks = describeExistingDistributorLinks(ctx.stateDistributorProductRow)

  const extraReviewFlags: string[] = []
  const extraNotes: string[] = []

  // Current links and Sweed suggestions remain visible to C5 even when vendor
  // evidence disagrees, but an explicit operator brand pin must never be
  // silently replaced by their catalog brand. Preserve both facts for review.
  if (
    ctx.vendorEvidence.status === 'explicit-override'
    && classification.validatedReuseSnapshot !== null
    && !candidateMatchesVendorEvidence(
      { ...classification.validatedReuseSnapshot, groupName: classification.validatedReuseSnapshot.groupName },
      ctx.vendorEvidence,
    )
  ) {
    classification = downgradeExplicitBrandConflict({
      classification,
      catalogAction: 'Review the explicit brand override against the existing catalog reuse link.',
      explicitBrand: ctx.vendorEvidence.allowedBrandNames[0]!,
      additionalCandidates: [],
    })
    extraReviewFlags.push('Explicit brand override conflicts with existing catalog link')
    extraNotes.push('The explicit brand override was preserved; the conflicting existing link requires operator review.')
  }

  // Operator-pinned exact-name reuse (EXACT_REUSE_PRODUCT_IDS). Trusted like a
  // DB distributor link: if the reconciler did not already confirm a reuse, pin
  // it deterministically here (the model/reconciler cannot "discover" a hand-
  // curated pin on its own).
  //
  // NEVER let the pin override an existing distributor link the reconciler
  // couldn't confirm: when a row already has a live current distributor link
  // that points somewhere OTHER than the pin, C5 deliberately returns
  // reuseProductId===null / needs-review ("reviewer must resolve"). Silently
  // pinning it to a different product there would (a) undo that guard and
  // (b) risk creating a second distributor link at apply time. The current
  // link keeps absolute priority (matching the legacy row builder); the pin
  // only applies when there is no conflicting live link.
  const exactReuseId = EXACT_REUSE_PRODUCT_IDS.get(group.distributorProductName)
  const currentLinkId = ctx.classifierRow.currentDistributorLinkProductId
  const pinDoesNotConflictWithCurrentLink = currentLinkId === null || currentLinkId === exactReuseId
  if (exactReuseId !== undefined) {
    const pinned = await tryGetProductSummary(cache, exactReuseId)
    const pinnedCandidate = pinned === null ? null : toCandidatePoolEntry(pinned)?.classifier ?? null
    const conflictsWithExplicitOverride =
      pinnedCandidate !== null
      && ctx.vendorEvidence.status === 'explicit-override'
      && !candidateMatchesVendorEvidence(pinnedCandidate, ctx.vendorEvidence)
    if (pinned !== null && pinnedCandidate !== null && conflictsWithExplicitOverride) {
      classification = downgradeExplicitBrandConflict({
        classification,
        catalogAction: 'Review the explicit brand override against the exact-name reuse pin.',
        explicitBrand: ctx.vendorEvidence.allowedBrandNames[0]!,
        additionalCandidates: [{
          productId: pinned.productId,
          productName: pinned.productName,
          score: null,
        }],
      })
      extraReviewFlags.push('Explicit brand override conflicts with exact-name reuse pin')
      extraNotes.push('The explicit brand override was preserved; the conflicting exact-name reuse pin requires operator review.')
    } else if (
      pinned !== null
      && pinnedCandidate !== null
      && classification.reuseProductId === null
      && pinDoesNotConflictWithCurrentLink
    ) {
      classification = {
        ...classification,
        actionType: 'mapping-only',
        catalogAction: `Map existing purchase distributor product ${group.distributorProductId} onto operator-pinned variant ${pinned.productName}.`,
        reuseProductId: pinned.productId,
        reuseProductName: pinned.productName,
        reuseGroupId: pinned.groupId,
        validatedReuseSnapshot: snapshotFromSummary(pinned),
        targetBrand: pinned.brand || classification.targetBrand,
        targetCategory: pinned.category || classification.targetCategory,
        targetSubcategory: normalizeNonEmptyString(pinned.subcategory),
        targetGroupName: pinned.groupName || classification.targetGroupName,
        targetVariantName: pinned.productName,
        targetVariantTab: pinned.tab || classification.targetVariantTab,
        targetStrainName: pinned.strain || classification.targetStrainName,
        targetSize: pinned.size || classification.targetSize,
        targetPackCount: pinned.packCount > 0 ? pinned.packCount : classification.targetPackCount,
      }
      extraNotes.push(`Operator-pinned exact reuse to ${pinned.productName}.`)
    }
  }

  const reuseProductId = classification.reuseProductId
  const reuse = reuseProductId !== null ? await tryGetProductSummary(cache, reuseProductId) : null

  // Distributor-brand override disagreement flag (never a silent rewrite).
  if (
    ctx.pinnedDistributorBrand !== null
    && reuse === null
    && classification.targetBrand !== null
    && compactText(ctx.pinnedDistributorBrand) !== compactText(classification.targetBrand)
  ) {
    extraReviewFlags.push('Distributor brand override disagrees with classifier — verify brand')
    extraNotes.push(
      `Distributor mapping pins brand "${ctx.pinnedDistributorBrand}", but the classifier proposed "${classification.targetBrand}". Verify before creating.`,
    )
  }

  const lane: PendingPurchaseFamilyLane = {
    brand: classification.targetBrand ?? '',
    category: classification.targetCategory ?? '',
    subcategory: classification.targetSubcategory ?? '',
    size: classification.targetSize ?? '',
    packCount: classification.targetPackCount ?? 1,
  }
  const anchors = lane.brand.trim().length > 0 && lane.category.trim().length > 0
    ? await familyAnchorProductsForLane(cache, lane)
    : []
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

  const isNeedsReview = classification.actionType === 'needs-review'
  const pricingSupport = isNeedsReview
    ? null
    : await cache.getPendingPurchasePricingSupport({
        brand: lane.brand,
        category: lane.category,
        currentPrice,
        groupName: classification.targetGroupName || classification.targetVariantName || group.distributorProductName,
        subcategory: normalizeNonEmptyString(classification.targetSubcategory),
        variantName: classification.targetVariantName || group.distributorProductName,
        variantTab: classification.targetVariantTab || '',
        wholesaleCost: resolvedCost.value,
      })

  const publicSources = pricingSupport
    ? [...new Set(
        (pricingSupport.evidence?.matchedListings ?? [])
          .map((listing) => normalizeNonEmptyString(listing.url))
          .filter((url): url is string => url !== null),
      )]
    : []

  const reuseReason = reuse !== null
    ? `Reuse confirmed for ${reuse.productName}.`
    : null

  const notes = joinNotes([
    classification.notes,
    formatVendorEvidenceNote(ctx.vendorEvidence),
    reuseReason,
    resolvedCost.reason,
    !reuse && anchors.length > 0
      ? `Family anchor median uses ${anchors.length} live ${lane.brand} row${anchors.length === 1 ? '' : 's'} in the same size/category lane.`
      : null,
    suggestionNote,
    ...extraNotes,
  ])

  const reviewFlags = compactStrings([
    ...classification.reviewFlags,
    ...extraReviewFlags,
    proposedPrice === null ? 'Needs manual price' : null,
    !primaryImage ? 'Needs image review' : null,
    !reuse && !isNeedsReview && anchors.length === 0 ? 'No live family anchor' : null,
    pricingSupport?.marketAvailability === 'error' ? 'Pricing evidence lookup failed' : null,
  ])

  const threeWayComparison = buildThreeWayComparisonRecord(ctx, llmClassificationForComparison)

  return {
    actionType: classification.actionType,
    allowedSaleType: reuse?.allowedSaleType ?? 'Medical and recreational',
    anchorPrice,
    averageCompetitorPostTaxPrice: pricingSupport?.evidence?.averagePostTaxPrice ?? null,
    averageCompetitorPrice: pricingSupport?.evidence?.averagePreTaxPrice ?? null,
    catalogAction: classification.catalogAction,
    classifierConfidence: classification.confidence,
    classifierRationale: classification.rationale,
    citedHintIds: [...classification.citedHintIds],
    competitorMedianPostTaxPrice: pricingSupport?.evidence?.medianPostTaxPrice ?? null,
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
    expectedCategory: classification.targetCategory,
    expectedSubcategory: classification.targetSubcategory,
    existingDistributorLinks,
    gmPercent: computeGmPercent(resolvedCost.value, proposedPrice),
    marketAdvicePosture: pricingSupport?.marketAvailability ?? null,
    marketAdviceSummary: pricingSupport?.marketNote ?? null,
    marketListings: pricingSupport?.evidence?.matchedListings ?? [],
    marketNote: pricingSupport?.marketNote ?? null,
    marketSearchTerm: pricingSupport?.marketSearchTerm ?? null,
    notes,
    orderIds,
    positionIds,
    pricingEvidenceNote: pricingSupport?.marketNote ?? null,
    pricingMarketEvidence: pricingSupport?.evidence ? toJsonValue(pricingSupport.evidence) : null,
    primaryImageNote: primaryImage
      ? reuse
        ? 'Primary image comes from the live reused variant.'
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
    pricingReason: buildPricingReason({
      anchorPrice,
      currentPriceBasis,
      proposedPrice,
      resolvedCost: resolvedCost.value,
    }),
    parserSource: 'llm-classifier',
    proposedDescription,
    proposedPrice,
    reviewFlags,
    reviewerNotes: notes,
    reuseGroupId: classification.reuseGroupId,
    reuseProductId: classification.reuseProductId,
    reuseProductName: classification.reuseProductName ?? '',
    rowCacheKey,
    rowInputSignature: ctx.rowInputSignature,
    sampleLike,
    siteDealerId: group.siteDealerId,
    siteDealerName: group.siteDealerName,
    siteKey: group.siteKey,
    siteLabel: group.siteLabel,
    suggestionCandidates: classification.suggestionCandidates.length > 0
      ? classification.suggestionCandidates
      : suggestionCandidates,
    stateDistributorProductId: ctx.stateDistributorProductRow?.distributorProductId ?? null,
    targetBrand: classification.targetBrand ?? '',
    targetGroupName: classification.targetGroupName ?? '',
    targetPackCount: classification.targetPackCount,
    targetPrevalence: reuse ? null : ctx.parseComparison.winner?.prevalence ?? null,
    targetSize: classification.targetSize ?? '',
    targetStrain: classification.targetStrainName ?? '',
    targetVariantName: classification.targetVariantName ?? group.distributorProductName,
    targetVariantTab: classification.targetVariantTab ?? '',
    threeWayComparison,
    validatedReuseSnapshot: classification.validatedReuseSnapshot,
    warningFlags: [...classification.warningFlags],
  }
}

async function tryGetProductSummary(
  cache: CatalogCache,
  productId: number,
): Promise<LiveProductSummary | null> {
  try {
    return await cache.getProductSummary(productId)
  } catch {
    return null
  }
}

function snapshotFromSummary(summary: LiveProductSummary): ReconciledPendingPurchaseClassification['validatedReuseSnapshot'] {
  return {
    productId: summary.productId,
    productName: summary.productName,
    groupId: summary.groupId > 0 ? summary.groupId : null,
    brand: normalizeNonEmptyString(summary.brand),
    category: normalizeNonEmptyString(summary.category),
    subcategory: normalizeNonEmptyString(summary.subcategory),
    groupName: normalizeNonEmptyString(summary.groupName),
    variantTab: normalizeNonEmptyString(summary.tab),
    strain: normalizeNonEmptyString(summary.strain),
    size: normalizeNonEmptyString(summary.size),
    packCount: summary.packCount > 0 ? summary.packCount : null,
  }
}

/**
 * The per-line 3-way comparison persisted into `raw_row_json.threeWayComparison`
 * for the C8b ETL Details page: the LLM/reconciled result next to what parsekit
 * and the legacy heuristics would have produced for the same distributor name.
 */
function buildThreeWayComparisonRecord(
  ctx: PendingPurchaseGroupContext,
  classification: ReconciledPendingPurchaseClassification,
): JsonValue {
  return toJsonValue({
    schemaVersion: 1,
    llm: {
      actionType: classification.actionType,
      targetBrand: classification.targetBrand,
      targetCategory: classification.targetCategory,
      targetSubcategory: classification.targetSubcategory,
      targetGroupName: classification.targetGroupName,
      targetVariantName: classification.targetVariantName,
      targetVariantTab: classification.targetVariantTab,
      targetStrainName: classification.targetStrainName,
      targetSize: classification.targetSize,
      targetPackCount: classification.targetPackCount,
      reuseProductId: classification.reuseProductId,
      reuseProductName: classification.reuseProductName,
      confidence: classification.confidence,
      rationale: classification.rationale,
      reviewFlags: classification.reviewFlags,
      warningFlags: classification.warningFlags,
      citedHintIds: classification.citedHintIds,
    },
    parsekit: serializeParsekitLeg(ctx.parseComparison.parsekit),
    legacy: serializeLegacyLeg(ctx.parseComparison.legacy),
  })
}

function serializeParsekitLeg(parsekit: PendingPurchaseParseComparison['parsekit']): unknown {
  switch (parsekit.kind) {
    case 'ok':
      return {
        status: 'ok',
        output: parsekit.output,
        parserId: parsekit.parserId,
        ruleId: parsekit.ruleId,
        snapshotSha: parsekit.snapshotSha,
      }
    case 'fail':
      return {
        status: 'fail',
        reason: parsekit.reason,
        parserId: parsekit.parserId,
        snapshotSha: parsekit.snapshotSha,
      }
    case 'no_detect_match':
      return { status: 'no_detect_match', snapshotSha: parsekit.snapshotSha }
    case 'no_registry':
      return { status: 'no_registry' }
  }
}

function serializeLegacyLeg(legacy: PendingPurchaseParseComparison['legacy']): unknown {
  return legacy.ok
    ? { status: 'ok', output: legacy.output }
    : { status: 'error', error: legacy.error }
}

/**
 * Phase 3 — persist the generated packet and kick off market-data
 * refresh. Writes the packet through the single
 * `persistPendingPurchasePacket` contract inside one transaction, records
 * the resulting packet id back onto the job payload, then best-effort
 * enqueues a Lit Alerts refresh for every referenced product so the
 * reviewer opens the packet with fresh market evidence.
 */
async function persistGeneratedPendingPurchasePacket(input: {
  jobId: number
  packet: PendingPurchasePacket
  requestId: string
  requestedByUserId: number | null
}): Promise<void> {
  const { jobId, packet, requestId, requestedByUserId } = input

  await updateJobProgress(jobId, {
    completed: 1,
    message: `Saving ${packet.rows.length} pending-purchase review row${packet.rows.length === 1 ? '' : 's'} into Helios.`,
    phase: 'Persisting review packet',
    phaseCount: 3,
    phaseIndex: 3,
    total: 1,
  })

  const persistResult = await withTransaction(async (db) => {
    const result = await persistPendingPurchasePacket(db, {
      createdByUserId: requestedByUserId,
      importFileName: null,
      jobId,
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
      [jobId, result.packetId],
    )
    return result
  })

  // Drop every product the packet references onto the market-data
  // refresh queue at priority 10 so the pending-purchase reviewer sees
  // fresh Lit Alerts evidence by the time they open the packet. The
  // helper is idempotent within a 5-minute window so concurrent packets
  // referencing the same product will not double-enqueue.
  const packetProductIds = collectPendingPurchasePacketProductIds(packet)
  if (packetProductIds.length > 0) {
    try {
      await enqueueMarketRefreshForProducts(packetProductIds, {
        trigger: {
          kind: 'pending-purchase',
          pendingPurchaseRowId: persistResult.packetId,
        },
        priority: 10,
        requestedByUserId,
      })
    } catch (enqueueError) {
      // Refresh enqueue is best-effort; never fail packet generation
      // because the queue is temporarily unhappy.
      console.warn(
        `Failed to enqueue market-data refresh for packet ${persistResult.packetId}:`,
        enqueueError,
      )
    }
  }
}

/**
 * Pull every productId referenced by a packet's rows (preferring the
 * `reuseProductId` mapped variant on rows where Helios already resolved
 * the target). Uses the raw, looser shape because the import schema
 * is `.passthrough()`-typed.
 */
function collectPendingPurchasePacketProductIds(packet: PendingPurchasePacket): number[] {
  const ids = new Set<number>()
  for (const row of packet.rows) {
    const looseRow = row as unknown as Record<string, unknown>
    const reuseId = looseRow.reuseProductId
    if (typeof reuseId === 'number' && Number.isFinite(reuseId) && reuseId > 0) {
      ids.add(reuseId)
    }
  }
  return Array.from(ids)
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
    // Transient transport / dependency-unavailable failures from the
    // Lit Alerts partner API must NEVER silently degrade the row to
    // `marketAvailability='error'` with empty evidence — that ships a
    // packet with no comps, which is exactly the "timed out, gave up"
    // outcome we have explicitly ruled unacceptable. Bubble them up
    // so the worker loop's per-job retry (with exponential backoff)
    // re-runs the whole packet generation against a healthy upstream.
    // The partner client itself already does an inline retry loop
    // (`PARTNER_API_MAX_TRANSPORT_ATTEMPTS`), so anything still
    // throwing here has already survived several short retries.
    if (isRetryableWorkerError(error)) {
      throw error
    }
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
    brandId: null,
    category: input.category,
    categoryId: null,
    currentDescription: '',
    effects: [],
    flavorings: [],
    groupFullName,
    groupId: 1,
    groupName: input.groupName,
    imageUrl: null,
    images: [],
    productTabs: compactStrings([input.variantTab]),
    products: [{
      externalBarcode: null,
      gmPercent: computeGmPercent(input.wholesaleCost, input.currentPrice),
      imageUrl: null,
      images: [],
      name: input.variantName,
      packOfSize: null,
      price: input.currentPrice,
      productId,
      shortName: null,
      sizeName: null,
      sku: null,
      tab: input.variantTab,
      wholesaleCost: input.wholesaleCost,
    }],
    scents: [],
    strain: null,
    subcategory: input.subcategory,
    subcategoryId: null,
    tags: [],
  }
}

async function collectPendingPositions(
  jobId: number,
  fromDate: string,
  toDate: string,
  sites: HeliosPendingPurchaseSiteDealer[],
  purchaseOrderNumber: string | null,
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
    const allSiteOrders = await listOutstandingOrders(site.dealerId, fromDate, toDate)
    // Single-PO scope: when a purchase number is requested, drop every other
    // outstanding order at the list step (before any per-order detail/suggestion
    // RPCs) so only that one purchase runs through the flow.
    const siteOrders = purchaseOrderNumber
      ? allSiteOrders.filter((order) => matchesRequestedPurchaseOrder(order, purchaseOrderNumber))
      : allSiteOrders
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
  knownDistributorName: string | null
  resolvedCost: ResolvedCost
  rowInputSignature: string
  suggestionCandidates: SuggestedProductCandidate[]
}): Promise<PendingPurchaseParseResolution> {
  const observationRawRow = buildPendingPurchaseParserObservationRawRow(input)
  const normalizedDistributorProductName = normalizePendingPurchaseParserText(input.group.distributorProductName)

  // Distributor-keyed brand override (operator-curated). When the row's
  // distributor maps to a brand whose name never appears in the product
  // name (white-label product), pin the brand deterministically and skip
  // the LLM. This wins over learned product-name rules, which can carry
  // a wrong brand the LLM previously guessed from the distributor. We
  // deliberately return a PARTIAL resolution (parsed = null) so the row
  // is a brand-prefilled needs-review row, not a catalog-create with
  // missing category/size — the reviewer sets category/size/variant.
  const distributorOverride = await resolveDistributorBrandOverride(input.group.distributorNames)
  if (distributorOverride.status === 'matched') {
    const displayBrandName = distributorOverride.brandProfile.displayBrandName
    await withTransaction(async (db) => {
      await insertPendingPurchaseParseObservation(db, {
        brandProfileId: distributorOverride.brandProfile.id,
        inference: toJsonValue({
          matchedAliasId: distributorOverride.aliasId,
          matchedDistributor: distributorOverride.matchedDistributorName,
          parserSource: 'distributor-override',
        }),
        normalizedDistributorProductName,
        notes: `Pinned brand "${displayBrandName}" from distributor alias "${distributorOverride.matchedDistributorName}"; skipped LLM. Category/size require review.`,
        observationStatus: 'accepted',
        observationType: 'generation_parse',
        rawDistributorProductName: input.group.distributorProductName,
        rawRow: observationRawRow,
        rowInputSignature: input.rowInputSignature,
        sourceSystem: PENDING_PURCHASE_SOURCE_SYSTEM,
      })
    })

    return {
      brandProfile: distributorOverride.brandProfile,
      note: `Brand pinned to ${displayBrandName} from distributor mapping (${distributorOverride.matchedDistributorName}); set category, size, and variant before creating.`,
      parsed: null,
      parserSource: 'distributor-override',
      reviewFlag: 'Distributor brand override — set category/size/variant',
      rule: null,
      ruleTrust: 'none',
    }
  }
  if (distributorOverride.status === 'conflict') {
    // Misconfiguration (one distributor mapped to >1 brand). Surface it
    // and fall through to normal parsing rather than guessing.
    console.warn(`[pending-purchases] ${distributorOverride.note}`)
  }

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

  // Brand-keyed deterministic parsers. Some upstream distributors ship
  // METRC product names that carry NO brand token (e.g. Canna Cure
  // Farms' "Blue Dream- 1g Pre-roll"), so the name-only parser above
  // cannot dispatch them and throws. But the upstream brand IS known
  // here from the linked distributor product row, which makes these
  // names unambiguously parseable. Run the matching brand parser before
  // paying for an LLM round-trip.
  if (parsed === null && isCannaCureDistributorName(input.knownDistributorName)) {
    let cannaParsed: ParsedProductName | null = null
    try {
      cannaParsed = parseCannaCureName(input.group.distributorProductName)
    } catch (cannaError) {
      parseError = joinNotes([
        parseError,
        `Canna Cure brand parser could not classify "${input.group.distributorProductName}": ${cannaError instanceof Error ? cannaError.message : 'unknown error'}.`,
      ])
    }
    if (cannaParsed) {
      const brandProfile = await withTransaction(async (db) => {
        const profile = await upsertPendingPurchaseBrandProfile(db, {
          displayBrandName: cannaParsed.brand,
          metadata: { seededBy: 'known-distributor-brand-parser' },
          sourceSystem: PENDING_PURCHASE_SOURCE_SYSTEM,
          taxonomyHints: {
            category: cannaParsed.category,
            subcategory: cannaParsed.subcategory || null,
          },
        })
        await upsertPendingPurchaseBrandAlias(db, {
          aliasType: 'exact',
          aliasValue: cannaParsed.brand,
          brandProfileId: profile.id,
          confidence: 1,
          metadata: { seededBy: 'known-distributor-brand-parser' },
          provenance: 'known-distributor-brand-parser',
          status: 'active',
        })
        await insertPendingPurchaseParseObservation(db, {
          brandProfileId: profile.id,
          inference: toJsonValue({
            knownDistributorName: input.knownDistributorName,
            parsed: cannaParsed,
            parserMode: 'known-distributor-brand',
            parserSource: 'hardcoded-parser',
          }),
          normalizedDistributorProductName,
          notes: 'Resolved deterministically from the known upstream distributor brand (Canna Cure Farms).',
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
        parsed: cannaParsed,
        parserSource: 'hardcoded-parser',
        reviewFlag: null,
        rule: null,
        ruleTrust: 'none',
      }
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

type DistributorBrandOverrideResult =
  | { status: 'none' }
  | {
      status: 'matched'
      aliasId: number
      brandProfile: PendingPurchaseBrandProfileRecord
      matchedDistributorName: string
    }
  | { status: 'conflict'; note: string }

/**
 * Resolve a row's distributor name(s) to a pinned brand via the
 * operator-curated `alias_type='distributor'` aliases. `distributorNames`
 * carries both the distributor and distributor-integration names Sweed
 * exposes on the order; any of them may match.
 *
 *  - 0 matches  → 'none'      (caller continues normal parsing)
 *  - 1 brand    → 'matched'   (caller pins the brand)
 *  - >1 brand   → 'conflict'  (misconfiguration; caller warns + continues)
 */
async function resolveDistributorBrandOverride(
  distributorNames: Set<string>,
): Promise<DistributorBrandOverrideResult> {
  const normalizedNames = [...distributorNames]
    .map((name) => normalizePendingPurchaseParserText(name))
    .filter((name) => name.length > 0)
  if (normalizedNames.length === 0) {
    return { status: 'none' }
  }

  const matches = await listPendingPurchaseDistributorBrandAliases(getPool(), {
    normalizedDistributorNames: normalizedNames,
    sourceSystem: PENDING_PURCHASE_SOURCE_SYSTEM,
  })
  if (matches.length === 0) {
    return { status: 'none' }
  }

  const distinctBrandIds = new Set(matches.map((match) => match.brandProfile.id))
  if (distinctBrandIds.size > 1) {
    const brandNames = [...new Set(matches.map((match) => match.brandProfile.displayBrandName))]
    return {
      note: `Distributor name(s) ${normalizedNames.join(', ')} map to multiple brands (${brandNames.join(', ')}); skipping distributor override.`,
      status: 'conflict',
    }
  }

  const winner = matches[0]
  return {
    aliasId: winner.alias.id,
    brandProfile: winner.brandProfile,
    matchedDistributorName: winner.alias.aliasValue,
    status: 'matched',
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
  knownDistributorName?: string | null
  resolvedCost: ResolvedCost
  suggestionCandidates: SuggestedProductCandidate[]
}): Record<string, JsonValue> {
  return {
    distributorNames: [...input.group.distributorNames].sort(),
    distributorProductId: input.group.distributorProductId,
    distributorProductName: input.group.distributorProductName,
    effectiveUnitCost: input.resolvedCost.value,
    effectiveUnitCostReason: input.resolvedCost.reason,
    knownDistributorName: input.knownDistributorName ?? null,
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

/**
 * NY adult-use market rule: an edible package can never exceed 100 mg
 * total THC and a single piece can never exceed 10 mg THC. So a "100 mg
 * 1 pk" variant is structurally illegal — it must be split into multiple
 * pieces (commonly 10×10mg, 20×5mg, or 40×2.5mg). When the parser hands
 * us such a one-piece edible above 10 mg total, infer the canonical
 * piece-count split here so the pending-purchase proposal does not
 * propose a SKU that can never legally exist.
 *
 * Strategy:
 *   - assume the maximum allowed per-piece dose (10 mg) and derive
 *     pieces = totalMg / 10 when totalMg is an integer multiple of 10.
 *   - when totalMg is not a clean multiple of 10 (uncommon for our
 *     vendors but possible — e.g. 25 mg), fall back to the smallest
 *     integer pieces that brings per-piece down to ≤ 10 mg.
 *   - never invent a split when totalMg > 100 (illegal package) — flag
 *     it for the reviewer to resolve instead.
 *
 * Returns `null` when no adjustment is needed. Otherwise returns the
 * new size / packCount / tab plus a human-readable note and review
 * flag the caller appends onto the pending-purchase row.
 */
const NY_EDIBLE_CANONICAL_PER_PIECE_MG = 10
const NY_EDIBLE_PACKAGE_CAP_MG = 100
const NY_EDIBLE_TOTAL_SIZE_REGEX = /^\s*(\d+(?:\.\d+)?)\s*mg\s*$/i

export function maybeApplyNyEdibleCanonicalSplit(input: {
  category: string
  packCount: number
  size: string
  tab: string
}): { packCount: number; size: string; tab: string; reviewerNote: string; reviewFlag: string | null } | null {
  if (input.category.toLowerCase() !== 'edibles') return null
  if (input.packCount > 1) return null
  const sizeMatch = input.size.match(NY_EDIBLE_TOTAL_SIZE_REGEX)
  if (!sizeMatch) return null
  const totalMg = Number(sizeMatch[1])
  if (!Number.isFinite(totalMg) || totalMg <= NY_EDIBLE_CANONICAL_PER_PIECE_MG) return null

  if (totalMg > NY_EDIBLE_PACKAGE_CAP_MG) {
    // > 100 mg total exceeds the NY package cap; we cannot honestly
    // split this into a legal SKU. Flag for the reviewer to either
    // correct the parsed total or reject the proposal entirely.
    return {
      packCount: input.packCount,
      size: input.size,
      tab: input.tab,
      reviewerNote:
        `Parsed total THC of ${totalMg} mg/package exceeds the NY adult-use cap of ` +
        `${NY_EDIBLE_PACKAGE_CAP_MG} mg/package. Cannot auto-split into a legal SKU; ` +
        'please correct the parsed size or reject this proposal.',
      reviewFlag: 'NY edible exceeds 100mg/package cap',
    }
  }

  // Canonical split: 10 mg per piece when totalMg divides evenly, else
  // the smallest integer pieces that brings per-piece below 10 mg.
  const cleanPieces = totalMg / NY_EDIBLE_CANONICAL_PER_PIECE_MG
  const pieces = Number.isInteger(cleanPieces)
    ? cleanPieces
    : Math.ceil(totalMg / NY_EDIBLE_CANONICAL_PER_PIECE_MG)
  const mgPerPiece = totalMg / pieces
  const mgPerPieceLabel = Number.isInteger(mgPerPiece)
    ? `${mgPerPiece}mg`
    : `${Number(mgPerPiece.toFixed(2))}mg`
  const newSize = mgPerPieceLabel
  const newTab = `${pieces}x${mgPerPieceLabel}`
  return {
    packCount: pieces,
    size: newSize,
    tab: newTab,
    reviewerNote:
      `NY edible canonical split applied: parsed ${totalMg}mg total in 1 piece → ` +
      `${pieces}x${mgPerPieceLabel} (NY caps edibles at ${NY_EDIBLE_CANONICAL_PER_PIECE_MG}mg/piece, ` +
      `${NY_EDIBLE_PACKAGE_CAP_MG}mg/package, so a "${totalMg}mg 1pk" variant cannot exist).`,
    reviewFlag: 'NY edible split inferred — verify pieces',
  }
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
  // The upstream distributor brand printed on the live purchase row.
  // Some vendors (e.g. Canna Cure Farms) ship METRC product names with
  // NO brand token, so the name-only parser cannot dispatch them — but
  // the brand IS known here from the linked distributor product row.
  const knownDistributorName = stateDistributorProductRow?.distributorName ?? null
  const rowInputSignature = sha256(
    JSON.stringify({
      distributorProductId: group.distributorProductId,
      distributorProductName: group.distributorProductName,
      effectiveUnitCost: resolvedCost.value,
      knownDistributorName,
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
    knownDistributorName,
    resolvedCost,
    rowInputSignature,
    suggestionCandidates,
  })
  const parsed = parseResolution.parsed

  // Compute family anchors UP FRONT so the reuse waterfall below can
  // use them as a fallback match source. Anchors are the set of live
  // catalog products that already match parsed.brand + category +
  // subcategory + size + packCount — i.e. they're in the same "lane"
  // and the only remaining axis is the strain / group name.
  const anchors = parsed ? await familyAnchorProducts(cache, parsed) : []

  let reuse: LiveProductSummary | null = null
  let reuseReason: string | null = null
  if (stateDistributorProductRow?.productId) {
    reuse = await cache.getProductSummary(stateDistributorProductRow.productId)
    reuseReason = stateDistributorProductRow.productName
      ? `Current distributor product row ${stateDistributorProductRow.distributorProductId} already links to ${stateDistributorProductRow.productName}.`
      : `Current distributor product row ${stateDistributorProductRow.distributorProductId} already links to an existing variant.`
  } else if (parsed) {
    // 1. Exact variantName compactText equality (legacy strict path).
    reuse = await exactReuseSummary(cache, group.distributorProductName, parsed)
    if (reuse) {
      reuseReason = `Exact live variant match found for ${reuse.productName}.`
    }
    // 2. Sweed pre-computed suggestion candidates: if Sweed itself
    //    nominated a productId AND that product's structured shape
    //    matches our parsed lane, treat it as a reuse. This catches
    //    the very common case where the LLM teacher returned a
    //    partial / non-canonical variantName (e.g. "3.5g" instead of
    //    "Dank Purple Panty Dropper 3.5g") so exactReuseSummary's
    //    strict compact-equality failed.
    if (!reuse) {
      const matched = await pickReuseFromSuggestionCandidates(cache, parsed, suggestionCandidates)
      if (matched) {
        reuse = matched.summary
        reuseReason = `Sweed-suggested catalog match: ${matched.summary.productName}` +
          (matched.score !== null ? ` (score ${matched.score}).` : '.')
      }
    }
    // 3. Strain/group fuzzy match within family anchors. Anchors
    //    already share brand+category+subcategory+size+packCount, so
    //    the only remaining ambiguity is the strain / group name. If
    //    a single anchor has a strain or group name matching the
    //    parsed strain/group (compactText), reuse it.
    if (!reuse) {
      const matched = pickReuseFromAnchorsByStrain(anchors, parsed)
      if (matched) {
        reuse = matched
        reuseReason = `Live family-anchor strain match: ${matched.productName}.`
      }
    }
  }
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
    // A distributor-override resolution pins the brand but intentionally
    // leaves category/size/variant for the reviewer, so it lands here as
    // a brand-prefilled needs-review row rather than a genuinely
    // unclassified one.
    const isDistributorOverride = parseResolution.parserSource === 'distributor-override'
    const pinnedBrand = parseResolution.brandProfile?.displayBrandName ?? ''
    return {
      actionType: 'needs-review',
      catalogAction: isDistributorOverride
        ? `Brand pinned to ${pinnedBrand} from distributor mapping. Set category, size, and variant, then create.`
        : 'Review and classify this unresolved distributor product before proposing catalog create or mapping work.',
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
        isDistributorOverride ? 'Needs category/size classification' : 'Needs manual classification',
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
      targetBrand: pinnedBrand,
      targetGroupName: '',
      targetPackCount: null,
      targetPrevalence: '',
      targetSize: '',
      targetStrain: '',
      targetVariantName: group.distributorProductName,
      targetVariantTab: '',
      unresolvedReason: isDistributorOverride
        ? 'Brand pinned from distributor mapping; category, size, and variant still need review.'
        : 'Name parser could not confidently classify this distributor product.',
    }
  }

  const rawTarget = reuse ?? {
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
  // NY market rule: edibles MUST be ≤ 10 mg per piece and ≤ 100 mg per
  // package, so a "100mg 1pk" variant cannot legally exist on our shelves
  // — it has to be split (typically 10x10mg, 20x5mg, or 40x2.5mg). If the
  // parser handed us a one-piece edible above 10 mg total, infer the
  // canonical split here so the proposal doesn't propose an illegal SKU.
  // Only applied to brand-new variants (reuse=null) since existing
  // catalog rows have already been audited.
  const nyEdibleAdjustment = reuse
    ? null
    : maybeApplyNyEdibleCanonicalSplit({
        category: rawTarget.category,
        packCount: rawTarget.packCount,
        size: rawTarget.size,
        tab: rawTarget.tab,
      })
  const target = nyEdibleAdjustment
    ? {
        ...rawTarget,
        packCount: nyEdibleAdjustment.packCount,
        size: nyEdibleAdjustment.size,
        tab: nyEdibleAdjustment.tab,
      }
    : rawTarget
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
    nyEdibleAdjustment?.reviewerNote ?? null,
    suggestionNote,
  ])
  const reviewFlags = compactStrings([
    parseResolution.reviewFlag,
    !reuse && proposedDescription === null ? 'Needs description review' : null,
    proposedPrice === null ? 'Needs manual price' : null,
    !reuse && anchors.length === 0 ? 'No live family anchor' : null,
    !primaryImage ? 'Needs image review' : null,
    pricingSupport.marketAvailability === 'error' ? 'Pricing evidence lookup failed' : null,
    nyEdibleAdjustment?.reviewFlag ?? null,
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
    // Surface LitAlerts matched listings on the row so the pending-purchase
    // review page can show competitor listings (and their images) directly.
    // The shape matches `PendingPurchaseMarketListingSchema`; the reader in
    // `pendingPurchaseQueries.ts:readMarketListings` will pull it out of
    // `raw_row_json` and validate field-by-field.
    marketListings: pricingSupport.evidence?.matchedListings ?? [],
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

async function listOutstandingOrders(
  dealerId: number,
  fromDate: string,
  toDate: string,
): Promise<Array<{ id: number; name: string | null }>> {
  const orders: Array<{ id: number; name: string | null }> = []
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

    orders.push(...response.data.map((row) => ({
      id: row.id,
      name: normalizeNonEmptyString((row as Record<string, unknown>).name),
    })))
    if (orders.length >= response.totalCount || response.data.length < pageSize) {
      return orders
    }
    page += 1
  }
}

/**
 * Single-PO scope predicate. The operator enters a "purchase number" exactly
 * as it appears in Sweed's outstanding-PO list; that can be either the
 * human-facing order name/number (e.g. `PO-12345`) or the numeric Sweed order
 * id. We accept either: a normalized text match against the order name (so
 * `PO-12345`, `po 12345`, and `PO12345` all match) OR an exact match against
 * the numeric order id.
 */
function matchesRequestedPurchaseOrder(
  order: { id: number; name: string | null },
  requestedPurchaseOrderNumber: string,
): boolean {
  const requestedTrimmed = requestedPurchaseOrderNumber.trim()
  if (requestedTrimmed.length === 0) {
    return false
  }
  if (String(order.id) === requestedTrimmed) {
    return true
  }
  const requestedCompact = compactText(requestedTrimmed)
  if (requestedCompact.length === 0) {
    return false
  }
  return compactText(order.name) === requestedCompact
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

/**
 * The five identity lanes that define a pending-purchase "family" (everything
 * except the strain / group name). Both the legacy parsed shape and the C8a
 * reconciled classification project onto this so `familyAnchorProductsForLane`
 * can serve both paths.
 */
interface PendingPurchaseFamilyLane {
  brand: string
  category: string
  subcategory: string
  size: string
  packCount: number
}

async function familyAnchorProducts(cache: CatalogCache, parsed: ParsedProductName): Promise<LiveProductSummary[]> {
  return familyAnchorProductsForLane(cache, {
    brand: parsed.brand,
    category: parsed.category,
    subcategory: parsed.subcategory,
    size: parsed.size,
    packCount: parsed.packCount,
  })
}

async function familyAnchorProductsForLane(
  cache: CatalogCache,
  lane: PendingPurchaseFamilyLane,
): Promise<LiveProductSummary[]> {
  if (lane.brand.trim().length === 0) {
    return []
  }
  const rows = await cache.searchProducts(lane.brand)
  const anchors: LiveProductSummary[] = []

  for (const row of rows) {
    const summary = await cache.getProductSummary(row.id)
    if (summary.category !== lane.category) {
      continue
    }
    if ((summary.subcategory || '') !== lane.subcategory) {
      continue
    }
    if (summary.size !== lane.size) {
      continue
    }
    if ((summary.packCount || 1) !== lane.packCount) {
      continue
    }
    anchors.push(summary)
  }

  return anchors
}

// Returns true when a live catalog product summary structurally matches
// the parsed pending-purchase lane (brand/category/subcategory/size/
// packCount). Used by the reuse waterfall's suggestion-candidate path
// to confirm a Sweed-nominated productId is actually the same SKU
// shape we're trying to reuse — without that check, a Sweed candidate
// for the wrong size (e.g. 0.5g vs 3.5g) could be reused incorrectly.
function liveSummaryMatchesParsedLane(
  summary: LiveProductSummary,
  parsed: ParsedProductName,
): boolean {
  if (compactText(summary.brand) !== compactText(parsed.brand)) return false
  if (summary.category !== parsed.category) return false
  if ((summary.subcategory || '') !== parsed.subcategory) return false
  if (summary.size !== parsed.size) return false
  if ((summary.packCount || 1) !== parsed.packCount) return false
  return true
}

// Walk the (already-sorted-by-score) suggestionCandidates from Sweed
// and return the first one whose productId resolves to a live product
// summary that matches our parsed lane. This is the second tier of the
// reuse waterfall: it fires when exactReuseSummary's strict compactText
// equality misses because the LLM teacher returned a non-canonical
// variantName (very common: "3.5g" or "Flower 3.5g" instead of
// "Dank Purple Panty Dropper 3.5g").
async function pickReuseFromSuggestionCandidates(
  cache: CatalogCache,
  parsed: ParsedProductName,
  suggestionCandidates: readonly SuggestedProductCandidate[],
): Promise<{ summary: LiveProductSummary; score: number | null } | null> {
  for (const candidate of suggestionCandidates) {
    if (candidate.productId === null) continue
    try {
      const summary = await cache.getProductSummary(candidate.productId)
      if (liveSummaryMatchesParsedLane(summary, parsed)) {
        return { summary, score: candidate.score }
      }
    } catch {
      // A suggestion candidate may point at a product that's been
      // deleted / made invisible upstream; skip and keep walking
      // rather than letting a stale Sweed suggestion crash the row.
      continue
    }
  }
  return null
}

// Third tier of the reuse waterfall: pick the anchor whose strain or
// groupName matches the parsed strain/groupName (compactText). Anchors
// already share brand+category+subcategory+size+packCount, so this is
// the final identity axis. Returns null when nothing matches OR when
// multiple anchors tie (ambiguous → safer to fall through to
// catalog-create with the reviewer in the loop). This catches the
// real-world case where Sweed didn't surface a suggestion candidate
// AND exactReuseSummary missed because variantName didn't compact-
// equal the catalog row name.
function pickReuseFromAnchorsByStrain(
  anchors: readonly LiveProductSummary[],
  parsed: ParsedProductName,
): LiveProductSummary | null {
  const targetStrain = compactText(parsed.strainName)
  const targetGroup = compactText(parsed.groupName)
  if (targetStrain.length === 0 && targetGroup.length === 0) return null

  const matches: LiveProductSummary[] = []
  for (const anchor of anchors) {
    const anchorStrain = compactText(anchor.strain)
    const anchorGroup = compactText(anchor.groupName)
    if (
      (targetStrain.length > 0 && anchorStrain === targetStrain) ||
      (targetGroup.length > 0 && anchorGroup === targetGroup)
    ) {
      matches.push(anchor)
    }
  }

  if (matches.length === 1) return matches[0]
  // Ambiguous (0 or 2+ matches): defer to the reviewer rather than
  // guess. With 2+ matches the catalog has a duplicate problem that
  // a human should resolve; with 0 matches this is a genuinely new
  // strain in the family and catalog-create is the right action.
  return null
}

// Pricing proposals must never use cost basis of trade samples or anything
// under $1 — those are not real wholesale prices. Anything below this floor
// is treated as a weak reference for traceability only; pricing falls back to
// the family-average wholesale cost computed across peer pending-purchase
// rows in the same brand/category/size/pack lane (see
// `applyFamilyAverageCostFallback` below).
const MIN_TRUSTWORTHY_UNIT_COST_USD = 1.0

function isTrustworthyUnitCost(value: number | null): value is number {
  return value !== null && value >= MIN_TRUSTWORTHY_UNIT_COST_USD
}

function resolveEffectiveUnitCost(
  positions: z.infer<typeof PurchaseOrderPositionSchema>[],
  stateDistributorProductRow: ExactDistributorProductRow | null,
): ResolvedCost {
  // Trustworthy pass: skip trade-sample positions entirely, require the cost
  // basis to be at least $1. Anything cheaper is a nominal / sample reference
  // and gets handled by the weak-reference branch below + family-average
  // post-pass.
  for (const position of positions) {
    if (isSampleLike(position)) {
      continue
    }
    const directCost = normalizePrice(position.discountProductPrice)
    if (isTrustworthyUnitCost(directCost)) {
      return {
        reason: 'Effective cost comes from the live purchase unit price on a paid companion line.',
        source: 'purchase-order',
        value: directCost,
      }
    }

    const metrcCost = readMetrcUnitCost(position)
    if (isTrustworthyUnitCost(metrcCost)) {
      return {
        reason: 'Effective cost comes from live Metrc wholesale on a paid companion line.',
        source: 'purchase-order-metrc',
        value: metrcCost,
      }
    }
  }

  const distributorProductPrice = stateDistributorProductRow?.price ?? null
  if (isTrustworthyUnitCost(distributorProductPrice)) {
    return {
      reason: `Falling back to existing distributor-product price on row ${stateDistributorProductRow?.distributorProductId ?? 'unknown'}.`,
      source: 'distributor-product',
      value: distributorProductPrice,
    }
  }

  // Weak reference: capture nominal / trade-sample numbers so the reviewer
  // sees what was rejected, but flag the source so the family-average
  // post-pass replaces this value before pricing.
  for (const position of positions) {
    const directCost = normalizePrice(position.discountProductPrice)
    if (directCost !== null) {
      return {
        reason: `Only ${formatCurrency(directCost)} sample / sub-$1 unit pricing was visible on the live purchase row — excluded from pricing; pricing falls back to family-average wholesale cost.`,
        source: 'sample-reference',
        value: directCost,
      }
    }

    const metrcCost = readMetrcUnitCost(position)
    if (metrcCost !== null) {
      return {
        reason: `Only ${formatCurrency(metrcCost)} sample / sub-$1 Metrc wholesale was visible on the live purchase row — excluded from pricing; pricing falls back to family-average wholesale cost.`,
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

const TRUSTWORTHY_COST_SOURCES = new Set<string>([
  'purchase-order',
  'purchase-order-metrc',
  'distributor-product',
])

// The packet row type is `.passthrough()` so the extra cost-pricing fields we
// set in `buildGeneratedRow` are typed as `unknown`/`{}` on the schema-derived
// `GeneratedPendingPurchaseRow`. This local view spells out the fields the
// family-average post-pass needs to read and write so the calls stay typed.
interface MutableRowForFamilyCostPostPass {
  anchorPrice?: number | null
  currentGmPercent?: number | null
  currentPrice?: number | null
  currentPriceBasis?: string | null
  effectiveUnitCost?: number | null
  effectiveUnitCostReason?: string | null
  effectiveUnitCostSource?: string | null
  expectedCategory?: string | null
  expectedSubcategory?: string | null
  gmPercent?: number | null
  pricingAction?: string | null
  pricingReason?: string | null
  proposedPrice?: number | null
  reuseProductId?: number | null
  targetBrand?: string | null
  targetPackCount?: number | null
  targetSize?: string | null
}

function asMutableRow(row: GeneratedPendingPurchaseRow): MutableRowForFamilyCostPostPass {
  return row as unknown as MutableRowForFamilyCostPostPass
}

function familyCostKeyFromRow(row: MutableRowForFamilyCostPostPass): string | null {
  const brand = (row.targetBrand ?? '').trim().toLowerCase()
  const category = (row.expectedCategory ?? '').trim().toLowerCase()
  if (!brand || !category) {
    return null
  }
  const subcategory = (row.expectedSubcategory ?? '').trim().toLowerCase()
  const size = (row.targetSize ?? '').trim().toLowerCase()
  const packCount = row.targetPackCount ?? 1
  return `${brand}|${category}|${subcategory}|${size}|${packCount}`
}

function rowHasTrustworthyCost(row: MutableRowForFamilyCostPostPass): boolean {
  return TRUSTWORTHY_COST_SOURCES.has(row.effectiveUnitCostSource ?? '')
    && isTrustworthyUnitCost(row.effectiveUnitCost ?? null)
}

function medianOfNumbers(values: number[]): number | null {
  if (values.length === 0) {
    return null
  }
  const sorted = [...values].sort((left, right) => left - right)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) {
    return sorted[mid]
  }
  return roundMoney((sorted[mid - 1] + sorted[mid]) / 2)
}

// Wave-2 pass over the rows produced by `buildGeneratedRow`. The user rule is:
//   "Pricing proposals must never use cost basis of trade samples or anything
//    under $1, those aren't real prices. Use the family average cost instead."
// So we collect every row that DOES have a trustworthy (>= $1, non-sample)
// unit cost, bucket those by brand/category/subcategory/size/pack-count, and
// substitute the family-median cost into any row whose own cost was rejected
// (sample-reference, sample-reference-metrc, or simply absent). Pricing is
// then recomputed off the family-average cost so proposedPrice and gmPercent
// are no longer skewed by a $0.05 trade-sample line item.
function applyFamilyAverageCostFallback(rows: GeneratedPendingPurchaseRow[]): void {
  const mutableRows = rows.map(asMutableRow)
  const costsByFamily = new Map<string, number[]>()
  for (const row of mutableRows) {
    if (!rowHasTrustworthyCost(row)) {
      continue
    }
    const key = familyCostKeyFromRow(row)
    if (!key) {
      continue
    }
    const cost = row.effectiveUnitCost
    if (cost === null || cost === undefined) {
      continue
    }
    const bucket = costsByFamily.get(key)
    if (bucket) {
      bucket.push(cost)
    } else {
      costsByFamily.set(key, [cost])
    }
  }

  for (const row of mutableRows) {
    if (rowHasTrustworthyCost(row)) {
      continue
    }
    const previousSource = row.effectiveUnitCostSource ?? null
    const previousValue = row.effectiveUnitCost ?? null
    const wasSampleReference = previousSource === 'sample-reference' || previousSource === 'sample-reference-metrc'
    const originalNote = wasSampleReference && previousValue !== null
      ? `Original live cost ${formatCurrency(previousValue)} was a trade-sample / sub-$1 reference and is excluded from pricing.`
      : null

    const key = familyCostKeyFromRow(row)
    const peerCosts = (key ? costsByFamily.get(key) ?? [] : []).filter((value): value is number => isTrustworthyUnitCost(value))
    const familyAverageCost = medianOfNumbers(peerCosts)

    let newCost: number | null = null
    let newSource: string | null = null
    let newReason: string

    if (familyAverageCost !== null) {
      newCost = familyAverageCost
      newSource = 'family-average-cost'
      const lane = compactStrings([
        row.targetBrand ?? null,
        row.expectedCategory ?? null,
        row.expectedSubcategory ?? null,
        row.targetSize ?? null,
        row.targetPackCount ? `${row.targetPackCount}pk` : null,
      ]).join(' · ')
      newReason = compactStrings([
        `Family-average wholesale cost ${formatCurrency(familyAverageCost)} drawn from ${peerCosts.length} peer pending-purchase row${peerCosts.length === 1 ? '' : 's'} in the same ${lane || 'family'} lane.`,
        originalNote,
      ]).join(' ')
    } else {
      newReason = compactStrings([
        originalNote,
        previousValue === null && !wasSampleReference
          ? 'No usable wholesale cost was visible on the live purchase rows.'
          : null,
        'No peer pending-purchase rows in the same brand/category/size lane carried a trustworthy (>= $1, non-sample) wholesale cost to derive a family-average from.',
      ]).join(' ')
    }

    row.effectiveUnitCost = newCost
    row.effectiveUnitCostSource = newSource
    row.effectiveUnitCostReason = newReason

    // Only recompute proposedPrice when it was not pinned from an exact live
    // catalog reuse (reuseProductId truthy => proposedPrice = reuse.price).
    const reusePinned = (row.reuseProductId ?? null) !== null
    if (!reusePinned) {
      const recomputedProposed = recommendPendingPurchasePrice(newCost, row.anchorPrice ?? null)
      row.proposedPrice = recomputedProposed
      if ((row.currentPrice ?? null) === null) {
        row.currentPrice = row.anchorPrice ?? recomputedProposed
      }
      row.pricingAction = classifyPricingAction(row.currentPrice ?? null, recomputedProposed)
    }

    row.gmPercent = computeGmPercent(newCost, row.proposedPrice ?? null)
    row.currentGmPercent = computeGmPercent(newCost, row.currentPrice ?? null)
    row.pricingReason = buildPricingReason({
      anchorPrice: row.anchorPrice ?? null,
      currentPriceBasis: row.currentPriceBasis ?? null,
      proposedPrice: row.proposedPrice ?? null,
      resolvedCost: newCost,
    })
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

/**
 * Legacy hardcoded waterfall parser for METRC pending-purchase product
 * names. This is the byte-for-byte comparator that the parsekit-based
 * reverse-shadow harness in `parseProductName` measures the new parser
 * against. Once parsekit has reached and held parity across all live
 * inputs for long enough, the legacy implementation can be retired.
 *
 * Public exports stay stable: callers continue to import `parseProductName`;
 * the parity tests in `src/lib/parsekit/__tests__/metrc-v1.test.ts` import
 * `parseProductNameLegacy` directly so they're comparing two independent
 * implementations rather than parsekit-versus-itself.
 */
export function parseProductNameLegacy(name: string): ParsedProductName {
  const normalized = name.trim()
  const lowered = normalized.toLowerCase()
  // Case-pack grammar (`<brand> <size> <type...> <N>cpk - <strain>`) used by
  // multiple distributors (e.g. Empire Standard) for CRU / Untitled / Jetpacks
  // / Littles. Gated on the very specific `<N>cpk` token so it can run before
  // the brand `startsWith` branches without swallowing anything else. The
  // `cpk` count is the *case / order* quantity, never the retail pack count.
  const casePack = parseMetrcCasePackName(normalized)
  if (casePack !== null) {
    return normalizeAndValidateParsedProductName(casePack, normalized)
  }
  // Bare brand-prefix grammar (`<brand> <descriptor...>`) submitted with no
  // delimiters by some distributors (e.g. BCD Innovation for Alter / Hashtag
  // Honey / Continental Exotics). Gated on a small allowlist of known brand
  // prefixes — including a canonicalising alias map (`HH` → Hashtag Honey,
  // the `Contintental` misspelling → Continental Exotics) — so it can never
  // mis-place an unknown row. Declines (null) on any unrecognised descriptor
  // shape so the row falls through to the rest of the waterfall.
  const brandPrefix = parseKnownBrandPrefixName(normalized)
  if (brandPrefix !== null) {
    return normalizeAndValidateParsedProductName(brandPrefix, normalized)
  }
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
  if (/^ttm\s*[-:]/i.test(normalized)) {
    return normalizeAndValidateParsedProductName(parseTtmName(normalized), normalized)
  }
  // Pipe-delimited supplier format: `Brand | Category | Strain | Size`.
  // Used by multiple distributors that submit catalog rows with that
  // exact, uniform 4-part shape (e.g. Platinum Reserve, Dank, Her
  // Highness). The previous waterfall fell through to the HR Botanical
  // brand-startsWith parser, which throws "Unhandled HR Botanical
  // product name" on anything outside its 8 hard-coded brands — every
  // 4-part pipe row therefore landed in the LLM fallback path and
  // mostly in needs-manual-review. This branch handles the entire
  // 4-part pipe shape in one place so the reviewer gets a fully
  // populated row out of the box.
  if (PIPE_DELIMITED_FOUR_PART_REGEX.test(normalized)) {
    const parsed = parsePipeDelimitedFourPartName(normalized)
    if (parsed !== null) {
      return normalizeAndValidateParsedProductName(parsed, normalized)
    }
  }
  return normalizeAndValidateParsedProductName(parseHrBotanicalName(normalized), normalized)
}

// Matches `something | something | something | something` with 4 non-empty
// parts. Keeps the parse path cheap (the regex is the gatekeeper before
// any of the per-token classification work runs).
const PIPE_DELIMITED_FOUR_PART_REGEX = /^[^|]+\|[^|]+\|[^|]+\|[^|]+$/

// Size token in the case-pack grammar: `1g`, `0.5g`, `.5g`, `3.5g`, `1ml`.
const METRC_CASE_PACK_SIZE_REGEX = /^(?:\d+(?:\.\d+)?|\.\d+)(?:g|ml)$/i
// Case / order quantity token: `16cpk`, `12cpk`, `25cpk`, `32cpk`.
const METRC_CASE_PACK_TOKEN_REGEX = /^\d+cpk$/i
// Flower nug-size tier tokens worth preserving in the group name (e.g.
// Untitled catalog has both `Bigs Bombay Dream` and `Smalls Green Crack`).
const METRC_CASE_PACK_TIER_REGEX = /^(?:bigs|smalls)$/i

/**
 * Parses the case-pack METRC grammar:
 *
 *   `<brand> [line...] <size> <type...> <N>cpk - <strain>`
 *
 * Returns null on any ambiguity so the legacy waterfall keeps going. The
 * `<N>cpk` token is the case / order quantity and is deliberately discarded:
 * the catalog variant is a single retail unit (`packCount = 1`).
 */
function parseMetrcCasePackName(name: string): ParsedProductName | null {
  const sep = name.lastIndexOf(' - ')
  if (sep < 0) return null

  const left = name.slice(0, sep).trim()
  const strainRaw = name.slice(sep + 3).trim()
  if (left.length === 0 || strainRaw.length === 0) return null

  const tokens = left.split(/\s+/).filter((token) => token.length > 0)
  const sizeIndex = tokens.findIndex((token) => METRC_CASE_PACK_SIZE_REGEX.test(token))
  // Need at least one brand token before the size.
  if (sizeIndex <= 0) return null

  const cpkIndex = tokens.findIndex((token, index) => index > sizeIndex && METRC_CASE_PACK_TOKEN_REGEX.test(token))
  // The `cpk` token must terminate the left side; anything after it means the
  // shape isn't what we think it is, so decline and let the waterfall run.
  if (cpkIndex < 0 || cpkIndex !== tokens.length - 1) return null

  const preTokens = tokens.slice(0, sizeIndex)
  const typeTokens = tokens.slice(sizeIndex + 1, cpkIndex)
  if (preTokens.length === 0 || typeTokens.length === 0) return null

  const classification = classifyMetrcCasePackType(typeTokens.join(' '))
  if (classification === null) return null

  // `1ml` → `1g`: Sweed has no millilitre sizes for these vapes.
  const sizeInput = tokens[sizeIndex].replace(/ml$/i, 'g')
  const size = normalizeSizeText(sizeInput)
  if (size === null || !/\d/.test(size)) return null

  const brand = preTokens[0]
  const lineTokens = preTokens.slice(1)
  const tierTokens = typeTokens.filter((token) => METRC_CASE_PACK_TIER_REGEX.test(token))
  // Prevalence must be derived from the raw strain (the `(I)`/`(S)`/`(H)`
  // marker is stripped by `cleanCultivar`).
  const prevalence = derivePrevalence(strainRaw)
  const strain = cleanCultivar(strainRaw)

  const groupPrefix = [...lineTokens, ...tierTokens].join(' ').trim()
  const groupName = groupPrefix.length > 0 ? `${groupPrefix} ${strain}` : strain

  return {
    brand,
    category: classification.category,
    groupName,
    packCount: 1,
    prevalence,
    searchTerm: strain,
    size,
    strainName: strain,
    subcategory: classification.subcategory,
    variantName: `${brand} ${groupName} ${size}`,
    variantTab: size,
  }
}

// Maps the free-form type segment of the case-pack grammar to the canonical
// (category, subcategory) tuple. Form-factor categories (pre-roll / flower /
// vape) are checked before concentrate sub-types so "Live Resin Disposable"
// classifies as a Vapes disposable rather than a Concentrates Live Resin.
// Returns null for anything we don't recognise so the row declines to the LLM
// fallback rather than being mis-placed.
function classifyMetrcCasePackType(token: string): { category: string; subcategory: string } | null {
  const lowered = token.toLowerCase()
  const isInfused = !/\bun[\s-]?infused\b|\bnon[\s-]?infused\b/.test(lowered)
    && /\binfused\b|\blive\s*resin\b|\blive\s*rosin\b|\brosin\b/.test(lowered)

  if (/\bpre[\s-]?rolls?\b|\bprerolls?\b|\bjoints?\b/.test(lowered)) {
    return { category: 'Pre-Rolls', subcategory: isInfused ? 'Infused' : '' }
  }
  if (/\bflower\b/.test(lowered)) {
    return { category: 'Flower', subcategory: isInfused ? 'Infused' : '' }
  }
  // Vapes (form factor) must win over the concentrate sub-types below.
  if (/\baio\b|\ball[\s-]?in[\s-]?one\b|\bdisposables?\b/.test(lowered)) {
    return { category: 'Vapes', subcategory: 'All In One / Disposable' }
  }
  if (/\bcarts?\b|\bcartridges?\b/.test(lowered)) {
    return { category: 'Vapes', subcategory: 'Cartridge' }
  }
  if (/\bpods?\b/.test(lowered)) {
    return { category: 'Vapes', subcategory: 'Pod' }
  }
  // A bare "vape" with no recognised form factor can't be placed — decline.
  if (/\bvapes?\b/.test(lowered)) {
    return null
  }
  // Concentrate sub-types.
  if (/\bdiamonds?\b/.test(lowered)) return { category: 'Concentrates', subcategory: 'Diamonds' }
  if (/\bbadder\b|\bbudder\b/.test(lowered)) return { category: 'Concentrates', subcategory: 'Badder' }
  if (/\bsugar\b/.test(lowered)) return { category: 'Concentrates', subcategory: 'Sugar' }
  if (/\bkief\b/.test(lowered)) return { category: 'Concentrates', subcategory: 'Kief' }
  if (/\blive\s*rosin\b|\brosin\b/.test(lowered)) return { category: 'Concentrates', subcategory: 'Live Rosin' }
  if (/\blive\s*resin\b/.test(lowered)) return { category: 'Concentrates', subcategory: 'Live Resin' }
  if (/\bhash\b/.test(lowered)) return { category: 'Concentrates', subcategory: 'Hash' }

  return null
}

// Allowlist of brand prefixes for the bare brand-prefix grammar. Maps a
// lower-cased leading brand phrase to the canonical catalog brand. Keep this
// list tight: every entry runs deterministically ahead of the LLM teacher, so
// only add brands whose descriptor shapes we have verified. Includes alias
// spellings (`HH` and the `Contintental` typo) that fold to a canonical brand.
const KNOWN_BRAND_PREFIXES: ReadonlyArray<readonly [string, string]> = [
  ['contintental exotics', 'Continental Exotics'],
  ['continental exotics', 'Continental Exotics'],
  ['hashtag honey', 'Hashtag Honey'],
  ['alter', 'Alter'],
  ['hh', 'Hashtag Honey'],
]

// Terminal vendor package / batch code, e.g. `AL-CG-1225-001`. Strict enough
// (all-caps lead, then ≥3 dash-separated alphanumeric segments) that it never
// eats legitimate strain tokens like `MAC-1`, `AK-47`, or `GG-4`.
const TERMINAL_PACKAGE_CODE_REGEX = /\s+[A-Z]{2,}(?:-[A-Z0-9]+){2,}$/

/**
 * Parses the bare brand-prefix grammar `<brand> <descriptor...>` for the small
 * allowlist of brands in {@link KNOWN_BRAND_PREFIXES}. Returns null for any
 * brand outside the allowlist, or any descriptor shape we don't recognise, so
 * the legacy waterfall keeps going and nothing is mis-placed.
 */
function parseKnownBrandPrefixName(name: string): ParsedProductName | null {
  const lowered = name.toLowerCase()
  // Prefer the longest matching prefix so `Hashtag Honey` wins over a bare
  // `HH`, and the two-word `Continental Exotics` wins over any single token.
  const ordered = [...KNOWN_BRAND_PREFIXES].sort((a, b) => b[0].length - a[0].length)
  const match = ordered.find(([prefix]) => lowered === prefix || lowered.startsWith(`${prefix} `))
  if (match === undefined) return null

  const [prefix, brand] = match
  const rest = name.slice(prefix.length).trim()
  if (rest.length === 0) return null

  // Edible gummies carry no explicit size; try that shape first.
  const gummy = parseBrandPrefixGummy(brand, rest)
  if (gummy !== null) return gummy

  // Everything else (pre-rolls, vapes, flower) carries an explicit gram size.
  return parseBrandPrefixSized(brand, rest)
}

/**
 * Edible-gummy shape: `<flavor> Gummy [pkg-code]` or `<flavor> Gummies`. All of
 * these brands ship gummies as 10-packs of 10mg pieces. The terminal package
 * code (Alter only) is dropped entirely. Singular "Gummy" stays in the group
 * name (matching the catalog), plural "Gummies" is dropped.
 */
function parseBrandPrefixGummy(brand: string, rest: string): ParsedProductName | null {
  const body = rest.replace(TERMINAL_PACKAGE_CODE_REGEX, '').trim()
  let group: string
  if (/\bgummies$/i.test(body)) {
    group = body.replace(/\s+gummies$/i, '').trim()
  } else if (/\bgummy$/i.test(body)) {
    group = body
  } else {
    return null
  }
  if (group.length === 0) return null

  return {
    brand,
    category: 'Edibles',
    groupName: group,
    packCount: 10,
    prevalence: null,
    searchTerm: group,
    size: '10mg',
    strainName: group,
    subcategory: '',
    variantName: `${brand} ${group} 10x 10mg`,
    variantTab: '10x 10mg',
  }
}

/**
 * Explicit-size shape: `<strain...> <size> <type...>`, e.g. `Amnesia Lemon Haze
 * 1G preroll` or `Lemon Cherry Gelato .5G Live Resin Disposable Vape`. The type
 * segment after the size classifies category/subcategory via the same table the
 * case-pack parser uses. The catalog variant is a single retail unit.
 */
function parseBrandPrefixSized(brand: string, rest: string): ParsedProductName | null {
  const tokens = rest.split(/\s+/).filter((token) => token.length > 0)
  const sizeIndex = tokens.findIndex((token) => METRC_CASE_PACK_SIZE_REGEX.test(token))
  // Need at least one strain token before the size and a type segment after it.
  if (sizeIndex <= 0 || sizeIndex >= tokens.length - 1) return null

  const classification = classifyMetrcCasePackType(tokens.slice(sizeIndex + 1).join(' '))
  if (classification === null) return null

  // `1ml` → `1g`: Sweed has no millilitre sizes for these forms.
  const size = normalizeSizeText(tokens[sizeIndex].replace(/ml$/i, 'g'))
  if (size === null || !/\d/.test(size)) return null

  const strainRaw = tokens.slice(0, sizeIndex).join(' ')
  const prevalence = derivePrevalence(strainRaw)
  const strain = cleanCultivar(strainRaw)
  if (strain.length === 0) return null

  return {
    brand,
    category: classification.category,
    groupName: strain,
    packCount: 1,
    prevalence,
    searchTerm: strain,
    size,
    strainName: strain,
    subcategory: classification.subcategory,
    variantName: `${brand} ${strain} ${size}`,
    variantTab: size,
  }
}

function parsePipeDelimitedFourPartName(name: string): ParsedProductName | null {
  const parts = name.split('|').map((part) => part.trim())
  if (parts.length !== 4) return null
  if (parts.some((part) => part.length === 0)) return null

  const [brandRaw, categoryRaw, strainRaw, sizeRaw] = parts
  const brand = brandRaw
  const strain = cleanCultivar(strainRaw)

  const classification = classifyPipeDelimitedCategoryToken(categoryRaw)
  if (classification === null) return null

  const sized = derivePipeDelimitedSize(sizeRaw)
  if (sized === null) return null

  const { packCount, size } = sized
  const prevalence = derivePrevalence(strainRaw)
  const variantTab = packCount > 1 ? `${packCount}x ${size}` : size
  const variantName = packCount > 1
    ? `${brand} ${strain} ${variantTab}`
    : `${brand} ${strain} ${size}`

  return {
    brand,
    category: classification.category,
    groupName: strain,
    packCount,
    prevalence,
    searchTerm: strain,
    size,
    strainName: strain,
    subcategory: classification.subcategory,
    variantName,
    variantTab,
  }
}

// Maps the free-form category token from the 2nd pipe segment to the
// canonical (category, subcategory) tuple Helios expects. Returns null
// when the token doesn't look like anything we know how to auto-place;
// the caller then falls through to the LLM fallback / manual review.
function classifyPipeDelimitedCategoryToken(
  token: string,
): { category: string; subcategory: string } | null {
  const lowered = token.toLowerCase().trim()
  const isInfused = /\binfused\b|\blive\s*resin\b|\brosin\b|\bdistillate\b/.test(lowered)

  // Pre-Rolls: "Preroll", "Pre-Roll", "Pre Roll", optionally with
  // "Infused" / "Live Resin" / etc. prefix or "Pack" suffix.
  if (/\bpre[\s-]?rolls?\b|\bjoints?\b/.test(lowered)) {
    return { category: 'Pre-Rolls', subcategory: isInfused ? 'Infused' : '' }
  }

  // Flower variants: bare "Flower", "Pre-Ground Flower",
  // "Ready to Roll Flower", "Packaged Flower", etc. All map to
  // category Flower; the "Infused" subcategory marker carries through.
  if (/\bflower\b|\bbud\b|\bnug\b/.test(lowered)) {
    return { category: 'Flower', subcategory: isInfused ? 'Infused' : '' }
  }

  // Vapes & cartridges.
  if (/\bvape\b|\bcart(?:ridge)?\b|\baio\b|\ball[\s-]?in[\s-]?one\b|\bdisposable\b/.test(lowered)) {
    return { category: 'Vapes', subcategory: /\baio\b|\ball[\s-]?in[\s-]?one\b|\bdisposable\b/.test(lowered) ? 'All-in-One' : '' }
  }

  // Edibles family.
  if (/\bgumm(?:y|ies)\b|\bchew\b|\bchocolate\b|\bcandy\b|\bmint\b|\btablets?\b/.test(lowered)) {
    // Edibles gummies / chews / candies are deliberately stored with
    // no subcategory in our Sweed taxonomy (there is no enabled
    // "Chews/Gummies" or "Gummies" subcategory under Edibles).
    return { category: 'Edibles', subcategory: '' }
  }
  if (/\bbeverage\b|\bdrink\b|\bsoda\b|\bseltzer\b|\bjuice\b/.test(lowered)) {
    return { category: 'Beverages', subcategory: '' }
  }
  if (/\bedibles?\b/.test(lowered)) {
    return { category: 'Edibles', subcategory: '' }
  }

  // Concentrates.
  if (/\bconcentrate\b|\bwax\b|\bshatter\b|\bbadder\b|\bbudder\b|\brosin\b|\bhash\b|\bdab\b/.test(lowered)) {
    return { category: 'Concentrates', subcategory: '' }
  }

  // Tinctures / topicals.
  if (/\btincture\b|\bsublingual\b/.test(lowered)) {
    return { category: 'Tinctures', subcategory: '' }
  }
  if (/\btopical\b|\bbalm\b|\bsalve\b|\blotion\b|\bcream\b/.test(lowered)) {
    return { category: 'Topicals', subcategory: '' }
  }

  return null
}

// Derives (packCount, size) from the 4th pipe segment.
//
// Accepted shapes (case-insensitive, whitespace-tolerant):
//   1g, 3.5g, 14g, 28g, 1.1g, 0.5g, .5g       → packCount 1
//   100mg, 10mg                                → packCount 1
//   10x 10mg, 2x 1g, 5pk 0.5g, 4-pack 1g       → multi-pack
function derivePipeDelimitedSize(raw: string): { packCount: number; size: string } | null {
  const text = raw.trim()
  if (text.length === 0) return null

  // Multi-pack: leading count, separator (x|pk|pack|-pack|×), then size.
  const multiPack = /^(\d+)\s*(?:x|×|pk|-?\s*pack)\s+(.+)$/i.exec(text)
  if (multiPack) {
    const packCount = Number.parseInt(multiPack[1], 10)
    const sizePart = normalizeSizeText(multiPack[2])
    if (Number.isFinite(packCount) && packCount > 0 && sizePart) {
      return { packCount, size: sizePart }
    }
  }

  // Single-unit: just a size literal (1g / 3.5g / 100mg / .5g).
  const single = normalizeSizeText(text)
  if (single && /\d/.test(single)) {
    return { packCount: 1, size: single }
  }
  return null
}

/**
 * Reverse-shadow entry point: parsekit is the live parser, the legacy
 * implementation is the comparator and the fallback.
 *
 *   1. Run parsekit (loaded from the helios-parser-configs repo by
 *      `getParserRegistry()`). If no registry has loaded yet (e.g. dev
 *      boot or tests), treat that as "parsekit did not match".
 *   2. Run the legacy parser.
 *   3. If parsekit succeeded:
 *        - record `ok_match` or `regression_diff` depending on whether
 *          the parsekit output equals the legacy output, then return
 *          the parsekit output (we trust parsekit).
 *   4. If parsekit declined to dispatch (no detect-prefix match) we use
 *      legacy silently — that's the expected path for tenants not yet
 *      modeled in parsekit (currently: hr-botanical).
 *   5. If parsekit dispatched but failed to parse, that's a regression:
 *      log it loud and return the legacy output.
 *
 * Counters and a small ring buffer of recent regressions are exposed via
 * `getParsekitReverseShadowSnapshot()` for the Helios `Config -> Parsing
 * -> Purchases` page.
 */
/**
 * A single parsekit-vs-legacy comparison for one distributor product name.
 * `winner` is parsekit's output when it parsed, else legacy's, else null when
 * neither could parse. Produced by {@link computePendingPurchaseParseComparison},
 * which is the ONE place that feeds the reverse-shadow scorecard, so the LLM
 * driving path (C8a) and the throwing {@link parseProductName} wrapper always
 * compare the exact same outputs.
 */
export interface PendingPurchaseParseComparison {
  parsekit: ParsekitDispatchResult
  legacy: { ok: true; output: ParsedProductName } | { ok: false; error: string }
  winner: ParsedProductName | null
}

/**
 * Run parsekit (the live parser being tuned) AND the legacy hardcoded waterfall
 * (`parseProductNameLegacy`) over one name, record any divergence to the
 * `parsekit_reverse_shadow_events` feed exactly once, and return BOTH outputs
 * plus the winner. Never throws — an input neither parser can handle returns
 * `winner: null`.
 *
 * Post-C8a, parsekit and the legacy heuristics run hand-in-hand with the LLM
 * classifier (operator kept parsekit alive; the Config → Parsing → Purchases
 * scorecard stays live). This function is the shared core: the LLM path calls
 * it once per row to (a) keep feeding the scorecard and (b) build the per-line
 * 3-way comparison record, while `parseProductName` delegates to it for its
 * legacy throwing contract.
 */
export function computePendingPurchaseParseComparison(name: string): PendingPurchaseParseComparison {
  const normalized = name.trim()
  const parsekit = tryParsekitParsePendingPurchase(normalized)

  let legacy: ParsedProductName | null = null
  let legacyErr: unknown = null
  try {
    legacy = parseProductNameLegacy(name)
  } catch (err) {
    legacyErr = err
  }
  const legacyLeg: PendingPurchaseParseComparison['legacy'] = legacy !== null
    ? { ok: true, output: legacy }
    : { ok: false, error: errMessage(legacyErr) }

  if (parsekit.kind === 'ok') {
    if (legacy === null) {
      // Legacy threw on something parsekit accepted. Treat as a (good)
      // surprise: use parsekit's output but record it for review.
      REVERSE_SHADOW_STATS.legacy_threw += 1
      recordReverseShadowRecord({
        ts: Date.now(),
        kind: 'legacy_threw',
        input: name,
        parsekit: parsekit.output,
        parserId: parsekit.parserId,
        snapshotSha: parsekit.snapshotSha,
        legacyError: errMessage(legacyErr),
      })
      return { parsekit, legacy: legacyLeg, winner: parsekit.output }
    }
    const diffs = diffParsedProductName(parsekit.output, legacy)
    if (diffs.length === 0) {
      REVERSE_SHADOW_STATS.ok_match += 1
    } else {
      REVERSE_SHADOW_STATS.regression_diff += 1
      recordReverseShadowRecord({
        ts: Date.now(),
        kind: 'regression_diff',
        input: name,
        parsekit: parsekit.output,
        legacy,
        parserId: parsekit.parserId,
        ruleId: parsekit.ruleId,
        snapshotSha: parsekit.snapshotSha,
        diffFields: diffs,
      })
    }
    return { parsekit, legacy: legacyLeg, winner: parsekit.output }
  }

  // parsekit did not produce a successful parse — fall back to legacy.
  if (legacy === null) {
    // No safety net; the caller decides whether to throw.
    return { parsekit, legacy: legacyLeg, winner: null }
  }

  if (parsekit.kind === 'fail') {
    REVERSE_SHADOW_STATS.regression_unmatched += 1
    recordReverseShadowRecord({
      ts: Date.now(),
      kind: 'regression_unmatched',
      input: name,
      legacy,
      parserId: parsekit.parserId,
      snapshotSha: parsekit.snapshotSha,
      parsekitFailureReason: parsekit.reason,
    })
  } else {
    // 'no_registry' or 'no_detect_match' — silent legacy use, this is
    // the expected path for tenants not yet ported (hr-botanical) and
    // for boot windows before the registry has loaded.
    REVERSE_SHADOW_STATS.ok_no_detect += 1
  }
  return { parsekit, legacy: legacyLeg, winner: legacy }
}

export function parseProductName(name: string): ParsedProductName {
  const comparison = computePendingPurchaseParseComparison(name)
  if (comparison.winner !== null) {
    return comparison.winner
  }
  if (comparison.legacy.ok === false) {
    throw new Error(comparison.legacy.error)
  }
  throw new Error('parseProductName: legacy returned no result')
}

// ---------------------------------------------------------------------
// Reverse-shadow telemetry
// ---------------------------------------------------------------------

export interface ParsekitReverseShadowRecord {
  ts: number
  kind: 'regression_unmatched' | 'regression_diff' | 'legacy_threw'
  input: string
  parsekit?: ParsedProductName
  legacy?: ParsedProductName
  parserId?: string
  ruleId?: string
  snapshotSha?: string
  /** Fields whose values differ between parsekit and legacy. */
  diffFields?: string[]
  /** parsekit failure reason ({no_match,validation_error,...}: diagnostics). */
  parsekitFailureReason?: string
  /** Stringified legacy error when `kind === 'legacy_threw'`. */
  legacyError?: string
}

export interface ParsekitReverseShadowSnapshot {
  /** parsekit succeeded with identical output to legacy. */
  ok_match: number
  /** parsekit did not dispatch (no detect prefix or no registry) — legacy used. */
  ok_no_detect: number
  /** parsekit dispatched but failed to parse — legacy used, regression. */
  regression_unmatched: number
  /** parsekit succeeded but output differs from legacy. */
  regression_diff: number
  /** legacy threw on input parsekit accepted. */
  legacy_threw: number
  /** Most-recent-first ring buffer (cap MAX_RECENT). */
  recent: ParsekitReverseShadowRecord[]
}

const REVERSE_SHADOW_MAX_RECENT = 100
const REVERSE_SHADOW_STATS: ParsekitReverseShadowSnapshot = {
  ok_match: 0,
  ok_no_detect: 0,
  regression_unmatched: 0,
  regression_diff: 0,
  legacy_threw: 0,
  recent: [],
}

export function getParsekitReverseShadowSnapshot(): ParsekitReverseShadowSnapshot {
  return {
    ok_match: REVERSE_SHADOW_STATS.ok_match,
    ok_no_detect: REVERSE_SHADOW_STATS.ok_no_detect,
    regression_unmatched: REVERSE_SHADOW_STATS.regression_unmatched,
    regression_diff: REVERSE_SHADOW_STATS.regression_diff,
    legacy_threw: REVERSE_SHADOW_STATS.legacy_threw,
    recent: REVERSE_SHADOW_STATS.recent.slice(),
  }
}

/** Test-only: clear counters and ring buffer. */
export function __resetParsekitReverseShadowSnapshot(): void {
  REVERSE_SHADOW_STATS.ok_match = 0
  REVERSE_SHADOW_STATS.ok_no_detect = 0
  REVERSE_SHADOW_STATS.regression_unmatched = 0
  REVERSE_SHADOW_STATS.regression_diff = 0
  REVERSE_SHADOW_STATS.legacy_threw = 0
  REVERSE_SHADOW_STATS.recent.length = 0
}

function recordReverseShadowRecord(rec: ParsekitReverseShadowRecord): void {
  REVERSE_SHADOW_STATS.recent.unshift(rec)
  if (REVERSE_SHADOW_STATS.recent.length > REVERSE_SHADOW_MAX_RECENT) {
    REVERSE_SHADOW_STATS.recent.length = REVERSE_SHADOW_MAX_RECENT
  }
  // Loud structured log: one JSON line per event. The Helios UI reads
  // from the DB-backed event log via /api/config/parsing/pending-purchases;
  // this log line is the durable trail for ops-debugging via journalctl.
  console.warn(JSON.stringify({ msg: 'parsekit reverse-shadow', ...rec }))

  // Persist asynchronously so the parser stays synchronous and
  // call-site free of DB plumbing. Failures (no DB, no migration,
  // anything) must NOT propagate: parser correctness has already
  // been decided by the caller before this point.
  void insertParsekitReverseShadowEvent({
    kind: rec.kind,
    input: rec.input,
    parserId: rec.parserId ?? null,
    ruleId: rec.ruleId ?? null,
    snapshotSha: rec.snapshotSha ?? null,
    diffFields: rec.diffFields ?? null,
    parsekitOutput: rec.parsekit ?? null,
    legacyOutput: rec.legacy ?? null,
    parsekitFailureReason: rec.parsekitFailureReason ?? null,
    legacyError: rec.legacyError ?? null,
  }).catch((err) => {
    // Swallow — already logged loudly above. We don't want a DB
    // hiccup to slow down or break the parsing path.
    console.warn(
      JSON.stringify({
        msg: 'parsekit reverse-shadow: db persist failed',
        err: err instanceof Error ? err.message : String(err),
      }),
    )
  })
}

function diffParsedProductName(a: ParsedProductName, b: ParsedProductName): string[] {
  const out: string[] = []
  const keys = new Set<string>([...Object.keys(a), ...Object.keys(b)])
  const ar = a as unknown as Record<string, unknown>
  const br = b as unknown as Record<string, unknown>
  for (const k of keys) {
    if (ar[k] !== br[k]) out.push(k)
  }
  return out
}

type ParsekitDispatchResult =
  | { kind: 'no_registry' }
  | { kind: 'no_detect_match'; snapshotSha: string }
  | { kind: 'fail'; snapshotSha: string; parserId: string; reason: string }
  | {
      kind: 'ok'
      snapshotSha: string
      parserId: string
      ruleId: string
      output: ParsedProductName
    }

function tryParsekitParsePendingPurchase(input: string): ParsekitDispatchResult {
  const release = getParserRegistry().current()
  if (!release) return { kind: 'no_registry' }
  const dispatch = findParsekitDispatchByPrefix(release, input)
  if (!dispatch) return { kind: 'no_detect_match', snapshotSha: release.sha }
  let r
  try {
    r = parseWith(dispatch, input, { snapshotSha: release.sha })
  } catch (err) {
    return {
      kind: 'fail',
      snapshotSha: release.sha,
      parserId: dispatch.config.parserId,
      reason: `threw: ${errMessage(err)}`,
    }
  }
  if (r.ok) {
    return {
      kind: 'ok',
      snapshotSha: r.snapshotSha,
      parserId: r.parserId,
      ruleId: r.ruleId,
      output: r.output as ParsedProductName,
    }
  }
  const diagSummary = r.diagnostics?.length
    ? ': ' + r.diagnostics.map((d) => `${d.ruleId || '-'}=${d.reason}`).join('; ')
    : ''
  return {
    kind: 'fail',
    snapshotSha: release.sha,
    parserId: dispatch.config.parserId,
    reason: `${r.reason}${diagSummary}`,
  }
}

function findParsekitDispatchByPrefix(
  release: CompiledRelease,
  input: string,
): CompiledParser<unknown> | null {
  const lowered = input.toLowerCase()
  for (const parser of release.parsers.values()) {
    if (parser.config.scope.useCase !== 'pending-purchases') continue
    const prefixes = parser.config.detect.prefixes ?? []
    for (const p of prefixes) {
      if (lowered.startsWith(p.toLowerCase())) return parser
    }
  }
  return null
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

// Brand names we will never accept from the LLM teacher as a
// classification of a *distributor* product row. "Freshly Baked NYC"
// is the operator's own retail brand and cannot appear on a METRC
// distributor invoice; if the teacher proposes it, it has hallucinated
// the brand (historically because the system prompt named us by name).
// Compared after `derivePendingPurchaseBrandKey` normalization (lower-
// case, strip punctuation, collapse whitespace).
const PROHIBITED_HOUSE_BRAND_KEYS: ReadonlySet<string> = new Set([
  'freshly baked nyc',
  'freshly baked ny',
  'freshly baked',
  'freshlybaked',
  'freshlybakednyc',
  'freshlybakedny',
  'fbnyc',
  'fb nyc',
  'fbn',
])

function isProhibitedHouseBrand(brand: string | null | undefined): boolean {
  if (!brand) return false
  const key = derivePendingPurchaseBrandKey(brand)
  if (!key) return false
  return PROHIBITED_HOUSE_BRAND_KEYS.has(key)
}

type TeacherAttempt = {
  attempt: number
  rawContent: string
  failureKind: 'schema' | 'house-brand' | 'too-risky'
  failureDetail: string
}

function formatTeacherSchemaErrors(issues: ReadonlyArray<z.ZodIssue>): string {
  if (issues.length === 0) return '(no issues reported)'
  return issues
    .slice(0, 8)
    .map((issue) => {
      const path = issue.path.length === 0 ? '<root>' : issue.path.map((segment) => String(segment)).join('.')
      return `- at ${path}: ${issue.message}`
    })
    .join('\n')
}

function buildTeacherRetryPromptForSchemaErrors(options: { failureSummary: string }): string {
  return [
    options.failureSummary,
    '',
    'IMPORTANT:',
    '- Return only valid JSON, no prose, no markdown fences.',
    '- The shape MUST be {"classification": {...}, "teaching": {...}}.',
    '- Every confidence is a number in [0, 1] (e.g. 0.85), never a percentage.',
    '- packCount is a positive integer (1, 2, 3, ...), never null or 0.',
    '- size always includes its unit ("3.5g", "1g", "100mg").',
    '- Use only allowed enum values listed in the system message.',
  ].join('\n')
}

function describeWhyNormalizationFailed(
  classification: z.infer<typeof PendingPurchaseLlmClassificationSchema>,
): string {
  const reasons: string[] = []
  if (!AUTO_CLASSIFIABLE_PENDING_PURCHASE_CATEGORIES.has(classification.category)) {
    reasons.push(`category "${classification.category}" is not on the auto-classifiable list`)
  }
  if (classification.confidence < 0.8) {
    reasons.push(`confidence ${classification.confidence.toFixed(2)} is below 0.8`)
  }
  if (classification.parserFeasibility === 'needs-more-context') {
    reasons.push('parserFeasibility is "needs-more-context"')
  }
  if (reasons.length === 0) {
    reasons.push('normalization rejected the classification for an unspecified reason')
  }
  return reasons.join('; ')
}

async function emitTeacherUnresolved(input: {
  attempts: ReadonlyArray<TeacherAttempt>
  envelope: z.infer<typeof PendingPurchaseLlmTeachingEnvelopeSchema> | null
  finalNoteHint: string
  normalizedDistributorProductName: string
  observationRawRow: Record<string, JsonValue>
  rawDistributorProductName: string
  rowInputSignature: string
}): Promise<PendingPurchaseLlmFallbackResult> {
  // Persist an audit observation containing the full teacher transcript
  // so the operator can inspect why the model kept failing. We do NOT
  // associate a brandProfile (the whole point is the teacher could not
  // safely identify one) and we do NOT learn a rule.
  try {
    await withTransaction(async (db) => {
      await insertPendingPurchaseParseObservation(db, {
        inference: toJsonValue({
          attempts: input.attempts.map((attempt) => ({
            attempt: attempt.attempt,
            failureKind: attempt.failureKind,
            failureDetail: attempt.failureDetail,
            rawContent: attempt.rawContent,
          })),
          finalEnvelope: input.envelope,
          parserSource: 'llm-teacher',
          resolution: 'unresolved',
        }),
        normalizedDistributorProductName: input.normalizedDistributorProductName,
        notes: input.finalNoteHint,
        observationStatus: 'captured',
        observationType: 'llm_inference',
        rawDistributorProductName: input.rawDistributorProductName,
        rawRow: input.observationRawRow,
        rowInputSignature: input.rowInputSignature,
        sourceSystem: PENDING_PURCHASE_SOURCE_SYSTEM,
      })
    })
  } catch (persistErr) {
    // Audit-only side effect — never let an observation-write failure
    // hide the real classification failure from the caller.
    console.warn('[pending-purchase] failed to persist teacher-unresolved observation', persistErr)
  }

  const transcriptSummary = input.attempts
    .map((attempt) => `attempt ${attempt.attempt} (${attempt.failureKind}): ${attempt.failureDetail}`)
    .join(' | ')
  return {
    brandProfile: null,
    learnedRule: null,
    note: `${input.finalNoteHint} Teacher transcript: ${transcriptSummary || '(no attempts recorded)'}`,
    parsed: null,
    parserSource: 'llm-teacher',
    reviewFlag: 'LLM teacher could not classify — manual review required',
  }
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

  const MAX_TEACHER_ATTEMPTS = 3
  const anchors = await findPendingPurchaseLlmAnchors(input.cache, input.group.distributorProductName)
  const normalizedDistributorProductName = normalizePendingPurchaseParserText(input.group.distributorProductName)
  const observationRawRow = buildPendingPurchaseParserObservationRawRow(input)

  const systemPrompt = [
    'You classify a single unresolved row from a METRC cannabis-distribution invoice into a strict catalog taxonomy and teach reusable parsing knowledge.',
    'The `brand` field MUST be the actual upstream distributor brand printed on the METRC invoice — never the receiving retailer.',
    'Specifically: NEVER propose "Freshly Baked NYC" (or any of its aliases: Freshly Baked, Freshly Baked NY, FBNYC, FBN) as the brand. That is the receiving retailer\'s own house brand and cannot appear on a METRC distributor invoice. If the raw row name does not clearly identify an upstream brand, leave `brand` empty and set `parserFeasibility` to "needs-more-context" — do NOT default to the retailer\'s name.',
    'Return only valid JSON with the exact top-level shape {"classification": {...}, "teaching": {...}}.',
    'The classification object must include: brand, category, subcategory, groupName, variantName, variantTab, size, packCount, strainName, prevalence, confidence, parserFeasibility, rationale, warningFlags.',
    'The teaching object must include: brandAliases, exactNameRules, generalizedRules, riskFlags.',
    'Each brandAliases item must include: aliasType, aliasValue, confidence, rationale, riskFlags.',
    'Each exactNameRules item must include: rawName, confidence, rationale, safeAutoPersist, riskFlags.',
    'Each generalizedRules item must include: ruleKind, normalizedMatchValue, matchPayload, confidence, rationale, riskFlags.',
    'Use parserFeasibility only from: easy-rule-based, needs-more-context, likely-llm-only.',
    'Use null for subcategory or prevalence when not applicable.',
    'For category "Edibles": gummies and chews are deliberately stored with NO subcategory in our Sweed taxonomy. NEVER propose "Gummies", "Gummy", or "Chews/Gummies" as a subcategory — none of those exist as enabled subcategories. Return subcategory: null for any gummy/chew edible.',
    'Use aliasType only from: exact, prefix.',
    'Use ruleKind only from: prefix, regex, template.',
    'Every confidence field is a probability between 0 and 1 inclusive (e.g. 0.92, NOT 92 or 92%). Do not emit values above 1.',
    'size is always a string with its unit attached, e.g. "3.5g", "1g", "100mg", "750mg" — never a bare number.',
    'packCount is ALWAYS a positive integer (1, 3, 5, 10, etc.). For a single-unit package, packCount = 1. NEVER emit null, 0, NaN, or omit the field.',
    'Never use generic words like Beverage, Vape, or Gummy Brick by themselves as the full groupName when a flavor, cultivar, or family differentiator is present.',
    'If live anchor examples for the same brand and family are provided, follow their packCount, size, and variantTab pattern unless the raw input clearly contradicts them.',
    'For beverage and edible flavors, strainName is usually empty unless the name clearly represents a cultivar lane.',
    'Keep canonical naming customer-facing and normalized instead of copying raw punctuation.',
    'Only mark safeAutoPersist true for narrow exact-name reuse on the exact raw row, never for broad generalized rules.',
    'If you suggest a broader prefix, regex, or template rule, be conservative and include a risk flag unless it is very clearly safe.',
  ].join(' ')

  const userPayload = JSON.stringify({
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
  }, null, 2)

  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPayload },
  ]
  const transcript: TeacherAttempt[] = []

  try {
    for (let attempt = 1; attempt <= MAX_TEACHER_ATTEMPTS; attempt += 1) {
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
          messages,
        }),
        signal: AbortSignal.timeout(env.llmRequestTimeoutMs),
      })

      const rawResponseText = await response.text()
      if (!response.ok) {
        return {
          brandProfile: null,
          learnedRule: null,
          note: `Bedrock fallback classification failed with HTTP ${response.status} on attempt ${attempt}; keeping manual review.`,
          parsed: null,
          parserSource: 'llm-teacher',
          reviewFlag: null,
        }
      }

      const content = extractChatCompletionContent(rawResponseText)
      messages.push({ role: 'assistant', content })

      // 1) JSON.parse the model output. If it isn't even valid JSON,
      //    feed that back and ask for a corrected response.
      let envelopeJson: unknown
      try {
        envelopeJson = JSON.parse(content)
      } catch (jsonErr) {
        const failureDetail = jsonErr instanceof Error ? jsonErr.message : String(jsonErr)
        transcript.push({ attempt, rawContent: content, failureKind: 'schema', failureDetail: `JSON parse error: ${failureDetail}` })
        if (attempt < MAX_TEACHER_ATTEMPTS) {
          messages.push({
            role: 'user',
            content: buildTeacherRetryPromptForSchemaErrors({
              failureSummary: `Your previous response was not valid JSON: ${failureDetail}. Return ONLY a single JSON object with the exact required shape.`,
            }),
          })
          continue
        }
        return await emitTeacherUnresolved({
          attempts: transcript,
          envelope: null,
          finalNoteHint: `Bedrock returned non-JSON content after ${MAX_TEACHER_ATTEMPTS} attempts (last error: ${failureDetail}).`,
          normalizedDistributorProductName,
          observationRawRow,
          rawDistributorProductName: input.group.distributorProductName,
          rowInputSignature: input.rowInputSignature,
        })
      }

      // 2) Validate against the envelope schema. If that fails, feed
      //    the Zod errors back to the model and ask it to fix the
      //    offending fields.
      const safeEnvelope = PendingPurchaseLlmTeachingEnvelopeSchema.safeParse(envelopeJson)
      if (!safeEnvelope.success) {
        const formattedErrors = formatTeacherSchemaErrors(safeEnvelope.error.issues)
        transcript.push({ attempt, rawContent: content, failureKind: 'schema', failureDetail: formattedErrors })
        if (attempt < MAX_TEACHER_ATTEMPTS) {
          messages.push({
            role: 'user',
            content: buildTeacherRetryPromptForSchemaErrors({
              failureSummary: `Your previous response did not match the required schema. Validation errors:\n${formattedErrors}\nFix ONLY those fields and re-emit the complete JSON object — same shape, same other fields.`,
            }),
          })
          continue
        }
        return await emitTeacherUnresolved({
          attempts: transcript,
          envelope: null,
          finalNoteHint: `Bedrock returned schema-invalid JSON after ${MAX_TEACHER_ATTEMPTS} attempts. Last errors: ${formattedErrors}`,
          normalizedDistributorProductName,
          observationRawRow,
          rawDistributorProductName: input.group.distributorProductName,
          rowInputSignature: input.rowInputSignature,
        })
      }

      const parsedEnvelope = safeEnvelope.data

      // 3) Reject hallucinated house-brand classifications outright.
      //    Re-prompt with the explicit instruction to pick the actual
      //    upstream distributor brand or leave the field empty.
      if (isProhibitedHouseBrand(parsedEnvelope.classification.brand)) {
        const failureDetail = `proposed brand "${parsedEnvelope.classification.brand}" is the operator's own retail brand (Freshly Baked NYC) and is not a valid METRC distributor brand`
        transcript.push({ attempt, rawContent: content, failureKind: 'house-brand', failureDetail })
        if (attempt < MAX_TEACHER_ATTEMPTS) {
          messages.push({
            role: 'user',
            content: [
              'You proposed "Freshly Baked NYC" (or one of its aliases) as the brand. That is the receiving retailer\'s own brand and CAN NEVER be the brand of a METRC distributor row.',
              'If the raw row name clearly identifies an upstream brand, return that brand instead.',
              'If the raw row name does NOT clearly identify an upstream brand, set `brand` to "" (empty string) and `parserFeasibility` to "needs-more-context", and lower `confidence` below 0.8.',
              'Re-emit the complete JSON object with the corrected classification.',
            ].join(' '),
          })
          continue
        }
        return await emitTeacherUnresolved({
          attempts: transcript,
          envelope: parsedEnvelope,
          finalNoteHint: `Bedrock kept proposing the house brand "Freshly Baked NYC" after ${MAX_TEACHER_ATTEMPTS} attempts; rejecting and keeping manual review.`,
          normalizedDistributorProductName,
          observationRawRow,
          rawDistributorProductName: input.group.distributorProductName,
          rowInputSignature: input.rowInputSignature,
        })
      }

      const normalizedClassification = normalizePendingPurchaseLlmClassification(
        parsedEnvelope.classification,
        input.group.distributorProductName,
      )
      if (!normalizedClassification) {
        // The model returned a valid shape but the row is still not
        // safe to auto-classify (e.g. confidence too low, category not
        // on the safe-list, or `parserFeasibility = 'needs-more-context'`).
        // Surface to manual review with the classification persisted
        // for auditing, same as before — no point retrying a model
        // that is honestly telling us it isn't sure.
        const why = describeWhyNormalizationFailed(parsedEnvelope.classification)
        transcript.push({ attempt, rawContent: content, failureKind: 'too-risky', failureDetail: why })
        return await emitTeacherUnresolved({
          attempts: transcript,
          envelope: parsedEnvelope,
          finalNoteHint: `Bedrock fallback classification returned a shape that is still too risky for auto-classification (${why}); keeping manual review.`,
          normalizedDistributorProductName,
          observationRawRow,
          rawDistributorProductName: input.group.distributorProductName,
          rowInputSignature: input.rowInputSignature,
        })
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
    }
    // Unreachable: the retry loop above always returns inside the
    // body (either with a successful classification or via
    // `emitTeacherUnresolved`). This satisfies the TS control-flow
    // checker for the function's return type.
    return await emitTeacherUnresolved({
      attempts: transcript,
      envelope: null,
      finalNoteHint: `Bedrock teacher exhausted ${MAX_TEACHER_ATTEMPTS} attempts without returning a usable classification.`,
      normalizedDistributorProductName,
      observationRawRow,
      rawDistributorProductName: input.group.distributorProductName,
      rowInputSignature: input.rowInputSignature,
    })
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

/**
 * Strip container nouns the LLM teacher sometimes leaves in
 * `classification.variantName` (e.g. "3.5g Jar", "1g Tin",
 * "100mg Pouch"), and for Flower override the variant name with the
 * canonical size — Flower variants are conventionally named by size
 * alone ("3.5g", "7g", "14g"), never by the container they ship in.
 *
 * Trims trailing single-word container nouns even outside Flower so a
 * misclassified "X 1g Bottle" still loses the "Bottle" suffix.
 */
const LLM_VARIANT_NAME_CONTAINER_TOKENS = new Set([
  'jar',
  'jars',
  'tin',
  'tins',
  'bag',
  'bags',
  'pouch',
  'pouches',
  'bottle',
  'bottles',
  'box',
  'boxes',
  'container',
  'containers',
  'pack',
  'packs',
  'tube',
  'tubes',
  'tray',
  'trays',
])

function repairLlmVariantName(
  rawVariantName: string | null | undefined,
  category: string,
  packCount: number,
  normalizedSize: string,
  normalizedTab: string,
): string {
  if (category === 'Flower') {
    return packCount > 1 ? normalizedTab : normalizedSize
  }
  const seed = (rawVariantName ?? '').trim()
  if (seed.length === 0) {
    // LLM omitted/nulled variantName. Fall back to the canonical tab,
    // which already encodes packCount/size (e.g. "10mg", "2x 100mg").
    return normalizedTab
  }
  const stripped = stripTrailingContainerTokens(seed)
  return stripped.length > 0 ? stripped : seed
}

function stripTrailingContainerTokens(value: string): string {
  let working = value.trim()
  while (true) {
    const match = /\s+(\S+)$/.exec(working)
    if (!match) return working
    const lastToken = match[1].toLowerCase().replace(/[.,;:]+$/u, '')
    if (!LLM_VARIANT_NAME_CONTAINER_TOKENS.has(lastToken)) return working
    working = working.slice(0, match.index).trimEnd()
  }
}

/**
 * Known strain-class words the LLM occasionally drops into the wrong
 * field. Anything in here is a *classification* label (Sativa / Indica /
 * Hybrid family) — never a cultivar / flavor / variant.
 *
 * Matched case-insensitively. Multi-word combinations (e.g.
 * "Indica Hybrid") are normalized via `pickTrailingStrainLabel` below.
 */
const STRAIN_LABEL_WORDS = new Set<string>([
  'indica',
  'sativa',
  'hybrid',
  'indica-dominant',
  'sativa-dominant',
])

/**
 * If the value's trailing word(s) are a strain-class label
 * (e.g. "… Blueberry Indica" → "Indica"), return the matched label in
 * canonical title-case along with the value with those words stripped
 * off. Returns null if the value does not end in a strain label.
 *
 * Recognized trailing patterns (last 1 or 2 whitespace-delimited words,
 * lowercased and punctuation-trimmed):
 *   - "indica" / "sativa" / "hybrid"
 *   - "indica hybrid" / "sativa hybrid"  → normalized to e.g. "Indica Hybrid"
 *   - hyphenated variants ("indica-dominant")
 */
function pickTrailingStrainLabel(value: string): { stripped: string; strain: string } | null {
  const trimmed = value.trim()
  if (trimmed.length === 0) return null
  const tokens = trimmed.split(/\s+/)
  const last = tokens[tokens.length - 1].toLowerCase().replace(/[.,;:]+$/u, '')
  const penultimate = tokens.length >= 2
    ? tokens[tokens.length - 2].toLowerCase().replace(/[.,;:]+$/u, '')
    : null

  // "Indica Hybrid" / "Sativa Hybrid"
  if (penultimate !== null
    && (penultimate === 'indica' || penultimate === 'sativa')
    && last === 'hybrid') {
    const stripped = tokens.slice(0, tokens.length - 2).join(' ').trim()
    const strain = `${penultimate.charAt(0).toUpperCase()}${penultimate.slice(1)} Hybrid`
    return { stripped, strain }
  }

  if (STRAIN_LABEL_WORDS.has(last)) {
    const stripped = tokens.slice(0, tokens.length - 1).join(' ').trim()
    // Title-case ("indica-dominant" → "Indica-dominant"); good enough
    // for downstream display where strain is a label, not a slug.
    const strain = `${last.charAt(0).toUpperCase()}${last.slice(1)}`
    return { stripped, strain }
  }

  return null
}

/**
 * Some LLM classifications stuff a strain-class label (Indica / Sativa
 * / Hybrid) into the variantName (and occasionally swap it with the
 * actual flavor in strainName). Example seen in prod for
 *   "Flav - Candy - Belt - 100mg - Live Resin - Blueberry - Indica"
 * the LLM returned `variantName="Blueberry Indica"`, `strainName="Blueberry"`
 * even though its own rationale correctly identified "'Indica' is a
 * strain indicator." This repair detects that trailing strain label
 * and moves it into strainName, leaving the flavor / cultivar in
 * variantName.
 *
 * Conservative: only fires when the trailing token of variantName is a
 * recognized strain label AND the LLM's strainName is empty OR is itself
 * not a strain label (i.e. the LLM almost certainly swapped them).
 */
function repairLlmStrainPlacement(input: {
  variantName: string
  strainName: string
}): { variantName: string; strainName: string } {
  const picked = pickTrailingStrainLabel(input.variantName)
  if (!picked) return input
  if (picked.stripped.length === 0) return input

  const currentStrainTokens = input.strainName.trim().split(/\s+/).filter((t) => t.length > 0)
  const currentStrainLooksLikeLabel = currentStrainTokens.length === 1
    && STRAIN_LABEL_WORDS.has(currentStrainTokens[0].toLowerCase())
  if (input.strainName.trim().length > 0 && currentStrainLooksLikeLabel) {
    // LLM already correctly put a strain label in strainName; leave
    // variantName alone (it presumably intended the trailing word).
    return input
  }

  return {
    variantName: picked.stripped,
    strainName: picked.strain,
  }
}

// Extraction-method tokens the LLM teacher often glues onto the front of
// variantName when the distributor name interleaves the method with the
// flavor (e.g. "Mega Ring - Gummy - 100mg - Distillate - Peach - 10x10mg"
// is misclassified as variantName="Distillate Peach"). These are
// process / formulation modifiers, not part of the customer-facing
// variant name. Stripped from the LEADING positions of variantName only —
// they can legitimately appear later in a name (e.g. "Live Resin
// Diamonds").
const LEADING_EXTRACTION_METHOD_TOKENS_RE =
  /^\s*(?:(?:live\s+resin|live\s+rosin|rosin|solventless|distillate|full\s+spectrum|broad\s+spectrum|rso|fso|co2|hash\s+rosin)\s*[-:·]?\s+)+/i

// Categories for which an "AIO" / "All-in-One" token in the raw
// distributor name strongly implies the All-in-One disposable
// subcategory. The catalog uses `All In One / Disposable` for these.
const ALL_IN_ONE_VAPE_SUBCATEGORY = 'All In One / Disposable'
const AIO_TOKEN_RE = /(?:^|[\s\-·.,/(])aio(?:[\s\-·.,/)$]|$)/i

/**
 * LLM-emitted subcategory canonicalization map: `category:subcategory`
 * (both lowercased) → canonical Sweed subcategory name. Used to rewrite
 * known-bad subcategory names the LLM teacher keeps proposing into the
 * actual taxonomy name Sweed expects. Mirrors `SUBCATEGORY_ALIASES` in
 * the apply worker so packets are corrected at *proposal* time rather
 * than only at apply time. Currently empty — gummies-style hallucinations
 * are handled by `LLM_FORBIDDEN_SUBCATEGORIES` below (drop to no
 * subcategory) rather than a rewrite, because Edibles gummies are
 * deliberately stored with no subcategory in our Sweed taxonomy.
 */
const LLM_SUBCATEGORY_REWRITES = new Map<string, string>([])

/**
 * Subcategory names the LLM teacher must never emit. Forbidden values
 * are blanked (the row keeps its category, just no subcategory) rather
 * than rewritten. Keep this list short and explicit; the goal is to
 * stop a known recurring hallucination, not to police all taxonomy.
 *
 * Edibles "Gummies" / "Gummy": Sweed's Edibles category has no
 * enabled gummies subcategory — gummies are deliberately filed as
 * Edibles with no subcategory. Apply jobs that proposed "Gummies"
 * crashed (job 133150 rows 362/364).
 */
const LLM_FORBIDDEN_SUBCATEGORIES = new Set<string>([
  'edibles:gummies',
  'edibles:gummy',
])

function canonicalizeLlmSubcategory(category: string, subcategory: string): string {
  const trimmed = subcategory.trim()
  if (trimmed === '') {
    return ''
  }
  const key = `${category.trim().toLowerCase()}:${trimmed.toLowerCase()}`
  const rewritten = LLM_SUBCATEGORY_REWRITES.get(key)
  if (rewritten) {
    return rewritten
  }
  if (LLM_FORBIDDEN_SUBCATEGORIES.has(key)) {
    return ''
  }
  return trimmed
}

function stripLeadingExtractionMethods(value: string): string {
  return value.replace(LEADING_EXTRACTION_METHOD_TOKENS_RE, '').trim()
}

function looksLikeStrainLabel(value: string): boolean {
  const trimmed = value.trim().toLowerCase()
  return STRAIN_LABEL_WORDS.has(trimmed)
    || trimmed === 'indica hybrid'
    || trimmed === 'sativa hybrid'
}

function normalizePendingPurchaseLlmClassification(
  classification: z.infer<typeof PendingPurchaseLlmClassificationSchema>,
  rawDistributorProductName?: string,
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
  const llmTab = normalizeNonEmptyString(classification.variantTab)

  // variantTab is structural metadata: it encodes pack-count × unit
  // size (e.g. "1g", "0.5g", "10x 10mg"). The LLM teacher occasionally
  // drops a prevalence label ("Indica" / "Sativa" / "Hybrid") into
  // variantTab when the source name's last dashed segment is the
  // strain class. Replace any such mis-tagged variantTab with the
  // canonical size-based tab. If the LLM also mis-routed the real size
  // into variantTab, normalizeSizeText below will salvage the size.
  const repairedTab = (llmTab !== null && !looksLikeStrainLabel(llmTab))
    ? llmTab
    : (classification.packCount > 1 ? `${classification.packCount}x ${normalizedSize}` : normalizedSize)

  // The LLM teacher sometimes echoes container nouns from the
  // distributor product name into `variantName` (e.g. "3.5g Jar" for a
  // Herb flower eighth that should just be called "3.5g"). Strip those
  // trailing container tokens and, for Flower in particular, override
  // the variant name with the canonical size — the variant name for a
  // flower variant is the size, not the container.
  let repairedVariantName = repairLlmVariantName(
    classification.variantName,
    classification.category,
    classification.packCount,
    normalizedSize,
    repairedTab,
  )

  // Strip leading extraction-method / formulation tokens. The LLM teacher
  // routinely keeps tokens like "Distillate" or "Live Resin" attached to
  // variantName when they should be process modifiers (e.g.
  // "Mega Ring - Gummy - 100mg - Distillate - Peach - 10x10mg" should be
  // variantName="Peach", not "Distillate Peach"). Skip for Flower, where
  // variantName is already canonicalized to the size.
  if (classification.category !== 'Flower') {
    const stripped = stripLeadingExtractionMethods(repairedVariantName)
    if (stripped.length > 0) {
      repairedVariantName = stripped
    }
  }

  // The LLM teacher routinely mis-files strain-class labels (Indica /
  // Sativa / Hybrid) by appending them to variantName instead of
  // strainName — sometimes also swapping them with the actual flavor.
  // `repairLlmStrainPlacement` detects a trailing strain label and
  // moves it back into strainName so reviewers don't see "Create new
  // Blueberry Indica" when the variant is actually a Blueberry candy
  // belt with an Indica strain.
  const strainRepair = repairLlmStrainPlacement({
    variantName: repairedVariantName,
    strainName: normalizeNonEmptyString(classification.strainName) ?? '',
  })

  // AIO / All-in-One subcategory inference. If the raw distributor
  // product name carries an `AIO` token (case-insensitive, word-bounded)
  // and the LLM classified this as a vape but missed the subcategory
  // (or chose something inconsistent), force the catalog's canonical
  // "All In One / Disposable" subcategory. This matches what the
  // hardcoded parsers do for Posh Puff / Cannabals Chubby Puff and
  // keeps Flav AIO vapes from being filed without a subcategory.
  let resolvedSubcategory = normalizeNonEmptyString(classification.subcategory) ?? ''
  const distributorMatchesAio = rawDistributorProductName !== undefined && AIO_TOKEN_RE.test(rawDistributorProductName)
  if (distributorMatchesAio && classification.category === 'Vapes' && resolvedSubcategory !== ALL_IN_ONE_VAPE_SUBCATEGORY) {
    resolvedSubcategory = ALL_IN_ONE_VAPE_SUBCATEGORY
  }

  // Subcategory rewrites + blocklist. The LLM teacher occasionally
  // proposes subcategory names that don't exist under that category
  // in Sweed's taxonomy. We canonicalise the known-good rewrites
  // (e.g. the literal "Gummies" → Sweed's canonical "Chews/Gummies")
  // and silently drop other forbidden values so the apply path
  // doesn't have to deal with them. Keep this list small and explicit;
  // never silently invent a subcategory.
  resolvedSubcategory = canonicalizeLlmSubcategory(classification.category, resolvedSubcategory)

  const draft: ParsedProductName = {
    brand: classification.brand,
    category: classification.category,
    groupName: classification.groupName,
    packCount: classification.packCount,
    prevalence: normalizeNonEmptyString(classification.prevalence),
    searchTerm: classification.groupName,
    size: normalizedSize,
    strainName: strainRepair.strainName,
    subcategory: resolvedSubcategory,
    variantName: strainRepair.variantName,
    variantTab: repairedTab,
  }

  try {
    return normalizeAndValidateParsedProductName(draft, classification.variantName ?? repairedVariantName)
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
  // Edibles gummies have no subcategory in our Sweed taxonomy; Pre-Roll
  // Infused does. Don't propose a "Chews/Gummies" subcategory for the
  // gummy case — that's not an enabled Sweed subcategory.
  const subcategory = isRevertGummy ? '' : isInfused ? 'Infused' : ''

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

/**
 * Canonical upstream brand string for Canna Cure Farms. This is the
 * distributor name printed on the live METRC purchase row; we keep the
 * legal-entity form because the existing brand profile / aliases and the
 * `validatePendingPurchaseParsedOutput` "variantName includes brand"
 * check all key off this exact string.
 */
const CANNA_CURE_DISTRIBUTOR_BRAND = 'Canna Cure Farms, LLC'

/**
 * True when the known upstream distributor (from the linked distributor
 * product row) is Canna Cure Farms. Uses the shared distributor-name
 * comparator so the corporate "LLC" suffix is ignored.
 */
function isCannaCureDistributorName(value: string | null | undefined): boolean {
  return sameDistributorName(value ?? null, CANNA_CURE_DISTRIBUTOR_BRAND)
}

/**
 * Brand-keyed deterministic parser for Canna Cure Farms.
 *
 * Canna Cure's METRC product names carry NO brand token, so the
 * name-only `parseProductNameLegacy` dispatcher cannot route them and
 * throws. This parser is only invoked from `resolvePendingPurchaseParse`
 * once we know — from the linked distributor product row — that the
 * upstream brand is Canna Cure Farms. It deterministically handles the
 * brand's two observed shapes:
 *
 *   - Pre-rolls: `<Strain>[-] <size> [infused] Pre-roll[s]` and bare
 *     sub-gram multipacks like `<Strain> .5g 6 Pack` (a 6-pack of
 *     half-gram pre-rolls). A trailing `(Sample)` marker is stripped.
 *   - Gummies: `Gummies (<flavor>/<size>)` → Edibles (the NY edible
 *     canonical split is applied downstream in `buildGeneratedRow`).
 *
 * Anything outside those shapes throws so the LLM / manual-review path
 * still owns the long tail — a partial deterministic parse is worse than
 * needs-review.
 */
export function parseCannaCureName(rawName: string): ParsedProductName {
  const brand = CANNA_CURE_DISTRIBUTOR_BRAND
  // Strip a trailing "(Sample)" marker — sample-ness is tracked
  // separately via the position, not the variant taxonomy.
  const name = rawName.replace(/\s*\(\s*sample\s*\)\s*$/i, '').trim()
  const lowered = name.toLowerCase()

  // --- Gummies: "Gummies (<flavor>/<size>)" -> Edibles ----------------
  const gummyMatch = /^gummies\s*\(\s*(.+?)\s*\/\s*(\d+(?:\.\d+)?\s*mg)\s*\)$/i.exec(name)
  if (gummyMatch) {
    const flavor = cleanCultivar(gummyMatch[1])
    if (flavor.length === 0) {
      throw new Error(`Unhandled Canna Cure gummy name (empty flavor): ${rawName}`)
    }
    const size = normalizeSizeText(gummyMatch[2]) ?? gummyMatch[2].replace(/\s+/g, '').toLowerCase()
    const groupName = `${flavor} Gummies`
    return normalizeAndValidateParsedProductName(
      {
        brand,
        category: 'Edibles',
        groupName,
        packCount: 1,
        prevalence: null,
        searchTerm: flavor,
        size,
        strainName: '',
        // Edibles gummies are deliberately filed with no subcategory in
        // our Sweed taxonomy (see LLM_FORBIDDEN_SUBCATEGORIES).
        subcategory: '',
        variantName: `${brand} ${groupName} ${size}`,
        variantTab: size,
      },
      rawName,
    )
  }

  // --- Pre-rolls ------------------------------------------------------
  // Require either an explicit pre-roll token or a bare sub-gram
  // multipack shape; Canna Cure's catalog is pre-rolls + gummies only.
  const isPreroll = /pre[\s-]?rolls?/i.test(lowered)
  const isBareMultipack = /\b\d+\s*(?:pack|pk)\b/i.test(lowered)
  if (!isPreroll && !isBareMultipack) {
    throw new Error(`Unhandled Canna Cure product name: ${rawName}`)
  }

  // Size token. The negative lookbehind prevents matching the "5g" tail
  // inside ".5g" as 5 grams.
  const sizeMatch = /(?<![\d.])(\d*\.?\d+)\s*g\b/i.exec(name)
  if (!sizeMatch) {
    throw new Error(`Unhandled Canna Cure product name (no size token): ${rawName}`)
  }
  const sizeText = sizeMatch[1].startsWith('.') ? `0${sizeMatch[1]}` : sizeMatch[1]
  const sizeGrams = Number(sizeText)
  const size = normalizeSizeText(`${sizeText}g`) ?? `${sizeText}g`

  // Pack count.
  let packCount = 1
  const packMatch = /(\d+)\s*(?:pack|pk)\b/i.exec(name)
  if (packMatch) {
    const parsedCount = Number(packMatch[1])
    if (Number.isFinite(parsedCount) && parsedCount >= 1) {
      packCount = parsedCount
    }
  }

  // A multipack whose unit size is > 1g is ambiguous (it may be a total
  // package weight rather than a per-unit size). Defer those to manual
  // review rather than guessing.
  if (packCount > 1 && sizeGrams > 1) {
    throw new Error(`Unhandled Canna Cure multipack size: ${rawName}`)
  }

  const isInfused = !lowered.includes('uninfused')
    && ['infused', 'live resin', 'rosin', 'hash hole'].some((token) => lowered.includes(token))
  const subcategory = isInfused ? 'Infused' : ''

  // Strain = the name with every descriptor token removed.
  let strain = name
    .replace(/\b\d+\s*(?:pack|pk)\b/gi, '')
    .replace(/pre[\s-]?rolls?/gi, '')
    .replace(/\buninfused\b/gi, '')
    .replace(/\binfused\b/gi, '')
    .replace(/\blive\s+resin\b/gi, '')
    .replace(/\brosin\b/gi, '')
    .replace(/(?<![\d.])\d*\.?\d+\s*g\b/gi, '')
    .replace(/[-–—]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  strain = cleanCultivar(strain)
  if (strain.length === 0) {
    throw new Error(`Unhandled Canna Cure product name (empty strain): ${rawName}`)
  }

  const variantTab = packCount > 1 ? `${packCount}x ${size}` : size
  const variantName = packCount > 1 ? `${brand} ${strain} ${variantTab}` : `${brand} ${strain} ${size}`

  return normalizeAndValidateParsedProductName(
    {
      brand,
      category: 'Pre-Rolls',
      groupName: strain,
      packCount,
      prevalence: derivePrevalence(name),
      searchTerm: strain,
      size,
      strainName: strain,
      subcategory,
      variantName,
      variantTab,
    },
    rawName,
  )
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
    // Edibles gummies have no subcategory in our Sweed taxonomy —
    // there is no enabled "Chews/Gummies" subcategory under Edibles.
    subcategory: '',
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

/**
 * TTM (Terps to Mountains / "TTM") names ship as
 *   `TTM - <Category> - <Format> - [Lineage] - <Size> - <Strain(s)>`
 *
 * Examples this parser handles:
 *   - "TTM - Flower - Packaged - Flight - 3.0g - Cyber Diesel x Peanut Butter N Jealousy x Skywalker"
 *     → brand=TTM, category=Flower, groupName="Flight: Cyber Diesel × Peanut Butter N Jealousy × Skywalker",
 *       strainName same, size="3g", variantTab="3g"
 *   - "TTM - Flower - Packaged - 3.5g - Pineapple Express"
 *     → brand=TTM, category=Flower, groupName="Pineapple Express", size="3.5g"
 *   - "TTM - Pre-Roll - 1g - Sour Diesel"
 *     → brand=TTM, category=Pre-Rolls, groupName="Sour Diesel"
 *
 * `Flight` is TTM's multi-strain bundle line: when present, the trailing
 * strain segment may contain ` x ` separators that join multiple
 * cultivars in one pack. Normalize those to ` × ` (Unicode multiplication
 * sign) for display so the reviewer can tell at a glance this is a
 * blended-strain pack rather than a strain literally named "x".
 */
function parseTtmName(name: string): ParsedProductName {
  const parts = name.split(/\s*-\s*/).map((part) => part.trim()).filter((part) => part.length > 0)
  if (parts.length < 4 || !/^ttm$/i.test(parts[0])) {
    throw new Error(`Unhandled TTM product name: ${name}`)
  }

  const rawCategory = parts[1].toLowerCase()
  let category: string
  if (rawCategory === 'flower') {
    category = 'Flower'
  } else if (rawCategory === 'pre-roll' || rawCategory === 'preroll' || rawCategory === 'pre-rolls') {
    category = 'Pre-Rolls'
  } else if (rawCategory === 'vape' || rawCategory === 'vapes') {
    category = 'Vapes'
  } else {
    throw new Error(`Unhandled TTM category "${parts[1]}" in: ${name}`)
  }

  // Find the size token — the FIRST part (after position 1) that looks
  // like an explicit weight/dose. Anything before it (between category
  // and size) is treated as format/lineage qualifiers; anything after
  // it is the strain (possibly multi-strain).
  const sizeIndex = parts.findIndex((part, index) => index >= 2 && /^\.?\d+(?:\.\d+)?\s*(?:g|mg)$/i.test(part))
  if (sizeIndex < 0 || sizeIndex >= parts.length - 1) {
    throw new Error(`Unhandled TTM product name (no size token / no trailing strain): ${name}`)
  }
  const sizeText = parts[sizeIndex]
  const size = normalizeSizeText(sizeText) ?? sizeText
  const qualifiers = parts.slice(2, sizeIndex).map((q) => q.trim()).filter((q) => q.length > 0)
  const strainSegment = parts.slice(sizeIndex + 1).join(' - ').trim()

  // Multi-strain "Flight": replace ` x ` (lowercase, whitespace-bounded)
  // with the proper multiplication sign so display reads cleanly. Don't
  // touch capital X or strain-internal "x" tokens (e.g. "TenX").
  const normalizedStrain = strainSegment
    .replace(/\s+[x×]\s+/g, ' × ')
    .replace(/\s{2,}/g, ' ')
    .trim()
  if (normalizedStrain.length === 0) {
    throw new Error(`Unhandled TTM product name (empty strain segment): ${name}`)
  }
  const isFlight = qualifiers.some((q) => /^flight$/i.test(q))

  const groupName = isFlight ? `Flight: ${normalizedStrain}` : normalizedStrain
  const packCount = 1
  const variantTab = size
  const variantName = category === 'Flower'
    ? size
    : `TTM ${groupName} ${size}`
  // Flower's strainName is the strain itself; treat the joined multi-
  // strain string as a single strainName for downstream catalog use.
  const strainName = category === 'Flower' || category === 'Pre-Rolls' ? normalizedStrain : ''

  return {
    brand: 'TTM',
    category,
    groupName,
    packCount,
    prevalence: derivePrevalence(name),
    searchTerm: normalizedStrain,
    size,
    strainName,
    subcategory: '',
    variantName,
    variantTab,
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
  return callSharedSweedRpc<TResult>(dealerId, name, params)
}

async function readCurrentDealerContext(dealerId: number): Promise<Record<string, unknown>> {
  const context = await readSweedDealerContext(dealerId)
  return {
    dealerId: context.dealerId,
    dealerName: context.dealerName ?? `dealer ${context.dealerId}`,
  }
}

async function ensureDealerContext(dealerId: number): Promise<void> {
  await ensureSharedDealerContext(dealerId)
}
