import { sign } from '@fastify/cookie'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import {
  GroupDetailResponseSchema,
  HistoryEventsResponseSchema,
  LlmRunDetailResponseSchema,
  MutationAcceptedResponseSchema,
} from '../src/shared/contracts/index.js'
import type { GroupDetailResponse, JobStatusResponse, ProposalLineItem } from '../src/shared/contracts/index.js'
import { getUserForLogin } from '../src/server/db/queries/authQueries.js'
import { getJobStatus } from '../src/server/db/queries/jobQueries.js'
import { closePool, getPool } from '../src/server/db/pool.js'
import { buildServer } from '../src/server/app/buildServer.js'
import { getServerEnv } from '../src/server/config/env.js'
import { getWorkerEnv } from '../src/worker/config/env.js'
import { NormalizedCatalogGroupLiveStateSchema, getLiveStateFieldValue } from '../src/worker/catalog/liveState.js'
import { ensureDependenciesReadyForJob } from '../src/worker/runtime/dependencyHealth.js'
import { isDependencyUnavailableWorkerError, isRetryableWorkerError } from '../src/worker/runtime/errors.js'
import { markJobDeadLetter, markJobDeferred, markJobFailed, markJobForRetry, markJobSucceeded, runJob } from '../src/worker/runtime/jobRegistry.js'
import { leaseJobs, type LeasedJob } from '../src/worker/runtime/leaseJobs.js'

const SmokeWorkflowArgsSchema = z.object({
  approvalField: z.enum(['description', 'pricing']).default('pricing'),
  catalogGroupId: z.coerce.number().int().positive(),
  forceLiveRefresh: z.boolean().default(false),
  userEmail: z.string().email(),
})

interface ApiClient {
  getJson<T>(url: string, schema: z.ZodType<T>): Promise<T>
  patchJson<T>(url: string, body: unknown, schema: z.ZodType<T>): Promise<T>
  postJson<T>(url: string, body: unknown, schema: z.ZodType<T>): Promise<T>
}

interface SelectedApprovalLineItem {
  batchId: number
  lineItem: ProposalLineItem
}

const args = SmokeWorkflowArgsSchema.parse(parseArgs(process.argv.slice(2)))
const serverEnv = getServerEnv()

const server = await buildServer()
await server.ready()

