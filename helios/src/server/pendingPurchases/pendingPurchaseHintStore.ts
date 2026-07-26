/**
 * Out-of-band, content-addressed, append-only storage for pending-purchase
 * HINT DOCUMENT bytes (child FreshlyBakedNYC/automation#54, task C2).
 *
 * The operator requirement: large/unstructured hint material (a distributor
 * menu, a sibling purchase order, a free-text note — and, later, uploaded
 * files) must NOT live in Postgres. The bytes live out-of-band on the
 * `/cloud` storage box; the DB row keeps only a POINTER (content hash +
 * logical uri + size) plus the small extracted facts (C3). This mirrors the
 * existing catalog image icebox (server/catalog/pendingImageUploadStore.ts):
 * append-only, shared by server + worker over the same `/cloud` sshfs mount,
 * with a backend-selection hook for a future S3 cutover.
 *
 * CONTENT-ADDRESSED: the address is the sha256 of the exact normalized UTF-8
 * bytes, so identical text always maps to the same blob — deterministic
 * idempotency, cross-bundle physical dedup, and a trivial integrity check.
 * Because a blob is shared across bundles/rows by its content address, blobs
 * are NEVER deleted (icebox-forever); a row delete drops only the DB pointer.
 *
 * Layout under <root> (default /cloud/data/fbnyc, override HELIOS_PENDING_HINT_ROOT):
 *
 *   pending-purchase-hints/<sha[0:2]>/<sha[2:4]>/<sha>.txt
 *   pending-purchase-hints/<sha[0:2]>/<sha[2:4]>/<sha>.txt.meta.json
 *
 * storage_uri (the DB pointer) is the LOGICAL key `fs://<that relative key>`,
 * never an absolute filesystem path — so a crafted/legacy uri can't escape
 * the root, and the key maps 1:1 onto a future S3 object key.
 *
 * The sidecar is blob-INVARIANT (only facts intrinsic to the bytes:
 * contentSha256, byteLength, contentType, createdAt). Per-row provenance
 * (kind, source label, who pasted it, when) lives in the DB, because the same
 * bytes may be referenced by different bundles with different kinds/labels.
 */

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { resolve, sep } from 'node:path'

import { z } from 'zod'

const DEFAULT_HINT_ROOT = '/cloud/data/fbnyc'
const KEY_PREFIX = 'pending-purchase-hints'
const CONTENT_TYPE = 'text/plain; charset=utf-8'
const TRANSIENT_DIRECTORY_RETRY_DELAYS_MS = [500, 1_500] as const

interface LocalFsHintDocumentStoreOptions {
  readonly mkdir?: typeof mkdir
  readonly sleep?: (delayMs: number) => Promise<void>
}

export type HintStorageBackend = 'fs' | 's3'

export interface HintBlobPointer {
  readonly contentSha256: string
  readonly storageBackend: HintStorageBackend
  /** Logical key, e.g. `fs://pending-purchase-hints/ab/cd/<sha>.txt`. */
  readonly storageUri: string
  readonly byteSize: number
}

export interface HintBlob {
  readonly contentSha256: string
  readonly text: string
  readonly byteSize: number
}

const SidecarSchema = z.object({
  contentSha256: z.string().regex(/^[0-9a-f]{64}$/),
  byteLength: z.number().int().nonnegative(),
  contentType: z.string().min(1),
  createdAt: z.string().min(1),
})

// `fs://` + the relative key. The key is anchored to the sharded sha layout,
// so it can contain no `..`, no extra path segments, and no separators beyond
// the three fixed ones.
const STORAGE_URI_PATTERN =
  /^fs:\/\/pending-purchase-hints\/([0-9a-f]{2})\/([0-9a-f]{2})\/([0-9a-f]{64})\.txt$/

