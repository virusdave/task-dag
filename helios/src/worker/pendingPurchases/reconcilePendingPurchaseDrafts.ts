// Deterministic validator / reconciler — the pending-purchase safety layer
// (child FreshlyBakedNYC/automation#54, task C5, parent virusdave/top-level#33).
//
// C4 (classifyPendingPurchasePacket.ts) is a PROBABILISTIC PROPOSER: an LLM
// emits one draft per distributor line item, possibly proposing a reuse link to
// an existing live product. C5 is the DETERMINISTIC GATE that decides whether a
// model proposal ever becomes the authoritative `reuseProductId` the apply job
// trusts and writes to the regulated Sweed catalog. Nothing probabilistic
// reaches a catalog write without surviving this module.
//
// This module is a PURE function: no DB, no network, no clock. It takes the C4
// drafts plus the EXACT context the model saw (the authoritative input rows, the
// attribute-bearing live catalog candidates, the allowed taxonomy) and returns
// one reconciled classification per input row. C8 wires C4 → C5 into the
// generate job and composes deterministic pricing/market evidence separately
// (the final price of a new SKU is the post-receive quarantine→reprice→release
// lifecycle, not anything C5 computes — see the design doc supersession note).
//
// Safety posture (mirrors C4's fail-loud boundary discipline):
//   - Identity is bound by `rowKey` ONLY; distributor identity/cost are copied
//     from the authoritative input rows, never from the model echo.
//   - A reuse candidate is promoted to a non-null `reuseProductId` ONLY when it
//     is independently anchored — by an existing distributor link (a DB fact) or
//     a row-scoped Sweed suggestion that also matches on every attribute lane.
//     A model that merely "found it in the candidate list" (live-catalog-search)
//     or asserts it (model-inference) is SUGGESTION-ONLY: it can never
//     self-certify a link by copying the candidate's own attributes into its
//     target fields.
//   - A live existing distributor link is never silently turned into a duplicate
//     catalog-create.
//   - A catalog-create whose identity already exists live is downgraded to
//     needs-review (never a confident duplicate).
//   - Prohibited house brands, invalid taxonomy, and structurally illegal NY
//     edibles are guarded deterministically.
//   - Internal-corruption inputs (missing/extra/duplicate drafts, conflicting
//     duplicate candidates) THROW; semantic/model uncertainty DOWNGRADES the
//     affected row to a safe non-reuse state.
//
// Satisfies: virusdave/top-level#33

import type {
  PendingPurchaseLlmClassifierResult,
  PendingPurchaseLlmDraftRow,
  PendingPurchaseMappingStatus,
  PendingPurchaseProposedAction,
} from '../../shared/contracts/index.js'
import type {
  ClassifierAllowedTaxonomy,
  ClassifierRowInput,
} from './classifyPendingPurchasePacket.js'

// Bump when the reconciler's SEMANTICS change (recorded on the result for
// audit/replay alongside the classifier's model + promptVersion).
export const PENDING_PURCHASE_RECONCILER_VERSION = '2026-06-21-deterministic-validator-v1'

// ── input contract ───────────────────────────────────────────────────────

/**
 * One live product the validator may confirm a reuse link onto. Richer than the
 * classifier's `ClassifierCatalogCandidate`: C5 additionally needs `groupId`
 * (to set `reuseGroupId`) and `enabled` (to refuse retired/disabled products),
 * which the model never sees. C8 builds these from the catalog cache.
 */
export interface ReconcilerCatalogCandidate {
  readonly productId: number
  readonly productName: string
  readonly groupId: number | null
  readonly brand: string | null
  readonly category: string | null
  readonly subcategory: string | null
  readonly groupName: string | null
  readonly variantTab: string | null
  readonly strain: string | null
  readonly size: string | null
  readonly packCount: number | null
  // Sweed `enabled` flag. Absent is treated as enabled; a name flagged
  // DEAD/RETIRED/DELETED is treated as retired regardless (operator
  // convention, see helios/AGENTS.md).
  readonly enabled?: boolean
}

export interface ReconcilePendingPurchaseDraftsInput {
  // The C4 classifier output (drafts + provenance). Drafts have already passed
  // the C4 output schema; C5 re-validates the SEMANTICS, not the shape.
  readonly classifierResult: PendingPurchaseLlmClassifierResult
  // The authoritative input rows handed to C4 — the single source of truth for
  // distributor identity, cost, the current distributor link, and the row-scoped
  // Sweed suggestions. Reconciliation copies identity from here, never the draft.
  readonly rows: readonly ClassifierRowInput[]
  // The attribute-bearing live catalog products — the validation universe for
  // reuse promotion and duplicate detection.
  readonly catalogCandidates: readonly ReconcilerCatalogCandidate[]
  readonly allowedTaxonomy: ClassifierAllowedTaxonomy
}

// ── output contract ────────────────────────────────────────────────────────

