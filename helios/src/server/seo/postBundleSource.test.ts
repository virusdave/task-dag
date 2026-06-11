import type { QueryResult, QueryResultRow } from 'pg'
import { describe, expect, it } from 'vitest'

import { PostBundleSourceError, loadApprovedPostsForBundle } from './postBundleSource.js'
import { postContentSha256, type PostContentInput } from './postContent.js'
import type { Queryable } from '../db/pool.js'

const content: PostContentInput = {
  post_id: 'post_a',
  scope: 'all',
  slug: 'summer-drop-2026',
  title: 'Summer 2026 Drop',
  meta_description: 'A look at the new summer arrivals.',
  excerpt: 'New arrivals for summer 2026.',
  author: 'Freshly Baked Editorial',
  tags: ['nyc-culture'],
  body_raw: 'Summer is here with new cannabis arrivals.',
  body_sanitized: 'Summer is here with new arrivals.',
}

function approvedRow(overrides: Record<string, unknown> = {}) {
  const content_sha256 = postContentSha256(content)
  return {
    post_id: content.post_id,
    scope: content.scope,
    slug: content.slug,
    title: content.title,
    meta_description: content.meta_description,
    excerpt: content.excerpt,
    author: content.author,
    tags: content.tags,
    body_raw: content.body_raw,
    body_sanitized: content.body_sanitized,
    noindex: false,
    published_at: '2026-06-11T08:00:00Z',
    updated_at: '2026-06-11T09:30:00Z',
    reviewer: 'dave',
    content_sha256,
    approval_id: 'seoapr_a',
    approval_kind: 'post',
    approval_ref: content.post_id,
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

describe('loadApprovedPostsForBundle', () => {
  it('maps a verified approved row into a contract BlogPostContent (canonical derived)', async () => {
    const out = await loadApprovedPostsForBundle(fakeDb([approvedRow()]))
    expect(out).toHaveLength(1)
    expect(out[0]!.post_id).toBe('post_a')
    expect(out[0]!.approval_id).toBe('seoapr_a')
    expect(out[0]!.reviewer).toBe('dave')
    expect(out[0]!.canonical_url).toBe(
      'https://freshlybaked.nyc/sites/all/whats-new/summer-drop-2026',
    )
  })

  it('omits noindex when false and sets it when true', async () => {
    const off = await loadApprovedPostsForBundle(fakeDb([approvedRow()]))
    expect(off[0]!.noindex).toBeUndefined()
    const onContent = { ...content, noindex: true }
    const sha = postContentSha256(onContent)
    const on = await loadApprovedPostsForBundle(
      fakeDb([approvedRow({ noindex: true, content_sha256: sha, approval_sha256: sha })]),
    )
    expect(on[0]!.noindex).toBe(true)
  })

  it('fails when an approved row has no ledger join', async () => {
    await expect(
      loadApprovedPostsForBundle(
        fakeDb([approvedRow({ approval_kind: null, approval_ref: null, approval_sha256: null })]),
      ),
    ).rejects.toBeInstanceOf(PostBundleSourceError)
  })

  it('fails when the ledger content_ref points at another post', async () => {
    await expect(
      loadApprovedPostsForBundle(fakeDb([approvedRow({ approval_ref: 'post_other' })])),
    ).rejects.toBeInstanceOf(PostBundleSourceError)
  })

  it('fails when the ledger hash disagrees with the stored fingerprint', async () => {
    await expect(
      loadApprovedPostsForBundle(fakeDb([approvedRow({ approval_sha256: 'f'.repeat(64) })])),
    ).rejects.toBeInstanceOf(PostBundleSourceError)
  })

  it('fails when the actual content no longer hashes to the approved fingerprint', async () => {
    await expect(
      loadApprovedPostsForBundle(fakeDb([approvedRow({ title: 'tampered after approval' })])),
    ).rejects.toBeInstanceOf(PostBundleSourceError)
  })

  it('fails when the approval_kind is wrong', async () => {
    await expect(
      loadApprovedPostsForBundle(fakeDb([approvedRow({ approval_kind: 'faq_set' })])),
    ).rejects.toBeInstanceOf(PostBundleSourceError)
  })

  it('fails when an approved post has no reviewer stamped', async () => {
    await expect(
      loadApprovedPostsForBundle(fakeDb([approvedRow({ reviewer: null })])),
    ).rejects.toBeInstanceOf(PostBundleSourceError)
  })

  it('fails when the slug is invalid (canonical cannot be derived)', async () => {
    const bad = { ...content, slug: 'Bad Slug' }
    const sha = postContentSha256(bad)
    await expect(
      loadApprovedPostsForBundle(
        fakeDb([approvedRow({ slug: 'Bad Slug', content_sha256: sha, approval_sha256: sha })]),
      ),
    ).rejects.toBeInstanceOf(PostBundleSourceError)
  })

  it('returns an empty array when there are no approved rows', async () => {
    expect(await loadApprovedPostsForBundle(fakeDb([]))).toEqual([])
  })

  it('passes the release-time gate (now) to the SQL filter', async () => {
    const captured: unknown[][] = []
    const capturingDb: Queryable = {
      query: async <T extends QueryResultRow>(
        _sql: string,
        params?: unknown[],
      ): Promise<QueryResult<T>> => {
        captured.push(params ?? [])
        return {
          rows: [] as T[],
          rowCount: 0,
          command: '',
          oid: 0,
          fields: [],
        } as QueryResult<T>
      },
    }
    const now = new Date('2026-06-11T12:00:00Z')
    await loadApprovedPostsForBundle(capturingDb, now)
    expect(captured[0]).toEqual([now.toISOString()])
  })

  it('maps an approved row that carries a (past) scheduled_publish_at', async () => {
    const out = await loadApprovedPostsForBundle(
      fakeDb([approvedRow({ scheduled_publish_at: '2026-06-10T08:00:00Z' })]),
    )
    expect(out).toHaveLength(1)
    expect(out[0]!.post_id).toBe('post_a')
  })
})
