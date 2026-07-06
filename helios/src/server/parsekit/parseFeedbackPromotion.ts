/**
 * Promotion export mapper (issue #59, task T5).
 *
 * Pure, deterministic transform from the INERT operator parse-correction
 * feedback inbox into agent/reviewer-facing promotion material: corrections
 * grouped by the parsekit tenant they resolve to, each carrying a best-effort
 * projection of the operator's corrected fields plus — when (and only when) that
 * projection forms a full, valid LitAlerts descriptor — a ready-to-paste
 * parsekit golden.
 *
 * This does NOT write a parser config (no web-side git writes) and does NOT join
 * the production scorer / market-match read path. It is a report shape only; the
 * agent still authors the `helios-parser-configs` entry by hand.
 *
 * No I/O, no Date.now(), no randomness — golden ids derive from the feedback
 * UUID so the export is reproducible.
 */

import {
  type ConventionProposalFeedbackRecord,
  type ListingCorrectionDetails,
  type ListingCorrectionFeedbackRecord,
  type ParseFeedbackRecord,
  type PromotionBestEffortExpected,
  type PromotionExportConvention,
  type PromotionExportCorrection,
  type PromotionExportTenantGroup,
  type PromotionParsekitGolden,
} from '../../shared/contracts/index.js'
import {
  FuzzyVariantCategorySchema,
  FuzzyVariantSizeUnitSchema,
  litalertsContract,
  type FuzzyVariantCategory,
  type FuzzyVariantSizeUnit,
} from '../../lib/parsekit/contracts/litalerts.js'
import { dispensaryToTenantId } from './litalertsLookup.js'

const USE_CASE = 'litalerts'

/** Common operator spellings → parsekit size units (`g | mg | mL | ea`). */
const UNIT_ALIASES: Record<string, FuzzyVariantSizeUnit> = {
  g: 'g',
  gram: 'g',
  grams: 'g',
  mg: 'mg',
  milligram: 'mg',
  milligrams: 'mg',
  ml: 'mL',
  milliliter: 'mL',
  milliliters: 'mL',
  millilitre: 'mL',
  millilitres: 'mL',
  ea: 'ea',
  each: 'ea',
  unit: 'ea',
  units: 'ea',
  ct: 'ea',
  count: 'ea',
}

/** Common operator spellings → parsekit categories. */
const CATEGORY_ALIASES: Record<string, FuzzyVariantCategory> = {
  'pre-roll': 'preroll',
  'pre-rolls': 'preroll',
  prerolls: 'preroll',
  flowers: 'flower',
  vapes: 'vape',
  cartridge: 'vape',
  cartridges: 'vape',
  vapecartridge: 'vape',
  edibles: 'edible',
  concentrates: 'concentrate',
  tinctures: 'tincture',
  topicals: 'topical',
  accessories: 'accessory',
  beverages: 'beverage',
}

function normalizeUnit(raw: string | null): FuzzyVariantSizeUnit | null {
  if (raw === null) return null
  const key = raw.trim().toLowerCase()
  if (key.length === 0) return null
  const alias = UNIT_ALIASES[key]
  if (alias) return alias
  const direct = FuzzyVariantSizeUnitSchema.safeParse(raw.trim())
  return direct.success ? direct.data : null
}

function normalizeCategory(raw: string | null): FuzzyVariantCategory | null {
  if (raw === null) return null
  const key = raw.trim().toLowerCase().replace(/\s+/g, '')
  if (key.length === 0) return null
  const alias = CATEGORY_ALIASES[key]
  if (alias) return alias
  const direct = FuzzyVariantCategorySchema.safeParse(key)
  return direct.success ? direct.data : null
}

function trimToNull(value: string | null): string | null {
  if (value === null) return null
  const t = value.trim()
  return t.length === 0 ? null : t
}

function snapshotString(
  snapshot: Record<string, unknown> | null,
  key: string,
): string | null {
  if (snapshot === null) return null
  const v = snapshot[key]
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null
}

/** Best-effort projection of the operator's fields into parsekit's shape. */
function buildBestEffortExpected(details: ListingCorrectionDetails): PromotionBestEffortExpected {
  const unitSize =
    details.unitSizeValue !== null && details.unitSizeUnit !== null
      ? { value: details.unitSizeValue, unit: details.unitSizeUnit }
      : null
  const totalSize =
    details.totalSizeValue !== null && details.totalSizeUnit !== null
      ? { value: details.totalSizeValue, unit: details.totalSizeUnit }
      : null
  return {
    brand: trimToNull(details.brand),
    productLine: null,
    variantName: trimToNull(details.strain) ?? trimToNull(details.nameTokens),
    category: trimToNull(details.category),
    packCount: details.packCount,
    unitSize,
    totalSize,
    prevalence: null,
    searchTerm: null,
  }
}

/**
 * Try to build a full, valid parsekit golden from a correction. Returns the
 * golden plus an empty issues list on success, or `null` + human-readable
 * reasons when the corrected fields can't form a complete valid descriptor.
 */
