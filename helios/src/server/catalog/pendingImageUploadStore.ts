/**
 * Durable staging for catalog-maintenance image uploads.
 *
 * The /catalog/maintenance "Images & Barcodes" page used to do its
 * Sweed blob upload + group.edit *synchronously* inside the Fastify
 * request handler. If anything went wrong (dead env token, transport
 * blip, Sweed slowness), the operator's bytes were lost — they had
 * to re-select the file and click upload again.
 *
 * This module makes the bytes survive: the route handler writes the
 * incoming multipart bytes (plus a sidecar `.meta.json`) to a
 * durable directory BEFORE enqueueing the
 * `catalog.maintenance.upload_group_image` worker job. The worker
 * reads bytes back from the same staging dir, runs the full Sweed
 * flow inside a pooled `withSweedSession()`, and deletes the staged
 * bytes only after the upload + verification succeed. A failed job
 * leaves bytes in place; the existing worker retry/backoff
 * re-attempts the upload without operator action, and Retry from the
 * UI simply re-enqueues against the same `stagedRef`.
 *
 * Backend selection:
 *   HELIOS_PENDING_UPLOAD_BACKEND=fs        (default; this file)
 *   HELIOS_PENDING_UPLOAD_BACKEND=s3        (follow-on — Phase 7)
 *
 * Local-fs location (override with HELIOS_PENDING_UPLOAD_DIR):
 *   /var/lib/helios/pending-image-uploads
 *
 * The directory is created lazily and is shared between the Helios
 * server and worker processes (they run as the same `helios` Unix
 * user from /var/lib/helios/automation/helios per systemd unit).
 */

import { randomUUID } from 'node:crypto'
import {
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'

import { z } from 'zod'

const DEFAULT_STAGING_DIR = '/var/lib/helios/pending-image-uploads'

const MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

export interface StagedImageMeta {
  groupId: number
  sweedGroupId: number
  requestedByUserId: number | null
  targetType: 'group'
  originalFilename: string | null
  contentType: string
  byteLength: number
  createdAt: string // ISO
}

const StagedImageMetaSchema = z.object({
  groupId: z.number().int().positive(),
  sweedGroupId: z.number().int().positive(),
  requestedByUserId: z.number().int().nullable(),
  targetType: z.literal('group'),
  originalFilename: z.string().nullable(),
  contentType: z.string().min(1),
  byteLength: z.number().int().nonnegative(),
  createdAt: z.string().min(1),
})

export interface StagedImage {
  stagedRef: string
  bytes: Uint8Array
  meta: StagedImageMeta
}

export interface PendingImageUploadStore {
  put(input: {
    bytes: Uint8Array
    meta: Omit<StagedImageMeta, 'byteLength' | 'createdAt'>
  }): Promise<{ stagedRef: string }>
  read(stagedRef: string): Promise<StagedImage>
  delete(stagedRef: string): Promise<void>
  listOlderThan(olderThan: Date): Promise<string[]>
}

class LocalFsPendingImageUploadStore implements PendingImageUploadStore {
  constructor(private readonly baseDir: string) {}

  async put({
    bytes,
    meta,
  }: {
    bytes: Uint8Array
    meta: Omit<StagedImageMeta, 'byteLength' | 'createdAt'>
  }): Promise<{ stagedRef: string }> {
    await mkdir(this.baseDir, { recursive: true })
    const ext = MIME_TO_EXT[meta.contentType.toLowerCase()] ?? 'bin'
    const id = randomUUID()
    const stagedRef = `${id}.${ext}`
    const bytesPath = join(this.baseDir, stagedRef)
    const metaPath = `${bytesPath}.meta.json`

    const fullMeta: StagedImageMeta = {
      ...meta,
      byteLength: bytes.byteLength,
      createdAt: new Date().toISOString(),
    }

    // Write bytes first, then sidecar, so a partially-written batch
    // never confuses a reader (sidecar absent → row ignored).
    await writeFile(bytesPath, bytes)
    await writeFile(metaPath, JSON.stringify(fullMeta, null, 2), 'utf8')
    return { stagedRef }
  }

  async read(stagedRef: string): Promise<StagedImage> {
    assertSafeRef(stagedRef)
    const bytesPath = join(this.baseDir, stagedRef)
    const metaPath = `${bytesPath}.meta.json`
    const [bytesBuf, metaText] = await Promise.all([
      readFile(bytesPath),
      readFile(metaPath, 'utf8'),
    ])
    const meta = StagedImageMetaSchema.parse(JSON.parse(metaText))
    return {
      stagedRef,
      bytes: new Uint8Array(bytesBuf.buffer, bytesBuf.byteOffset, bytesBuf.byteLength),
      meta,
    }
  }

  async delete(stagedRef: string): Promise<void> {
    assertSafeRef(stagedRef)
    const bytesPath = join(this.baseDir, stagedRef)
    const metaPath = `${bytesPath}.meta.json`
    await Promise.all([
      rm(bytesPath, { force: true }),
      rm(metaPath, { force: true }),
    ])
  }

  async listOlderThan(olderThan: Date): Promise<string[]> {
    let entries: string[]
    try {
      entries = await readdir(this.baseDir)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw err
    }
    const refs: string[] = []
    for (const entry of entries) {
      if (entry.endsWith('.meta.json')) continue
      const fullPath = join(this.baseDir, entry)
      try {
        const s = await stat(fullPath)
        if (s.mtime < olderThan) refs.push(entry)
      } catch {
        // Race against a delete — ignore.
      }
    }
    return refs
  }
}

function assertSafeRef(stagedRef: string): void {
  // Bytes are uuid + ext; reject anything containing path separators
  // or relative-path tricks so the staging dir can never be escaped
  // by a crafted ref from a route handler.
  if (
    stagedRef.length === 0 ||
    stagedRef.includes('/') ||
    stagedRef.includes('\\') ||
    stagedRef.includes('..')
  ) {
    throw new Error(`unsafe stagedRef: ${stagedRef}`)
  }
}

let cachedStore: PendingImageUploadStore | null = null

export function getPendingImageUploadStore(): PendingImageUploadStore {
  if (cachedStore !== null) return cachedStore
  const backend = (process.env.HELIOS_PENDING_UPLOAD_BACKEND ?? 'fs').toLowerCase()
  if (backend !== 'fs') {
    // S3 backend is Phase 7 in
    // docs/helios/catalog-maintenance-pooled-async-uploads/.
    throw new Error(
      `HELIOS_PENDING_UPLOAD_BACKEND=${backend} is not implemented. ` +
        `Only 'fs' is supported today; S3 is the planned follow-on.`,
    )
  }
  const dir = process.env.HELIOS_PENDING_UPLOAD_DIR ?? DEFAULT_STAGING_DIR
  cachedStore = new LocalFsPendingImageUploadStore(dir)
  return cachedStore
}

// Test-only override hook (not used in production paths).
export function _setPendingImageUploadStoreForTests(store: PendingImageUploadStore | null): void {
  cachedStore = store
}
