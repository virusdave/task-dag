import type { QueryResult, QueryResultRow } from 'pg'
import { describe, expect, it } from 'vitest'

import {
  ImageAssetBundleSourceError,
  loadApprovedImageAssetsForBundle,
} from './imageAssetBundleSource.js'
import { imageAssetContentSha256, type ImageAssetContentInput } from './imageContent.js'
import type { Queryable } from '../db/pool.js'

const content: ImageAssetContentInput = {
  asset_id: 'img_a',
  asset_sha256: 'a'.repeat(64),
  role: 'hero',
  media_type: 'image/webp',
  width: 1200,
  height: 630,
  alt_text: 'A rooftop garden in Brooklyn at sunset.',
}

function approvedRow(overrides: Record<string, unknown> = {}) {
  const content_sha256 = imageAssetContentSha256(content)
  return {
    asset_id: content.asset_id,
    asset_sha256: content.asset_sha256,
    role: content.role,
    media_type: content.media_type,
    width: content.width,
    height: content.height,
    alt_text: content.alt_text,
    content_sha256,
    approval_id: 'seoapr_a',
    approval_kind: 'image',
    approval_ref: content.asset_id,
    approval_sha256: content_sha256,
    ...overrides,
  }
}

function fakeDb(rows: Array<Record<string, unknown>>): Queryable {
  return {
    query: async <T extends QueryResultRow>(): Promise<QueryResult<T>> =>
      ({ rows: rows as T[], rowCount: rows.length, command: '', oid: 0, fields: [] }) as QueryResult<T>,
  }
}

describe('loadApprovedImageAssetsForBundle', () => {
  it('maps a verified approved row into a contract SeoAsset', async () => {
    const out = await loadApprovedImageAssetsForBundle(fakeDb([approvedRow()]))
    expect(out).toHaveLength(1)
    expect(out[0]!.sha256).toBe('a'.repeat(64))
    expect(out[0]!.role).toBe('hero')
    expect(out[0]!.media_type).toBe('image/webp')
    expect(out[0]!.width).toBe(1200)
    expect(out[0]!.height).toBe(630)
    expect(out[0]!.alt_text).toBe(content.alt_text)
    expect(out[0]!.approval_status).toBe('approved')
    expect(out[0]!.approval_id).toBe('seoapr_a')
  })

  it('omits dimensions when null', async () => {
    const c = { ...content, width: null, height: null }
    const sha = imageAssetContentSha256(c)
    const out = await loadApprovedImageAssetsForBundle(
      fakeDb([approvedRow({ width: null, height: null, content_sha256: sha, approval_sha256: sha })]),
    )
    expect(out[0]!.width).toBeUndefined()
    expect(out[0]!.height).toBeUndefined()
  })

  it('fails when an approved row has no ledger join', async () => {
    await expect(
      loadApprovedImageAssetsForBundle(
        fakeDb([approvedRow({ approval_kind: null, approval_ref: null, approval_sha256: null })]),
      ),
    ).rejects.toBeInstanceOf(ImageAssetBundleSourceError)
  })

  it('fails when the ledger row is the wrong content_kind', async () => {
    await expect(
      loadApprovedImageAssetsForBundle(fakeDb([approvedRow({ approval_kind: 'post' })])),
    ).rejects.toThrow(/content_kind 'post', expected 'image'/)
  })

  it('fails when the ledger references a different asset', async () => {
    await expect(
      loadApprovedImageAssetsForBundle(fakeDb([approvedRow({ approval_ref: 'img_other' })])),
    ).rejects.toThrow(/content_ref 'img_other', not this asset/)
  })

  it('fails when the stored fingerprint and ledger fingerprint disagree', async () => {
    await expect(
      loadApprovedImageAssetsForBundle(fakeDb([approvedRow({ approval_sha256: 'f'.repeat(64) })])),
    ).rejects.toThrow(/does not match the approved fingerprint/)
  })

  it('fails when the actual metadata no longer hashes to the stored fingerprint', async () => {
    // alt_text changed without re-approval: stored/ledger sha still old.
    await expect(
      loadApprovedImageAssetsForBundle(
        fakeDb([approvedRow({ alt_text: 'A different, unapproved caption.' })]),
      ),
    ).rejects.toThrow(/metadata changed without re-approval/)
  })

  it('returns an empty list when there are no approved rows', async () => {
    const out = await loadApprovedImageAssetsForBundle(fakeDb([]))
    expect(out).toEqual([])
  })
})
