import type {
  AuditEntityType,
  CatalogReviewRerunRowJobPayload,
  ScopeKind,
  ScopeRef,
} from '../../shared/contracts/index.js'
import { getPool } from '../../server/db/pool.js'
import { withTransaction } from '../../server/db/tx.js'
import { enqueueJob } from '../../server/jobs/enqueueJob.js'
import { appendAuditEvent } from '../../server/audit/appendAuditEvent.js'
import type { JobHandlerContext } from '../runtime/jobRegistry.js'

interface RerunDispatchResult {
  dispatchedJobIds: number[]
  notes: string[]
}

/**
 * Dispatch the right concrete rerun for the given scope. Reuses existing
 * helpers (LLM debug rerun, pending-purchase packet regenerate, catalog
 * group sync) rather than introducing a parallel rerun pipeline.
 */
async function dispatchByScope(
  payload: CatalogReviewRerunRowJobPayload,
): Promise<RerunDispatchResult> {
  const dispatchedJobIds: number[] = []
  const notes: string[] = []
  const scopeKind: ScopeKind = payload.scopeKind
  const scopeRef: ScopeRef = payload.scopeRef

  await withTransaction(async (db) => {
    if (scopeKind === 'proposal_line_item') {
      const lineItemId = Number(scopeRef.id)
      const lookup = await db.query<{ catalog_group_id: number | null; proposal_batch_id: number | null }>(
        `
          select pli.proposal_batch_id, pb.catalog_group_id
          from proposal_line_items pli
          join proposal_batches pb on pb.id = pli.proposal_batch_id
          where pli.id = $1
          limit 1
        `,
        [lineItemId],
      )
      const found = lookup.rows[0]
      if (!found?.catalog_group_id || !found.proposal_batch_id) {
        notes.push(`No proposal_line_item found for id ${lineItemId}; nothing to rerun.`)
        return
      }

      const llmRunInsert = await db.query<{ id: number }>(
        `
          insert into llm_runs (
            catalog_group_id,
            purpose,
            model,
            prompt_version,
            input_json,
            raw_output_text,
            parsed_output_json,
            validation_issues_json,
            forced_refresh,
            status,
            created_by_user_id
          )
          values ($1, 'description', 'rerun-row', 'rerun-row', '{}'::jsonb, '', null, '[]'::jsonb, false, 'queued', $2)
          returning id
        `,
        [found.catalog_group_id, payload.requestedByUserId ?? null],
      )
      const jobId = await enqueueJob(db, {
        jobType: 'llm.debug.rerun',
        module: 'catalog',
        payload: {
          catalogGroupId: found.catalog_group_id,
          forceLiveRefresh: false,
          llmRunId: llmRunInsert.rows[0].id,
          purpose: 'description',
          requestedByUserId: payload.requestedByUserId ?? null,
        },
        requestedByUserId: payload.requestedByUserId ?? null,
        scope: { entityType: 'catalog_group', entityId: String(found.catalog_group_id) },
      })
      dispatchedJobIds.push(jobId)
      await db.query('update llm_runs set job_id = $2 where id = $1', [llmRunInsert.rows[0].id, jobId])
      notes.push(`Queued llm.debug.rerun job ${jobId} for proposal_line_item ${lineItemId}.`)
      return
    }

    if (scopeKind === 'pending_purchase_row' || scopeKind === 'pending_purchase_packet') {
      const packetLookup = await db.query<{ packet_id: number | null; from_date: string | null; to_date: string | null }>(
        scopeKind === 'pending_purchase_row'
          ? `
              select pp.id as packet_id, pp.from_date, pp.to_date
              from pending_purchase_rows ppr
              join pending_purchase_packets pp on pp.id = ppr.packet_id
              where ppr.id = $1
              limit 1
            `
          : `
              select id as packet_id, from_date, to_date
              from pending_purchase_packets
              where id = $1
              limit 1
            `,
        [Number(scopeRef.id)],
      )
      const packet = packetLookup.rows[0]
      if (!packet?.packet_id || !packet.from_date || !packet.to_date) {
        notes.push(`No pending_purchase_packet found for ${scopeKind} id ${scopeRef.id}; nothing to rerun.`)
        return
      }
      const jobId = await enqueueJob(db, {
        jobType: 'catalog.pending_purchases.generate',
        module: 'catalog',
        payload: {
          fromDate: String(packet.from_date),
          requestedByUserId: payload.requestedByUserId ?? null,
          siteDealerIds: [],
          toDate: String(packet.to_date),
        },
        requestedByUserId: payload.requestedByUserId ?? null,
        scope: null,
      })
      dispatchedJobIds.push(jobId)
      notes.push(`Queued catalog.pending_purchases.generate job ${jobId} for ${scopeKind} ${scopeRef.id}.`)
      return
    }

    if (scopeKind === 'catalog_group') {
      const groupId = Number(scopeRef.id)
      const jobId = await enqueueJob(db, {
        jobType: 'catalog.sync.group_detail',
        module: 'catalog',
        payload: {
          catalogGroupId: groupId,
          forceLiveRefresh: true,
          requestedByUserId: payload.requestedByUserId ?? null,
          trigger: 'manual_refresh',
        },
        requestedByUserId: payload.requestedByUserId ?? null,
        scope: { entityType: 'catalog_group', entityId: String(groupId) },
      })
      dispatchedJobIds.push(jobId)
      notes.push(`Queued catalog.sync.group_detail job ${jobId} for catalog_group ${groupId}.`)
      return
    }

    notes.push(`No rerun handler registered for scope kind ${scopeKind}; recording rerun request without dispatch.`)
  })

  return { dispatchedJobIds, notes }
}

export async function runCatalogReviewRerunRowJob(
  context: JobHandlerContext,
  payload: CatalogReviewRerunRowJobPayload,
): Promise<void> {
  const result = await dispatchByScope(payload)
  await withTransaction(async (db) => {
    await appendAuditEvent(db, {
      actorType: payload.requestedByUserId ? 'user' : 'system',
      actorUserId: payload.requestedByUserId ?? null,
      entityId: String(payload.scopeRef.id),
      entityType: scopeKindToEntityType(payload.scopeKind),
      eventType: 'catalog.review.row.rerun_requested',
      module: 'catalog',
      payload: {
        scopeKind: payload.scopeKind,
        scopeRef: payload.scopeRef,
        reason: payload.reason ?? null,
        triggeringJobId: context.id,
        dispatchedJobIds: result.dispatchedJobIds,
        notes: result.notes,
      },
      requestId: null,
      undoPayload: null,
    })
  })
  void getPool
}

export function scopeKindToEntityType(scopeKind: ScopeKind): AuditEntityType {
  switch (scopeKind) {
    case 'catalog_group':
      return 'catalog_group'
    case 'pending_purchase_row':
      return 'pending_purchase_row'
    case 'pending_purchase_packet':
      return 'pending_purchase_packet'
    case 'proposal_line_item':
      return 'proposal_line_item'
    case 'proposal_batch':
      return 'proposal_batch'
    case 'catalog_brand':
      return 'catalog_brand'
    case 'catalog_item':
      return 'catalog_item'
    case 'write_operation':
      return 'write_operation'
    case 'job':
      return 'job'
    case 'audit_event':
      return 'catalog_group'
  }
}

export const __test__ = { dispatchByScope, scopeKindToEntityType }
