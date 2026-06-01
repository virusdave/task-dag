import { randomUUID } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'

import type { FastifyInstance } from 'fastify'
import type { PoolClient, QueryResultRow } from 'pg'
import { z } from 'zod'

import {
  type EditedStructuredFields,
  HELIOS_PENDING_PURCHASE_SITE_DEALERS,
  type JsonValue,
  MutationAcceptedResponseSchema,
  PendingPurchaseListQuerySchema,
  PendingPurchaseListResponseSchema,
  PendingPurchaseRowRouteParamsSchema,
  QueuePendingPurchaseApplyRequestSchema,
  QueuePendingPurchasePacketGenerationRequestSchema,
  QueuePendingPurchasePacketImportRequestSchema,
  type SweedVariantSearchHit,
  SweedVariantSearchQuerySchema,
  SweedVariantSearchResponseSchema,
  UpdatePendingPurchaseRowApprovalRequestSchema,
  UpdatePendingPurchaseRowRequestSchema,
} from '../../shared/contracts/index.js'
import { sha256 } from '../../shared/util/hash.js'
import { appendAuditEvent } from '../audit/appendAuditEvent.js'
import { requireSessionUser } from '../auth/requireSession.js'
import { getPool } from '../db/pool.js'
import { loadCatalogStructuredOverrideFacets } from '../db/queries/catalogQueries.js'
import {
  getLatestPendingPurchaseApplyRequest,
  getPendingPurchasePacketSummary,
  listPendingPurchasePacketListPage,
  listPendingPurchaseRows,
} from '../db/queries/pendingPurchaseQueries.js'
import {
  insertPendingPurchaseParseObservation,
  normalizePendingPurchaseParserText,
  updatePendingPurchaseParseRuleFeedback,
} from '../db/queries/pendingPurchaseParserQueries.js'
import { withTransaction } from '../db/tx.js'
import { getJobStatus } from '../db/queries/jobQueries.js'
import { getOptionalSweedSessionConcurrencyKey } from '../jobs/concurrency.js'
import { JOB_PRIORITY_LIVE_REQUESTED, enqueueJob } from '../jobs/enqueueJob.js'
import { callSweedRpc } from '../../worker/sweed/rpc.js'
import { withSweedSession } from '../../worker/sweed/session.js'

interface PendingPurchaseRowLockRow extends QueryResultRow {
  approval_status: 'approved' | 'pending' | 'rejected'
  catalog_action: string
  distributor_product_name: string
  edited_primary_image_url: string | null
  edited_proposed_description: string | null
  edited_proposed_price: number | null
  edited_structured_fields: JsonValue
  id: number
  last_apply_status: 'applied' | 'blocked' | 'failed' | 'not_requested' | 'queued' | 'running'
  notes: string | null
  packet_id: number
  raw_row_json: JsonValue
  row_input_signature: string | null
  site_label: string
  version: number
}

interface PendingPurchaseApplySelectionRow extends QueryResultRow {
  approval_status: 'approved' | 'pending' | 'rejected'
  distributor_product_name: string
  id: number
  last_apply_status: 'applied' | 'blocked' | 'failed' | 'not_requested' | 'queued' | 'running'
  packet_id: number
}

interface PendingPurchaseApplyRequestInsertRow extends QueryResultRow {
  id: number
}

interface JobIdRow extends QueryResultRow {
  id: number
}

