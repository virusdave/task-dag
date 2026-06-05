import type { QueryResultRow } from 'pg'

import type { JsonValue } from '../../../shared/contracts/common/json.js'
import { sha256, stableJsonStringify } from '../../../shared/util/hash.js'
import type { Queryable } from '../pool.js'

export type PendingPurchaseBrandAliasStatus = 'active' | 'draft' | 'provisional' | 'rejected' | 'retired'
export type PendingPurchaseBrandAliasType = 'exact' | 'prefix' | 'distributor'
export type PendingPurchaseObservationStatus =
  | 'accepted'
  | 'blocked'
  | 'captured'
  | 'failed'
  | 'informational'
  | 'rejected'
  | 'succeeded'
export type PendingPurchaseObservationType =
  | 'apply_outcome'
  | 'generation_parse'
  | 'llm_inference'
  | 'reviewer_approval'
  | 'reviewer_edit'
  | 'rule_state_change'
export type PendingPurchaseParseRuleKind = 'exact_name' | 'prefix' | 'regex' | 'template'
export type PendingPurchaseParseRuleState = 'active' | 'draft' | 'provisional' | 'rejected' | 'retired'

interface PendingPurchaseBrandProfileRow extends QueryResultRow {
  created_at: Date
  display_brand_name: string
  id: number
  metadata_json: JsonValue
  normalized_brand_key: string
  source_system: string
  taxonomy_hints_json: JsonValue
  updated_at: Date
}

interface PendingPurchaseBrandAliasRow extends QueryResultRow {
  alias_type: PendingPurchaseBrandAliasType
  alias_value: string
  brand_profile_id: number
  confidence: number | null
  created_at: Date
  id: number
  metadata_json: JsonValue
  normalized_alias_value: string
  provenance: string | null
  status: PendingPurchaseBrandAliasStatus
  updated_at: Date
}

interface PendingPurchaseParseRuleRow extends QueryResultRow {
  brand_profile_id: number
  confidence: number | null
  created_at: Date
  failure_count: number
  hit_count: number
  id: number
  last_feedback_at: Date | null
  last_matched_at: Date | null
  last_state_changed_at: Date | null
  match_payload_json: JsonValue
  metadata_json: JsonValue
  normalized_match_value: string | null
  parsed_output_json: JsonValue
  provenance: string | null
  risk_flags_json: string[]
  rule_fingerprint: string
  rule_kind: PendingPurchaseParseRuleKind
  source: string
  state: PendingPurchaseParseRuleState
  success_count: number
  updated_at: Date
  validation_json: JsonValue
}

interface PendingPurchaseObservationInsertRow extends QueryResultRow {
  id: number
}

interface PendingPurchaseAliasMatchRow extends PendingPurchaseBrandAliasRow {
  brand_display_name: string
  brand_metadata_json: JsonValue
  brand_normalized_brand_key: string
  brand_source_system: string
  brand_taxonomy_hints_json: JsonValue
}

export interface PendingPurchaseBrandProfileRecord {
  displayBrandName: string
  id: number
  metadata: JsonValue
  normalizedBrandKey: string
  sourceSystem: string
  taxonomyHints: JsonValue
}

export interface PendingPurchaseBrandAliasRecord {
  aliasType: PendingPurchaseBrandAliasType
  aliasValue: string
  brandProfileId: number
  confidence: number | null
  id: number
  metadata: JsonValue
  normalizedAliasValue: string
  provenance: string | null
  status: PendingPurchaseBrandAliasStatus
}

export interface PendingPurchaseParseRuleRecord {
  brandProfileId: number
  confidence: number | null
  failureCount: number
  hitCount: number
  id: number
  lastFeedbackAt: string | null
  lastMatchedAt: string | null
  lastStateChangedAt: string | null
  matchPayload: JsonValue
  metadata: JsonValue
  normalizedMatchValue: string | null
  parsedOutput: JsonValue
  provenance: string | null
  riskFlags: string[]
  ruleFingerprint: string
  ruleKind: PendingPurchaseParseRuleKind
  source: string
  state: PendingPurchaseParseRuleState
  successCount: number
  validation: JsonValue
}

export interface PendingPurchaseBrandAliasMatch {
  alias: PendingPurchaseBrandAliasRecord
  brandProfile: PendingPurchaseBrandProfileRecord
}

