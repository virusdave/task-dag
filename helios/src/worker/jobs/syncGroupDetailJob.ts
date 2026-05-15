import { buildCatalogGroupModuleScope, type ReconcileStatus } from '../../shared/contracts/index.js'
import type { CatalogSyncGroupDetailJobPayload } from '../../shared/contracts/domain/jobs.js'
import { getPool } from '../../server/db/pool.js'
import { withTransaction } from '../../server/db/tx.js'
import { listActiveDesiredStateFields } from '../../server/db/queries/desiredStateQueries.js'
import { buildDesiredProjection, getDesiredProjectionHash } from '../../server/domain/desiredProjection.js'
import { getOptionalSweedSessionConcurrencyKey } from '../../server/jobs/concurrency.js'
import { enqueueJob } from '../../server/jobs/enqueueJob.js'
import { normalizeCatalogGroupDetail } from '../catalog/liveState.js'
import { getCatalogGroupRecord, hashLiveState, insertCatalogGroupSnapshot, updateCatalogGroupLiveState } from './catalogGroupPersistence.js'
import { assessDesiredProjectionAgainstLiveState } from '../reconcile/managedFields.js'
import { getProductGroupDetail } from '../sweed/client.js'

export async function runCatalogSyncGroupDetailJob(payload: CatalogSyncGroupDetailJobPayload): Promise<void> {
  const group = await getCatalogGroupRecord(getPool(), payload.catalogGroupId)
  const liveState = normalizeCatalogGroupDetail(await getProductGroupDetail(group.sweedGroupId))
  const liveStateHash = hashLiveState(liveState)

  await withTransaction(async (db) => {
    await getCatalogGroupRecord(db, payload.catalogGroupId, { forUpdate: true })

    const activeDesiredStateFields = (await listActiveDesiredStateFields(db, payload.catalogGroupId)).filter((field) => !field.paused)
    const desiredProjection = buildDesiredProjection(payload.catalogGroupId, activeDesiredStateFields)
    const desiredProjectionHash = getDesiredProjectionHash(desiredProjection)
    const assessment = assessDesiredProjectionAgainstLiveState(liveState, desiredProjection.fields)

    let nextReconcileStatus: ReconcileStatus = 'in_sync'
    let driftedAt: Date | null = null

    if (assessment.driftedFields.length > 0) {
      driftedAt = new Date()
      nextReconcileStatus = assessment.unsupportedWriteFields.length === 0 ? 'queued' : 'drifted'
    }

    await insertCatalogGroupSnapshot(db, {
      catalogGroupId: payload.catalogGroupId,
      source: 'sync',
      stateHash: liveStateHash,
      stateJson: liveState,
    })
    await updateCatalogGroupLiveState(db, {
      catalogGroupId: payload.catalogGroupId,
      driftedAt,
      liveState,
      liveStateHash,
      reconcileStatus: nextReconcileStatus,
    })

    if (nextReconcileStatus === 'queued') {
      const scope = buildCatalogGroupModuleScope(payload.catalogGroupId)
      await enqueueJob(db, {
        concurrencyKey: getOptionalSweedSessionConcurrencyKey(true),
        dedupeKey: `reconcile.group:${payload.catalogGroupId}`,
        jobType: 'reconcile.group',
        module: 'catalog',
        payload: {
          catalogGroupId: payload.catalogGroupId,
          expectedDesiredProjectionHash: desiredProjectionHash,
          trigger: 'drift_sync',
          triggerAuditEventId: null,
        },
        requestedByUserId: payload.requestedByUserId ?? null,
        scope,
      })
    }
  })
}