export async function registerPendingPurchaseRoutes(server: FastifyInstance): Promise<void> {
  server.get('/api/catalog/pending-purchases', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'viewer')
    if (!user) {
      return
    }

    const query = PendingPurchaseListQuerySchema.parse(request.query)
    const db = getPool()
    // mode default: 'rows' when a specific packetId is asked for, otherwise
    // 'packets' so the reviewer always lands on the all-packets archive.
    const mode: 'packets' | 'rows' = query.mode ?? (query.packetId != null ? 'rows' : 'packets')
    const page = query.page
    const pageSize = query.pageSize

    const [packetsPage, items, activeGenerationJobIdResult, activePacket, latestApplyRequest, overrideOptions] = await Promise.all([
      mode === 'packets'
        ? listPendingPurchasePacketListPage(db, {
            filters: {
              after: query.after ?? null,
              before: query.before ?? null,
              search: query.search ?? null,
              siteKey: query.siteKey ?? null,
              source: query.source ?? null,
              status: query.status ?? null,
            },
            limit: pageSize,
            offset: (page - 1) * pageSize,
          })
        : Promise.resolve({ items: [], totalCount: 0 }),
      mode === 'rows' && query.packetId != null
        ? listPendingPurchaseRows(db, query.packetId)
        : Promise.resolve([] as Awaited<ReturnType<typeof listPendingPurchaseRows>>),
      db.query<JobIdRow>(
        `
          select jq.id
          from job_queue jq
          where jq.job_type = 'catalog.pending_purchases.generate'
            and jq.status in ('queued', 'running')
          order by jq.created_at desc, jq.id desc
          limit 1
        `,
      ),
      query.packetId != null
        ? getPendingPurchasePacketSummary(db, query.packetId)
        : Promise.resolve(null),
      query.packetId != null
        ? getLatestPendingPurchaseApplyRequest(db, query.packetId)
        : Promise.resolve(null),
      // Only load the dropdown options when the reviewer is on the
      // row-detail view — the archive list doesn't render override
      // editors, so the per-request scans would be pure waste.
      mode === 'rows'
        ? loadCatalogStructuredOverrideFacets(db)
        : Promise.resolve(null),
    ])
    const activeGenerationJobId = activeGenerationJobIdResult.rows[0]?.id ?? null
    const activeGenerationJob = activeGenerationJobId ? await getJobStatus(db, activeGenerationJobId) : null
    const totalCount = mode === 'packets' ? packetsPage.totalCount : items.length
    return reply.send(PendingPurchaseListResponseSchema.parse({
      activePacket,
      activeGenerationJob,
      filters: query,
      hasNextPage: mode === 'packets' ? page * pageSize < packetsPage.totalCount : false,
      items,
      latestApplyRequest,
      mode,
      overrideOptions,
      packets: packetsPage.items,
      page,
      pageSize,
      totalCount,
    }))
  })

  server.post('/api/catalog/pending-purchases/import', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'admin')
    if (!user) {
      return
    }

    const body = QueuePendingPurchasePacketImportRequestSchema.parse(request.body ?? {})
    if (!isAbsolute(body.filePath)) {
      throw new Error('Pending-purchase packet import path must be absolute.')
    }

    const normalizedFilePath = resolve(body.filePath)
    const requestId = randomUUID()

    const mutationResult = await withTransaction(async (db) => {
      const jobId = await enqueueJob(db, {
        concurrencyKey: 'catalog-pending-purchases-import',
        dedupeKey: `catalog.pending_purchases.import_json:${sha256(normalizedFilePath)}`,
        jobType: 'catalog.pending_purchases.import_json',
        module: 'catalog',
        payload: {
          filePath: normalizedFilePath,
          requestedByUserId: user.id,
        },
        priority: JOB_PRIORITY_LIVE_REQUESTED,
        requestedByUserId: user.id,
      })

      const auditEventId = await appendAuditEvent(db, {
        actorType: 'user',
        actorUserId: user.id,
        entityId: String(jobId),
        entityType: 'job',
        eventType: 'pending_purchase.packet.import_requested',
        module: 'catalog',
        payload: {
          filePath: normalizedFilePath,
          queuedJobId: jobId,
          requestedReason: body.reason ?? null,
          summary: 'Queued a pending-purchase packet import.',
        },
        requestId,
        undoPayload: null,
      })

      return { auditEventId, jobId }
    })

    return reply.send(
      MutationAcceptedResponseSchema.parse({
        auditEventId: mutationResult.auditEventId,
        jobId: mutationResult.jobId,
        requestId,
      }),
    )
  })

  server.post('/api/catalog/pending-purchases/generate', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'admin')
    if (!user) {
      return
    }

    const body = QueuePendingPurchasePacketGenerationRequestSchema.parse(request.body ?? {})
    const siteDealerIds = body.siteDealerIds.length > 0
      ? [...new Set(body.siteDealerIds)]
      : HELIOS_PENDING_PURCHASE_SITE_DEALERS.map((dealer) => dealer.dealerId)
    const requestId = randomUUID()

    const mutationResult = await withTransaction(async (db) => {
      const jobId = await enqueueJob(db, {
        concurrencyKey: getOptionalSweedSessionConcurrencyKey(true),
        dedupeKey: `catalog.pending_purchases.generate:${body.fromDate}:${body.toDate}:${siteDealerIds.join(',')}`,
        jobType: 'catalog.pending_purchases.generate',
        module: 'catalog',
        payload: {
          fromDate: body.fromDate,
          requestedByUserId: user.id,
          siteDealerIds,
          toDate: body.toDate,
        },
        priority: JOB_PRIORITY_LIVE_REQUESTED,
        requestedByUserId: user.id,
      })

      const auditEventId = await appendAuditEvent(db, {
        actorType: 'user',
        actorUserId: user.id,
        entityId: String(jobId),
        entityType: 'job',
        eventType: 'pending_purchase.packet.generation_requested',
        module: 'catalog',
        payload: {
          fromDate: body.fromDate,
          queuedJobId: jobId,
          requestedReason: body.reason ?? null,
          siteDealerIds,
          siteDealerNames: siteDealerIds.flatMap((dealerId) => {
            const dealer = HELIOS_PENDING_PURCHASE_SITE_DEALERS.find((candidate) => candidate.dealerId === dealerId)
            return dealer ? [dealer.dealerName] : []
          }),
          summary: buildQueuedPendingPurchaseGenerationSummary(siteDealerIds, body.fromDate, body.toDate),
          toDate: body.toDate,
        },
        requestId,
        undoPayload: null,
      })

      return { auditEventId, jobId }
    })

    return reply.send(
      MutationAcceptedResponseSchema.parse({
        auditEventId: mutationResult.auditEventId,
        jobId: mutationResult.jobId,
        requestId,
      }),
    )
  })

  server.patch('/api/catalog/pending-purchases/:rowId', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'editor')
    if (!user) {
      return
    }

    const params = PendingPurchaseRowRouteParamsSchema.parse(request.params)
    const body = UpdatePendingPurchaseRowRequestSchema.parse(request.body ?? {})
    const requestId = randomUUID()

    const result = await withTransaction(async (db) => {
      const current = await lockPendingPurchaseRow(db, params.rowId)
      assertPendingPurchaseRowVersion(current, body.expectedVersion)
      if (current.approval_status === 'approved') {
        throw new Error('Approved pending-purchase rows must be returned to pending review before editing.')
      }
      if (current.last_apply_status === 'queued' || current.last_apply_status === 'running') {
        throw new Error('This pending-purchase row is already queued for apply. Wait for that request to finish first.')
      }

      const nextEditedProposedDescription = body.editedProposedDescription !== undefined
        ? body.editedProposedDescription
        : current.edited_proposed_description
      const nextEditedProposedPrice = body.editedProposedPrice !== undefined
        ? body.editedProposedPrice
        : current.edited_proposed_price
      const nextEditedPrimaryImageUrl = body.editedPrimaryImageUrl !== undefined
        ? body.editedPrimaryImageUrl
        : current.edited_primary_image_url
      const previousEditedStructuredFields = readEditedStructuredFieldsFromJson(current.edited_structured_fields)
      const nextEditedStructuredFields = body.editedStructuredFields !== undefined
        ? body.editedStructuredFields
        : previousEditedStructuredFields
      const nextNotes = body.notes !== undefined ? body.notes : current.notes
      if (
        nextEditedProposedDescription === current.edited_proposed_description &&
        nextEditedProposedPrice === current.edited_proposed_price &&
        nextEditedPrimaryImageUrl === current.edited_primary_image_url &&
        editedStructuredFieldsEqual(nextEditedStructuredFields, previousEditedStructuredFields) &&
        nextNotes === current.notes
      ) {
        return { auditEventId: null }
      }

      const nextVersion = current.version + 1

      await db.query(
        `
          update pending_purchase_rows
          set edited_proposed_description = $2,
              edited_proposed_price = $3,
              edited_primary_image_url = $4,
              edited_structured_fields = $5::jsonb,
              notes = $6,
              last_apply_request_id = null,
              last_apply_status = 'not_requested',
              last_apply_error = null,
              last_apply_summary_json = '{}'::jsonb,
              version = $7,
              updated_at = now()
          where id = $1
        `,
        [
          current.id,
          nextEditedProposedDescription,
          nextEditedProposedPrice,
          nextEditedPrimaryImageUrl,
          nextEditedStructuredFields === null ? null : JSON.stringify(nextEditedStructuredFields),
          nextNotes,
          nextVersion,
        ],
      )

      const auditEventId = await appendAuditEvent(db, {
        actorType: 'user',
        actorUserId: user.id,
        entityId: String(current.id),
        entityType: 'pending_purchase_row',
        eventType: 'pending_purchase.row.edited',
        module: 'catalog',
        payload: {
          nextEditedPrimaryImageUrl,
          nextEditedProposedDescription,
          nextEditedProposedPrice,
          nextEditedStructuredFields,
          nextNotes,
          nextVersion,
          packetId: current.packet_id,
          pendingPurchaseRowId: current.id,
          previousEditedPrimaryImageUrl: current.edited_primary_image_url,
          previousEditedProposedDescription: current.edited_proposed_description,
          previousEditedProposedPrice: current.edited_proposed_price,
          previousEditedStructuredFields,
          previousNotes: current.notes,
          previousVersion: current.version,
          summary: `Updated pending-purchase row for ${current.distributor_product_name}.`,
        },
        requestId,
        scope: buildPendingPurchasePacketScope(current.packet_id),
        undoPayload: null,
      })

      await recordPendingPurchaseParserReviewFeedback(db, {
        action: 'edit',
        currentRow: current,
        notes: 'Reviewer updated non-parser pending-purchase fields.',
        userId: user.id,
      })

      return { auditEventId }
    })

    return reply.send(MutationAcceptedResponseSchema.parse({ auditEventId: result.auditEventId, jobId: null, requestId }))
  })

  // Live Sweed variant picker (powers the `targetReuseProductId`
  // link-override). Reviewer sees a row whose parser-chosen variant
  // looks wrong, opens this picker, types a few characters (or pastes
  // an exact product id), then clicks a hit. The PATCH route above
  // persists the chosen id in `edited_structured_fields.targetReuseProductId`.
  //
  // This endpoint is deliberately pending-purchases-specific (rather
  // than a generic catalog lookup) because the response shape is
  // tuned for reviewer-verification: it carries the image, price,
  // group, brand, strain — every signal the reviewer needs to confirm
  // they picked the right variant. Build a generic endpoint when
  // another page wants the same picker.
  server.get('/api/catalog/pending-purchases/sweed-variant-search', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'editor')
    if (!user) {
      return
    }
    const query = SweedVariantSearchQuerySchema.parse(request.query)
    const dealer = HELIOS_PENDING_PURCHASE_SITE_DEALERS.find((candidate) => candidate.dealerId === query.siteDealerId)
    if (!dealer) {
      return reply.code(400).send({
        error: `Unknown siteDealerId ${query.siteDealerId}. Must be one of ${HELIOS_PENDING_PURCHASE_SITE_DEALERS.map((d) => d.dealerId).join(', ')}.`,
      })
    }
    const result = await withSweedSession(async () => {
      return runSweedVariantSearch(dealer.dealerId, query.q)
    })
    return reply.send(SweedVariantSearchResponseSchema.parse({ ...result, query }))
  })

  server.post('/api/catalog/pending-purchases/:rowId/approval', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'approver')
    if (!user) {
      return
    }

    const params = PendingPurchaseRowRouteParamsSchema.parse(request.params)
    const body = UpdatePendingPurchaseRowApprovalRequestSchema.parse(request.body ?? {})
    const requestId = randomUUID()

    const result = await withTransaction(async (db) => {
      const current = await lockPendingPurchaseRow(db, params.rowId)
      assertPendingPurchaseRowVersion(current, body.expectedVersion)
      if (current.last_apply_status === 'queued' || current.last_apply_status === 'running') {
        throw new Error('This pending-purchase row is already queued for apply. Wait for that request to finish first.')
      }
      if (current.approval_status === body.approvalStatus) {
        return { auditEventId: null }
      }

      const nextVersion = current.version + 1
      const approvedByUserId = body.approvalStatus === 'approved' ? user.id : null
      const rejectedByUserId = body.approvalStatus === 'rejected' ? user.id : null

      if (body.approvalStatus === 'approved') {
        await db.query(
          `
            update pending_purchase_rows
            set approval_status = $2,
                approved_by_user_id = $3,
                rejected_by_user_id = null,
                approval_updated_at = now(),
                version = $4,
                updated_at = now()
            where id = $1
          `,
          [current.id, body.approvalStatus, approvedByUserId, nextVersion],
        )
      } else {
        await db.query(
          `
            update pending_purchase_rows
            set approval_status = $2,
                approved_by_user_id = null,
                rejected_by_user_id = $3,
                approval_updated_at = now(),
                last_apply_request_id = null,
                last_apply_status = 'not_requested',
                last_apply_error = null,
                last_apply_summary_json = '{}'::jsonb,
                version = $4,
                updated_at = now()
            where id = $1
          `,
          [current.id, body.approvalStatus, rejectedByUserId, nextVersion],
        )
      }

      const summary = body.approvalStatus === 'approved'
        ? `Approved pending-purchase row for ${current.distributor_product_name}.`
        : body.approvalStatus === 'rejected'
          ? `Rejected pending-purchase row for ${current.distributor_product_name}.`
          : `Returned pending-purchase row for ${current.distributor_product_name} to pending review.`

      const auditEventId = await appendAuditEvent(db, {
        actorType: 'user',
        actorUserId: user.id,
        entityId: String(current.id),
        entityType: 'pending_purchase_row',
        eventType: 'pending_purchase.row.approval_updated',
        module: 'catalog',
        payload: {
          nextApprovalStatus: body.approvalStatus,
          nextVersion,
          packetId: current.packet_id,
          pendingPurchaseRowId: current.id,
          previousApprovalStatus: current.approval_status,
          previousVersion: current.version,
          summary,
        },
        requestId,
        scope: buildPendingPurchasePacketScope(current.packet_id),
        undoPayload: null,
      })

      await recordPendingPurchaseParserReviewFeedback(db, {
        action: body.approvalStatus,
        currentRow: current,
        notes: summary,
        userId: user.id,
      })

      return { auditEventId }
    })

    return reply.send(MutationAcceptedResponseSchema.parse({ auditEventId: result.auditEventId, jobId: null, requestId }))
  })

  server.post('/api/catalog/pending-purchases/apply', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'approver')
    if (!user) {
      return
    }

    const body = QueuePendingPurchaseApplyRequestSchema.parse(request.body ?? {})
    const requestId = randomUUID()
    const uniqueRowIds = [...new Set(body.rowIds)].sort((left, right) => left - right)

    const mutationResult = await withTransaction(async (db) => {
      const rowsResult = await db.query<PendingPurchaseApplySelectionRow>(
        `
          select
            id,
            packet_id,
            distributor_product_name,
            approval_status,
            last_apply_status
          from pending_purchase_rows
          where packet_id = $1
            and id = any($2::bigint[])
          order by id asc
          for update
        `,
        [body.packetId, uniqueRowIds],
      )

      if (rowsResult.rows.length !== uniqueRowIds.length) {
        throw new Error('One or more pending-purchase rows were not found in the selected packet.')
      }

      const invalidApprovalRow = rowsResult.rows.find((row) => row.approval_status !== 'approved')
      if (invalidApprovalRow) {
        throw new Error(`Pending-purchase row ${invalidApprovalRow.id} is not approved for apply.`)
      }

      const busyRow = rowsResult.rows.find((row) => row.last_apply_status === 'queued' || row.last_apply_status === 'running')
      if (busyRow) {
        throw new Error(`Pending-purchase row ${busyRow.id} is already queued for apply.`)
      }

      const alreadyAppliedRow = rowsResult.rows.find((row) => row.last_apply_status === 'applied')
      if (alreadyAppliedRow) {
        throw new Error(`Pending-purchase row ${alreadyAppliedRow.id} has already been applied. Return it to pending review before reapplying.`)
      }

      const applyRequestResult = await db.query<PendingPurchaseApplyRequestInsertRow>(
        `
          insert into pending_purchase_apply_requests (
            packet_id,
            requested_by_user_id,
            requested_reason,
            status,
            selected_row_count,
            selected_row_ids_json
          )
          values ($1, $2, $3, 'queued', $4, $5::jsonb)
          returning id
        `,
        [body.packetId, user.id, body.reason ?? null, uniqueRowIds.length, JSON.stringify(uniqueRowIds)],
      )

      const pendingPurchaseApplyRequestId = applyRequestResult.rows[0].id
      const scope = buildPendingPurchasePacketScope(body.packetId)
      const jobId = await enqueueJob(db, {
        concurrencyKey: getOptionalSweedSessionConcurrencyKey(true),
        jobType: 'catalog.pending_purchases.apply',
        module: 'catalog',
        payload: {
          pendingPurchaseApplyRequestId,
          requestedByUserId: user.id,
        },
        priority: JOB_PRIORITY_LIVE_REQUESTED,
        requestedByUserId: user.id,
        scope,
      })

      await db.query(
        `
          update pending_purchase_apply_requests
          set job_id = $2,
              updated_at = now()
          where id = $1
        `,
        [pendingPurchaseApplyRequestId, jobId],
      )

      await db.query(
        `
          update pending_purchase_rows
          set last_apply_request_id = $2,
              last_apply_status = 'queued',
              last_apply_error = null,
              last_apply_summary_json = '{}'::jsonb,
              version = version + 1,
              updated_at = now()
          where id = any($1::bigint[])
        `,
        [uniqueRowIds, pendingPurchaseApplyRequestId],
      )

      const auditEventId = await appendAuditEvent(db, {
        actorType: 'user',
        actorUserId: user.id,
        entityId: String(pendingPurchaseApplyRequestId),
        entityType: 'pending_purchase_apply_request',
        eventType: 'pending_purchase.apply.requested',
        module: 'catalog',
        payload: {
          packetId: body.packetId,
          pendingPurchaseApplyRequestId,
          queuedJobId: jobId,
          requestedReason: body.reason ?? null,
          rowIds: uniqueRowIds,
          selectedRowCount: uniqueRowIds.length,
          summary: buildQueuedPendingPurchaseApplySummary(uniqueRowIds.length),
        },
        requestId,
        scope,
        undoPayload: null,
      })

      return { auditEventId, jobId }
    })

    return reply.send(
      MutationAcceptedResponseSchema.parse({
        auditEventId: mutationResult.auditEventId,
        jobId: mutationResult.jobId,
        requestId,
      }),
    )
  })
}

