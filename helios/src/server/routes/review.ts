import { randomUUID } from 'node:crypto'

import type { FastifyInstance } from 'fastify'
import type { PoolClient, QueryResultRow } from 'pg'

import {
  buildCatalogGroupModuleScope,
  ApproveProposalLineItemRequestSchema,
  EditProposalLineItemRequestSchema,
  MutationAcceptedResponseSchema,
  RejectProposalLineItemRequestSchema,
  ReviewFamilyQueueQuerySchema,
  ReviewFamilyQueueResponseSchema,
  ReviewLineItemListQuerySchema,
  ReviewLineItemListResponseSchema,
  UpdateProposalLineItemNoteRequestSchema,
  type ProposalLineItemApprovalUndoPayload,
  type ProposalLineItemApprovedAuditPayload,
  type ProposalLineItemEditedAuditPayload,
  type ProposalLineItemEditedUndoPayload,
  type ProposalLineItemNoteUpdatedAuditPayload,
  type ProposalLineItemNoteUpdatedUndoPayload,
  type ProposalLineItemRejectedAuditPayload,
} from '../../shared/contracts/index.js'
import type { JsonValue } from '../../shared/contracts/common/json.js'
import type { FieldPath } from '../../shared/domain/fieldPaths.js'
import { appendAuditEvent } from '../audit/appendAuditEvent.js'
import { requireSessionUser } from '../auth/requireSession.js'
import { getPool } from '../db/pool.js'
import { listActiveDesiredStateFields } from '../db/queries/desiredStateQueries.js'
import { buildDesiredProjection, getDesiredProjectionHash } from '../domain/desiredProjection.js'
import { listReviewFamilyQueue } from '../db/queries/reviewFamilyQueueQueries.js'
import { listReviewLineItems } from '../db/queries/reviewQueries.js'
import { getOptionalSweedSessionConcurrencyKey } from '../jobs/concurrency.js'
import { withTransaction } from '../db/tx.js'
import { enqueueJob } from '../jobs/enqueueJob.js'

interface ProposalLineItemRow extends QueryResultRow {
  approval_status: 'approved' | 'pending' | 'rejected' | 'superseded'
  approval_updated_at: Date | null
  approved_by_user_id: number | null
  catalog_group_id: number
  edited_value_json: JsonValue | null
  effective_value_json: JsonValue
  field_path: FieldPath
  id: number
  notes: string | null
  proposal_row_id: number
  rejected_by_user_id: number | null
  suggested_value_json: JsonValue
  target_entity_id: number
  target_entity_type: 'catalog_group' | 'catalog_product'
  version: number
}

interface DesiredStateRow extends QueryResultRow {
  id: number
}

interface DesiredStateRevisionIdRow extends QueryResultRow {
  id: number
}

