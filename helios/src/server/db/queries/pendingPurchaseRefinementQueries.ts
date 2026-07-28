import { createHash } from 'node:crypto'

import type { PoolClient, QueryResultRow } from 'pg'

import type {
  JsonValue,
  PendingPurchasePacketRevisionSummary,
  PendingPurchasePacketRootSummary,
  PendingPurchaseRefinementFailureCode,
  PendingPurchaseRefinementTurnSummary,
  PendingPurchaseRevisionRowDiff,
  PendingPurchaseRowSnapshotRef,
} from '../../../shared/contracts/index.js'
import { sha256 } from '../../../shared/util/hash.js'
import type { Queryable } from '../pool.js'
import { pendingPurchaseRefinementSchemaApplied } from '../pendingPurchaseRefinementSchema.js'

export class PendingPurchaseRefinementConflictError extends Error {}

interface PacketRootDbRow extends QueryResultRow {
  current_packet_id: number | null
  current_revision_number: number | null
  id: number
  root_key: string
  root_status: 'active' | 'superseded' | 'archived'
  updated_at: Date
  version: number
}

interface PacketRevisionDbRow extends QueryResultRow {
  accepted_at: Date | null
  accepted_by_user: string | null
  created_at: Date
  id: number
  is_applyable: boolean
  packet_root_id: number | null
  packet_title: string
  parent_packet_id: number | null
  revision_created_reason: string | null
  revision_number: number | null
  revision_status: 'current' | 'candidate' | 'superseded' | 'failed'
  source_refinement_turn_id: number | null
  updated_at: Date
}

interface RefinementTurnDbRow extends QueryResultRow {
  candidate_packet_id: number | null
  created_at: Date
  error_message: string | null
  feedback_sha256: string | null
  feedback_text: string
  finished_at: Date | null
  id: number
  job_id: number | null
  model: string | null
  packet_root_id: number
  prompt_context_json: JsonValue
  prompt_version: string | null
  requested_by_user: string | null
  row_snapshot_sha256: string
  started_at: Date | null
  status: 'queued' | 'running' | 'candidate_created' | 'failed' | 'cancelled'
  target_packet_id: number
  target_revision_number: number
  target_root_version: number
  updated_at: Date
}

interface SnapshotPacketDbRow extends QueryResultRow {
  current_packet_id: number | null
  current_revision_number: number | null
  packet_root_id: number
  packet_title: string
  revision_number: number
  revision_status: 'current' | 'candidate' | 'superseded' | 'failed'
  root_key: string
  root_status: 'active' | 'superseded' | 'archived'
  root_updated_at: Date
  root_version: number
}

interface SnapshotRowDbRow extends QueryResultRow {
  action_type: string
  approval_status: string
  catalog_action: string
  distributor_product_id: string
  distributor_product_name: string
  effective_primary_image_url: string | null
  effective_proposed_description: string | null
  effective_proposed_price: string | null
  edited_structured_fields: JsonValue
  expected_category: string | null
  expected_subcategory: string | null
  last_apply_status: string
  lineage_revision_number: number
  mapping_status: string
  notes: string | null
  raw_row_json: JsonValue
  refinement_provenance_json: JsonValue
  review_flags_json: JsonValue
  row_id: number
  row_lineage_id: string | null
  row_snapshot_sha256: string | null
  site_key: string
  target_brand: string | null
  target_group_name: string | null
  target_variant_name: string | null
  version: number
}

interface InsertTurnRow extends QueryResultRow {
  id: number
}

interface InsertPacketRow extends QueryResultRow {
  id: number
  revision_number: number
}

interface ApplyGateRow extends QueryResultRow {
  current_packet_id: number | null
  is_applyable: boolean
  packet_root_id: number | null
  revision_status: 'current' | 'candidate' | 'superseded' | 'failed'
  root_status: 'active' | 'superseded' | 'archived' | null
  status: string
}

interface LineageRow extends QueryResultRow {
  lineages: string[]
}

interface TurnLockRow extends QueryResultRow {
  candidate_packet_id: number | null
  feedback_text: string
  id: number
  packet_root_id: number
  row_snapshot_sha256: string
  status: 'queued' | 'running' | 'candidate_created' | 'failed' | 'cancelled'
  target_packet_id: number
  target_revision_number: number
  target_root_version: number
}

interface CandidateCreationResult {
  candidatePacketId: number
  revisionNumber: number
}

export interface PendingPurchaseCandidatePatch {
  readonly basePacketSnapshotSha256: string
  readonly citedContextIds: readonly string[]
  readonly fields: Readonly<Record<string, unknown>>
  readonly rationale: string
  readonly rowLineageId: string
}

export interface PreparedPendingPurchaseRefinement {
  readonly feedbackText: string
  readonly packetTitle: string
  readonly rowRefs: PendingPurchaseRowSnapshotRef[]
  readonly rowSnapshot: JsonValue
  readonly rowSnapshotSha256: string
}

export interface PendingPurchaseCandidateRefinement {
  readonly compactionLevel: string
  readonly contextItemCount: number
  readonly degradedProviders: readonly string[]
  readonly estimatedInputTokens: number
  readonly model: string
  readonly omittedContextItemCount: number
  readonly overflowRetryCount: number
  readonly patches: readonly PendingPurchaseCandidatePatch[]
  readonly promptVersion: string
  readonly schemaVersion: number
}

export interface PendingPurchaseRefinementSnapshot {
  packetTitle: string
  root: PendingPurchasePacketRootSummary
  rowRefs: PendingPurchaseRowSnapshotRef[]
  rowSnapshot: JsonValue
  rowSnapshotSha256: string
  targetPacketId: number
  targetRevisionNumber: number
}