try {
  const user = await getUserForLogin(getPool(), args.userEmail)
  if (!user || !user.active) {
    throw new Error(`No active user found for ${args.userEmail}. Provision an active admin first.`)
  }
  if (user.role !== 'admin') {
    throw new Error(`Smoke workflow requires an admin user for undo. ${args.userEmail} is ${user.role}.`)
  }

  const client = createApiClient(server, user.id)

  console.log(`Using admin session ${user.email} (#${user.id}) for catalog group ${args.catalogGroupId}.`)

  const initialGroupDetail = await fetchGroupDetail(client, args.catalogGroupId)
  console.log(`Loaded group ${initialGroupDetail.group.groupName} (${initialGroupDetail.group.catalogGroupId}).`)

  const descriptionBatchResult = await queueProposalBatch(client, {
    catalogGroupId: args.catalogGroupId,
    forceLiveRefresh: args.forceLiveRefresh,
    proposalType: 'description',
  })
  console.log(`Description batch ${descriptionBatchResult.batchId} succeeded.`)

  const pricingBatchResult = await queueProposalBatch(client, {
    catalogGroupId: args.catalogGroupId,
    forceLiveRefresh: args.forceLiveRefresh,
    proposalType: 'pricing',
  })
  console.log(`Pricing batch ${pricingBatchResult.batchId} succeeded.`)

  const postBatchDetail = await fetchGroupDetail(client, args.catalogGroupId)
  const selection = selectApprovalLineItem(
    postBatchDetail,
    args.approvalField === 'pricing' ? pricingBatchResult.batchId : descriptionBatchResult.batchId,
    args.approvalField,
  )
  const preApprovalLiveValue = readLiveFieldValue(
    postBatchDetail,
    selection.lineItem.targetEntityType,
    selection.lineItem.targetEntityId,
    selection.lineItem.fieldPath,
  )

  console.log(
    `Approving ${selection.lineItem.fieldPath} line item ${selection.lineItem.lineItemId} from batch ${selection.batchId}.`,
  )
  const approveMutation = await client.postJson(
    `/api/proposal-line-items/${selection.lineItem.lineItemId}/approve`,
    { expectedVersion: selection.lineItem.version },
    MutationAcceptedResponseSchema,
  )
  if (!approveMutation.jobId) {
    throw new Error('Approval did not enqueue a reconcile job.')
  }

  const approveJob = await driveWorkerUntilJobSettles(approveMutation.jobId)
  assertSuccessfulJob(approveJob, 'approval reconcile')
  console.log(`Approval reconcile job ${approveJob.job.jobId} succeeded.`)

  const approvalHistory = await client.getJson(
    `/api/history/events?catalogGroupId=${args.catalogGroupId}&eventType=proposal.line_item.approved&pageSize=20`,
    HistoryEventsResponseSchema,
  )
  const approvalEvent = approvalHistory.items.find((item) => {
    const payload = item.payload
    return typeof payload === 'object' && payload !== null && (payload as { proposalLineItemId?: number }).proposalLineItemId === selection.lineItem.lineItemId
  })
  if (!approvalEvent) {
    throw new Error(`Could not find the approval history event for line item ${selection.lineItem.lineItemId}.`)
  }

  const previousReconcileJobId = await getLatestJobId('reconcile.group', args.catalogGroupId)
  const undoMutation = await client.postJson(
    `/api/history/events/${approvalEvent.eventId}/undo`,
    { reason: 'Smoke workflow validation' },
    MutationAcceptedResponseSchema,
  )
  if (!undoMutation.jobId) {
    throw new Error('Undo request did not enqueue an undo job.')
  }

  const undoJob = await driveWorkerUntilJobSettles(undoMutation.jobId)
  assertSuccessfulJob(undoJob, 'undo execution')
  console.log(`Undo job ${undoJob.job.jobId} succeeded.`)

  const undoReconcileJobId = await waitForNewJobId('reconcile.group', args.catalogGroupId, previousReconcileJobId)
  const undoReconcileJob = await driveWorkerUntilJobSettles(undoReconcileJobId)
  assertSuccessfulJob(undoReconcileJob, 'undo follow-up reconcile')
  console.log(`Undo follow-up reconcile job ${undoReconcileJob.job.jobId} succeeded.`)

  const afterUndoDetail = await fetchGroupDetail(client, args.catalogGroupId)
  const restoredLiveValue = readLiveFieldValue(
    afterUndoDetail,
    selection.lineItem.targetEntityType,
    selection.lineItem.targetEntityId,
    selection.lineItem.fieldPath,
  )
  if (stableJsonStringify(preApprovalLiveValue) !== stableJsonStringify(restoredLiveValue)) {
    throw new Error(
      `Undo did not restore the live ${selection.lineItem.fieldPath} value. Expected ${formatValue(preApprovalLiveValue)}, got ${formatValue(restoredLiveValue)}.`,
    )
  }

  const approvalPayload = approvalEvent.payload as { supersededDesiredStateRevisionIds?: number[] }
  if ((approvalPayload.supersededDesiredStateRevisionIds?.length ?? 0) === 0) {
    const undoWrite = afterUndoDetail.writeOperations.find((operation) => operation.operationType === 'undo')
    if (!undoWrite || undoWrite.status !== 'succeeded') {
      throw new Error('Expected a successful undo write operation after undoing the only active desired revision.')
    }
  }
  console.log(`Undo restored the live ${selection.lineItem.fieldPath} value.`)

  const rerunMutation = await client.postJson(
    `/api/catalog-groups/${args.catalogGroupId}/llm-reruns`,
    { forceLiveRefresh: args.forceLiveRefresh, purpose: 'description' },
    MutationAcceptedResponseSchema,
  )
  if (!rerunMutation.jobId) {
    throw new Error('LLM rerun did not enqueue a job.')
  }

  const rerunJob = await driveWorkerUntilJobSettles(rerunMutation.jobId)
  assertSuccessfulJob(rerunJob, 'llm rerun')
  if (!rerunJob.linkedRecords.llmRunId) {
    throw new Error('LLM rerun job did not link an llmRunId.')
  }
  await client.getJson(`/api/llm/runs/${rerunJob.linkedRecords.llmRunId}`, LlmRunDetailResponseSchema)
  console.log(`LLM rerun ${rerunJob.linkedRecords.llmRunId} succeeded.`)

  const summaryRefreshMutation = await client.postJson('/api/catalog/refresh', { reason: 'Smoke workflow validation' }, MutationAcceptedResponseSchema)
  if (!summaryRefreshMutation.jobId) {
    throw new Error('Catalog refresh did not enqueue a full summary job.')
  }

  const summaryRefreshJob = await driveWorkerUntilJobSettles(summaryRefreshMutation.jobId)
  assertSuccessfulJob(summaryRefreshJob, 'catalog full-summary refresh')
  console.log(`Full summary sync job ${summaryRefreshJob.job.jobId} succeeded.`)

  console.log(
    JSON.stringify(
      {
        approvalField: args.approvalField,
        approvalLineItemId: selection.lineItem.lineItemId,
        catalogGroupId: args.catalogGroupId,
        descriptionBatchId: descriptionBatchResult.batchId,
        llmRunId: rerunJob.linkedRecords.llmRunId,
        pricingBatchId: pricingBatchResult.batchId,
        summaryJobId: summaryRefreshJob.job.jobId,
        undoJobId: undoJob.job.jobId,
      },
      null,
      2,
    ),
  )
} finally {
  await server.close()
  await closePool()
}