/**
 * A frozen snapshot of the live product a confirmed reuse link points at, taken
 * at validation time. Stored on the row so the C7 apply-time drift guard can
 * detect a product that changed identity between generation and apply. Pure: no
 * timestamp (the persistence layer records when).
 */
export interface ReconciledReuseSnapshot {
  readonly productId: number
  readonly productName: string
  readonly groupId: number | null
  readonly brand: string | null
  readonly category: string | null
  readonly subcategory: string | null
  readonly groupName: string | null
  readonly variantTab: string | null
  readonly strain: string | null
  readonly size: string | null
  readonly packCount: number | null
}

/**
 * A reuse/duplicate candidate surfaced for the reviewer to pick via the existing
 * `targetReuseProductId` override. `score` is null for deterministically
 * surfaced candidates (C5 does not rank).
 */
export interface ReconciledSuggestionCandidate {
  readonly productId: number
  readonly productName: string | null
  readonly score: number | null
}

export interface ReconciledPendingPurchaseClassification {
  // Identity copied from the authoritative input row (never the model echo).
  readonly rowKey: string
  readonly distributorProductId: string
  readonly distributorProductName: string

  // Final, deterministic action. `mapping-only` ⟺ reuseProductId !== null.
  readonly actionType: PendingPurchaseProposedAction
  readonly catalogAction: string
  // Convenience mirror of the server's deriveMappingStatus(actionType); the
  // persisted mapping_status is still derived from actionType, not from this.
  readonly mappingStatus: PendingPurchaseMappingStatus

  // Validated, normalized taxonomy. When a reuse link is confirmed these are
  // adopted from the candidate snapshot (idempotent apply, clean drift baseline);
  // otherwise they carry the model's normalized targets.
  readonly targetBrand: string | null
  readonly targetCategory: string | null
  readonly targetSubcategory: string | null
  readonly targetGroupName: string | null
  readonly targetVariantName: string | null
  readonly targetVariantTab: string | null
  readonly targetStrainName: string | null
  readonly targetSize: string | null
  readonly targetPackCount: number | null

  // Authoritative reuse — non-null ONLY when it survived deterministic
  // validation. `validatedReuseSnapshot` is non-null iff `reuseProductId` is.
  readonly reuseProductId: number | null
  readonly reuseProductName: string | null
  readonly reuseGroupId: number | null
  readonly validatedReuseSnapshot: ReconciledReuseSnapshot | null

  readonly suggestionCandidates: readonly ReconciledSuggestionCandidate[]
  readonly reviewFlags: readonly string[]
  readonly notes: string | null

  // Passthrough model provenance (audit/review only; never trusted for safety).
  readonly confidence: number
  readonly rationale: string
  readonly citedHintIds: readonly string[]
  readonly warningFlags: readonly string[]
}

export interface ReconcilePendingPurchaseDraftsResult {
  readonly schemaVersion: number
  readonly model: string
  readonly promptVersion: string
  readonly reconcilerVersion: string
  readonly classifications: readonly ReconciledPendingPurchaseClassification[]
}

// ── errors ─────────────────────────────────────────────────────────────────

/** Internal-corruption / contract-violation error. Aborts the whole pass. */
export class PendingPurchaseReconcilerError extends Error {}

// ── prohibited house brands ──────────────────────────────────────────────────

// The receiving retailer's own house brand can never appear on a METRC
// distributor invoice; a model proposing it is hallucinating. Keys are stripped
// to alphanumerics so spacing/punctuation variants all collapse. This is the
// canonical home for the guard once the legacy classifier is deleted at C8.
const PROHIBITED_HOUSE_BRAND_KEYS: ReadonlySet<string> = new Set([
  'freshlybakednyc',
  'freshlybakedny',
  'freshlybaked',
  'fbnyc',
  'fbn',
])

