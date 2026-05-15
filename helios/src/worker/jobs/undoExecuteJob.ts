import type { PoolClient, QueryResultRow } from 'pg'

import {
  buildCatalogGroupModuleScope,
  parseUndoableAuditEvent,
  type JsonValue,
  type UndoExecuteJobPayload,
  type UndoableAuditEvent,
} from '../../shared/contracts/index.js'
import type { FieldPath } from '../../shared/domain/fieldPaths.js'
import { stableJsonStringify } from '../../shared/util/hash.js'
import { listActiveDesiredStateFields } from '../../server/db/queries/desiredStateQueries.js'
import { withTransaction } from '../../server/db/tx.js'
import { buildDesiredProjection, getDesiredProjectionHash } from '../../server/domain/desiredProjection.js'
import { getOptionalSweedSessionConcurrencyKey } from '../../server/jobs/concurrency.js'
import { enqueueJob } from '../../server/jobs/enqueueJob.js'
import {
  findDescriptionMedicalClaimIssues,
  getLiveStateFieldValue,
  normalizeCatalogGroupDetail,
  normalizeDescriptionText,
  NormalizedCatalogGroupLiveStateSchema,
} from '../catalog/liveState.js'
import { hashLiveState, insertCatalogGroupSnapshot, updateCatalogGroupLiveState } from './catalogGroupPersistence.js'
import { editProductGroupDescription, editProductPrice, getProductGroupDetail, waitForProductPrice } from '../sweed/client.js'

interface UndoEventRow extends QueryResultRow {
  catalog_group_id: number | null
  original_event_id: number
  original_event_type: string
  original_payload_json: JsonValue
  original_undo_payload_json: JsonValue | null
  requested_by_user_id: number | null
  status: 'completed' | 'failed' | 'queued' | 'running'
  undo_audit_event_id: number | null
}

interface ProposalLineItemUndoRow extends QueryResultRow {
  approval_status: 'approved' | 'pending' | 'rejected' | 'superseded'
  approval_updated_at: Date | null
  approved_by_user_id: number | null
  catalog_group_id: number
  edited_value_json: JsonValue | null
  effective_value_json: JsonValue
  id: number
  notes: string | null
  rejected_by_user_id: number | null
  version: number
}

interface DesiredStateRevisionRow extends QueryResultRow {
  active: boolean
  id: number
  proposal_line_item_id: number
}

interface OriginalApprovalWriteSnapshotRow extends QueryResultRow {
  state_json: JsonValue
  sweed_group_id: number
}

interface WriteOperationInsertRow extends QueryResultRow {
  id: number
}

interface UndoExecutionContext {
  originalEvent: UndoableAuditEvent
  originalEventId: number
  requestedByUserId: number | null
  undoAuditEventId: number | null
  undoEventId: number
}

interface ApprovalUndoLiveWritePlan {
  catalogGroupId: number
  desiredProjectionHash: string
  desiredProjectionJson: ReturnType<typeof buildDesiredProjection>
  fieldPath: FieldPath
  jobId: number
  restoredValue: JsonValue
  sweedGroupId: number
  targetEntityId: number
  targetEntityType: 'catalog_group' | 'catalog_product'
  triggerAuditEventId: number | null
}