export async function loadPendingPurchaseRefinementSnapshot(
  db: Queryable,
  packetId: number,
  options: { forUpdate?: boolean } = {},
): Promise<PendingPurchaseRefinementSnapshot | null> {
  const packetResult = await db.query<SnapshotPacketDbRow>(
    `
      select
        p.packet_root_id,
        p.revision_number,
        p.revision_status,
        p.packet_title,
        r.root_key,
        r.current_packet_id,
        r.current_revision_number,
        r.root_status,
        r.updated_at as root_updated_at,
        r.version as root_version
      from pending_purchase_packets p
      join pending_purchase_packet_roots r on r.id = p.packet_root_id
      where p.id = $1
      ${options.forUpdate ? 'for update of p, r' : ''}
    `,
    [packetId],
  )
  const packet = packetResult.rows[0]
  if (!packet) {
    return null
  }
  if (packet.current_packet_id !== packetId || packet.revision_status !== 'current') {
    throw new PendingPurchaseRefinementConflictError('Refinement feedback must target the current packet revision.')
  }

  const rowsResult = await db.query<SnapshotRowDbRow>(
    `
      select
        r.id as row_id,
        r.version,
        r.row_lineage_id,
        r.lineage_revision_number,
        r.row_snapshot_sha256,
        r.site_key,
        r.distributor_product_id,
        r.distributor_product_name,
        r.action_type,
        r.catalog_action,
        r.mapping_status,
        r.approval_status,
        r.last_apply_status,
        r.target_brand,
        r.target_group_name,
        r.target_variant_name,
        r.expected_category,
        r.expected_subcategory,
        r.notes,
        coalesce(r.edited_proposed_price, r.proposed_price)::text as effective_proposed_price,
        coalesce(r.edited_proposed_description, r.proposed_description) as effective_proposed_description,
        coalesce(r.edited_primary_image_url, r.primary_image_url) as effective_primary_image_url,
        r.edited_structured_fields,
        r.review_flags_json,
        r.raw_row_json,
        r.refinement_provenance_json
      from pending_purchase_rows r
      where r.packet_id = $1
      order by r.id asc
      ${options.forUpdate ? 'for update' : ''}
    `,
    [packetId],
  )
  if (rowsResult.rows.length === 0) {
    throw new PendingPurchaseRefinementConflictError('Cannot refine an empty pending-purchase packet.')
  }
  const snapshotRows = rowsResult.rows.map((row) => normalizeSnapshotRow(row))
  const rowSnapshot = {
    packetId,
    revisionNumber: packet.revision_number,
    rows: snapshotRows,
  } satisfies JsonValue
  const rowSnapshotSha256 = sha256(stableStringify(rowSnapshot))
  return {
    packetTitle: packet.packet_title,
    root: {
      currentPacketId: packet.current_packet_id,
      currentRevisionNumber: packet.current_revision_number,
      packetRootId: packet.packet_root_id,
      rootKey: packet.root_key,
      rootStatus: packet.root_status,
      updatedAt: toIso(packet.root_updated_at),
      version: packet.root_version,
    },
    rowRefs: rowsResult.rows.map((row) => ({
      lineageRevisionNumber: row.lineage_revision_number,
      rowId: row.row_id,
      rowLineageId: row.row_lineage_id,
      rowSnapshotSha256: row.row_snapshot_sha256,
      version: row.version,
    })),
    rowSnapshot,
    rowSnapshotSha256,
    targetPacketId: packetId,
    targetRevisionNumber: packet.revision_number,
  }
}

export function assertBaseRowsMatchSnapshot(
  actualRows: PendingPurchaseRowSnapshotRef[],
  expectedRows: PendingPurchaseRowSnapshotRef[],
): void {
  if (actualRows.length !== expectedRows.length) {
    throw new PendingPurchaseRefinementConflictError('This packet changed since the refinement form loaded. Refresh and try again.')
  }
  const expectedById = new Map(expectedRows.map((row) => [row.rowId, row]))
  for (const actual of actualRows) {
    const expected = expectedById.get(actual.rowId)
    if (!expected) {
      throw new PendingPurchaseRefinementConflictError('This packet changed since the refinement form loaded. Refresh and try again.')
    }
    if (
      actual.version !== expected.version ||
      actual.rowLineageId !== expected.rowLineageId ||
      actual.lineageRevisionNumber !== expected.lineageRevisionNumber ||
      actual.rowSnapshotSha256 !== expected.rowSnapshotSha256
    ) {
      throw new PendingPurchaseRefinementConflictError('This packet changed since the refinement form loaded. Refresh and try again.')
    }
  }
}

export async function createPendingPurchaseRefinementTurn(
  db: Queryable,
  input: {
    expectedRootVersion: number
    feedbackText: string
    packetId: number
    requestedByUserId: number
    rowSnapshot: JsonValue
    rowSnapshotSha256: string
    scopeRowLineageIds: readonly string[]
    targetRevisionNumber: number
    packetRootId: number
  },
): Promise<PendingPurchaseRefinementTurnSummary> {
  if (input.expectedRootVersion <= 0) {
    throw new PendingPurchaseRefinementConflictError('Invalid root version.')
  }
  const result = await db.query<InsertTurnRow>(
    `
      insert into pending_purchase_refinement_turns (
        packet_root_id,
        target_packet_id,
        target_revision_number,
        target_root_version,
        status,
        requested_by_user_id,
        feedback_text,
        feedback_sha256,
        row_snapshot_sha256,
        row_snapshot_json,
        prompt_context_json
      )
      values ($1, $2, $3, $4, 'queued', $5, $6, $7, $8, $9::jsonb, $10::jsonb)
      returning id
    `,
    [
      input.packetRootId,
      input.packetId,
      input.targetRevisionNumber,
      input.expectedRootVersion,
      input.requestedByUserId,
      input.feedbackText,
      sha256(input.feedbackText),
      input.rowSnapshotSha256,
      JSON.stringify(input.rowSnapshot),
      JSON.stringify({ scope: { kind: 'row-lineages', rowLineageIds: input.scopeRowLineageIds } }),
    ],
  )
  return getPendingPurchaseRefinementTurn(db, result.rows[0].id).then((turn) => {
    if (!turn) {
      throw new Error('Created pending-purchase refinement turn could not be reloaded.')
    }
    return turn
  })
}

export async function attachJobToPendingPurchaseRefinementTurn(
  db: Queryable,
  turnId: number,
  jobId: number,
): Promise<void> {
  await db.query(
    `
      update pending_purchase_refinement_turns
      set job_id = $2,
          updated_at = now()
      where id = $1
    `,
    [turnId, jobId],
  )
}

