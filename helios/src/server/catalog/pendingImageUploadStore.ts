/**
 * Durable icebox staging for catalog-maintenance image uploads.
 *
 * The /catalog/maintenance "Images & Barcodes" page used to do its
 * Sweed blob upload + group.edit *synchronously* inside the Fastify
 * request handler. If anything went wrong (dead env token, transport
 * blip, Sweed slowness), the operator's bytes were lost — they had
 * to re-select the file and click upload again.
 *
 * This module makes the bytes survive forever: the route handler
 * writes the incoming multipart bytes (plus a sidecar `.meta.json`)
 * to a durable directory under our `/cloud` storage box BEFORE
 * enqueueing the `catalog.maintenance.upload_group_image` worker job.
 * The worker reads bytes back from the same path, runs the full Sweed
 * flow inside a pooled `withSweedSession()`. The staged bytes are
 * **never** deleted — the icebox is forever, both as a safety net for
 * Sweed-side data loss and as a future source for re-deriving
 * renditions.
 *
 * Filesystem layout:
 *
 *     <baseDir>/<YYYY>/<MM>/<DD>/<HH>/<MM>-<uuid>.<ext>
 *     <baseDir>/<YYYY>/<MM>/<DD>/<HH>/<MM>-<uuid>.<ext>.meta.json
 *
 * Example:
 *
 *     /cloud/data/fbnyc/icebox/sweed/images/2026/05/18/14/07-9b0a…f7.jpg
 *     /cloud/data/fbnyc/icebox/sweed/images/2026/05/18/14/07-9b0a…f7.jpg.meta.json
 *
 * The minute-prefix-then-uuid scheme keeps file listings sortable
 * chronologically at every depth and keeps any single directory
 * comfortably small even at several uploads per minute.
 *
 * Wire shape:
 *
 *   `stagedRef` is kept URL-safe (no slashes) so we don't have to
 *   touch the existing `POST /api/catalog/maintenance/images/:stagedRef/retry`
 *   route or worry about reverse proxies that fold %2F → "/". It is
 *   shaped:
 *
 *       <YYYYMMDDhhmm>-<uuid>.<ext>
 *
 *   e.g. `202605181407-9b0a…f7.jpg`. Both the filesystem path and
 *   any future S3 key are derived from this single string, so we
 *   keep one source of truth.
 *
 * Backend selection:
 *   HELIOS_PENDING_UPLOAD_BACKEND=fs        (default; this file)
 *   HELIOS_PENDING_UPLOAD_BACKEND=s3        (follow-on)
 *
 * Default local-fs location (override with HELIOS_PENDING_UPLOAD_DIR):
 *   /cloud/data/fbnyc/icebox/sweed/images
 *
 * The directory is created lazily and is shared between the Helios
 * server and worker processes (they run as the same `helios` Unix
 * user from /var/lib/helios/automation/helios per systemd unit). On
 * vps-nixos-3 `/cloud` is an sshfs mount to a 1 TB Hetzner storage
 * box, so both processes see the same bytes without any extra plumbing.
 */

import { randomUUID } from 'node:crypto'
import {
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
} from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'

import { z } from 'zod'

const DEFAULT_STAGING_DIR = '/cloud/data/fbnyc/icebox/sweed/images'

const MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

/**
 * stagedRef = `<YYYYMMDDhhmm>-<uuid>.<ext>`.
 * Anchored, length-bounded, and rejects path-separator / traversal
 * characters; safe to use as a URL path segment or a filesystem name.
 */
