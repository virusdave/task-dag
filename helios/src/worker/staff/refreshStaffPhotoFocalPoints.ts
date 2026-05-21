// In-worker task that brings the staff_photo_focal_points cache up
// to date with the current set of approved-and-with-photo staff
// directory rows.
//
// Why in-worker (not a job_queue row, not an external cron script):
//   * The user explicitly chose "worker computes focal points
//     async" over server-inline and over an external deploy hook.
//   * helios-worker is the long-lived process that already has the
//     Mantle bearer token and database pool, and it's already
//     restarted/reloaded by the host's helios deploy lifecycle.
//   * Running inside the worker process means startup, restart,
//     reload, and system reload all naturally re-trigger this pass
//     (entrypoint runs it immediately; SIGHUP re-runs it; see
//     worker/main.ts).
//
// Append-only cache semantics: each portrait's focal point is
// computed at most once per Sweed URL. We never overwrite. New
// staff photos get processed on the next pass; rotated photos
// (Sweed re-upload → new UUID/URL) become a brand-new cache row.

import { getPool } from '../../server/db/pool.js'
import {
  insertStaffPhotoFocalPointIfAbsent,
  listApprovedTeamMembersMissingFocalPoint,
} from '../../server/db/queries/staffQueries.js'
import { getWorkerEnv } from '../config/env.js'

const FOCAL_POINT_MODEL = 'google.gemma-3-27b-it'

// Bound concurrent Mantle calls so a fresh deploy with N new staffers
// doesn't blast the LLM endpoint. The work is not latency-critical.
const PER_PASS_CONCURRENCY = 2

// Sweed photo URLs look like
//   https://media-prime.sweedpos.com/store/prime/1777909975_05da973a-9c9d-4b3d-b39d-820adaf6f983.jpg
// We use the UUID portion as the append-only cache key (stable per
// uploaded image, rotates when a new file is uploaded).
const SWEED_UUID_REGEX = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i

interface FocalPointResult {
  x: number
  y: number
  confidence: number
  rationale: string | null
}

function extractSweedUuid(url: string): string | null {
  const m = url.match(SWEED_UUID_REGEX)
  return m ? m[1].toLowerCase() : null
}

async function fetchPhotoBytes(url: string): Promise<{ bytes: Buffer; contentType: string }> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) {
    throw new Error(`Photo fetch returned HTTP ${response.status} for ${url}`)
  }
  const contentType = response.headers.get('content-type') ?? 'application/octet-stream'
  const arrayBuffer = await response.arrayBuffer()
  return { bytes: Buffer.from(arrayBuffer), contentType }
}

interface MantleVisionResult {
  raw: unknown
  text: string
}

async function askMantleForFocalPoint(
  imageBytes: Buffer,
  contentType: string,
): Promise<MantleVisionResult> {
  const env = getWorkerEnv()
  if (!env.bedrockMantleBearerToken) {
    throw new Error('BEDROCK_MANTLE_BEARER_TOKEN is required to compute staff-photo focal points.')
  }
  // Normalize content type to one Mantle understands; default to
  // image/jpeg if Sweed returned something generic.
  const safeContentType =
    /^image\/(jpeg|png|webp|gif)$/.test(contentType) ? contentType : 'image/jpeg'
  const dataUrl = `data:${safeContentType};base64,${imageBytes.toString('base64')}`
  const systemPrompt =
    'You are an image-cropping assistant. Given a single portrait photograph, output strict JSON ' +
    'identifying the normalized (0..1) coordinates of the subject\'s face center (the point that ' +
    'should remain visible under a square or 4:5 center-crop). Use (0,0)=top-left, (1,1)=bottom-right. ' +
    'Also output a confidence in [0,1] and a one-sentence rationale.'
  const userPrompt =
    'Return ONLY a JSON object with this exact shape: ' +
    '{"x": <number>, "y": <number>, "confidence": <number>, "rationale": "<string>"}. ' +
    'No prose, no markdown fences.'

  const response = await fetch(`${env.bedrockMantleBaseUrl}/chat/completions`, {
    body: JSON.stringify({
      max_tokens: 200,
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: [
            { type: 'text', text: userPrompt },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        },
      ],
      model: FOCAL_POINT_MODEL,
      response_format: { type: 'json_object' },
      temperature: 0,
      top_p: 0.1,
    }),
    headers: {
      Authorization: `Bearer ${env.bedrockMantleBearerToken}`,
      'Content-Type': 'application/json',
    },
    method: 'POST',
    signal: AbortSignal.timeout(env.llmRequestTimeoutMs),
  })
  const responseText = await response.text()
  if (!response.ok) {
    throw new Error(`Mantle focal-point request returned HTTP ${response.status}: ${responseText.slice(0, 400)}`)
  }
  const parsed: unknown = JSON.parse(responseText)
  const choices = (parsed as { choices?: unknown }).choices
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new Error('Mantle focal-point response had no choices.')
  }
  const first = choices[0] as { message?: { content?: unknown } }
  const content = first.message?.content
  let text: string
  if (typeof content === 'string') {
    text = content
  } else if (Array.isArray(content)) {
    text = content
      .map((part) =>
        part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
          ? (part as { text: string }).text
          : '',
      )
      .join('')
  } else {
    throw new Error('Mantle focal-point response had no text content.')
  }
  return { raw: parsed, text }
}