export async function preparePendingPurchaseRefinement(
  db: PoolClient,
  turnId: number,
): Promise<PreparedPendingPurchaseRefinement | null> {
  const turn = await lockRefinementTurn(db, turnId)
  if (turn.status === 'candidate_created' && turn.candidate_packet_id !== null) {
    return null
  }
  if (turn.status !== 'queued' && turn.status !== 'running') {
    throw new PendingPurchaseRefinementConflictError(`Refinement turn ${turnId} is ${turn.status}; cannot refine it.`)
  }

  const snapshot = await validateRefinementTurnSnapshot(db, turn)
  await db.query(
    `
      update pending_purchase_refinement_turns
      set status = 'running',
          started_at = coalesce(started_at, now()),
          updated_at = now()
      where id = $1
    `,
    [turnId],
  )
  return {
    feedbackText: turn.feedback_text,
    packetTitle: snapshot.packetTitle,
    rowRefs: snapshot.rowRefs,
    rowSnapshot: snapshot.rowSnapshot,
    rowSnapshotSha256: snapshot.rowSnapshotSha256,
  }
}

export async function createPendingPurchaseCandidateRevision(
  db: PoolClient,
  turnId: number,
  refinement: PendingPurchaseCandidateRefinement,
): Promise<CandidateCreationResult> {
  await db.query('lock table pending_purchase_packets in row exclusive mode')
  const turn = await lockRefinementTurn(db, turnId)
  if (turn.status === 'candidate_created' && turn.candidate_packet_id !== null) {
    const existing = await loadPacketRevisionById(db, turn.candidate_packet_id)
    if (!existing || existing.revisionNumber === null) {
      throw new Error(`Refinement turn ${turnId} points at an invalid candidate packet.`)
    }
    return { candidatePacketId: turn.candidate_packet_id, revisionNumber: existing.revisionNumber }
  }
  if (turn.status !== 'queued' && turn.status !== 'running') {
    throw new PendingPurchaseRefinementConflictError(`Refinement turn ${turnId} is ${turn.status}; cannot create a candidate.`)
  }

  const snapshot = await validateRefinementTurnSnapshot(db, turn)
  const targetLineages = new Set(snapshot.rowRefs.map((row) => row.rowLineageId))
  const patchLineages = new Set<string>()
  for (const patch of refinement.patches) {
    if (patch.basePacketSnapshotSha256 !== snapshot.rowSnapshotSha256) {
      throw new PendingPurchaseRefinementConflictError('Validated refinement patches target a stale packet snapshot.')
    }
    if (!targetLineages.has(patch.rowLineageId) || patchLineages.has(patch.rowLineageId)) {
      throw new PendingPurchaseRefinementConflictError('Validated refinement patches contain an unknown or duplicate row lineage.')
    }
    patchLineages.add(patch.rowLineageId)
  }

  const packetInsert = await db.query<InsertPacketRow>(
    `
      insert into pending_purchase_packets (
        source,
        status,
        packet_title,
        import_file_name,
        source_path,
        generated_at,
        site_keys_json,
        site_labels_json,
        orders_json,
        summary_json,
        state_context_json,
        job_id,
        created_by_user_id,
        packet_root_id,
        revision_number,
        revision_status,
        is_applyable,
        parent_packet_id,
        source_refinement_turn_id,
        revision_created_reason
      )
      select
        source,
        'superseded',
        packet_title || ' refinement r' || next_revision.revision_number::text,
        import_file_name,
        source_path,
        now(),
        site_keys_json,
        site_labels_json,
        orders_json,
        summary_json || jsonb_build_object(
          'refinement', jsonb_build_object(
            'sourcePacketId', id,
            'sourceRevisionNumber', pending_purchase_packets.revision_number,
            'turnId', $1::bigint,
            'mode', 'llm-patches',
            'model', $3::text,
            'promptVersion', $4::text,
            'patchCount', $5::integer
          )
        ),
        state_context_json,
        job_id,
        created_by_user_id,
        packet_root_id,
        next_revision.revision_number,
        'candidate',
        false,
        id,
        $1::bigint,
        'Validated LLM refinement candidate.'
      from pending_purchase_packets
      cross join lateral (
        select coalesce(max(revision_number), 0) + 1 as revision_number
        from pending_purchase_packets siblings
        where siblings.packet_root_id = pending_purchase_packets.packet_root_id
      ) next_revision
      where id = $2
      returning id, revision_number
    `,
    [turnId, turn.target_packet_id, refinement.model, refinement.promptVersion, refinement.patches.length],
  )
  const candidate = packetInsert.rows[0]
  if (!candidate) {
    await markPendingPurchaseRefinementTurnFailed(db, turnId, 'Could not create candidate packet.')
    throw new PendingPurchaseRefinementConflictError('Could not create candidate packet.')
  }

  const rowCopyResult = await db.query(
    `
      insert into pending_purchase_rows (
        packet_id,
        row_key,
        row_input_signature,
        site_key,
        site_label,
        site_dealer_id,
        site_dealer_name,
        distributor_product_id,
        distributor_product_name,
        action_type,
        mapping_status,
        target_brand,
        target_group_name,
        target_variant_name,
        expected_category,
        expected_subcategory,
        current_price,
        proposed_price,
        current_description,
        proposed_description,
        primary_image_url,
        primary_image_source,
        primary_image_note,
        catalog_action,
        pricing_reason,
        market_advice_summary,
        notes,
        review_flags_json,
        order_ids_json,
        position_ids_json,
        raw_row_json,
        approval_status,
        approved_by_user_id,
        rejected_by_user_id,
        approval_updated_at,
        edited_proposed_description,
        edited_proposed_price,
        edited_primary_image_url,
        edited_structured_fields,
        last_apply_request_id,
        last_apply_status,
        last_apply_error,
        last_apply_summary_json,
        row_lineage_id,
        parent_row_id,
        parent_packet_id,
        source_refinement_turn_id,
        lineage_revision_number,
        row_snapshot_sha256,
        refinement_provenance_json
      )
      select
        $1,
        row_key,
        row_input_signature,
        site_key,
        site_label,
        site_dealer_id,
        site_dealer_name,
        distributor_product_id,
        distributor_product_name,
        action_type,
        mapping_status,
        case when edited_structured_fields ? 'targetBrand' then edited_structured_fields ->> 'targetBrand' else target_brand end,
        case when edited_structured_fields ? 'targetGroupName' then edited_structured_fields ->> 'targetGroupName' else target_group_name end,
        case when edited_structured_fields ? 'targetVariantName' then edited_structured_fields ->> 'targetVariantName' else target_variant_name end,
        case when edited_structured_fields ? 'expectedCategory' then edited_structured_fields ->> 'expectedCategory' else expected_category end,
        case when edited_structured_fields ? 'expectedSubcategory' then edited_structured_fields ->> 'expectedSubcategory' else expected_subcategory end,
        current_price,
        coalesce(edited_proposed_price, proposed_price),
        current_description,
        coalesce(edited_proposed_description, proposed_description),
        coalesce(edited_primary_image_url, primary_image_url),
        primary_image_source,
        primary_image_note,
        catalog_action,
        pricing_reason,
        market_advice_summary,
        notes,
        review_flags_json,
        order_ids_json,
        position_ids_json,
        raw_row_json
        || case when edited_structured_fields ? 'targetVariantTab' then jsonb_build_object('targetVariantTab', edited_structured_fields -> 'targetVariantTab') else '{}'::jsonb end
        || case when edited_structured_fields ? 'targetStrainName' then jsonb_build_object('targetStrain', edited_structured_fields -> 'targetStrainName') else '{}'::jsonb end
        || case when edited_structured_fields ? 'targetSize' then jsonb_build_object('targetSize', edited_structured_fields -> 'targetSize') else '{}'::jsonb end
        || case when edited_structured_fields ? 'targetPackCount' then jsonb_build_object('targetPackCount', edited_structured_fields -> 'targetPackCount') else '{}'::jsonb end
        || case when edited_structured_fields ? 'targetReuseProductId' then jsonb_build_object(
          'reuseProductId', edited_structured_fields -> 'targetReuseProductId',
          'validatedReuseSnapshot', case
            when edited_structured_fields -> 'targetReuseProductId' = 'null'::jsonb then 'null'::jsonb
            else raw_row_json -> 'validatedReuseSnapshot'
          end
        ) else '{}'::jsonb end
        || jsonb_build_object(
          'refinementParentRowId', id,
          'refinementTurnId', $2::bigint
        ),
        'pending',
        null,
        null,
        null,
        null,
        null,
        null,
        case when edited_structured_fields ? 'targetReuseProductId'
          then jsonb_build_object('targetReuseProductId', edited_structured_fields -> 'targetReuseProductId')
          else null
        end,
        null,
        'not_requested',
        null,
        '{}'::jsonb,
        row_lineage_id,
        id,
        packet_id,
        $2::bigint,
        lineage_revision_number + 1,
        null,
        jsonb_build_object(
          'mode', 'llm-refinement-copy',
          'parentRowId', id,
          'parentPacketId', packet_id,
          'turnId', $2::bigint,
          'parentSnapshotSha256', $3::text
        )
      from pending_purchase_rows
      where packet_id = $4
      order by id asc
    `,
    [candidate.id, turnId, turn.row_snapshot_sha256, turn.target_packet_id],
  )
  if (rowCopyResult.rowCount !== snapshot.rowRefs.length) {
    await markPendingPurchaseRefinementTurnFailed(db, turnId, 'Candidate row copy count did not match the target snapshot.')
    throw new PendingPurchaseRefinementConflictError('Candidate row copy count did not match the target snapshot.')
  }

  if (refinement.patches.length > 0) {
    const patchResult = await db.query(
      `
        with patches as (
          select *
          from jsonb_to_recordset($1::jsonb) as patch(
            row_lineage_id text,
            base_packet_snapshot_sha256 text,
            fields jsonb,
            rationale text,
            cited_context_ids jsonb
          )
        )
        update pending_purchase_rows as target_row
        set
          target_brand = case when patch.fields ? 'targetBrand' then patch.fields ->> 'targetBrand' else target_row.target_brand end,
          target_group_name = case when patch.fields ? 'targetGroupName' then patch.fields ->> 'targetGroupName' else target_row.target_group_name end,
          target_variant_name = case when patch.fields ? 'targetVariantName' then patch.fields ->> 'targetVariantName' else target_row.target_variant_name end,
          expected_category = case when patch.fields ? 'expectedCategory' then patch.fields ->> 'expectedCategory' else target_row.expected_category end,
          expected_subcategory = case when patch.fields ? 'expectedSubcategory' then patch.fields ->> 'expectedSubcategory' else target_row.expected_subcategory end,
          proposed_price = case when patch.fields ? 'proposedPrice' then (patch.fields ->> 'proposedPrice')::numeric else target_row.proposed_price end,
          proposed_description = case when patch.fields ? 'proposedDescription' then patch.fields ->> 'proposedDescription' else target_row.proposed_description end,
          primary_image_url = case when patch.fields ? 'primaryImageUrl' then patch.fields ->> 'primaryImageUrl' else target_row.primary_image_url end,
          notes = case when patch.fields ? 'notes' then patch.fields ->> 'notes' else target_row.notes end,
          review_flags_json = case when patch.fields ? 'reviewFlags' then coalesce(nullif(patch.fields -> 'reviewFlags', 'null'::jsonb), '[]'::jsonb) else target_row.review_flags_json end,
          raw_row_json = target_row.raw_row_json
            || case when patch.fields ? 'targetVariantTab' then jsonb_build_object('targetVariantTab', patch.fields -> 'targetVariantTab') else '{}'::jsonb end
            || case when patch.fields ? 'targetStrainName' then jsonb_build_object('targetStrain', patch.fields -> 'targetStrainName') else '{}'::jsonb end
            || case when patch.fields ? 'targetSize' then jsonb_build_object('targetSize', patch.fields -> 'targetSize') else '{}'::jsonb end
            || case when patch.fields ? 'targetPackCount' then jsonb_build_object('targetPackCount', patch.fields -> 'targetPackCount') else '{}'::jsonb end,
          refinement_provenance_json = target_row.refinement_provenance_json || jsonb_build_object(
            'mode', 'llm-patch',
            'model', $2::text,
            'promptVersion', $3::text,
            'schemaVersion', $4::integer,
            'basePacketSnapshotSha256', patch.base_packet_snapshot_sha256,
            'rationale', patch.rationale,
            'citedContextIds', patch.cited_context_ids,
            'patchFields', patch.fields
          )
        from patches patch
        where target_row.packet_id = $5
          and target_row.row_lineage_id = patch.row_lineage_id
      `,
      [
        JSON.stringify(refinement.patches.map((patch) => ({
          base_packet_snapshot_sha256: patch.basePacketSnapshotSha256,
          cited_context_ids: patch.citedContextIds,
          fields: patch.fields,
          rationale: patch.rationale,
          row_lineage_id: patch.rowLineageId,
        }))),
        refinement.model,
        refinement.promptVersion,
        refinement.schemaVersion,
        candidate.id,
      ],
    )
    if (patchResult.rowCount !== refinement.patches.length) {
      throw new PendingPurchaseRefinementConflictError('Validated refinement patches did not match every target row lineage.')
    }
  }

  await db.query(
    `
      update pending_purchase_refinement_turns
      set status = 'candidate_created',
          candidate_packet_id = $2,
          model = $3,
          prompt_version = $4,
          prompt_context_json = prompt_context_json || $5::jsonb,
          finished_at = now(),
          updated_at = now()
      where id = $1
        and status in ('queued', 'running')
        and candidate_packet_id is null
    `,
    [
      turnId,
      candidate.id,
      refinement.model,
      refinement.promptVersion,
      JSON.stringify({
        compactionLevel: refinement.compactionLevel,
        contextItemCount: refinement.contextItemCount,
        degradedProviders: refinement.degradedProviders,
        estimatedInputTokens: refinement.estimatedInputTokens,
        omittedContextItemCount: refinement.omittedContextItemCount,
        overflowRetryCount: refinement.overflowRetryCount,
        patchCount: refinement.patches.length,
        schemaVersion: refinement.schemaVersion,
      }),
    ],
  )
  return { candidatePacketId: candidate.id, revisionNumber: candidate.revision_number }
}

