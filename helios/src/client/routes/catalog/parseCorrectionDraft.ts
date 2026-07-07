// Pure form-state → API-payload logic for the parse-correction drawer
// (issue #59, task T4). Kept UI-free so it can be unit-tested without a DOM.
//
// Cardinal rule (see automation#59 + Oracle design review): the feedback store
// is INERT. This module only shapes what the operator explicitly selected into
// the T3 create body — it never re-parses a listing, never guesses fields the
// operator didn't confirm, and nothing here feeds production scoring/matching.
//
// The "what's wrong?" issue chips gate which correction fields are meaningful:
// a field is sent ONLY when its owning chip is selected AND the operator gave a
// valid value. Prefill/stale hidden state must never leak into the payload.

import type {
  BrandFamilyMarketMatchResponse,
  BrandFamilyMatchCandidate,
  ConventionPatternChip,
  ConventionProposalDetails,
  ConventionScope,
  CreateParseFeedbackBody,
  ListingCorrectionDetails,
  ParseFeedbackIssueType,
} from '../../../shared/contracts/index.js'

/** Which correction chips reveal structured fields (vs. pure dispositions). */
export const STRUCTURED_ISSUE_TYPES: readonly ParseFeedbackIssueType[] = [
  'size',
  'pack_qty',
  'category_subcategory',
  'brand',
  'name_tokens_strain',
]

/** Dispositions carry no structured correction — an issue type (+ optional note). */
export const DISPOSITION_ISSUE_TYPES: readonly ParseFeedbackIssueType[] = ['price_genuine', 'no_match']

/** Raw (string-backed) correction form state; numbers stay strings until built. */
export interface CorrectionDraft {
  issueTypes: readonly ParseFeedbackIssueType[]
  packCount: string
  unitSizeValue: string
  unitSizeUnit: string
  totalSizeValue: string
  totalSizeUnit: string
  category: string
  subcategory: string
  brand: string
  strain: string
  nameTokens: string
  note: string
}

/** Raw convention-proposal form state (the opt-in second half of a save). */
export interface ConventionDraft {
  enabled: boolean
  scope: ConventionScope
  note: string
  patternChips: readonly ConventionPatternChip[]
}

export function emptyCorrectionDraft(): CorrectionDraft {
  return {
    issueTypes: [],
    packCount: '',
    unitSizeValue: '',
    unitSizeUnit: '',
    totalSizeValue: '',
    totalSizeUnit: '',
    category: '',
    subcategory: '',
    brand: '',
    strain: '',
    nameTokens: '',
    note: '',
  }
}

/**
 * Default convention scope. Retailer-scoped proposals are weak/non-promotable
 * without a STABLE retailer id (the promotion export is retailer-id scoped), so
 * a listing lacking `retailerId` can only propose a listing-only convention.
 */
export function defaultConventionScope(retailerId: number | null): ConventionScope {
  return retailerId == null ? 'listing_only' : 'retailer_category'
}

export function emptyConventionDraft(retailerId: number | null): ConventionDraft {
  return { enabled: false, scope: defaultConventionScope(retailerId), note: '', patternChips: [] }
}

/** Convention scopes selectable given retailer identity (retailer-scoped need an id). */
export function conventionScopeOptions(
  retailerId: number | null,
): readonly { value: ConventionScope; label: string; disabled: boolean }[] {
  const hasRetailer = retailerId != null
  return [
    { value: 'retailer_category', label: 'This retailer + category/subcategory', disabled: !hasRetailer },
    { value: 'retailer_wide', label: 'This retailer (whole catalog)', disabled: !hasRetailer },
    { value: 'retailer_brand', label: 'This retailer + brand', disabled: !hasRetailer },
    { value: 'listing_only', label: 'This listing only', disabled: false },
  ]
}

function trimOrEmpty(s: string): string {
  return s.trim()
}

/** A finite positive number parsed from an input string, else null. */
function positiveNumber(raw: string): number | null {
  const t = raw.trim()
  if (t.length === 0) return null
  const n = Number(t)
  return Number.isFinite(n) && n > 0 ? n : null
}

/** A positive integer parsed from an input string, else null. */
function positiveInt(raw: string): number | null {
  const n = positiveNumber(raw)
  return n != null && Number.isInteger(n) ? n : null
}

/** A bounded short unit label (mirrors the contract's ShortUnit bound), else null. */
function shortUnit(raw: string): string | null {
  const t = raw.trim()
  return t.length >= 1 && t.length <= 16 ? t : null
}

/** True when the operator supplied a valid unit-size pair (value + unit). */
function hasUnitSize(d: CorrectionDraft): boolean {
  return positiveNumber(d.unitSizeValue) != null && shortUnit(d.unitSizeUnit) != null
}

/** True when the operator supplied a valid total-size pair (value + unit). */
function hasTotalSize(d: CorrectionDraft): boolean {
  return positiveNumber(d.totalSizeValue) != null && shortUnit(d.totalSizeUnit) != null
}

/**
 * Whether a selected structured chip contributes at least one valid field. A
 * structured chip selected with no valid field is junk and blocks the save.
 */
export function structuredChipHasValue(issue: ParseFeedbackIssueType, d: CorrectionDraft): boolean {
  switch (issue) {
    case 'size':
      return hasUnitSize(d) || hasTotalSize(d)
    case 'pack_qty':
      return positiveInt(d.packCount) != null
    case 'category_subcategory':
      return trimOrEmpty(d.category).length > 0 || trimOrEmpty(d.subcategory).length > 0
    case 'brand':
      return trimOrEmpty(d.brand).length > 0
    case 'name_tokens_strain':
      return trimOrEmpty(d.strain).length > 0 || trimOrEmpty(d.nameTokens).length > 0
    case 'price_genuine':
    case 'no_match':
      return false
  }
}