async function lockPendingPurchaseRow(db: PoolClient, rowId: number): Promise<PendingPurchaseRowLockRow> {
  const result = await db.query<PendingPurchaseRowLockRow>(
    `
      select
        id,
        packet_id,
        distributor_product_name,
        site_label,
        catalog_action,
        approval_status,
        edited_proposed_description,
        edited_proposed_price::double precision as edited_proposed_price,
        edited_primary_image_url,
        edited_structured_fields,
        last_apply_status,
        notes,
        raw_row_json,
        row_input_signature,
        version
      from pending_purchase_rows
      where id = $1
      for update
    `,
    [rowId],
  )

  const row = result.rows[0]
  if (!row) {
    throw new Error('Pending-purchase row not found.')
  }
  return row
}

function assertPendingPurchaseRowVersion(row: PendingPurchaseRowLockRow, expectedVersion: number): void {
  if (row.version !== expectedVersion) {
    throw new Error('This pending-purchase row was updated by someone else. Refresh and try again.')
  }
}

function buildPendingPurchasePacketScope(packetId: number): { entityId: string; entityType: 'pending_purchase_packet' } {
  return { entityId: String(packetId), entityType: 'pending_purchase_packet' }
}

function buildQueuedPendingPurchaseApplySummary(selectedRowCount: number): string {
  return `Queued pending-purchase apply for ${selectedRowCount} approved row${selectedRowCount === 1 ? '' : 's'}.`
}