export async function listPendingPurchaseRefinementHistory(
  db: Queryable,
  packetId: number,
): Promise<{
  currentRevision: PendingPurchasePacketRevisionSummary | null
  rowDiffs: PendingPurchaseRevisionRowDiff[]
  root: PendingPurchasePacketRootSummary | null
  revisions: PendingPurchasePacketRevisionSummary[]
  turns: PendingPurchaseRefinementTurnSummary[]
}> {
  const rootResult = await db.query<PacketRootDbRow>(
    `
      select r.id, r.root_key, r.current_packet_id, r.current_revision_number, r.root_status, r.version, r.updated_at
      from pending_purchase_packets p
      join pending_purchase_packet_roots r on r.id = p.packet_root_id
      where p.id = $1
    `,
    [packetId],
  )
  const rootRow = rootResult.rows[0]
  if (!rootRow) {
    return { currentRevision: null, rowDiffs: [], root: null, revisions: [], turns: [] }
  }
  const [revisionResult, turnResult, diffResult] = await Promise.all([
    db.query<PacketRevisionDbRow>(
      `
        select
          p.id,
          p.packet_root_id,
          p.revision_number,
          p.revision_status,
          p.is_applyable,
          p.parent_packet_id,
          p.source_refinement_turn_id,
          p.revision_created_reason,
          p.accepted_at,
          u.name as accepted_by_user,
          p.packet_title,
          p.created_at,
          p.updated_at
        from pending_purchase_packets p
        left join users u on u.id = p.accepted_by_user_id
        where p.packet_root_id = $1
        order by p.revision_number asc, p.id asc
      `,
      [rootRow.id],
    ),
    db.query<RefinementTurnDbRow>(
      `
        select
          t.id,
          t.packet_root_id,
          t.target_packet_id,
          t.target_revision_number,
          t.target_root_version,
          t.status,
          t.job_id,
          u.name as requested_by_user,
          t.feedback_sha256,
          t.feedback_text,
          t.row_snapshot_sha256,
          t.model,
          t.prompt_version,
          t.prompt_context_json,
          t.candidate_packet_id,
          t.error_message,
          t.created_at,
          t.started_at,
          t.finished_at,
          t.updated_at
        from pending_purchase_refinement_turns t
        left join users u on u.id = t.requested_by_user_id
        where t.packet_root_id = $1
        order by t.created_at desc, t.id desc
        limit 50
      `,
      [rootRow.id],
    ),
    db.query<PendingPurchaseRevisionRowDiff>(
      `
        select
          c.row_lineage_id as "rowLineageId",
          c.parent_row_id as "parentRowId",
          c.id as "candidateRowId",
          diff.field,
          diff.before,
          diff.after
        from pending_purchase_rows c
        join pending_purchase_rows p on p.id = c.parent_row_id
        cross join lateral (
          values
            ('proposedPrice', to_jsonb(coalesce(p.edited_proposed_price, p.proposed_price)), to_jsonb(coalesce(c.edited_proposed_price, c.proposed_price))),
            ('proposedDescription', to_jsonb(coalesce(p.edited_proposed_description, p.proposed_description)), to_jsonb(coalesce(c.edited_proposed_description, c.proposed_description))),
            ('primaryImageUrl', to_jsonb(coalesce(p.edited_primary_image_url, p.primary_image_url)), to_jsonb(coalesce(c.edited_primary_image_url, c.primary_image_url))),
            ('notes', to_jsonb(p.notes), to_jsonb(c.notes)),
            ('targetBrand', case when p.edited_structured_fields ? 'targetBrand' then p.edited_structured_fields -> 'targetBrand' else to_jsonb(p.target_brand) end, case when c.edited_structured_fields ? 'targetBrand' then c.edited_structured_fields -> 'targetBrand' else to_jsonb(c.target_brand) end),
            ('targetGroupName', case when p.edited_structured_fields ? 'targetGroupName' then p.edited_structured_fields -> 'targetGroupName' else to_jsonb(p.target_group_name) end, case when c.edited_structured_fields ? 'targetGroupName' then c.edited_structured_fields -> 'targetGroupName' else to_jsonb(c.target_group_name) end),
            ('targetVariantName', case when p.edited_structured_fields ? 'targetVariantName' then p.edited_structured_fields -> 'targetVariantName' else to_jsonb(p.target_variant_name) end, case when c.edited_structured_fields ? 'targetVariantName' then c.edited_structured_fields -> 'targetVariantName' else to_jsonb(c.target_variant_name) end),
            ('expectedCategory', case when p.edited_structured_fields ? 'expectedCategory' then p.edited_structured_fields -> 'expectedCategory' else to_jsonb(p.expected_category) end, case when c.edited_structured_fields ? 'expectedCategory' then c.edited_structured_fields -> 'expectedCategory' else to_jsonb(c.expected_category) end),
            ('expectedSubcategory', case when p.edited_structured_fields ? 'expectedSubcategory' then p.edited_structured_fields -> 'expectedSubcategory' else to_jsonb(p.expected_subcategory) end, case when c.edited_structured_fields ? 'expectedSubcategory' then c.edited_structured_fields -> 'expectedSubcategory' else to_jsonb(c.expected_subcategory) end),
            ('targetVariantTab', case when p.edited_structured_fields ? 'targetVariantTab' then p.edited_structured_fields -> 'targetVariantTab' else p.raw_row_json -> 'targetVariantTab' end, case when c.edited_structured_fields ? 'targetVariantTab' then c.edited_structured_fields -> 'targetVariantTab' else c.raw_row_json -> 'targetVariantTab' end),
            ('targetStrainName', case when p.edited_structured_fields ? 'targetStrainName' then p.edited_structured_fields -> 'targetStrainName' else p.raw_row_json -> 'targetStrain' end, case when c.edited_structured_fields ? 'targetStrainName' then c.edited_structured_fields -> 'targetStrainName' else c.raw_row_json -> 'targetStrain' end),
            ('targetSize', case when p.edited_structured_fields ? 'targetSize' then p.edited_structured_fields -> 'targetSize' else p.raw_row_json -> 'targetSize' end, case when c.edited_structured_fields ? 'targetSize' then c.edited_structured_fields -> 'targetSize' else c.raw_row_json -> 'targetSize' end),
            ('targetPackCount', case when p.edited_structured_fields ? 'targetPackCount' then p.edited_structured_fields -> 'targetPackCount' else p.raw_row_json -> 'targetPackCount' end, case when c.edited_structured_fields ? 'targetPackCount' then c.edited_structured_fields -> 'targetPackCount' else c.raw_row_json -> 'targetPackCount' end),
            ('targetReuseProductId', case when p.edited_structured_fields ? 'targetReuseProductId' then p.edited_structured_fields -> 'targetReuseProductId' else p.raw_row_json -> 'reuseProductId' end, case when c.edited_structured_fields ? 'targetReuseProductId' then c.edited_structured_fields -> 'targetReuseProductId' else c.raw_row_json -> 'reuseProductId' end),
            ('reviewFlags', p.review_flags_json, c.review_flags_json)
        ) as diff(field, before, after)
        where c.packet_id = $1
          and c.parent_row_id is not null
          and diff.before is distinct from diff.after
        order by c.id asc, diff.field asc
      `,
      [packetId],
    ),
  ])
  const revisions = revisionResult.rows.map(mapRevision)
  return {
    currentRevision: revisions.find((revision) => revision.packetId === rootRow.current_packet_id) ?? null,
    rowDiffs: diffResult.rows,
    root: mapRoot(rootRow),
    revisions,
    turns: turnResult.rows.map(mapTurn),
  }
}

