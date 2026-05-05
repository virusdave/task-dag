import type { QueryResultRow } from 'pg'

import type { ReconcileGroupJobPayload } from '../../shared/contracts/domain/jobs.js'
import { getPool, type Queryable } from '../../server/db/pool.js'
import { listActiveDesiredStateFields } from '../../server/db/queries/desiredStateQueries.js'
import {
  buildDesiredProjection,
  getDesiredProjectionHash,
  type DesiredProjection,
  type DesiredProjectionField,
} from '../../server/domain/desiredProjection.js'
import { withTransaction } from '../../server/db/tx.js'
import {
  findDescriptionMedicalClaimIssues,
  normalizeCatalogGroupDetail,
  normalizeDescriptionText,
  type NormalizedCatalogGroupLiveState,
} from '../catalog/liveState.js'
import { RetryableWorkerError, isRetryableWorkerError } from '../runtime/errors.js'
import { assessDesiredProjectionAgainstLiveState, formatProjectionFieldLabel } from '../reconcile/managedFields.js'
import { editProductGroupDescription, editProductPrice, getProductGroupDetail, waitForProductPrice } from '../sweed/client.js'
import { getCatalogGroupRecord, hashLiveState, insertCatalogGroupSnapshot, updateCatalogGroupLiveState } from './catalogGroupPersistence.js'

interface WriteOperationInsertRow extends QueryResultRow {
  id: number
}

interface ReconcileWriteActionBase {
  field: DesiredProjectionField
}

interface GroupDescriptionWriteAction extends ReconcileWriteActionBase {
  description: string
  kind: 'group_description'
}

interface ProductPriceWriteAction extends ReconcileWriteActionBase {
  desiredPrice: number
  kind: 'product_price'
  productId: number
}

type ReconcileWriteAction = GroupDescriptionWriteAction | ProductPriceWriteAction

interface ReconcilePreparationResult {
  desiredProjectionHash: string
  writeActions: ReconcileWriteAction[]
  writeOperationId: number
}