function buildQueuedPendingPurchaseGenerationSummary(
  siteDealerIds: number[],
  fromDate: string,
  toDate: string,
): string {
  const siteLabels = siteDealerIds.flatMap((dealerId) => {
    const dealer = HELIOS_PENDING_PURCHASE_SITE_DEALERS.find((candidate) => candidate.dealerId === dealerId)
    return dealer ? [dealer.siteLabel] : []
  })

  const siteLabel = siteLabels.length > 0 ? siteLabels.join(', ') : 'configured sites'
  return `Queued live pending-purchase packet generation for ${siteLabel} from ${fromDate} through ${toDate}.`
}

async function recordPendingPurchaseParserReviewFeedback(
  db: PoolClient,
  input: {
    action: 'approved' | 'edit' | 'pending' | 'rejected'
    currentRow: PendingPurchaseRowLockRow
    notes: string
    userId: number
  },
): Promise<void> {
  const parserRuleId = readOptionalIntFromJson(input.currentRow.raw_row_json, 'parserRuleId')
  const parserBrandProfileId = readOptionalIntFromJson(input.currentRow.raw_row_json, 'parserBrandProfileId')
  if (parserRuleId === null && parserBrandProfileId === null) {
    return
  }

  await insertPendingPurchaseParseObservation(db, {
    brandProfileId: parserBrandProfileId,
    createdByUserId: input.userId,
    inference: {
      parserSource: readOptionalStringFromJson(input.currentRow.raw_row_json, 'parserSource'),
      reviewAction: input.action,
    },
    normalizedDistributorProductName: normalizePendingPurchaseParserText(input.currentRow.distributor_product_name),
    notes: input.notes,
    observationStatus: input.action === 'approved' ? 'accepted' : input.action === 'rejected' ? 'rejected' : 'informational',
    observationType: input.action === 'edit' ? 'reviewer_edit' : 'reviewer_approval',
    packetId: input.currentRow.packet_id,
    parseRuleId: parserRuleId,
    pendingPurchaseRowId: input.currentRow.id,
    rawDistributorProductName: input.currentRow.distributor_product_name,
    rawRow: input.currentRow.raw_row_json,
    rowInputSignature: input.currentRow.row_input_signature,
    sourceSystem: 'metrc',
  })

  if (parserRuleId !== null && input.action === 'rejected') {
    await updatePendingPurchaseParseRuleFeedback(db, {
      feedbackType: 'rejected',
      ruleId: parserRuleId,
      state: 'draft',
    })
  }
}