function buildParsekitGolden(
  correction: ListingCorrectionFeedbackRecord,
  tenantId: string,
): { golden: PromotionParsekitGolden | null; issues: string[] } {
  const issues: string[] = []
  const details = correction.details

  const input = trimToNull(correction.rawListingName)
  if (input === null) {
    issues.push('no raw listing name to use as the golden input')
  }

  const brand = trimToNull(details.brand)
  if (brand === null) issues.push('missing corrected brand')

  const category = normalizeCategory(details.category)
  if (details.category === null) {
    issues.push('missing corrected category')
  } else if (category === null) {
    issues.push(`category "${details.category}" is not a parsekit category`)
  }

  const unitValue = details.unitSizeValue
  const unitUnit = normalizeUnit(details.unitSizeUnit)
  if (unitValue === null || details.unitSizeUnit === null) {
    issues.push('missing corrected unit size (value + unit)')
  } else if (unitUnit === null) {
    issues.push(`unit "${details.unitSizeUnit}" is not a parsekit size unit`)
  }

  // totalSize: prefer the corrected total; for a single unit fall back to the
  // unit size so a common "one item" listing still yields a complete golden.
  let totalValue = details.totalSizeValue
  let totalUnit = normalizeUnit(details.totalSizeUnit)
  if (
    totalValue === null &&
    details.totalSizeUnit === null &&
    (details.packCount === null || details.packCount === 1) &&
    unitValue !== null &&
    unitUnit !== null
  ) {
    totalValue = unitValue
    totalUnit = unitUnit
  }
  if (totalValue === null) {
    issues.push('missing corrected total size (value + unit)')
  } else if (totalUnit === null && details.totalSizeUnit !== null) {
    issues.push(`total size unit "${details.totalSizeUnit}" is not a parsekit size unit`)
  } else if (totalUnit === null) {
    issues.push('missing corrected total size unit')
  }

  if (issues.length > 0) return { golden: null, issues }

  const candidate = {
    brand,
    productLine: null,
    variantName: trimToNull(details.strain) ?? trimToNull(details.nameTokens),
    category,
    packCount: details.packCount ?? 1,
    unitSize: { value: unitValue, unit: unitUnit },
    totalSize: { value: totalValue, unit: totalUnit },
    prevalence: null,
    searchTerm: null,
  }

  const parsed = litalertsContract.outputSchema.safeParse(candidate)
  if (!parsed.success) {
    for (const err of parsed.error.issues) {
      issues.push(`${err.path.join('.') || '(root)'}: ${err.message}`)
    }
    return { golden: null, issues }
  }
  const semantic = litalertsContract.semanticValidate(parsed.data)
  if (semantic.length > 0) {
    for (const s of semantic) issues.push(`${s.path}: ${s.message}`)
    return { golden: null, issues }
  }

  return {
    golden: {
      kind: 'match',
      id: `${tenantId}.${correction.id}`,
      input: input as string,
      expected: parsed.data,
    },
    issues: [],
  }
}

function toExportConvention(rec: ConventionProposalFeedbackRecord): PromotionExportConvention {
  return {
    id: rec.id,
    status: rec.status,
    details: rec.details,
    createdAt: rec.createdAt,
  }
}

function toExportCorrection(
  correction: ListingCorrectionFeedbackRecord,
  tenantId: string,
  conventions: ParseFeedbackRecord[],
): PromotionExportCorrection {
  const { golden, issues } = buildParsekitGolden(correction, tenantId)
  return {
    feedbackId: correction.id,
    status: correction.status,
    sourceListingId: correction.sourceListingId,
    fuzzySkuId: correction.fuzzySkuId,
    rawListingName: correction.rawListingName,
    inputSnapshot: correction.inputSnapshot,
    familyKey: correction.familyKey,
    brandKey: correction.brandKey,
    matchedCatalogProductId: correction.matchedCatalogProductId,
    rawCorrection: correction.details,
    bestEffortExpected: buildBestEffortExpected(correction.details),
    parsekitGolden: golden,
    issues,
    conventionProposals: conventions
      .filter(
        (c): c is ConventionProposalFeedbackRecord => c.kind === 'convention_proposal',
      )
      .map(toExportConvention),
  }
}

/**
 * Group retailer-scoped listing corrections by the parsekit tenant they resolve
 * to (derived from the raw listing's `dispensaryName`). Groups are ordered by
 * tenant id; corrections keep the incoming (created_at desc, id) order.
 */
export function buildPromotionExportGroups(
  retailerId: number,
  corrections: ParseFeedbackRecord[],
  conventionsByCorrectionId: Map<string, ParseFeedbackRecord[]>,
): { groups: PromotionExportTenantGroup[]; totalCorrections: number } {
  interface Bucket {
    tenantId: string
    dispensaryName: string | null
    corrections: PromotionExportCorrection[]
  }
  const buckets = new Map<string, Bucket>()
  let totalCorrections = 0

  for (const record of corrections) {
    if (record.kind !== 'listing_correction') continue
    totalCorrections += 1
    const dispensaryName = snapshotString(record.inputSnapshot, 'dispensaryName')
    const slug = dispensaryName === null ? '' : dispensaryToTenantId(dispensaryName)
    // Blank/unslugifiable dispensary name → a stable per-retailer fallback so
    // the agent still sees the work (and that the tenant needs identifying).
    const tenantId = slug.length > 0 ? slug : `retailer-${retailerId}`

    let bucket = buckets.get(tenantId)
    if (!bucket) {
      bucket = { tenantId, dispensaryName, corrections: [] }
      buckets.set(tenantId, bucket)
    } else if (bucket.dispensaryName === null && dispensaryName !== null) {
      bucket.dispensaryName = dispensaryName
    }
    bucket.corrections.push(
      toExportCorrection(record, tenantId, conventionsByCorrectionId.get(record.id) ?? []),
    )
  }

  const groups: PromotionExportTenantGroup[] = Array.from(buckets.values())
    .sort((a, b) => (a.tenantId < b.tenantId ? -1 : a.tenantId > b.tenantId ? 1 : 0))
    .map((b) => ({
      tenantId: b.tenantId,
      parserId: `${USE_CASE}.${b.tenantId}`,
      configPath: `use-cases/${USE_CASE}/parsers/${b.tenantId}.jsonc`,
      dispensaryName: b.dispensaryName,
      useCase: USE_CASE,
      corrections: b.corrections,
    }))

  return { groups, totalCorrections }
}