const STAGED_REF_PATTERN =
  /^(?<ts>\d{12})-(?<uuid>[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(?<ext>[a-z0-9]{1,8})$/

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
  /**
   * No-op for the icebox backend — bytes are never deleted. Kept on
   * the interface so existing callers (worker job completion paths)
   * don't have to know which backend they're running against.
   */
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
    const ext = MIME_TO_EXT[meta.contentType.toLowerCase()] ?? 'bin'
    const id = randomUUID()
    const now = new Date()
    const yyyy = String(now.getUTCFullYear()).padStart(4, '0')
    const mm = String(now.getUTCMonth() + 1).padStart(2, '0')
    const dd = String(now.getUTCDate()).padStart(2, '0')
    const hh = String(now.getUTCHours()).padStart(2, '0')
    const min = String(now.getUTCMinutes()).padStart(2, '0')
    const stagedRef = `${yyyy}${mm}${dd}${hh}${min}-${id}.${ext}`
    const { bytesPath, metaPath } = resolveRefPaths(this.baseDir, stagedRef)
    await mkdir(join(this.baseDir, yyyy, mm, dd, hh), { recursive: true })

    const fullMeta: StagedImageMeta = {
      ...meta,
      byteLength: bytes.byteLength,
      createdAt: now.toISOString(),
    }

    // Write bytes first, then sidecar, so a partially-written batch
    // never confuses a reader (sidecar absent → row ignored).
    await writeFile(bytesPath, bytes)
    await writeFile(metaPath, JSON.stringify(fullMeta, null, 2), 'utf8')
    return { stagedRef }
  }

  async read(stagedRef: string): Promise<StagedImage> {
    const { bytesPath, metaPath } = resolveRefPaths(this.baseDir, stagedRef)
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
    // Validate but don't unlink — icebox is forever. We still
    // re-resolve the path to catch crafted refs early rather than
    // silently swallow garbage from a misbehaving caller.
    resolveRefPaths(this.baseDir, stagedRef)
  }

  async listOlderThan(olderThan: Date): Promise<string[]> {
    // Walk the date-partitioned tree depth-first and yield bytes
    // refs (skipping sidecars). We don't currently run any cleanup
    // against the icebox, but this stays correct for ad-hoc tooling.
    const refs: string[] = []
    await this.walk(this.baseDir, olderThan, refs)
    return refs
  }

  private async walk(absDir: string, olderThan: Date, out: string[]): Promise<void> {
    let entries: Array<{ name: string; isDirectory: boolean; isFile: boolean }>
    try {
      const direntList = await readdir(absDir, { withFileTypes: true })
      entries = direntList.map((d) => ({
        name: d.name,
        isDirectory: d.isDirectory(),
        isFile: d.isFile(),
      }))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
      throw err
    }
    for (const entry of entries) {
      const childAbs = join(absDir, entry.name)
      if (entry.isDirectory) {
        await this.walk(childAbs, olderThan, out)
        continue
      }
      if (!entry.isFile) continue
      if (entry.name.endsWith('.meta.json')) continue
      // Only surface entries whose basename matches the
      // canonical stagedRef shape — anything else (stray files
      // dropped in by ops, lock files, etc.) is ignored.
      if (!STAGED_REF_PATTERN.test(entry.name)) continue
      try {
        const s = await stat(childAbs)
        if (s.mtime < olderThan) out.push(entry.name)
      } catch {
        // Race against a delete — ignore.
      }
    }
  }
}

function resolveRefPaths(baseDir: string, stagedRef: string): { bytesPath: string; metaPath: string } {
  const match = STAGED_REF_PATTERN.exec(stagedRef)
  if (!match || !match.groups) {
    throw new Error(`unsafe stagedRef: ${stagedRef}`)
  }
  const { ts } = match.groups as { ts: string }
  const yyyy = ts.slice(0, 4)
  const mm = ts.slice(4, 6)
  const dd = ts.slice(6, 8)
  const hh = ts.slice(8, 10)
  const min = ts.slice(10, 12)
  // Defense in depth: re-resolve and assert the absolute path is
  // still inside baseDir, even though STAGED_REF_PATTERN already
  // forbids slashes / dots / backslashes.
  const absBase = resolve(baseDir)
  const fileBasename = stagedRef.replace(/^\d{12}-/, `${min}-`)
  const bytesPath = resolve(absBase, yyyy, mm, dd, hh, fileBasename)
  if (bytesPath !== absBase && !bytesPath.startsWith(absBase + sep)) {
    throw new Error(`stagedRef resolved outside base: ${stagedRef}`)
  }
  return { bytesPath, metaPath: `${bytesPath}.meta.json` }
}

let cachedStore: PendingImageUploadStore | null = null

export function getPendingImageUploadStore(): PendingImageUploadStore {
  if (cachedStore !== null) return cachedStore
  const backend = (process.env.HELIOS_PENDING_UPLOAD_BACKEND ?? 'fs').toLowerCase()
  if (backend !== 'fs') {
    // S3 backend is the planned follow-on; the icebox layout above
    // maps 1:1 onto an S3 key prefix when we cut over.
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