export async function runUndoExecuteJob(jobContext: { id: number }, payload: UndoExecuteJobPayload): Promise<void> {
  const undoContext = await markUndoEventRunning(payload.undoEventId)
  if (!undoContext) {
    return
  }

  try {
    await withTransaction(async (db) => {
      switch (undoContext.originalEvent.eventType) {
        case 'proposal.line_item.edited':
          await undoProposalLineItemEdit(db, undoContext)
          break
        case 'proposal.line_item.note_updated':
          await undoProposalLineItemNoteUpdate(db, undoContext)
          break
        case 'proposal.line_item.approved':
          await undoProposalLineItemApproval(db, undoContext, { jobId: jobContext.id })
          break
        case 'proposal.line_item.rejected':
          await undoProposalLineItemRejection(db, undoContext)
          break
      }

      await db.query(
        `
          update undo_events
          set status = 'completed',
              error = null,
              finished_at = now(),
              updated_at = now()
          where id = $1
        `,
        [undoContext.undoEventId],
      )
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown undo worker error.'
    await withTransaction(async (db) => {
      await db.query(
        `
          update undo_events
          set status = 'failed',
              error = $2,
              finished_at = now(),
              updated_at = now()
          where id = $1
        `,
        [undoContext.undoEventId, message],
      )
    })
    throw error
  }
}

async function markUndoEventRunning(undoEventId: number): Promise<UndoExecutionContext | null> {
  return withTransaction(async (db) => {
    const row = await lockUndoEvent(db, undoEventId)
    if (!row) {
      throw new Error(`Undo event ${undoEventId} not found.`)
    }
    if (row.status === 'completed') {
      return null
    }

    const originalUndoPayload = row.original_undo_payload_json
    if (originalUndoPayload === null) {
      throw new Error('This audit event does not have an undo payload.')
    }

    const originalEvent = parseUndoableAuditEvent({
      eventType: row.original_event_type,
      payload: row.original_payload_json,
      undoPayload: originalUndoPayload,
    })

    await db.query(
      `
        update undo_events
        set status = 'running',
            error = null,
            started_at = coalesce(started_at, now()),
            finished_at = null,
            updated_at = now()
        where id = $1
      `,
      [undoEventId],
    )

    return {
      originalEvent,
      originalEventId: row.original_event_id,
      requestedByUserId: row.requested_by_user_id,
      undoAuditEventId: row.undo_audit_event_id,
      undoEventId,
    }
  })
}

async function lockUndoEvent(db: PoolClient, undoEventId: number): Promise<UndoEventRow | null> {
  const result = await db.query<UndoEventRow>(
    `
      select
        ue.original_event_id,
        ue.status,
        ue.requested_by_user_id,
        ue.undo_audit_event_id,
        ae.catalog_group_id,
        ae.event_type as original_event_type,
        ae.payload_json as original_payload_json,
        ae.undo_payload_json as original_undo_payload_json
      from undo_events ue
      inner join audit_events ae on ae.id = ue.original_event_id
      where ue.id = $1
      for update
    `,
    [undoEventId],
  )

  return result.rows[0] ?? null
}

async function undoProposalLineItemEdit(db: PoolClient, context: UndoExecutionContext): Promise<void> {
  const event = context.originalEvent
  if (event.eventType !== 'proposal.line_item.edited') {
    throw new Error('Undo context did not contain a proposal edit event.')
  }
  const { payload, undoPayload } = event

  const lineItem = await lockProposalLineItem(db, payload.proposalLineItemId)
  if (lineItem.approval_status !== payload.approvalStatusAtEdit) {
    throw new Error('Cannot undo this edit because the line item approval status has changed since the edit was made.')
  }
  if (lineItem.version !== payload.nextVersion) {
    throw new Error('Cannot undo this edit because the line item version has changed since the edit was made.')
  }
  if (!jsonValuesEqual(lineItem.edited_value_json, payload.nextEditedValue)) {
    throw new Error('Cannot undo this edit because the edited value no longer matches the recorded post-edit value.')
  }
  if (!jsonValuesEqual(lineItem.effective_value_json, payload.nextEffectiveValue)) {
    throw new Error('Cannot undo this edit because the effective value no longer matches the recorded post-edit value.')
  }

  await db.query(
    `
      update proposal_line_items
      set edited_value_json = $2::jsonb,
          effective_value_json = $3::jsonb,
          version = $4,
          updated_at = now()
      where id = $1
    `,
    [
      lineItem.id,
      undoPayload.previousEditedValue === null ? null : JSON.stringify(undoPayload.previousEditedValue),
      JSON.stringify(undoPayload.previousEffectiveValue),
      undoPayload.previousVersion,
    ],
  )
}

async function undoProposalLineItemNoteUpdate(db: PoolClient, context: UndoExecutionContext): Promise<void> {
  const event = context.originalEvent
  if (event.eventType !== 'proposal.line_item.note_updated') {
    throw new Error('Undo context did not contain a proposal note update event.')
  }
  const { payload, undoPayload } = event

  const lineItem = await lockProposalLineItem(db, payload.proposalLineItemId)
  if (lineItem.notes !== payload.nextNote) {
    throw new Error('Cannot undo this note change because the note has been updated since the original change.')
  }

  await db.query(
    `
      update proposal_line_items
      set notes = $2,
          updated_at = now()
      where id = $1
    `,
    [lineItem.id, undoPayload.previousNote],
  )
}

async function undoProposalLineItemApproval(
  db: PoolClient,
  context: UndoExecutionContext,
  execution: { jobId: number },
): Promise<void> {
  const event = context.originalEvent
  if (event.eventType !== 'proposal.line_item.approved') {
    throw new Error('Undo context did not contain a proposal approval event.')
  }
  const { payload, undoPayload } = event

  const lineItem = await lockProposalLineItem(db, payload.proposalLineItemId)
  if (lineItem.approval_status !== 'approved') {
    throw new Error('Cannot undo this approval because the line item is no longer approved.')
  }
  if (lineItem.approved_by_user_id !== payload.nextApprovedByUserId) {
    throw new Error('Cannot undo this approval because the approving user no longer matches the recorded approval.')
  }

  const activatedRevision = await lockDesiredStateRevision(db, payload.activatedDesiredStateRevisionId)
  if (!activatedRevision) {
    throw new Error('Cannot undo this approval because the activated desired-state revision no longer exists.')
  }
  if (activatedRevision.proposal_line_item_id !== payload.proposalLineItemId) {
    throw new Error('Cannot undo this approval because the activated desired-state revision no longer belongs to this line item.')
  }
  if (!activatedRevision.active) {
    throw new Error('Cannot undo this approval because the activated desired-state revision is no longer active.')
  }

  await db.query(
    `
      update proposal_line_items
      set approval_status = $2,
          approved_by_user_id = $3,
          rejected_by_user_id = $4,
          approval_updated_at = $5,
          updated_at = now()
      where id = $1
    `,
    [
      lineItem.id,
      undoPayload.previousApprovalStatus,
      undoPayload.previousApprovedByUserId,
      undoPayload.previousRejectedByUserId,
      undoPayload.previousApprovalUpdatedAt,
    ],
  )

  await db.query(
    `
      update desired_state_revisions
      set active = false
      where id = $1
    `,
    [payload.activatedDesiredStateRevisionId],
  )

  if (payload.supersededDesiredStateRevisionIds.length > 0) {
    await db.query(
      `
        update desired_state_revisions
        set active = true,
            superseded_by_id = null
        where id = any($1::bigint[])
      `,
      [payload.supersededDesiredStateRevisionIds],
    )
  }

  const liveUndoPlan = await buildApprovalUndoLiveWritePlan(db, context, execution.jobId)
  if (liveUndoPlan) {
    await executeApprovalUndoLiveWrite(db, liveUndoPlan)
  }

  await enqueueReconcileAfterUndo(db, {
    catalogGroupId: lineItem.catalog_group_id,
    requestedByUserId: context.requestedByUserId,
    triggerAuditEventId: context.undoAuditEventId,
  })
}

async function undoProposalLineItemRejection(db: PoolClient, context: UndoExecutionContext): Promise<void> {
  const event = context.originalEvent
  if (event.eventType !== 'proposal.line_item.rejected') {
    throw new Error('Undo context did not contain a proposal rejection event.')
  }
  const { payload, undoPayload } = event

  const lineItem = await lockProposalLineItem(db, payload.proposalLineItemId)
  if (lineItem.approval_status !== 'rejected') {
    throw new Error('Cannot undo this rejection because the line item is no longer rejected.')
  }
  if (lineItem.rejected_by_user_id !== payload.nextRejectedByUserId) {
    throw new Error('Cannot undo this rejection because the rejecting user no longer matches the recorded rejection.')
  }

  const conflictingDesiredStateResult = await db.query<{ id: number }>(
    `
      select id
      from desired_state_revisions
      where catalog_group_id = $1
        and target_entity_type = $2
        and target_entity_id = $3
        and field_path = $4
        and active = true
      limit 1
      for update
    `,
    [payload.catalogGroupId, payload.targetEntityType, payload.targetEntityId, payload.fieldPath],
  )
  if (conflictingDesiredStateResult.rows[0]) {
    throw new Error('Cannot undo this rejection because another active desired-state revision now owns the same managed field.')
  }

  await db.query(
    `
      update proposal_line_items
      set approval_status = $2,
          approved_by_user_id = $3,
          rejected_by_user_id = $4,
          approval_updated_at = $5,
          updated_at = now()
      where id = $1
    `,
    [
      lineItem.id,
      undoPayload.previousApprovalStatus,
      undoPayload.previousApprovedByUserId,
      undoPayload.previousRejectedByUserId,
      undoPayload.previousApprovalUpdatedAt,
    ],
  )

  if (payload.deactivatedDesiredStateRevisionIds.length > 0) {
    await db.query(
      `
        update desired_state_revisions
        set active = true
        where id = any($1::bigint[])
      `,
      [payload.deactivatedDesiredStateRevisionIds],
    )
  }

  await enqueueReconcileAfterUndo(db, {
    catalogGroupId: lineItem.catalog_group_id,
    requestedByUserId: context.requestedByUserId,
    triggerAuditEventId: context.undoAuditEventId,
  })
}

async function lockProposalLineItem(db: PoolClient, proposalLineItemId: number): Promise<ProposalLineItemUndoRow> {
  const result = await db.query<ProposalLineItemUndoRow>(
    `
      select
        id,
        catalog_group_id,
        approval_status,
        approved_by_user_id,
        rejected_by_user_id,
        approval_updated_at,
        edited_value_json,
        effective_value_json,
        version,
        notes
      from proposal_line_items
      where id = $1
      for update
    `,
    [proposalLineItemId],
  )

  const row = result.rows[0]
  if (!row) {
    throw new Error(`Proposal line item ${proposalLineItemId} not found.`)
  }
  return row
}

async function lockDesiredStateRevision(db: PoolClient, desiredStateRevisionId: number): Promise<DesiredStateRevisionRow | null> {
  const result = await db.query<DesiredStateRevisionRow>(
    `
      select id, proposal_line_item_id, active
      from desired_state_revisions
      where id = $1
      for update
    `,
    [desiredStateRevisionId],
  )

  return result.rows[0] ?? null
}

async function enqueueReconcileAfterUndo(
  db: PoolClient,
  input: {
    catalogGroupId: number
    requestedByUserId: number | null
    triggerAuditEventId: number | null
  },
): Promise<void> {
  const activeDesiredStateFields = (await listActiveDesiredStateFields(db, input.catalogGroupId)).filter((field) => !field.paused)
  const desiredProjection = buildDesiredProjection(input.catalogGroupId, activeDesiredStateFields)
  const expectedDesiredProjectionHash = getDesiredProjectionHash(desiredProjection)
  const scope = buildCatalogGroupModuleScope(input.catalogGroupId)

  await enqueueJob(db, {
    concurrencyKey: getOptionalSweedSessionConcurrencyKey(true),
    dedupeKey: `reconcile.group:${input.catalogGroupId}`,
    jobType: 'reconcile.group',
    module: 'catalog',
    payload: {
      catalogGroupId: input.catalogGroupId,
      expectedDesiredProjectionHash,
      trigger: 'undo',
      triggerAuditEventId: input.triggerAuditEventId,
    },
    requestedByUserId: input.requestedByUserId,
    scope,
  })
}

function jsonValuesEqual(left: JsonValue | null, right: JsonValue | null): boolean {
  return stableJsonStringify(left) === stableJsonStringify(right)
}

async function buildApprovalUndoLiveWritePlan(
  db: PoolClient,
  context: UndoExecutionContext,
  jobId: number,
): Promise<ApprovalUndoLiveWritePlan | null> {
  const event = context.originalEvent
  if (event.eventType !== 'proposal.line_item.approved') {
    return null
  }

  const remainingDesiredStateResult = await db.query<{ id: number }>(
    `
      select id
      from desired_state_revisions
      where catalog_group_id = $1
        and target_entity_type = $2
        and target_entity_id = $3
        and field_path = $4
        and active = true
      limit 1
    `,
    [event.payload.catalogGroupId, event.payload.targetEntityType, event.payload.targetEntityId, event.payload.fieldPath],
  )
  if (remainingDesiredStateResult.rows[0]) {
    return null
  }

  const originalWriteResult = await db.query<OriginalApprovalWriteSnapshotRow>(
    `
      select cgs.state_json, cg.sweed_group_id
      from write_operations wo
      inner join catalog_group_snapshots cgs on cgs.id = wo.pre_write_snapshot_id
      inner join catalog_groups cg on cg.id = wo.catalog_group_id
      where wo.trigger_event_id = $1
        and wo.status = 'succeeded'
        and wo.pre_write_snapshot_id is not null
      order by wo.finished_at desc nulls last, wo.id desc
      limit 1
    `,
    [context.originalEventId],
  )

  const originalWrite = originalWriteResult.rows[0]
  if (!originalWrite) {
    return null
  }

  const restoredLiveState = NormalizedCatalogGroupLiveStateSchema.parse(originalWrite.state_json)
  const restoredValue = getLiveStateFieldValue(
    restoredLiveState,
    event.payload.targetEntityType,
    event.payload.targetEntityId,
    event.payload.fieldPath,
  )

  const desiredProjectionJson = buildDesiredProjection(event.payload.catalogGroupId, [
    {
      desiredValue: restoredValue,
      fieldPath: event.payload.fieldPath,
      revisionId: 0,
      targetEntityId: event.payload.targetEntityId,
      targetEntityType: event.payload.targetEntityType,
    },
  ])

  return {
    catalogGroupId: event.payload.catalogGroupId,
    desiredProjectionHash: getDesiredProjectionHash(desiredProjectionJson),
    desiredProjectionJson,
    fieldPath: event.payload.fieldPath,
    jobId,
    restoredValue,
    sweedGroupId: originalWrite.sweed_group_id,
    targetEntityId: event.payload.targetEntityId,
    targetEntityType: event.payload.targetEntityType,
    triggerAuditEventId: context.undoAuditEventId,
  }
}

async function executeApprovalUndoLiveWrite(db: PoolClient, plan: ApprovalUndoLiveWritePlan): Promise<void> {
  const currentLiveState = normalizeCatalogGroupDetail(await getProductGroupDetail(plan.sweedGroupId))
  const currentLiveStateHash = hashLiveState(currentLiveState)
  const currentFieldValue = getLiveStateFieldValue(
    currentLiveState,
    plan.targetEntityType,
    plan.targetEntityId,
    plan.fieldPath,
  )

  if (jsonValuesEqual(currentFieldValue, plan.restoredValue)) {
    await insertCatalogGroupSnapshot(db, {
      catalogGroupId: plan.catalogGroupId,
      source: 'undo',
      stateHash: currentLiveStateHash,
      stateJson: currentLiveState,
    })
    await updateCatalogGroupLiveState(db, {
      catalogGroupId: plan.catalogGroupId,
      driftedAt: null,
      liveState: currentLiveState,
      liveStateHash: currentLiveStateHash,
      reconcileStatus: 'queued',
    })
    return
  }

  const preWriteSnapshotId = await insertCatalogGroupSnapshot(db, {
    catalogGroupId: plan.catalogGroupId,
    source: 'pre_write',
    stateHash: currentLiveStateHash,
    stateJson: currentLiveState,
  })

  const writeOperationId = await insertUndoWriteOperation(db, {
    catalogGroupId: plan.catalogGroupId,
    desiredProjectionHash: plan.desiredProjectionHash,
    desiredProjectionJson: plan.desiredProjectionJson,
    jobId: plan.jobId,
    preWriteSnapshotId,
    requestJson: buildUndoWriteRequestJson(plan),
    triggerAuditEventId: plan.triggerAuditEventId,
  })

  await updateCatalogGroupLiveState(db, {
    catalogGroupId: plan.catalogGroupId,
    driftedAt: new Date(),
    liveState: currentLiveState,
    liveStateHash: currentLiveStateHash,
    reconcileStatus: 'applying',
  })

  const responseJson = await applyApprovalUndoLiveWrite(plan)
  const postWriteLiveState = normalizeCatalogGroupDetail(await getProductGroupDetail(plan.sweedGroupId))
  const postWriteLiveStateHash = hashLiveState(postWriteLiveState)
  const restoredFieldValue = getLiveStateFieldValue(
    postWriteLiveState,
    plan.targetEntityType,
    plan.targetEntityId,
    plan.fieldPath,
  )
  const postWriteSnapshotId = await insertCatalogGroupSnapshot(db, {
    catalogGroupId: plan.catalogGroupId,
    source: 'undo',
    stateHash: postWriteLiveStateHash,
    stateJson: postWriteLiveState,
  })

  if (!jsonValuesEqual(restoredFieldValue, plan.restoredValue)) {
    const errorMessage = buildUndoVerificationMismatchMessage(plan, restoredFieldValue)
    await updateUndoWriteOperationOutcome(db, {
      error: errorMessage,
      postWriteSnapshotId,
      responseJson,
      status: 'verified_mismatch',
      writeOperationId,
    })
    await updateCatalogGroupLiveState(db, {
      catalogGroupId: plan.catalogGroupId,
      driftedAt: new Date(),
      liveState: postWriteLiveState,
      liveStateHash: postWriteLiveStateHash,
      reconcileStatus: 'error',
    })
    throw new Error(errorMessage)
  }

  await updateUndoWriteOperationOutcome(db, {
    error: null,
    postWriteSnapshotId,
    responseJson,
    status: 'succeeded',
    writeOperationId,
  })
  await updateCatalogGroupLiveState(db, {
    catalogGroupId: plan.catalogGroupId,
    driftedAt: null,
    liveState: postWriteLiveState,
    liveStateHash: postWriteLiveStateHash,
    reconcileStatus: 'queued',
  })
}

async function applyApprovalUndoLiveWrite(plan: ApprovalUndoLiveWritePlan): Promise<Record<string, unknown>> {
  if (plan.targetEntityType === 'catalog_group' && plan.fieldPath === 'description') {
    if (typeof plan.restoredValue !== 'string') {
      throw new Error('Undo restore for description requires a text value.')
    }

    const normalizedDescription = normalizeDescriptionText(plan.restoredValue)
    const medicalClaimIssues = findDescriptionMedicalClaimIssues(normalizedDescription)
    if (medicalClaimIssues.length > 0) {
      throw new Error(`Undo restore blocked description apply: ${medicalClaimIssues.join(', ')}`)
    }

    const response = await editProductGroupDescription(plan.sweedGroupId, normalizedDescription)
    return {
      fieldPath: plan.fieldPath,
      kind: 'group_description',
      response,
      targetEntityId: plan.targetEntityId,
      targetEntityType: plan.targetEntityType,
    }
  }

  if (plan.targetEntityType === 'catalog_product' && plan.fieldPath === 'products.price') {
    if (typeof plan.restoredValue !== 'number' || !Number.isFinite(plan.restoredValue)) {
      throw new Error('Undo restore for product price requires a numeric price value.')
    }

    const response = await editProductPrice(plan.targetEntityId, plan.restoredValue)
    await waitForProductPrice(plan.targetEntityId, plan.restoredValue)
    return {
      desiredPrice: plan.restoredValue,
      fieldPath: plan.fieldPath,
      kind: 'product_price',
      response,
      targetEntityId: plan.targetEntityId,
      targetEntityType: plan.targetEntityType,
    }
  }

  throw new Error(`Undo restore does not support ${plan.targetEntityType} ${plan.fieldPath}.`)
}

function buildUndoWriteRequestJson(plan: ApprovalUndoLiveWritePlan): Record<string, unknown> {
  if (plan.targetEntityType === 'catalog_group' && plan.fieldPath === 'description') {
    return {
      description: typeof plan.restoredValue === 'string' ? normalizeDescriptionText(plan.restoredValue) : plan.restoredValue,
      fieldPath: plan.fieldPath,
      kind: 'group_description',
      sweedGroupId: plan.sweedGroupId,
      targetEntityId: plan.targetEntityId,
      targetEntityType: plan.targetEntityType,
    }
  }

  return {
    desiredPrice: plan.restoredValue,
    fieldPath: plan.fieldPath,
    kind: 'product_price',
    targetEntityId: plan.targetEntityId,
    targetEntityType: plan.targetEntityType,
  }
}

function buildUndoVerificationMismatchMessage(
  plan: ApprovalUndoLiveWritePlan,
  restoredFieldValue: JsonValue | null,
): string {
  return `Undo restore verification mismatch for ${plan.targetEntityType} ${plan.fieldPath} ${plan.targetEntityId}. Expected ${formatUndoValue(plan.restoredValue)}, got ${formatUndoValue(restoredFieldValue)}.`
}

function formatUndoValue(value: JsonValue | null): string {
  if (typeof value === 'string') {
    return JSON.stringify(value)
  }
  return String(value)
}

async function insertUndoWriteOperation(
  db: PoolClient,
  input: {
    catalogGroupId: number
    desiredProjectionHash: string
    desiredProjectionJson: ReturnType<typeof buildDesiredProjection>
    jobId: number
    preWriteSnapshotId: number
    requestJson: unknown
    triggerAuditEventId: number | null
  },
): Promise<number> {
  const result = await db.query<WriteOperationInsertRow>(
    `
      insert into write_operations (
        catalog_group_id,
        operation_type,
        trigger_event_id,
        job_id,
        desired_projection_json,
        desired_projection_hash,
        status,
        attempt_count,
        pre_write_snapshot_id,
        request_json,
        started_at
      )
      values ($1, 'undo', $2, $3, $4::jsonb, $5, 'running', 1, $6, $7::jsonb, now())
      returning id
    `,
    [
      input.catalogGroupId,
      input.triggerAuditEventId,
      input.jobId,
      JSON.stringify(input.desiredProjectionJson),
      input.desiredProjectionHash,
      input.preWriteSnapshotId,
      JSON.stringify(input.requestJson),
    ],
  )

  return result.rows[0].id
}

async function updateUndoWriteOperationOutcome(
  db: PoolClient,
  input: {
    error: string | null
    postWriteSnapshotId: number | null
    responseJson: unknown
    status: 'succeeded' | 'verified_mismatch'
    writeOperationId: number
  },
): Promise<void> {
  await db.query(
    `
      update write_operations
      set status = $2,
          post_write_snapshot_id = $3,
          response_json = $4::jsonb,
          error = $5,
          finished_at = now(),
          updated_at = now()
      where id = $1
    `,
    [input.writeOperationId, input.status, input.postWriteSnapshotId, JSON.stringify(input.responseJson), input.error],
  )
}
