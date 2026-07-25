import { createHash } from 'node:crypto'

import type { FastifyInstance, FastifyRequest } from 'fastify'

import {
  OperatorCaptureResponseSchema,
  OperatorCaptureUploadFieldsSchema,
  type OperatorCaptureResponse,
} from '../../shared/contracts/index.js'
import {
  findMssSlotsByNotePrefix,
  uploadStaticBundleToMssOneOffs,
  type MssStaticUploadResult,
} from '../ads/mssOneOffsUpload.js'
import { requireSessionUser } from '../auth/requireSession.js'
import { getPool } from '../db/pool.js'

const MAX_PNG_BYTES = 8 * 1024 * 1024
const MAX_PIXELS = 16_000_000
const CAPTURE_TTL_SECONDS = 24 * 60 * 60
const RATE_WINDOW_MS = 10 * 60 * 1000
const RATE_LIMIT = 5
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const ALLOWED_PAGE_HOSTS = new Set(['helios.freshlybaked.us', 'vpn-helios.freshlybaked.us', 'localhost'])

interface CaptureFields {
  captureKey?: string
  captureName?: string
  metadata?: string
  redirectUrl?: string
  png?: Buffer
  fileCount: number
}

interface CachedCapture {
  identityHash: string
  response: OperatorCaptureResponse
  userId: number
}

const completedCaptures = new Map<string, CachedCapture>()
const requestTimes = new Map<number, number[]>()

export async function registerOperatorCaptureRoutes(server: FastifyInstance): Promise<void> {
  server.post('/api/operator-captures', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'admin')
    if (!user) return
    if (!request.isMultipart()) {
      return reply.status(400).send({ error: 'multipart/form-data required.' })
    }
    let fields: CaptureFields
    try {
      fields = await collectCaptureFields(request)
    } catch (error) {
      if (error instanceof CaptureRequestError) return reply.status(error.status).send({ error: error.message })
      const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : ''
      if (code.startsWith('FST_')) return reply.status(413).send({ error: 'Capture multipart limits exceeded.' })
      throw error
    }
    if (fields.fileCount !== 1 || fields.png === undefined) {
      return reply.status(400).send({ error: 'Exactly one capture PNG is required.' })
    }
    const parsed = OperatorCaptureUploadFieldsSchema.safeParse({
      captureKey: fields.captureKey,
      captureName: fields.captureName,
      metadata: parseJson(fields.metadata),
      redirectUrl: fields.redirectUrl,
    })
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Capture fields are invalid.', issues: parsed.error.issues })
    }
    const dimensions = readPngDimensions(fields.png)
    const expectedWidth = Math.round(parsed.data.metadata.width * parsed.data.metadata.devicePixelRatio)
    const expectedHeight = Math.round(parsed.data.metadata.height * parsed.data.metadata.devicePixelRatio)
    if (
      fields.png.byteLength > MAX_PNG_BYTES ||
      dimensions === null ||
      dimensions.width * dimensions.height > MAX_PIXELS ||
      Math.abs(dimensions.width - expectedWidth) > 2 ||
      Math.abs(dimensions.height - expectedHeight) > 2
    ) {
      return reply.status(400).send({ error: 'Capture PNG failed size or dimension validation.' })
    }
    if (!isAllowedPageUrl(parsed.data.metadata.pageUrl)) {
      return reply.status(400).send({ error: 'Capture page URL is not an allowed Helios URL.' })
    }

    const capturedAt = new Date(parsed.data.metadata.capturedAt)
    const expectedExpiry = new Date(capturedAt.getTime() + CAPTURE_TTL_SECONDS * 1000)
    const metadataJson = Buffer.from(JSON.stringify({
      ...parsed.data.metadata,
      captureId: parsed.data.captureKey,
      captureName: parsed.data.captureName,
      expectedExpiresAt: expectedExpiry.toISOString(),
      redirectUrl: parsed.data.redirectUrl,
      requestedBy: { id: user.id, email: user.email, name: user.name },
    }, null, 2))
    const identityHash = createHash('sha256')
      .update(fields.png)
      .update(metadataJson)
      .digest('hex')
    pruneCompletedCaptures(Date.now())
    const cached = completedCaptures.get(parsed.data.captureKey)
    if (cached !== undefined) {
      if (cached.userId !== user.id || cached.identityHash !== identityHash) {
        return reply.status(409).send({ error: 'This capture key already identifies different content.' })
      }
      return reply.send(cached.response)
    }
    if (!admitRateLimit(user.id, Date.now())) {
      return reply.status(429).send({ error: 'Capture limit reached. Try again in a few minutes.' })
    }
    const reviewHtml = Buffer.from(renderReviewPage({
      captureName: parsed.data.captureName,
      capturedAt,
      expectedExpiry,
      metadata: parsed.data.metadata,
      redirectUrl: parsed.data.redirectUrl,
    }))
    const notePrefix = `helios-capture-v1:${parsed.data.captureKey}:`
    const note = `${notePrefix}${user.id}:${identityHash}`
    let response: OperatorCaptureResponse
    try {
      response = await withCaptureLock(parsed.data.captureKey, async () => {
        const existing = await reconcileCapture(notePrefix, note)
        if (existing !== null) return buildCaptureResponse(existing, parsed.data.captureKey, parsed.data.redirectUrl)
        try {
          const upload = await uploadStaticBundleToMssOneOffs({
            files: [
              { path: 'capture.png', bytes: fields.png!, contentType: 'image/png' },
              { path: 'index.html', bytes: reviewHtml, contentType: 'text/html; charset=utf-8' },
              { path: 'metadata.json', bytes: metadataJson, contentType: 'application/json' },
            ],
            note,
            ttlSeconds: CAPTURE_TTL_SECONDS,
          })
          return buildCaptureResponse(upload, parsed.data.captureKey, parsed.data.redirectUrl)
        } catch (error) {
          const recovered = await reconcileCapture(notePrefix, note)
          if (recovered !== null) return buildCaptureResponse(recovered, parsed.data.captureKey, parsed.data.redirectUrl)
          throw error
        }
      })
    } catch (error) {
      if (error instanceof CaptureConflictError) return reply.status(409).send({ error: error.message })
      throw error
    }
    completedCaptures.set(parsed.data.captureKey, { identityHash, response, userId: user.id })
    pruneCompletedCaptures(Date.now())
    return reply.status(201).send(response)
  })
}