/** Convention is "ready" to attach only when it carries a note or a pattern chip. */
export function conventionReady(c: ConventionDraft): boolean {
  return !c.enabled || trimOrEmpty(c.note).length > 0 || c.patternChips.length > 0
}

/**
 * A save is valid iff at least one issue chip is selected, EVERY selected
 * structured chip has a valid field (no junk rows), and an enabled convention
 * is non-empty. Dispositions (`price_genuine` / `no_match`) are valid alone.
 */
export function canSave(d: CorrectionDraft, c: ConventionDraft): boolean {
  if (d.issueTypes.length === 0) return false
  for (const issue of d.issueTypes) {
    if (STRUCTURED_ISSUE_TYPES.includes(issue) && !structuredChipHasValue(issue, d)) return false
  }
  return conventionReady(c)
}

/**
 * Build the listing-correction details, sending a field ONLY when its owning
 * chip is selected and the value is valid. Everything else is null so hidden or
 * stale prefill can never leak into the persisted correction.
 */
export function buildListingCorrectionDetails(d: CorrectionDraft): ListingCorrectionDetails {
  const selected = new Set(d.issueTypes)
  const sizeOn = selected.has('size')
  const packOn = selected.has('pack_qty')
  const catOn = selected.has('category_subcategory')
  const brandOn = selected.has('brand')
  const nameOn = selected.has('name_tokens_strain')

  const unitOk = sizeOn && hasUnitSize(d)
  const totalOk = sizeOn && hasTotalSize(d)

  const note = trimOrEmpty(d.note)

  return {
    issueTypes: [...d.issueTypes],
    packCount: packOn ? positiveInt(d.packCount) : null,
    unitSizeValue: unitOk ? positiveNumber(d.unitSizeValue) : null,
    unitSizeUnit: unitOk ? shortUnit(d.unitSizeUnit) : null,
    totalSizeValue: totalOk ? positiveNumber(d.totalSizeValue) : null,
    totalSizeUnit: totalOk ? shortUnit(d.totalSizeUnit) : null,
    category: catOn ? nullIfEmpty(d.category) : null,
    subcategory: catOn ? nullIfEmpty(d.subcategory) : null,
    brand: brandOn ? nullIfEmpty(d.brand) : null,
    strain: nameOn ? nullIfEmpty(d.strain) : null,
    nameTokens: nameOn ? nullIfEmpty(d.nameTokens) : null,
    note: note.length > 0 ? note : null,
  }
}

function nullIfEmpty(s: string): string | null {
  const t = s.trim()
  return t.length > 0 ? t : null
}

/** Scope refiners (category/subcategory/brand) implied by the convention scope. */
export function conventionRefiners(
  scope: ConventionScope,
  data: BrandFamilyMarketMatchResponse,
): { category: string | null; subcategory: string | null; brand: string | null } {
  switch (scope) {
    case 'retailer_category':
      return { category: data.categoryName, subcategory: data.subcategoryName, brand: null }
    case 'retailer_brand':
      return { category: null, subcategory: null, brand: data.brandName }
    case 'retailer_wide':
      return { category: null, subcategory: null, brand: null }
    case 'listing_only':
      return { category: data.categoryName, subcategory: data.subcategoryName, brand: data.brandName }
  }
}

/**
 * Build the convention-proposal details, or null when not enabled / not ready.
 * The auto example is the corrected listing's raw name (operator-visible, never
 * re-parsed). The operator NEVER authors parsekit JSON/regex.
 */
export function buildConventionProposalDetails(
  c: ConventionDraft,
  candidate: BrandFamilyMatchCandidate,
  data: BrandFamilyMarketMatchResponse,
): ConventionProposalDetails | null {
  if (!c.enabled || !conventionReady(c)) return null
  const refiners = conventionRefiners(c.scope, data)
  const example = (candidate.listingName ?? '').trim()
  return {
    scope: c.scope,
    note: trimOrEmpty(c.note),
    examples: example.length > 0 ? [example.slice(0, 500)] : [],
    patternChips: [...c.patternChips],
    category: refiners.category,
    subcategory: refiners.subcategory,
    brand: refiners.brand,
  }
}

/**
 * Assemble the full POST body for one drawer save: a listing correction and an
 * OPTIONAL convention proposal. Provenance (source listing id / retailer id /
 * raw name / hash / snapshot) is derived SERVER-SIDE from `fuzzySkuId` — never
 * trusted from the browser — so it is deliberately absent here.
 */
export function buildCreateBody(
  candidate: BrandFamilyMatchCandidate,
  data: BrandFamilyMarketMatchResponse,
  d: CorrectionDraft,
  c: ConventionDraft,
): CreateParseFeedbackBody {
  const conventionDetails = buildConventionProposalDetails(c, candidate, data)
  return {
    listingCorrection: {
      fuzzySkuId: candidate.fuzzySkuId,
      familyKey: data.familyKey,
      brandKey: data.brandKey,
      matchedCatalogProductId: candidate.matchedCatalogProductId,
      details: buildListingCorrectionDetails(d),
    },
    ...(conventionDetails != null ? { conventionProposal: { details: conventionDetails } } : {}),
  }
}

/**
 * The bounded, de-duplicated set of fuzzy_sku ids to fetch existing feedback
 * for: the union of the displayed candidates and the (pre-display-cap) review
 * candidates. Capped at the contract limit so a bad response can never blow the
 * bounded GET.
 */
export function feedbackFetchIds(data: BrandFamilyMarketMatchResponse, limit: number): number[] {
  const ids = new Set<number>()
  for (const c of data.candidates) ids.add(c.fuzzySkuId)
  for (const c of data.reviewCandidates) ids.add(c.fuzzySkuId)
  return [...ids].slice(0, limit)
}
