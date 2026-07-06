/**
 * LitAlerts parse-correction feedback inbox queries (issue #59, task T3).
 *
 * An INERT feedback store: NOTHING in the production scorer / market-match read
 * path joins `litalerts_parse_feedback`. These queries are the ONLY reader of
 * the table (plus the later T5 promotion export). Unpromoted feedback never
 * changes production scoring/matching, `fuzzy_skus`, market aggregates, or IQR.
 *
 * Provenance (source listing id / retailer id / raw name / input hash /
 * snapshot / use case) is derived SERVER-SIDE from the referenced `fuzzy_skus`
 * row (`loadFuzzySkuProvenance`), never trusted from the browser.
 */

import type { QueryResultRow } from 'pg'

import {
  ConventionProposalDetailsSchema,
  ListingCorrectionDetailsSchema,
  ParseFeedbackRecordSchema,
  type ConventionProposalDetails,
  type ListingCorrectionDetails,
  type ParseFeedbackKind,
  type ParseFeedbackRecord,
  type ParseFeedbackStatus,
  type ParseFeedbackUseCase,
} from '../../../shared/contracts/index.js'
import type { Queryable } from '../pool.js'

interface ParseFeedbackRow extends QueryResultRow {
  id: string
  kind: string
  use_case: string
  source_listing_id: string | null
  fuzzy_sku_id: string | null
  retailer_id: string | null
  raw_listing_name: string | null
  input_hash: string | null
  input_snapshot: Record<string, unknown> | null
  family_key: string | null
  brand_key: string | null
  matched_catalog_product_id: string | null
  source_feedback_id: string | null
  details: unknown
  status: string
  promoted_parser_id: string | null
  promoted_rule_id: string | null
  promoted_config_sha: string | null
  status_changed_by: string | null
  status_changed_at: Date | null
  created_by: string
  created_at: Date
  updated_by: string
  updated_at: Date
}

const SELECT_COLUMNS = `
  id, kind, use_case, source_listing_id, fuzzy_sku_id, retailer_id,
  raw_listing_name, input_hash, input_snapshot, family_key, brand_key,
  matched_catalog_product_id, source_feedback_id, details, status,
  promoted_parser_id, promoted_rule_id, promoted_config_sha,
  status_changed_by, status_changed_at, created_by, created_at,
  updated_by, updated_at
`

function toIso(value: Date | null): string | null {
  return value === null ? null : value.toISOString()
}