function readOptionalIntFromJson(value: JsonValue, key: string): number | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null
  }
  const rawValue = (value as Record<string, JsonValue>)[key]
  return typeof rawValue === 'number' && Number.isInteger(rawValue) && rawValue > 0 ? rawValue : null
}

function readOptionalStringFromJson(value: JsonValue, key: string): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null
  }
  const rawValue = (value as Record<string, JsonValue>)[key]
  return typeof rawValue === 'string' && rawValue.trim().length > 0 ? rawValue.trim() : null
}

/**
 * Decodes the JSONB `edited_structured_fields` column into the
 * `EditedStructuredFields` contract type. Returns `null` (== "no
 * override map at all") when the column is null / missing / a
 * non-object — the apply worker treats null and `{}` identically
 * (both mean "no overrides; use the parsed values"), but
 * round-tripping the column through `null` keeps the audit-event
 * payload faithful to the DB state.
 */
function readEditedStructuredFieldsFromJson(value: JsonValue): EditedStructuredFields | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'object' || Array.isArray(value)) return null
  return value as EditedStructuredFields
}

/**
 * Cheap structural equality on the override map. The shape is small
 * (<= 9 keys, scalar values), so JSON-string-compare on sorted keys
 * is fine and avoids depending on a deep-equal helper.
 */
