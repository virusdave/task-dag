import * as crypto from 'node:crypto'
import { once } from 'node:events'
import { createReadStream, type ReadStream } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import { pipeline } from 'node:stream/promises'

import { z } from 'zod'

/**
 * In-process port of scripts/upload-to-mss (the bash uploader).
 *
 * Stages the file under /var/lib/mss-one-offs/incoming/<uploadId>/index.html
 * and POSTs a slot-claim to the mss-one-offs control socket. Returns
 * the public URL on success.
 *
 * Configurable via env so dev hosts that don't run mss-one-offs can
 * point at an alternate staging dir + socket:
 *   MSS_ONE_OFFS_INCOMING_DIR   default: /var/lib/mss-one-offs/incoming
 *   MSS_ONE_OFFS_CONTROL_SOCKET default: /run/mss-one-offs/control.sock
 */

const DEFAULT_INCOMING_DIR = '/var/lib/mss-one-offs/incoming'
const DEFAULT_CONTROL_SOCKET = '/run/mss-one-offs/control.sock'

export interface MssUploadResult {
  publicUrl: string
  uploadId: string
}

export class MssUploadError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message)
  }
}

const UploadStatusSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/),
  declared: z.object({ files: z.number().int().nonnegative(), bytes: z.number().int().nonnegative() }),
  completed: z.object({ files: z.number().int().nonnegative(), bytes: z.number().int().nonnegative() }),
  complete: z.boolean(),
})

const SlotResponseSchema = z.object({
  nonce: z.string().min(1),
  url: z.url(),
  expiresAtMs: z.number().int().positive(),
  note: z.string().nullable(),
  uploadId: z.string().min(1),
})

const SlotListSchema = z.object({ slots: z.array(SlotResponseSchema) })

interface MssStaticFileBase {
  path: string
  contentType: string
}

export type MssStaticFile = MssStaticFileBase & (
  | { bytes: Buffer; sourcePath?: never; byteLength?: never }
  | { bytes?: never; sourcePath: string; byteLength: number }
)

export interface MssStaticUploadResult {
  publicUrl: string
  expiresAt: Date
  nonce: string
}

export interface MssStaticSlotResult extends MssStaticUploadResult {
  note: string
}

export async function findMssSlotsByNotePrefix(notePrefix: string): Promise<MssStaticSlotResult[]> {
  const socketPath = process.env.MSS_ONE_OFFS_CONTROL_SOCKET?.trim() || DEFAULT_CONTROL_SOCKET
  const list = SlotListSchema.parse(await unixSocketRequestJson({
    maxResponseBytes: 2 * 1024 * 1024,
    method: 'GET',
    path: '/v1/slots',
    socketPath,
  }))
  return list.slots
    .filter((slot): slot is typeof slot & { note: string } => slot.note?.startsWith(notePrefix) === true)
    .map((slot) => ({ ...validatedSlotResult(slot), note: slot.note }))
}

/** Publish a static bundle through the daemon-owned streaming API. */
export async function uploadStaticBundleToMssOneOffs(args: {
  files: readonly MssStaticFile[]
  note: string
  ttlSeconds: number
}): Promise<MssStaticUploadResult> {
  const socketPath = process.env.MSS_ONE_OFFS_CONTROL_SOCKET?.trim() || DEFAULT_CONTROL_SOCKET
  const declaredBytes = args.files.reduce((total, file) => total + fileByteLength(file), 0)
  const reservation = UploadStatusSchema.parse(await unixSocketRequestJson({
    body: Buffer.from(JSON.stringify({ files: args.files.length, bytes: declaredBytes })),
    contentType: 'application/json',
    method: 'POST',
    path: '/v1/uploads',
    socketPath,
  }))
  let pendingUploadId: string | null = reservation.id
  try {
    let finalStatus = reservation
    for (const file of args.files) {
      finalStatus = UploadStatusSchema.parse(await unixSocketRequestJson({
        body: file.bytes,
        bodyPath: file.sourcePath,
        bodyLength: fileByteLength(file),
        contentType: file.contentType,
        method: 'PUT',
        path: `/v1/uploads/${reservation.id}/${file.path}`,
        socketPath,
      }))
      if (finalStatus.id !== reservation.id) {
        throw new MssUploadError('mss-one-offs returned a mismatched upload id')
      }
    }
    if (
      !finalStatus.complete ||
      finalStatus.completed.files !== args.files.length ||
      finalStatus.completed.bytes !== declaredBytes
    ) {
      throw new MssUploadError('mss-one-offs did not confirm exact upload completion')
    }
    const slot = SlotResponseSchema.parse(await unixSocketRequestJson({
      body: Buffer.from(JSON.stringify({
        note: args.note,
        requestedBy: os.userInfo().username,
        ttlSeconds: args.ttlSeconds,
        uploadId: reservation.id,
      })),
      contentType: 'application/json',
      method: 'POST',
      path: '/v1/slots',
      socketPath,
    }))
    if (slot.uploadId !== reservation.id || slot.note !== args.note) {
      throw new MssUploadError('mss-one-offs activation response did not match the uploaded bundle')
    }
    const result = validatedSlotResult(slot)
    pendingUploadId = null
    return result
  } catch (error) {
    throw error instanceof MssUploadError
      ? error
      : new MssUploadError(`mss-one-offs streaming upload failed: ${(error as Error).message}`)
  } finally {
    if (pendingUploadId !== null) {
      await discardPendingUpload(socketPath, pendingUploadId)
    }
  }
}