export async function switchPendingPurchaseCurrentRevision(
  db: PoolClient,
  input: {
    expectedRootVersion: number
    packetId: number
    reason: string | null
    selectedPacketId: number
    userId: number
  },
): Promise<{
  previousCurrentRevision: PendingPurchasePacketRevisionSummary | null
  root: PendingPurchasePacketRootSummary
  selectedRevision: PendingPurchasePacketRevisionSummary
}> {
  await db.query('lock table pending_purchase_packets in row exclusive mode')
  const rootResult = await db.query<PacketRootDbRow>(
    `
      select r.id, r.root_key, r.current_packet_id, r.current_revision_number, r.root_status, r.version, r.updated_at
      from pending_purchase_packets p
      join pending_purchase_packet_roots r on r.id = p.packet_root_id
      where p.id = $1
      for update of r
    `,
    [input.packetId],
  )
  const root = rootResult.rows[0]
  if (!root) {
    throw new PendingPurchaseRefinementConflictError('Pending-purchase packet root not found.')
  }
  if (root.version !== input.expectedRootVersion) {
    throw new PendingPurchaseRefinementConflictError('This packet revision changed. Refresh and try again.')
  }
  if (root.root_status !== 'active' || root.current_packet_id === null) {
    throw new PendingPurchaseRefinementConflictError('This packet root is no longer active.')
  }
  const activeApply = await db.query<{ id: number }>(
    `
      select id
      from pending_purchase_apply_requests
      where packet_id = $1
        and status in ('queued', 'running')
      order by id asc
      limit 1
      for update
    `,
    [root.current_packet_id],
  )
  if (activeApply.rows.length > 0) {
    throw new PendingPurchaseRefinementConflictError(
      'Wait for the current packet apply to finish before switching revisions.',
    )
  }
  const selected = await loadPacketRevisionById(db, input.selectedPacketId)
  if (!selected || selected.packetRootId !== root.id) {
    throw new PendingPurchaseRefinementConflictError('Selected revision does not belong to this packet root.')
  }
  if (selected.revisionStatus === 'failed') {
    throw new PendingPurchaseRefinementConflictError('Failed packet revisions cannot be made current.')
  }
  const previous = root.current_packet_id === null ? null : await loadPacketRevisionById(db, root.current_packet_id)

  await db.query(
    `
      update pending_purchase_packets
      set revision_status = 'superseded',
          is_applyable = false,
          status = 'superseded',
          updated_at = now()
      where packet_root_id = $1
        and revision_status = 'current'
        and id <> $2
    `,
    [root.id, input.selectedPacketId],
  )
  await db.query(
    `
      update pending_purchase_packets
      set revision_status = 'current',
          is_applyable = true,
          status = 'ready',
          accepted_at = now(),
          accepted_by_user_id = $2,
          revision_created_reason = coalesce($3, revision_created_reason),
          updated_at = now()
      where id = $1
    `,
    [input.selectedPacketId, input.userId, input.reason],
  )
  await db.query(
    `
      update pending_purchase_packet_roots
      set current_packet_id = $2,
          current_revision_number = $3,
          current_updated_by_user_id = $4,
          current_updated_at = now(),
          version = version + 1,
          updated_at = now()
      where id = $1
    `,
    [root.id, input.selectedPacketId, selected.revisionNumber, input.userId],
  )
  const nextRoot = await loadPacketRootById(db, root.id)
  const nextSelected = await loadPacketRevisionById(db, input.selectedPacketId)
  if (!nextRoot || !nextSelected) {
    throw new Error('Switched pending-purchase revision could not be reloaded.')
  }
  return { previousCurrentRevision: previous, root: nextRoot, selectedRevision: nextSelected }
}