function editedStructuredFieldsEqual(
  left: EditedStructuredFields | null,
  right: EditedStructuredFields | null,
): boolean {
  if (left === right) return true
  if (left === null || right === null) return false
  const leftKeys = Object.keys(left).sort()
  const rightKeys = Object.keys(right).sort()
  if (leftKeys.length !== rightKeys.length) return false
  for (let i = 0; i < leftKeys.length; i += 1) {
    if (leftKeys[i] !== rightKeys[i]) return false
  }
  for (const k of leftKeys) {
    const lv = (left as Record<string, unknown>)[k]
    const rv = (right as Record<string, unknown>)[k]
    if (lv !== rv) return false
  }
  return true
}

// --- Live Sweed variant picker -----------------------------------------------

const SWEED_VARIANT_SEARCH_PAGE_SIZE = 20
// `helios/AGENTS.md`: anything Sweed marks `enabled: false`, or whose
// name starts with a DEAD/RETIRED/DELETED marker (operator convention
// for soft-retired records), should be filtered out of reviewer lists
// — we keep it visible (with a `isDisabled: true` flag) so the
// reviewer notices stale rows but can still see them.
const DISABLED_NAME_MARKER_RE = /^\s*(?:DEAD\b|DELETED\b|RETIRED\b)/i

const SweedShortProductRowSchema = z.object({
  id: z.union([z.coerce.number().int().positive(), z.string().trim().min(1)]),
  name: z.string().nullable().optional(),
  enabled: z.boolean().nullable().optional(),
}).passthrough()