async function discardPendingUpload(socketPath: string, uploadId: string): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await unixSocketRequestJson({
        method: 'DELETE', path: `/v1/uploads/${uploadId}`, socketPath, timeoutMs: 3_000,
      })
      return
    } catch (error) {
      if (!(error instanceof MssUploadError) || error.code !== 'upload_busy' || attempt === 3) return
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
}

function fileByteLength(file: MssStaticFile): number {
  if (file.bytes !== undefined) return file.bytes.byteLength
  return file.byteLength
}

function validatedSlotResult(slot: z.infer<typeof SlotResponseSchema>): MssStaticUploadResult {
  if (!/^[A-Za-z0-9_-]{24,128}$/u.test(slot.nonce)) {
    throw new MssUploadError('mss-one-offs returned an invalid slot nonce')
  }
  const expectedUrl = `https://vpn-helios.freshlybaked.us/one-offs/${slot.nonce}/`
  if (slot.url !== expectedUrl) {
    throw new MssUploadError(`mss-one-offs returned an unexpected private URL for slot ${slot.nonce}`)
  }
  const expiresAt = new Date(slot.expiresAtMs)
  const now = Date.now()
  if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= now || expiresAt.getTime() > now + 86_460_000) {
    throw new MssUploadError('mss-one-offs returned an invalid capture expiry')
  }
  return { expiresAt, nonce: slot.nonce, publicUrl: expectedUrl }
}

export async function uploadToMssOneOffs(args: {
  sourcePath: string
  note: string
  ttlSeconds: number
}): Promise<MssUploadResult> {
  const incomingRoot = process.env.MSS_ONE_OFFS_INCOMING_DIR?.trim() || DEFAULT_INCOMING_DIR
  const socketPath = process.env.MSS_ONE_OFFS_CONTROL_SOCKET?.trim() || DEFAULT_CONTROL_SOCKET

  const uploadId = `upload-${stampNow()}-${crypto.randomBytes(4).toString('hex')}`
  const incomingDir = path.join(incomingRoot, uploadId)
  await fs.mkdir(incomingDir, { recursive: true })
  const dest = path.join(incomingDir, 'index.html')
  await fs.copyFile(args.sourcePath, dest)

  const payload = JSON.stringify({
    uploadId,
    ttlSeconds: args.ttlSeconds,
    requestedBy: os.userInfo().username,
    note: args.note,
  })

  const body = await unixSocketPostJson({
    socketPath,
    path: '/v1/slots',
    payload,
  })

  let parsed: { url?: string; error?: string }
  try {
    parsed = JSON.parse(body) as { url?: string; error?: string }
  } catch (err) {
    throw new MssUploadError(
      `mss-one-offs returned non-JSON: ${body.slice(0, 400)} (parse err: ${(err as Error).message})`,
    )
  }
  if (parsed.error) {
    throw new MssUploadError(`mss-one-offs rejected slot claim: ${parsed.error}`)
  }
  if (!parsed.url) {
    throw new MssUploadError(`mss-one-offs returned no url: ${body.slice(0, 400)}`)
  }
  return { publicUrl: parsed.url, uploadId }
}

function stampNow(): string {
  // Format: YYYYMMDD-HHMMSS in local time, matching the bash version
  // (which used `date +%Y%m%d-%H%M%S` without -u).
  const d = new Date()
  const pad = (n: number) => n.toString().padStart(2, '0')
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  )
}