function houseBrandKey(value: string | null): string {
  return (value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
}

function isProhibitedHouseBrand(brand: string | null): boolean {
  const key = houseBrandKey(brand)
  return key.length > 0 && PROHIBITED_HOUSE_BRAND_KEYS.has(key)
}

// ── normalization helpers ────────────────────────────────────────────────────

/** Trim to a non-empty string or null. */
function nullableTrim(value: string | null): string | null {
  if (value === null) return null
  const trimmed = value.trim()
  return trimmed.length === 0 ? null : trimmed
}

/** Lane-equality key: lowercase + whitespace-collapsed. No punctuation
 * stripping — false negatives are safe here, false positives are not.
 *
 * Exported because the C7 apply-time drift guard
 * (`reuseDriftGuard.ts`) compares a frozen {@link ReconciledReuseSnapshot}
 * against the live product at apply time and MUST use the exact same
 * equality semantics as this validator — otherwise a purely-cosmetic
 * case/whitespace difference between the catalog-cache snapshot and the
 * apply-time RPC read would be a false drift. One source of truth. */
export function laneKey(value: string | null): string | null {
  const trimmed = nullableTrim(value)
  return trimmed === null ? null : trimmed.toLowerCase().replace(/\s+/g, ' ')
}

/** Size-equivalence key: lowercase, all whitespace removed, so "3.5 g" === "3.5g".
 * Exported for the C7 drift guard for the same single-source-of-truth reason
 * as {@link laneKey}. */
export function sizeKey(value: string | null): string | null {
  const trimmed = nullableTrim(value)
  return trimmed === null ? null : trimmed.toLowerCase().replace(/\s+/g, '')
}

/** Operator soft-retire convention: name renamed to start with DEAD/RETIRED/DELETED. */
function isRetiredName(name: string | null): boolean {
  return /^(?:dead\s*-|dead-|deleted|retired)/i.test((name ?? '').trim())
}

function isLiveCandidate(candidate: ReconcilerCatalogCandidate): boolean {
  if (candidate.enabled === false) return false
  if (isRetiredName(candidate.productName)) return false
  if (isRetiredName(candidate.groupName)) return false
  if (isRetiredName(candidate.brand)) return false
  return true
}

// ── NY edible compliance (ported from the legacy classifier) ─────────────────
//
// NY adult-use rule: an edible package can never exceed 100 mg total THC and a
// single piece can never exceed 10 mg. A "100mg 1pk" variant is structurally
// illegal and must be split into pieces. This is pure deterministic shape safety
// (a regulatory guard), so it lives in C5, not in pricing/C8.

const NY_EDIBLE_CANONICAL_PER_PIECE_MG = 10
const NY_EDIBLE_PACKAGE_CAP_MG = 100
const NY_EDIBLE_TOTAL_SIZE_REGEX = /^\s*(\d+(?:\.\d+)?)\s*mg\s*$/i

interface NyEdibleSplit {
  readonly packCount: number
  readonly size: string
  readonly variantTab: string
  readonly note: string
  readonly reviewFlag: string
  readonly illegal: boolean
}

function maybeNyEdibleSplit(input: {
  category: string | null
  packCount: number | null
  size: string | null
  variantTab: string | null
}): NyEdibleSplit | null {
  if ((input.category ?? '').toLowerCase() !== 'edibles') return null
  if (input.packCount !== 1) return null
  if (input.size === null) return null
  const match = input.size.match(NY_EDIBLE_TOTAL_SIZE_REGEX)
  if (!match) return null
  const totalMg = Number(match[1])
  if (!Number.isFinite(totalMg) || totalMg <= NY_EDIBLE_CANONICAL_PER_PIECE_MG) return null

  if (totalMg > NY_EDIBLE_PACKAGE_CAP_MG) {
    return {
      packCount: input.packCount,
      size: input.size,
      variantTab: input.variantTab ?? '',
      note:
        `Parsed total THC of ${totalMg} mg/package exceeds the NY adult-use cap of ` +
        `${NY_EDIBLE_PACKAGE_CAP_MG} mg/package. Cannot auto-split into a legal SKU; ` +
        'correct the parsed size or reject this proposal.',
      reviewFlag: 'NY edible exceeds 100mg/package cap',
      illegal: true,
    }
  }

  const cleanPieces = totalMg / NY_EDIBLE_CANONICAL_PER_PIECE_MG
  const pieces = Number.isInteger(cleanPieces)
    ? cleanPieces
    : Math.ceil(totalMg / NY_EDIBLE_CANONICAL_PER_PIECE_MG)
  const mgPerPiece = totalMg / pieces
  const mgPerPieceLabel = Number.isInteger(mgPerPiece)
    ? `${mgPerPiece}mg`
    : `${Number(mgPerPiece.toFixed(2))}mg`
  return {
    packCount: pieces,
    size: mgPerPieceLabel,
    variantTab: `${pieces}x${mgPerPieceLabel}`,
    note:
      `NY edible canonical split applied: parsed ${totalMg}mg total in 1 piece → ` +
      `${pieces}x${mgPerPieceLabel} (NY caps edibles at ${NY_EDIBLE_CANONICAL_PER_PIECE_MG}mg/piece, ` +
      `${NY_EDIBLE_PACKAGE_CAP_MG}mg/package).`,
    reviewFlag: 'NY edible split inferred — verify pieces',
    illegal: false,
  }
}

// ── identity lane matching ───────────────────────────────────────────────────

/** Working taxonomy the reconciler reasons about for one row. */
interface WorkingTaxonomy {
  brand: string | null
  category: string | null
  subcategory: string | null
  groupName: string | null
  variantName: string | null
  variantTab: string | null
  strainName: string | null
  size: string | null
  packCount: number | null
}

/**
 * True iff a live candidate matches the reconciled target on every attribute
 * lane. Used to corroborate a row-scoped Sweed-suggestion reuse (suggestions are
 * fuzzy) and to detect catalog-create duplicates. A current distributor link is
 * a DB fact and does not need this gate.
 */
function laneMatches(candidate: ReconcilerCatalogCandidate, target: WorkingTaxonomy): boolean {
  // Brand and category must both be present and equal — a reuse onto an
  // unknown-brand/category product is too risky to confirm automatically.
  const candBrand = laneKey(candidate.brand)
  const tgtBrand = laneKey(target.brand)
  if (candBrand === null || tgtBrand === null || candBrand !== tgtBrand) return false

  const candCategory = laneKey(candidate.category)
  const tgtCategory = laneKey(target.category)
  if (candCategory === null || tgtCategory === null || candCategory !== tgtCategory) return false

  // Subcategory / size / pack / tab: null===null is acceptable, but any
  // present-vs-present disagreement (or present-vs-absent) is a mismatch.
  if (laneKey(candidate.subcategory) !== laneKey(target.subcategory)) return false
  if (sizeKey(candidate.size) !== sizeKey(target.size)) return false
  if ((candidate.packCount ?? null) !== (target.packCount ?? null)) return false
  if (laneKey(candidate.variantTab) !== laneKey(target.variantTab)) return false

  // Strain / group lane (Oracle rule):
  //  - if either side has a strain, strains must match exactly (a one-sided or
  //    conflicting strain is a mismatch);
  //  - if both sides also carry a group, groups must match too;
  //  - if neither side has a strain, the group must match and be present.
  const candStrain = laneKey(candidate.strain)
  const tgtStrain = laneKey(target.strainName)
  const candGroup = laneKey(candidate.groupName)
  const tgtGroup = laneKey(target.groupName)
  const eitherStrain = candStrain !== null || tgtStrain !== null
  if (eitherStrain) {
    if (candStrain !== tgtStrain) return false
    if (candGroup !== null && tgtGroup !== null && candGroup !== tgtGroup) return false
    return true
  }
  // No strain on either side — the group lane is the only identity we have.
  if (candGroup === null || tgtGroup === null || candGroup !== tgtGroup) return false
  return true
}

/** Identity key for catalog-create duplicate detection. */
function identityKey(candidate: ReconcilerCatalogCandidate): string
function identityKey(target: WorkingTaxonomy): string
function identityKey(
  source: ReconcilerCatalogCandidate | WorkingTaxonomy,
): string {
  const isCandidate = 'productId' in source
  const brand = laneKey(source.brand)
  const category = laneKey(source.category)
  const subcategory = laneKey(source.subcategory)
  const size = sizeKey(source.size)
  const pack = (source.packCount ?? null) === null ? '' : String(source.packCount)
  const variantTab = laneKey(source.variantTab)
  const strain = laneKey(isCandidate ? source.strain : (source as WorkingTaxonomy).strainName)
  const group = laneKey(source.groupName)
  // strain takes precedence over group when present (mirrors laneMatches).
  const identityTail = strain !== null ? `s:${strain}` : `g:${group ?? ''}`
  return [brand, category, subcategory, size, pack, variantTab, identityTail]
    .map((part) => part ?? '')
    .join('\u0001')
}

// ── public entry point ───────────────────────────────────────────────────────

/**
 * Validate and reconcile the C4 drafts into deterministic, safe classifications.
 * Pure: no DB/network/clock. Throws PendingPurchaseReconcilerError on internal
 * contract corruption; downgrades rows (never throws) on model/semantic
 * uncertainty.
 */
export function reconcilePendingPurchaseDrafts(
  input: ReconcilePendingPurchaseDraftsInput,
): ReconcilePendingPurchaseDraftsResult {
  const { classifierResult, rows } = input

  const rowByKey = indexInputRows(rows)
  const draftByKey = indexDrafts(classifierResult.drafts, rowByKey)
  const candidateById = indexCatalogCandidates(input.catalogCandidates)
  const allowedCategories = toLowerSet(input.allowedTaxonomy.categories)
  const allowedSubcategories = toLowerSet(input.allowedTaxonomy.subcategories)
  const liveDuplicateIndex = buildLiveDuplicateIndex(input.catalogCandidates)
  const liveGroupIndex = buildLiveGroupIndex(input.catalogCandidates)

  const classifications: ReconciledPendingPurchaseClassification[] = []
  for (const row of rows) {
    const draft = draftByKey.get(row.rowKey)
    if (draft === undefined) {
      // indexDrafts already guarantees coverage; this is belt-and-suspenders.
      throw new PendingPurchaseReconcilerError(`Missing draft for input rowKey "${row.rowKey}".`)
    }
    classifications.push(
      reconcileRow({
        row,
        draft,
        candidateById,
        allowedCategories,
        allowedSubcategories,
        liveDuplicateIndex,
        liveGroupIndex,
      }),
    )
  }

  return {
    schemaVersion: classifierResult.schemaVersion,
    model: classifierResult.model,
    promptVersion: classifierResult.promptVersion,
    reconcilerVersion: PENDING_PURCHASE_RECONCILER_VERSION,
    classifications,
  }
}

// ── indexing / input validation (throws on corruption) ───────────────────────

function indexInputRows(rows: readonly ClassifierRowInput[]): Map<string, ClassifierRowInput> {
  if (rows.length === 0) {
    throw new PendingPurchaseReconcilerError('Reconciler requires at least one input row.')
  }
  const byKey = new Map<string, ClassifierRowInput>()
  for (const row of rows) {
    if (byKey.has(row.rowKey)) {
      throw new PendingPurchaseReconcilerError(`Duplicate input rowKey "${row.rowKey}".`)
    }
    byKey.set(row.rowKey, row)
  }
  return byKey
}

function indexDrafts(
  drafts: readonly PendingPurchaseLlmDraftRow[],
  rowByKey: ReadonlyMap<string, ClassifierRowInput>,
): Map<string, PendingPurchaseLlmDraftRow> {
  const byKey = new Map<string, PendingPurchaseLlmDraftRow>()
  for (const draft of drafts) {
    if (byKey.has(draft.rowKey)) {
      throw new PendingPurchaseReconcilerError(`Duplicate draft rowKey "${draft.rowKey}".`)
    }
    if (!rowByKey.has(draft.rowKey)) {
      throw new PendingPurchaseReconcilerError(
        `Draft references unknown rowKey "${draft.rowKey}" (no matching input row).`,
      )
    }
    byKey.set(draft.rowKey, draft)
  }
  if (byKey.size !== rowByKey.size) {
    const missing = [...rowByKey.keys()].filter((key) => !byKey.has(key))
    throw new PendingPurchaseReconcilerError(
      `Draft coverage mismatch: ${byKey.size} drafts for ${rowByKey.size} rows; missing [${missing.join(', ')}].`,
    )
  }
  return byKey
}

function indexCatalogCandidates(
  candidates: readonly ReconcilerCatalogCandidate[],
): Map<number, ReconcilerCatalogCandidate> {
  const byId = new Map<number, ReconcilerCatalogCandidate>()
  for (const candidate of candidates) {
    const existing = byId.get(candidate.productId)
    if (existing !== undefined) {
      // Duplicate id with identical attributes is harmless (dedupe); a
      // disagreeing duplicate makes validation non-deterministic — fail loud.
      if (!candidatesEqual(existing, candidate)) {
        throw new PendingPurchaseReconcilerError(
          `Conflicting duplicate catalog candidate for productId ${candidate.productId}.`,
        )
      }
      continue
    }
    byId.set(candidate.productId, candidate)
  }
  return byId
}

function candidatesEqual(a: ReconcilerCatalogCandidate, b: ReconcilerCatalogCandidate): boolean {
  return (
    a.productName === b.productName &&
    (a.groupId ?? null) === (b.groupId ?? null) &&
    a.brand === b.brand &&
    a.category === b.category &&
    a.subcategory === b.subcategory &&
    a.groupName === b.groupName &&
    a.variantTab === b.variantTab &&
    a.strain === b.strain &&
    a.size === b.size &&
    (a.packCount ?? null) === (b.packCount ?? null) &&
    (a.enabled ?? true) === (b.enabled ?? true)
  )
}

function toLowerSet(values: readonly string[]): ReadonlySet<string> {
  return new Set(values.map((value) => value.trim().toLowerCase()).filter((value) => value.length > 0))
}

/** brand+category+...+strain/group identity → live productIds, for duplicate detection. */
function buildLiveDuplicateIndex(
  candidates: readonly ReconcilerCatalogCandidate[],
): Map<string, ReconcilerCatalogCandidate[]> {
  const index = new Map<string, ReconcilerCatalogCandidate[]>()
  for (const candidate of candidates) {
    if (!isLiveCandidate(candidate)) continue
    const key = identityKey(candidate)
    const bucket = index.get(key)
    if (bucket === undefined) index.set(key, [candidate])
    else bucket.push(candidate)
  }
  return index
}

/** brand+group → a live candidate carrying that group's id, for group reuse. */
function buildLiveGroupIndex(
  candidates: readonly ReconcilerCatalogCandidate[],
): Map<string, ReconcilerCatalogCandidate> {
  const index = new Map<string, ReconcilerCatalogCandidate>()
  for (const candidate of candidates) {
    if (!isLiveCandidate(candidate)) continue
    if (candidate.groupId === null) continue
    const brand = laneKey(candidate.brand)
    const group = laneKey(candidate.groupName)
    if (brand === null || group === null) continue
    const key = `${brand}\u0001${group}`
    if (!index.has(key)) index.set(key, candidate)
  }
  return index
}

// ── per-row reconciliation ───────────────────────────────────────────────────

interface ReconcileRowInput {
  readonly row: ClassifierRowInput
  readonly draft: PendingPurchaseLlmDraftRow
  readonly candidateById: ReadonlyMap<number, ReconcilerCatalogCandidate>
  readonly allowedCategories: ReadonlySet<string>
  readonly allowedSubcategories: ReadonlySet<string>
  readonly liveDuplicateIndex: ReadonlyMap<string, ReconcilerCatalogCandidate[]>
  readonly liveGroupIndex: ReadonlyMap<string, ReconcilerCatalogCandidate>
}

function reconcileRow(args: ReconcileRowInput): ReconciledPendingPurchaseClassification {
  const { row, draft, candidateById } = args

  const reviewFlags: string[] = []
  const noteParts: string[] = [draft.rationale]

  const target: WorkingTaxonomy = {
    brand: nullableTrim(draft.targetBrand),
    category: nullableTrim(draft.targetCategory),
    subcategory: nullableTrim(draft.targetSubcategory),
    groupName: nullableTrim(draft.targetGroupName),
    variantName: nullableTrim(draft.targetVariantName),
    variantTab: nullableTrim(draft.targetVariantTab),
    strainName: nullableTrim(draft.targetStrainName),
    size: nullableTrim(draft.targetSize),
    packCount: draft.targetPackCount,
  }

  // (2) House-brand guard.
  let forcedReview = false
  if (isProhibitedHouseBrand(target.brand)) {
    reviewFlags.push(`Prohibited house brand "${target.brand}" proposed — stripped`)
    target.brand = null
    forcedReview = true
  }

  // (3) Taxonomy membership.
  if (target.category !== null && !args.allowedCategories.has(target.category.toLowerCase())) {
    reviewFlags.push(`Category "${target.category}" is not in the allowed taxonomy`)
    forcedReview = true
  }
  if (target.subcategory !== null && !args.allowedSubcategories.has(target.subcategory.toLowerCase())) {
    reviewFlags.push(`Subcategory "${target.subcategory}" is not in the allowed taxonomy`)
    forcedReview = true
  }

  // NY edible structural compliance.
  const edible = maybeNyEdibleSplit(target)
  if (edible !== null) {
    reviewFlags.push(edible.reviewFlag)
    noteParts.push(edible.note)
    if (edible.illegal) {
      forcedReview = true
    } else {
      target.size = edible.size
      target.packCount = edible.packCount
      target.variantTab = edible.variantTab
    }
  }

  const suggestions = new Map<number, ReconciledSuggestionCandidate>()
  const surface = (productId: number, productName: string | null): void => {
    if (!suggestions.has(productId)) {
      suggestions.set(productId, { productId, productName, score: null })
    }
  }

  // (4) Reuse resolution. Produces either a confirmed reuse or a safe downgrade.
  const reuse = resolveReuse({
    row,
    draft,
    target,
    candidateById,
    forcedReview,
    reviewFlags,
    surface,
  })

  let actionType: PendingPurchaseProposedAction
  let reuseProductId: number | null = null
  let reuseProductName: string | null = null
  let reuseGroupId: number | null = null
  let validatedReuseSnapshot: ReconciledReuseSnapshot | null = null

  if (reuse.kind === 'confirmed') {
    actionType = 'mapping-only'
    reuseProductId = reuse.candidate.productId
    reuseProductName = reuse.candidate.productName
    reuseGroupId = reuse.candidate.groupId
    validatedReuseSnapshot = snapshotOf(reuse.candidate)
    // Adopt the live product's identity so apply is idempotent and C7 has a
    // clean drift baseline.
    adoptCandidateTaxonomy(target, reuse.candidate)
  } else if (reuse.kind === 'needs-review') {
    actionType = 'needs-review'
  } else {
    // reuse.kind === 'catalog-create' — model proposes a new product. Guard
    // against creating a duplicate of an existing live variant.
    const dupKey = identityKey(target)
    const dupBucket = args.liveDuplicateIndex.get(dupKey) ?? []
    const liveDupes = dupBucket.filter((candidate) => isLiveCandidate(candidate))
    if (liveDupes.length > 0) {
      actionType = 'needs-review'
      reviewFlags.push('Possible existing live variant — choose reuse or confirm new SKU')
      for (const dupe of liveDupes) surface(dupe.productId, dupe.productName)
    } else {
      actionType = 'catalog-create'
      // Attach a genuinely-new variant to an existing brand+group so apply does
      // not create a duplicate group.
      const brand = laneKey(target.brand)
      const group = laneKey(target.groupName)
      if (brand !== null && group !== null) {
        const groupCandidate = args.liveGroupIndex.get(`${brand}\u0001${group}`)
        if (groupCandidate !== undefined) {
          reuseGroupId = groupCandidate.groupId
          reviewFlags.push(`New variant will attach to existing group "${groupCandidate.groupName}"`)
        }
      }
    }
  }

  const suggestionCandidates = [...suggestions.values()]
  const mappingStatus = deriveMappingStatus(actionType)
  const catalogAction = describeCatalogAction(actionType, reuseProductName)
  const notes = joinNotes(noteParts)

  const classification: ReconciledPendingPurchaseClassification = {
    rowKey: row.rowKey,
    distributorProductId: row.distributorProductId,
    distributorProductName: row.distributorProductName,
    actionType,
    catalogAction,
    mappingStatus,
    targetBrand: target.brand,
    targetCategory: target.category,
    targetSubcategory: target.subcategory,
    targetGroupName: target.groupName,
    targetVariantName: target.variantName,
    targetVariantTab: target.variantTab,
    targetStrainName: target.strainName,
    targetSize: target.size,
    targetPackCount: target.packCount,
    reuseProductId,
    reuseProductName,
    reuseGroupId,
    validatedReuseSnapshot,
    suggestionCandidates,
    reviewFlags,
    notes,
    confidence: draft.confidence,
    rationale: draft.rationale,
    citedHintIds: draft.citedHintIds,
    warningFlags: draft.warningFlags,
  }

  assertActionInvariant(classification)
  return classification
}

// ── reuse decision ───────────────────────────────────────────────────────────

type ReuseDecision =
  | { kind: 'confirmed'; candidate: ReconcilerCatalogCandidate }
  | { kind: 'needs-review' }
  | { kind: 'catalog-create' }

interface ResolveReuseInput {
  readonly row: ClassifierRowInput
  readonly draft: PendingPurchaseLlmDraftRow
  readonly target: WorkingTaxonomy
  readonly candidateById: ReadonlyMap<number, ReconcilerCatalogCandidate>
  readonly forcedReview: boolean
  readonly reviewFlags: string[]
  readonly surface: (productId: number, productName: string | null) => void
}

/**
 * The heart of the safety gate. A reuse link is CONFIRMED only when:
 *   - the candidate is an existing distributor link (a DB fact) the model
 *     agreed with, or
 *   - the candidate is a row-scoped Sweed suggestion that is enriched, live, and
 *     matches the reconciled target on every attribute lane.
 * Everything else — live-catalog-search, model-inference, lane mismatch,
 * unenriched/retired candidate, a current link the model disagreed with — is
 * downgraded to needs-review and the candidate is surfaced for the reviewer.
 */
function resolveReuse(input: ResolveReuseInput): ReuseDecision {
  const { row, draft, target, candidateById, forcedReview, reviewFlags, surface } = input

  const linkId = row.currentDistributorLinkProductId
  const sweedSuggestionIds = new Set(row.sweedSuggestions.map((s) => s.productId))
  const proposedId = draft.reuseProductIdCandidate

  // Priority 1 — an existing distributor link is a database fact. Never silently
  // turn it into a duplicate catalog-create.
  if (linkId !== null) {
    const linkCandidate = candidateById.get(linkId)
    if (linkCandidate !== undefined && isLiveCandidate(linkCandidate)) {
      if (proposedId === linkId) {
        return { kind: 'confirmed', candidate: linkCandidate }
      }
      // Model disagreed with (or omitted) an existing live link — surface both
      // sides and let the reviewer resolve. Do NOT catalog-create a duplicate.
      reviewFlags.push('Existing distributor link not confirmed by classifier — reviewer must resolve')
      surface(linkCandidate.productId, linkCandidate.productName)
      if (proposedId !== null) surfaceProposed(proposedId, candidateById, surface)
      return { kind: 'needs-review' }
    }
    // Link exists but is not enriched/live in the candidate set — we cannot
    // build a validated snapshot, so we cannot confirm it. Still refuse to
    // create a duplicate; surface the bare id.
    reviewFlags.push('Existing distributor link product is not in the live candidate set — reviewer must resolve')
    surface(linkId, null)
    if (proposedId !== null && proposedId !== linkId) surfaceProposed(proposedId, candidateById, surface)
    return { kind: 'needs-review' }
  }

  // No current link. A house-brand/taxonomy/illegal-edible problem already
  // forces review; still surface any proposed candidate for the reviewer.
  if (forcedReview) {
    if (proposedId !== null) surfaceProposed(proposedId, candidateById, surface)
    return { kind: 'needs-review' }
  }

  // Priority 2 — the model COMMITS to a mapping. A reuse link is promotable only
  // when ALL of these agree, so no weaker signal can self-certify a link:
  //   - the model proposed `mapping-only` (it is confident it IS this product),
  //   - the model's own evidence source says `sweed-suggestion`,
  //   - the candidate is a row-scoped Sweed suggestion that is enriched + live,
  //   - it matches the reconciled target on every attribute lane.
  // A `live-catalog-search` / `model-inference` / `sibling-po` proposal — even
  // one that happens to overlap this row's Sweed suggestions — is suggestion-only.
  if (draft.proposedAction === 'mapping-only') {
    if (proposedId === null) {
      // mapping-only with no candidate violates the C4 schema; defensively
      // downgrade rather than trust an incoherent draft.
      reviewFlags.push('Mapping proposed without a reuse candidate — needs review')
      return { kind: 'needs-review' }
    }
    const candidate = candidateById.get(proposedId)
    if (candidate === undefined) {
      reviewFlags.push('Proposed reuse product is not in the live candidate set — surfaced as a suggestion')
      surface(proposedId, null)
      return { kind: 'needs-review' }
    }
    if (!isLiveCandidate(candidate)) {
      reviewFlags.push('Proposed reuse product is retired/disabled — surfaced as a suggestion')
      surface(candidate.productId, candidate.productName)
      return { kind: 'needs-review' }
    }
    const source = draft.reuseEvidence?.source ?? null
    const anchoredBySuggestion = source === 'sweed-suggestion' && sweedSuggestionIds.has(proposedId)
    if (!anchoredBySuggestion) {
      reviewFlags.push(
        `Reuse evidence "${source ?? 'unknown'}" is not a row-scoped Sweed suggestion — surfaced as a suggestion`,
      )
      surface(candidate.productId, candidate.productName)
      return { kind: 'needs-review' }
    }
    if (!laneMatches(candidate, target)) {
      reviewFlags.push('Proposed reuse product does not match on every attribute lane — surfaced as a suggestion')
      surface(candidate.productId, candidate.productName)
      return { kind: 'needs-review' }
    }
    return { kind: 'confirmed', candidate }
  }

  // Priority 3 — the model proposes a brand-new product.
  if (draft.proposedAction === 'catalog-create') {
    // A (schema-invalid) candidate riding a catalog-create is ignored for
    // promotion; duplicate detection still guards against creating an existing
    // live variant.
    return { kind: 'catalog-create' }
  }

  // proposedAction === 'needs-review' (possibly carrying a candidate to surface).
  if (proposedId !== null) surfaceProposed(proposedId, candidateById, surface)
  return { kind: 'needs-review' }
}

function surfaceProposed(
  productId: number,
  candidateById: ReadonlyMap<number, ReconcilerCatalogCandidate>,
  surface: (productId: number, productName: string | null) => void,
): void {
  const candidate = candidateById.get(productId)
  surface(productId, candidate?.productName ?? null)
}

// ── output assembly helpers ──────────────────────────────────────────────────

function snapshotOf(candidate: ReconcilerCatalogCandidate): ReconciledReuseSnapshot {
  return {
    productId: candidate.productId,
    productName: candidate.productName,
    groupId: candidate.groupId,
    brand: candidate.brand,
    category: candidate.category,
    subcategory: candidate.subcategory,
    groupName: candidate.groupName,
    variantTab: candidate.variantTab,
    strain: candidate.strain,
    size: candidate.size,
    packCount: candidate.packCount,
  }
}

function adoptCandidateTaxonomy(target: WorkingTaxonomy, candidate: ReconcilerCatalogCandidate): void {
  target.brand = nullableTrim(candidate.brand)
  target.category = nullableTrim(candidate.category)
  target.subcategory = nullableTrim(candidate.subcategory)
  target.groupName = nullableTrim(candidate.groupName)
  target.variantTab = nullableTrim(candidate.variantTab)
  target.strainName = nullableTrim(candidate.strain)
  target.size = nullableTrim(candidate.size)
  target.packCount = candidate.packCount
  // variantName: prefer the live product name as the variant identity.
  target.variantName = nullableTrim(candidate.productName)
}

function deriveMappingStatus(actionType: PendingPurchaseProposedAction): PendingPurchaseMappingStatus {
  if (actionType === 'mapping-only') return 'mapped_variant_ready_for_link'
  if (actionType === 'catalog-create') return 'needs_catalog_create'
  return 'needs_review'
}

function describeCatalogAction(
  actionType: PendingPurchaseProposedAction,
  reuseProductName: string | null,
): string {
  if (actionType === 'mapping-only') {
    return reuseProductName !== null
      ? `Link this delivery line to the existing live product "${reuseProductName}".`
      : 'Link this delivery line to the validated existing live product.'
  }
  if (actionType === 'catalog-create') {
    return 'Create a new catalog variant for this delivery line.'
  }
  return 'Review and classify this delivery line before proposing a catalog create or mapping.'
}

function joinNotes(parts: ReadonlyArray<string | null>): string | null {
  const cleaned = parts
    .map((part) => (part === null ? '' : part.trim()))
    .filter((part) => part.length > 0)
  return cleaned.length === 0 ? null : cleaned.join(' ')
}

/** mapping-only ⟺ reuseProductId/validatedReuseSnapshot non-null. Internal bug if violated. */
function assertActionInvariant(row: ReconciledPendingPurchaseClassification): void {
  const isMapping = row.actionType === 'mapping-only'
  const hasReuse = row.reuseProductId !== null
  if (isMapping !== hasReuse) {
    throw new PendingPurchaseReconcilerError(
      `Action invariant violated for rowKey "${row.rowKey}": actionType=${row.actionType} but reuseProductId=${row.reuseProductId}.`,
    )
  }
  if (hasReuse !== (row.validatedReuseSnapshot !== null)) {
    throw new PendingPurchaseReconcilerError(
      `Snapshot invariant violated for rowKey "${row.rowKey}": reuseProductId=${row.reuseProductId} but validatedReuseSnapshot=${row.validatedReuseSnapshot === null ? 'null' : 'set'}.`,
    )
  }
}
