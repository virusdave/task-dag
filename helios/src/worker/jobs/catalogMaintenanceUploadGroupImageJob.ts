/**
 * Resilient catalog-maintenance group image upload — worker side.
 *
 * The /catalog/maintenance "Images & Barcodes" page used to do its
 * Sweed blob upload + group.edit synchronously inside the Fastify
 * request handler. That meant any transport blip or dead-token
 * failure during the upload silently lost the operator's bytes.
 *
 * The new flow:
 *   1. Fastify route stashes incoming bytes via
 *      PendingImageUploadStore and enqueues this job.
 *   2. Worker runs the handler inside withSweedSession() — we lease
 *      a token from sweed_session_tokens and pin the state dealer.
 *   3. Handler does the full Sweed sequence with a verify read-back.
 *   4. On success we flag the catalog group for reanalysis (so the
 *      cached live_state picks up the new image) and delete the
 *      staged bytes; on transient failure the job is left queued so
 *      the worker's standard retry/backoff re-tries against the
 *      same staged bytes — no operator re-upload.
 *
 * Survey cache invalidation:
 *   `loadCatalogMaintenanceSurvey` keeps an in-process 60s memo on
 *   the server. We can't reach it from this worker process; the UI
 *   compensates by re-fetching the survey with ?refresh=1 when the
 *   job transitions to `succeeded`. The TTL also bounds staleness
 *   for anyone refreshing the page within the next minute.
 */

import { getCurrentSweedSessionClaim } from '../sweed/session.js'
import { callSweedRpc } from '../sweed/rpc.js'
import { z } from 'zod'

import { getWorkerEnv } from '../config/env.js'
import { getPool } from '../../server/db/pool.js'
import { flagSweedGroupForReanalysis } from '../../server/catalog/maintenance.js'
import { getPendingImageUploadStore } from '../../server/catalog/pendingImageUploadStore.js'
import type { CatalogMaintenanceUploadGroupImageJobPayload } from '../../shared/contracts/index.js'
import type { JobHandlerContext } from '../runtime/jobRegistry.js'

const SWEED_BLOB_UPLOAD_URL = 'https://prime.sweedpos.com/api/blobs/upload'
const SWEED_REQUEST_TIMEOUT_MS = 30_000

const SweedImageRefSchema = z
  .object({
    id: z.union([z.coerce.number().int(), z.string().trim().min(1)]).nullable().optional(),
    url: z.string().nullable().optional(),
  })
  .passthrough()

const SweedGroupImagesSchema = z
  .object({
    id: z.coerce.number().int(),
    images: z.array(SweedImageRefSchema).default([]),
  })
  .passthrough()

const BlobAddResultSchema = z.union([
  z.string().trim().min(1),
  z
    .object({ id: z.string().trim().min(1) })
    .passthrough()
    .transform((value) => value.id),
])

const TOTAL_PHASES = 5

export async function runCatalogMaintenanceUploadGroupImageJob(
  context: JobHandlerContext,
  payload: CatalogMaintenanceUploadGroupImageJobPayload,
): Promise<void> {
  // jobRegistry already wrapped us in withSweedSession() because
  // 'catalog.maintenance.upload_group_image' is in
  // SWEED_BACKED_JOB_TYPES. We sanity-check rather than open a
  // nested session.
  if (getCurrentSweedSessionClaim() === null) {
    throw new Error(
      'catalogMaintenanceUploadGroupImageJob: no active Sweed session — ' +
        "this job type must be in SWEED_BACKED_JOB_TYPES so the runner wraps it.",
    )
  }

  const store = getPendingImageUploadStore()

  await updateJobProgress(context.id, {
    phase: 'loading-staged-bytes',
    phaseIndex: 1,
    phaseCount: TOTAL_PHASES,
    message: `Loading staged image ${payload.stagedRef}…`,
    completed: null,
    total: null,
  })
  const staged = await store.read(payload.stagedRef)

  if (staged.meta.targetType !== 'group') {
    throw new Error(
      `Staged image ${payload.stagedRef} targetType is ${staged.meta.targetType}; only 'group' uploads are supported by this job.`,
    )
  }
  if (staged.meta.sweedGroupId !== payload.sweedGroupId) {
    throw new Error(
      `Staged meta sweedGroupId ${staged.meta.sweedGroupId} disagrees with job payload sweedGroupId ${payload.sweedGroupId}.`,
    )
  }

  const stateDealerId = getWorkerEnv().sweedStateDealerId

  await updateJobProgress(context.id, {
    phase: 'creating-blob',
    phaseIndex: 2,
    phaseCount: TOTAL_PHASES,
    message: 'Asking Sweed for a fresh blob id…',
    completed: null,
    total: null,
  })
  const blobIdRaw = await callSweedRpc<unknown>(stateDealerId, 'store.blob.add', {
    type: 'banner',
  })
  const blobId = BlobAddResultSchema.parse(blobIdRaw)

  await updateJobProgress(context.id, {
    phase: 'uploading-bytes',
    phaseIndex: 3,
    phaseCount: TOTAL_PHASES,
    message: `Uploading ${staged.bytes.byteLength} bytes to Sweed blob ${blobId}…`,
    completed: 0,
    total: staged.bytes.byteLength,
  })
  await putBlobBytes(blobId, staged.bytes, staged.meta.contentType)

  await updateJobProgress(context.id, {
    phase: 'attaching-to-group',
    phaseIndex: 4,
    phaseCount: TOTAL_PHASES,
    message: `Attaching blob ${blobId} to Sweed group ${payload.sweedGroupId}…`,
    completed: null,
    total: null,
  })
  const existingGroupRaw = await callSweedRpc<unknown>(stateDealerId, 'store.product.group.get', {
    id: payload.sweedGroupId,
  })
  const existingGroup = SweedGroupImagesSchema.parse(existingGroupRaw)
  const existingImageIds = collectExistingImageIds(existingGroup.images)
  const nextImageIds = appendUnique(existingImageIds, blobId)
  await callSweedRpc(stateDealerId, 'store.product.group.edit', {
    id: payload.sweedGroupId,
    imagesIds: nextImageIds,
  })

  // Read-back verification: Sweed's `store.product.group.edit` does
  // not return a body reflecting the post-edit image list, and we've
  // seen silent no-ops in adjacent variant-image paths. Re-fetch and
  // confirm the new blob is actually attached so a failed write does
  // not silently look like success.
  const refreshedRaw = await callSweedRpc<unknown>(stateDealerId, 'store.product.group.get', {
    id: payload.sweedGroupId,
  })
  const refreshed = SweedGroupImagesSchema.parse(refreshedRaw)
  const matching = refreshed.images.filter((image) => normalizeImageId(image) === blobId)
  if (matching.length === 0) {
    throw new Error(
      `Sweed accepted store.product.group.edit for group ${payload.sweedGroupId} but the new image blob ${blobId} is not present in the refreshed image list (got ${describeImageIds(refreshed.images)}). The upload did NOT take effect.`,
    )
  }

  await updateJobProgress(context.id, {
    phase: 'flagging-for-reanalysis',
    phaseIndex: 5,
    phaseCount: TOTAL_PHASES,
    message: `Flagging catalog group ${payload.catalogGroupId} for reanalysis…`,
    completed: null,
    total: null,
  })
  await flagSweedGroupForReanalysis({
    sweedGroupId: payload.sweedGroupId,
    reason: 'catalog_maintenance_group_image_upload',
    requestedByUserId: payload.requestedByUserId,
  })

  // Only delete staged bytes after every Sweed write *and* the
  // verify read have succeeded. If we throw before this line the
  // bytes remain on disk and the standard job retry/backoff picks
  // them back up via the same stagedRef on the next attempt.
  await store.delete(payload.stagedRef)
}