function unixSocketPostJson(args: {
  socketPath: string
  path: string
  payload: string
}): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath: args.socketPath,
        path: args.path,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(args.payload).toString(),
          host: 'localhost',
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf-8')
          if (res.statusCode && res.statusCode >= 400) {
            reject(
              new MssUploadError(
                `mss-one-offs ${args.path} returned ${res.statusCode}: ${text.slice(0, 400)}`,
              ),
            )
            return
          }
          resolve(text)
        })
        res.on('error', (err) => reject(new MssUploadError(`mss-one-offs response error: ${err.message}`)))
      },
    )
    req.on('error', (err) => {
      reject(
        new MssUploadError(
          `mss-one-offs control socket (${args.socketPath}) unreachable: ${err.message}`,
        ),
      )
    })
    req.write(args.payload)
    req.end()
  })
}

function unixSocketRequestJson(args: {
  socketPath: string
  path: string
  method: 'DELETE' | 'GET' | 'POST' | 'PUT'
  body?: Buffer
  bodyPath?: string
  bodyLength?: number
  contentType?: string
  maxResponseBytes?: number
  timeoutMs?: number
}): Promise<unknown> {
  let request: http.ClientRequest | undefined
  let source: ReadStream | undefined
  let timer: ReturnType<typeof setTimeout>
  const responsePromise = new Promise<unknown>((resolve, reject) => {
    let settled = false
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      callback()
    }
    const headers: Record<string, string> = { host: 'localhost' }
    if (args.body !== undefined || args.bodyPath !== undefined) {
      headers['content-length'] = String(args.body?.byteLength ?? args.bodyLength)
      headers['content-type'] = args.contentType ?? 'application/octet-stream'
    }
    request = http.request(
      { headers, method: args.method, path: args.path, socketPath: args.socketPath },
      (res) => {
        const chunks: Buffer[] = []
        let total = 0
        res.on('data', (chunk: Buffer) => {
          total += chunk.byteLength
          if (total <= (args.maxResponseBytes ?? 64 * 1024)) chunks.push(chunk)
        })
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          if (total > (args.maxResponseBytes ?? 64 * 1024)) {
            finish(() => reject(new MssUploadError(`mss-one-offs ${args.path} returned an oversized response`)))
            return
          }
          if ((res.statusCode ?? 500) >= 400) {
            finish(() => reject(new MssUploadError(
              `mss-one-offs ${args.path} returned ${res.statusCode}: ${text.slice(0, 400)}`,
              responseErrorCode(text),
            )))
            return
          }
          try {
            finish(() => resolve(JSON.parse(text) as unknown))
          } catch {
            finish(() => reject(new MssUploadError(`mss-one-offs ${args.path} returned non-JSON: ${text.slice(0, 400)}`)))
          }
        })
        res.on('error', (error) => finish(() => reject(new MssUploadError(`mss-one-offs response error: ${error.message}`))))
      },
    )
    timer = setTimeout(() => {
      finish(() => reject(new MssUploadError(`mss-one-offs ${args.path} timed out`)))
      request?.destroy()
    }, args.timeoutMs ?? (args.bodyPath === undefined ? 15_000 : 120_000))
    request.on('error', (error) => finish(() => reject(new MssUploadError(`mss-one-offs control socket (${args.socketPath}) unreachable: ${error.message}`))))
  })
  if (request === undefined) throw new MssUploadError('mss-one-offs request initialization failed')
  const activeRequest = request
  const bodyPromise = args.bodyPath !== undefined
    ? (() => {
        source = createReadStream(args.bodyPath)
        const closed = once(activeRequest, 'close')
        return Promise.all([pipeline(source, activeRequest), closed]).then(() => undefined)
      })()
    : (() => {
        activeRequest.end(args.body)
        return Promise.resolve()
      })()
  return Promise.all([responsePromise, bodyPromise])
    .then(([response]) => response)
    .catch(async (error: unknown) => {
      source?.destroy()
      activeRequest.destroy()
      await bodyPromise.catch(() => undefined)
      throw error
    })
    .finally(() => clearTimeout(timer))
}

function responseErrorCode(text: string): string | undefined {
  try {
    const body = JSON.parse(text) as { code?: unknown }
    return typeof body.code === 'string' ? body.code : undefined
  } catch {
    return undefined
  }
}
