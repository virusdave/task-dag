import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  createLocalFsHintDocumentStore,
  type HintBlobPointer,
  type HintDocumentStore,
} from './pendingPurchaseHintStore.js'

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

describe('LocalFsHintDocumentStore', () => {
  let root: string
  let store: HintDocumentStore

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'hint-store-'))
    store = createLocalFsHintDocumentStore(root)
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('content-addresses the blob: pointer sha, size, and logical sharded uri', async () => {
    const text = 'SKU    Name      Cost'
    const pointer = await store.put(text)
    const sha = sha256Hex(text)
    expect(pointer.contentSha256).toBe(sha)
    expect(pointer.storageBackend).toBe('fs')
    expect(pointer.byteSize).toBe(Buffer.byteLength(text, 'utf8'))
    expect(pointer.storageUri).toBe(
      `fs://pending-purchase-hints/${sha.slice(0, 2)}/${sha.slice(2, 4)}/${sha}.txt`,
    )
  })

  it('round-trips: read returns the exact stored text', async () => {
    const text = 'distributor menu\nline two\n  indented'
    const pointer = await store.put(text)
    const blob = await store.read(pointer)
    expect(blob.text).toBe(text)
    expect(blob.contentSha256).toBe(pointer.contentSha256)
    expect(blob.byteSize).toBe(pointer.byteSize)
  })

  it('is idempotent: re-putting identical text resolves to the same blob', async () => {
    const text = 'same text'
    const a = await store.put(text)
    const b = await store.put(text)
    expect(b).toEqual(a)
    expect((await store.read(b)).text).toBe(text)
  })

  it('rejects a storage uri that does not match the pointer sha', async () => {
    const pointer = await store.put('hello')
    const tampered: HintBlobPointer = {
      ...pointer,
      contentSha256: 'f'.repeat(64),
    }
    await expect(store.read(tampered)).rejects.toThrow(/sha does not match/)
  })

  it('rejects an unsafe/malformed storage uri (no path traversal)', async () => {
    const bad: HintBlobPointer = {
      contentSha256: 'a'.repeat(64),
      storageBackend: 'fs',
      storageUri: 'fs://pending-purchase-hints/../../etc/passwd',
      byteSize: 1,
    }
    await expect(store.read(bad)).rejects.toThrow(/unsafe hint storage uri/)
  })

  it('fails closed if the stored bytes are corrupted after write', async () => {
    const pointer = await store.put('trustworthy text')
    const sha = pointer.contentSha256
    const bytesPath = join(
      root,
      'pending-purchase-hints',
      sha.slice(0, 2),
      sha.slice(2, 4),
      `${sha}.txt`,
    )
    await writeFile(bytesPath, 'tampered bytes')
    await expect(store.read(pointer)).rejects.toThrow(/integrity check failed/)
    // sanity: the file really was changed on disk
    expect(await readFile(bytesPath, 'utf8')).toBe('tampered bytes')
  })

  it('rejects empty text (a stored blob is always > 0 B)', async () => {
    await expect(store.put('')).rejects.toThrow(/must not be empty/)
  })

  it('fails closed when the storage root is missing (no local shadow tree)', async () => {
    const missing = join(root, 'does-not-exist')
    const fenced = createLocalFsHintDocumentStore(missing)
    await expect(fenced.put('some text')).rejects.toThrow(/does not exist/)
  })

  it('rejects a non-fs backend on read', async () => {
    const pointer = await store.put('x')
    await expect(store.read({ ...pointer, storageBackend: 's3' })).rejects.toThrow(
      /not implemented/,
    )
  })
})