async function collectCaptureFields(request: FastifyRequest): Promise<CaptureFields> {
  const result: CaptureFields = { fileCount: 0 }
  const seen = new Set<string>()
  for await (const part of request.parts({ limits: { fields: 4, fieldSize: 8_192, fileSize: MAX_PNG_BYTES, files: 1, parts: 5 } })) {
    if (seen.has(part.fieldname)) throw new CaptureRequestError(400, `Duplicate capture field: ${part.fieldname}.`)
    seen.add(part.fieldname)
    if (part.type === 'file') {
      result.fileCount += 1
      const bytes = await part.toBuffer()
      if (part.fieldname !== 'capture' || part.mimetype !== 'image/png') throw new CaptureRequestError(400, 'The capture file must be a PNG.')
      result.png = bytes
      continue
    }
    const value = typeof part.value === 'string' ? part.value : ''
    if (part.fieldname === 'captureKey') result.captureKey = value
    else if (part.fieldname === 'captureName') result.captureName = value
    else if (part.fieldname === 'metadata') result.metadata = value
    else if (part.fieldname === 'redirectUrl') result.redirectUrl = value
    else throw new CaptureRequestError(400, `Unknown capture field: ${part.fieldname}.`)
  }
  return result
}

function parseJson(value: string | undefined): unknown {
  if (value === undefined) return undefined
  try { return JSON.parse(value) as unknown } catch { return undefined }
}

function readPngDimensions(bytes: Buffer): { width: number; height: number } | null {
  if (
    bytes.byteLength < 33 ||
    !bytes.subarray(0, 8).equals(PNG_SIGNATURE) ||
    bytes.readUInt32BE(8) !== 13 ||
    bytes.toString('ascii', 12, 16) !== 'IHDR'
  ) {
    return null
  }
  const width = bytes.readUInt32BE(16)
  const height = bytes.readUInt32BE(20)
  return width > 0 && width <= 12_000 && height > 0 && height <= 12_000 ? { height, width } : null
}

function isAllowedPageUrl(value: string): boolean {
  const url = new URL(value)
  return (url.protocol === 'https:' || (url.protocol === 'http:' && url.hostname === 'localhost')) &&
    ALLOWED_PAGE_HOSTS.has(url.hostname) && url.username === '' && url.password === ''
}