const SweedShortProductListResponseSchema = z.union([
  z.object({
    data: z.array(SweedShortProductRowSchema).default([]),
    totalCount: z.coerce.number().int().min(0).optional(),
  }).passthrough(),
  z.array(SweedShortProductRowSchema),
])

const SweedProductDetailWrappedSchema = z.object({
  product: z.object({
    id: z.coerce.number().int().positive(),
    name: z.string().nullable().optional(),
    shortName: z.string().nullable().optional(),
    tab: z.string().nullable().optional(),
    packOfSize: z.coerce.number().int().nullable().optional(),
    price: z.coerce.number().nullable().optional(),
    productGroupId: z.union([z.coerce.number().int(), z.string().trim().min(1)]).nullable().optional(),
    enabled: z.boolean().nullable().optional(),
    images: z.array(z.object({ url: z.string().nullable().optional() }).passthrough()).default([]),
    size: z.object({ name: z.string().nullable().optional() }).passthrough().nullable().optional(),
  }).passthrough(),
}).passthrough()

const SweedProductGroupWrappedSchema = z.object({
  id: z.coerce.number().int().positive().nullable().optional(),
  name: z.string().nullable().optional(),
  enabled: z.boolean().nullable().optional(),
  brand: z.object({ name: z.string().nullable().optional() }).passthrough().nullable().optional(),
  category: z.object({ name: z.string().nullable().optional() }).passthrough().nullable().optional(),
  subcategory: z.object({ name: z.string().nullable().optional() }).passthrough().nullable().optional(),
  strain: z.object({ name: z.string().nullable().optional() }).passthrough().nullable().optional(),
  images: z.array(z.object({ url: z.string().nullable().optional() }).passthrough()).default([]),
}).passthrough()