export async function runReconcileGroupJob(
  context: { id: number },
  payload: ReconcileGroupJobPayload,
): Promise<void> {
  const pool = getPool()
  const group = await getCatalogGroupRecord(pool, payload.catalogGroupId)
  const preWriteLiveState = normalizeCatalogGroupDetail(await getProductGroupDetail(group.sweedGroupId))
  const preWriteLiveStateHash = hashLiveState(preWriteLiveState)

  const preparation = await withTransaction(async (db) => {
    await getCatalogGroupRecord(db, payload.catalogGroupId, { forUpdate: true })

    const enforcedFields = (await listActiveDesiredStateFields(db, payload.catalogGroupId)).filter((field) => !field.paused)
    const desiredProjection = buildDesiredProjection(payload.catalogGroupId, enforcedFields)
    const desiredProjectionHash = getDesiredProjectionHash(desiredProjection)
    const assessment = assessDesiredProjectionAgainstLiveState(preWriteLiveState, desiredProjection.fields)

    await insertCatalogGroupSnapshot(db, {
      catalogGroupId: payload.catalogGroupId,
      source: 'sync',
      stateHash: preWriteLiveStateHash,
      stateJson: preWriteLiveState,
    })

    if (desiredProjection.fields.length === 0 || assessment.driftedFields.length === 0) {
      await updateCatalogGroupLiveState(db, {
        catalogGroupId: payload.catalogGroupId,
        driftedAt: null,
        liveState: preWriteLiveState,
        liveStateHash: preWriteLiveStateHash,
        reconcileStatus: 'in_sync',
      })
      return null
    }

    const preWriteSnapshotId = await insertCatalogGroupSnapshot(db, {
      catalogGroupId: payload.catalogGroupId,
      source: 'pre_write',
      stateHash: preWriteLiveStateHash,
      stateJson: preWriteLiveState,
    })

    if (assessment.unsupportedWriteFields.length > 0) {
      const errorMessage = `Reconcile cannot apply unsupported desired fields: ${assessment.unsupportedWriteFields
        .map(formatProjectionFieldLabel)
        .join(', ')}`
      await insertFailedWriteOperation(db, {
        catalogGroupId: payload.catalogGroupId,
        desiredProjection,
        desiredProjectionHash,
        error: errorMessage,
        jobId: context.id,
        preWriteSnapshotId,
        triggerAuditEventId: payload.triggerAuditEventId ?? null,
      })
      await updateCatalogGroupLiveState(db, {
        catalogGroupId: payload.catalogGroupId,
        driftedAt: new Date(),
        liveState: preWriteLiveState,
        liveStateHash: preWriteLiveStateHash,
        reconcileStatus: 'error',
      })
      throw new Error(errorMessage)
    }

    let writeActions: ReconcileWriteAction[]
    try {
      writeActions = buildWriteActions(assessment.driftedFields)
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Reconcile could not build a supported write plan.'
      await insertFailedWriteOperation(db, {
        catalogGroupId: payload.catalogGroupId,
        desiredProjection,
        desiredProjectionHash,
        error: errorMessage,
        jobId: context.id,
        preWriteSnapshotId,
        triggerAuditEventId: payload.triggerAuditEventId ?? null,
      })
      await updateCatalogGroupLiveState(db, {
        catalogGroupId: payload.catalogGroupId,
        driftedAt: new Date(),
        liveState: preWriteLiveState,
        liveStateHash: preWriteLiveStateHash,
        reconcileStatus: 'error',
      })
      throw error
    }

    if (writeActions.length === 0) {
      const errorMessage = 'Reconcile found drift but could not derive a supported write patch.'
      await insertFailedWriteOperation(db, {
        catalogGroupId: payload.catalogGroupId,
        desiredProjection,
        desiredProjectionHash,
        error: errorMessage,
        jobId: context.id,
        preWriteSnapshotId,
        triggerAuditEventId: payload.triggerAuditEventId ?? null,
      })
      await updateCatalogGroupLiveState(db, {
        catalogGroupId: payload.catalogGroupId,
        driftedAt: new Date(),
        liveState: preWriteLiveState,
        liveStateHash: preWriteLiveStateHash,
        reconcileStatus: 'error',
      })
      throw new Error(errorMessage)
    }

    const descriptionWrite = writeActions.find(
      (action): action is GroupDescriptionWriteAction => action.kind === 'group_description',
    )
    if (descriptionWrite) {
      const medicalClaimIssues = findDescriptionMedicalClaimIssues(descriptionWrite.description)
      if (medicalClaimIssues.length > 0) {
        const errorMessage = `Reconcile blocked description apply: ${medicalClaimIssues.join(', ')}`
        await insertFailedWriteOperation(db, {
          catalogGroupId: payload.catalogGroupId,
          desiredProjection,
          desiredProjectionHash,
          error: errorMessage,
          jobId: context.id,
          preWriteSnapshotId,
          triggerAuditEventId: payload.triggerAuditEventId ?? null,
        })
        await updateCatalogGroupLiveState(db, {
          catalogGroupId: payload.catalogGroupId,
          driftedAt: new Date(),
          liveState: preWriteLiveState,
          liveStateHash: preWriteLiveStateHash,
          reconcileStatus: 'error',
        })
        throw new Error(errorMessage)
      }
    }

    const writeOperationId = await insertRunningWriteOperation(db, {
      catalogGroupId: payload.catalogGroupId,
      desiredProjection,
      desiredProjectionHash,
      jobId: context.id,
      preWriteSnapshotId,
      requestJson: { operations: serializeWriteActions(writeActions), sweedGroupId: group.sweedGroupId },
      triggerAuditEventId: payload.triggerAuditEventId ?? null,
    })

    await updateCatalogGroupLiveState(db, {
      catalogGroupId: payload.catalogGroupId,
      driftedAt: new Date(),
      liveState: preWriteLiveState,
      liveStateHash: preWriteLiveStateHash,
      reconcileStatus: 'applying',
    })

    return {
      desiredProjectionHash,
      writeActions,
      writeOperationId,
    } satisfies ReconcilePreparationResult
  })

  if (!preparation) {
    return
  }

  const writeResponses: Array<Record<string, unknown>> = []
  let postWriteLiveState: NormalizedCatalogGroupLiveState
  let postWriteLiveStateHash: string

  try {
    for (const action of preparation.writeActions) {
      if (action.kind === 'group_description') {
        const response = await editProductGroupDescription(group.sweedGroupId, action.description)
        writeResponses.push({
          fieldPath: action.field.fieldPath,
          kind: action.kind,
          response,
          targetEntityId: action.field.targetEntityId,
          targetEntityType: action.field.targetEntityType,
        })
        continue
      }

      const response = await editProductPrice(action.productId, action.desiredPrice)
      writeResponses.push({
        desiredPrice: action.desiredPrice,
        fieldPath: action.field.fieldPath,
        kind: action.kind,
        response,
        targetEntityId: action.field.targetEntityId,
        targetEntityType: action.field.targetEntityType,
      })
      await waitForProductPrice(action.productId, action.desiredPrice)
    }

    postWriteLiveState = normalizeCatalogGroupDetail(await getProductGroupDetail(group.sweedGroupId))
    postWriteLiveStateHash = hashLiveState(postWriteLiveState)
  } catch (error) {
    const refreshedState = await refreshLiveStateAfterFailure(group.sweedGroupId, preWriteLiveState)
    await finalizeFailedWriteAttempt({
      catalogGroupId: payload.catalogGroupId,
      liveState: refreshedState.liveState,
      liveStateHash: refreshedState.liveStateHash,
      retryable: isRetryableWorkerError(error),
      writeOperationId: preparation.writeOperationId,
      writeResponseJson: writeResponses.length > 0 ? { operations: writeResponses } : null,
      errorMessage: error instanceof Error ? error.message : 'Unknown reconcile worker error.',
    })
    throw error
  }

  const postWriteSnapshotId = await withTransaction(async (db) => {
    return insertCatalogGroupSnapshot(db, {
      catalogGroupId: payload.catalogGroupId,
      source: 'post_write',
      stateHash: postWriteLiveStateHash,
      stateJson: postWriteLiveState,
    })
  })

  const attemptedAssessment = assessDesiredProjectionAgainstLiveState(
    postWriteLiveState,
    preparation.writeActions.map((action) => action.field),
  )

  const followUp = await withTransaction(async (db) => {
    const latestEnforcedFields = (await listActiveDesiredStateFields(db, payload.catalogGroupId)).filter((field) => !field.paused)
    const latestDesiredProjection = buildDesiredProjection(payload.catalogGroupId, latestEnforcedFields)
    const latestDesiredProjectionHash = getDesiredProjectionHash(latestDesiredProjection)
    const latestAssessment = assessDesiredProjectionAgainstLiveState(postWriteLiveState, latestDesiredProjection.fields)

    if (attemptedAssessment.driftedFields.length > 0) {
      const errorMessage = `Read-after-write verification mismatch for desired fields: ${attemptedAssessment.driftedFields
        .map(formatProjectionFieldLabel)
        .join(', ')}`
      await updateWriteOperationOutcome(db, {
        error: errorMessage,
        postWriteSnapshotId,
        responseJson: { operations: writeResponses },
        status: 'verified_mismatch',
        writeOperationId: preparation.writeOperationId,
      })
      await updateCatalogGroupLiveState(db, {
        catalogGroupId: payload.catalogGroupId,
        driftedAt: new Date(),
        liveState: postWriteLiveState,
        liveStateHash: postWriteLiveStateHash,
        reconcileStatus: 'error',
      })
      throw new Error(errorMessage)
    }

    await updateWriteOperationOutcome(db, {
      error: null,
      postWriteSnapshotId,
      responseJson: { operations: writeResponses },
      status: 'succeeded',
      writeOperationId: preparation.writeOperationId,
    })

    if (latestAssessment.driftedFields.length === 0) {
      await updateCatalogGroupLiveState(db, {
        catalogGroupId: payload.catalogGroupId,
        driftedAt: null,
        liveState: postWriteLiveState,
        liveStateHash: postWriteLiveStateHash,
        reconcileStatus: 'in_sync',
      })
      return null
    }

    const nextStatus = latestAssessment.unsupportedWriteFields.length === 0 ? 'queued' : 'drifted'
    await updateCatalogGroupLiveState(db, {
      catalogGroupId: payload.catalogGroupId,
      driftedAt: new Date(),
      liveState: postWriteLiveState,
      liveStateHash: postWriteLiveStateHash,
      reconcileStatus: nextStatus,
    })

    if (latestAssessment.unsupportedWriteFields.length > 0) {
      throw new Error(
        `Reconcile left drift on unsupported desired fields: ${latestAssessment.unsupportedWriteFields
          .map(formatProjectionFieldLabel)
          .join(', ')}`,
      )
    }

    if (latestDesiredProjectionHash !== preparation.desiredProjectionHash) {
      return new RetryableWorkerError('Desired state changed during reconcile; retrying the latest approved projection.')
    }

    return new RetryableWorkerError('Catalog group is still drifted after apply; retrying reconcile.')
  })

  if (followUp) {
    throw followUp
  }
}