export async function assertPendingPurchasePacketApplyable(db: Queryable, packetId: number): Promise<void> {
  // Migration 102 is an expand migration applied manually in production. Until
  // the sentinel is applied, legacy packets have no root/current columns to
  // gate on; keep the pre-refinement apply path working. Once the schema is
  // present, the revision gate below is authoritative.
  if (!(await isPendingPurchaseRefinementSchemaAvailable(db))) {
    return
  }
  const result = await db.query<ApplyGateRow>(
    `
      select p.packet_root_id, p.status, p.revision_status, p.is_applyable,
             r.current_packet_id, r.root_status
      from pending_purchase_packets p
      left join pending_purchase_packet_roots r on r.id = p.packet_root_id
      where p.id = $1
    `,
    [packetId],
  )
  const row = result.rows[0]
  if (!row) {
    throw new PendingPurchaseRefinementConflictError('Pending-purchase packet not found.')
  }
  if (row.packet_root_id === null) {
    if (row.status === 'ready') {
      return
    }
    throw new PendingPurchaseRefinementConflictError('Only the current applyable packet revision can be applied.')
  }
  if (
    row.root_status !== 'active'
    || row.current_packet_id !== packetId
    || row.revision_status !== 'current'
    || !row.is_applyable
  ) {
    throw new PendingPurchaseRefinementConflictError('Only the current applyable packet revision can be applied.')
  }
}