function createApiClient(server: FastifyInstance, userId: number): ApiClient {
  const origin = new URL(serverEnv.appBaseUrl).origin
  const cookieHeader = `${serverEnv.sessionCookieName}=${sign(String(userId), serverEnv.sessionCookieSecret)}`

  return {
    getJson: async <T>(url: string, schema: z.ZodType<T>) => requestJson(server, { cookieHeader, method: 'GET', origin, url }, schema),
    patchJson: async <T>(url: string, body: unknown, schema: z.ZodType<T>) =>
      requestJson(server, { body, cookieHeader, method: 'PATCH', origin, url }, schema),
    postJson: async <T>(url: string, body: unknown, schema: z.ZodType<T>) =>
      requestJson(server, { body, cookieHeader, method: 'POST', origin, url }, schema),
  }
}

async function requestJson<T>(
  server: FastifyInstance,
  input: { body?: unknown; cookieHeader: string; method: 'GET' | 'PATCH' | 'POST'; origin: string; url: string },
  schema: z.ZodType<T>,
): Promise<T> {
  const response = await server.inject({
    headers: {
      cookie: input.cookieHeader,
      ...(input.method === 'GET' ? {} : { origin: input.origin }),
      ...(input.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    method: input.method,
    payload: input.body === undefined ? undefined : JSON.stringify(input.body),
    url: input.url,
  })

  if (response.statusCode >= 400) {
    throw new Error(`${input.method} ${input.url} failed: ${response.statusCode} ${response.body}`)
  }

  if (!response.body) {
    throw new Error(`${input.method} ${input.url} returned an empty response.`)
  }

  return schema.parse(JSON.parse(response.body) as unknown)
}

async function fetchGroupDetail(client: ApiClient, catalogGroupId: number): Promise<GroupDetailResponse> {
  return client.getJson(`/api/catalog/groups/${catalogGroupId}`, GroupDetailResponseSchema)
}

async function queueProposalBatch(
  client: ApiClient,
  input: { catalogGroupId: number; forceLiveRefresh: boolean; proposalType: 'description' | 'pricing' },
): Promise<{ batchId: number; job: JobStatusResponse }> {
  const mutation = await client.postJson(
    '/api/proposal-batches',
    {
      catalogGroupIds: [input.catalogGroupId],
      forceLiveRefresh: input.forceLiveRefresh,
      proposalType: input.proposalType,
      reason: 'Smoke workflow validation',
    },
    MutationAcceptedResponseSchema,
  )

  if (!mutation.jobId) {
    throw new Error(`${input.proposalType} batch request did not enqueue a worker job.`)
  }

  const job = await driveWorkerUntilJobSettles(mutation.jobId)
  assertSuccessfulJob(job, `${input.proposalType} batch generation`)
  if (!job.linkedRecords.proposalBatchId) {
    throw new Error(`${input.proposalType} batch job did not link a proposalBatchId.`)
  }

  return { batchId: job.linkedRecords.proposalBatchId, job }
}

function selectApprovalLineItem(detail: GroupDetailResponse, batchId: number, approvalField: 'description' | 'pricing'): SelectedApprovalLineItem {
  const targetFieldPath = approvalField === 'pricing' ? 'products.price' : 'description'
  for (const proposalRow of detail.proposalRows) {
    if (proposalRow.proposalBatchId !== batchId) {
      continue
    }

    for (const lineItem of proposalRow.lineItems) {
      if (lineItem.fieldPath !== targetFieldPath || lineItem.approvalStatus !== 'pending') {
        continue
      }

      if (stableJsonStringify(lineItem.baselineValue) === stableJsonStringify(lineItem.effectiveValue)) {
        continue
      }

      return { batchId: proposalRow.proposalBatchId, lineItem }
    }
  }

  throw new Error(`Could not find a pending ${targetFieldPath} line item with a live change to approve.`)
}

function readLiveFieldValue(
  detail: GroupDetailResponse,
  targetEntityType: 'catalog_group' | 'catalog_product',
  targetEntityId: number,
  fieldPath: 'description' | 'products.price',
): unknown {
  const snapshot = detail.liveSnapshot
  if (!snapshot) {
    throw new Error(`Catalog group ${detail.group.catalogGroupId} has no persisted live snapshot.`)
  }

  const liveState = NormalizedCatalogGroupLiveStateSchema.parse(snapshot.stateJson)
  return getLiveStateFieldValue(liveState, targetEntityType, targetEntityId, fieldPath)
}

async function driveWorkerUntilJobSettles(jobId: number): Promise<JobStatusResponse> {
  const workerEnv = getWorkerEnv()

  for (;;) {
    const status = await getJobStatus(getPool(), jobId)
    if (!status) {
      throw new Error(`Job ${jobId} was not found.`)
    }
    if (isTerminalJobStatus(status.job.status)) {
      return status
    }

    const leasedJobs = await leaseJobs(workerEnv.workerMaxConcurrentJobs)
    if (leasedJobs.length === 0) {
      const queuedForLater = Date.parse(status.job.runAt) > Date.now() + 1_000
      if (status.job.status === 'queued' && status.job.lastError && queuedForLater) {
        throw new Error(`Job ${jobId} is deferred: ${status.job.lastError}`)
      }

      await delay(100)
      continue
    }

    await Promise.all(leasedJobs.map((job) => processLeasedJob(job, workerEnv.workerRetryBaseDelayMs, workerEnv.workerMaxAttempts)))
  }
}

async function processLeasedJob(job: LeasedJob, retryBaseDelayMs: number, workerMaxAttempts: number): Promise<void> {
  try {
    await ensureDependenciesReadyForJob(job.jobType, job.payload)
    await runJob({ id: job.id, jobType: job.jobType, module: job.module, payload: job.payload, scope: job.scope })
    await markJobSucceeded(job.id, job.leaseToken)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown worker error.'
    if (isDependencyUnavailableWorkerError(error)) {
      const delayMs = error.delayMs ?? getRetryDelayMs(0, retryBaseDelayMs)
      await markJobDeferred(job.id, job.leaseToken, message, new Date(Date.now() + delayMs))
      return
    }

    if (isRetryableWorkerError(error)) {
      if (job.attemptCount >= workerMaxAttempts) {
        await markJobDeadLetter(job.id, job.leaseToken, message)
        return
      }

      const delayMs = error.delayMs ?? getRetryDelayMs(job.attemptCount, retryBaseDelayMs)
      await markJobForRetry(job.id, job.leaseToken, message, new Date(Date.now() + delayMs))
      return
    }

    await markJobFailed(job.id, job.leaseToken, message)
  }
}

function getRetryDelayMs(attemptCount: number, baseDelayMs: number): number {
  return Math.min(baseDelayMs * 2 ** Math.max(attemptCount - 1, 0), 5 * 60 * 1000)
}

function isTerminalJobStatus(status: JobStatusResponse['job']['status']): boolean {
  return status === 'dead_letter' || status === 'failed' || status === 'succeeded'
}

function assertSuccessfulJob(job: JobStatusResponse, label: string): void {
  if (job.job.status !== 'succeeded') {
    throw new Error(`${label} job ${job.job.jobId} ended as ${job.job.status}: ${job.job.lastError ?? 'unknown error'}`)
  }
}

async function getLatestJobId(jobType: string, catalogGroupId: number | null): Promise<number> {
  const result = await getPool().query<{ max_id: number | null }>(
    `
      select max(id)::bigint as max_id
      from job_queue
      where job_type = $1
        and ($2::bigint is null or catalog_group_id = $2)
    `,
    [jobType, catalogGroupId],
  )

  return result.rows[0]?.max_id ?? 0
}

async function waitForNewJobId(jobType: string, catalogGroupId: number | null, previousJobId: number): Promise<number> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const result = await getPool().query<{ id: number }>(
      `
        select id
        from job_queue
        where job_type = $1
          and ($2::bigint is null or catalog_group_id = $2)
          and id > $3
        order by id desc
        limit 1
      `,
      [jobType, catalogGroupId, previousJobId],
    )

    const jobId = result.rows[0]?.id
    if (jobId) {
      return jobId
    }

    await delay(100)
  }

  throw new Error(`Timed out waiting for a new ${jobType} job after ${previousJobId}.`)
}

function stableJsonStringify(value: unknown): string {
  return JSON.stringify(sortValue(value))
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortValue(item))
  }

  if (typeof value !== 'object' || value === null) {
    return value
  }

  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nestedValue]) => [key, sortValue(nestedValue)]),
  )
}

function formatValue(value: unknown): string {
  return typeof value === 'string' ? JSON.stringify(value) : JSON.stringify(value)
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds)
  })
}

function parseArgs(argv: string[]): Record<string, boolean | string | undefined> {
  const parsed: Record<string, boolean | string | undefined> = {}

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) {
      continue
    }

    const key = token.slice(2)
    const next = argv[index + 1]
    if (!next || next.startsWith('--')) {
      parsed[key] = true
      continue
    }

    parsed[key] = next
    index += 1
  }

  return {
    approvalField: typeof parsed['approval-field'] === 'string' ? parsed['approval-field'] : undefined,
    catalogGroupId: parsed['catalog-group-id'],
    forceLiveRefresh: parsed['force-live-refresh'] === true,
    userEmail: parsed['user-email'],
  }
}