function toIntOrNull(value: string | null): number | null {
  if (value === null) return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/**
 * Parse the stored `details` blob with the schema for the row's kind, so a
 * `listing_correction` row can never be mis-read as a convention (and vice
 * versa). Throws (via zod) if the persisted payload is malformed.
 */
function parseDetails(
  kind: ParseFeedbackKind,
  details: unknown,
): ListingCorrectionDetails | ConventionProposalDetails {
  return kind === 'listing_correction'
    ? ListingCorrectionDetailsSchema.parse(details)
    : ConventionProposalDetailsSchema.parse(details)
}

function mapRow(row: ParseFeedbackRow): ParseFeedbackRecord {
  const kind = row.kind as ParseFeedbackKind
  return ParseFeedbackRecordSchema.parse({
    id: row.id,
    kind,
    useCase: row.use_case,
    sourceListingId: row.source_listing_id,
    fuzzySkuId: toIntOrNull(row.fuzzy_sku_id),
    retailerId: toIntOrNull(row.retailer_id),
    rawListingName: row.raw_listing_name,
    inputHash: row.input_hash,
    inputSnapshot: row.input_snapshot,
    familyKey: row.family_key,
    brandKey: row.brand_key,
    matchedCatalogProductId: toIntOrNull(row.matched_catalog_product_id),
    sourceFeedbackId: row.source_feedback_id,
    details: parseDetails(kind, row.details),
    status: row.status,
    promotedParserId: row.promoted_parser_id,
    promotedRuleId: row.promoted_rule_id,
    promotedConfigSha: row.promoted_config_sha,
    statusChangedBy: row.status_changed_by,
    statusChangedAt: toIso(row.status_changed_at),
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    updatedBy: row.updated_by,
    updatedAt: row.updated_at.toISOString(),
  })
}

/**
 * Server-derived provenance for one `fuzzy_skus` row. Projects ONLY the fields
 * the feedback record needs out of `raw_input_jsonb` (never the whole blob) so a
 * large raw payload isn't detoasted/serialized for nothing (canon DB rules).
 */
export interface FuzzySkuProvenance {
  fuzzySkuId: number
  sourceListingId: string
  useCase: ParseFeedbackUseCase
  retailerId: number | null
  rawListingName: string | null
  inputHash: string
  inputSnapshot: Record<string, unknown>
}

interface FuzzySkuProvenanceRow extends QueryResultRow {
  id: string
  source_listing_id: string
  raw_input_hash: string
  retailer_id: string | null
  listing_name: string | null
  input_snapshot: Record<string, unknown>
}

export async function loadFuzzySkuProvenance(
  db: Queryable,
  fuzzySkuId: number,
): Promise<FuzzySkuProvenance | null> {
  const result = await db.query<FuzzySkuProvenanceRow>(
    `select
       id,
       source_listing_id,
       raw_input_hash,
       nullif(raw_input_jsonb->>'retailerId', '') as retailer_id,
       nullif(raw_input_jsonb->>'listingName', '') as listing_name,
       jsonb_strip_nulls(jsonb_build_object(
         'retailerId', raw_input_jsonb->'retailerId',
         'listingName', raw_input_jsonb->'listingName',
         'brand', raw_input_jsonb->'brand',
         'dispensaryName', raw_input_jsonb->'dispensaryName',
         'url', raw_input_jsonb->'url',
         'normalPrice', raw_input_jsonb->'normalPrice',
         'salePrice', raw_input_jsonb->'salePrice'
       )) as input_snapshot
     from fuzzy_skus
     where id = $1`,
    [fuzzySkuId],
  )
  const row = result.rows[0]
  if (!row) return null
  return {
    fuzzySkuId: Number(row.id),
    sourceListingId: row.source_listing_id,
    // LitAlerts is the only source today; the feedback inbox is scoped to it.
    useCase: 'litalerts',
    retailerId: toIntOrNull(row.retailer_id),
    rawListingName: row.listing_name,
    inputHash: row.raw_input_hash,
    inputSnapshot: row.input_snapshot,
  }
}

export interface ListParseFeedbackInput {
  fuzzySkuIds: number[]
  retailerIds: number[]
}

/**
 * Fetch feedback for the visible candidates (by fuzzy_sku_id) and/or a set of
 * retailers (by retailer_id). Runs one indexed query per non-empty id set and
 * merges by `id` so a row matching both filters isn't returned twice. Both id
 * sets are already bounded by the contract (PARSE_FEEDBACK_ID_QUERY_LIMIT).
 */
export async function listParseFeedback(
  db: Queryable,
  input: ListParseFeedbackInput,
): Promise<ParseFeedbackRecord[]> {
  const byId = new Map<string, ParseFeedbackRow>()

  // LitAlerts is the only surface reading this endpoint today; scope every read
  // to it so a future `competitor-ecom` use case can never leak onto this panel
  // (and so the reads line up with the `use_case`-leading partial indexes).
  if (input.fuzzySkuIds.length > 0) {
    const result = await db.query<ParseFeedbackRow>(
      `select ${SELECT_COLUMNS}
         from litalerts_parse_feedback
        where use_case = 'litalerts'
          and fuzzy_sku_id = any($1::bigint[])
        order by created_at desc`,
      [input.fuzzySkuIds],
    )
    for (const row of result.rows) byId.set(row.id, row)
  }

  if (input.retailerIds.length > 0) {
    const result = await db.query<ParseFeedbackRow>(
      `select ${SELECT_COLUMNS}
         from litalerts_parse_feedback
        where use_case = 'litalerts'
          and retailer_id = any($1::bigint[])
        order by created_at desc`,
      [input.retailerIds],
    )
    for (const row of result.rows) byId.set(row.id, row)
  }

  return Array.from(byId.values())
    .sort((a, b) => b.created_at.getTime() - a.created_at.getTime())
    .map(mapRow)
}

export async function getParseFeedbackById(
  db: Queryable,
  id: string,
): Promise<ParseFeedbackRecord | null> {
  const result = await db.query<ParseFeedbackRow>(
    `select ${SELECT_COLUMNS} from litalerts_parse_feedback where id = $1`,
    [id],
  )
  const row = result.rows[0]
  return row ? mapRow(row) : null
}

export interface InsertListingCorrectionInput {
  provenance: FuzzySkuProvenance
  familyKey: string
  brandKey: string | null
  matchedCatalogProductId: number | null
  details: ListingCorrectionDetails
  actor: string
}

export async function insertListingCorrection(
  db: Queryable,
  input: InsertListingCorrectionInput,
): Promise<ParseFeedbackRecord> {
  const p = input.provenance
  const result = await db.query<ParseFeedbackRow>(
    `insert into litalerts_parse_feedback
       (kind, use_case, source_listing_id, fuzzy_sku_id, retailer_id,
        raw_listing_name, input_hash, input_snapshot, family_key, brand_key,
        matched_catalog_product_id, details, created_by, updated_by)
     values ('listing_correction', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12)
     returning ${SELECT_COLUMNS}`,
    [
      p.useCase,
      p.sourceListingId,
      p.fuzzySkuId,
      p.retailerId,
      p.rawListingName,
      p.inputHash,
      JSON.stringify(p.inputSnapshot),
      input.familyKey,
      input.brandKey,
      input.matchedCatalogProductId,
      JSON.stringify(input.details),
      input.actor,
    ],
  )
  const row = result.rows[0]
  if (!row) throw new Error('litalerts_parse_feedback listing_correction insert returned no row')
  return mapRow(row)
}

export interface InsertConventionProposalInput {
  provenance: FuzzySkuProvenance
  familyKey: string
  brandKey: string | null
  matchedCatalogProductId: number | null
  sourceFeedbackId: string
  details: ConventionProposalDetails
  actor: string
}

export async function insertConventionProposal(
  db: Queryable,
  input: InsertConventionProposalInput,
): Promise<ParseFeedbackRecord> {
  const p = input.provenance
  const result = await db.query<ParseFeedbackRow>(
    `insert into litalerts_parse_feedback
       (kind, use_case, source_listing_id, fuzzy_sku_id, retailer_id,
        raw_listing_name, input_hash, input_snapshot, family_key, brand_key,
        matched_catalog_product_id, source_feedback_id, details, created_by, updated_by)
     values ('convention_proposal', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $13)
     returning ${SELECT_COLUMNS}`,
    [
      p.useCase,
      p.sourceListingId,
      p.fuzzySkuId,
      p.retailerId,
      p.rawListingName,
      p.inputHash,
      JSON.stringify(p.inputSnapshot),
      input.familyKey,
      input.brandKey,
      input.matchedCatalogProductId,
      input.sourceFeedbackId,
      JSON.stringify(input.details),
      input.actor,
    ],
  )
  const row = result.rows[0]
  if (!row) throw new Error('litalerts_parse_feedback convention_proposal insert returned no row')
  return mapRow(row)
}

export interface UpdateParseFeedbackInput {
  details: ListingCorrectionDetails | ConventionProposalDetails
  matchedCatalogProductId?: number | null
  actor: string
}

/**
 * Re-edit a still-`draft` feedback row in place. Returns null when the id is
 * unknown, and the string `'not-draft'` when the row exists but is no longer a
 * draft (so the route can answer 409). Never inserts/supersedes — draft edits
 * mutate the same row (Oracle design review).
 */
export async function updateParseFeedbackDraft(
  db: Queryable,
  id: string,
  input: UpdateParseFeedbackInput,
): Promise<ParseFeedbackRecord | null | 'not-draft'> {
  const existing = await getParseFeedbackById(db, id)
  if (!existing) return null
  if (existing.status !== 'draft') return 'not-draft'

  const sets: string[] = ['details = $1', 'updated_by = $2', 'updated_at = now()']
  const params: unknown[] = [JSON.stringify(input.details), input.actor]
  if (input.matchedCatalogProductId !== undefined) {
    params.push(input.matchedCatalogProductId)
    sets.push(`matched_catalog_product_id = $${params.length}`)
  }
  params.push(id)
  const result = await db.query<ParseFeedbackRow>(
    `update litalerts_parse_feedback
        set ${sets.join(', ')}
      where id = $${params.length} and status = 'draft'
      returning ${SELECT_COLUMNS}`,
    params,
  )
  const row = result.rows[0]
  return row ? mapRow(row) : null
}

export interface UpdateParseFeedbackStatusInput {
  status: ParseFeedbackStatus
  actor: string
  /** Only present when `status === 'promoted'` (validated at the route boundary). */
  promotion?: {
    parserId: string
    ruleId: string | null
    configSha: string
  }
}

/**
 * Move a feedback row to a new lifecycle status. Promotion provenance follows
 * the schema's `litalerts_parse_feedback_promotion_meta_ok` coupling (T5):
 *   - `promoted`                              → set parser id / rule id / config sha.
 *   - `superseded`                            → PRESERVE any existing provenance.
 *   - `draft` / `promotion_requested` / `rejected` → CLEAR provenance to null.
 * The DB CHECK is the backstop; this mirrors it so the columns are always
 * consistent with the status we write.
 */
export async function updateParseFeedbackStatus(
  db: Queryable,
  id: string,
  input: UpdateParseFeedbackStatusInput,
): Promise<ParseFeedbackRecord | null> {
  const sets = [
    'status = $1',
    'status_changed_by = $2',
    'status_changed_at = now()',
    'updated_by = $2',
    'updated_at = now()',
  ]
  const params: unknown[] = [input.status, input.actor]

  if (input.status === 'promoted') {
    const promotion = input.promotion
    if (!promotion) {
      throw new Error('updateParseFeedbackStatus: promotion metadata required for status=promoted')
    }
    params.push(promotion.parserId)
    sets.push(`promoted_parser_id = $${params.length}`)
    params.push(promotion.ruleId)
    sets.push(`promoted_rule_id = $${params.length}`)
    params.push(promotion.configSha)
    sets.push(`promoted_config_sha = $${params.length}`)
  } else if (input.status !== 'superseded') {
    // draft / promotion_requested / rejected: clear provenance.
    sets.push('promoted_parser_id = null', 'promoted_rule_id = null', 'promoted_config_sha = null')
  }
  // superseded: leave the promotion columns untouched (preserve prior provenance).

  params.push(id)
  const result = await db.query<ParseFeedbackRow>(
    `update litalerts_parse_feedback
        set ${sets.join(', ')}
      where id = $${params.length}
      returning ${SELECT_COLUMNS}`,
    params,
  )
  const row = result.rows[0]
  return row ? mapRow(row) : null
}

// ---------------------------------------------------------------------------
// Promotion export (task T5)
//
// A READ-ONLY, retailer-scoped fetch of the inert feedback inbox for the
// agent/reviewer promotion path. Nothing here joins the production scorer /
// market-match read path — it just reads back the operator's corrections +
// their linked convention proposals so an agent can turn them into parsekit
// goldens + a `helios-parser-configs` entry. Bounded by `limit`.
// ---------------------------------------------------------------------------

export interface LoadPromotionExportInput {
  retailerId: number
  statuses: ParseFeedbackStatus[]
  /** Max listing corrections to return; one extra is fetched to detect truncation. */
  limit: number
}

export interface PromotionExportRows {
  corrections: ParseFeedbackRecord[]
  /** Convention proposals keyed by the listing-correction id they were spawned from. */
  conventionsByCorrectionId: Map<string, ParseFeedbackRecord[]>
  truncated: boolean
}

export async function loadPromotionExportFeedback(
  db: Queryable,
  input: LoadPromotionExportInput,
): Promise<PromotionExportRows> {
  // Retailer-scoped, status-filtered listing corrections. Uses the
  // (use_case, retailer_id, created_at desc) partial index from migration 097.
  // Fetch one extra row so the caller can report truncation without a count(*).
  const result = await db.query<ParseFeedbackRow>(
    `select ${SELECT_COLUMNS}
       from litalerts_parse_feedback
      where use_case = 'litalerts'
        and kind = 'listing_correction'
        and retailer_id = $1
        and status = any($2::text[])
      order by created_at desc, id
      limit $3`,
    [input.retailerId, input.statuses, input.limit + 1],
  )
  const truncated = result.rows.length > input.limit
  const correctionRows = truncated ? result.rows.slice(0, input.limit) : result.rows
  const corrections = correctionRows.map(mapRow)

  const conventionsByCorrectionId = new Map<string, ParseFeedbackRecord[]>()
  const correctionIds = corrections.map((c) => c.id)
  if (correctionIds.length > 0) {
    // Linked convention proposals (any status) for the selected corrections,
    // via the source_feedback_id partial index from migration 097.
    const convResult = await db.query<ParseFeedbackRow>(
      `select ${SELECT_COLUMNS}
         from litalerts_parse_feedback
        where kind = 'convention_proposal'
          and source_feedback_id = any($1::uuid[])
        order by created_at desc, id`,
      [correctionIds],
    )
    for (const row of convResult.rows) {
      const rec = mapRow(row)
      if (rec.kind !== 'convention_proposal' || rec.sourceFeedbackId === null) continue
      const list = conventionsByCorrectionId.get(rec.sourceFeedbackId) ?? []
      list.push(rec)
      conventionsByCorrectionId.set(rec.sourceFeedbackId, list)
    }
  }

  return { corrections, conventionsByCorrectionId, truncated }
}