export interface UpsertPendingPurchaseBrandProfileInput {
  displayBrandName: string
  metadata?: JsonValue
  normalizedBrandKey?: string
  sourceSystem: string
  taxonomyHints?: JsonValue
}

export interface UpsertPendingPurchaseBrandAliasInput {
  aliasType: PendingPurchaseBrandAliasType
  aliasValue: string
  brandProfileId: number
  confidence?: number | null
  metadata?: JsonValue
  provenance?: string | null
  status: PendingPurchaseBrandAliasStatus
}

export interface UpsertPendingPurchaseParseRuleInput {
  brandProfileId: number
  confidence?: number | null
  matchPayload?: JsonValue
  metadata?: JsonValue
  normalizedMatchValue?: string | null
  parsedOutput: JsonValue
  provenance?: string | null
  riskFlags?: string[]
  ruleFingerprint: string
  ruleKind: PendingPurchaseParseRuleKind
  source: string
  state: PendingPurchaseParseRuleState
  validation?: JsonValue
}

export interface InsertPendingPurchaseObservationInput {
  brandProfileId?: number | null
  createdByUserId?: number | null
  inference?: JsonValue
  normalizedDistributorProductName?: string | null
  notes?: string | null
  observationStatus: PendingPurchaseObservationStatus
  observationType: PendingPurchaseObservationType
  packetId?: number | null
  parseRuleId?: number | null
  pendingPurchaseRowId?: number | null
  rawDistributorProductName?: string | null
  rawRow?: JsonValue
  rowInputSignature?: string | null
  sourceSystem: string
}

export interface UpdatePendingPurchaseParseRuleFeedbackInput {
  feedbackType: 'approved' | 'applied' | 'blocked' | 'edited' | 'failed' | 'rejected'
  ruleId: number
  state?: PendingPurchaseParseRuleState | null
}

const ACTIVE_RULE_STATES: PendingPurchaseParseRuleState[] = ['active', 'provisional']
const ACTIVE_ALIAS_STATES: PendingPurchaseBrandAliasStatus[] = ['active', 'provisional']