export interface HintDocumentStore {
  /**
   * Store the (already-normalized) hint text content-addressed. Idempotent:
   * identical text resolves to the same blob; an existing, valid blob is a
   * no-op. Returns the pointer to persist in the DB.
   */
  put(normalizedText: string): Promise<HintBlobPointer>
  /**
   * Read a blob back from its DB pointer, verifying integrity (the bytes must
   * re-hash to contentSha256 and match byteSize) before returning.
   */
  read(pointer: HintBlobPointer): Promise<HintBlob>
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function keyForSha(sha: string): string {
  return `${KEY_PREFIX}/${sha.slice(0, 2)}/${sha.slice(2, 4)}/${sha}.txt`
}

class LocalFsHintDocumentStore implements HintDocumentStore {
  private readonly makeDirectory: typeof mkdir
  private readonly sleep: (delayMs: number) => Promise<void>

  constructor(
    private readonly root: string,
    options: LocalFsHintDocumentStoreOptions = {},
  ) {
    this.makeDirectory = options.mkdir ?? mkdir
    this.sleep = options.sleep ?? ((delayMs) => new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs)))
  }

  /**
   * Resolve a relative key to an absolute path, asserting it stays inside the
   * configured root (defense in depth on top of the anchored key regex).
   */
  private resolveKey(key: string): string {
    const absRoot = resolve(this.root)
    const abs = resolve(absRoot, key)
    if (abs !== absRoot && !abs.startsWith(absRoot + sep)) {
      throw new Error(`hint blob key resolved outside root: ${key}`)
    }
    return abs
  }

  /**
   * Fail CLOSED if the configured storage root is missing or not a directory.
   * On a prod host this guards against a dropped `/cloud` sshfs mount: without
   * it `mkdir(recursive)` would silently create a local shadow tree and write
   * blobs to local disk instead of the storage box. A missing root must be a
   * loud 5xx, never silent local storage.
   */
  private async assertRootMounted(): Promise<void> {
    const absRoot = resolve(this.root)
    let st
    try {
      st = await stat(absRoot)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(
          `hint storage root ${absRoot} does not exist (is the /cloud mount up?); refusing to write.`,
        )
      }
      throw err
    }
    if (!st.isDirectory()) {
      throw new Error(`hint storage root ${absRoot} is not a directory; refusing to write.`)
    }
  }

  async put(normalizedText: string): Promise<HintBlobPointer> {
    if (normalizedText.length === 0) {
      throw new Error('hint blob text must not be empty')
    }
    const contentSha256 = sha256Hex(normalizedText)
    const bytes = Buffer.from(normalizedText, 'utf8')
    const byteSize = bytes.byteLength
    const key = keyForSha(contentSha256)
    const bytesPath = this.resolveKey(key)
    const metaPath = `${bytesPath}.meta.json`
    const pointer: HintBlobPointer = {
      contentSha256,
      storageBackend: 'fs',
      storageUri: `fs://${key}`,
      byteSize,
    }

    // Treat the sidecar as the completion marker: if a complete, valid blob
    // already exists (sidecar present + bytes re-hash correctly) it is an
    // idempotent no-op. A partial/corrupt prior write is repaired below.
    if (await this.isCompleteValidBlob(bytesPath, metaPath, contentSha256, byteSize)) {
      return pointer
    }

    // Refuse to write if the root (e.g. the /cloud mount) is absent, so a
    // dropped mount can't silently create a local shadow tree. Only the lower
    // shard dirs are created below.
    await this.ensureShardDirectory(
      this.resolveKey(`${KEY_PREFIX}/${contentSha256.slice(0, 2)}/${contentSha256.slice(2, 4)}`),
    )

    // Write to a unique temp file in the same dir, then atomically rename, so
    // a concurrent reader/put never observes a half-written final path. The
    // bytes are renamed first; the sidecar rename is the durable completion
    // marker.
    const suffix = randomUUID()
    const tmpBytes = `${bytesPath}.tmp-${suffix}`
    const tmpMeta = `${metaPath}.tmp-${suffix}`
    await writeFile(tmpBytes, bytes)
    await rename(tmpBytes, bytesPath)
    const sidecar = JSON.stringify(
      { contentSha256, byteLength: byteSize, contentType: CONTENT_TYPE, createdAt: new Date().toISOString() },
      null,
      2,
    )
    await writeFile(tmpMeta, sidecar, 'utf8')
    await rename(tmpMeta, metaPath)
    return pointer
  }

  private async ensureShardDirectory(directory: string): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
      // Re-check on every attempt. A transient lower-directory failure may be
      // retried, but a dropped /cloud mount must remain a loud failure rather
      // than allowing recursive mkdir to create a local shadow tree.
      await this.assertRootMounted()
      try {
        await this.makeDirectory(directory, { recursive: true })
        return
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        const delayMs = TRANSIENT_DIRECTORY_RETRY_DELAYS_MS[attempt]
        if (!isTransientDirectoryError(code) || delayMs === undefined) {
          throw error
        }
        console.warn(
          `[pendingPurchaseHintStore] mkdir ${directory} failed with ${code}; retrying in ${delayMs}ms`,
        )
        await this.sleep(delayMs)
      }
    }
  }

  private async isCompleteValidBlob(
    bytesPath: string,
    metaPath: string,
    expectedSha: string,
    expectedSize: number,
  ): Promise<boolean> {
    try {
      await stat(metaPath)
      const buf = await readFile(bytesPath)
      if (buf.byteLength !== expectedSize) {
        return false
      }
      return createHash('sha256').update(buf).digest('hex') === expectedSha
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return false
      }
      throw err
    }
  }

  async read(pointer: HintBlobPointer): Promise<HintBlob> {
    if (pointer.storageBackend !== 'fs') {
      throw new Error(`hint storage backend ${pointer.storageBackend} is not implemented (only 'fs').`)
    }
    const match = STORAGE_URI_PATTERN.exec(pointer.storageUri)
    if (!match) {
      throw new Error(`unsafe hint storage uri: ${pointer.storageUri}`)
    }
    const uriSha = match[3]!
    if (uriSha !== pointer.contentSha256) {
      throw new Error('hint storage uri sha does not match pointer contentSha256')
    }
    const key = pointer.storageUri.slice('fs://'.length)
    const bytesPath = this.resolveKey(key)
    const buf = await readFile(bytesPath)
    const actualSha = createHash('sha256').update(buf).digest('hex')
    if (actualSha !== pointer.contentSha256) {
      throw new Error(`hint blob integrity check failed for ${pointer.storageUri}`)
    }
    if (buf.byteLength !== pointer.byteSize) {
      throw new Error(`hint blob size mismatch for ${pointer.storageUri}`)
    }
    return { contentSha256: pointer.contentSha256, text: buf.toString('utf8'), byteSize: buf.byteLength }
  }
}