async function finalizeFailedWriteAttempt(
  input: {
    catalogGroupId: number
    errorMessage: string
    liveState: NormalizedCatalogGroupLiveState
    liveStateHash: string
    retryable: boolean
    writeOperationId: number
    writeResponseJson: unknown
  },
): Promise<void> {
  await withTransaction(async (tx) => {
    await updateWriteOperationOutcome(tx, {
      error: input.errorMessage,
      postWriteSnapshotId: null,
      responseJson: input.writeResponseJson,
      status: 'failed',
      writeOperationId: input.writeOperationId,
    })
    await updateCatalogGroupLiveState(tx, {
      catalogGroupId: input.catalogGroupId,
      driftedAt: new Date(),
      liveState: input.liveState,
      liveStateHash: input.liveStateHash,
      reconcileStatus: input.retryable ? 'queued' : 'error',
    })
  })
}

async function insertFailedWriteOperation(
  db: Queryable,
  input: {
    catalogGroupId: number
    desiredProjection: DesiredProjection
    desiredProjectionHash: string
    error: string
    jobId: number
    preWriteSnapshotId: number
    triggerAuditEventId: number | null
  },
): Promise<void> {
  await db.query(
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
        error,
        started_at,
        finished_at
      )
      values ($1, 'apply', $2, $3, $4::jsonb, $5, 'failed', 1, $6, $7, now(), now())
    `,
    [
      input.catalogGroupId,
      input.triggerAuditEventId,
      input.jobId,
      JSON.stringify(input.desiredProjection),
      input.desiredProjectionHash,
      input.preWriteSnapshotId,
      input.error,
    ],
  )
}

async function insertRunningWriteOperation(
  db: Queryable,
  input: {
    catalogGroupId: number
    desiredProjection: DesiredProjection
    desiredProjectionHash: string
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
      values ($1, 'apply', $2, $3, $4::jsonb, $5, 'running', 1, $6, $7::jsonb, now())
      returning id
    `,
    [
      input.catalogGroupId,
      input.triggerAuditEventId,
      input.jobId,
      JSON.stringify(input.desiredProjection),
      input.desiredProjectionHash,
      input.preWriteSnapshotId,
      JSON.stringify(input.requestJson),
    ],
  )

  return result.rows[0].id
}