export async function registerReviewRoutes(server: FastifyInstance): Promise<void> {
  server.get('/api/review/line-items', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'viewer')
    if (!user) {
      return
    }

    const query = ReviewLineItemListQuerySchema.parse(request.query)
    const response = await listReviewLineItems(getPool(), query)
    return reply.send(ReviewLineItemListResponseSchema.parse(response))
  })

  // Family-grouped review queue (issue #15 — canonical product-review row).
  // Reviewers consume this for `/catalog/review`; groups line items into
  // family panels and joins the latest cached LitAlerts market evidence
  // per targeted SKU so the canonical pricing-ladder can be rendered
  // pre-populated.
  server.get('/api/review/family-queue', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'viewer')
    if (!user) {
      return
    }

    const query = ReviewFamilyQueueQuerySchema.parse(request.query)
    const response = await listReviewFamilyQueue(getPool(), query)
    return reply.send(ReviewFamilyQueueResponseSchema.parse(response))
  })

  server.patch('/api/proposal-line-items/:lineItemId/edit', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'editor')
    if (!user) {
      return
    }

    const lineItemId = Number.parseInt((request.params as { lineItemId: string }).lineItemId, 10)
    const body = EditProposalLineItemRequestSchema.parse(request.body)
    const requestId = randomUUID()

    const result = await withTransaction(async (db) => {
      const current = await lockProposalLineItem(db, lineItemId)
      assertVersion(current, body.expectedVersion)
      if (current.approval_status === 'approved') {
        throw new Error('Approved line items must be superseded instead of edited in place.')
      }

      const normalizedEditedValue = normalizeEditedValue(current.field_path, body.editedValue)
      const nextEffectiveValue = normalizedEditedValue ?? current.suggested_value_json
      const nextVersion = current.version + 1
      const scope = buildCatalogGroupModuleScope(current.catalog_group_id)
      const auditPayload = {
        approvalStatusAtEdit: current.approval_status,
        catalogGroupId: current.catalog_group_id,
        fieldPath: current.field_path,
        nextEditedValue: normalizedEditedValue,
        nextEffectiveValue,
        nextVersion,
        previousEditedValue: current.edited_value_json,
        previousEffectiveValue: current.effective_value_json,
        previousVersion: current.version,
        proposalLineItemId: current.id,
        targetEntityId: current.target_entity_id,
        targetEntityType: current.target_entity_type,
      } satisfies ProposalLineItemEditedAuditPayload
      const undoPayload = {
        previousEditedValue: current.edited_value_json,
        previousEffectiveValue: current.effective_value_json,
        previousVersion: current.version,
      } satisfies ProposalLineItemEditedUndoPayload

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
          current.id,
          normalizedEditedValue === null ? null : JSON.stringify(normalizedEditedValue),
          JSON.stringify(nextEffectiveValue),
          nextVersion,
        ],
      )

      const auditEventId = await appendAuditEvent(db, {
        actorType: 'user',
        actorUserId: user.id,
        entityId: String(current.id),
        entityType: 'proposal_line_item',
        eventType: 'proposal.line_item.edited',
        module: 'catalog',
        payload: auditPayload,
        requestId,
        scope,
        undoPayload,
      })

      return { auditEventId }
    })

    return reply.send(MutationAcceptedResponseSchema.parse({ auditEventId: result.auditEventId, jobId: null, requestId }))
  })

  server.patch('/api/proposal-line-items/:lineItemId/note', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'editor')
    if (!user) {
      return
    }

    const lineItemId = Number.parseInt((request.params as { lineItemId: string }).lineItemId, 10)
    const body = UpdateProposalLineItemNoteRequestSchema.parse(request.body)
    const requestId = randomUUID()

    const result = await withTransaction(async (db) => {
      const current = await lockProposalLineItem(db, lineItemId)
      const scope = buildCatalogGroupModuleScope(current.catalog_group_id)
      const auditPayload = {
        nextNote: body.note,
        previousNote: current.notes,
        proposalLineItemId: current.id,
      } satisfies ProposalLineItemNoteUpdatedAuditPayload
      const undoPayload = {
        previousNote: current.notes,
      } satisfies ProposalLineItemNoteUpdatedUndoPayload

      await db.query(
        `
          update proposal_line_items
          set notes = $2,
              updated_at = now()
          where id = $1
        `,
        [current.id, body.note],
      )

      const auditEventId = await appendAuditEvent(db, {
        actorType: 'user',
        actorUserId: user.id,
        entityId: String(current.id),
        entityType: 'proposal_line_item',
        eventType: 'proposal.line_item.note_updated',
        module: 'catalog',
        payload: auditPayload,
        requestId,
        scope,
        undoPayload,
      })

      return { auditEventId }
    })

    return reply.send(MutationAcceptedResponseSchema.parse({ auditEventId: result.auditEventId, jobId: null, requestId }))
  })

  server.post('/api/proposal-line-items/:lineItemId/approve', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'approver')
    if (!user) {
      return
    }

    const lineItemId = Number.parseInt((request.params as { lineItemId: string }).lineItemId, 10)
    const body = ApproveProposalLineItemRequestSchema.parse(request.body)
    const requestId = randomUUID()

    const result = await withTransaction(async (db) => {
      const current = await lockProposalLineItem(db, lineItemId)
      assertVersion(current, body.expectedVersion)

      const priorDesiredStateResult = await db.query<DesiredStateRevisionIdRow>(
        `
          update desired_state_revisions
          set active = false,
              superseded_by_id = null
          where catalog_group_id = $1
            and target_entity_type = $2
            and target_entity_id = $3
            and field_path = $4
            and active = true
          returning id
        `,
        [current.catalog_group_id, current.target_entity_type, current.target_entity_id, current.field_path],
      )

      const desiredStateResult = await db.query<DesiredStateRow>(
        `
          insert into desired_state_revisions (
            proposal_line_item_id,
            catalog_group_id,
            target_entity_type,
            target_entity_id,
            field_path,
            desired_value_json,
            created_by_user_id
          )
          values ($1, $2, $3, $4, $5, $6::jsonb, $7)
          returning id
        `,
        [
          current.id,
          current.catalog_group_id,
          current.target_entity_type,
          current.target_entity_id,
          current.field_path,
          JSON.stringify(current.effective_value_json),
          user.id,
        ],
      )

      const activatedDesiredStateRevisionId = desiredStateResult.rows[0].id
      const priorDesiredStateRevisionIds = priorDesiredStateResult.rows.map((row) => row.id)
      const scope = buildCatalogGroupModuleScope(current.catalog_group_id)
      const auditPayload = {
        activatedDesiredStateRevisionId,
        catalogGroupId: current.catalog_group_id,
        fieldPath: current.field_path,
        nextApprovalStatus: 'approved',
        nextApprovedByUserId: user.id,
        previousApprovalStatus: current.approval_status,
        proposalLineItemId: current.id,
        supersededDesiredStateRevisionIds: priorDesiredStateRevisionIds,
        targetEntityId: current.target_entity_id,
        targetEntityType: current.target_entity_type,
      } satisfies ProposalLineItemApprovedAuditPayload
      const undoPayload = {
        previousApprovalStatus: current.approval_status,
        previousApprovedByUserId: current.approved_by_user_id,
        previousApprovalUpdatedAt: current.approval_updated_at ? current.approval_updated_at.toISOString() : null,
        previousRejectedByUserId: current.rejected_by_user_id,
      } satisfies ProposalLineItemApprovalUndoPayload
      if (priorDesiredStateRevisionIds.length > 0) {
        await db.query(
          `
            update desired_state_revisions
            set superseded_by_id = $2
            where id = any($1::bigint[])
          `,
          [priorDesiredStateRevisionIds, activatedDesiredStateRevisionId],
        )
      }

      await db.query(
        `
          update proposal_line_items
          set approval_status = 'approved',
              approved_by_user_id = $2,
              rejected_by_user_id = null,
              approval_updated_at = now(),
              updated_at = now()
          where id = $1
        `,
        [current.id, user.id],
      )

      const auditEventId = await appendAuditEvent(db, {
        actorType: 'user',
        actorUserId: user.id,
        entityId: String(current.id),
        entityType: 'proposal_line_item',
        eventType: 'proposal.line_item.approved',
        module: 'catalog',
        payload: auditPayload,
        requestId,
        scope,
        undoPayload,
      })

      const activeDesiredStateFields = await listActiveDesiredStateFields(db, current.catalog_group_id)
      const desiredProjection = buildDesiredProjection(
        current.catalog_group_id,
        activeDesiredStateFields.filter((row) => !row.paused),
      )
      const expectedDesiredProjectionHash = getDesiredProjectionHash(desiredProjection)

      const jobId = await enqueueJob(db, {
        concurrencyKey: getOptionalSweedSessionConcurrencyKey(true),
        dedupeKey: `reconcile.group:${current.catalog_group_id}`,
        jobType: 'reconcile.group',
        module: 'catalog',
        payload: {
          catalogGroupId: current.catalog_group_id,
          expectedDesiredProjectionHash,
          trigger: 'approval',
          triggerAuditEventId: auditEventId,
        },
        requestedByUserId: user.id,
        scope,
      })

      return { auditEventId, jobId }
    })

    return reply.send(
      MutationAcceptedResponseSchema.parse({
        auditEventId: result.auditEventId,
        jobId: result.jobId,
        requestId,
      }),
    )
  })

  server.post('/api/proposal-line-items/:lineItemId/reject', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'approver')
    if (!user) {
      return
    }

    const lineItemId = Number.parseInt((request.params as { lineItemId: string }).lineItemId, 10)
    const body = RejectProposalLineItemRequestSchema.parse(request.body)
    const requestId = randomUUID()

    const result = await withTransaction(async (db) => {
      const current = await lockProposalLineItem(db, lineItemId)
      assertVersion(current, body.expectedVersion)
      const deactivatedDesiredStateResult = await db.query<DesiredStateRevisionIdRow>(
        `
          update desired_state_revisions
          set active = false
          where proposal_line_item_id = $1
            and active = true
          returning id
        `,
        [current.id],
      )
      const deactivatedDesiredStateRevisionIds = deactivatedDesiredStateResult.rows.map((row) => row.id)
      const scope = buildCatalogGroupModuleScope(current.catalog_group_id)
      const auditPayload = {
        catalogGroupId: current.catalog_group_id,
        deactivatedDesiredStateRevisionIds,
        fieldPath: current.field_path,
        nextApprovalStatus: 'rejected',
        nextRejectedByUserId: user.id,
        previousApprovalStatus: current.approval_status,
        proposalLineItemId: current.id,
        targetEntityId: current.target_entity_id,
        targetEntityType: current.target_entity_type,
      } satisfies ProposalLineItemRejectedAuditPayload
      const undoPayload = {
        previousApprovalStatus: current.approval_status,
        previousApprovedByUserId: current.approved_by_user_id,
        previousApprovalUpdatedAt: current.approval_updated_at ? current.approval_updated_at.toISOString() : null,
        previousRejectedByUserId: current.rejected_by_user_id,
      } satisfies ProposalLineItemApprovalUndoPayload

      await db.query(
        `
          update proposal_line_items
          set approval_status = 'rejected',
              rejected_by_user_id = $2,
              approval_updated_at = now(),
              updated_at = now()
          where id = $1
        `,
        [current.id, user.id],
      )

      const auditEventId = await appendAuditEvent(db, {
        actorType: 'user',
        actorUserId: user.id,
        entityId: String(current.id),
        entityType: 'proposal_line_item',
        eventType: 'proposal.line_item.rejected',
        module: 'catalog',
        payload: auditPayload,
        requestId,
        scope,
        undoPayload,
      })

      return { auditEventId }
    })

    return reply.send(
      MutationAcceptedResponseSchema.parse({
        auditEventId: result.auditEventId,
        jobId: null,
        requestId,
      }),
    )
  })
}