export async function lockPendingPurchasePacketRootForApply(
  db: Queryable,
  packetId: number,
): Promise<void> {
  if (!(await isPendingPurchaseRefinementSchemaAvailable(db))) return
  await lockPendingPurchasePacketRootRow(db, packetId)
}

export async function lockPendingPurchasePacketRootRow(
  db: Queryable,
  packetId: number,
): Promise<void> {
  await db.query(
    `
      select r.id
      from pending_purchase_packets p
      join pending_purchase_packet_roots r on r.id = p.packet_root_id
      where p.id = $1
      for update of r
    `,
    [packetId],
  )
}

export async function isPendingPurchaseRefinementSchemaAvailable(db: Queryable): Promise<boolean> {
  return pendingPurchaseRefinementSchemaApplied(db)
}

async function getPendingPurchaseRefinementTurn(
  db: Queryable,
  turnId: number,
): Promise<PendingPurchaseRefinementTurnSummary | null> {
  const result = await db.query<RefinementTurnDbRow>(
    `
      select
        t.id,
        t.packet_root_id,
        t.target_packet_id,
        t.target_revision_number,
        t.target_root_version,
        t.status,
        t.job_id,
        u.name as requested_by_user,
        t.feedback_sha256,
        t.feedback_text,
        t.row_snapshot_sha256,
        t.model,
        t.prompt_version,
        t.prompt_context_json,
        t.candidate_packet_id,
        t.error_message,
        t.created_at,
        t.started_at,
        t.finished_at,
        t.updated_at
      from pending_purchase_refinement_turns t
      left join users u on u.id = t.requested_by_user_id
      where t.id = $1
    `,
    [turnId],
  )
  return result.rows[0] ? mapTurn(result.rows[0]) : null
}

async function lockRefinementTurn(db: PoolClient, turnId: number): Promise<TurnLockRow> {
  const result = await db.query<TurnLockRow>(
    `
      select id, packet_root_id, target_packet_id, target_revision_number, target_root_version,
             status, candidate_packet_id, feedback_text, row_snapshot_sha256
      from pending_purchase_refinement_turns
      where id = $1
      for update
    `,
    [turnId],
  )
  const row = result.rows[0]
  if (!row) {
    throw new PendingPurchaseRefinementConflictError('Pending-purchase refinement turn not found.')
  }
  return row
}

async function validateRefinementTurnSnapshot(
  db: PoolClient,
  turn: TurnLockRow,
): Promise<PendingPurchaseRefinementSnapshot> {
  const snapshot = await loadPendingPurchaseRefinementSnapshot(db, turn.target_packet_id, { forUpdate: true })
  if (!snapshot) {
    throw new PendingPurchaseRefinementConflictError('Target packet not found.')
  }
  if (
    snapshot.root.packetRootId !== turn.packet_root_id ||
    snapshot.root.version !== turn.target_root_version ||
    snapshot.targetRevisionNumber !== turn.target_revision_number ||
    snapshot.rowSnapshotSha256 !== turn.row_snapshot_sha256
  ) {
    throw new PendingPurchaseRefinementConflictError('Target packet snapshot is stale. Submit feedback against the current revision.')
  }
  const lineageCheck = await db.query<LineageRow>(
    `
      select array_agg(coalesce(row_lineage_id, '') order by row_lineage_id) as lineages
      from pending_purchase_rows
      where packet_id = $1
    `,
    [turn.target_packet_id],
  )
  const lineages = lineageCheck.rows[0]?.lineages ?? []
  if (lineages.some((lineage) => lineage.trim().length === 0)) {
    throw new PendingPurchaseRefinementConflictError('Target packet has a row without lineage metadata.')
  }
  if (new Set(lineages).size !== lineages.length) {
    throw new PendingPurchaseRefinementConflictError('Target packet has duplicate row lineage metadata.')
  }
  return snapshot
}