function parseFocalPointJson(text: string): FocalPointResult {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '')
  const parsed: unknown = JSON.parse(trimmed)
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Mantle focal-point output was not an object.')
  }
  const obj = parsed as Record<string, unknown>
  const x = Number(obj.x)
  const y = Number(obj.y)
  const confidence = Number(obj.confidence)
  if (!Number.isFinite(x) || x < 0 || x > 1) {
    throw new Error(`Invalid x coordinate: ${String(obj.x)}`)
  }
  if (!Number.isFinite(y) || y < 0 || y > 1) {
    throw new Error(`Invalid y coordinate: ${String(obj.y)}`)
  }
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new Error(`Invalid confidence: ${String(obj.confidence)}`)
  }
  const rationale = typeof obj.rationale === 'string' ? obj.rationale.slice(0, 1000) : null
  return { x, y, confidence, rationale }
}

async function computeFocalPointForUrl(photoUrl: string): Promise<FocalPointResult> {
  const { bytes, contentType } = await fetchPhotoBytes(photoUrl)
  const mantle = await askMantleForFocalPoint(bytes, contentType)
  return parseFocalPointJson(mantle.text)
}

export interface RefreshFocalPointsResult {
  consideredCount: number
  insertedCount: number
  skippedNoUuidCount: number
  errors: Array<{ staffId: string; photoUrl: string; error: string }>
}

/**
 * Compute + insert focal points for every approved staff photo that
 * doesn't already have one cached. Idempotent and append-only:
 * re-running this is safe and fast (it skips photos whose UUID is
 * already cached). Per-photo failures are isolated; one bad photo
 * does not block the rest of the pass.
 */
export async function refreshStaffPhotoFocalPoints(): Promise<RefreshFocalPointsResult> {
  const pool = getPool()
  let missing: Awaited<ReturnType<typeof listApprovedTeamMembersMissingFocalPoint>>
  try {
    missing = await listApprovedTeamMembersMissingFocalPoint(pool)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/relation .*staff_(directory_cache|inclusion|photo_focal_points).* does not exist/i.test(message)) {
      console.warn(`[staff-focal-points] tables not yet migrated; skipping: ${message}`)
      return { consideredCount: 0, insertedCount: 0, skippedNoUuidCount: 0, errors: [] }
    }
    throw error
  }
  const result: RefreshFocalPointsResult = {
    consideredCount: missing.length,
    insertedCount: 0,
    skippedNoUuidCount: 0,
    errors: [],
  }
  if (missing.length === 0) {
    console.log('[staff-focal-points] cache up to date; no photos to process.')
    return result
  }
  console.log(`[staff-focal-points] computing focal points for ${missing.length} photo(s)...`)

  // Simple bounded-concurrency loop. We process the queue head-first
  // and let each finishing worker pull the next item.
  let cursor = 0
  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor++
      if (index >= missing.length) return
      const row = missing[index]
      const sweedUuid = extractSweedUuid(row.photoUrl)
      if (sweedUuid === null) {
        result.skippedNoUuidCount += 1
        console.warn(
          `[staff-focal-points] no UUID extractable from URL for staff ${row.staffId}: ${row.photoUrl}`,
        )
        continue
      }
      try {
        const focal = await computeFocalPointForUrl(row.photoUrl)
        const insertResult = await insertStaffPhotoFocalPointIfAbsent(pool, {
          sweedUuid,
          sweedUrl: row.photoUrl,
          x: focal.x,
          y: focal.y,
          confidence: focal.confidence,
          model: FOCAL_POINT_MODEL,
          rationale: focal.rationale,
        })
        if (insertResult.inserted) {
          result.insertedCount += 1
          console.log(
            `[staff-focal-points] inserted focal point for staff ${row.staffId} (uuid ${sweedUuid}): ` +
              `x=${focal.x.toFixed(3)} y=${focal.y.toFixed(3)} conf=${focal.confidence.toFixed(2)}`,
          )
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        result.errors.push({ staffId: row.staffId, photoUrl: row.photoUrl, error: message })
        console.error(
          `[staff-focal-points] failed for staff ${row.staffId} (${row.photoUrl}): ${message}`,
        )
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(PER_PASS_CONCURRENCY, missing.length) }, () => worker()),
  )
  console.log(
    `[staff-focal-points] pass complete: considered=${result.consideredCount} ` +
      `inserted=${result.insertedCount} skippedNoUuid=${result.skippedNoUuidCount} ` +
      `errors=${result.errors.length}`,
  )
  return result
}

// Single-flight guard so a SIGHUP that arrives mid-pass does not
// fan out two overlapping passes (which would still be correct
// thanks to the append-only insert, but would waste Mantle budget).
let currentRun: Promise<RefreshFocalPointsResult> | null = null
let queuedRerun = false

export function triggerStaffPhotoFocalPointsRefresh(reason: string): void {
  if (currentRun !== null) {
    queuedRerun = true
    console.log(`[staff-focal-points] refresh already in-flight; queued rerun (reason=${reason}).`)
    return
  }
  console.log(`[staff-focal-points] starting refresh (reason=${reason}).`)
  currentRun = refreshStaffPhotoFocalPoints()
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[staff-focal-points] refresh pass crashed: ${message}`)
      return { consideredCount: 0, insertedCount: 0, skippedNoUuidCount: 0, errors: [] }
    })
    .finally(() => {
      currentRun = null
      if (queuedRerun) {
        queuedRerun = false
        triggerStaffPhotoFocalPointsRefresh('queued-rerun')
      }
    })
}