async function lockProposalLineItem(db: PoolClient, lineItemId: number): Promise<ProposalLineItemRow> {
  const result = await db.query<ProposalLineItemRow>(
    `
      select
        id,
        proposal_row_id,
        catalog_group_id,
        target_entity_type,
        target_entity_id,
        field_path,
        suggested_value_json,
        edited_value_json,
        effective_value_json,
        approval_status,
        approval_updated_at,
        version,
        notes,
        approved_by_user_id,
        rejected_by_user_id
      from proposal_line_items
      where id = $1
      for update
    `,
    [lineItemId],
  )

  const row = result.rows[0]
  if (!row) {
    throw new Error('Proposal line item not found.')
  }
  return row
}

function assertVersion(current: ProposalLineItemRow, expectedVersion: number): void {
  if (current.version !== expectedVersion) {
    throw new Error(`Line item version mismatch. Expected ${expectedVersion}, found ${current.version}.`)
  }
}

function normalizeEditedValue(fieldPath: string, editedValue: JsonValue | null): JsonValue | null {
  if (editedValue === null) {
    return null
  }

  if (fieldPath === 'description') {
    if (typeof editedValue !== 'string') {
      throw new Error('Description edits must be text.')
    }

    return editedValue
  }

  if (fieldPath === 'products.price') {
    if (typeof editedValue === 'number' && Number.isFinite(editedValue)) {
      return roundCurrencyValue(editedValue)
    }

    if (typeof editedValue === 'string') {
      const parsed = Number(editedValue.trim())
      if (Number.isFinite(parsed)) {
        return roundCurrencyValue(parsed)
      }
    }

    throw new Error('Price edits must be numeric.')
  }

  return editedValue
}

function roundCurrencyValue(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100
}