export async function markPendingPurchaseRefinementTurnFailed(
  db: Queryable,
  turnId: number,
  message: string,
  failureCode: PendingPurchaseRefinementFailureCode | null = null,
  attemptProvenance: JsonValue | null = null,
): Promise<void> {
  await db.query(
    `
      update pending_purchase_refinement_turns
      set status = 'failed',
          error_message = $2,
          prompt_context_json = prompt_context_json || case
            when $3::text is null then '{}'::jsonb
            else jsonb_build_object('failureCode', $3::text)
          end || coalesce($4::jsonb, '{}'::jsonb),
          finished_at = now(),
          updated_at = now()
      where id = $1
        and status in ('queued', 'running')
        and candidate_packet_id is null
    `,
    [turnId, message, failureCode, attemptProvenance === null ? null : JSON.stringify(attemptProvenance)],
  )
}

async function loadPacketRootById(db: Queryable, rootId: number): Promise<PendingPurchasePacketRootSummary | null> {
  const result = await db.query<PacketRootDbRow>(
    `
      select id, root_key, current_packet_id, current_revision_number, root_status, version, updated_at
      from pending_purchase_packet_roots
      where id = $1
    `,
    [rootId],
  )
  return result.rows[0] ? mapRoot(result.rows[0]) : null
}

async function loadPacketRevisionById(db: Queryable, packetId: number): Promise<PendingPurchasePacketRevisionSummary | null> {
  const result = await db.query<PacketRevisionDbRow>(
    `
      select
        p.id,
        p.packet_root_id,
        p.revision_number,
        p.revision_status,
        p.is_applyable,
        p.parent_packet_id,
        p.source_refinement_turn_id,
        p.revision_created_reason,
        p.accepted_at,
        u.name as accepted_by_user,
        p.packet_title,
        p.created_at,
        p.updated_at
      from pending_purchase_packets p
      left join users u on u.id = p.accepted_by_user_id
      where p.id = $1
    `,
    [packetId],
  )
  return result.rows[0] ? mapRevision(result.rows[0]) : null
}

function normalizeSnapshotRow(row: SnapshotRowDbRow): JsonValue {
  return {
    actionType: row.action_type,
    approvalStatus: row.approval_status,
    catalogAction: row.catalog_action,
    distributorProductId: row.distributor_product_id,
    distributorProductName: row.distributor_product_name,
    effectivePrimaryImageUrl: row.effective_primary_image_url,
    effectiveProposedDescription: row.effective_proposed_description,
    effectiveProposedPrice: row.effective_proposed_price,
    editedStructuredFields: row.edited_structured_fields,
    expectedCategory: row.expected_category,
    expectedSubcategory: row.expected_subcategory,
    lastApplyStatus: row.last_apply_status,
    lineageRevisionNumber: row.lineage_revision_number,
    mappingStatus: row.mapping_status,
    notes: row.notes,
    rawProvenance: row.raw_row_json,
    refinementProvenance: row.refinement_provenance_json,
    reviewFlags: row.review_flags_json,
    rowId: row.row_id,
    rowLineageId: row.row_lineage_id,
    siteKey: row.site_key,
    targetBrand: row.target_brand,
    targetGroupName: row.target_group_name,
    targetVariantName: row.target_variant_name,
    version: row.version,
  }
}

function mapRoot(row: PacketRootDbRow): PendingPurchasePacketRootSummary {
  return {
    currentPacketId: row.current_packet_id,
    currentRevisionNumber: row.current_revision_number,
    packetRootId: row.id,
    rootKey: row.root_key,
    rootStatus: row.root_status,
    updatedAt: toIso(row.updated_at),
    version: row.version,
  }
}

function mapRevision(row: PacketRevisionDbRow): PendingPurchasePacketRevisionSummary {
  return {
    acceptedAt: toIsoOrNull(row.accepted_at),
    acceptedByUser: row.accepted_by_user,
    createdAt: toIso(row.created_at),
    isApplyable: row.is_applyable,
    packetId: row.id,
    packetRootId: row.packet_root_id,
    packetTitle: row.packet_title,
    parentPacketId: row.parent_packet_id,
    revisionCreatedReason: row.revision_created_reason,
    revisionNumber: row.revision_number,
    revisionStatus: row.revision_status,
    sourceRefinementTurnId: row.source_refinement_turn_id,
    updatedAt: toIso(row.updated_at),
  }
}

function mapTurn(row: RefinementTurnDbRow): PendingPurchaseRefinementTurnSummary {
  return {
    candidatePacketId: row.candidate_packet_id,
    createdAt: toIso(row.created_at),
    errorMessage: row.error_message,
    feedbackSha256: row.feedback_sha256,
    feedbackText: row.feedback_text,
    finishedAt: toIsoOrNull(row.finished_at),
    jobId: row.job_id,
    model: row.model,
    packetRootId: row.packet_root_id,
    promptVersion: row.prompt_version,
    promptContext: row.prompt_context_json,
    requestedByUser: row.requested_by_user,
    rowSnapshotSha256: row.row_snapshot_sha256,
    startedAt: toIsoOrNull(row.started_at),
    status: row.status,
    targetPacketId: row.target_packet_id,
    targetRevisionNumber: row.target_revision_number,
    targetRootVersion: row.target_root_version,
    turnId: row.id,
    updatedAt: toIso(row.updated_at),
  }
}

function stableStringify(value: JsonValue): string {
  return JSON.stringify(sortJsonValue(value))
}

function sortJsonValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue)
  }
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, JsonValue> = {}
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortJsonValue((value as Record<string, JsonValue>)[key])
    }
    return sorted
  }
  return value
}

function toIso(value: Date): string {
  return value.toISOString()
}

function toIsoOrNull(value: Date | null): string | null {
  return value === null ? null : value.toISOString()
}

export function hashJsonForPendingPurchaseRefinement(value: JsonValue): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex')
}