async function updateWriteOperationOutcome(
  db: Queryable,
  input: {
    error: string | null
    postWriteSnapshotId: number | null
    responseJson: unknown
    status: 'failed' | 'succeeded' | 'verified_mismatch'
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
    [
      input.writeOperationId,
      input.status,
      input.postWriteSnapshotId,
      toJsonbParameter(input.responseJson),
      input.error,
    ],
  )
}

function toJsonbParameter(value: unknown): string {
  return JSON.stringify(value === undefined ? null : value)
}

function buildWriteActions(fields: DesiredProjectionField[]): ReconcileWriteAction[] {
  const actions: ReconcileWriteAction[] = []

  for (const field of fields) {
    if (field.targetEntityType === 'catalog_group' && field.fieldPath === 'description') {
      actions.push({
        description: normalizeDescriptionText(
          typeof field.desiredValue === 'string' ? field.desiredValue : String(field.desiredValue ?? ''),
        ),
        field,
        kind: 'group_description',
      })
      continue
    }

    if (field.targetEntityType === 'catalog_product' && field.fieldPath === 'products.price') {
      if (typeof field.desiredValue !== 'number' || !Number.isFinite(field.desiredValue)) {
        throw new Error(`Desired price for ${formatProjectionFieldLabel(field)} must be a finite number.`)
      }

      actions.push({
        desiredPrice: field.desiredValue,
        field,
        kind: 'product_price',
        productId: field.targetEntityId,
      })
    }
  }

  return actions
}

function serializeWriteActions(actions: ReconcileWriteAction[]): Array<Record<string, unknown>> {
  return actions.map((action) => {
    if (action.kind === 'group_description') {
      return {
        description: action.description,
        fieldPath: action.field.fieldPath,
        kind: action.kind,
        targetEntityId: action.field.targetEntityId,
        targetEntityType: action.field.targetEntityType,
      }
    }

    return {
      desiredPrice: action.desiredPrice,
      fieldPath: action.field.fieldPath,
      kind: action.kind,
      targetEntityId: action.field.targetEntityId,
      targetEntityType: action.field.targetEntityType,
    }
  })
}

async function refreshLiveStateAfterFailure(
  sweedGroupId: number,
  fallbackLiveState: NormalizedCatalogGroupLiveState,
): Promise<{ liveState: NormalizedCatalogGroupLiveState; liveStateHash: string }> {
  try {
    const liveState = normalizeCatalogGroupDetail(await getProductGroupDetail(sweedGroupId))
    return {
      liveState,
      liveStateHash: hashLiveState(liveState),
    }
  } catch {
    return {
      liveState: fallbackLiveState,
      liveStateHash: hashLiveState(fallbackLiveState),
    }
  }
}