async function putBlobBytes(
  blobId: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<void> {
  const response = await fetch(`${SWEED_BLOB_UPLOAD_URL}/${blobId}`, {
    body: bytes,
    headers: {
      'content-type': contentType,
      'user-agent': 'helios-worker/1.0',
    },
    method: 'PUT',
    signal: AbortSignal.timeout(SWEED_REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) {
    const responseText = await safeText(response)
    throw new Error(`Blob upload failed for ${blobId}: HTTP ${response.status}${responseText ? `: ${responseText}` : ''}.`)
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    const text = await response.text()
    return text.replace(/\s+/g, ' ').trim().slice(0, 240)
  } catch {
    return ''
  }
}

function collectExistingImageIds(images: Array<z.infer<typeof SweedImageRefSchema>>): string[] {
  const seen = new Set<string>()
  const ids: string[] = []
  for (const image of images) {
    const id = normalizeImageId(image)
    if (id === null || seen.has(id)) continue
    seen.add(id)
    ids.push(id)
  }
  return ids
}

function appendUnique(existing: string[], blobId: string): string[] {
  const filtered = existing.filter((id) => id !== blobId)
  filtered.push(blobId)
  return filtered
}

function normalizeImageId(image: z.infer<typeof SweedImageRefSchema>): string | null {
  if (image.id === undefined || image.id === null) return null
  return String(image.id)
}

function describeImageIds(images: Array<z.infer<typeof SweedImageRefSchema>>): string {
  if (images.length === 0) return '[]'
  const ids = images.map((image) => normalizeImageId(image) ?? '<no-id>')
  return `[${ids.join(', ')}]`
}

/* -------------------------------------------------------------------------- */
/*  Progress reporting — mirrors screensBannerRefreshJob.updateJobProgress.    */
/* -------------------------------------------------------------------------- */

interface ProgressBeacon {
  phase: string
  phaseIndex: number
  phaseCount: number
  message: string
  completed: number | null
  total: number | null
}

const MAX_JOB_PROGRESS_LOG_ENTRIES = 50

async function updateJobProgress(jobId: number, progress: ProgressBeacon): Promise<void> {
  const progressLogEntry = JSON.stringify({
    createdAt: new Date().toISOString(),
    message: progress.message,
  })

  await getPool().query(
    `
      update job_queue
      set payload_json = (
            jsonb_set(
              jsonb_set(coalesce(payload_json, '{}'::jsonb), '{progress}', $2::jsonb, true),
              '{progressLog}',
              (
                select coalesce(jsonb_agg(entry order by ordinality asc), '[]'::jsonb)
                from (
                  select entry, ordinality
                  from (
                    select entry, ordinality
                    from jsonb_array_elements(coalesce(payload_json->'progressLog', '[]'::jsonb) || $3::jsonb) with ordinality as log_entries(entry, ordinality)
                    order by ordinality desc
                    limit ${MAX_JOB_PROGRESS_LOG_ENTRIES}
                  ) recent_entries
                ) trimmed_entries
              ),
              true
            )
          ),
          updated_at = now()
      where id = $1
    `,
    [jobId, JSON.stringify(progress), progressLogEntry],
  )
}