async function runSweedVariantSearch(
  stateDealerId: number,
  q: string,
): Promise<{ hits: SweedVariantSearchHit[]; totalCount: number }> {
  // Numeric paste: skip the list call and look the product up directly.
  // Reviewers will paste `338655` from a debugging session — this
  // path needs to keep working even if the catalog's short-list search
  // tokenizer doesn't index pure numeric ids.
  const trimmed = q.trim()
  if (/^\d+$/.test(trimmed)) {
    const productId = Number.parseInt(trimmed, 10)
    if (Number.isInteger(productId) && productId > 0) {
      const hit = await enrichSweedSearchHit(stateDealerId, productId)
      if (hit) {
        return { hits: [hit], totalCount: 1 }
      }
      return { hits: [], totalCount: 0 }
    }
  }
  const rawList = await callSweedRpc<unknown>(stateDealerId, 'store.product.list.short', {
    page: 1,
    pageSize: SWEED_VARIANT_SEARCH_PAGE_SIZE,
    query: trimmed,
  })
  const parsedList = SweedShortProductListResponseSchema.parse(rawList)
  const rows = Array.isArray(parsedList) ? parsedList : parsedList.data
  const totalCount = Array.isArray(parsedList) ? rows.length : (parsedList.totalCount ?? rows.length)
  const productIds = rows
    .map((row) => Number(row.id))
    .filter((id) => Number.isInteger(id) && id > 0)
  const enriched = await Promise.all(productIds.map((id) => enrichSweedSearchHit(stateDealerId, id)))
  const hits = enriched.filter((value): value is SweedVariantSearchHit => value !== null)
  return { hits, totalCount }
}

async function enrichSweedSearchHit(
  stateDealerId: number,
  productId: number,
): Promise<SweedVariantSearchHit | null> {
  try {
    const productResult = SweedProductDetailWrappedSchema.parse(
      await callSweedRpc<unknown>(stateDealerId, 'store.product.get', { id: String(productId) }),
    )
    const product = productResult.product
    const groupId = product.productGroupId ? Number(product.productGroupId) : null
    const group = groupId
      ? SweedProductGroupWrappedSchema.parse(
        await callSweedRpc<unknown>(stateDealerId, 'store.product.group.get', { id: groupId }),
      )
      : null
    const productName = (product.name ?? '').trim()
    const groupName = (group?.name ?? '').trim()
    const productDisabled = product.enabled === false
    const groupDisabled = group?.enabled === false
    const nameLooksDisabled = DISABLED_NAME_MARKER_RE.test(productName) || DISABLED_NAME_MARKER_RE.test(groupName)
    return {
      productId,
      productName,
      shortName: normalizeNonEmpty(product.shortName ?? null),
      tab: normalizeNonEmpty(product.tab ?? null),
      packOfSize: typeof product.packOfSize === 'number' && Number.isInteger(product.packOfSize) ? product.packOfSize : null,
      sizeName: normalizeNonEmpty(product.size?.name ?? null),
      price: typeof product.price === 'number' && Number.isFinite(product.price) ? product.price : null,
      imageUrl: normalizeNonEmpty(product.images[0]?.url ?? null),
      groupId,
      groupName: normalizeNonEmpty(groupName) ?? normalizeNonEmpty(group?.name ?? null),
      brandName: normalizeNonEmpty(group?.brand?.name ?? null),
      categoryName: normalizeNonEmpty(group?.category?.name ?? null),
      subcategoryName: normalizeNonEmpty(group?.subcategory?.name ?? null),
      strainName: normalizeNonEmpty(group?.strain?.name ?? null),
      isDisabled: productDisabled || groupDisabled || nameLooksDisabled,
    }
  } catch (err) {
    // Per helios/AGENTS.md: one disabled/deleted hit must not nuke the
    // whole batch. Sweed's misleading "Action does not exist" subcode
    // 14002 is the canonical "you asked for a soft-retired record"
    // signal here. Skip and continue.
    if (err instanceof Error && /14002|does not exist or you do not have permission/i.test(err.message)) {
      return null
    }
    throw err
  }
}

function normalizeNonEmpty(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}