/** Test-only constructor so unit tests can point at a temp root. */
export function createLocalFsHintDocumentStore(
  root: string,
  options: LocalFsHintDocumentStoreOptions = {},
): HintDocumentStore {
  return new LocalFsHintDocumentStore(root, options)
}

let cachedStore: HintDocumentStore | null = null

export function getHintDocumentStore(): HintDocumentStore {
  if (cachedStore !== null) {
    return cachedStore
  }
  const backend = (process.env.HELIOS_PENDING_HINT_BACKEND ?? 'fs').toLowerCase()
  if (backend !== 'fs') {
    // S3 is the planned follow-on; the content-addressed key maps 1:1 onto an
    // S3 object key when we cut over.
    throw new Error(`HELIOS_PENDING_HINT_BACKEND=${backend} is not implemented. Only 'fs' is supported today.`)
  }
  const root = process.env.HELIOS_PENDING_HINT_ROOT ?? DEFAULT_HINT_ROOT
  cachedStore = new LocalFsHintDocumentStore(root)
  return cachedStore
}

// Test-only override hook (not used in production paths).
export function _setHintDocumentStoreForTests(store: HintDocumentStore | null): void {
  cachedStore = store
}

export const HINT_BLOB_CONTENT_TYPE = CONTENT_TYPE

function isTransientDirectoryError(code: string | undefined): boolean {
  return code === 'ENOENT' || code === 'EACCES' || code === 'EPERM'
}