export function normalizePendingPurchaseParserText(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function derivePendingPurchaseBrandKey(value: string): string {
  return normalizePendingPurchaseParserText(value)
}

export function buildPendingPurchaseBrandAliasCandidates(value: string): string[] {
  const normalized = normalizePendingPurchaseParserText(value)
  if (normalized.length === 0) {
    return []
  }

  const words = normalized.split(' ').filter((word) => word.length > 0)
  const candidates: string[] = []
  const maxWords = Math.min(words.length, 6)
  for (let wordCount = maxWords; wordCount >= 1; wordCount -= 1) {
    candidates.push(words.slice(0, wordCount).join(' '))
  }

  return [...new Set(candidates)]
}

export function buildPendingPurchaseParseRuleFingerprint(input: {
  brandProfileNormalizedKey: string
  matchPayload?: JsonValue
  normalizedMatchValue?: string | null
  parsedOutput: JsonValue
  ruleKind: PendingPurchaseParseRuleKind
  sourceSystem: string
}): string {
  return sha256(stableJsonStringify({
    brandProfileNormalizedKey: input.brandProfileNormalizedKey,
    matchPayload: input.matchPayload ?? null,
    normalizedMatchValue: input.normalizedMatchValue ?? null,
    parsedOutput: input.parsedOutput,
    ruleKind: input.ruleKind,
    sourceSystem: input.sourceSystem,
  }))
}

export async function upsertPendingPurchaseBrandProfile(
  db: Queryable,
  input: UpsertPendingPurchaseBrandProfileInput,
): Promise<PendingPurchaseBrandProfileRecord> {
  const normalizedBrandKey = input.normalizedBrandKey ?? derivePendingPurchaseBrandKey(input.displayBrandName)
  const result = await db.query<PendingPurchaseBrandProfileRow>(
    `
      insert into pending_purchase_brand_profiles (
        source_system,
        normalized_brand_key,
        display_brand_name,
        taxonomy_hints_json,
        metadata_json
      )
      values ($1, $2, $3, $4::jsonb, $5::jsonb)
      on conflict (source_system, normalized_brand_key)
      do update
        set display_brand_name = excluded.display_brand_name,
            taxonomy_hints_json = pending_purchase_brand_profiles.taxonomy_hints_json || excluded.taxonomy_hints_json,
            metadata_json = pending_purchase_brand_profiles.metadata_json || excluded.metadata_json,
            updated_at = now()
      returning id, source_system, normalized_brand_key, display_brand_name, taxonomy_hints_json, metadata_json, created_at, updated_at
    `,
    [
      input.sourceSystem,
      normalizedBrandKey,
      input.displayBrandName.trim(),
      JSON.stringify(input.taxonomyHints ?? {}),
      JSON.stringify(input.metadata ?? {}),
    ],
  )

  return mapBrandProfileRow(result.rows[0])
}

export async function upsertPendingPurchaseBrandAlias(
  db: Queryable,
  input: UpsertPendingPurchaseBrandAliasInput,
): Promise<PendingPurchaseBrandAliasRecord> {
  const normalizedAliasValue = normalizePendingPurchaseParserText(input.aliasValue)
  const result = await db.query<PendingPurchaseBrandAliasRow>(
    `
      insert into pending_purchase_brand_aliases (
        brand_profile_id,
        alias_type,
        alias_value,
        normalized_alias_value,
        status,
        confidence,
        provenance,
        metadata_json
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
      on conflict (brand_profile_id, alias_type, normalized_alias_value)
      do update
        set alias_value = excluded.alias_value,
            status = excluded.status,
            confidence = excluded.confidence,
            provenance = excluded.provenance,
            metadata_json = pending_purchase_brand_aliases.metadata_json || excluded.metadata_json,
            updated_at = now()
      returning id,
        brand_profile_id,
        alias_type,
        alias_value,
        normalized_alias_value,
        status,
        confidence::double precision as confidence,
        provenance,
        metadata_json,
        created_at,
        updated_at
    `,
    [
      input.brandProfileId,
      input.aliasType,
      input.aliasValue.trim(),
      normalizedAliasValue,
      input.status,
      input.confidence ?? null,
      input.provenance ?? null,
      JSON.stringify(input.metadata ?? {}),
    ],
  )

  return mapBrandAliasRow(result.rows[0])
}

export async function upsertPendingPurchaseParseRule(
  db: Queryable,
  input: UpsertPendingPurchaseParseRuleInput,
): Promise<PendingPurchaseParseRuleRecord> {
  const result = await db.query<PendingPurchaseParseRuleRow>(
    `
      insert into pending_purchase_parse_rules (
        brand_profile_id,
        rule_kind,
        state,
        source,
        provenance,
        confidence,
        normalized_match_value,
        match_payload_json,
        parsed_output_json,
        validation_json,
        risk_flags_json,
        rule_fingerprint,
        metadata_json,
        last_state_changed_at
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb, $11::jsonb, $12, $13::jsonb, now())
      on conflict (rule_fingerprint)
      do update
        set state = excluded.state,
            confidence = excluded.confidence,
            normalized_match_value = excluded.normalized_match_value,
            match_payload_json = excluded.match_payload_json,
            parsed_output_json = excluded.parsed_output_json,
            validation_json = pending_purchase_parse_rules.validation_json || excluded.validation_json,
            risk_flags_json = excluded.risk_flags_json,
            metadata_json = pending_purchase_parse_rules.metadata_json || excluded.metadata_json,
            provenance = excluded.provenance,
            source = excluded.source,
            last_state_changed_at = case
              when pending_purchase_parse_rules.state <> excluded.state then now()
              else pending_purchase_parse_rules.last_state_changed_at
            end,
            updated_at = now()
      returning id,
        brand_profile_id,
        rule_kind,
        state,
        source,
        provenance,
        confidence::double precision as confidence,
        normalized_match_value,
        match_payload_json,
        parsed_output_json,
        validation_json,
        risk_flags_json,
        rule_fingerprint,
        hit_count,
        success_count,
        failure_count,
        last_matched_at,
        last_feedback_at,
        last_state_changed_at,
        metadata_json,
        created_at,
        updated_at
    `,
    [
      input.brandProfileId,
      input.ruleKind,
      input.state,
      input.source,
      input.provenance ?? null,
      input.confidence ?? null,
      input.normalizedMatchValue ?? null,
      JSON.stringify(input.matchPayload ?? {}),
      JSON.stringify(input.parsedOutput),
      JSON.stringify(input.validation ?? {}),
      JSON.stringify(input.riskFlags ?? []),
      input.ruleFingerprint,
      JSON.stringify(input.metadata ?? {}),
    ],
  )

  return mapParseRuleRow(result.rows[0])
}

export async function insertPendingPurchaseParseObservation(
  db: Queryable,
  input: InsertPendingPurchaseObservationInput,
): Promise<number> {
  const result = await db.query<PendingPurchaseObservationInsertRow>(
    `
      insert into pending_purchase_parse_observations (
        source_system,
        packet_id,
        pending_purchase_row_id,
        brand_profile_id,
        parse_rule_id,
        created_by_user_id,
        observation_type,
        observation_status,
        row_input_signature,
        raw_distributor_product_name,
        normalized_distributor_product_name,
        raw_row_json,
        inference_json,
        notes
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13::jsonb, $14)
      returning id
    `,
    [
      input.sourceSystem,
      input.packetId ?? null,
      input.pendingPurchaseRowId ?? null,
      input.brandProfileId ?? null,
      input.parseRuleId ?? null,
      input.createdByUserId ?? null,
      input.observationType,
      input.observationStatus,
      input.rowInputSignature ?? null,
      input.rawDistributorProductName ?? null,
      input.normalizedDistributorProductName ?? null,
      JSON.stringify(input.rawRow ?? {}),
      JSON.stringify(input.inference ?? {}),
      input.notes ?? null,
    ],
  )
  return result.rows[0].id
}

export async function findPendingPurchaseExactParseRule(
  db: Queryable,
  input: { normalizedName: string; sourceSystem: string },
): Promise<{ brandProfile: PendingPurchaseBrandProfileRecord; rule: PendingPurchaseParseRuleRecord } | null> {
  const result = await db.query<PendingPurchaseParseRuleRow & PendingPurchaseBrandProfileRow>(
    `
      select
        pr.id,
        pr.brand_profile_id,
        pr.rule_kind,
        pr.state,
        pr.source,
        pr.provenance,
        pr.confidence::double precision as confidence,
        pr.normalized_match_value,
        pr.match_payload_json,
        pr.parsed_output_json,
        pr.validation_json,
        pr.risk_flags_json,
        pr.rule_fingerprint,
        pr.hit_count,
        pr.success_count,
        pr.failure_count,
        pr.last_matched_at,
        pr.last_feedback_at,
        pr.last_state_changed_at,
        pr.metadata_json,
        pr.created_at,
        pr.updated_at,
        bp.source_system,
        bp.normalized_brand_key,
        bp.display_brand_name,
        bp.taxonomy_hints_json,
        bp.metadata_json as brand_metadata_json,
        bp.created_at as brand_created_at,
        bp.updated_at as brand_updated_at
      from pending_purchase_parse_rules pr
      inner join pending_purchase_brand_profiles bp on bp.id = pr.brand_profile_id
      where bp.source_system = $1
        and pr.rule_kind = 'exact_name'
        and pr.state = any($2::text[])
        and pr.normalized_match_value = $3
      order by
        case pr.state when 'active' then 0 when 'provisional' then 1 else 2 end,
        pr.confidence desc nulls last,
        pr.success_count desc,
        pr.id desc
      limit 1
    `,
    [input.sourceSystem, ACTIVE_RULE_STATES, input.normalizedName],
  )

  const row = result.rows[0]
  if (!row) {
    return null
  }

  return {
    brandProfile: {
      displayBrandName: row.display_brand_name,
      id: row.brand_profile_id,
      metadata: (row as unknown as { brand_metadata_json: JsonValue }).brand_metadata_json,
      normalizedBrandKey: row.normalized_brand_key,
      sourceSystem: row.source_system,
      taxonomyHints: row.taxonomy_hints_json,
    },
    rule: mapParseRuleRow(row),
  }
}

export async function listPendingPurchaseMatchingBrandAliases(
  db: Queryable,
  input: { aliasCandidates: string[]; normalizedName: string; sourceSystem: string },
): Promise<PendingPurchaseBrandAliasMatch[]> {
  if (input.aliasCandidates.length === 0) {
    return []
  }

  const result = await db.query<PendingPurchaseAliasMatchRow>(
    `
      select
        ba.id,
        ba.brand_profile_id,
        ba.alias_type,
        ba.alias_value,
        ba.normalized_alias_value,
        ba.status,
        ba.confidence::double precision as confidence,
        ba.provenance,
        ba.metadata_json,
        ba.created_at,
        ba.updated_at,
        bp.source_system as brand_source_system,
        bp.normalized_brand_key as brand_normalized_brand_key,
        bp.display_brand_name as brand_display_name,
        bp.taxonomy_hints_json as brand_taxonomy_hints_json,
        bp.metadata_json as brand_metadata_json
      from pending_purchase_brand_aliases ba
      inner join pending_purchase_brand_profiles bp on bp.id = ba.brand_profile_id
      where bp.source_system = $1
        and ba.status = any($2::text[])
        and (
          (ba.alias_type = 'exact' and ba.normalized_alias_value = any($3::text[]))
          or (ba.alias_type = 'prefix' and $4 like ba.normalized_alias_value || '%')
        )
      order by
        case ba.status when 'active' then 0 when 'provisional' then 1 else 2 end,
        length(ba.normalized_alias_value) desc,
        ba.confidence desc nulls last,
        ba.id desc
    `,
    [input.sourceSystem, ACTIVE_ALIAS_STATES, input.aliasCandidates, input.normalizedName],
  )

  return result.rows.map((row) => ({
    alias: mapBrandAliasRow(row),
    brandProfile: {
      displayBrandName: row.brand_display_name,
      id: row.brand_profile_id,
      metadata: row.brand_metadata_json,
      normalizedBrandKey: row.brand_normalized_brand_key,
      sourceSystem: row.brand_source_system,
      taxonomyHints: row.brand_taxonomy_hints_json,
    },
  }))
}

/**
 * Look up distributor-keyed brand aliases (alias_type='distributor').
 *
 * Unlike the product-name aliases above, these match on the (already
 * normalized) DISTRIBUTOR name. A match means "every product this
 * distributor ships belongs to this brand" — used by the generation
 * worker to pin the brand deterministically (skipping the LLM) when the
 * brand never appears in the product name. `normalizedDistributorNames`
 * should already be run through `normalizePendingPurchaseParserText`.
 *
 * Backed by the partial unique index added in migration 063 so an
 * active/provisional distributor alias maps to at most one brand
 * profile; we still order deterministically and let the caller detect
 * cross-brand conflicts defensively.
 */
export async function listPendingPurchaseDistributorBrandAliases(
  db: Queryable,
  input: { normalizedDistributorNames: string[]; sourceSystem: string },
): Promise<PendingPurchaseBrandAliasMatch[]> {
  const distinctNames = [...new Set(input.normalizedDistributorNames.filter((name) => name.length > 0))]
  if (distinctNames.length === 0) {
    return []
  }

  const result = await db.query<PendingPurchaseAliasMatchRow>(
    `
      select
        ba.id,
        ba.brand_profile_id,
        ba.alias_type,
        ba.alias_value,
        ba.normalized_alias_value,
        ba.status,
        ba.confidence::double precision as confidence,
        ba.provenance,
        ba.metadata_json,
        ba.created_at,
        ba.updated_at,
        bp.source_system as brand_source_system,
        bp.normalized_brand_key as brand_normalized_brand_key,
        bp.display_brand_name as brand_display_name,
        bp.taxonomy_hints_json as brand_taxonomy_hints_json,
        bp.metadata_json as brand_metadata_json
      from pending_purchase_brand_aliases ba
      inner join pending_purchase_brand_profiles bp on bp.id = ba.brand_profile_id
      where bp.source_system = $1
        and ba.status = any($2::text[])
        and ba.alias_type = 'distributor'
        and ba.normalized_alias_value = any($3::text[])
      order by
        case ba.status when 'active' then 0 when 'provisional' then 1 else 2 end,
        ba.confidence desc nulls last,
        ba.id desc
    `,
    [input.sourceSystem, ACTIVE_ALIAS_STATES, distinctNames],
  )

  return result.rows.map((row) => ({
    alias: mapBrandAliasRow(row),
    brandProfile: {
      displayBrandName: row.brand_display_name,
      id: row.brand_profile_id,
      metadata: row.brand_metadata_json,
      normalizedBrandKey: row.brand_normalized_brand_key,
      sourceSystem: row.brand_source_system,
      taxonomyHints: row.brand_taxonomy_hints_json,
    },
  }))
}

export async function listPendingPurchaseRuntimeRulesForProfiles(
  db: Queryable,
  input: { brandProfileIds: number[] },
): Promise<PendingPurchaseParseRuleRecord[]> {
  if (input.brandProfileIds.length === 0) {
    return []
  }

  const result = await db.query<PendingPurchaseParseRuleRow>(
    `
      select
        id,
        brand_profile_id,
        rule_kind,
        state,
        source,
        provenance,
        confidence::double precision as confidence,
        normalized_match_value,
        match_payload_json,
        parsed_output_json,
        validation_json,
        risk_flags_json,
        rule_fingerprint,
        hit_count,
        success_count,
        failure_count,
        last_matched_at,
        last_feedback_at,
        last_state_changed_at,
        metadata_json,
        created_at,
        updated_at
      from pending_purchase_parse_rules
      where brand_profile_id = any($1::bigint[])
        and state = any($2::text[])
        and rule_kind <> 'exact_name'
      order by
        case state when 'active' then 0 when 'provisional' then 1 else 2 end,
        confidence desc nulls last,
        success_count desc,
        id desc
    `,
    [input.brandProfileIds, ACTIVE_RULE_STATES],
  )

  return result.rows.map((row) => mapParseRuleRow(row))
}

export async function markPendingPurchaseParseRuleMatched(db: Queryable, ruleId: number): Promise<void> {
  await db.query(
    `
      update pending_purchase_parse_rules
      set hit_count = hit_count + 1,
          last_matched_at = now(),
          updated_at = now()
      where id = $1
    `,
    [ruleId],
  )
}

export async function updatePendingPurchaseParseRuleFeedback(
  db: Queryable,
  input: UpdatePendingPurchaseParseRuleFeedbackInput,
): Promise<void> {
  const successIncrement = input.feedbackType === 'applied' ? 1 : 0
  const failureIncrement = input.feedbackType === 'blocked' || input.feedbackType === 'edited' || input.feedbackType === 'failed'
    ? 1
    : 0
  await db.query(
    `
      update pending_purchase_parse_rules
      set success_count = success_count + $2,
          failure_count = failure_count + $3,
          state = coalesce($4, state),
          last_feedback_at = now(),
          last_state_changed_at = case
            when $4 is not null and state <> $4 then now()
            else last_state_changed_at
          end,
          updated_at = now()
      where id = $1
    `,
    [input.ruleId, successIncrement, failureIncrement, input.state ?? null],
  )
}

function mapBrandProfileRow(row: PendingPurchaseBrandProfileRow): PendingPurchaseBrandProfileRecord {
  return {
    displayBrandName: row.display_brand_name,
    id: row.id,
    metadata: row.metadata_json,
    normalizedBrandKey: row.normalized_brand_key,
    sourceSystem: row.source_system,
    taxonomyHints: row.taxonomy_hints_json,
  }
}

function mapBrandAliasRow(row: PendingPurchaseBrandAliasRow): PendingPurchaseBrandAliasRecord {
  return {
    aliasType: row.alias_type,
    aliasValue: row.alias_value,
    brandProfileId: row.brand_profile_id,
    confidence: row.confidence,
    id: row.id,
    metadata: row.metadata_json,
    normalizedAliasValue: row.normalized_alias_value,
    provenance: row.provenance,
    status: row.status,
  }
}

function mapParseRuleRow(row: PendingPurchaseParseRuleRow): PendingPurchaseParseRuleRecord {
  return {
    brandProfileId: row.brand_profile_id,
    confidence: row.confidence,
    failureCount: row.failure_count,
    hitCount: row.hit_count,
    id: row.id,
    lastFeedbackAt: toIsoString(row.last_feedback_at),
    lastMatchedAt: toIsoString(row.last_matched_at),
    lastStateChangedAt: toIsoString(row.last_state_changed_at),
    matchPayload: row.match_payload_json,
    metadata: row.metadata_json,
    normalizedMatchValue: row.normalized_match_value,
    parsedOutput: row.parsed_output_json,
    provenance: row.provenance,
    riskFlags: Array.isArray(row.risk_flags_json) ? row.risk_flags_json : [],
    ruleFingerprint: row.rule_fingerprint,
    ruleKind: row.rule_kind,
    source: row.source,
    state: row.state,
    successCount: row.success_count,
    validation: row.validation_json,
  }
}

function toIsoString(value: Date | null): string | null {
  return value instanceof Date ? value.toISOString() : null
}