function admitRateLimit(userId: number, now: number): boolean {
  const recent = (requestTimes.get(userId) ?? []).filter((time) => now - time < RATE_WINDOW_MS)
  if (recent.length >= RATE_LIMIT) {
    requestTimes.set(userId, recent)
    return false
  }
  recent.push(now)
  requestTimes.set(userId, recent)
  return true
}

function pruneCompletedCaptures(now: number): void {
  for (const [key, cached] of completedCaptures) {
    if (new Date(cached.response.expiresAt).getTime() <= now) completedCaptures.delete(key)
  }
}

async function reconcileCapture(notePrefix: string, exactNote: string): Promise<MssStaticUploadResult | null> {
  const matches = await findMssSlotsByNotePrefix(notePrefix)
  const exact = matches.filter((slot) => slot.note === exactNote)
  if (matches.length !== exact.length) {
    throw new CaptureConflictError('This capture key already identifies different content.')
  }
  return exact.sort((left, right) => right.expiresAt.getTime() - left.expiresAt.getTime())[0] ?? null
}

function buildCaptureResponse(
  upload: MssStaticUploadResult,
  captureId: string,
  redirectUrl: string,
): OperatorCaptureResponse {
  const baseUrl = upload.publicUrl.endsWith('/') ? upload.publicUrl : `${upload.publicUrl}/`
  return OperatorCaptureResponseSchema.parse({
    captureId,
    directUrl: new URL('capture.png', baseUrl).toString(),
    expiresAt: upload.expiresAt.toISOString(),
    redirectUrl,
    reviewUrl: baseUrl,
  })
}

async function withCaptureLock<T>(captureKey: string, action: () => Promise<T>): Promise<T> {
  const digest = createHash('sha256').update(captureKey).digest()
  const lockPartOne = digest.readInt32BE(0)
  const lockPartTwo = digest.readInt32BE(4)
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock($1, $2)', [lockPartOne, lockPartTwo])
    const result = await action()
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

class CaptureRequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

class CaptureConflictError extends Error {}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;')
}

function renderReviewPage(args: {
  captureName: string
  capturedAt: Date
  expectedExpiry: Date
  metadata: { pageUrl: string; renderer: string; viewportHeight: number; viewportWidth: number }
  redirectUrl: string
}): string {
  const name = escapeHtml(args.captureName.replaceAll('-', ' '))
  const capturedLabel = formatNewYorkDateTime(args.capturedAt)
  const expiryLabel = formatNewYorkDateTime(args.expectedExpiry)
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${name} capture</title><style>
body{margin:0;background:#eee8df;color:#211b16;font:16px/1.45 system-ui,sans-serif}main{max-width:1440px;margin:auto;padding:16px}header{display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap;margin-bottom:12px}h1{font-size:clamp(1.2rem,3vw,1.8rem);margin:0;text-transform:capitalize}img{display:block;width:100%;height:auto;background:white;border:1px solid #c9bcae;box-shadow:0 4px 18px #0002}a{color:#075b9c}details{margin-top:14px;background:white;padding:12px;border-radius:8px}dl{display:grid;grid-template-columns:max-content 1fr;gap:6px 12px}dd{margin:0;overflow-wrap:anywhere}
</style></head><body><main><header><h1>${name} capture</h1><a href="${escapeHtml(args.redirectUrl)}">Return to task</a></header>
<a href="capture.png"><img src="capture.png" alt="Captured Helios page"></a>
<details><summary>Capture details</summary><dl>
<dt>Captured</dt><dd>${escapeHtml(capturedLabel)}</dd><dt>Expected expiry</dt><dd>${escapeHtml(expiryLabel)}</dd>
<dt>Source</dt><dd><a href="${escapeHtml(args.metadata.pageUrl)}">${escapeHtml(args.metadata.pageUrl)}</a></dd>
<dt>Viewport</dt><dd>${args.metadata.viewportWidth} × ${args.metadata.viewportHeight}</dd><dt>Renderer</dt><dd>${escapeHtml(args.metadata.renderer)}</dd>
</dl><p><a href="metadata.json">Download metadata</a></p></details></main></body></html>`
}

function formatNewYorkDateTime(value: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'long',
    timeZone: 'America/New_York',
  }).format(value)
}

export function resetOperatorCaptureStateForTests(): void {
  completedCaptures.clear()
  requestTimes.clear()
}
